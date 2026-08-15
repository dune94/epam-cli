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
# Service endpoints come from orchestrations/config/services.json — one place to change
# a port, instead of the 20+ copies these URLs used to have across the pipeline.
. "$(dirname "${BASH_SOURCE[0]}")/lib/service-urls.sh"

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
if [ -n "${EPAM_RESUME_RUN:-}" ]; then
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
    rm -f "$_rf" 2>/dev/null && _ROSTER_CLEARED=$((_ROSTER_CLEARED+1)) || true
done
if [ "$_ROSTER_CLEARED" -gt 0 ]; then
    info "  Cleared $_ROSTER_CLEARED generated-roster file(s) — this run mints from the canonical base"
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

# Clear stale lock files
for lf in "$LOG_DIR"/*.lock; do
  [ -f "$lf" ] && > "$lf"
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

# ── Step 3b: Restore the KB to its canonical state ──────────────────────────
# The scratchpad above is per-run attempt notes. This is the KB ITSELF, which had no
# canonical to restore from and therefore accumulated across every run — and it is
# injected into writer prompts, so a wrong entry teaches every later agent. See
# lib/kb-canonical.sh. Self-heal still writes the KB freely DURING a run; nothing carries
# it into the next one.
# shellcheck source=lib/kb-canonical.sh
. "$SCRIPT_DIR/lib/kb-canonical.sh"
kb_restore_canonical "$REPO_ROOT/orchestrations"

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

