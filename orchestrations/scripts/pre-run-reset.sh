#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pre-run-reset.sh — Generic dashboard + log reset before any orchestration run.
#
# Accepts any PRD file (inside or outside this project). Idempotent.
#
# What it does:
#   1. Generates docker-compose.observability.override.yml mounting the PRD
#      at /prd/active.json inside the agent-monitor container, then restarts
#      agent-monitor so nginx serves the live PRD directly — no copy/sync needed.
#   2. Reads configuration.budget from PRD and patches BUDGET_TOTAL in monitor.html
#   3. Archives non-essential JSONL logs and clears them for the new run
#   4. Resets agent-status.json to an empty state
#
# Preserved (never cleared):
#   calibration.json     — CPA baselines; accumulate over time
#   cpa-review.jsonl     — calibration inputs; accumulate over time
#   checkpoint-*.jsonl   — historical audit trail
#
# Usage:
#   bash orchestrations/scripts/pre-run-reset.sh --prd /path/to/any-prd.json
#   bash orchestrations/scripts/pre-run-reset.sh --prd orchestrations/travel-app-prd.json
#   bash orchestrations/scripts/pre-run-reset.sh --prd /outside/project/my-app-prd.json
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIVE_DIR="$REPO_ROOT/orchestrations/dashboards/live"
LOG_DIR="$REPO_ROOT/orchestrations/logs"
MONITOR_HTML="$LIVE_DIR/monitor.html"
COMPOSE_BASE="$REPO_ROOT/docker-compose.observability.yml"
COMPOSE_OVERRIDE="$REPO_ROOT/docker-compose.observability.override.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[pre-run-reset]${NC} $*"; }
success() { echo -e "${GREEN}[pre-run-reset] ✓${NC} $*"; }
fail()    { echo -e "${RED}[pre-run-reset] ✗${NC} $*" >&2; exit 1; }

# ── Parse args ────────────────────────────────────────────────────────────────
PRD_FILE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_FILE="$2"; shift 2 ;;
    *)     fail "Unknown argument: $1. Usage: --prd <path>" ;;
  esac
done

[ -z "$PRD_FILE" ] && fail "--prd <path> is required"

# Resolve to absolute path (supports paths outside project)
PRD_FILE="$(cd "$(dirname "$PRD_FILE")" && pwd)/$(basename "$PRD_FILE")"
[ -f "$PRD_FILE" ] && success "PRD: $PRD_FILE" || fail "PRD not found: $PRD_FILE"

# ── Step 1: Wire agent-monitor to serve the live PRD ─────────────────────────
# Generate a compose override that mounts the PRD (from anywhere on the host)
# at /prd/active.json inside the nginx container. nginx.conf routes GET /prd.json
# to that fixed path. The file is read directly from disk on every request —
# no copy or sync required. Works for any PRD location.
info "Configuring agent-monitor to serve: $(basename "$PRD_FILE")..."

# Ensure the PRD file is world-readable so nginx (non-root) can serve it
chmod o+r "$PRD_FILE"

cat > "$COMPOSE_OVERRIDE" << OVERRIDE
services:
  agent-monitor:
    volumes:
      - ${PRD_FILE}:/prd/active.json:ro
OVERRIDE

# Restart agent-monitor with the updated override so the new PRD mount applies
if docker compose \
     -f "$COMPOSE_BASE" \
     -f "$COMPOSE_OVERRIDE" \
     up -d agent-monitor 2>/dev/null; then
  success "agent-monitor restarted → /prd/active.json = $PRD_FILE"
else
  info "  Docker not available or agent-monitor not running — skipping container restart"
fi

# ── Step 2: Patch BUDGET_TOTAL in monitor.html ────────────────────────────────
info "Patching BUDGET_TOTAL in monitor.html..."

BUDGET=$(python3 -c "
import json
d = json.load(open('$PRD_FILE'))
b = d.get('configuration', {}).get('budget', 0)
print(f'{float(b):.2f}')
")

if [ -z "$BUDGET" ] || [ "$BUDGET" = "0.00" ]; then
  info "  No budget set in PRD configuration — skipping BUDGET_TOTAL patch"
else
  sed -i "s/const BUDGET_TOTAL[[:space:]]*=[[:space:]]*[0-9][0-9.]*;/const BUDGET_TOTAL  = ${BUDGET};/" "$MONITOR_HTML"
  PATCHED=$(grep "BUDGET_TOTAL" "$MONITOR_HTML" | head -1 | xargs)
  success "monitor.html → $PATCHED"
fi

# ── Step 3: Archive + clear JSONL logs ────────────────────────────────────────
info "Archiving and clearing run logs..."

ARCHIVE_DIR="$LOG_DIR/archive/pre-run-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$ARCHIVE_DIR"

CLEARABLE_LOGS=(
  agent-activity.jsonl
  agent-messages.jsonl
  story-artifacts.jsonl
  phase-gates.jsonl
  spec-phase.jsonl
  testing-gates.jsonl
  phase-skill-assessments.jsonl
  code-reviews.jsonl
  profiles-audit.jsonl
  phase-cost.jsonl
)

ARCHIVED=0
for f in "${CLEARABLE_LOGS[@]}"; do
  fp="$LOG_DIR/$f"
  if [ -f "$fp" ] && [ -s "$fp" ]; then
    cp "$fp" "$ARCHIVE_DIR/$f"
    > "$fp"
    ARCHIVED=$((ARCHIVED+1))
  fi
done

# Clear stale lock files
for lf in "$LOG_DIR"/*.lock; do
  [ -f "$lf" ] && > "$lf"
done

[ "$ARCHIVED" -gt 0 ] \
  && success "Archived $ARCHIVED log files → $ARCHIVE_DIR" \
  || info "  No non-empty logs to archive (already clean)"

# ── Step 4: Reset agent-status.json ──────────────────────────────────────────
info "Resetting agent-status.json..."
echo '{"startedAt":null,"phase":null,"orchMode":null,"lanes":{},"events":[],"stories":{},"completedAt":null}' \
  > "$LOG_DIR/agent-status.json"
success "agent-status.json reset"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
success "Pre-run reset complete."
echo "  PRD:         $PRD_FILE"
echo "  Budget:      \$$BUDGET"
echo "  Dashboard:   http://localhost:8092/monitor.html"
echo "  PRD Viewer:  http://localhost:8092/prd-viewer.html"
echo "  Langfuse:    http://localhost:3100"
echo ""

