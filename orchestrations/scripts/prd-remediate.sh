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
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    *)     fail "Unknown argument: $1. Usage: --prd <path>" ;;
  esac
done

[ -z "$PRD_FILE" ] && fail "--prd <path> is required"
[ -f "$PRD_FILE" ] || fail "PRD file not found: $PRD_FILE"

info "Remediating PRD: $PRD_FILE"

python3 "$SCRIPT_DIR/_prd_remediate_impl.py" "$PRD_FILE"

info "Verifying PRD integrity post-remediation..."
if bash "$SCRIPT_DIR/preflight-prd-integrity.sh" --prd "$PRD_FILE"; then
    success "PRD remediation complete — integrity OK"
    exit 0
else
    fail "PRD integrity still failing after remediation — manual review required"
fi
