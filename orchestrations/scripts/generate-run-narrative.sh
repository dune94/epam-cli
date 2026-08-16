#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# generate-run-narrative.sh — Post-run prose narrative generator.
#
# Reads a tier3 run log and supporting orchestration log files and emits a
# detailed chronological prose narrative to stdout. Output reads like a
# technical incident report / engineering story covering every significant
# event from pre-run reset through final PRD state.
#
# Usage:
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log --phase scaffold
#   bash generate-run-narrative.sh --log /tmp/tier3-sky-jira-<ts>.log --phase all
#
# Requirements:
#   - python3 in PATH
#   - Run log must be from a COMPLETE successful run (script will refuse otherwise)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$(cd "$SCRIPT_DIR/../logs" && pwd)"
# The PRD comes from the run, never from a project-named default: a built-in path reports
# on whichever project it names rather than the one that just ran.
PRD_FILE="${PRD_FILE:-${MAIN_PRD_FILE:-}}"
if [ -z "$PRD_FILE" ]; then
  echo "[$(basename "$0")] no PRD: set PRD_FILE or MAIN_PRD_FILE — the engine names no project." >&2
  exit 2
fi

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${YELLOW}[narrative]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[narrative] ✓${NC} $*" >&2; }
fail()  { echo -e "${RED}[narrative] ✗${NC} $*" >&2; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
LOG_FILE=""
PHASE_FILTER="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)   LOG_FILE="$2"; shift 2 ;;
    --phase) PHASE_FILTER="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -20 | sed 's/^# \?//'
      exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$LOG_FILE" ]] || fail "Required: --log <path>"
[[ -f "$LOG_FILE" ]] || fail "Log file not found: $LOG_FILE"

# ── Validate run completeness ─────────────────────────────────────────────────
info "Validating run log: $LOG_FILE"

# Use python to validate the run log (avoids bash variable size issues with large logs)
VALIDATION=$(python3 "$SCRIPT_DIR/lib/handlers/run-log-validate.py" "$LOG_FILE"
)

case "$VALIDATION" in
  FAIL:no_phase_gate)
    fail "No completed phase gate found in log. This run did not complete any phase successfully. Refusing to narrate an incomplete run." ;;
  FAIL:pipeline_aborted)
    fail "Run log ends with a pipeline failure. This run did not complete successfully. Refusing to narrate an aborted run." ;;
  FAIL:has_*_failures)
    fail "Log contains pipeline failure(s). Only complete successful runs can be narrated." ;;
  OK:*)
    PHASE_GOS="${VALIDATION#OK:}"
    ok "Run log validated — $PHASE_GOS phase(s) completed successfully" ;;
  *)
    fail "Unexpected validation result: $VALIDATION" ;;
esac

# ── Emit narrative via Python ─────────────────────────────────────────────────
info "Generating narrative..."

python3 "$SCRIPT_DIR/lib/handlers/run-narrative-build.py" "$LOG_FILE" "$LOG_DIR" "$PRD_FILE" "$PHASE_FILTER"

ok "Narrative complete."
