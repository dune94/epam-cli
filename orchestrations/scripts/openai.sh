#!/usr/bin/env bash
# openai.sh — Orchestration entry point for OpenAI provider via epam-cli.
# Stories with aiProvider: openai will be executed via:
#   epam run --provider openai --model <model> --json
#
# Set EPAM_CLI=/path/to/mock for zero-token testing.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export EPAM_CLI="${EPAM_CLI:-epam}"
export CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # fallback for non-epam stories
exec "$SCRIPT_DIR/claude.sh" "$@"
