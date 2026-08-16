#!/usr/bin/env bash
# post-impl-tc-writer.sh — TC (test criteria) generation gate.
#
# Runs after all impl stories in a phase complete, before any test stories start.
# Reads actual source files and writes testCriteria to prd.json for each pending
# test story. ACs are never modified — TCs are additive only.
#
# Usage:
#   bash post-impl-tc-writer.sh --prd <path> --phase <phase> --output-dir <dir>
#
# Skip:
#   SKIP_TC_WRITER=1  — bypass entirely (CI fast path)
#
# Exit 0 = TCs written or nothing to do.
# Exit 1 = TC generation failed and test stories exist — blocks pipeline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# EVERY ENTRY POINT READS THE LADDER DECLARATION ITSELF.
#
# lib/model-ladders.sh exists so that "what a tier contains" is declared once and read the same
# way everywhere. Only claude.sh, run-agent-orchestration.sh and detective-rerun.sh ever called
# it, so this script resolved its model ONLY from environment its parent happened to export. Run
# standalone — a replay, a retest, a test harness — nothing set EPAM_MODEL_LADDER_<TIER>,
# seam_ladder_export set no EPAM_MODEL, and this seam skipped its work while exiting 0.
#
# export_model_ladders leaves an already-set value alone, so calling it here changes nothing when
# the orchestrator has already exported the chain, and supplies it when nobody has.
_ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
if [ -f "$_ml_lib" ]; then
    # shellcheck source=lib/model-ladders.sh
    . "$_ml_lib" || true
    command -v export_model_ladders >/dev/null 2>&1 \
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json}" || true
fi
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "tc-writer"

source "$SCRIPT_DIR/lib/flags.sh"

# Files this run PRODUCED supersede the files it DECLARED.
#
# technicalNotes.files is a PREDICTION written during the spec pass; the manifest
# is a RECORD of what the run actually wrote. This script runs AFTER
# implementation, so the record is authoritative — and the reproducing test is
# created by a later agent, so it can never appear in a prediction made earlier.
_TCW_MANIFEST="${LOG_DIR:-$(dirname "$0")/../logs}/story-outputs-${PHASE:-core}.txt"
export _TCW_MANIFEST
PRD_FILE=""
PHASE=""
OUTPUT_DIR=""
STORY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --prd)        PRD_FILE="$2";    shift 2 ;;
    --phase)      PHASE="$2";       shift 2 ;;
    --output-dir) OUTPUT_DIR="$2";  shift 2 ;;
    # Optional: scope the gate to a single story instead of every test story
    # in the phase. Root cause this fixes (found live, 2026-07-08): the
    # inline per-story call site in run-agent-orchestration.sh's Step 1 loop
    # invokes this script right before ONE specific story runs — but without
    # scoping, it also processes every OTHER test story in the phase whose
    # impl hasn't run yet, gets a correct null/"source doesn't exist" reply
    # for them, and that unrelated null hard-failed the whole gate (and thus
    # aborted the phase) even though the one story the caller actually cared
    # about (e.g. SKY-002-test) was fine. When set, only that one story is
    # considered "needed" and only that one story is checked for success.
    --story)      STORY="$2";       shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if is_truthy "${SKIP_TC_WRITER:-}"; then
  echo "  [tc-writer] SKIP_TC_WRITER=1 — skipping gate"
  exit 0
fi

if [[ -z "$PRD_FILE" || ! -f "$PRD_FILE" ]]; then
  echo "  [tc-writer] ERROR: PRD not found: $PRD_FILE" >&2; exit 1
fi
if [[ -z "$PHASE" ]]; then
  echo "  [tc-writer] ERROR: --phase required" >&2; exit 1
fi
if [[ -z "$OUTPUT_DIR" || ! -d "$OUTPUT_DIR" ]]; then
  echo "  [tc-writer] ERROR: --output-dir not found: $OUTPUT_DIR" >&2; exit 1
fi

# ── Load tc-writer-agent profile ───────────────────────────────────────────────
PROFILES_FILE="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
TC_WRITER_PROFILE=""
if [ -f "$PROFILES_FILE" ]; then
  TC_WRITER_PROFILE=$(jq -r '."tc-writer-agent" // ""' "$PROFILES_FILE" 2>/dev/null || echo "")
fi
[ -z "$TC_WRITER_PROFILE" ] && TC_WRITER_PROFILE="You are the TC writer agent. Your job is to generate testCriteria JSON for test stories by reading actual implementation source files."

# ── Find test stories in this phase that need TCs ──────────────────────────────
TC_NEEDED=$(python3 << PYEOF
import json, sys
import os as _os
# Test conventions vary per project (.spec.ts here, .test.ts elsewhere,
# __tests__/, test_*.py). NO REGEX: two of this script's heredocs are unquoted,
# so backslash escapes are collapsed by the shell before Python sees them.
def _is_test_file(f):
    f = f or ''
    base = f.split('/')[-1]
    if '__tests__/' in f or f.startswith('__tests__/'):
        return True
    if base.startswith('test_'):
        return True
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in base:
            return True
    return False
def _pair_key(f):
    """Path with the test marker AND extension removed, so 'a.service.ts' and
    'a.service.spec.ts' produce the same key."""
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _manifest_files():
    try:
        with open(_os.environ.get('_TCW_MANIFEST', '')) as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return []
def _files_for(story):
    """After implementation the RECORD supersedes the PREDICTION."""
    declared = (story.get('technicalNotes') or {}).get('files') or []
    produced = _manifest_files()
    if not produced:
        return declared
    base = set()
    for _f in declared:
        base.add(_pair_key(_f))
    extra = []
    for _f in produced:
        if _f in declared or _pair_key(_f) in base:
            extra.append(_f)
    return list(dict.fromkeys(declared + extra))



with open('$PRD_FILE') as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get('$PHASE', [])
by_id = {s['id']: s for s in d['stories']}
results = []
story_filter = '$STORY'

# The TARGET story (--story) must always be considered "needed" if it
# structurally qualifies, regardless of implementationOrder timing — a
# mid-execution split can leave a story transiently absent from
# implementationOrder[phase] even though it's a real, scheduled story.
# Root cause this fixes (found live, 2026-07-09): SKY-003-test's inline gate
# reported "TC writer populated testCriteria" while the story's own
# testCriteria.facts remained empty, because this exact query silently
# excluded it and the caller trusted the exit code alone.
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids + [story_filter]

for sid in phase_ids:
    if story_filter and sid != story_filter:
        continue
    s = by_id.get(sid, {})
    # Defensive check (found live, 2026-07-06, tier3-full-run-15): a story
    # that was split delegates its ENTIRE implementation to child stories —
    # its own technicalNotes.files still lists the original (now-delegated)
    # files, so it can look like a "test story with no TC yet" even though
    # the real work (and TC) belongs to a child. spec-mode-runner marks a
    # delegated parent 'deprecated' at split time (and removes it from
    # implementationOrder), which is the actual, specific signal for this
    # case — checked below.
    #
    # Root cause fixed (found live, 2026-07-14, tier3-travel-app run): this
    # used to ALSO skip any story with completed == True, on the theory that
    # a delegated parent gets marked completed too. But EVERY story this
    # BATCH gate (Step 1.6, called post-Step-3.2) examines is, by
    # construction, already completed by the time it runs — that's the
    # entire reason the gate exists post-execution. The completed-exclusion
    # therefore silently no-op'd this script for every genuinely-finished
    # combo story (impl+test files together, e.g. SKY-004) and every
    # worktree-lane pure-test story once it completed, causing the CALLER
    # (Step 1.6 in run-agent-orchestration.sh, whose own "needs TC" query has
    # no such completed-exclusion) to retry 3 times against a script that
    # always no-ops, then permanently BLOCK a story with real, already-
    # verified (tsc + external tests passed) work over a bookkeeping mismatch.
    if s.get('status') == 'deprecated':
        continue
    files = _files_for(s)
    is_test_story = any(_is_test_file(f) for f in files)
    already_has_tc = bool(s.get('testCriteria', {}).get('facts'))
    if is_test_story and not already_has_tc:
        results.append(sid)

print('\n'.join(results))
PYEOF
)

if [[ -z "$TC_NEEDED" ]]; then
  echo "  [tc-writer] No test stories need TCs in phase '$PHASE' — skipping"
  exit 0
fi

TC_COUNT=$(echo "$TC_NEEDED" | grep -c '[^[:space:]]')
echo ""
echo "  [tc-writer] Phase '$PHASE': $TC_COUNT test story/stories need TCs"
echo "$TC_NEEDED" | while read -r sid; do [ -n "$sid" ] && echo "    - $sid"; done

# ── Build the epam prompt ──────────────────────────────────────────────────────
TC_OUT_FILE="${SCRIPT_DIR}/../logs/tc-${PHASE}.json"
mkdir -p "$(dirname "$TC_OUT_FILE")"

# Build story context for the prompt
STORY_CONTEXT=$(python3 << PYEOF
import json
import os as _os
# Test conventions vary per project (.spec.ts here, .test.ts elsewhere,
# __tests__/, test_*.py). NO REGEX: two of this script's heredocs are unquoted,
# so backslash escapes are collapsed by the shell before Python sees them.
def _is_test_file(f):
    f = f or ''
    base = f.split('/')[-1]
    if '__tests__/' in f or f.startswith('__tests__/'):
        return True
    if base.startswith('test_'):
        return True
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in base:
            return True
    return False
def _pair_key(f):
    """Path with the test marker AND extension removed, so 'a.service.ts' and
    'a.service.spec.ts' produce the same key."""
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _manifest_files():
    try:
        with open(_os.environ.get('_TCW_MANIFEST', '')) as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return []
def _files_for(story):
    """After implementation the RECORD supersedes the PREDICTION."""
    declared = (story.get('technicalNotes') or {}).get('files') or []
    produced = _manifest_files()
    if not produced:
        return declared
    base = set()
    for _f in declared:
        base.add(_pair_key(_f))
    extra = []
    for _f in produced:
        if _f in declared or _pair_key(_f) in base:
            extra.append(_f)
    return list(dict.fromkeys(declared + extra))



with open('$PRD_FILE') as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get('$PHASE', [])
by_id = {s['id']: s for s in d['stories']}
output_dir = '$OUTPUT_DIR'
story_filter = '$STORY'

# Same fix as the TC_NEEDED query above — the target story must be considered
# even if implementationOrder[phase] transiently lacks it. Peer-file discovery
# below still iterates the ORIGINAL implementationOrder-derived list, which is
# correct and must not change.
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids + [story_filter]

lines = []
for sid in phase_ids:
    if story_filter and sid != story_filter:
        continue
    s = by_id.get(sid, {})
    files = _files_for(s)
    is_test_story = any(_is_test_file(f) for f in files)
    if not is_test_story:
        continue
    if s.get('testCriteria', {}).get('facts'):
        continue

    impl_files = [f for f in files if not _is_test_file(f)]
    test_files = [f for f in files if _is_test_file(f)]

    # Impl source files can live in the SAME story (impl+test not split into
    # separate children) or in a PEER story (split topology, e.g. SKY-004-A/
    # SKY-004-B). Seed with the story's own impl files first — the peer search
    # below only covers the split case and previously left impl_src empty
    # whenever impl+test lived together, causing the TC writer to see zero
    # IMPL_SOURCE_FILES and wrongly conclude "source files don't exist".
    impl_src = list(impl_files)
    for peer_id in phase_ids:
        if peer_id == sid:
            continue
        ps = by_id.get(peer_id, {})
        peer_files = _files_for(ps)
        # A peer is an impl story sharing a non-test filename base
        test_bases = {_test_base(f) for f in test_files}
        peer_bases = {_pair_key(f.split('/')[-1]) for f in peer_files if not _is_test_file(f)}
        if test_bases & peer_bases:
            impl_src.extend(peer_files)

    impl_src = list(dict.fromkeys(impl_src))  # dedupe, preserve order

    lines.append(f'STORY_ID: {sid}')
    lines.append(f'TEST_FILE: {", ".join(f.split("/")[-1] for f in test_files)}')
    lines.append(f'IMPL_SOURCE_FILES: {", ".join(f for f in impl_src)}')
    lines.append(f'EXISTING_ACS:')
    for ac in s.get('acceptanceCriteria', []):
        lines.append(f'  - {ac}')
    # Verification Criteria (VC) — the observable, mechanism-free checks the change
    # must satisfy. TEST CRITERIA should assert these directly; they are the
    # primary source of test facts (the ACs are the ticket intent).
    vc = s.get('verificationCriteria', [])
    if vc:
        lines.append(f'VERIFICATION_CRITERIA (derive the test facts primarily from these — each should become an assertion):')
        for v in vc:
            lines.append(f'  - {v}')
    lines.append('')

print('\n'.join(lines))
PYEOF
)

# RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
_tpl_vals=$(mktemp "${TMPDIR:-/tmp}/tc-writer-vals-XXXXXX.json")
jq -n --arg story_context "$STORY_CONTEXT" \
      --arg tc_out_file "$TC_OUT_FILE" \
      --arg tc_writer_profile "$TC_WRITER_PROFILE" \
      '{"__STORY_CONTEXT__":$story_context,"__TC_OUT_FILE__":$tc_out_file,"__TC_WRITER_PROFILE__":$tc_writer_profile}' > "$_tpl_vals" 2>/dev/null
if ! TC_PROMPT=$(render_engine_prompt tc-writer "$_tpl_vals"); then
    echo "[tc-writer] cannot render its prompt — refusing to run with no instructions" >&2
    rm -f "$_tpl_vals"; exit 1
fi
rm -f "$_tpl_vals"

# ── Run the TC writer agent ────────────────────────────────────────────────────
LOG_FILE="${SCRIPT_DIR}/../logs/tc-writer-${PHASE}.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "  [tc-writer] Invoking TC writer agent..."

# Resolve epam binary and keys
EPAM_BIN="${EPAM_BIN:-epam}"
# TC_WRITER_MODEL is set nowhere, so this default was the model the TC writer
# ACTUALLY ran on — the discontinued k2. Now the pipeline workhorse.
# THE SEAM DECIDES — see seam_ladder_export above, which sets EPAM_MODEL from this seam's
# declared tier. A literal here made that declaration decorative.
TC_MODEL="${TC_WRITER_MODEL:-${EPAM_MODEL:-}}"
TC_PROVIDER="${TC_WRITER_PROVIDER:-qwen}"

set +e
# `epam run` has no --cwd flag (Commander rejects it as unknown, always exit 1) —
# it operates on process.cwd() for its file tools, so change directory in a
# subshell instead of passing a nonexistent option.
(
  cd "$OUTPUT_DIR" && \
  EPAM_API_KEY_OPENAI="${OPENROUTER_API_KEY:-}" \
  EPAM_PROVIDER="$TC_PROVIDER" \
  EPAM_MODEL="$TC_MODEL" \
  EPAM_MAX_OUTPUT_TOKENS="${TC_WRITER_MAX_OUTPUT_TOKENS:-32768}" \
  EPAM_DANGEROUS_SKIP_APPROVAL=1 \
  EPAM_MAX_TOOL_CALLS="${TC_WRITER_MAX_TOOL_CALLS:-15}" \
    "$EPAM_BIN" run "$TC_PROMPT"
) 2>&1 | tee "$LOG_FILE"
TC_EXIT=${PIPESTATUS[0]}
set -e

# ── Validate and apply TCs to prd.json ─────────────────────────────────────────
python3 << PYEOF
import os as _os
# Backslash-free by necessity: this heredoc is UNQUOTED, so the shell collapses
# escape sequences before Python sees them — a regex here is silently corrupted.
def _is_test_file(f):
    f = f or ''
    base = f.split('/')[-1]
    if '__tests__/' in f or f.startswith('__tests__/'):
        return True
    if base.startswith('test_'):
        return True
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in base:
            return True
    return False
def _pair_key(f):
    f = f or ''
    for _m in ('.spec.', '.test.', '_spec.', '_test.'):
        if _m in f:
            return f[:f.rindex(_m)]
    return f.rsplit('.', 1)[0] if '.' in f.split('/')[-1] else f
def _test_base(f):
    return _pair_key((f or '').split('/')[-1])
def _manifest_files():
    try:
        with open(_os.environ.get('_TCW_MANIFEST', '')) as fh:
            return [l.strip() for l in fh if l.strip()]
    except OSError:
        return []
def _files_for(story):
    declared = (story.get('technicalNotes') or {}).get('files') or []
    produced = _manifest_files()
    if not produced:
        return declared
    base = set()
    for _f in declared:
        base.add(_pair_key(_f))
    extra = []
    for _f in produced:
        if _f in declared or _pair_key(_f) in base:
            extra.append(_f)
    return list(dict.fromkeys(declared + extra))
import json, re, sys, os
from datetime import datetime, timezone

prd_file   = '$PRD_FILE'
tc_file    = '$TC_OUT_FILE'
phase      = '$PHASE'
tc_exit    = $TC_EXIT
story_filter = '$STORY'

# Check agent exit FIRST — never use a stale tc_file from a previous run when
# the current agent invocation failed. Using old TCs on failure silently applies
# outdated criteria against new implementation code.
if tc_exit != 0:
    if os.path.exists(tc_file):
        print(f"  [tc-writer] ERROR: Agent failed (exit {tc_exit}) — stale TC file exists but will NOT be used (unsafe)", file=sys.stderr)
    else:
        print(f"  [tc-writer] ERROR: Agent failed (exit {tc_exit}) and no TC file written", file=sys.stderr)
    sys.exit(1)

if not os.path.exists(tc_file):
    print("  [tc-writer] WARNING: Agent succeeded but wrote no TC file — treating as no-op")
    sys.exit(0)

with open(tc_file) as f:
    tc_raw = f.read()
try:
    tc_data = json.loads(tc_raw)
except json.JSONDecodeError as e:
    # Root cause this repairs (found live, 2026-07-09, tier3-travel-app run):
    # the TC writer agent is explicitly asked to describe validation regexes
    # verbatim as "facts" (this PRD is full of date/IATA-code regex ACs) —
    # e.g. "regex /^\d{4}-\d{2}-\d{2}$/" — and routinely writes the literal
    # backslash from \d, \s, etc. into the JSON string without escaping it to
    # \\d. \d is not a valid JSON escape sequence, so json.load hard-fails and
    # the whole phase aborted even though every OTHER fact in the file was
    # fine. Since the invalid-escape defect class is narrow and mechanical
    # (a lone backslash not forming one of JSON's actual escape sequences),
    # repair it deterministically — escape any such backslash — and retry
    # once before giving up. A genuinely different JSON syntax error (missing
    # comma, unterminated string, etc.) will still fail after the repair
    # attempt, since this only touches backslash sequences.
    # Built from chr(92) rather than a literal backslash — this whole block
    # sits inside an UNQUOTED bash heredoc (<< PYEOF, not <<'PYEOF'), which
    # collapses literal '\\' sequences before Python ever sees them. A
    # callable repl (not a plain string) sidesteps re.sub's OWN backslash/
    # backreference processing on the replacement text entirely.
    #
    # Root cause of a SECOND live failure (found 2026-07-09, same run):
    # the original repair matched each backslash independently ("a backslash
    # not immediately followed by a valid escape char"), which corrupts an
    # ALREADY-VALID "\\" (escaped-backslash) pair — e.g. a regex fact like
    # "\\s\\-" is valid JSON (two proper \\  pairs), but the old regex saw
    # the SECOND backslash of each pair as "a backslash followed by 's'/'-',
    # neither of which is a valid escape char" and inserted a spurious extra
    # backslash, silently changing \s (whitespace) into \\s (literal
    # backslash-s) in the decoded string. Fixed by matching whole runs of
    # backslashes and only padding a run when its length is ODD (a genuine
    # dangling backslash) AND the character immediately after the run isn't
    # a valid escape completion — even-length runs (already-paired) are left
    # untouched.
    _bs = chr(92)
    _valid_escape_chars = (_bs, '"', '/', 'b', 'f', 'n', 'r', 't', 'u')

    def _repair_backslash_run(m):
        run, nxt = m.group(1), m.group(2)
        if len(run) % 2 == 1 and nxt not in _valid_escape_chars:
            run = run + _bs
        return run + nxt

    _pattern = '(' + (_bs * 2) + '+)(.)'
    repaired = re.sub(_pattern, _repair_backslash_run, tc_raw)
    try:
        tc_data = json.loads(repaired)
        print(f"  [tc-writer] WARNING: TC file had invalid JSON escape sequence(s) ({e}) — auto-repaired by escaping stray backslashes")
    except json.JSONDecodeError:
        print(f"  [tc-writer] ERROR: TC file is not valid JSON (repair attempt also failed): {e}", file=sys.stderr)
        sys.exit(1)

with open(prd_file) as f:
    prd = json.load(f)

phase_ids_list = prd.get('implementationOrder', {}).get(phase, [])
# Same fix as the two queries above — gating on whether a story is "in scope
# to apply a TC to" must always include the target (--story) story, even if
# implementationOrder[phase] transiently lacks it. peer_ids_for() below still
# iterates the ORIGINAL phase_ids_list for peer-file discovery, unaffected.
phase_ids = set(phase_ids_list)
if story_filter and story_filter not in phase_ids:
    phase_ids = phase_ids | {story_filter}
by_id = {s['id']: s for s in prd['stories']}
applied = []
skipped = []

# Deterministic mockStrategy override (2026-07-05): the LLM-authored mockStrategy
# sentence above is freeform prose and was the root cause of a live vi.requireActual/
# vi.importActual confusion (SKY-003) — the model's own words, not verified against
# real source. generate_story_contract() (claude.sh) already writes an exact,
# regex-derived mock-factory skeleton to .contracts/<dep-id>.md for every completed
# story with exported classes. When a test story's impl dependency has one, splice
# that skeleton in as testCriteria.mockStrategy instead of trusting prose — same
# "engine has no stack-specific knowledge, the .md content decides the syntax" split
# as generate_story_contract() itself: this script doesn't know vi.fn() from
# unittest.mock, it just copies whatever the contract file says.
contracts_dir = os.path.join('$OUTPUT_DIR', '.contracts')

FENCE = chr(96) * 3  # a literal triple-backtick inside this unquoted heredoc would
                      # trigger bash command substitution before python3 ever sees it

def find_contract_mock_skeleton(peer_ids):
    for pid in peer_ids:
        cpath = os.path.join(contracts_dir, f'{pid}.md')
        if not os.path.isfile(cpath):
            continue
        with open(cpath) as cf:
            text = cf.read()
        marker_idx = text.find('Mock factory skeleton')
        if marker_idx == -1:
            continue
        fence_start = text.find(FENCE, marker_idx)
        if fence_start == -1:
            continue
        fence_end = text.find(FENCE, fence_start + 3)
        if fence_end == -1:
            continue
        return text[fence_start:fence_end + 3].strip()
    return None

def peer_ids_for(sid):
    story = by_id.get(sid, {})
    files = _files_for(story)
    test_files = [f for f in files if _is_test_file(f)]
    test_bases = {_test_base(f) for f in test_files}
    peers = []
    for peer_id in phase_ids_list:
        if peer_id == sid:
            continue
        peer_files = by_id.get(peer_id, {}).get('technicalNotes', {}).get('files', [])
        peer_bases = {_pair_key(f.split('/')[-1]) for f in peer_files if not _is_test_file(f)}
        if test_bases & peer_bases:
            peers.append(peer_id)
    return peers

for story in prd['stories']:
    sid = story['id']
    if sid not in phase_ids:
        continue
    if sid not in tc_data:
        continue
    tc = tc_data[sid]
    # Agent may legitimately write null when it determines a story's source
    # files don't exist yet (e.g. a prior implementation story failed) —
    # treat as skipped, not a crash.
    if tc is None:
        skipped.append(f"{sid}: agent wrote null (source files not found)")
        continue
    # Validate required fields
    if not isinstance(tc.get('facts'), list) or len(tc['facts']) == 0:
        skipped.append(f"{sid}: empty facts array")
        continue
    # Stamp verifiedAt if agent omitted it
    if not tc.get('verifiedAt'):
        tc['verifiedAt'] = datetime.now(timezone.utc).isoformat()
    skeleton = find_contract_mock_skeleton(peer_ids_for(sid) + [sid])
    if skeleton:
        tc['mockStrategy'] = skeleton
    story['testCriteria'] = tc
    applied.append(sid)

_tmp_prd_file = prd_file + '.tmp'
with open(_tmp_prd_file, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_file, prd_file)

print(f"  [tc-writer] Applied TCs to {len(applied)} stories: {applied}")
if skipped:
    print(f"  [tc-writer] WARNING: Skipped {skipped}")

# Verify all needed stories got TCs — scoped to just --story when set, so an
# unrelated test story elsewhere in the phase whose impl hasn't run yet (and
# therefore correctly got a null/"source not found" TC) doesn't fail THIS
# story's gate.
by_id = {s['id']: s for s in prd['stories']}
still_missing = []
check_ids = [story_filter] if story_filter else phase_ids
for sid in check_ids:
    s = by_id.get(sid, {})
    files = _files_for(s)
    if any(_is_test_file(f) for f in files) and not s.get('testCriteria', {}).get('facts'):
        still_missing.append(sid)

if still_missing:
    print(f"  [tc-writer] ERROR: {len(still_missing)} test stories still missing TCs: {still_missing}", file=sys.stderr)
    sys.exit(1)

print(f"  [tc-writer] Gate PASSED — all test stories have verified TCs")
sys.exit(0)
PYEOF
