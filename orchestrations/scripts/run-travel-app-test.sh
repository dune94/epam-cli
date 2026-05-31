#!/bin/bash
# Run the Skyscanner mini-app multi-agent orchestration test.
#
# Builds a full TypeScript flight-search app at /tmp/skyscanner-app using
# three specialist agents across three phases:
#   scaffold → core → ui_and_review
#
# Usage:
#   ./run-skyscanner-test.sh [--phase <phase>] [--dry-run] [-- extra flags]
#
# Env:
#   RAPIDAPI_KEY        — required for real API calls (agents embed it via env)
#   DRY_RUN=true        — show execution plan without running agents
#   AUTO_PROMOTE_PHASE  — set to true to chain phases automatically (default: false)
#   SKIP_AUTO_PR        — set to true to skip PR creation (default: false)
#
# The output directory /tmp/skyscanner-app is created on first run.
# Re-runs are idempotent: RESET_STORIES=true resets completed flags before
# each phase so agents start clean.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="$AUTOMATION_DIR/travel-app-prd.json"
OUTPUT_DIR="/tmp/skyscanner-app"

if [ ! -f "$PRD_FILE" ]; then
    echo "ERROR: $PRD_FILE not found" >&2
    exit 1
fi

# Parse --phase from args before forwarding
PHASE="scaffold"
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --phase) PHASE="$2"; shift 2 ;;
        *)       EXTRA_ARGS+=("$1"); shift ;;
    esac
done

# Create output directory so agents can write files immediately
mkdir -p "$OUTPUT_DIR"

echo ""
echo "============================================"
echo "  Skyscanner Mini-App Orchestration Test"
echo "  Phase: $PHASE"
echo "  Output: $OUTPUT_DIR"
echo "============================================"
echo ""

export RESET_STORIES=true
export PRD_FILE="$PRD_FILE"
export OUTPUT_LOGS="$AUTOMATION_DIR/logs/skyscanner"
exec "$SCRIPT_DIR/run-agent-orchestration.sh" \
     --phase "$PHASE" \
     "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
