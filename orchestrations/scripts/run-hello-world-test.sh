#!/bin/bash
# Run the hello-world repeatable orchestration test.
#
# Resets all stories to pending, then runs the full pipeline for the
# hello_world_test phase using game-prd.json.
#
# Usage:
#   ./run-hello-world-test.sh [-- extra run-agent-orchestration.sh flags]
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
echo "  Hello-World Orchestration Test"
echo "============================================"
echo ""

export RESET_STORIES=true
export PRD_FILE="$PRD_FILE"
exec "$SCRIPT_DIR/run-agent-orchestration.sh" \
     --phase hello_world_test \
     "$@"
