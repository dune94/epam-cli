#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pre-run-reset.sh — Generic dashboard + log reset before any orchestration run.
#
# Accepts any PRD file (inside or outside this project). Idempotent.
#
# What it does:
#   1. Generates docker-compose.observability.override.yml mounting the PRD's
#      PARENT DIRECTORY at /prd-dir, and the run's LOG_DIR at /logs-dir, inside
#      the agent-monitor container (directory mounts, not file mounts — see
#      the rationale further down), patches nginx.conf's /prd.json alias to
#      the right basename, then restarts agent-monitor so nginx serves live
#      data directly — no copy/sync needed.
#   2. Archives non-essential JSONL logs and clears them for the new run
#   3. Resets agent-status.json to an empty state
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
#   bash orchestrations/scripts/pre-run-reset.sh --prd <prd> --log-dir /outside/project
#
# --log-dir defaults to orchestrations/logs (in-repo runs). External-project
# runs (e.g. tier3-*-run.sh, where run-agent-orchestration.sh's own LOG_DIR
# resolves to $OUTPUT_DIR, NOT orchestrations/logs) must pass --log-dir
# "$OUTPUT_DIR" or the dashboard has nothing real to read: step-status.json,
# agent-status.json, agent-activity.jsonl, and phase-cost.jsonl are all
# written to LOG_DIR by the pipeline, which for an external-project run is
# the target project's own directory (found live 2026-07-13 — the dashboard
# had been silently reading an unrelated, empty orchestrations/logs the whole
# time for any such run).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_BASE="$REPO_ROOT/docker-compose.observability.yml"
COMPOSE_OVERRIDE="$REPO_ROOT/docker-compose.observability.override.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[pre-run-reset]${NC} $*"; }
success() { echo -e "${GREEN}[pre-run-reset] ✓${NC} $*"; }
fail()    { echo -e "${RED}[pre-run-reset] ✗${NC} $*" >&2; exit 1; }

# ── Parse args ────────────────────────────────────────────────────────────────
PRD_FILE=""
LOG_DIR_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd)     PRD_FILE="$2"; shift 2 ;;
    --log-dir) LOG_DIR_ARG="$2"; shift 2 ;;
    *)         fail "Unknown argument: $1. Usage: --prd <path> [--log-dir <path>]" ;;
  esac
done

[ -z "$PRD_FILE" ] && fail "--prd <path> is required"

# Resolve to absolute path (supports paths outside project)
PRD_FILE="$(cd "$(dirname "$PRD_FILE")" && pwd)/$(basename "$PRD_FILE")"
[ -f "$PRD_FILE" ] && success "PRD: $PRD_FILE" || fail "PRD not found: $PRD_FILE"

if [ -n "$LOG_DIR_ARG" ]; then
  mkdir -p "$LOG_DIR_ARG"
  LOG_DIR="$(cd "$LOG_DIR_ARG" && pwd)"
else
  LOG_DIR="$REPO_ROOT/orchestrations/logs"
fi
success "Log dir: $LOG_DIR"

# ── Step 1: Wire agent-monitor to serve the live PRD ─────────────────────────
# Generate a compose override that mounts the PRD's PARENT DIRECTORY (not the
# file itself) at /prd-dir inside the nginx container, and patch nginx.conf's
# alias to the correct basename. nginx.conf routes GET /prd.json to that path.
#
# Directory mount, not file mount — deliberately. A single-FILE bind mount is
# fixed to the inode present at mount time; since the orchestration pipeline
# always writes the PRD via atomic tmp+rename (jq ... > tmp && mv tmp file /
# fs.renameSync — correct, corruption-safe, used throughout this codebase),
# every write creates a NEW inode at that path, silently orphaning a file
# mount the moment the PRD is rewritten after this script runs (found live
# 2026-07-13: the dashboard had been serving a frozen, stale PRD snapshot
# indefinitely). A directory mount doesn't have this problem — renames INSIDE
# the mounted directory are visible immediately, no container restart needed
# for subsequent PRD writes during the run.
info "Configuring agent-monitor to serve: $(basename "$PRD_FILE")..."

PRD_DIR="$(dirname "$PRD_FILE")"
PRD_BASENAME="$(basename "$PRD_FILE")"

# Ensure the PRD file is world-readable so nginx (non-root) can serve it
chmod o+r "$PRD_FILE"

# build/snapshot.js (the Eleventy watcher — a separate Node process, no access
# to the Docker mounts above) needs its own way to know which PRD is active.
# It reads this pointer file directly; falls back to the old dead
# orchestrations/prd.json symlink when absent so an unrun/older setup doesn't
# break. Truncate-write (>), not atomic rename — this file itself must never
# be subject to the inode-staleness bug it exists to work around.
echo -n "$PRD_FILE" > "$REPO_ROOT/orchestrations/dashboards/.active-prd-path"

# /logs-dir gets the same directory-mount treatment as /prd-dir above, and for
# the identical reason: step-status.json/agent-status.json/agent-activity.jsonl/
# phase-cost.jsonl are all rewritten via atomic tmp+rename or repeated append
# during a run, and for external-project runs LOG_DIR is a directory the
# dashboard has otherwise never been told about at all.
cat > "$COMPOSE_OVERRIDE" << OVERRIDE
services:
  agent-monitor:
    volumes:
      - ${PRD_DIR}:/prd-dir:ro
      - ${LOG_DIR}:/logs-dir:ro
OVERRIDE

# nginx.conf's /prd.json alias basename must match whatever PRD was passed —
# patch it in place (truncate-write via sed -i, not atomic rename, so this
# single-file mount for nginx.conf itself is not subject to the same bug).
sed -i "s|alias /prd-dir/[^;]*;|alias /prd-dir/${PRD_BASENAME};|" \
  "$REPO_ROOT/orchestrations/dashboards/nginx.conf"

# --force-recreate, not just `up -d`: nginx.conf itself is STILL a single-
# FILE bind mount (the sed -i just above rewrites it via a new inode, same as
# every other atomic-write case this session). Plain `up -d` only recreates a
# container when the COMPOSE CONFIG changed — it does not notice an existing
# bind-mounted file's inode changing underneath it, so without
# --force-recreate the container keeps serving the nginx.conf it started
# with, silently ignoring this run's PRD-basename patch (found live
# 2026-07-13 verifying this exact fix — even the fix's own docs file wasn't
# safe from the bug it documents).
if docker compose \
     -f "$COMPOSE_BASE" \
     -f "$COMPOSE_OVERRIDE" \
     up -d --force-recreate agent-monitor 2>/dev/null; then
  success "agent-monitor restarted → /prd-dir = $PRD_DIR (serving $PRD_BASENAME), /logs-dir = $LOG_DIR"
else
  info "  Docker not available or agent-monitor not running — skipping container restart"
fi

# Step 2 (removed 2026-07-13): used to sed-patch a BUDGET_TOTAL constant into
# monitor.html from prd.configuration.budget. Removed along with the
# "Budget Remaining" stat card it fed — comparing spend against an arbitrary
# budget number was less useful than comparing it against the CPA estimate
# already computed per-story, which monitor.html now does directly from
# live prd.json on every refresh (no sed-patching, no stale-const bug class).

# ── Step 2: Archive + clear JSONL logs ────────────────────────────────────────
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

# ── Step 3: Reset agent-status.json ──────────────────────────────────────────
info "Resetting agent-status.json..."
echo '{"startedAt":null,"phase":null,"orchMode":null,"lanes":{},"events":[],"stories":{},"completedAt":null}' \
  > "$LOG_DIR/agent-status.json"
success "agent-status.json reset"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
success "Pre-run reset complete."
echo "  PRD:         $PRD_FILE"
echo "  Log dir:     $LOG_DIR"
echo "  Dashboard:   http://localhost:8092/monitor.html"
echo "  PRD Viewer:  http://localhost:8092/prd-viewer.html"
echo "  Langfuse:    http://localhost:3100"
echo ""

