#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# generate-qa-report.sh — Post-run QA/Test HTML report generator.
#
# Reads vitest-oracle-*.json, tc-*.json, npm-audit-oracle-*.json, gate logs,
# and travel-app-prd.json to produce a self-contained dark-theme HTML report.
# All data is embedded statically — no external fetch calls at view time.
#
# Usage:
#   bash generate-qa-report.sh --log /tmp/tier3-sky-jira-<ts>.log --out /tmp/qa-report.html
#   bash generate-qa-report.sh --log /tmp/tier3-sky-jira-<ts>.log --out /tmp/qa-report.html --log-dir /custom/logs
#
# Output:
#   A single self-contained HTML file at the path given by --out.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_LOG_DIR="$(cd "$SCRIPT_DIR/../logs" && pwd)"
# The PRD comes from the run, never from a project-named default: a built-in path reports
# on whichever project it names rather than the one that just ran.
PRD_FILE="${PRD_FILE:-${MAIN_PRD_FILE:-}}"
if [ -z "$PRD_FILE" ]; then
  echo "[$(basename "$0")] no PRD: set PRD_FILE or MAIN_PRD_FILE — the engine names no project." >&2
  exit 2
fi

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${YELLOW}[qa-report]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[qa-report] ✓${NC} $*" >&2; }
fail()  { echo -e "${RED}[qa-report] ✗${NC} $*" >&2; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
LOG_FILE=""
OUT_FILE=""
LOG_DIR="$DEFAULT_LOG_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)     LOG_FILE="$2"; shift 2 ;;
    --out)     OUT_FILE="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -20 | sed 's/^# \?//'
      exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$LOG_FILE" ]] || fail "Required: --log <path>"
[[ -n "$OUT_FILE" ]] || fail "Required: --out <path>"
[[ -f "$LOG_FILE" ]] || fail "Log file not found: $LOG_FILE"

info "Generating QA report from $LOG_FILE"
info "Log dir: $LOG_DIR"
info "Output:  $OUT_FILE"

# ── Generate HTML via Python ──────────────────────────────────────────────────

python3 "$SCRIPT_DIR/lib/handlers/qa-report-build.py" "$LOG_FILE" "$OUT_FILE" "$LOG_DIR" "$PRD_FILE"

ok "QA report written to: $OUT_FILE"
info "File size: $(wc -c < "$OUT_FILE") bytes"
