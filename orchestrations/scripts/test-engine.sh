#!/bin/bash
# Regression test for the epam-cli orchestration engine.
#
# epam-cli is a seeding engine — it reads configuration (PRD, profiles) and
# builds apps in external directories.  This script proves the engine still
# seeds correctly by running the hello-world fixture (the simplest possible
# PRD) through both invoke paths and asserting the output app was produced.
#
# Run this manually after changing any engine script:
#   claude.sh, ai-run.sh, run-agent-orchestration.sh,
#   contextualize-stories.sh, invoke.py, check-phase-gate.sh
#
# Usage:
#   ./test-engine.sh
#
# Exit codes:
#   0 — engine seeded correctly in both CLI and SDK modes
#   1 — one or both modes failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_pass=0
_fail=0
_results=()

run_mode() {
    local label="$1"
    local script="$2"
    local log="/tmp/test-engine-${label}.log"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $label"
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

run_mode "CLI invoke path  (EPAM_SDK_INVOKE=0)" "run-hello-world-test.sh"
run_mode "SDK invoke path  (EPAM_SDK_INVOKE=1)" "run-hello-world-sdk-test.sh"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "  epam-cli Engine Regression — Results"
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
