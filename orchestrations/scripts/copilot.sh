#!/usr/bin/env bash
# copilot.sh — Orchestration entry point for GitHub Copilot provider via epam-cli.
# Stories with aiProvider: copilot (or any story in a copilot-scoped run) will be
# executed via: epam run --provider copilot --model <model> --json
#
# Set EPAM_CLI=/path/to/mock for zero-token testing.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Ensure epam-run provider cases in claude.sh are reachable for per-story routing
export EPAM_CLI="${EPAM_CLI:-epam}"
export CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # fallback for non-epam stories
exec "$SCRIPT_DIR/claude.sh" "$@"
