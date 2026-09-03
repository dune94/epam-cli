#!/usr/bin/env bash
# mock-epam-run.sh — Zero-token mock for `epam run --json` used in orchestration tests.
#
# Usage:
#   EPAM_CLI="$(dirname "$0")/mock-epam-run.sh" ./copilot.sh --prd ...
#
# Reads stdin (the prompt) and returns a canned JSON response that matches the
# real `epam run --json` output schema:
#   { result, cost_usd, usage: { inputTokens, outputTokens, totalTokens } }
#
# The --provider and --model flags are captured so tests can verify routing.
# They are written to MOCK_LOG (default: /tmp/mock-epam-run.log) if set.

set -euo pipefail

# Parse flags
provider=""
model=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        run) shift ;;                          # epam run ...
        --provider) provider="$2"; shift 2 ;;
        --model) model="$2"; shift 2 ;;
        # --json is accepted and ignored: this mock always emits JSON, so the flag set a variable
        # nothing read. Saying so beats keeping a dead assignment to satisfy the analyser.
        --json) shift ;;
        -) shift; cat > /dev/null ;;           # consume stdin
        *) shift ;;
    esac
done

# Log invocation for test assertions
if [[ -n "${MOCK_LOG:-}" ]]; then
    echo "provider=$provider model=$model" >> "$MOCK_LOG"
fi

# Emit canned JSON matching epam run --json schema
cat <<JSON
{
  "result": "Mock response from epam-run mock (provider=$provider, model=$model)",
  "cost_usd": 0.0042,
  "usage": {
    "inputTokens": 120,
    "outputTokens": 80,
    "totalTokens": 200
  }
}
JSON
