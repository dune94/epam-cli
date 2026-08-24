#!/bin/bash
# Run the hello-world orchestration test using Python SDK invoke mode (EPAM_SDK_INVOKE=1).
#
# Identical to run-hello-world-test.sh but forces the Anthropic Python SDK
# shim (invoke.py) instead of the claude CLI binary.  This validates the SDK
# code-path end-to-end against the same stories and acceptance criteria.
#
# Usage:
#   ./run-hello-world-sdk-test.sh [-- extra run-agent-orchestration.sh flags]
#
# Env:
#   DRY_RUN=true   — show execution plan without running agents

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="$AUTOMATION_DIR/hello-world-prd.json"

if [ ! -f "$PRD_FILE" ]; then
    echo "ERROR: $PRD_FILE not found" >&2
    exit 1
fi

echo ""
echo "============================================"
echo "  Hello-World Orchestration Test (SDK mode)"
echo "============================================"
echo ""

export RESET_STORIES=true
export PRD_FILE="$PRD_FILE"
export EPAM_SDK_INVOKE=1
# THE CONTAMINATION GATE. Without it this launcher started a run on the PREVIOUS run's
# state: retry counts, ladder position, agent KB, agent-io, review feedback. `--reset`
# below is NOT this gate — it rewrites PRD story flags and clears checkpoints, nothing
# else. Six launchers gated and these did not; see lib/pre-run-reset-gate.sh.
# shellcheck source=lib/pre-run-reset-gate.sh
. "$SCRIPT_DIR/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"

exec "$SCRIPT_DIR/run-agent-orchestration.sh" \
     --phase hello_world_test \
     "$@"
