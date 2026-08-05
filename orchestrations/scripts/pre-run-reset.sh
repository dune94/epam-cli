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
# B29: overridable so a TEST can point this at a throwaway path. Hardcoding it
# meant any test invoking this script rewrote the repo's own git-tracked override
# to mount its mkdtemp dirs; once those were removed at teardown the live
# dashboard mounted two vanished paths and served 403/404 for /prd.json and
# /logs/* until someone noticed. Real runs pass nothing and get the repo file.
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-$REPO_ROOT/docker-compose.observability.override.yml}"
# B29 (second vector): the dashboard pointer files are git-TRACKED too, and a
# test running this script rewrote them to its mkdtemp paths exactly like the
# compose override did. Same indirection, same reason.
DASHBOARD_STATE_DIR="${DASHBOARD_STATE_DIR:-$REPO_ROOT/orchestrations/dashboards}"

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
# Tolerate a not-yet-created PRD *and* a not-yet-created parent directory: the
# per-project PRD is written later by the Jira ingest.
_prd_dir="$(dirname "$PRD_FILE")"
if [ -d "$_prd_dir" ]; then
  PRD_FILE="$(cd "$_prd_dir" && pwd)/$(basename "$PRD_FILE")"
fi
# A MISSING PRD MUST NOT ABORT THE RESET. This used to `fail`, which killed the
# script before archiving logs, clearing the KB scratchpad or resetting cost.
# That became reachable when PRD paths went per-project (2026-07-25): the
# metrolinx PRD is CREATED BY THE JIRA INGEST, which runs AFTER this script — and
# the tier3 caller swallows a failure here as "non-fatal", so the run would have
# proceeded with none of the standing pre-run resets done.
PRD_PRESENT=1
if [ -f "$PRD_FILE" ]; then
  success "PRD: $PRD_FILE"
else
  PRD_PRESENT=0
  info "PRD not found (not yet created?): $PRD_FILE"
  info "  skipping dashboard mount; ALL resets below still run."
fi

if [ -n "$LOG_DIR_ARG" ]; then
  mkdir -p "$LOG_DIR_ARG"
  LOG_DIR="$(cd "$LOG_DIR_ARG" && pwd)"
else
  LOG_DIR="$REPO_ROOT/orchestrations/logs"
fi
success "Log dir: $LOG_DIR"
export EPAM_PROJECT_OUTPUT_DIR="$LOG_DIR"

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
if [ "$PRD_PRESENT" = "0" ]; then
  info "Dashboard mount skipped — no PRD at $PRD_FILE yet."
else
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
echo -n "$PRD_FILE" > "$DASHBOARD_STATE_DIR/.active-prd-path"

# Same pointer-file pattern for the project output directory: snapshot.js
# (the Eleventy watcher) reads EPAM_PROJECT_OUTPUT_DIR from its process env,
# but since pre-run-reset.sh is invoked as a subprocess (not sourced), the
# export above does not propagate to the parent shell or to the Eleventy
# watcher started later by run-agent-orchestration.sh. Writing the path here
# lets snapshot.js read it without requiring the env var in the process chain.
echo -n "$LOG_DIR" > "$DASHBOARD_STATE_DIR/.active-output-dir"

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
fi   # end: dashboard mount, skipped when the PRD does not exist yet

# Step 2 (removed 2026-07-13): used to sed-patch a BUDGET_TOTAL constant into
# monitor.html from prd.configuration.budget. Removed along with the
# "Budget Remaining" stat card it fed — comparing spend against an arbitrary
# budget number was less useful than comparing it against the CPA estimate
# already computed per-story, which monitor.html now does directly from
# live prd.json on every refresh (no sed-patching, no stale-const bug class).

# ── Step 2: Archive + clear JSONL logs ────────────────────────────────────────
info "Archiving and clearing run logs..."

ARCHIVE_DIR="$LOG_DIR/archive/pre-run-${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
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
  healing-events.jsonl
  failure-diagnosis-groundedness.jsonl
  story-failures.jsonl
  guarded-step-retries.jsonl
  blocked-stories.jsonl
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

# B13 — MOVE per-run *.log files out of the way.
#
# The list above covers .jsonl only. The .log files keep FIXED names
# (review-agent-<story>.log, repro-test-writer-<story>.log,
# regression-guard-<phase>.log) and are rewritten only if the step that owns them
# actually runs — so after a run where a step did NOT run, the file still holds
# output from hours earlier and reads as current. That cost five wrong diagnoses on
# 2026-07-24, including a 16:33 mock-era review log attributed to a 20:52 metrolinx
# run, which produced an entire "reviewer thrashed" theory about a different run.
#
# story-outputs-<phase>.txt (the writer-output manifest) is archived by the same
# sweep, and is the sharpest case of this rule: lib/story-outputs.sh and
# lib/eslint-baseline-gate.sh read an ABSENT manifest as "fall back and say so"
# but a PRESENT one as authoritative. A leftover manifest is therefore not just
# misleading to a human — it is a lie the lint gate, review-ranger and
# mutant-hunter all act on, attributing a previous run's files to this one.
#
# eslint-baseline-<sha>.json (the lint gate's baseline-findings cache) goes the
# same way. It is keyed by SHA and would otherwise be reused across runs — and a
# run that FAILED to compute it leaves a zero-byte file that looks exactly like a
# valid cached result. That is what silently disabled the lint gate's
# inherited-debt subtraction on 2026-07-26.
#
# MOVED, not truncated: a MISSING file is honest ("this run did not write it"),
# whereas a stale file is a lie that looks exactly like data. .jsonl stays
# truncate-in-place above because dashboards read those paths live and expect them
# to exist.
_ARCHIVED_LOGS=0
# RECURSIVE, and the relative path is preserved in the archive.
#
# This swept with `-maxdepth 1`, so it only ever reached $LOG_DIR's top level. Every
# per-lane writer-output manifest lives at $LOG_DIR/lanes/<lane>/story-outputs-<phase>.txt
# — depth 3 — and was therefore NEVER wiped: it survived every run and unioned with the
# next one indefinitely. Live metrolinx 20260804T225443Z: upexpress's manifest still listed
# orchestrations/agents/KB.md, with no way to tell which run had put it there.
#
# The path must be preserved rather than flattened: all three lanes produce a file named
# story-outputs-core.txt, and moving them into one flat directory would have two of them
# silently overwrite the third.
while IFS= read -r _lf; do
    [ -f "$_lf" ] || continue
    _rel="${_lf#"$LOG_DIR"/}"
    _dest="$ARCHIVE_DIR/$_rel"
    mkdir -p "$(dirname "$_dest")" 2>/dev/null || true
    mv "$_lf" "$_dest" 2>/dev/null && _ARCHIVED_LOGS=$((_ARCHIVED_LOGS+1)) || true
done < <(find "$LOG_DIR" -type f \( -name '*.log' -o -name 'story-outputs-*.txt' -o -name 'eslint-baseline-*.json' \) -not -path "$ARCHIVE_DIR/*" -not -path "$LOG_DIR/archive/*" 2>/dev/null || true)
[ "$_ARCHIVED_LOGS" -gt 0 ] \
  && success "Moved $_ARCHIVED_LOGS stale *.log / manifest / baseline-cache file(s) → $ARCHIVE_DIR (absence now means 'this run did not write it')" \
  || info "  No stale .log files to move"

# Clear stale lock files
for lf in "$LOG_DIR"/*.lock; do
  [ -f "$lf" ] && > "$lf"
done

[ "$ARCHIVED" -gt 0 ] \
  && success "Archived $ARCHIVED log files → $ARCHIVE_DIR" \
  || info "  No non-empty logs to archive (already clean)"

# ── Step 3: Clear KB scratchpad (per-run attempt files — stale notes from failed
# runs contaminate future attempts with wrong diagnoses; reset before every run)
KB_DIR="$LOG_DIR/kb-scratchpad"
if [ -d "$KB_DIR" ]; then
  KB_COUNT=$(find "$KB_DIR" -name "*.md" | wc -l)
  if [ "$KB_COUNT" -gt 0 ]; then
    find "$KB_DIR" -name "*.md" -delete
    success "Cleared $KB_COUNT KB scratchpad file(s) from $KB_DIR"
  else
    info "  KB scratchpad already empty"
  fi
fi

# ── Step 4: Reset agent-status.json ──────────────────────────────────────────
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

