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
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PRD_FILE" || ! -f "$PRD_FILE" ]]; then
  echo "  ✗ PRD file not found: $PRD_FILE" >&2; exit 1
fi

python3 << PYEOF
import json, re, sys

PRD_FILE = """$PRD_FILE"""
KNOWN_PROVIDERS = {'qwen', 'minimax', 'anthropic', 'claude', 'gemini', 'opencode', 'codex', 'cursor'}
KNOWN_MINIMAX_MODELS = {'MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M1.5', 'MiniMax-M1', 'upgrade'}
REQUIRED_PHASES = ['scaffold', 'core', 'ui_and_review']
MAX_ACS = 24

with open(PRD_FILE) as f:
    d = json.load(f)

stories    = d.get('stories', [])
impl_order = d.get('implementationOrder', {})
output_dir = d.get('project', {}).get('outputDir', '')
by_id      = {s['id']: s for s in stories}
active_ids = set(sid for phase in impl_order.values() for sid in phase)

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
        print(f"  ✓ Exactly 3 phases in correct order: {REQUIRED_PHASES}")
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
for sid in active_ids:
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
for sid in active_ids:
    s = by_id.get(sid, {})
    status    = s.get('status', 'pending')
    completed = s.get('completed', False)
    if status not in ('pending', 'deprecated') or completed:
        not_pending.append(f"{sid}(status={status},completed={completed})")
if not_pending:
    err(f"Active stories not in clean pending state: {not_pending[:5]}{'...' if len(not_pending)>5 else ''}")
else:
    print(f"  ✓ All {len(active_ids)} active stories are pending/clean")

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
for sid in active_ids:
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
    warn(f"testCriteria.sourceFiles reference files not declared in any story: {tc_source_bad}")
else:
    print("  ✓ All testCriteria.sourceFiles align with known story files")

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
