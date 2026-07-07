#!/usr/bin/env bash
# prd-remediate.sh — Auto-remediate PRD state before each phase run.
#
# Fixes every category of drift that causes test failures when a prior run
# mutated the PRD (failed mid-phase, spec agents inflated ACs, split stories
# were left in implementationOrder, etc.).
#
# Remediation steps (all idempotent):
#   1. Remove stale bug-fix runtime splits from implementationOrder + stories[]
#   2. Remove no-files stories from implementationOrder (kept in stories[] as archive)
#   3. Trim any story exceeding 24 ACs back to exactly 24
#   4. Deduplicate file paths within each phase (first-seen wins)
#   5. Remove extra/stale phases (anything not in scaffold|core|ui_and_review)
#   6. Reset all active story status to pending + completed=false
#   7. Strip one-off runtime fields (startedAt, completedAt, actualCost, error)
#   8. Run preflight-prd-integrity.sh to verify clean state
#
# Usage:
#   bash orchestrations/scripts/prd-remediate.sh --prd <path>
#
# Exit 0 = PRD is in clean state after remediation.
# Exit 1 = Remediation completed but preflight still reports errors.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[prd-remediate]${NC} $*"; }
success() { echo -e "${GREEN}[prd-remediate] ✓${NC} $*"; }
fail()    { echo -e "${RED}[prd-remediate] ✗${NC} $*" >&2; exit 1; }

PRD_FILE=""
PHASE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    *)     fail "Unknown argument: $1. Usage: --prd <path> [--phase <phase>]" ;;
  esac
done

[ -z "$PRD_FILE" ] && fail "--prd <path> is required"
[ -f "$PRD_FILE" ] || fail "PRD file not found: $PRD_FILE"

info "Remediating PRD: $PRD_FILE"

# --phase scopes the destructive status-reset step to that phase's stories only —
# without it, remediation between phases would reset already-completed prior-phase
# stories back to pending. Omit --phase for a fresh-run full reset (all phases).
python3 "$SCRIPT_DIR/_prd_remediate_impl.py" "$PRD_FILE" ${PHASE:+"$PHASE"}

# Detect canonical (pre-spec-pass) state FOR THIS PHASE: if none of THIS
# PHASE's own active stories are elaborated (no createdFrom), skip the strict
# phase/field checks. Strict checks require aiProvider, testCriteria, and
# ui_and_review — none exist on base user stories before the spec pass runs.
#
# Root cause of a real bug (found live, 2026-07-06, tier3-full-run-17): this
# check used to scan ALL stories in the PRD, not just the current phase's. The
# first time ANY phase (e.g. scaffold) ever produced a split, is_canonical
# became false for EVERY later phase too — including core, whose own stories
# (SKY-002/003/004) hadn't been spec-elaborated yet and correctly had no
# testCriteria/ui_and_review at that point. Core's preflight then ran the full
# strict checks against its own genuinely-pre-spec-pass stories and failed
# immediately, blocking the phase from ever starting. Scope the check to only
# the phase actually being validated.
_is_canonical=$(python3 -c "
import json, sys
d = json.load(open('$PRD_FILE'))
phase_ids = set(d.get('implementationOrder', {}).get('$PHASE', []))
by_id = {s['id']: s for s in d['stories']}
has_splits = any(by_id.get(sid, {}).get('specification', {}).get('createdFrom') for sid in phase_ids)
print('false' if has_splits else 'true')
" 2>/dev/null || echo "false")

info "Verifying PRD integrity post-remediation..."
if [ "$_is_canonical" = "true" ]; then
    # Base stories not yet processed in THIS run should carry no pre-baked
    # 'specification' block from a prior run — the has_splits check above
    # only catches createdFrom (split children), not stale status/
    # coordinatorReview data left on a base story. A story already
    # completed=true in THIS run (e.g. SKY-001 after the scaffold phase)
    # legitimately carries its own real specification data from this run's
    # own spec pass — only PENDING stories carrying specification data are
    # a sign of prior-run contamination baked into canonical.
    _stale_spec=$(python3 -c "
import json
d = json.load(open('$PRD_FILE'))
print(','.join(s['id'] for s in d.get('stories', []) if s.get('specification') and not s.get('completed')))
" 2>/dev/null || echo "")
    if [ -n "$_stale_spec" ]; then
        fail "Canonical PRD has pre-baked 'specification' blocks on base stories (must be lean/unelaborated): $_stale_spec"
    fi
    _count=$(python3 -c "import json; print(len(json.load(open('$PRD_FILE'))['stories']))" 2>/dev/null || echo "?")
    success "PRD is canonical (pre-spec-pass, $_count base user stories) — strict checks skipped until spec pass elaborates"
    exit 0
fi

if bash "$SCRIPT_DIR/preflight-prd-integrity.sh" --prd "$PRD_FILE"; then
    success "PRD remediation complete — integrity OK"
    exit 0
else
    fail "PRD integrity still failing after remediation — manual review required"
fi
