#!/usr/bin/env bash
# preflight-prd-integrity.sh — exhaustive PRD integrity gate.
#
# Catches every category of PRD drift that has caused run failures:
#   - Stale runtime artifacts (BUG- stories, numbered bug-fix split suffixes)
#   - Provider/model misalignment
#   - Phase structure corruption
#   - Dirty pre-run state (non-pending active stories)
#   - Path drift (outputDir mismatch, /tmp/ stragglers)
#   - AC quality issues (phantom imports, oversized)
#
# Usage:
#   bash orchestrations/scripts/preflight-prd-integrity.sh --prd <path>
#
# Exit 0 = all checks passed. Exit 1 = one or more HARD failures.
# Warnings (⚠) are printed but do not fail the gate.

set -euo pipefail

PRD_FILE=""
PHASE_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    --phase) PHASE_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PRD_FILE" || ! -f "$PRD_FILE" ]]; then
  echo "  ✗ PRD file not found: $PRD_FILE" >&2; exit 1
fi

python3 << PYEOF
import json, re, sys

PRD_FILE = """$PRD_FILE"""
# Optional: scope the per-story "is this story in a clean/correct state right
# now" checks (#9, #10, #17) to a single phase's own implementationOrder,
# instead of the union across every phase.
#
# Root cause this fixes (found live, 2026-07-13, tier3-travel-app run): a
# scaffold story that legitimately becomes status=completed once its phase
# finishes was still counted in the ALL-PHASES active_ids union used by check
# #10 (clean pending state) on every SUBSEQUENT phase's remediation call --
# there was no way to say "only validate the phase I'm actually about to run."
# That made check #10 fail FOREVER on any pipeline that completes more than
# one phase, hard-aborting with "fix prd.json manually" on an otherwise
# perfectly healthy PRD. Checks that must stay PRD-wide (duplicate IDs across
# phases, phase order/structure, phantom story references) are unaffected --
# only the three checks whose failure mode is specifically "this story
# belongs to a different, already-finished phase" are scoped here.
PHASE_SCOPE = """$PHASE_ARG"""
KNOWN_PROVIDERS = {'qwen', 'minimax', 'anthropic', 'claude', 'gemini', 'opencode', 'codex', 'cursor'}
KNOWN_MINIMAX_MODELS = {'MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M1.5', 'MiniMax-M1', 'upgrade'}
# ui_and_review removed (2026-07-07): the pipeline is scaffold -> core only.
REQUIRED_PHASES = ['scaffold', 'core']
MAX_ACS = 24

with open(PRD_FILE) as f:
    d = json.load(f)

stories    = d.get('stories', [])
impl_order = d.get('implementationOrder', {})
output_dir = d.get('project', {}).get('outputDir', '')
by_id      = {s['id']: s for s in stories}
active_ids = set(sid for phase in impl_order.values() for sid in phase)
check_ids  = set(impl_order.get(PHASE_SCOPE, [])) if PHASE_SCOPE else active_ids

errors = []
warns  = []

def err(msg):  errors.append(msg)
def warn(msg): warns.append(msg)

# ── 1. No BUG- stories in stories[] ─────────────────────────────────────────
bug_stories = [s['id'] for s in stories if s['id'].startswith('BUG-')]
if bug_stories:
    err(f"Stale BUG- stories in stories[]: {bug_stories} — remove before run")
else:
    print("  ✓ No BUG- artifacts in stories[]")

# ── 2. No bug-fix runtime splits in implementationOrder ──────────────────────
# A stale split: ID matches <base>-(impl|test|table)-N AND the base is also active.
# Canonical stories like SKY-003a-test-3 are safe — "SKY-003a-test" is not active.
split_re = re.compile(r'^(.+)-(impl|test|table)-\d+$')
stale_active = [sid for sid in active_ids
                if (lambda m: m and m.group(1) in active_ids)(split_re.match(sid))]
if stale_active:
    err(f"Stale bug-fix split stories in active phases: {stale_active}")
else:
    print("  ✓ No stale bug-fix split stories in active phases")

# ── 3. Exactly the required phases, in order ────────────────────────────────
phases = list(impl_order.keys())
# Strip any bug_fix_* phases
extra_phases = [p for p in phases if p not in REQUIRED_PHASES]
missing_phases = [p for p in REQUIRED_PHASES if p not in phases]
if extra_phases:
    err(f"Extra/stale phases in implementationOrder: {extra_phases}")
if missing_phases:
    err(f"Missing required phases: {missing_phases}")
if not extra_phases and not missing_phases:
    # Check order
    idxs = [phases.index(p) for p in REQUIRED_PHASES if p in phases]
    if idxs == sorted(idxs):
        print(f"  ✓ Exactly {len(REQUIRED_PHASES)} phases in correct order: {REQUIRED_PHASES}")
    else:
        err(f"Phase order wrong: {phases}")

# ── 4. All implementationOrder IDs resolve to known stories ─────────────────
phantom = [sid for sid in active_ids if sid not in by_id]
if phantom:
    err(f"implementationOrder references unknown story IDs: {phantom}")
else:
    print(f"  ✓ All {len(active_ids)} active story IDs resolve")

# ── 5. No duplicate IDs within or across phases ──────────────────────────────
all_phase_ids = [sid for phase in impl_order.values() for sid in phase]
seen = set(); dupes = set()
for sid in all_phase_ids:
    if sid in seen: dupes.add(sid)
    seen.add(sid)
if dupes:
    err(f"Duplicate story IDs in implementationOrder: {sorted(dupes)}")
else:
    print("  ✓ No duplicate story IDs across phases")

# ── 6. No deprecated stories in implementationOrder ─────────────────────────
deprecated_active = [sid for sid in active_ids if by_id.get(sid, {}).get('status') == 'deprecated']
if deprecated_active:
    err(f"Deprecated stories appear in implementationOrder: {deprecated_active}")
else:
    print("  ✓ No deprecated stories in active phases")

# ── 7. Provider values are known — no 'openrouter' literal ──────────────────
bad_providers = {}
for s in stories:
    prov = s.get('aiProvider', '')
    if prov and prov not in KNOWN_PROVIDERS:
        bad_providers[s['id']] = prov
if bad_providers:
    err(f"Unknown aiProvider values (check for 'openrouter' literal): {bad_providers}")
else:
    print(f"  ✓ All aiProvider values are known ({KNOWN_PROVIDERS})")

# ── 8. Model/provider alignment ──────────────────────────────────────────────
misaligned = []
for s in stories:
    if s['id'] not in active_ids:
        continue
    prov  = s.get('aiProvider', '')
    model = s.get('model', '')
    if prov == 'qwen' and model and '/' not in model:
        misaligned.append(f"{s['id']}: aiProvider=qwen but model='{model}' (expected openrouter slug with '/')")
    if prov == 'minimax' and model and model not in KNOWN_MINIMAX_MODELS:
        warn(f"{s['id']}: aiProvider=minimax model='{model}' not in known set {KNOWN_MINIMAX_MODELS}")
if misaligned:
    err(f"Provider/model misalignment in active stories: {misaligned}")
else:
    print("  ✓ Active story provider/model alignment OK")

# ── 9. .test.ts active stories must use qwen (not minimax) ──────────────────
test_ts_minimax = []
for sid in check_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    if any(f.endswith('.test.ts') for f in files) and s.get('aiProvider') == 'minimax':
        test_ts_minimax.append(sid)
if test_ts_minimax:
    err(f".test.ts active stories using minimax (must use qwen/K2): {test_ts_minimax}")
else:
    print("  ✓ All active .test.ts stories use qwen provider")

# ── 10. Clean slate — all active stories pending/not completed ───────────────
not_pending = []
for sid in check_ids:
    s = by_id.get(sid, {})
    status    = s.get('status', 'pending')
    completed = s.get('completed', False)
    if status not in ('pending', 'deprecated') or completed:
        not_pending.append(f"{sid}(status={status},completed={completed})")
if not_pending:
    err(f"Active stories not in clean pending state: {not_pending[:5]}{'...' if len(not_pending)>5 else ''}")
else:
    print(f"  ✓ All {len(check_ids)} active stories are pending/clean")

# ── 11. All active stories have required fields ──────────────────────────────
missing_fields = []
for sid in active_ids:
    s = by_id.get(sid, {})
    if not s.get('effort'):
        missing_fields.append(f"{sid}: missing effort")
    if not s.get('aiProvider'):
        missing_fields.append(f"{sid}: missing aiProvider")
if missing_fields:
    err(f"Active stories missing required fields: {missing_fields}")
else:
    print("  ✓ All active stories have required fields (effort, aiProvider)")

# ── 12. outputDir is an absolute literal path ────────────────────────────────
if not output_dir:
    err("project.outputDir is not set in PRD")
elif output_dir.startswith('/') and '$' not in output_dir and '{' not in output_dir:
    print(f"  ✓ project.outputDir is absolute literal: {output_dir}")
else:
    err(f"project.outputDir is not an absolute literal path (no shell vars allowed): '{output_dir}'")

# ── 13. All active story file paths under outputDir (no /tmp/ stragglers) ────
if output_dir and '$' not in output_dir:
    bad_paths = []
    for sid in active_ids:
        s = by_id.get(sid, {})
        for f in s.get('technicalNotes', {}).get('files', []):
            if not f.startswith(output_dir):
                bad_paths.append(f"{sid}: {f}")
    if bad_paths:
        err(f"Story file paths not under outputDir ({output_dir}): {bad_paths[:5]}{'...' if len(bad_paths)>5 else ''}")
    else:
        print(f"  ✓ All active story file paths are under outputDir")

# ── 14. No story exceeds 24 ACs ─────────────────────────────────────────────
oversized = [(s['id'], len(s.get('acceptanceCriteria', []))) for s in stories
             if s['id'] in active_ids and len(s.get('acceptanceCriteria', [])) > MAX_ACS]
if oversized:
    err(f"Active stories exceed {MAX_ACS} ACs (speckit limit): {oversized}")
else:
    print(f"  ✓ All active stories within {MAX_ACS} AC limit")

# ── 15. No AC references ./types phantom module ──────────────────────────────
phantom_types = []
for sid in active_ids:
    s = by_id.get(sid, {})
    for ac in s.get('acceptanceCriteria', []):
        if "./types'" in ac or './types"' in ac:
            phantom_types.append(sid)
            break
if phantom_types:
    err(f"Active stories have ACs referencing phantom './types' module: {phantom_types}")
else:
    print("  ✓ No ACs reference phantom './types' module")

# ── 16. No AC prescribes an import path not declared in story files ──────────
phantom_imports = []
import_re = re.compile(r"""from ['"](\./[^'"]+)['"]""")
for sid in active_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    # Build set of basenames declared by this story
    basenames = {f.split('/')[-1].replace('.ts', '').replace('.js', '') for f in files}
    for ac in s.get('acceptanceCriteria', []):
        for imp in import_re.findall(ac):
            imp_base = imp.lstrip('./').replace('.ts', '').replace('.js', '')
            if imp_base not in basenames and imp != './types':
                phantom_imports.append(f"{sid}: AC imports '{imp}' not in story files")
                break
if phantom_imports:
    warn(f"ACs reference import paths not declared in story files (may be cross-story): {phantom_imports[:3]}")
else:
    print("  ✓ AC import paths align with declared story files")

# ── 17. Test stories have testCriteria stub (schema presence check) ──────────
# Full TC content is written at runtime by the TC writer gate.
# Preflight only verifies the schema field exists so the pipeline can
# detect which stories need TC generation before test execution starts.
test_stories_missing_tc_field = []
for sid in check_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    is_test_story = any(f.endswith('.test.ts') for f in files)
    if is_test_story and 'testCriteria' not in s:
        test_stories_missing_tc_field.append(sid)
if test_stories_missing_tc_field:
    err(f"Test stories missing testCriteria field (add stub before run): {test_stories_missing_tc_field}")
else:
    print("  ✓ All active test stories have testCriteria field")

# ── 18. testCriteria.sourceFiles align with known impl stories ───────────────
tc_source_bad = []
all_story_files = set()
for s in stories:
    for f in s.get('technicalNotes', {}).get('files', []):
        all_story_files.add(f.split('/')[-1])
for sid in active_ids:
    s = by_id.get(sid, {})
    tc = s.get('testCriteria') or {}
    for src in tc.get('sourceFiles', []):
        bname = src.split('/')[-1]
        if bname and bname not in all_story_files:
            tc_source_bad.append(f"{sid}: sourceFiles references unknown file '{bname}'")
if tc_source_bad:
    # Hard failure, not a warning (upgraded 2026-07-09, pipeline audit): unlike
    # check #16 (AC import paths — a "from './x'" mention is often a
    # legitimate cross-story reference, since importing a file you don't own
    # is completely normal), this checks against the UNION of every story's
    # OWN declared files. A sourceFile that matches NOTHING anywhere in the
    # whole project's declared scope is not a normal cross-reference — it is
    # either a hallucinated file the TC writer never actually read, or a stale
    # reference surviving a rename/split. Both silently corrupt test
    # generation if only warned about, not blocked.
    err(f"testCriteria.sourceFiles reference files not declared in any story: {tc_source_bad}")
else:
    print("  ✓ All testCriteria.sourceFiles align with known story files")

# ── 19. No AC references a file path outside this story's own scope ─────────
# Root cause this catches (found live, 2026-07-09, tier3-travel-app run):
# check #16 above only matches "from './x'" IMPORT syntax in AC text — it
# missed a spec-pass elaboration that wrote a NATURAL-LANGUAGE AC on SKY-001
# ("/…/skyscanner-app/src/server.ts file exists and is a valid TypeScript
# file") referencing server.ts, a file that belongs to a DIFFERENT story
# (SKY-004) and was never in SKY-001's own technicalNotes.files. The
# implementation (correctly scope-guarded) never created server.ts, so the
# AC went permanently unmet and the spec-validator testing gate failed the
# whole phase — with no indication the root cause was an elaboration defect,
# not an implementation gap. This is a HARD failure (not check #16's warn),
# since a story that can NEVER satisfy its own AC blocks the phase forever.
#
# Only matches an EXISTENCE claim ("<path> exists" / "<path> file exists"),
# not a cross-story reference — a legitimate AC pattern is "type imported
# from the SKY-002 export (e.g. src/skyscanner/client.ts)", which mentions
# a file another story owns for import-consistency purposes, not a claim
# that THIS story must create it. Distinguishing on "exists" immediately
# following the path (not merely mentioning the path) avoids flagging that.
scope_violations = []
path_re = re.compile(r'\b(src/[\w./-]+\.(?:ts|tsx|js|jsx))\b\s+(?:file\s+)?exists\b')
for sid in active_ids:
    s = by_id.get(sid, {})
    files = s.get('technicalNotes', {}).get('files', [])
    declared_rel = set()
    for f in files:
        # Normalize to a project-relative form (src/...) so absolute paths
        # under any outputDir compare equal to the story's own declared files.
        m = re.search(r'(src/[\w./-]+)$', f)
        if m:
            declared_rel.add(m.group(1))
    for ac in s.get('acceptanceCriteria', []):
        for mentioned in path_re.findall(ac):
            if mentioned not in declared_rel:
                scope_violations.append(f"{sid}: AC references '{mentioned}' — not in this story's technicalNotes.files")
if scope_violations:
    err(f"ACs reference file paths outside the story's own declared scope (elaboration defect — story can never satisfy its own AC): {scope_violations}")
else:
    print("  ✓ No AC references a file path outside its own story's declared scope")

# NOTE: a check for "no pre-baked specification block" was tried here and
# reverted (2026-07-06) — this script only runs on the POST-split-pass branch
# (is_canonical bypass in preflight-check.sh/prd-remediate.sh routes here only
# once spec pass has already produced split children), so by the time this
# script runs, every active story legitimately HAS a specification block from
# this run's own elaboration. There is no way to distinguish "stale, baked
# into canonical" from "legitimate, this run" using only this script's inputs.
# The real fix for stale pre-baked specification data lives in the
# is_canonical branches of preflight-check.sh and prd-remediate.sh instead,
# which run BEFORE spec pass and can correctly check "specification present
# AND not yet completed" == prior-run contamination.

# ── Summary ──────────────────────────────────────────────────────────────────
print("")
for w in warns:
    print(f"  ⚠  {w}")
if errors:
    print(f"\n  ✗ {len(errors)} integrity error(s):")
    for e in errors:
        print(f"    • {e}")
    sys.exit(1)
else:
    print(f"  ✓ PRD integrity OK — {len(active_ids)} active stories across {len(REQUIRED_PHASES)} phases")
    sys.exit(0)
PYEOF
