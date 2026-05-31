#!/bin/bash
# Asserts that phase-cost.jsonl contains at least one entry for each invoke mode
# (cli and sdk) for a given phase.  Fails with a clear message if either mode
# has never been recorded — making coverage gaps visible in CI or pre-merge checks.
#
# Usage:
#   ./check-invoke-coverage.sh <phase_id>
#   ./check-invoke-coverage.sh hello_world_test
#
# Exit codes:
#   0 — both cli and sdk invoke modes have been recorded for the phase
#   1 — one or both modes are missing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
COST_FILE="${COST_FILE:-$AUTOMATION_DIR/logs/phase-cost.jsonl}"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <phase_id>" >&2
    exit 1
fi

PHASE="$1"

if [ ! -f "$COST_FILE" ]; then
    echo "ERROR: phase-cost.jsonl not found at $COST_FILE" >&2
    echo "       Run the orchestration at least once to generate cost records." >&2
    exit 1
fi

_has_cli=$(grep -c "\"phase_id\":\"${PHASE}\".*\"invokeMode\":\"cli\"" "$COST_FILE" 2>/dev/null || true)
_has_sdk=$(grep -c "\"phase_id\":\"${PHASE}\".*\"invokeMode\":\"sdk\"" "$COST_FILE" 2>/dev/null || true)

echo ""
echo "Invoke-mode coverage for phase: $PHASE"
echo "  cli entries : $_has_cli"
echo "  sdk entries : $_has_sdk"
echo ""

_fail=0
if [ "$_has_cli" -eq 0 ]; then
    echo "MISSING: CLI mode (invokeMode:cli) — run: ./run-hello-world-test.sh"
    _fail=1
fi
if [ "$_has_sdk" -eq 0 ]; then
    echo "MISSING: SDK mode (invokeMode:sdk) — run: ./run-hello-world-sdk-test.sh"
    _fail=1
fi

if [ "$_fail" -eq 0 ]; then
    echo "PASS: both invoke modes are covered for phase '$PHASE'"
fi

exit $_fail
