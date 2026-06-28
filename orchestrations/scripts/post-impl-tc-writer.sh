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

    # Find impl peer files from paired impl story
    impl_src = []
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
You are the TC writer agent. Your job is to generate testCriteria JSON for test stories by reading actual implementation source files.

## Your ONLY output is a valid JSON object — nothing else

Output format (one object, all story IDs as keys):
{
  "SKY-004-B-TEST": {
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
EPAM_API_KEY_OPENAI="${OPENROUTER_API_KEY:-}" \
EPAM_PROVIDER="$TC_PROVIDER" \
EPAM_MODEL="$TC_MODEL" \
EPAM_MAX_TOKENS=8192 \
EPAM_DANGEROUS_SKIP_APPROVAL=1 \
  "$EPAM_BIN" run "$TC_PROMPT" \
  --cwd "$OUTPUT_DIR" \
  2>&1 | tee "$LOG_FILE"
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

if not os.path.exists(tc_file):
    if tc_exit != 0:
        print(f"  [tc-writer] ERROR: Agent failed (exit {tc_exit}) and no TC file written", file=sys.stderr)
        sys.exit(1)
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

phase_ids = set(prd.get('implementationOrder', {}).get(phase, []))
applied = []
skipped = []

for story in prd['stories']:
    sid = story['id']
    if sid not in phase_ids:
        continue
    if sid not in tc_data:
        continue
    tc = tc_data[sid]
    # Validate required fields
    if not isinstance(tc.get('facts'), list) or len(tc['facts']) == 0:
        skipped.append(f"{sid}: empty facts array")
        continue
    # Stamp verifiedAt if agent omitted it
    if not tc.get('verifiedAt'):
        tc['verifiedAt'] = datetime.now(timezone.utc).isoformat()
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
