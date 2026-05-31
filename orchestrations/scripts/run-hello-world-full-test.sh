#!/bin/bash
# Full dual-mode validation for hello-world: runs CLI mode then SDK mode in sequence.
#
# Both runs must pass for the script to exit 0.  Produces a combined summary
# so a single command proves both invoke paths work.
#
# Usage:
#   ./run-hello-world-full-test.sh
#
# Env:
#   DRY_RUN=true   — pass through to both runs (preview only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_pass=0
_fail=0
_results=()

run_mode() {
    local label="$1"
    local script="$2"
    local log="/tmp/hw-full-test-${label}.log"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Running: $label"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    if "$SCRIPT_DIR/$script" 2>&1 | tee "$log"; then
        _pass=$((_pass + 1))
        _results+=("  PASS  $label")
    else
        _fail=$((_fail + 1))
        _results+=("  FAIL  $label  (log: $log)")
    fi
}

run_mode "CLI mode (EPAM_SDK_INVOKE=0)" "run-hello-world-test.sh"
run_mode "SDK mode (EPAM_SDK_INVOKE=1)" "run-hello-world-sdk-test.sh"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "  Hello-World Full Test — Results"
echo "╠══════════════════════════════════════════════╣"
for r in "${_results[@]}"; do
    echo "  $r"
done
echo "╠══════════════════════════════════════════════╣"
echo "  Passed: $_pass / $((_pass + _fail))"
echo "╚══════════════════════════════════════════════╝"
echo ""

if [ "$_fail" -gt 0 ]; then
    exit 1
fi
