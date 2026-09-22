#!/usr/bin/env bash
# preflight-prd-integrity.sh — exhaustive PRD integrity gate.
#
# Catches every category of PRD drift that has caused run failures:
#   - Stale runtime artifacts (BUG- stories, numbered bug-fix split suffixes)
#   - Provider/model misalignment
#   - Phase structure corruption
#   - Dirty pre-run state (non-pending active stories)
#   - Path drift (outputDir mismatch, /tmp/ stragglers)
#   - AC quality issues (phantom imports, oversized)
#
# Usage:
#   bash orchestrations/scripts/preflight-prd-integrity.sh --prd <path>
#
# Exit 0 = all checks passed. Exit 1 = one or more HARD failures.
# Warnings (⚠) are printed but do not fail the gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PRD_FILE=""
PHASE_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    --phase) PHASE_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PRD_FILE" || ! -f "$PRD_FILE" ]]; then
  echo "  ✗ PRD file not found: $PRD_FILE" >&2; exit 1
fi

python3 "$SCRIPT_DIR/lib/handlers/prd-integrity-audit.py" "$PHASE_ARG" "$PRD_FILE" "$SCRIPT_DIR/../config/providers.json"
