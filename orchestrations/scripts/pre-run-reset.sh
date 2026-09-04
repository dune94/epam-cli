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

# The reset deletes a run's working state. Untested code doing that is how finished work disappears.
_scg_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/stage-coverage-gate.sh"
# shellcheck source=/dev/null
[ -f "$_scg_lib" ] && . "$_scg_lib" && require_stage_coverage reset || exit 1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Service endpoints come from orchestrations/config/services.json — one place to change
# a port, instead of the 20+ copies these URLs used to have across the pipeline.
. "$(dirname "${BASH_SOURCE[0]}")/lib/service-urls.sh"

# THE SAME PROJECT NAME install.sh ACTUALLY USED, never compose's own default resolution.
# install.sh (lib/isolated-compose-identity.sh) brings a TEST install's observability stack up as
# "test-install-amsd-pipeline-obs-<hash>" — a project name this script's own restart command never
# knew about until now, so it resolved to whatever compose falls back to with no -p (the compose
# file's declared `name:`, or the directory basename) and silently restarted the WRONG project's
# agent-monitor — for any install other than the hand-run dev checkout, always. Found live
# 2026-09-04: every real run against a fresh install hard-failed pre-flight on
# "nginx /logs/healing-events.jsonl not reachable", because the container that actually got
# recreated was never the one the run's own dashboard/log mounts point at.
_identity_lib="$REPO_ROOT/orchestrations-installer/lib/isolated-compose-identity.sh"
# shellcheck source=/dev/null
[ -f "$_identity_lib" ] && . "$_identity_lib" || { echo "[pre-run-reset] missing $_identity_lib — cannot resolve the observability project name" >&2; exit 1; }
OBS_PROJECT="$(isolated_project_name "$REPO_ROOT" obs)"

# THE SAME SUBNET AND PORTS install.sh ACTUALLY GOT, never docker-compose.observability.yml's own
# bare defaults (${EPAM_OBS_SUBNET:-172.31.0.0/16} etc). Even restarting the RIGHT project (above)
# still failed: `down` (no -v, run by nothing here, but true of any earlier stop/start too) removes
# the network, and a later `up`/`--force-recreate` with no EPAM_OBS_SUBNET at all resolves to the
# compose file's default — which, for an isolated install, is NOT the subnet the network was
# actually created with. Confirmed live 2026-09-04 against pipeline-tests-7: `docker network
# inspect test-install-amsd-pipeline-obs-925946_default` reported subnet 172.25.0.0/16; this
# script's own restart command (no EPAM_OBS_SUBNET set) resolved to 172.31.0.0/16 — a mismatch
# that makes --force-recreate fail with "container ... is not connected to the network
# test-install-amsd-pipeline-obs-925946_default", exit 1, every time, for every install other than
# the hand-run dev checkout.
#
# install.sh already persists exactly these 5 values to .pipeline-services-state.env on every
# successful bring-up, for precisely this reason ("so a LATER command against the same install can
# reuse the same identity instead of re-rolling a different one" — install.sh's own comment).
# pipeline-services.sh --start already reads it back the same way. This is the identical bug class
# the OBS_PROJECT fix above already covered, just for subnet/ports instead of project name.
#
# WHY DEV NEVER SAW THIS: dev's own checkout has no .pipeline-services-state.env (never brought up
# through install.sh's isolated path), so BOTH its original hand-run `up -d` and this restart
# consistently fall back to the SAME bare default — no mismatch, no failure.
#
# Overridable (B29: same no-repo-pollution rule as COMPOSE_OVERRIDE) so a test can point this at a
# throwaway file instead of the repo's own real state file.
_STATE_FILE="${PIPELINE_SERVICES_STATE_FILE:-$REPO_ROOT/.pipeline-services-state.env}"
if [ -f "$_STATE_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$_STATE_FILE"
  set +a
fi

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

# Contamination gets its OWN exit code (9) so no launcher can swallow it as a Docker
# problem. See lib/contamination-exit.sh.
# shellcheck source=lib/contamination-exit.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/contamination-exit.sh"

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
# THE LOGS MOUNT DOES NOT DEPEND ON THE PRD. This whole block used to be skipped when the PRD did
# not exist yet, taking /logs-dir down with it — but LOG_DIR is this run's own log directory and is
# knowable with or without a PRD. The consequence was a chain: a fresh install has no prd.json (it
# is REGENERATED by ingest, and no longer committed — see .gitignore), so the dashboard mount was
# skipped, so nginx had no /logs-dir, so pre-flight's own reachability check failed
# ("nginx /logs/healing-events.jsonl not reachable") and refused the launch — on an install where
# nothing was actually wrong.
#
# /prd-dir is the only part that genuinely needs the file, so that is the only part now conditional.
if [ "$PRD_PRESENT" = "0" ]; then
  info "Configuring agent-monitor to serve this run's logs (no PRD yet — ingest writes it)..."
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
fi   # end: the PRD-only half (pointer files, chmod, nginx alias below)

# /logs-dir gets the same directory-mount treatment as /prd-dir, and for the
# identical reason: step-status.json/agent-status.json/agent-activity.jsonl/
# phase-cost.jsonl are all rewritten via atomic tmp+rename or repeated append
# during a run, and for external-project runs LOG_DIR is a directory the
# dashboard has otherwise never been told about at all.
#
# WRITTEN WHETHER OR NOT A PRD EXISTS YET — the /prd-dir line is the only part that needs one.
{
  echo "services:"
  echo "  agent-monitor:"
  echo "    volumes:"
  [ "$PRD_PRESENT" = "1" ] && echo "      - ${PRD_DIR}:/prd-dir:ro"
  echo "      - ${LOG_DIR}:/logs-dir:ro"
} > "$COMPOSE_OVERRIDE"

# nginx.conf's /prd.json alias basename must match whatever PRD was passed —
# patch it in place (truncate-write via sed -i, not atomic rename, so this
# single-file mount for nginx.conf itself is not subject to the same bug).
# Only meaningful when there IS a PRD; with none, the alias keeps whatever it had and /prd.json
# simply 404s until ingest writes one and the next reset re-points it.
if [ "$PRD_PRESENT" = "1" ]; then
  sed -i "s|alias /prd-dir/[^;]*;|alias /prd-dir/${PRD_BASENAME};|" \
    "$REPO_ROOT/orchestrations/dashboards/nginx.conf"
fi

# --force-recreate, not just `up -d`: nginx.conf itself is STILL a single-
# FILE bind mount (the sed -i just above rewrites it via a new inode, same as
# every other atomic-write case this session). Plain `up -d` only recreates a
# container when the COMPOSE CONFIG changed — it does not notice an existing
# bind-mounted file's inode changing underneath it, so without
# --force-recreate the container keeps serving the nginx.conf it started
# with, silently ignoring this run's PRD-basename patch (found live
# 2026-07-13 verifying this exact fix — even the fix's own docs file wasn't
# safe from the bug it documents).
# THE DASHBOARD RESTART IS THE ONLY SLOW STEP, AND A TEST DOES NOT NEED IT.
#
# `docker compose up --force-recreate` costs ~3 seconds. Everything else this script does — the
# roster restore, the PRD restore, clearing generated artefacts and prompts — is file work that
# takes milliseconds. A test that exercises the RESET therefore paid three seconds per case for a
# container it never looks at: two test files spent 23 of the 24 seconds my tests take, purely
# here, and that is the difference between a suite that gets run and one that does not.
#
# Skipped only when asked. A run never sets this, so the live path is unchanged.
if [ "${EPAM_SKIP_CONTAINER_RESTART:-0}" = "1" ]; then
  info "  Container restart skipped (EPAM_SKIP_CONTAINER_RESTART=1)"
elif EPAM_OBS_SUBNET="${OBS_SUBNET:-}" \
     EPAM_OBS_CLICKHOUSE_PORT="${OBS_CLICKHOUSE_PORT:-}" \
     EPAM_OBS_LANGFUSE_PORT="${OBS_LANGFUSE_PORT:-}" \
     EPAM_OBS_DASHBOARD_PORT="${OBS_DASHBOARD_PORT:-}" \
     EPAM_OBS_GRAFANA_PORT="${OBS_GRAFANA_PORT:-}" \
     docker compose \
     -f "$COMPOSE_BASE" \
     -f "$COMPOSE_OVERRIDE" \
     -p "$OBS_PROJECT" \
     up -d --force-recreate agent-monitor 2>/dev/null; then
  if [ "$PRD_PRESENT" = "1" ]; then
    success "agent-monitor restarted → /prd-dir = $PRD_DIR (serving $PRD_BASENAME), /logs-dir = $LOG_DIR"
  else
    success "agent-monitor restarted → /logs-dir = $LOG_DIR (no /prd-dir yet — ingest writes the PRD)"
  fi
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
    : > "$fp"
    ARCHIVED=$((ARCHIVED+1))
  else
    # THIS LOOP USED TO ONLY TRUNCATE — a file that had never been created (a genuinely fresh
    # project, or one that has simply never had a self-heal event) stayed ABSENT, not empty. That
    # distinction was invisible to a human ("healing-events.jsonl is empty/absent — clean slate"
    # treats them the same) but not to nginx: agent-monitor serves LOG_DIR at /logs-dir, and a
    # request for a path that was never written gets a 404, not an empty 200 — which
    # preflight-check.sh's own next check (`curl -sf .../logs/healing-events.jsonl`) treats as a
    # hard failure and refuses to launch. Confirmed live 2026-09-04, pipeline-tests-9's first-ever
    # clean run to reach this exact point: every earlier run had failed at an EARLIER gate, which
    # is exactly why a truly-fresh-install file had never been requested through nginx before.
    : > "$fp"
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

# ── The inference ladder's rung counters ────────────────────────────────────
# story-retry-state/<story>.count records how far up the model ladder a story
# has climbed. It MUST survive across claude.sh subprocesses within one run —
# that is the whole reason it is on disk, and "retries must proceed up the
# rungs, nothing is allowed to intercede" is a standing requirement.
#
# It must NOT survive a run. lib/story-retry-state.sh assumed this reset wiped
# it "for free"; the archive sweep above matches *.log / story-outputs-*.txt /
# eslint-baseline-*.json and never touched it, so the assumption was false from
# the day it was written. AMSD-2041.count sat at 6 across every run of
# 2026-08-06/07, and a resumed writer attempt began already at rung 3 of 4: the
# reviewer requested changes ONCE, the ladder was declared exhausted, and the
# phase halted without a single re-implementation cycle.
#
# The failure mode is not limited to a resume. A story that exhausts its ladder
# is escalated after one rejection on EVERY future run, forever, until someone
# deletes the file by hand.
# CLEAR THE DIRECTORY, NOT A LIST OF EXTENSIONS.
#
# The 2026-08-07 repair above deleted '*.count' and said "every story starts this run at
# rung 0". That was true of the counter and false of the run: lib/story-retry-state.sh also
# persists <story>.model (the escalated MODEL) and <story>.iterbump, and neither matched the
# glob. Live 2026-08-11, AMSD-2041.model held 'moonshotai/kimi-k3' from a FAILED 15:57 run;
# a fresh 23:34 launch reset the counter to 0, announced rung 0, and then invoked the writer
# with "resuming on 'moonshotai/kimi-k3' (escalated in an earlier invocation)" — the TOP rung,
# with no escalation headroom left for the recovery mechanisms that exist to climb it. Worse,
# the escalation encoded a verdict about MODEL CAPABILITY that was really a verdict about a
# truncated prompt, a defect fixed hours earlier. The stale conclusion outlived its cause.
#
# An extension whitelist has now failed twice for the same reason: a new state file type gets
# added and nobody updates the sweep. This directory exists ONLY for per-story retry state and
# none of it may survive a run, so clear ALL of it — a file type added tomorrow is covered
# without anyone remembering this code exists.
# ── Run-scoped feedback artefacts ───────────────────────────────────────────
# NOTHING FROM A PREVIOUS RUN MAY REACH THIS ONE.
#
# review-feedback-<story>.json is written when a review REQUESTS CHANGES and deleted only when
# a LATER review APPROVES — cleanup that depends on a success which may never come. Live:
# review-feedback-AMSD-2041.json was written 2026-08-09 08:26 and was still being handed to the
# writer on 2026-08-12, under the heading "The team-lead reviewer examined YOUR PREVIOUS ATTEMPT
# ... This is the highest priority." It was a different run, against code that no longer
# existed. Its blockers demanded work on files that HAD since been modified, and a dependency
# that does not exist. The writer obeyed all of it, and was blamed for over-reaching.
#
# Operator, 2026-08-12: "I never granted permission to persist ANY such file across runs" and
# "if it is frail - DELETE it after each run - simple."
#
# BY PATTERN, NOT BY NAME. This reset has now been caught twice enumerating specific names —
# '*.count' while .model and .iterbump survived, and the PRD/roster while review feedback
# survived. A feedback artefact added tomorrow is covered without anyone remembering this code.
# IS THIS A CONTINUATION? ASKED ONCE, HERE, BEFORE ANYTHING ACTS ON THE ANSWER.
#
# The run-state clearing below deletes estate-survey.json, referenced-docs.json and
# ticket-documents.json. Whether this is a resume used to be worked out ~190 lines LATER, so that
# clearing could not see it: every resume deleted the artefacts the run had already produced.
# estate-survey.json is read back by surveyHypothesisBlock and injected into code-graph-detective,
# so the survey was paid for, shown to a human at the pause, and thrown away by the act of
# resuming — after which the detective rediscovered an estate that had already been surveyed.
#
# This is deliberately NOT _IS_RESUME, which is a broader question answered further down and is
# also true for EPAM_SKIP_AGENT_MINT=1. A skip-mint run is a FRESH run: it keeps the ROSTER the
# mint last produced, because nothing is going to rebuild it, but its LOG_DIR artefacts belong to
# a PREVIOUS run and must still be cleared — a stale survey matched by codeline name (api, web,
# src) is how one project's evidence reached another project's prompts.
_IS_RESUMED_RUN=0
if [ -n "${EPAM_RESUME_RUN:-}" ]; then
    _IS_RESUMED_RUN=1
fi

_RUN_ARTIFACT_DIR="${LOG_DIR:-}"
if [ -n "$_RUN_ARTIFACT_DIR" ] && [ -d "$_RUN_ARTIFACT_DIR" ]; then
    # EVERYWHERE A LANE CAN READ ONE, not just the parent directory.
    #
    # This swept `-maxdepth 1` while a lane runs with LOG_DIR=$LOG_DIR/lanes/<codeline> and the
    # writer reads $LOG_DIR/review-feedback-<story>.json — so every lane's findings survived every
    # reset. Found 2026-08-13: all three lanes still held files written on 2026-08-05, metrolinx's
    # carrying NINE issues and FOUR blockers about an implementation discarded a week earlier. A
    # run would have opened its writer's prompt with "a prior code review requested changes — this
    # is the highest priority" and demands about code that no longer existed.
    #
    # Second time the reset has been caught missing lane-scoped state; the published agent-input
    # store was the first, earlier the same day. Depth is the bug both times, so depth goes.
    _RA_CLEARED=$(find "$_RUN_ARTIFACT_DIR" -type f -name 'review-*.json' 2>/dev/null | wc -l)
    find "$_RUN_ARTIFACT_DIR" -type f -name 'review-*.json' -delete 2>/dev/null || true
    _RA_LEFT=$(find "$_RUN_ARTIFACT_DIR" -type f -name 'review-*.json' 2>/dev/null | wc -l)
    if [ "$_RA_LEFT" -gt 0 ]; then
        # Starting a run on another run's review findings is the whole defect. Never announce a
        # clean slate this script did not deliver.
        fail_contamination "$_RA_LEFT run-scoped review artefact(s) could NOT be cleared in $_RUN_ARTIFACT_DIR — a run started now would act on a previous run's findings"
    elif [ "$_RA_CLEARED" -gt 0 ]; then
        info "  Cleared $_RA_CLEARED run-scoped review artefact(s) — no prior run's findings reach this one"
    fi
fi

# FETCHED TICKET DOCUMENTS — one project's client documentation must never reach another's.
#
# mint-agents-step.js reads $LOG_DIR/referenced-docs.json (then ticket-documents.json) and hands
# whatever it finds to the estate survey, the mint and the roster review. LOG_DIR is SHARED across
# projects, and nothing cleared these files — so on 2026-08-26 a mock3 run opened its roster-review
# prompt with two Contentstack pages fetched for METROLINX on 2026-08-07, nineteen days earlier.
# Forty-one mentions of another client's CMS, paid for on every affected seam, in a project that
# has nothing to do with it.
#
# Third time the reset has been caught missing shared state after review artefacts and the
# published agent-input store. The rule that keeps being relearned: anything a later step READS
# out of LOG_DIR is run state, and run state is cleared here.
if [ "${_IS_RESUMED_RUN:-0}" = "1" ]; then
    info "  Resuming — keeping this run's own fetched documents and estate survey"
elif [ -n "${_RUN_ARTIFACT_DIR:-}" ] && [ -d "$_RUN_ARTIFACT_DIR" ]; then
    _TD_CLEARED=0
    # estate-survey.json joins them: surveyHypothesisBlock (spec-mode-runner.js) reads it back out
    # of LOG_DIR and injects the survey's EVIDENCE into a prompt, matched by codeline NAME. A stale
    # survey therefore feeds outdated evidence to the same project, and two projects sharing a
    # codeline name — api, web, src — feed each other's. Found 2026-08-26 by the seam test that
    # asserts the rule rather than the instance, immediately after the Contentstack document leak
    # was fixed. Fourth artefact of this class.
    for _td in referenced-docs.json ticket-documents.json estate-survey.json; do
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            rm -f "$_f" 2>/dev/null && _TD_CLEARED=$((_TD_CLEARED+1)) || true
        done <<< "$(find "$_RUN_ARTIFACT_DIR" -type f -name "$_td" 2>/dev/null)"
    done
    _TD_LEFT=$(find "$_RUN_ARTIFACT_DIR" -type f \( -name 'referenced-docs.json' -o -name 'ticket-documents.json' -o -name 'estate-survey.json' \) 2>/dev/null | wc -l)
    if [ "$_TD_LEFT" -gt 0 ]; then
        fail_contamination "$_TD_LEFT fetched-document cache(s) could NOT be cleared in $_RUN_ARTIFACT_DIR — a run started now would put another project's documents in its prompts"
    elif [ "$_TD_CLEARED" -gt 0 ]; then
        info "  Cleared $_TD_CLEARED cross-run artefact(s) — no other run's documents or survey evidence reach this run's prompts"
    fi
fi

# PUBLISHED AGENT INPUTS — the store agents read each other's outputs from.
#
# Same ruling as the review artefacts above, for the same reason and with a shorter fuse: the
# detective re-runs every pass, and yesterday's fix-plan is indistinguishable from today's to
# every consumer that collects it. A plan that outlives the investigation which produced it is a
# writer implementing a finding that has since been withdrawn.
#
# BY DIRECTORY, NOT BY KIND. Kinds are added as producers are migrated onto the framework; naming
# them here would mean the next one silently survives, which is how this reset has already been
# caught twice.
# BY DIRECTORY NAME, EVERYWHERE UNDER LOG_DIR — not just the one this process would use.
# Parallel lanes each publish into $LOG_DIR/lanes/<codeline>/agent-io, and clearing only the
# parent's store left three lane stores intact while REPORTING a clean slate. Found in the
# pre-launch review 2026-08-13, before it could reach a run.
_AGENT_IO_DIRS=()
if [ -n "${LOG_DIR:-}" ] && [ -d "$LOG_DIR" ]; then
    while IFS= read -r _d; do [ -n "$_d" ] && _AGENT_IO_DIRS+=("$_d"); done \
        < <(find "$LOG_DIR" -type d -name agent-io 2>/dev/null)
fi
# The configured store too, in case it was pointed outside LOG_DIR.
if [ -n "${AGENT_IO_DIR:-}" ] && [ -d "$AGENT_IO_DIR" ]; then
    _aio_known=" $(printf '%s ' "${_AGENT_IO_DIRS[@]+"${_AGENT_IO_DIRS[@]}"}")"
    case "$_aio_known" in *" $AGENT_IO_DIR "*) ;; *) _AGENT_IO_DIRS+=("$AGENT_IO_DIR") ;; esac
fi
if [ "${#_AGENT_IO_DIRS[@]}" -gt 0 ]; then
    _AIO_CLEARED=0
    _AIO_LEFT=0
    for _aio in "${_AGENT_IO_DIRS[@]}"; do
        _n=$(find "$_aio" -mindepth 1 -type f 2>/dev/null | wc -l)
        _AIO_CLEARED=$(( _AIO_CLEARED + _n ))
        rm -rf "$_aio" 2>/dev/null || true
        # COUNTING WHAT SURVIVED MUST NOT DEPEND ON THE DIRECTORY STILL EXISTING.
        #
        # This was `_AIO_LEFT=$(( _AIO_LEFT + $(find "$_aio" ... | wc -l) ))`. When the rm
        # above SUCCEEDS the path is gone, so `find` exits 1; `pipefail` (set at the top of
        # this file) propagates that through `| wc -l`; the arithmetic assignment inherits
        # it; and `set -e` kills the script — right here, at line ~386 of 555.
        #
        # So the reset aborted BECAUSE the clearing worked, and everything sequenced after
        # this point never ran: story-retry-state, the kb-scratchpad sweep, the roster
        # clear. lib/pre-run-reset-gate.sh saw a plain exit 1, could only tell
        # CONTAMINATION_EXIT from "environmental", and logged "(dashboard/environment, not
        # state) — non-fatal, continuing". It was entirely about state.
        #
        # Live cost, run 20260814T223413Z: the story inherited 12/12 attempts and "failed
        # after 12 attempts" in 18 seconds having made zero model calls.
        #
        # A directory that no longer exists has nothing left in it — say that directly
        # rather than asking a tool that treats the absence as an error.
        _remaining=0
        [ -d "$_aio" ] && _remaining=$(find "$_aio" -mindepth 1 -type f 2>/dev/null | wc -l)
        _AIO_LEFT=$(( _AIO_LEFT + _remaining ))
    done
    if [ "$_AIO_LEFT" -gt 0 ]; then
        fail_contamination "$_AIO_LEFT published agent input(s) could NOT be cleared under ${LOG_DIR:-?} — a run started now would hand agents a previous run's outputs"
    elif [ "$_AIO_CLEARED" -gt 0 ]; then
        info "  Cleared $_AIO_CLEARED published agent input(s) across ${#_AGENT_IO_DIRS[@]} store(s) — no prior run's outputs reach this one"
    fi
fi

# A PREVIOUS RUN'S COVERAGE VERDICT IS NOT THIS RUN'S.
#
# vc-coverage-<story>.json records which verification criteria had no test behind them.
# lib/vc-coverage-findings.js reads it straight out of LOG_DIR and renders it into the
# reviewer AND the writer, under text asserting it "compared this story's verification
# criteria against the tests it ACTUALLY PRODUCED". Nothing cleared it, so it was the
# LAST run's comparison, presented as this one's.
#
# Live 2026-08-15: an artifact written 08-14 18:35 reached the 07:17 writer prompt on
# 08-15 — four criteria reported as untested before that run had written a line, judged
# against a codeline hard-reset to baseline three times since. The block also carries
# "if it is testable, it needs a test" into a prompt whose own test-ownership section
# reads "Do NOT write, edit, or create any test file" — an instruction the writer is
# forbidden to act on, argued from data that is not about its work.
_VCC_CLEARED=0
while IFS= read -r _vcc; do
    [ -n "$_vcc" ] || continue
    rm -f "$_vcc" 2>/dev/null && _VCC_CLEARED=$((_VCC_CLEARED+1)) || true
done < <(find "$LOG_DIR" -maxdepth 1 -type f -name 'vc-coverage-*.json' 2>/dev/null)
if [ "$_VCC_CLEARED" -gt 0 ]; then
    info "  Cleared $_VCC_CLEARED VC-coverage verdict(s) — no prior run's coverage findings reach this writer"
fi

# THE PRODUCING MODEL IS PER-RUN STATE TOO, and it is caught by the SAME trap that caught
# story-retry-state above: the archive sweep matches `*.log` and
# `story-outputs-*.txt`, and this is a DIRECTORY of .json files, so it sails straight past. A survivor makes the
# next run's reviewer judge story S on the rung last run's writer happened to reach — a wrong
# model chosen by nothing, which is exactly what the block below exists to stop.
# THE PROJECT ROSTER IS A RUN OUTPUT, so it does not survive into the next run.
#
# It is derived from canonical on every launch — resume included — by the roster-specialiser, and
# reviewed before anything reads it. A roster that survives is a stored artefact with a lifetime:
# the next run's agents would be whoever the LAST run happened to derive, and nothing would ever
# ask whether canonical had moved since. That is the two-clock problem that left 40 project
# prompts stale against their templates while every test stayed green.
#
# Absence is the correct state at this point in a run. The seams refuse until the roster exists,
# which is what makes "derived every launch" enforceable rather than aspirational.
_ROSTER_FILE="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/roster.json}"
# A RESUME IS NOT THE NEXT RUN, so the argument above does not reach it.
#
# The rule this block enforces is right for a NEW launch: a roster that survives is a stored
# artefact with a lifetime, and the next run's agents would be whoever the LAST run derived. A
# resume is the SAME run continuing from its own checkpoint. The roster it holds was derived by
# this run, reviewed at this run's pause, and shown to the operator for approval — which is the
# whole purpose of pausing there. Deleting it makes the checkpoint meaningless.
#
# Same distinction the fetched-documents block above already draws for this run's own state.
#
# THREE COSTS, all of which landed before this was noticed. A paid roster-specialiser call, ~13
# minutes of wall clock. A roster that differs from the reviewed one, so the operator approved
# something the run then replaced. And every roster-keyed prompt invalidated, forcing a stage the
# checkpoint existed to skip — 17 of 39 regenerated on the 2026-09-01 resume for no other reason.
# The log said both things at once: "roster carried over from <run> — reviewed in that run, not
# re-reviewed here", immediately followed by the specialiser accepting a freshly derived roster.
if [ "${_IS_RESUMED_RUN:-0}" = "1" ] && [ -n "$_ROSTER_FILE" ] && [ -f "$_ROSTER_FILE" ]; then
    info "  Resuming — keeping this run's own reviewed roster; it is not re-derived"
elif [ -n "$_ROSTER_FILE" ] && [ -f "$_ROSTER_FILE" ]; then
    if rm -f "$_ROSTER_FILE" 2>/dev/null && [ ! -f "$_ROSTER_FILE" ]; then
        info "  Cleared the project roster — this run derives its own from canonical"
    else
        fail_contamination "the project roster at $_ROSTER_FILE could NOT be cleared — this run would inherit the agents the PREVIOUS run derived"
    fi
fi

_RUNG_STATE_DIR="$LOG_DIR/story-rung"
if [ -d "$_RUNG_STATE_DIR" ]; then
    _RUNG_REC_CLEARED=$(find "$_RUNG_STATE_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
    find "$_RUNG_STATE_DIR" -maxdepth 1 -type f -delete 2>/dev/null || true
    _RUNG_REC_LEFT=$(find "$_RUNG_STATE_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
    if [ "$_RUNG_REC_LEFT" -gt 0 ]; then
        fail_contamination "$_RUNG_REC_LEFT writer-rung record(s) could NOT be cleared in $_RUNG_STATE_DIR — this run's judges would inherit the rung the PREVIOUS run's writer reached"
    elif [ "$_RUNG_REC_CLEARED" -gt 0 ]; then
        info "  Cleared $_RUNG_REC_CLEARED writer-rung record(s) — no judge inherits a prior run's rung"
    fi
fi

_RETRY_STATE_DIR="$LOG_DIR/story-retry-state"
if [ -d "$_RETRY_STATE_DIR" ]; then
    _RETRY_CLEARED=$(find "$_RETRY_STATE_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
    find "$_RETRY_STATE_DIR" -maxdepth 1 -type f -delete 2>/dev/null || true
    _RETRY_LEFT=$(find "$_RETRY_STATE_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
    if [ "$_RETRY_LEFT" -gt 0 ]; then
        # ABORT rather than announce a clean slate we did not deliver. Surviving state means
        # the run starts mid-ladder on a model nobody chose, which is precisely what went
        # unnoticed through two runs — and this script's whole job is the clean slate.
        fail_contamination "$_RETRY_LEFT inference-ladder state file(s) could NOT be cleared in $_RETRY_STATE_DIR — a run started now would resume mid-ladder"
    elif [ "$_RETRY_CLEARED" -gt 0 ]; then
        info "  Cleared $_RETRY_CLEARED inference-ladder state file(s) — every story starts this run at rung 0 on its PRD-declared model"
    fi
fi
[ "$_ARCHIVED_LOGS" -gt 0 ] \
  && success "Moved $_ARCHIVED_LOGS stale *.log / manifest / baseline-cache file(s) → $ARCHIVE_DIR (absence now means 'this run did not write it')" \
  || info "  No stale .log files to move"

# ── The agent roster is EPHEMERAL ───────────────────────────────────────────
# Every run starts from the CANONICAL base roster, never from one a previous run
# mutated. Agent identities are generated per project now (the mint), and a
# generated roster that survives into the next run is a mutated base: two runs of
# 2026-08-07 left five roles behind, including two whose vendor was wrong, because
# the merge is additive by design so the second mint simply added to the first.
# Aggregating a roster over runs is not permitted.
#
# Cleared here rather than in the mint step so no launcher can skip it, and so the
# base is clean even for a run that never reaches the mint.
#
# KB-<role>.md USED to be exempt here: "per-agent knowledge is the one thing meant to
# persist across runs" (879c705). That exemption is REVOKED — operator, 2026-08-12, after
# KB-gotransit.md was found carrying conclusions from four separate days into every run.
# All agent KB is now cleared by kb_clear_agent_residue (lib/kb-canonical.sh), invoked from
# Step 3b below. Nothing an agent concluded survives the run that concluded it.
_ROSTER_CLEARED=0
_PROJECT_CFG_DIR="${EPAM_PROJECT_CONFIG_DIR:-}"
# A RESUME KEEPS THE ROSTER IT IS RESUMING WITH.
#
# Live 2026-08-08 (run 20260808T203346Z): the operator reviewed a roster at pause 1 and
# resumed. This cleared all three generated-roster files, the mint was then correctly SKIPPED
# because it was a resume, so nothing re-registered them, and role assignment died with "no
# project implementation roles are registered". The pause exists so a human can approve a
# roster before the spec phase; clearing it on the way back in destroys exactly that.
#
# The ephemeral-roster rule is about a FRESH run starting from the canonical base. A resume is
# the continuation of a run that already did so.
# DECIDED ONCE, READ EVERYWHERE. The roster is reset in TWO places in this script, and until
# 2026-08-12 only this one knew about resumes: the canonical restore further down replaced
# agents/profiles.json unconditionally. Both lines printed in the same reset, seconds apart —
# "keeping the roster this run already minted and reviewed", then "generated agents from prior
# runs are gone" — and the resumed run died at assignment with no agent. Any roster reset added
# later must read _IS_RESUME rather than re-deriving this.
_IS_RESUME=0
if [ "${_IS_RESUMED_RUN:-0}" = "1" ]; then
    _IS_RESUME=1
    _PROJECT_CFG_DIR=""
    info "  Resuming ${EPAM_RESUME_RUN} — keeping the roster this run already minted and reviewed"
elif [ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ]; then
    # THE SAME PROTECTION, FOR THE SAME REASON. Clearing these is right when the mint is about to
    # rebuild them: a registry naming agents the new roster never minted points consumers at
    # briefless names. When the mint is SKIPPED nothing rebuilds them, and the run deletes the
    # registries it is about to depend on — which on 2026-08-13 left the writer's own role absent
    # from the roster it was about to run under, and was only unblocked by authoring the files by
    # hand. They are agent artefacts; the pipeline preserves what an agent produced, and nobody
    # curates them.
    _IS_RESUME=1
    _PROJECT_CFG_DIR=""
    info "  Mint skipped (EPAM_SKIP_AGENT_MINT=1) — keeping the roster and registries the mint last produced"
fi
# BOTH registries. project-investigators.json was added after this list and never joined it,
# so a previous run's investigators survived every reset. Live 2026-08-08: six investigators
# were registered — three from that run and three from the run before, whose profiles had been
# restored away by the block just below. A registered investigator with no brief resolves to a
# name that reads as minted and investigates with nothing, and byCodeline can point a lane
# straight at it.
# role-assignments.json lives in LOG_DIR rather than the config dir, so it was never on this
# list. Live 2026-08-09: a run starting at 23:51 found the file from a run killed at 23:18,
# naming a role the new roster never minted. The rosters are ephemeral by design, so an
# assignment that outlives its roster points every consumer at an agent with no brief — and it
# reads as a successful assignment to anyone diagnosing a failure. Cleared with the registries
# it derives from, and preserved on a resume for the same reason they are.
_ASSIGN_DIR="${_PROJECT_CFG_DIR:+${LOG_DIR:-}}"
for _rf in "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/project-roles.json}" \
           "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/project-investigators.json}" \
           "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/agent-profiles.json}" \
           "${_ASSIGN_DIR:+$_ASSIGN_DIR/role-assignments.json}"; do
    [ -n "$_rf" ] && [ -f "$_rf" ] || continue
    # COPIED BEFORE IT IS DELETED. These are what the last run actually produced — the roster it
    # minted, the briefs it wrote, the assignments it made. Deleting them outright meant a killed
    # run left nothing to diagnose from and nothing to build a test fixture out of, so the only way
    # to see a real artefact was to pay for another run. The archive already exists for logs; this
    # is the same idea applied to the artefacts that actually decide a run's behaviour.
    mkdir -p "$ARCHIVE_DIR/generated" 2>/dev/null || true
    cp -p "$_rf" "$ARCHIVE_DIR/generated/$(basename "$_rf")" 2>/dev/null || true
    rm -f "$_rf" 2>/dev/null && _ROSTER_CLEARED=$((_ROSTER_CLEARED+1)) || true
done
if [ "$_ROSTER_CLEARED" -gt 0 ]; then
    info "  Cleared $_ROSTER_CLEARED generated-roster file(s) — this run mints from the canonical base"
fi

# ── The REST of what a run generates into the project config dir ────────────
#
# The registries above were cleared because a roster is ephemeral. Everything else a run WRITES
# into this directory was not, and each survivor is derived state the next run's agents read as
# though this run had produced it.
#
# Found 2026-08-17, mid-run 20260817T154640Z, checking whether it had provisioned its own prompts:
#
#   prompts/codeline-bridge.json      10:37   <- from the run whose survey returned state "failed"
#   prompts/assign-agent-roles.json   10:40   <- roster: transit-fare-engineer, since deleted
#   prompts/ac-classification.json    11:54
#   this run started                  12:01
#
# A project prompt is specialised against a specific roster and a specific survey. Those were
# written against a survey that read no files, for agents that no longer exist. Provisioning
# overwrites most of them alphabetically, so the window is narrow — but anything this run's list
# does not include is never overwritten and persists indefinitely.
#
# Same class as the PRD keeping the previous run's agentRole: derived state in a directory nothing
# walked. codeline-facts.json comes from discovery, estate-survey.md from the survey,
# prompt-agent-link.json from the mint — all rewritten every run that reaches those stages.
#
# _PROJECT_CFG_DIR is already empty on a resume and on a skipped mint, so this inherits both
# protections rather than re-deriving them: a resume continues a run that already reset, and
# nothing rebuilds these when the mint does not run.
_GEN_CLEARED=0
for _gf in "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/codeline-facts.json}" \
           "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/estate-survey.md}" \
           "${_PROJECT_CFG_DIR:+$_PROJECT_CFG_DIR/prompt-agent-link.json}"; do
    [ -n "$_gf" ] && [ -f "$_gf" ] || continue
    mkdir -p "$ARCHIVE_DIR/generated" 2>/dev/null || true
    cp -p "$_gf" "$ARCHIVE_DIR/generated/$(basename "$_gf")" 2>/dev/null || true
    rm -f "$_gf" 2>/dev/null && _GEN_CLEARED=$((_GEN_CLEARED+1)) || true
done
if [ "$_GEN_CLEARED" -gt 0 ]; then
    info "  Cleared $_GEN_CLEARED generated project artefact(s) — discovery, survey and mint rewrite these"
fi

# THE PROMPTS DIRECTORY, WHOLE. Named files would miss whatever the next seam adds, and the
# directory holds nothing a human authored — every file in it is rendered from a template by the
# prompt builder. Removed and recreated so the builder writes into a clean directory rather than
# over a mixture of this run's output and some earlier run's.
if [ -n "${_PROJECT_CFG_DIR:-}" ] && [ -d "$_PROJECT_CFG_DIR/prompts" ]; then
    _PROMPTS_N=$(find "$_PROJECT_CFG_DIR/prompts" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')
    # COPIED BEFORE THE WIPE, for the same reason as the roster above: these are the prompts the
    # last run's agents actually executed, and they are the only record of what each agent was
    # told. rm -rf destroyed them, so reproducing a prompt defect required another paid run.
    if [ "${_PROMPTS_N:-0}" -gt 0 ]; then
        mkdir -p "$ARCHIVE_DIR/prompts" 2>/dev/null || true
        cp -p "$_PROJECT_CFG_DIR/prompts/"*.json "$ARCHIVE_DIR/prompts/" 2>/dev/null || true
    fi
    # THE REFUSED ATTEMPTS TOO — and they are the ones worth keeping. An INSTALLED prompt can be
    # regenerated by rerunning a step that now succeeds; a REFUSED one exists only in the run that
    # failed, and it is the only text that says why the contract was not met. The glob above is
    # *.json at depth 1, so these .txt files under .refused/ were archived by nothing and deleted
    # by the rm -rf below — the evidence for a prompt defect destroyed by the next launch, which
    # is the failure this whole archive block exists to prevent.
    if [ -d "$_PROJECT_CFG_DIR/prompts/.refused" ]; then
        mkdir -p "$ARCHIVE_DIR/prompts/.refused" 2>/dev/null || true
        cp -p "$_PROJECT_CFG_DIR/prompts/.refused/"* "$ARCHIVE_DIR/prompts/.refused/" 2>/dev/null || true
        info "  Archived $(find "$_PROJECT_CFG_DIR/prompts/.refused" -type f 2>/dev/null | wc -l | tr -d '[:space:]') refused prompt attempt(s) before the wipe"
    fi
    rm -rf "$_PROJECT_CFG_DIR/prompts" && mkdir -p "$_PROJECT_CFG_DIR/prompts"
    [ "${_PROMPTS_N:-0}" -gt 0 ] \
        && info "  Cleared ${_PROMPTS_N} project prompt(s) — each was specialised for a roster this run has not minted"
fi

# Restore the live roster from its canonical original, so a run that begins here
# starts from the base even if its launcher does not restore.
# Overridable so this block is testable in isolation and so a project that keeps its
# agents elsewhere is not assumed to keep them here.
_AGENTS_DIR="${EPAM_AGENTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../agents" 2>/dev/null && pwd || true)}"
if [ "$_IS_RESUME" = "1" ]; then
    # A RESUME KEEPS THE ROSTER IT IS RESUMING WITH — including this one. The ephemeral-roster
    # rule is about a FRESH run starting from the canonical base; a resume is the continuation
    # of a run that already did so, and its roster was reviewed by a human at the pause.
    info "  Resume — keeping agents/profiles.json as minted; not restoring from canonical"
elif [ -n "$_AGENTS_DIR" ] && [ -f "$_AGENTS_DIR/profiles.json.original" ]; then
    cp "$_AGENTS_DIR/profiles.json.original" "$_AGENTS_DIR/profiles.json" 2>/dev/null \
        && info "  Roster restored from canonical original — generated agents from prior runs are gone" \
        || true
fi

# ── Restore the runtime PRD from its canonical original ─────────────────────
#
# THE PRD IS THE THIRD PLACE AN ASSIGNMENT LIVES, AND THE ONLY ONE NOTHING RESET.
#
# The two registries and role-assignments.json are cleared above, for the reason given there: a
# roster is ephemeral, so an assignment that outlives it names an agent with no brief. Each story
# in the PRD carries an agentRole too, written during the run — and nothing ever cleared it.
#
# Live 2026-08-17, mock3 run 20260817T152632Z. The reset ran, the roster was restored to canonical,
# the mint drew a FRESH roster (typescript-logic-engineer, mocka-fares-investigator,
# mockb-schedule-investigator) and the roster review passed. Assignment then read the PRD, found
# "transit-fare-engineer" left there by the run before, and correctly refused:
#
#   [assign] MOCK3-1 was assigned "transit-fare-engineer", which is not in the roster — it has no
#   profile entry, so the writer would run with an empty system prompt.
#
# Minted names are a fresh draw every run, so a persisted assignment is stale BY CONSTRUCTION: it
# can only be right by coincidence, and the coincidence gets rarer as roles are renamed.
#
# The per-project launchers this repo replaced (tier3-travel-app-run.sh, tier3-skyscanner-app-run.sh)
# each restored the PRD themselves. Generalising them into tier3-run.sh — "25 of that launcher's 588
# lines name its project" — dropped the restore along with the project names, and no launcher has
# done it since. It belongs here rather than in any launcher, next to the roster and KB restores, so
# every launcher inherits it and there is one place to change.
#
# Restores the WHOLE file rather than stripping known fields: the canonical is the base state, and a
# subtractive list would silently miss the next per-run field somebody adds.
# NOTHING TO RESTORE. This copied prd.canonical.json over the runtime PRD, which made that stored
# file the base state of every run — and it was hand-edited to unblock launches, so runs inherited
# a previous run's conclusions as premises.
#
# The PRD is ingested: the tracker supplies the work and the project's config supplies the
# identity, both re-read every run. A run that ingests cannot inherit, and a run that does not
# ingest has no PRD to restore from a template either.
# THE PRD IS RESTORED FOR EVERY FRESH RUN, INCLUDING ONE THAT SKIPS THE MINT.
#
# This read _IS_RESUME, which EPAM_SKIP_AGENT_MINT=1 also sets. That exemption exists for the
# ROSTER, where it is right — nothing rebuilds a roster the mint did not mint. The PRD is rebuilt
# from an authored file that is always present, so it does not need the exemption and must not
# borrow it: a fresh skip-mint run inherited whatever the previous run had written.
#
# Live 2026-08-27, the first mock3 launch: this printed "Resume — keeping the runtime PRD" on a
# FRESH run, and scope resolution then found the previous run's two codelines already declared and
# skipped codeline-discovery entirely — one of the two agents that run existed to exercise.
if [ "${_IS_RESUMED_RUN:-0}" = "1" ]; then
    info "  Resume — keeping the runtime PRD as the run left it"
elif [ "${JIRA_PIPELINE:-0}" = "1" ]; then
    # AN INGESTING PROJECT REBUILDS ITS PRD FROM THE TRACKER, so there is nothing to restore and
    # nothing stored that could carry a previous run's conclusions into this one.
    info "  PRD comes from the tracker this run — nothing stored to restore"
elif [ -n "${PRD_FILE:-}" ] && [ -f "$(dirname "$PRD_FILE")/prd.authored.json" ]; then
    # A PROJECT THAT AUTHORS ITS PRD has no tracker to rebuild from, so its authored input IS the
    # base state and restoring it is what makes the slate clean — the run's own writes to prd.json
    # are discarded rather than accumulating. Named for what it is: an authored input, not a
    # "canonical" template that synthesis fills.
    _PRD_AUTHORED="$(dirname "$PRD_FILE")/prd.authored.json"
    if ! jq -e . "$_PRD_AUTHORED" >/dev/null 2>&1; then
        fail "$_PRD_AUTHORED is not valid JSON. The runtime PRD is NOT restored and still carries the
  previous run's assignments, so this run cannot start clean. Repair it before running."
    fi
    cp "$_PRD_AUTHORED" "$PRD_FILE" \
        || fail "could not restore the PRD from $_PRD_AUTHORED — refusing to start a run that would
  inherit the previous run's agent assignments."
    info "  PRD restored from the project's authored input — prior run's assignments are gone"
fi

# Clear stale lock files
for lf in "$LOG_DIR"/*.lock; do
  [ -f "$lf" ] && : > "$lf"
done

[ "$ARCHIVED" -gt 0 ] \
  && success "Archived $ARCHIVED log files → $ARCHIVE_DIR" \
  || info "  No non-empty logs to archive (already clean)"

# ── Step 3: Clear KB scratchpad (per-run attempt files — stale notes from failed
# runs contaminate future attempts with wrong diagnoses; reset before every run)
# Scoped to EVERY kb-scratchpad under LOG_DIR, not just the top-level one.
# Found 2026-08-06: this cleared only "$LOG_DIR/kb-scratchpad", but a parallel
# run writes its review lessons per lane — orchestrations/logs/lanes/<lane>/
# kb-scratchpad/KB-review-agent.md (see Step 3.6's _escalate_review_story in
# run-agent-orchestration.sh, which appends there). All three lane files
# survived every reset and were still being injected into later runs, which is
# precisely the cross-run contamination this step exists to prevent.
KB_COUNT=$(find "$LOG_DIR" -type d -name kb-scratchpad -exec find {} -name "*.md" \; 2>/dev/null | wc -l)
if [ "$KB_COUNT" -gt 0 ]; then
  find "$LOG_DIR" -type d -name kb-scratchpad -exec find {} -name "*.md" -delete \; 2>/dev/null
  success "Cleared $KB_COUNT KB scratchpad file(s) from all kb-scratchpad dirs under $LOG_DIR"
else
  info "  KB scratchpad already empty (all lanes)"
fi

# ── Step 3a2: Clear persisted MODEL-LADDER position ─────────────────────────
#
# agent-ladder/ records which rung each agent climbed to, so a retry within a run resumes rather
# than restarting at the base model. Nothing cleared it between RUNS, so the position survived —
# and the state directory carried entries from other projects entirely.
#
# Live 2026-08-17: three failed mock3 launches left codeline-discovery.global pinned to the top
# rung, so the FIRST call of the next run announced "resuming ladder on 'moonshotai/kimi-k3'
# (persisted from an earlier invocation)" and started at the ceiling — no cheaper rung was ever
# tried, and when that model returned empty the run had nowhere left to climb. Alongside it sat
# impl-failure-analyst.AMSD-2041, two days old, from a different project.
#
# A run must start on the rung its seam declares. Same reasoning as the KB reset above: state that
# outlives its run is contamination, not memory.
_LADDER_DIR="$LOG_DIR/agent-ladder"
if [ -d "$_LADDER_DIR" ]; then
  _LADDER_N=$(find "$_LADDER_DIR" -type f 2>/dev/null | wc -l)
  if [ "${_LADDER_N:-0}" -gt 0 ]; then
    find "$_LADDER_DIR" -type f -delete 2>/dev/null || true
    success "Cleared $_LADDER_N persisted ladder position(s) — every agent starts on the rung its seam declares"
  else
    info "  No persisted ladder positions"
  fi
fi

# ── Step 3b: Restore the KB to its canonical state ──────────────────────────
# The scratchpad above is per-run attempt notes. This is the KB ITSELF, which had no
# canonical to restore from and therefore accumulated across every run — and it is
# injected into writer prompts, so a wrong entry teaches every later agent. See
# lib/kb-canonical.sh. Self-heal still writes the KB freely DURING a run; nothing carries
# it into the next one.
# shellcheck source=lib/kb-canonical.sh
. "$SCRIPT_DIR/lib/kb-canonical.sh"
kb_restore_canonical "$REPO_ROOT/orchestrations"
# AND THE LAUNCHING PROJECT'S OWN KB — deleted outright. The line above resets only the ENGINE KB;
# the project's KB.md and kb/ were touched by nothing, so a run inherited the previous run's
# conclusions about a different ticket.
kb_delete_project_kb

# ── Step 4: Reset agent-status.json ──────────────────────────────────────────
info "Resetting agent-status.json..."
echo '{"startedAt":null,"phase":null,"orchMode":null,"lanes":{},"events":[],"stories":{},"completedAt":null}' \
  > "$LOG_DIR/agent-status.json"
success "agent-status.json reset"

# ── Completion signal ─────────────────────────────────────────────────────────
#
# POSITIVE PROOF THAT THE STATE WORK RAN, because an exit code cannot carry it.
#
# This script runs under `set -euo pipefail` and clears state in sequence. Any command
# that fails part-way kills it, and the caller then sees a bare exit 1 — identical to
# "the dashboard is down". On 2026-08-14 exactly that happened: a count of an
# already-removed directory returned 1 (pipefail), the script died at line ~386 of 555,
# and lib/pre-run-reset-gate.sh reported "(dashboard/environment, not state) —
# non-fatal, continuing" while story-retry-state, the kb-scratchpad and the roster clear
# had never run. The next run inherited 12/12 attempts and died in 18 seconds.
#
# A sentinel emitted HERE — after every state-clearing step, before the cosmetic summary
# — is the only thing that distinguishes "finished" from "stopped somewhere". The gate
# requires it and refuses the launch without it, whatever the exit code says.
echo "PRE_RUN_RESET_STATE_CLEARED"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
success "Pre-run reset complete."
echo "  PRD:         $PRD_FILE"
echo "  Log dir:     $LOG_DIR"
echo "  Dashboard:   $(service_url dashboard)/monitor.html"
echo "  PRD Viewer:  $(service_url dashboard)/prd-viewer.html"
echo "  Langfuse:    $(service_url langfuse)"
echo ""

