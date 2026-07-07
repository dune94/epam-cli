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
PRD_FILE=""
PHASE=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --prd)        PRD_FILE="$2";    shift 2 ;;
    --phase)      PHASE="$2";       shift 2 ;;
    --output-dir) OUTPUT_DIR="$2";  shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ "${SKIP_TC_WRITER:-0}" = "1" ]]; then
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

with open('$PRD_FILE') as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get('$PHASE', [])
by_id = {s['id']: s for s in d['stories']}
results = []

for sid in phase_ids:
    s = by_id.get(sid, {})
    # Defensive check (found live, 2026-07-06, tier3-full-run-15): a story
    # that was split delegates its ENTIRE implementation to child stories —
    # its own technicalNotes.files still lists the original (now-delegated)
    # files, so it can look like a "test story with no TC yet" even though
    # the real work (and TC) belongs to a child. spec-mode-runner now removes
    # a delegated parent from implementationOrder and marks it deprecated/
    # completed at split time, so this should be redundant — kept as a second
    # line of defense in case some other path leaves a stale parent behind.
    if s.get('status') == 'deprecated' or s.get('completed') is True:
        continue
    files = s.get('technicalNotes', {}).get('files', [])
    is_test_story = any(f.endswith('.test.ts') for f in files)
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

with open('$PRD_FILE') as f:
    d = json.load(f)

phase_ids = d.get('implementationOrder', {}).get('$PHASE', [])
by_id = {s['id']: s for s in d['stories']}
output_dir = '$OUTPUT_DIR'

lines = []
for sid in phase_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    is_test_story = any(f.endswith('.test.ts') for f in files)
    if not is_test_story:
        continue
    if s.get('testCriteria', {}).get('facts'):
        continue

    impl_files = [f for f in files if not f.endswith('.test.ts')]
    test_files = [f for f in files if f.endswith('.test.ts')]

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
        peer_files = ps.get('technicalNotes', {}).get('files', [])
        # A peer is an impl story sharing a non-test filename base
        test_bases = {f.split('/')[-1].replace('.test.ts', '') for f in test_files}
        peer_bases = {f.split('/')[-1].replace('.ts', '') for f in peer_files if not f.endswith('.test.ts')}
        if test_bases & peer_bases:
            impl_src.extend(peer_files)

    impl_src = list(dict.fromkeys(impl_src))  # dedupe, preserve order

    lines.append(f'STORY_ID: {sid}')
    lines.append(f'TEST_FILE: {", ".join(f.split("/")[-1] for f in test_files)}')
    lines.append(f'IMPL_SOURCE_FILES: {", ".join(f for f in impl_src)}')
    lines.append(f'EXISTING_ACS:')
    for ac in s.get('acceptanceCriteria', []):
        lines.append(f'  - {ac}')
    lines.append('')

print('\n'.join(lines))
PYEOF
)

read -r -d '' TC_PROMPT << PROMPT_EOF || true
${TC_WRITER_PROFILE}

## Your ONLY output is a valid JSON object — nothing else

Output format (one object, all story IDs as keys):
{
  "<story-id>": {
    "verifiedAt": "<ISO8601 timestamp>",
    "sourceFiles": ["src/server.ts"],
    "facts": [
      "<concrete verifiable fact from source, e.g.: GET /search only — no /cheapest route exists>",
      "<exact query param names used: 'from' and 'to' not 'origin'/'destination'>",
      "<exact error shape: { error: string } with 400 status for missing params>"
    ],
    "mockStrategy": "<exact mock setup: e.g. vi.mock('./skyscanner/client') with vi.hoisted constructor>",
    "bannedPatterns": ["<string that must NOT appear in test file>"]
  }
}

## Stories to process

${STORY_CONTEXT}

## Instructions

For each story above:

1. READ every IMPL_SOURCE_FILES path listed using your file reading tool. Read the COMPLETE file.

2. Extract FACTS — only things you can verify by reading the source:
   - Exact function/method signatures and parameter names
   - Exact HTTP route paths and query parameter names
   - Exact error message strings (copy verbatim from throw/send statements)
   - Exact return shapes (copy from return statements)
   - Alignment direction (left/right-pad) per column if it's a table story
   - Which validations exist and which do not (e.g. "adults=0 is valid — no lower-bound check")
   - The correct import path for the module under test

3. Write MOCK_STRATEGY as a single sentence describing exactly how to mock dependencies:
   - Include the exact vi.mock() path (e.g. './skyscanner/client' not './client')
   - State whether to use vi.stubGlobal, vi.hoisted, or constructor mock
   - State whether beforeEach uses clearAllMocks or resetAllMocks

4. Write BANNED_PATTERNS as strings that must not appear in the test file:
   - Wrong endpoint paths that don't exist
   - Wrong parameter names
   - Wrong framework imports (@jest/globals)
   - Wrong mock paths

5. The testCriteria.facts OVERRIDE any conflicting AC. Write them as ground truth.

6. Write your JSON to: ${TC_OUT_FILE}
   Use WriteFile to write the complete JSON object to that path.

CRITICAL: Output ONLY the JSON object in the file. No markdown, no explanation, no code fences.
After writing the file, output a single line: TC_WRITER_DONE
PROMPT_EOF

# ── Run the TC writer agent ────────────────────────────────────────────────────
LOG_FILE="${SCRIPT_DIR}/../logs/tc-writer-${PHASE}.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "  [tc-writer] Invoking TC writer agent..."

# Resolve epam binary and keys
EPAM_BIN="${EPAM_BIN:-epam}"
TC_MODEL="${TC_WRITER_MODEL:-moonshotai/kimi-k2}"
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
  EPAM_MAX_TOKENS=8192 \
  EPAM_DANGEROUS_SKIP_APPROVAL=1 \
    "$EPAM_BIN" run "$TC_PROMPT"
) 2>&1 | tee "$LOG_FILE"
TC_EXIT=${PIPESTATUS[0]}
set -e

# ── Validate and apply TCs to prd.json ─────────────────────────────────────────
python3 << PYEOF
import json, sys, os
from datetime import datetime, timezone

prd_file   = '$PRD_FILE'
tc_file    = '$TC_OUT_FILE'
phase      = '$PHASE'
tc_exit    = $TC_EXIT

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

try:
    with open(tc_file) as f:
        tc_data = json.load(f)
except json.JSONDecodeError as e:
    print(f"  [tc-writer] ERROR: TC file is not valid JSON: {e}", file=sys.stderr)
    sys.exit(1)

with open(prd_file) as f:
    prd = json.load(f)

phase_ids_list = prd.get('implementationOrder', {}).get(phase, [])
phase_ids = set(phase_ids_list)
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
    files = story.get('technicalNotes', {}).get('files', [])
    test_files = [f for f in files if f.endswith('.test.ts')]
    test_bases = {f.split('/')[-1].replace('.test.ts', '') for f in test_files}
    peers = []
    for peer_id in phase_ids_list:
        if peer_id == sid:
            continue
        peer_files = by_id.get(peer_id, {}).get('technicalNotes', {}).get('files', [])
        peer_bases = {f.split('/')[-1].replace('.ts', '') for f in peer_files if not f.endswith('.test.ts')}
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

with open(prd_file, 'w') as f:
    json.dump(prd, f, indent=2)

print(f"  [tc-writer] Applied TCs to {len(applied)} stories: {applied}")
if skipped:
    print(f"  [tc-writer] WARNING: Skipped {skipped}")

# Verify all needed stories got TCs
by_id = {s['id']: s for s in prd['stories']}
still_missing = []
for sid in phase_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    if any(f.endswith('.test.ts') for f in files) and not s.get('testCriteria', {}).get('facts'):
        still_missing.append(sid)

if still_missing:
    print(f"  [tc-writer] ERROR: {len(still_missing)} test stories still missing TCs: {still_missing}", file=sys.stderr)
    sys.exit(1)

print(f"  [tc-writer] Gate PASSED — all test stories have verified TCs")
sys.exit(0)
PYEOF
