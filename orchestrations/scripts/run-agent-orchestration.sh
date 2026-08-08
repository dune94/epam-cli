#!/bin/bash

# Master orchestration script for parallel multi-agent execution
# Coordinates worktree-based parallel Claude agents across all EPAM CLI project phases

# ── Give the repositories back, on every exit ────────────────────────────────
# The write perimeter locks every codeline at run start. Nothing released them when the run
# ENDED — not on success, not on the pause before the writer, which is how these runs are
# meant to finish. Twice on 2026-08-06 a paused run left 23 of the operator's repositories
# read-only with no message. A trap covers every exit path, including the ones added later.
_release_write_perimeter() {
    local _lib
    _lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/codeline-write-perimeter.sh"
    [ -f "$_lib" ] || return 0
    # shellcheck source=lib/codeline-write-perimeter.sh
    . "$_lib" 2>/dev/null || return 0
    perimeter_release_all "${JIRA_CODELINE_ROOT:-}" || true
}
trap '_release_write_perimeter' EXIT
#
# Usage:
#   ./run-agent-orchestration.sh                                    # Run default phase (finops)
#   ./run-agent-orchestration.sh --phase finops                     # Run specific phase
#   ./run-agent-orchestration.sh --dry-run                          # Preview execution plan
#   ./run-agent-orchestration.sh --skip-cleanup                     # Keep worktrees for inspection

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$AUTOMATION_DIR/scripts/lib/env-file.sh"

# Early-load Jira env only when Jira mode is already externally activated
# (JIRA_PIPELINE=1 set by the caller — e.g. `source jira/.env` before running).
# Loading unconditionally would force every canonical-PRD run through the Jira
# pipeline and pollute the env with JIRA_PIPELINE=1.
# Only auto-source jira/.env when the caller has NOT already set JIRA_URL —
# if JIRA_URL is already in the environment (set by orchestrate.sh from the
# project config) the caller's config must win; sourcing here would clobber it
# with whatever stale/wrong project is in jira/.env.
if [ "${JIRA_PIPELINE:-0}" = "1" ] && [ -z "${JIRA_CODELINE_RUN:-}" ] && \
   [ -z "${JIRA_URL:-}" ] && [ -f "$AUTOMATION_DIR/jira/.env" ]; then
  load_env_file_safe "$AUTOMATION_DIR/jira/.env"
fi

# Setsid guard: re-exec under a new session so parent SIGTERM doesn't propagate
# to long-running agent subprocesses. Only applies to top-level Jira pipeline runs.
if [ "${JIRA_PIPELINE:-0}" = "1" ] && [ -z "${JIRA_CODELINE_RUN:-}" ] && \
   [ -z "${_ORCH_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export _ORCH_SETSID_DONE=1
  exec setsid bash "$0" "$@"
fi

PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
# Always resolve to absolute path — relative paths break when CWD changes in worktrees
PRD_FILE="$(cd "$(dirname "$PRD_FILE")" && pwd)/$(basename "$PRD_FILE")"
# Exported so subprocesses invoked by absolute path (e.g. team-lead-review.sh)
# resolve the SAME PRD as this run, instead of falling back to their own
# AUTOMATION_DIR/prd.json — which silently reviews the wrong project entirely
# whenever PRD_FILE points at an external test-app/codeline.
export PRD_FILE

# Resolve NODE_BIN once so all inline `node -e` calls (codeline extraction,
# story counting, etc.) use a consistent, working binary regardless of PATH.
# Callers that export NODE_BIN explicitly (e.g. CI / tier scripts) are respected.
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
export NODE_BIN

# shellcheck source=lib/tc-writer-gate.sh
source "$SCRIPT_DIR/lib/tc-writer-gate.sh"
# shellcheck source=lib/story-guards.sh
source "$SCRIPT_DIR/lib/story-guards.sh"
source "$SCRIPT_DIR/lib/flags.sh"
source "$SCRIPT_DIR/lib/run-checkpoint.sh"
# shellcheck source=lib/git-ops.sh
source "$SCRIPT_DIR/lib/git-ops.sh"
source "$SCRIPT_DIR/lib/story-retry-state.sh"

# Load timeout config from EPAM_PROJECT_CONFIG_DIR/llm-settings.json BEFORE
# any call to the watchdog wrapper defined further below — its `timeout`
# wrapper is computed synchronously the moment it's called, so this must run
# here, in THIS process, not inside claude.sh (which the watchdog invokes as
# a subprocess — too late by construction; see _load_timeout_config()'s
# docstring in lib/story-guards.sh).
_load_timeout_config

# Load project .env so API keys are available to all subprocesses (worktrees, epam-run, etc.)
# Preserve caller-set gate overrides so tier scripts can override .env defaults.
_pre_gate_provider="${ORCH_GATE_PROVIDER:-}"
_pre_gate_model="${ORCH_GATE_MODEL:-}"
_env_file="$(dirname "$AUTOMATION_DIR")/.env"
if [ -f "$_env_file" ]; then set -a; . "$_env_file"; set +a; fi
unset _env_file
# Restore caller overrides (tier scripts set these intentionally; .env has stale defaults)
[ -n "$_pre_gate_provider" ] && ORCH_GATE_PROVIDER="$_pre_gate_provider"
[ -n "$_pre_gate_model"    ] && ORCH_GATE_MODEL="$_pre_gate_model"
unset _pre_gate_provider _pre_gate_model
# When PRD_FILE is an external path (e.g. a test-app), derive PROJECT_ROOT from
# the directory two levels above the PRD file (prd sits in <root>/orchestrations/ normally,
# but for test apps it sits directly in the app root — detect via presence of package.json).
# PROJECT_ROOT can also be pre-set in the environment to force a specific directory.
_prd_dir="$(cd "$(dirname "$PRD_FILE")" && pwd)"
if [ -z "${PROJECT_ROOT:-}" ]; then
  # Read project.outputDir from PRD if present, else derive from PRD location
  _prd_output_dir=$(python3 -c "import sys,json; d=json.load(open('$PRD_FILE')); print(d.get('project',{}).get('outputDir',''))" 2>/dev/null || true)
  if [ -n "$_prd_output_dir" ]; then
    PROJECT_ROOT="$_prd_output_dir"
  elif [ -f "$_prd_dir/package.json" ]; then
    PROJECT_ROOT="$_prd_dir"
  else
    PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
  fi
fi
export PROJECT_ROOT

# Safety guard: PROJECT_ROOT must never be the epam-cli repo itself.
# Test apps must live in a separate directory (e.g. /home/.../epam-test-apps/<name>
# or /tmp/<name>). This prevents test artifacts polluting the orchestration codebase.
_repo_root="$(cd "$AUTOMATION_DIR/.." && pwd)"
if [ "$PROJECT_ROOT" = "$_repo_root" ]; then
  echo "ERROR: PROJECT_ROOT resolves to the epam-cli repo root ('$_repo_root')." >&2
  echo "       Set project.outputDir in your PRD to an external test-app directory." >&2
  echo "       Convention: any directory OUTSIDE this repository — the engine must never write into itself." >&2
  exit 1
fi

# Safety guard: the binary must be built from the source in this tree.
# `epam` is a shim around dist/epam.js — the pipeline never runs src/ — so a
# stale dist means a source change silently does not execute while APPEARING to
# (2026-07-26: dist was two days old, and that morning's AgentRunner tool-budget
# change would have been a complete no-op in a live run; caught only by a manual
# check before launch). Sourced defensively so a missing lib cannot block a run.
if [ -f "$SCRIPT_DIR/lib/dist-freshness.sh" ]; then
  # shellcheck disable=SC1090
  . "$SCRIPT_DIR/lib/dist-freshness.sh"
  if ! assert_dist_fresh "$_repo_root"; then
    exit 1
  fi
fi

AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
# Compute PRD path relative to PROJECT_ROOT for injecting into agent prompts.
# In the codeline-loop path, PRD_FILE is a per-codeline temp copy under /tmp/
# (e.g. /tmp/orch-<cl>-prd-$$.json) that lives nowhere near PROJECT_ROOT (a
# codeline worktree elsewhere under /tmp/ or the real project tree) — the
# "relative" path then requires several "../" hops out of the project root
# entirely (e.g. "../../../orch-mockhelloworld-prd-12345.json"). Found live
# 2026-07-23: an agent given that path burned its whole iteration budget
# reasoning about whether the traversal was valid instead of just reading
# the file, and never completed its actual task. Use the absolute path in
# that case — it's unambiguous and costs the agent nothing to resolve.
PRD_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$PRD_FILE")" 2>/dev/null || echo "orchestrations/prd.json")"
case "$PRD_REL" in
  ../*) PRD_REL="$(realpath "$PRD_FILE" 2>/dev/null || echo "$PRD_FILE")" ;;
esac
# B18 — agents run with cwd = the CODELINE, not this repo, so a BARE "profiles.json"
# does not resolve. The pre-phase assessment prompt named it bare eight times; unable
# to find it, the agent ran `find / -name profiles.json` and the pipeline sat there
# for 282 SECONDS (mock1, 2026-07-24 — nearly all of what looked like "slow LLM
# calls"). Same relative-inside / absolute-outside treatment as PRD_REL above.
PROFILES_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$AGENT_PROFILES_FILE")" 2>/dev/null || echo "$AGENT_PROFILES_FILE")"
case "$PROFILES_REL" in
  ../*) PROFILES_REL="$(realpath "$AGENT_PROFILES_FILE" 2>/dev/null || echo "$AGENT_PROFILES_FILE")" ;;
esac
# Select wrapper script based on PROVIDER override or CLAUDE_CMD
case "${EPAM_ORCHESTRATION_PROVIDER:-${CLAUDE_CMD}}" in
    codemie-claude) CLAUDE_SH="$SCRIPT_DIR/codemie-claude.sh" ;;
    copilot)        CLAUDE_SH="$SCRIPT_DIR/copilot.sh" ;;
    openai)         CLAUDE_SH="$SCRIPT_DIR/openai.sh" ;;
    qwen)           CLAUDE_SH="$SCRIPT_DIR/qwen.sh" ;;
    cursor)         CLAUDE_SH="$SCRIPT_DIR/cursor.sh" ;;
    codex)          CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    *)
        error "Unknown EPAM_ORCHESTRATION_PROVIDER '${EPAM_ORCHESTRATION_PROVIDER:-}'. Set it to one of: qwen|openai|copilot|cursor|codex|codemie-claude|claude in your .env file."
        exit 1
        ;;
esac
# Run logs default to orchestrations/logs/ so the nginx-served dashboard can see
# them. OUTPUT_DIR is for generated app code, not run telemetry.
#
# An INHERITED LOG_DIR wins. Parallel lanes give each codeline its own directory
# so that files read back as state — phase-baseline-sha.txt above all — cannot
# leak between lanes. This assignment used to be unconditional, so the lane loop
# passed the right value and the script discarded it: live metrolinx 2026-07-29
# ran three lanes whose environments named three separate directories, all of
# them empty, with everything still written to the shared one. The wiring was
# correct and invisible.
LOG_DIR="${LOG_DIR:-$AUTOMATION_DIR/logs}"
MONITOR_STATUS_FILE="$LOG_DIR/agent-status.json"
MESSAGES_JSONL="$LOG_DIR/agent-messages.jsonl"
# Export so all subprocesses (claude.sh, update-monitor.sh, invoke.py) write to the same files
export MONITOR_FILE="$MONITOR_STATUS_FILE"
export ACTIVITY_FILE="$LOG_DIR/agent-activity.jsonl"
export MESSAGES_JSONL="$LOG_DIR/agent-messages.jsonl"
export PHASE_COST_FILE="$LOG_DIR/phase-cost.jsonl"
export REVIEW_LOG="$LOG_DIR/code-reviews.jsonl"
export GATE_LOG="$LOG_DIR/phase-gates.jsonl"
export COST_LOG="$LOG_DIR/phase-cost.jsonl"
export MESSAGES_DIR="$LOG_DIR/messages"
export LOG_DIR
# PHASE reaches ai-run.sh so each agent plan is filed under the phase that
# produced it. Unexported, every plan landed in plans-unknown.jsonl.
export PHASE
# Propagate OpenRouter mock URL to all subprocesses (CPA, spec, ai-run.sh, testing gates)
[ -n "${OPENROUTER_BASE_URL:-}" ] && export OPENROUTER_BASE_URL
[ -n "${OPENROUTER_API_KEY:-}" ] && export OPENROUTER_API_KEY
[ -n "${EPAM_API_KEY_OPENROUTER:-}" ] && export EPAM_API_KEY_OPENROUTER
[ -n "${EPAM_QWEN_MODEL_OVERRIDE:-}" ] && export EPAM_QWEN_MODEL_OVERRIDE
# Propagate MiniMax key to all subprocesses
[ -n "${MINIMAX_API_KEY:-}" ] && export MINIMAX_API_KEY
[ -n "${EPAM_API_KEY_MINIMAX:-}" ] && export EPAM_API_KEY_MINIMAX
[ -n "${MINIMAX_BASE_URL:-}" ] && export MINIMAX_BASE_URL
[ -n "${ORCH_MINI_MODEL:-}" ] && export ORCH_MINI_MODEL
[ -n "${ORCH_UPGRADE_MODEL:-}" ] && export ORCH_UPGRADE_MODEL
[ -n "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && export EPAM_FINAL_FALLBACK_MODEL
[ -n "${EPAM_FINAL_FALLBACK_PROVIDER:-}" ] && export EPAM_FINAL_FALLBACK_PROVIDER
[ -n "${ORCH_GATE_PROVIDER:-}" ] && export ORCH_GATE_PROVIDER
[ -n "${ORCH_GATE_MODEL:-}" ] && export ORCH_GATE_MODEL
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
if [ -n "${CLAUDE_CMD:-}" ]; then
    CLAUDE_CMD="$CLAUDE_CMD"
elif [ "${EPAM_ORCHESTRATION_PROVIDER:-}" = "codex" ]; then
    CLAUDE_CMD="codex"
elif [ "${EPAM_ORCHESTRATION_PROVIDER:-}" = "qwen" ]; then
    CLAUDE_CMD="qwen"
else
    CLAUDE_CMD="claude"
fi

EPAM_SANDBOX="${EPAM_SANDBOX:-false}"
EPAM_SANDBOX_ALLOW_NETWORK="${EPAM_SANDBOX_ALLOW_NETWORK:-false}"

# Timeout policy:
#   STORY_TIMEOUT_SECS   — override flat timeout (skips effort-based scaling)
#   EPAM_PAUSE_ON_TIMEOUT — when "true", double-timeout pauses for operator;
#                           default "false" skips the story and continues
#                           (appropriate for autonomous/CI runs)
#   EPAM_MAX_PAUSE_SECS  — even when pausing, auto-resume after this many
#                           seconds (default 300); prevents indefinite hangs
EPAM_PAUSE_ON_TIMEOUT="${EPAM_PAUSE_ON_TIMEOUT:-false}"
EPAM_MAX_PAUSE_SECS="${EPAM_MAX_PAUSE_SECS:-300}"
mkdir -p "$LOG_DIR"
DASHBOARD_WATCH_PID_FILE="$LOG_DIR/dashboards-watch.pid"
DASHBOARD_WATCH_LOG="$LOG_DIR/dashboards-watch.log"
DASHBOARD_WATCH_PID=""
DASHBOARD_WATCH_OWNED=false
# PER-LANE CONTROL-PLANE PORT.
#
# Live 2026-08-04 (run 20260804T011537Z, three metrolinx lanes): this was a bare
# `${CONTROL_PLANE_PORT:-8094}`, so every lane started a control plane on 8094. The first
# bound it and the rest exited ("port already in use"), leaving those lanes with no
# control plane — and because the startup path KILLS whatever holds the port first, a
# later lane reaped the running lane's control plane. Three "Killing stale process on
# port 8094" warnings in one run were lanes destroying each other.
#
# Same shape as the checkpoint collision (b76e414): a per-lane resource keyed on a
# run-global value. The lane is derived exactly as the checkpoint's is — CODELINE_NAME
# when set, otherwise project.outputDir matched back against project.outputDirs[], since
# the orchestrator keeps the lane name as a local and never exports it.
#
# The offset is the lane's INDEX in outputDirs, so it is stable across restarts (a resume
# must find its own control plane) and bounded by the number of codelines. A single-
# codeline run resolves no lane and keeps the base port, unchanged.
CONTROL_PLANE_BASE_PORT="${CONTROL_PLANE_BASE_PORT:-8094}"
_resolve_control_plane_port() {
    # Self-contained: reads only the environment, so it can be tested in isolation.
    local _base="${CONTROL_PLANE_BASE_PORT:-8094}"
    # An explicit override always wins — the operator can pin a port.
    if [ -n "${CONTROL_PLANE_PORT:-}" ]; then
        printf '%s' "$CONTROL_PLANE_PORT"; return 0
    fi
    local _lane="${CODELINE_NAME:-}"
    if [ -z "$_lane" ] && [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _lane=$(jq -r '.project as $p | (($p.outputDirs // []) | map(select(.path == $p.outputDir)) | .[0].codeline) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    if [ -z "$_lane" ]; then
        printf '%s' "$_base"; return 0
    fi
    local _idx=""
    if [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _idx=$(jq -r --arg cl "$_lane" '((.project.outputDirs // []) | map(.codeline) | index($cl)) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    if [ -z "$_idx" ] || [ "$_idx" = "null" ]; then
        _idx=$(printf '%s' "$_lane" | cksum | awk '{print $1 % 64}')
    fi
    printf '%s' "$(( _base + _idx ))"
}
CONTROL_PLANE_PORT="$(_resolve_control_plane_port)"
CONTROL_PLANE_PID=""
CONTROL_PLANE_LOG="$LOG_DIR/control-plane.log"

# GAP-P13 Phase 1 — Durable orchestration: idempotency key + file checkpoints
# Each run gets a unique ID. After each story completes, a checkpoint entry is
# written so a crash-restart can skip already-finished stories without needing
# RESET_STORIES=false (which would otherwise re-run everything from scratch).
# EXPORTED so every child inherits it — each agent call is a separate `epam run`
# subprocess, and TracedProvider uses ORCH_RUN_ID as the Langfuse sessionId to
# group a run's traces. Without the export it was set but invisible to children,
# so every trace had sessionId:null and all runs blended into one stream
# (which produced a wrong, retracted cost analysis on 2026-07-24).
# `date -u`: the id ends in Z, which asserts UTC. It was LOCAL time, so the same
# instant rendered as 15:36:35Z here and 19:37:20Z elsewhere — one run looking
# like two, hours apart.
export ORCH_RUN_ID="${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
CHECKPOINT_FILE="${LOG_DIR}/checkpoint-${PHASE:-main}-${ORCH_RUN_ID}.jsonl"

# Announce the run id IMMEDIATELY, before any work. The operator needs it to resume,
# to find the logs, and to refer to the run at all — printing it only at the end (or
# only at a pause) means a run that is still going, or that died, has no usable handle.
echo ""
echo "  RUN NUMBER: ${ORCH_RUN_ID}"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'

log()     { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

# ── Step status tracking ──────────────────────────────────────────────────────
# step_emit <step_id> <status> <label> [reason]
#   status: pending | running | pass | skip | fail | warn
# Writes to terminal + step-status.json (read by dashboard)
STEP_STATUS_FILE="${LOG_DIR:-/tmp}/step-status.json"
declare -A _STEP_LABELS=()
declare -A _STEP_STATUS=()
declare -A _STEP_REASON=()

# Minimal JSON string escaping for step_emit's label/reason fields — both can
# carry dynamic content (model names, story counts, gate verdict summaries)
# that may contain a literal quote or backslash and would otherwise produce
# malformed step-status.json.
_json_escape_str() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

# review_feedback_is_incomplete
# True when the REVIEWER failed rather than the code being wrong. Re-running the
# review is the right answer then; re-implementing is not.
#
# B24 established this, but keyed only on review-incomplete-<phase>.flag or an
# empty feedback set. team-lead-review.sh has THREE unparseable-verdict paths:
# two write the flag, and one writes only a per-story
# review-feedback-<id>.json. Live metrolinx 2026-07-26 hit that third path, so
# the flag was absent AND the feedback count was 1 — both halves of the guard
# missed, and the pipeline re-implemented a fix the bug-reproduction gate had
# just proven correct, on "feedback" whose only content was that there was none.
#
# Keys on CONTENT (reviewIncomplete in the verdict) so it cannot depend on a
# side-channel filename matching across two scripts. Unreadable feedback counts
# as incomplete too: that is not evidence the code is wrong either. A single
# genuinely-reviewed story means real findings — the re-implementation loop is
# how over-engineering gets corrected and must not be disabled.
review_feedback_is_incomplete() {
    [ -f "$LOG_DIR/review-incomplete-${PHASE}.flag" ] && return 0
    local _f _any=0
    for _f in "$LOG_DIR"/review-feedback-*.json; do
        [ -f "$_f" ] || continue
        _any=1
        if [ "$(jq -r '.reviewIncomplete // false' "$_f" 2>/dev/null)" != "true" ]; then
            # jq failed (unreadable) or the verdict is a real finding.
            jq -e . "$_f" >/dev/null 2>&1 || continue
            return 1
        fi
    done
    [ "$_any" -eq 0 ] && return 0
    return 0
}

step_emit() {
    local step_id="$1"
    local status="$2"
    local label="$3"
    local reason="${4:-}"
    local ts
    ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)

    _STEP_LABELS["$step_id"]="$label"
    _STEP_STATUS["$step_id"]="$status"
    # Only overwrite the stored reason when this call actually supplied one —
    # many terminal-state calls (e.g. the final "pass") are emitted right
    # after a "running" call with no reason, and would otherwise blank out
    # a real detail a caller set moments earlier (found while wiring real
    # per-step detail through to the dashboard, 2026-07-13).
    [ -n "$reason" ] && _STEP_REASON["$step_id"]="$reason"

    local icon
    case "$status" in
        pass)    icon="${GREEN}  ✓${NC}" ;;
        skip)    icon="${YELLOW}  ⊘${NC}" ;;
        fail)    icon="${RED}  ✗${NC}" ;;
        warn)    icon="${YELLOW}  ⚠${NC}" ;;
        running) icon="${CYAN}  ▶${NC}" ;;
        *)       icon="    " ;;
    esac

    local reason_str=""
    [ -n "$reason" ] && reason_str=" ${YELLOW}[${reason}]${NC}"
    echo -e "${icon} ${label}${reason_str}"

    # Write JSON snapshot (atomic via tmp file)
    local tmp_file="${STEP_STATUS_FILE}.tmp.$$"
    {
        echo "{"
        echo "  \"phase\": \"${PHASE:-unknown}\","
        echo "  \"updatedAt\": \"${ts}\","
        echo "  \"steps\": ["
        local first=true
        local _sid _slabel _sstatus _sreason
        for _sid in \
            "1:spec" "1a:openspec" "1b:speckit" "2:cpa" "3:skill-pre" "4:hybrid-coord" "5:regression" \
            "6:mkdir" "7:model-coord" "8:main-stories" "9:auto-commit" "10:tc-writer" \
            "11:skills-audit" "12:tools-audit" "13:worktrees" "14:primary" "15:independent" "16:wt-health" \
            "17:wt-merge" "18:skill-post" "19:pre-review" "20:lint-gate" \
            "21:review-stories" "22a:sast" "22b:spec-val" \
            "22c:review-ranger" "22d:mutant-hunter" \
            "22e:fuzz-weaver" "22f:perf-sentinel" "23:e2e"; do
            local _key="${_sid%%:*}"
            _slabel="$(_json_escape_str "${_STEP_LABELS[$_key]:-${_sid#*:}}")"
            _sstatus="${_STEP_STATUS[$_key]:-pending}"
            _sreason="$(_json_escape_str "${_STEP_REASON[$_key]:-}")"
            [ "$first" = "true" ] && first=false || echo ","
            printf '    {"id":"%s","label":"%s","status":"%s","detail":"%s"}' \
                "$_key" "$_slabel" "$_sstatus" "$_sreason"
        done
        echo ""
        echo "  ]"
        echo "}"
    } > "$tmp_file" && mv "$tmp_file" "$STEP_STATUS_FILE" 2>/dev/null || true
}

# Print full step checklist (called once at run start, after skip detection)
print_step_checklist() {
    echo ""
    echo -e "${MAGENTA}━━━ Pipeline Step Checklist ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    printf "  %-6s %-32s %s\n" "Step" "Name" "Planned"
    printf "  %-6s %-32s %s\n" "------" "--------------------------------" "--------"

    _checklist_row() {
        local step="$1" name="$2" planned="$3" reason="${4:-}"
        local color
        case "$planned" in
            ACTIVE) color="$GREEN" ;;
            SKIP)   color="$YELLOW" ;;
            COND)   color="$CYAN" ;;
            *)      color="$NC" ;;
        esac
        local reason_str=""
        [ -n "$reason" ] && reason_str=" (${reason})"
        printf "  %-6s %-32s " "$step" "$name"
        echo -e "${color}${planned}${reason_str}${NC}"
    }

    _checklist_row "1"    "Specification pass"       "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "EPAM_SPEC_MODE=0"
    _checklist_row "1a"   "  openspec (elaboration)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "${SPEC_MODE_OPENSPEC_MODEL:-z-ai/glm-5.2}"
    _checklist_row "1b"   "  speckit (verification)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "${SPEC_MODE_SPECKIT_MODEL:-z-ai/glm-5.2}"
    _checklist_row "2"  "CPA pre-pass"             "$(is_truthy "${SKIP_CPA:-}" && echo SKIP || echo ACTIVE)"           "SKIP_CPA=1"
    _checklist_row "3"  "Pre-phase skill assess"   "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "4"  "Hybrid pre-coord"         "$([ "${RESOLVED_ORCH_MODE:-bash}" = "hybrid" ] && echo ACTIVE || echo SKIP)" "ORCH_MODE≠hybrid"
    _checklist_row "5"  "Regression guard"         "$(is_truthy "${SKIP_REGRESSION_GUARD:-}" && echo SKIP || echo ACTIVE)" "SKIP_REGRESSION_GUARD=true"
    _checklist_row "6"  "mkdir src/ dirs"          "ACTIVE"
    _checklist_row "7"  "PRD model coordinator"    "$(is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}" && echo SKIP_PRD_MODEL_COORDINATOR=1 || true)"
    _checklist_row "8"    "Main-branch stories"      "ACTIVE"
    _checklist_row "9"  "Auto-commit"              "COND"  "if uncommitted changes"
    _checklist_row "10"  "TC writer gate"           "$(is_truthy "${SKIP_TC_WRITER:-}" && echo SKIP || echo COND)" "SKIP_TC_WRITER=1 or no test stories"
    _checklist_row "11" "Skills coordinator audit" "$(is_truthy "${SKIP_SKILLS_AUDIT:-}" && echo SKIP || echo ACTIVE)" "SKIP_SKILLS_AUDIT=1"
    _checklist_row "12" "Tools coordinator audit"  "$(is_truthy "${SKIP_TOOLS_AUDIT:-}" && echo SKIP || echo ACTIVE)" "SKIP_TOOLS_AUDIT=1"
    _checklist_row "13"    "Create worktrees"         "COND"  "if parallel stories exist"
    _checklist_row "14"   "Primary agent"            "COND"  "if primary stories"
    _checklist_row "15"   "Independent agent"        "COND"  "if independent stories"
    _checklist_row "16"  "Worktree health check"    "COND"  "if worktrees created"
    _checklist_row "17"  "Merge worktrees"          "COND"  "if worktrees created"
    _checklist_row "18"  "Post-parallel assessment" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP || echo ACTIVE)" "$(is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "19"  "Pre-review gate"          "$(is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && echo SKIP || echo ACTIVE)" "SKIP_PRE_REVIEW_GATE=true"
    _checklist_row "20"  "Lint gate"                "$(is_truthy "${SKIP_LINT_GATE:-}" && echo SKIP || echo ACTIVE)" "SKIP_LINT_GATE=true"
    _checklist_row "21"    "Review stories"           "COND"  "if review stories exist"
    _checklist_row "22a" "SAST sentinel"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22b" "Spec validator"           "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22c" "Review ranger"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22d" "Mutant hunter"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22e" "Fuzz-weaver"              "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "22f" "Perf sentinel"            "$(is_truthy "${SKIP_TESTING_GATES:-}" && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "23"  "Browser E2E routing"     "$([ "${SKIP_BROWSER_E2E_ROUTING:-false}" = "true" ] && echo SKIP || echo COND)" "SKIP_BROWSER_E2E_ROUTING=true"

    local skips=0
    for key in "1" "2" "3" "4" "5" "6" "7" "8" "9" "10" "11" "12" "13" "14" "15" "16" "17" "18" "19" "21" "22a" "22b" "22c" "22d" "22e" "22f" "23"; do
        [ "${_STEP_STATUS[$key]:-}" = "skip" ] && skips=$((skips + 1))
    done
    echo ""
    echo -e "  ${YELLOW}SKIP bypass env vars active: SKIP_TESTING_GATES=${SKIP_TESTING_GATES:-false}  SKIP_CPA=${SKIP_CPA:-0}  SKIP_TC_WRITER=${SKIP_TC_WRITER:-0}  SKIP_REGRESSION_GUARD=${SKIP_REGRESSION_GUARD:-false}${NC}"
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

seed_runtime_logs() {
    mkdir -p "$LOG_DIR" "$LOG_DIR/phase-improvements"
    local files=(
        "agent-activity.jsonl"
        "agent-messages.jsonl"
        "code-reviews.jsonl"
        "cpa-review.jsonl"
        "phase-cost.jsonl"
        "phase-gates.jsonl"
        "profiles-audit.jsonl"
        "testing-gates.jsonl"
    )
    local f
    for f in "${files[@]}"; do
        [ -f "$LOG_DIR/$f" ] || : > "$LOG_DIR/$f"
    done
}

# Detect the Node.js binary — checks fnm, nvm, and PATH in order.
detect_node() {
    local candidates=(
        "$HOME/.local/share/fnm/node-versions/v20.20.2/installation/bin/node"
        "$HOME/.local/share/fnm/node-versions/v20.20.0/installation/bin/node"
        "$HOME/.nvm/versions/node/v20.20.2/bin/node"
        "$HOME/.nvm/versions/node/v20.20.0/bin/node"
        "$(command -v node 2>/dev/null || true)"
    )
    local c
    for c in "${candidates[@]}"; do
        [ -n "$c" ] && [ -x "$c" ] && echo "$c" && return 0
    done
    echo ""
    return 1
}

# resolve_codeline_node <codeline_root>
# Resolves a node binary satisfying <codeline_root>/package.json's OWN
# "engines.node" declaration, installing it on demand via fnm if not already
# present. Fully data-driven — the required version comes entirely from the
# codeline's own manifest; no version number is ever hardcoded here, so this
# works for any Node version any codeline happens to declare.
#
# Live bug this closes (2026-07-22): the regression guard ran a codeline's
# vitest using detect_node()'s orchestrator-side Node (whatever fnm/nvm
# version happens to be active for THIS shell — v24.14.1 at the time), not
# the Node version the codeline itself was built/tested against
# ("engines": {"node": "^22"}). Running vitest under a mismatched major Node
# version crashed outright (SIGBUS/segfault from a native module ABI break),
# which the regression guard then reported as "tests broken" even though the
# codeline's own tests were never actually exercised.
#
# Falls back to detect_node()'s existing generic candidate search if the
# codeline declares no engines.node, fnm is unavailable, or the declared
# range can't be resolved/installed for any reason — this must never be the
# thing that blocks a run outright.
# provision_env_local_from_sample <codeline_root> <dest_.env.local_path>
#
# Some client apps throw at config-load time (e.g. a CMS SDK guard) when an
# expected env var is merely ABSENT, well before any network call is made —
# blocking local tooling (type-check/lint via a pre-commit hook) even though
# nothing here ever talks to the real service. Values only need to be
# PRESENT, never real credentials.
#
# This used to be a per-codeline block hand-written into an engine-side
# env-vars.json (added 2026-08-02, commit 359f7fa) — keys picked by trial and
# error against whatever `tsc`/lint failure was visible at the time. It
# missed MANAGEMENT_TOKEN entirely (AMSD-2041, 2026-08-05) because nothing
# ever went back to keep that hand-picked list in sync with what the
# codeline's OWN config actually reads. A codeline that already declares its
# full set of expected vars in its own `.env.local.sample` makes any
# engine-side copy of that list redundant and guaranteed to drift.
#
# So: read the codeline's own sample file and derive placeholders from ITS
# keys, not a list a human maintains here. A new var the client adds is
# picked up on the next run with zero edits to this repo. A codeline with no
# sample file gets nothing — inventing keys nobody declared would be the same
# mistake in the other direction.
provision_env_local_from_sample() {
    local codeline_root="$1" dest="$2"
    local sample="$codeline_root/.env.local.sample"
    [ -f "$sample" ] || return 0

    # Every `KEY=` line (KEY is the only part that means anything — the
    # sample's own values are just whatever placeholder or blank the client
    # left there, not credentials to reuse). One deterministic placeholder
    # per key, not a fixed table, so this needs no maintenance as the
    # codeline's own required-var set changes.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$sample" | while IFS='=' read -r key _; do
        printf '%s=sandbox-placeholder-%s\n' "$key" "$(printf '%s' "$key" | tr '[:upper:]_' '[:lower:]-')"
    done > "$dest"
}

resolve_codeline_node() {
    local codeline_root="$1"
    local pkg="$codeline_root/package.json"
    local required=""

    if [ -f "$pkg" ]; then
        required=$(node -e '
          try {
            const p = require(process.argv[1]);
            process.stdout.write((p.engines && p.engines.node) || "");
          } catch { process.stdout.write(""); }
        ' "$pkg" 2>/dev/null || true)
    fi

    if [ -z "$required" ] || ! command -v fnm &>/dev/null; then
        detect_node
        return
    fi

    # fnm install/exec want a partial semver (e.g. "22", "20.10"), not a full
    # range operator like "^22" or ">=22 <23" — extract the first version-like
    # token from whatever the codeline declares. This is a heuristic, not a
    # full semver-range resolver, but covers the common declaration shapes
    # (^N, ~N, >=N, N.x, exact N.N.N) without hardcoding any specific version.
    local fnm_version
    fnm_version=$(echo "$required" | grep -oE '[0-9]+(\.[0-9]+){0,2}' | head -1)

    if [ -z "$fnm_version" ]; then
        detect_node
        return
    fi

    fnm install "$fnm_version" >/dev/null 2>&1 || true

    local resolved_bin
    resolved_bin=$(fnm exec --using="$fnm_version" -- node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)

    if [ -n "$resolved_bin" ] && [ -x "$resolved_bin" ]; then
        echo "$resolved_bin"
        return 0
    fi

    detect_node
}

# detect_and_install_dependencies <codeline_root> <node_bin>
# Generic, manifest-driven dependency install — detects the stack from
# manifest file PRESENCE (data), never assumes npm/Node is the only stack a
# codeline could use. Same detection matrix the old setup-deps.sh had, minus
# the private-scope-strip hack it also carried (that hack was rejected as
# permanent pipeline tooling — see feedback_no_client_repo_writes_or_
# hardcoding memory; a repair needing that kind of manifest mutation stays a
# manual, case-by-case decision, e.g. the azure.commerce.cdts cx-shared
# incident, 2026-07-22).
#
# Each handler is independent and non-fatal on its own failure — this
# mirrors run_dependency_check's own philosophy (a bad handler shouldn't
# block every other stack's install). Returns 0 if at least one recognized
# manifest was found and its handler didn't hard-fail; 1 if no manifest was
# recognized, or the one that WAS found failed outright.
detect_and_install_dependencies() {
    local codeline_root="$1"
    local node_bin="$2"
    local ran_any=0
    local ok=1

    if [ -f "$codeline_root/package.json" ]; then
        ran_any=1
        local npm_bin
        npm_bin="$(dirname "$node_bin")/npm"
        if [ ! -x "$npm_bin" ]; then
            warning "  [deps-install] npm not found alongside $node_bin"
            ok=0
        else
            # WHICH package manager is the PROJECT's answer. Its `packageManager`
            # field first (the standard corepack declaration), then the lockfile
            # it committed. Read, never assumed.
            local pm_name=""
            pm_name="$("$node_bin" -e '
              try {
                const p = JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8"));
                process.stdout.write(String(p.packageManager || "").split("@")[0]);
              } catch (e) { /* no declaration */ }
            ' "$codeline_root" 2>/dev/null)"
            if [ -z "$pm_name" ]; then
                [ -f "$codeline_root/pnpm-lock.yaml" ] && pm_name="pnpm"
                [ -z "$pm_name" ] && [ -f "$codeline_root/yarn.lock" ] && pm_name="yarn"
            fi

            local pm_bin="$npm_bin"
            if [ -n "$pm_name" ] && [ "$pm_name" != "npm" ] && command -v "$pm_name" &>/dev/null; then
                pm_bin="$(command -v "$pm_name")"
            fi

            # DESTRUCTIVE OR NOT is OUR policy, and the default is: never.
            #
            # This used to select `ci` whenever a lockfile existed. `npm ci`
            # DELETES node_modules before installing, so on 2026-07-28 a repair
            # wiped a working 1,530-package install, hit a 401 on a private
            # dependency, aborted, and left the codeline with an EMPTY
            # node_modules — strictly worse than it found it. The warning below
            # already said "often a private-registry auth wall": the failure was
            # anticipated and the destructive command ran first anyway.
            #
            # We did not create these repositories and cannot restore what we
            # remove. A caller that owns its tree can opt in.
            local pm_cmd="install"
            [ "${DEPS_CLEAN_INSTALL:-0}" = "1" ] && [ -f "$codeline_root/package-lock.json" ] && pm_cmd="ci"

            # What was there before, so the repair can be judged rather than
            # trusted. A repair that reduces the tree must not be handed on as a
            # working install.
            local _deps_before=0
            [ -d "$codeline_root/node_modules" ] && _deps_before=$(find "$codeline_root/node_modules" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)

            local repair_log; repair_log=$(mktemp)
            if [ "$pm_bin" = "$npm_bin" ]; then
                (cd "$codeline_root" && "$node_bin" "$npm_bin" "$pm_cmd" --no-audit --no-fund) > "$repair_log" 2>&1
            else
                (cd "$codeline_root" && "$pm_bin" "$pm_cmd") > "$repair_log" 2>&1
            fi
            local _install_rc=$?
            local _deps_after=0
            [ -d "$codeline_root/node_modules" ] && _deps_after=$(find "$codeline_root/node_modules" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)

            if [ "$_install_rc" -eq 0 ]; then
                success "  [deps-install] install ($pm_cmd via $(basename "$pm_bin")) succeeded in $codeline_root"
            else
                warning "  [deps-install] install FAILED in $codeline_root — tail below (often a private-registry auth wall):"
                tail -10 "$repair_log" >&2
                ok=0
            fi

            # Did the repair leave LESS than it found? Silence here is how a
            # working codeline became an empty one and the next gate was handed
            # the wreckage as if it were a tree.
            if [ "$_deps_after" -lt "$_deps_before" ]; then
                error "  [deps-install] REPAIR DESTROYED WHAT IT FOUND in $codeline_root: $_deps_before entries -> $_deps_after"
                error "    The codeline is now in a worse state than before this ran, and its gates cannot run."
                error "    Reinstall its dependencies before relying on any result from this run."
                ok=0
            fi
            rm -f "$repair_log"
        fi
    fi

    if [ -f "$codeline_root/Pipfile" ] && command -v pipenv &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && pipenv install --dev --quiet) 2>&1 || { warning "  [deps-install] pipenv install failed in $codeline_root"; ok=0; }
    elif { [ -f "$codeline_root/requirements.txt" ] || [ -f "$codeline_root/pyproject.toml" ]; } \
         && { command -v pip3 &>/dev/null || command -v pip &>/dev/null; }; then
        ran_any=1
        local pip_bin; pip_bin=$(command -v pip3 || command -v pip)
        if [ -f "$codeline_root/requirements.txt" ]; then
            (cd "$codeline_root" && "$pip_bin" install --quiet -r requirements.txt) 2>&1 \
              || { warning "  [deps-install] pip install failed in $codeline_root"; ok=0; }
        else
            (cd "$codeline_root" && "$pip_bin" install --quiet -e .) 2>&1 \
              || { warning "  [deps-install] pip install (pyproject) failed in $codeline_root"; ok=0; }
        fi
    fi

    if [ -f "$codeline_root/Cargo.toml" ] && command -v cargo &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && cargo fetch --quiet) 2>&1 || { warning "  [deps-install] cargo fetch failed in $codeline_root"; ok=0; }
    fi

    if [ -f "$codeline_root/go.mod" ] && command -v go &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && go mod download) 2>&1 || { warning "  [deps-install] go mod download failed in $codeline_root"; ok=0; }
    fi

    if [ -f "$codeline_root/pom.xml" ] && command -v mvn &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && mvn -q dependency:resolve) 2>&1 || { warning "  [deps-install] mvn dependency:resolve failed in $codeline_root"; ok=0; }
    fi

    if { [ -f "$codeline_root/build.gradle" ] || [ -f "$codeline_root/build.gradle.kts" ]; } && command -v gradle &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && ./gradlew dependencies --quiet) 2>&1 || { warning "  [deps-install] gradle dependencies failed in $codeline_root"; ok=0; }
    fi

    if [ -f "$codeline_root/Gemfile" ] && command -v bundle &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && bundle install --quiet) 2>&1 || { warning "  [deps-install] bundle install failed in $codeline_root"; ok=0; }
    fi

    if [ -f "$codeline_root/composer.json" ] && command -v composer &>/dev/null; then
        ran_any=1
        (cd "$codeline_root" && composer install --quiet --no-interaction) 2>&1 || { warning "  [deps-install] composer install failed in $codeline_root"; ok=0; }
    fi

    if [ "$ran_any" -eq 0 ]; then
        warning "  [deps-install] no recognized manifest found in $codeline_root — nothing to install"
        return 1
    fi
    [ "$ok" -eq 1 ]
}

# ensure_node_modules_healthy <codeline_root> <node_bin> <test_bin>
# Detects a missing or CORRUPTED dependency install (not just "missing") and
# repairs it via detect_and_install_dependencies() — never by editing any
# manifest file, which stays purely a manual, case-by-case decision (see the
# azure.commerce.cdts cx-shared incident, 2026-07-22 — that repair required
# temporarily stripping a private-registry dependency and was done as an
# explicit, user-approved one-off, not baked into automated tooling).
#
# Live bug this closes: a prior interrupted/killed install left node_modules
# with truncated native binaries (esbuild, rollup) — present on disk, correct
# file names, but silently corrupted. A plain "does node_modules exist" check
# would have missed this entirely; the failure only surfaced when vitest
# actually tried to load them and crashed outright (SIGBUS/segfault) instead
# of a normal test failure. This function directly smoke-tests the SAME
# binary the regression guard is about to invoke ("<test_bin> --version"),
# which is the cheapest, most direct way to know whether it will actually
# work — no need to guess at which native files might be corrupted, or fetch
# reference file sizes from a registry.
#
# Returns 0 (healthy or successfully repaired) or 1 (still broken after a
# genuine repair attempt — e.g. a private-registry auth wall with no
# credentials available). Never silent: logs what it found and did either way.
ensure_node_modules_healthy() {
    local codeline_root="$1"
    local node_bin="$2"
    local test_bin="$3"   # legacy: an arbitrary .bin entry, no longer trusted

    # Probe the runner the PROJECT DECLARES, not whatever sorts first in
    # node_modules/.bin. Live metrolinx 2026-07-29: the old probe picked
    # `escodegen` (alphabetically first), ran `node escodegen --version`, got
    # "Invalid option '--version'" — and condemned three codelines whose trees
    # were fine (`jest --version` -> 29.5.0 on the same tree). It had always
    # behaved this way; the caller's `|| true` hid it until that mask came off
    # and every lane stopped.
    local _declared _runner
    _declared="$(jq -r '.scripts.test // ""' "$codeline_root/package.json" 2>/dev/null || echo "")"
    # First word of the declared command is the runner: "jest --ci" -> jest.
    # Derived from what the project says, so an unknown stack needs no changes.
    _runner="${_declared%% *}"

    if [ -z "$_runner" ]; then
        # INCONCLUSIVE, not broken. We cannot identify a runner, so we cannot
        # claim the tree is unusable — and halting on "cannot tell" is the
        # escodegen bug with a different trigger. Step 5 runs the project's real
        # test command next, which is the actual question anyway.
        warning "  [node-modules-health] could not determine health: $codeline_root declares no test script — deferring to the real test command"
        return 0
    fi

    local _runner_bin="$codeline_root/node_modules/.bin/$_runner"
    if [ -x "$_runner_bin" ]; then
        if "$node_bin" "$_runner_bin" --version >/dev/null 2>&1; then
            return 0
        fi
        warning "  [node-modules-health] declared runner '$_runner' exists but failed --version — dependencies present but corrupted, attempting repair..."
    else
        warning "  [node-modules-health] declared runner '$_runner' not found in $codeline_root/node_modules/.bin — attempting install..."
    fi

    detect_and_install_dependencies "$codeline_root" "$node_bin"
}


resolve_prompt_provider() {
    if [ -n "${EPAM_ORCHESTRATION_PROVIDER:-}" ]; then
        echo "$EPAM_ORCHESTRATION_PROVIDER"
        return
    fi
    case "$(basename "$CLAUDE_CMD")" in
        codex|openai|qwen|cursor|copilot|codemie-claude) echo "$(basename "$CLAUDE_CMD")" ;;
        *) echo "claude" ;;
    esac
}

# GAP-P22: emit a cost record for a pipeline agent invocation.
# Args: agent_type, story_id, model, started_at, cost_usd, tokens_in, tokens_out, turns
# _spec_pass_usage <phase_id>
# Prints "<cost> <tokens_in> <tokens_out> <turns>" for the spec runner's own
# LLM calls in this phase.
#
# spec-mode-runner wires emitCostSnapshot through runClaude — the funnel for the
# detective, openspec, speckit, the spec coordinator, the VC reviewer and the
# PRD change reviewer — so every one of those calls already lands in
# agent-activity.jsonl tagged source="spec-mode-runner". The spec-pass row in
# phase-cost.jsonl was nevertheless written with literal zeros, so the ledger
# every reader sums (dashboard, run report, validate-dashboards.sh) understated
# the run by $0.1077 on gotransit (22%) and $0.0755 on upexpress, measured
# 2026-07-30. Cost tracking that silently reports zero is worse than none: a
# reader cannot tell "free" from "unmeasured".
#
# Filtered on source, NOT on agent name: typescript-engineer and team-lead-agent
# write their own phase-cost rows, so summing them here would double-count the
# run. Overstating is no more true than understating.
#
# Fails soft to zeros — a cost record must never be the thing that breaks a run.
_spec_pass_usage() {
    local _phase="${1:-}"
    local _act="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}"
    if [ ! -f "$_act" ]; then printf '0 0 0 0\n'; return 0; fi
    # -R (raw) + fromjson? so ONE malformed line cannot void the whole file.
    # Lanes append concurrently, so a torn write is realistic; jq -s would abort
    # on it and silently report zero — the exact failure this function exists to
    # end.
    jq -rRs --arg ph "$_phase" '
        [ (split("\n") | .[] | select(length > 0) | fromjson? // empty)
          | select(type == "object")
          | select(.type == "cost_snapshot")
          | select((.detail.source // "") == "spec-mode-runner")
          | select(($ph == "") or ((.phase // "") == $ph))
          | .detail ]
        | [ (map(.costUsd // 0) | add // 0),
            (map(.tokensIn  // 0) | add // 0),
            (map(.tokensOut // 0) | add // 0),
            (map(.turns     // 0) | add // 0) ]
        | @tsv' "$_act" 2>/dev/null | tr '\t' ' ' || printf '0 0 0 0\n'
}

append_pipeline_cost_record() {
    local agent_type="${1:-pipeline}" story_id="${2:-pipeline}"
    local model="${3:-}" started_at="${4:-}" ended_at
    ended_at=$(date -Iseconds)
    local cost="${5:-0}" tokens_in="${6:-0}" tokens_out="${7:-0}" turns="${8:-0}"
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"
    local phase_id="${CURRENT_PHASE:-${PHASE:-unknown}}"
    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg pid  "$phase_id" \
            --arg sid  "$story_id" \
            --arg at   "$agent_type" \
            --arg rm   "$model" \
            --arg sa   "$started_at" \
            --arg ea   "$ended_at" \
            --argjson cu  "${cost:-0}" \
            --argjson ti  "${tokens_in:-0}" \
            --argjson to  "${tokens_out:-0}" \
            --argjson tt  "${turns:-0}" \
            '{phase_id:$pid, story_id:$sid, agent_type:$at, resolvedModel:$rm,
              started_at:$sa, ended_at:$ea, task_cost_usd:$cu,
              task_tokens_in:$ti, task_tokens_out:$to, task_turns:$tt,
              status:"completed", invokeMode:"cli"}' >> "$cost_file"
    ) 200>"$lock_file"
}

# record_story_actual_cost, check_cost_budget, wait_if_paused,
# apply_redirect_if_any, validate_mid_execution_splits, story_tsc_gate — now
# defined once in lib/story-guards.sh (sourced above) so every lane (main
# and worktree) runs the identical guard. See that file's docstring.

# _emit_agent <start|complete|fail> <role> [message]
# Thin wrapper so QA/system agents appear in agent-activity.jsonl.
# story_id is intentionally left empty (these are pipeline-level agents, not
# bound to a specific story) so the agent badge and story badge don't repeat.
_emit_agent() {
    local _action="$1" _role="$2" _msg="${3:-}"
    local _gate_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
    local _gate_provider="${ORCH_GATE_PROVIDER:-}"
    case "$_action" in
        # story_start: <story_id> <lane> <role> [title] [provider] [model]
        start)    "$SCRIPT_DIR/update-monitor.sh" story_start    "" "main" "$_role" "$_msg" "${_gate_provider}" "${_gate_model}" 2>/dev/null || true ;;
        complete) "$SCRIPT_DIR/update-monitor.sh" story_complete "" "main" "$_msg"                                               2>/dev/null || true ;;
        fail)     "$SCRIPT_DIR/update-monitor.sh" story_fail     "" "main" "$_msg"                                               2>/dev/null || true ;;
    esac
}

# run_orch_prompt <prompt> [agent_type] [story_id]
# Runs a pipeline agent prompt, tracks cost to phase-cost.jsonl (GAP-P22),
# and returns the text output.
run_orch_prompt() {
    # Bound the LOOP, not only the clock. Without this a gate agent — especially
    # one with tools, as the phase assessment has — can explore indefinitely and is
    # only stopped by its timeout. Live 2026-07-25 that produced a ZERO-BYTE log
    # killed at 120s, then again at 300s after the timeout was raised: a stall, not
    # slowness, and raising the clock merely spent longer failing.
    #
    # An iteration cap fails fast and deterministically. Generous by default so QA
    # gates that legitimately read source files are not strangled; override per
    # site where a gate genuinely needs more.
    local EPAM_MAX_ITERATIONS="${ORCH_GATE_MAX_ITERATIONS:-25}"
    export EPAM_MAX_ITERATIONS
    local prompt_text="$1"
    local agent_type="${2:-pipeline}"
    local story_id="${3:-pipeline}"
    local provider_hint
    provider_hint="$(resolve_prompt_provider)"
    # ORCH_GATE_PROVIDER overrides the story-agent provider for coordinator/gate calls.
    # Set to "openai" to use GPT-4o as coordinator while qwen handles story agents.
    local gate_provider="${ORCH_GATE_PROVIDER:-$provider_hint}"

    if [ ! -x "$AI_RUNNER_CMD" ]; then
        error "ai runner not executable: $AI_RUNNER_CMD"
        return 1
    fi

    local gate_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
    local model_args=()
    [ -n "$gate_model" ] && model_args=(--model "$gate_model")

    local started_at
    started_at=$(date -Iseconds)
    local json_result_file
    json_result_file=$(mktemp /tmp/orch-prompt-XXXXXX.json)

    # Run with JSON output so we can capture cost/token data.
    # Hard timeout guards against API hangs that block indefinitely (observed
    # live: spec-validator stalled 55 min with zero output on two consecutive
    # runs). EPAM_GATE_TIMEOUT_SECS defaults to 600 (10 min) — enough for any
    # real gate response; exit 124 from timeout is treated as a failure.
    local _gate_timeout="${EPAM_GATE_TIMEOUT_SECS:-600}"
    local _rc=0
    echo "$prompt_text" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        CLAUDE_CMD="$CLAUDE_CMD" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        ORCH_JSON_RESULT="$json_result_file" \
        timeout "${_gate_timeout}" \
        "$AI_RUNNER_CMD" --provider "$gate_provider" "${model_args[@]}" || _rc=$?
    if [ "$_rc" -eq 124 ]; then
        warning "run_orch_prompt: gate agent timed out after ${_gate_timeout}s (${agent_type}/${story_id}) — treating as failure"
    fi

    # Extract cost/token data and emit pipeline cost record
    if [ -f "$json_result_file" ] && [ -s "$json_result_file" ]; then
        local cost tokens_in tokens_out turns
        cost=$(jq -r '.cost_usd // .total_cost_usd // 0'                    "$json_result_file" 2>/dev/null || echo "0")
        tokens_in=$(jq -r '.usage.inputTokens // .usage.input_tokens // 0'  "$json_result_file" 2>/dev/null || echo "0")
        tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo "0")
        turns=$(jq -r '.iterations // .num_turns // 1'                       "$json_result_file" 2>/dev/null || echo "1")
        # Compute cost from pricing table if provider returned 0
        if [ "${cost:-0}" = "0" ] && { [ "${tokens_in:-0}" -gt 0 ] || [ "${tokens_out:-0}" -gt 0 ]; }; then
            local _pricing_file="$SCRIPT_DIR/model-pricing.json"
            if [ -f "$_pricing_file" ]; then
                cost=$(python3 - "$_pricing_file" "${gate_model:-}" "${tokens_in:-0}" "${tokens_out:-0}" <<'PYEOF'
import sys, json
pricing_file, model, tin, tout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(pricing_file) as f:
        table = json.load(f)
    prices = table.get(model)
    if not prices:
        for k, v in table.items():
            if model.startswith(k) or k.startswith(model):
                prices = v
                break
    if prices:
        print("{:.6f}".format((tin * prices["input"] + tout * prices["output"]) / 1_000_000))
    else:
        print("0")
except Exception:
    print("0")
PYEOF
2>/dev/null || echo "0")
            fi
        fi
        append_pipeline_cost_record \
            "$agent_type" "$story_id" "$gate_model" "$started_at" \
            "${cost:-0}" "${tokens_in:-0}" "${tokens_out:-0}" "${turns:-1}"
        # Emit cost_snapshot so agent-activity dashboard shows tokens + cost per gate call
        local _phase_id
        _phase_id=$(jq -r '.phase // empty' "${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}" 2>/dev/null || true)
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg agent "$agent_type" \
            --arg story "${story_id:-}" \
            --arg phase "${_phase_id:-}" \
            --arg model "$gate_model" \
            --arg provider "$gate_provider" \
            --argjson cost "${cost:-0}" \
            --argjson tin "${tokens_in:-0}" \
            --argjson tout "${tokens_out:-0}" \
            --argjson turns "${turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))) ,
              timestamp: $ts,
              agent: $agent,
              story_id: (if $story == "" then null else $story end),
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: $model,
              provider: $provider,
              detail: {
                costUsd: $cost,
                tokensIn: $tin,
                tokensOut: $tout,
                turns: $turns,
                source: "run_orch_prompt"
              }
            }' >> "${ACTIVITY_FILE:-$SCRIPT_DIR/../logs/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$json_result_file"
    fi

    return $_rc
}

# run_orch_prompt_with_tools <prompt> [agent_type] [story_id]
# Identical to run_orch_prompt but enables ReadFile + Bash tool access for the agent.
# Required for QA gate agents that must read source files to ground their analysis:
# sast-sentinel, spec-validator, review-ranger, mutant-hunter, fuzz-weaver, perf-sentinel.
# Without tool access these agents hallucinate findings about files they cannot verify.
# STRUCTURAL, not prompt-level: the allowlist means write_file is never handed to
# the model, so "answering" by writing a file becomes unreachable. Live metrolinx
# 2026-07-26 — perf-sentinel's ENTIRE log was "The file has been written
# successfully.", both attempts exhausted, ~20 minutes spent reviewing nothing;
# fuzz-weaver produced a 0-byte log in the same run. Two of six quality gates
# passed the phase having examined nothing.
#
# This was already diagnosed and structurally fixed for the code-graph-detective
# on 2026-07-23, and src/tools/createTools.ts names "the source-reading QA gates"
# as intended beneficiaries — the wiring here was simply never done. In its place
# the pipeline grew two work-arounds for the symptom (a retry that detects "has
# been written" and prepends a corrective paragraph, and a recovery pass that
# hunts the project for the file the model wrote). Prompt instructions could not
# prevent it; removing the capability does. Those work-arounds stay as a
# backstop for any model that finds another way to avoid answering.
# Derived, not literal. The base built-in read-only set PLUS whatever plugins this project
# registered for the codeline — a project that adds a plugin gets it at the gates without
# editing this script. The literal here filtered every project plugin tool out before the
# model ever saw it, while the project had explicitly registered them.
# shellcheck source=lib/gate-tools.sh
. "${SCRIPT_DIR}/lib/gate-tools.sh" 2>/dev/null || true
if [ -z "${ORCH_GATE_ALLOWED_TOOLS:-}" ] && command -v gate_allowed_tools >/dev/null 2>&1; then
    ORCH_GATE_ALLOWED_TOOLS="$(gate_allowed_tools "${JIRA_CODELINE_ROOT:-${PROJECT_ROOT:-$PWD}}")"
fi
ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-bash,read_file,list_files,search}"
export ORCH_GATE_ALLOWED_TOOLS

# _brownfield_gate_scope <gate-name>
# The brownfield addendum every QA gate prompt gets. Empty on greenfield, whose
# flow is deliberately unchanged.
#
# These gates were designed for a freshly-scaffolded application. On a brownfield
# bugfix they are pointed at 850+ existing files and a three-line change, and it
# shows: on 2026-07-26 only TWO of six gates mentioned the code the run actually
# changed. sast spent its budget on 70 pre-existing dependency CVEs; review-ranger
# returned a 211-byte "pass" without naming the diff; perf-sentinel was handed
# browser E2E routing context for a backend string comparison and returned 40
# bytes; fuzz-weaver returned nothing.
#
# Two corrections: judge THIS CHANGE, and be allowed to say the change is not
# your business. Silence is indistinguishable from failure, and a fabricated
# "pass" is worse than both — so `not_applicable` is a first-class verdict with
# a required reason.
_brownfield_gate_scope() {
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate="${1:-this gate}"
    local _files=""
    if [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ]; then
        # shellcheck disable=SC1090
        . "$SCRIPT_DIR/lib/story-outputs.sh" 2>/dev/null || true
        _files=$(story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | head -20)
    fi
    cat <<BROWNFIELD_SCOPE

## BROWNFIELD — judge THIS CHANGE, not the codebase
This is an existing production repository. It contains problems that predate this
run and are none of this run's business. You are reviewing one small change to it.

Files this run produced or modified:
${_files:-  (none recorded — fall back to the injected diff)}

RULES:
1. Findings MUST be about the lines this run changed. A pre-existing issue in an
   untouched file, or on an untouched line of a touched file, is NOT a finding
   here — reporting it blocks a correct change over somebody else's problem.
2. If ${_gate} has nothing meaningful to say about a change of this kind, return
   verdict "not_applicable" with a one-line reason. That is a valid, useful
   answer. Do NOT invent a finding to look thorough, and do NOT return "pass" to
   mean "I could not evaluate this".
3. Prefer fewer, real findings over broad coverage.
BROWNFIELD_SCOPE
}

run_orch_prompt_with_tools() {
    AI_GATE_ALLOW_TOOLS=1 EPAM_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS}" run_orch_prompt "$@"
}

# _run_qa_gate_with_retry <prompt> <agent> <phase> <log_file>
# Wraps run_orch_prompt_with_tools with up to QA_GATE_MAX_RETRIES (default 2) attempts.
# Retry 2: prepends corrective note + escalates to ESCALATION_MODEL_HIGH when set.
# Returns 0 when the log contains structured JSON output; 1 when all attempts fail.
# _lint_fix_findings_directly <lint_log> <phase>
# Repair the flagged lines. Do not rebuild the story around them.
#
# Live metrolinx 2026-07-26, run 7: a correct fix, a test proven RED→GREEN by
# execution and an approved review were all discarded-in-waiting because
# `'line-item-1'` appeared four times in the test's fixture data
# (sonarjs/no-duplicate-string). The only remediation available was to add
# acceptance criteria, exit 2, reset the codeline and rebuild the entire phase —
# ~20 minutes and ~$1 — and nothing in that loop actually fixes the literal, so
# the rebuild can land in exactly the same place.
#
# Nothing here knows any rule names. Whatever the PROJECT'S eslint config
# flagged is what gets repaired; an engine carrying a list of "rules we can fix"
# would rot the moment the project changed its config.
#
# The danger this must not create is worse than the one it solves: an agent
# editing a test could "fix" the finding by weakening the test — and that test is
# the run's only executable proof. So every edit is verified (lint clean, types
# compile, tests still pass) and reverted on any failure, leaving the pipeline
# exactly where it was.
_lint_fix_findings_directly() {
    local _lf_log="$1" _lf_phase="${2:-core}"
    [ "${LINT_FIX_DIRECT_ENABLED:-1}" = "1" ] || return 1
    [ -f "$_lf_log" ] || return 1

    # Findings as the gate reported them: "path:line:col  rule  message".
    local _lf_findings
    _lf_findings=$(grep -oE '^[^ ]+\.[A-Za-z]+:[0-9]+:[0-9]+ +[^ ]+ +.*' "$_lf_log" 2>/dev/null | head -25)
    [ -n "$_lf_findings" ] || return 1

    # Scope: ONLY the files the gate flagged. Nothing else is touched.
    local _lf_files
    _lf_files=$(printf '%s\n' "$_lf_findings" | awk -F: '{print $1}' | sort -u)
    [ -n "$_lf_files" ] || return 1

    # Snapshot, so a bad repair can be undone completely.
    local _lf_stash="$LOG_DIR/lint-fix-${_lf_phase}.snapshot"
    rm -rf "$_lf_stash" 2>/dev/null; mkdir -p "$_lf_stash" 2>/dev/null || return 1
    local _f
    while IFS= read -r _f; do
        [ -f "$PROJECT_ROOT/$_f" ] || continue
        mkdir -p "$_lf_stash/$(dirname "$_f")" 2>/dev/null
        cp "$PROJECT_ROOT/$_f" "$_lf_stash/$_f" 2>/dev/null || true
    done <<< "$_lf_files"

    local _lf_attempt=0 _lf_max="${LINT_FIX_MAX_ATTEMPTS:-2}"
    while [ "$_lf_attempt" -lt "$_lf_max" ]; do
        _lf_attempt=$(( _lf_attempt + 1 ))
        info "  [lint-fix] repairing ${_lf_findings_count:-$(printf '%s\n' "$_lf_findings" | wc -l | tr -d ' ')} finding(s) in place (attempt ${_lf_attempt}/${_lf_max})"

        local _lf_prompt="You are fixing code-style findings a linter reported on files THIS RUN just wrote.

## Findings to fix (and nothing else)
${_lf_findings}

## Rules
1. Fix ONLY these findings, ONLY in these files. Do not refactor anything else.
2. Do NOT weaken any test. Assertions, expected values and the scenario under
   test must be preserved EXACTLY — a test here is the only executable proof the
   bug is fixed, and a test that no longer proves it is far worse than a lint
   warning. Extracting a repeated literal into a constant is fine; changing what
   is asserted is not.
3. Keep the change minimal and idiomatic for this repository.
4. Edit the files in place with your write tool. Do not create new files.

Files: ${_lf_files}
Project root: ${PROJECT_ROOT}"

        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="${LINT_FIX_ALLOWED_TOOLS:-bash,read_file,write_file,list_files,search}" \
        EPAM_AGENT_NAME="lint-fixer" EPAM_STORY_ID="${_lf_phase}" \
            run_orch_prompt "$_lf_prompt" "lint-fixer" "$_lf_phase" \
            > "$LOG_DIR/lint-fix-${_lf_phase}.log" 2>&1 || true

        # ── VERIFY. The agent's claim is not evidence. ────────────────────────
        local _lf_ok=1

        # 1. the finding is actually gone
        local _lf_relint=0
        eslint_baseline_gate "$PROJECT_ROOT" "$_eslint_bin" "$LOG_DIR" \
            "$LOG_DIR/lint-recheck-${_lf_phase}.log" || _lf_relint=$?
        [ "$_lf_relint" -eq 0 ] || _lf_ok=0

        # 2. it still compiles
        if [ "$_lf_ok" = "1" ] && [ -n "${_node_bin:-}" ]; then
            ( cd "$PROJECT_ROOT" && "$_node_bin" ./node_modules/.bin/tsc --noEmit ) \
                >/dev/null 2>&1 || _lf_ok=0
        fi

        # 3. the tests still pass — a repair must never weaken the proof
        if [ "$_lf_ok" = "1" ] && [ -n "${_node_bin:-}" ] && [ -x "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
            ( cd "$PROJECT_ROOT" && timeout 600 "$_node_bin" ./node_modules/.bin/vitest run ) \
                >/dev/null 2>&1 || _lf_ok=0
        fi

        if [ "$_lf_ok" = "1" ]; then
            success "  [lint-fix] findings repaired in place — lint clean, types compile, tests still pass"
            rm -rf "$_lf_stash" 2>/dev/null || true
            return 0
        fi

        warning "  [lint-fix] repair rejected by verification (attempt ${_lf_attempt}/${_lf_max}) — revert the files to their pre-repair state"
        while IFS= read -r _f; do
            [ -f "$_lf_stash/$_f" ] && cp "$_lf_stash/$_f" "$PROJECT_ROOT/$_f" 2>/dev/null || true
        done <<< "$_lf_files"
    done

    rm -rf "$_lf_stash" 2>/dev/null || true
    warning "  [lint-fix] could not repair in place — falling through to gate remediation"
    return 1
}

_run_qa_gate_with_retry() {
    local _qg_prompt="$1" _qg_agent="$2" _qg_phase="$3" _qg_log="$4"
    local _qg_max="${QA_GATE_MAX_RETRIES:-2}"
    local _qg_attempt=0
    local _saved_gate_model="${ORCH_GATE_MODEL:-}"
    # Derive short agent slug for file-recovery search (strip "qa-gate:" prefix)
    local _qg_slug="${_qg_agent#qa-gate:}"
    while [ "$_qg_attempt" -lt "$_qg_max" ]; do
        rm -f "$_qg_log"
        local _qg_eff_prompt="$_qg_prompt"
        if [ "$_qg_attempt" -ge 1 ]; then
            [ -n "${ESCALATION_MODEL_HIGH:-}" ] && ORCH_GATE_MODEL="${ESCALATION_MODEL_HIGH}"
            local _qg_retry_prefix
            if echo "$_qg_prompt" | grep -q "Do NOT attempt to call any shell commands"; then
                _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): The previous invocation produced no structured output. Re-analyze the pre-injected evidence already present in this prompt and emit your JSON verdict now. Do NOT call any tools. Do NOT use WriteFile — output your JSON as plain text in this message."
            else
                # Detect WriteFile-instead-of-stdout failure: log is tiny and contains
                # the tool confirmation phrase but no JSON fields.
                local _qg_log_size=0
                [ -f "$_qg_log" ] && _qg_log_size=$(wc -c < "$_qg_log" 2>/dev/null || echo 0)
                if [ "${_qg_log_size:-0}" -lt 200 ] && grep -q "has been written" "$_qg_log" 2>/dev/null; then
                    _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): CRITICAL — your previous response used WriteFile to write your output to a file. That file was NOT read by the pipeline. You MUST emit your JSON verdict as plain text in this message — do NOT use WriteFile, do NOT write to any file. Use ReadFile to read source files, then emit your findings directly here."
                else
                    _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): Your previous answer was REJECTED because it ${_qg_schema_reason:-timed out or produced no structured output}. Use ReadFile and Bash tools to read the relevant source files now, then emit your JSON findings directly in your response — do NOT use WriteFile."
                fi
            fi
            _qg_eff_prompt="$_qg_retry_prefix

$_qg_prompt"
        fi
        # SELF-HEAL (brownfield only — greenfield flow deliberately unchanged).
        #
        # Every gate already had retry + ladder escalation, and none had this.
        # Live 2026-07-26: perf-sentinel failed IDENTICALLY twice — both attempts
        # returned only "The file has been written successfully." — because
        # nothing diagnosed attempt 1, so attempt 2 differed only by model.
        # fuzz-weaver produced a 0-byte log in the same run. Two of six quality
        # gates reviewed nothing and the phase still passed.
        #
        # The repro-test-writer hit the same failure class that day and RECOVERED
        # on attempt 2, because its failure was recorded as an episode, diagnosed
        # and compiled into an enforced constraint. That machinery is proven; the
        # gates simply never called it.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_qg_attempt" -ge 1 ] \
           && [ -f "$SCRIPT_DIR/lib/kb-apply.sh" ]; then
            # shellcheck disable=SC1090
            . "$SCRIPT_DIR/lib/kb-apply.sh" || true
            # "produced no output" carries no error string to key on, so give the
            # episode an explicit class — otherwise it can never be looked up,
            # which is exactly why the write-tool failure was never learned from.
            local _qg_class="no_structured_output"
            if [ -f "$_qg_log" ] && grep -q "has been written" "$_qg_log" 2>/dev/null; then
                _qg_class="answered_via_write_tool"
            fi
            head -c 8000 "$_qg_log" 2>/dev/null | \
                FAILURE_CLASS="$_qg_class" \
                kb_record_episode "${_qg_phase:-}" "$_qg_slug" "gate produced no verdict" "$_qg_class" || true
            kb_apply_constraints "$_qg_slug" "story:${_qg_phase:-}" || true
        fi

        # Same allowlist as run_orch_prompt_with_tools: this path calls
        # run_orch_prompt directly, so wiring only the helper would leave every
        # actual gate invocation unrestricted.
        # EPAM_AGENT_NAME/STORY_ID name the Langfuse trace. Without them every
        # trace in a run renders as `llm-stream (uuid)` with no agent and no
        # prompt — 35 identical unreadable rows, which is how a hung call went
        # unnoticed behind a generic "timed out" message.
        AI_GATE_ALLOW_TOOLS=1 EPAM_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS}" \
            EPAM_AGENT_NAME="$_qg_agent" EPAM_STORY_ID="${_qg_phase:-}" \
            run_orch_prompt "$_qg_eff_prompt" "$_qg_agent" "$_qg_phase" 2>&1 | tee "$_qg_log"
        # VALIDATE the verdict rather than grepping for the word.
        #
        # This was `grep -qE '"(verdict|findings|agent|summary)"'`, so any text
        # containing the word "verdict" counted as a completed review — a
        # truncated report, a fragment of reasoning, a verdict of "maybe".
        # Live 2026-07-26: two gates "reviewed" a change while emitting 40 bytes
        # of write-tool echo between them.
        #
        # Validated AFTER the call, not via provider-level strict json_schema:
        # these gates need tools to read source and strict schema suppresses
        # tool calling (SCHEMA-1). The reason is fed back into the retry so
        # attempt 2 is told what was wrong instead of just getting a bigger model.
        _qg_schema_reason=""
        if [ -f "$SCRIPT_DIR/lib/gate_verdict_schema.py" ]; then
            _qg_schema_reason=$(python3 "$SCRIPT_DIR/lib/gate_verdict_schema.py" \
                                  "$_qg_agent" "$_qg_log" 2>/dev/null) || true
        fi
        if [ -z "$_qg_schema_reason" ] \
           && grep -qE '"(verdict|findings|agent|summary)"' "$_qg_log" 2>/dev/null; then
            ORCH_GATE_MODEL="$_saved_gate_model"
            return 0
        fi
        [ -n "$_qg_schema_reason" ] && \
            warning "  [qa-gate] ${_qg_agent}: rejected — ${_qg_schema_reason}"
        # ── WriteFile recovery: model wrote JSON to a file instead of emitting it ──
        # Search project root for a recently-written JSON file containing this
        # gate's structured output. If found, append its content to the log so
        # the normal grep check picks it up on the next iteration OR after the loop.
        local _qg_recovered=""
        _qg_recovered=$(find "${OUTPUT_DIR:-${PROJECT_ROOT:-$PWD}}" \
            -maxdepth 4 -name "*.json" -newer "$_qg_log" \
            2>/dev/null | \
            xargs grep -l "\"${_qg_slug}\"\|\"verdict\"\|\"summary\"" 2>/dev/null | \
            head -1 || true)
        if [ -z "$_qg_recovered" ]; then
            # Also check current directory and /tmp for files written in last 5 min
            _qg_recovered=$(find . /tmp -maxdepth 2 -name "*.json" \
                -newer "$_qg_log" \
                2>/dev/null | \
                xargs grep -l "\"${_qg_slug}\"" 2>/dev/null | \
                head -1 || true)
        fi
        if [ -n "$_qg_recovered" ]; then
            warning "  [qa-gate] $_qg_agent wrote output to file instead of stdout — recovering from: $_qg_recovered"
            cat "$_qg_recovered" >> "$_qg_log"
            if grep -qE '"(verdict|findings|agent|summary)"' "$_qg_log" 2>/dev/null; then
                ORCH_GATE_MODEL="$_saved_gate_model"
                return 0
            fi
        fi
        if [ "$(( _qg_attempt + 1 ))" -lt "$_qg_max" ]; then
            warning "  [qa-gate] $_qg_agent attempt $(( _qg_attempt + 1 )) produced no structured output — retrying with escalated model"
        else
            warning "  [qa-gate] $_qg_agent all $(( _qg_attempt + 1 )) attempt(s) exhausted with no structured output"
        fi
        _qg_attempt=$(( _qg_attempt + 1 ))
    done
    ORCH_GATE_MODEL="$_saved_gate_model"
    return 1
}

stop_dashboards_watch() {
    if [ "$DASHBOARD_WATCH_OWNED" != "true" ] || [ -z "$DASHBOARD_WATCH_PID" ]; then
        return
    fi
    if ps -p "$DASHBOARD_WATCH_PID" > /dev/null 2>&1; then
        info "Stopping dashboards watcher (PID $DASHBOARD_WATCH_PID)..."
        pkill -P "$DASHBOARD_WATCH_PID" 2>/dev/null || true
        kill "$DASHBOARD_WATCH_PID" 2>/dev/null || true
        wait "$DASHBOARD_WATCH_PID" 2>/dev/null || true
    fi
    rm -f "$DASHBOARD_WATCH_PID_FILE"
    DASHBOARD_WATCH_PID=""
    DASHBOARD_WATCH_OWNED=false
}

start_control_plane() {
    if [ "${EPAM_CONTROL_PLANE:-1}" != "1" ]; then
        info "Control plane disabled (EPAM_CONTROL_PLANE=0)."
        return
    fi
    local _node_bin
    _node_bin=$(detect_node 2>/dev/null || true)
    if [ -z "$_node_bin" ]; then
        warning "Control plane: node binary not found — skipping."
        return
    fi
    local cp_script="$SCRIPT_DIR/control-plane.js"
    if [ ! -f "$cp_script" ]; then
        warning "Control plane script not found at $cp_script — skipping."
        return
    fi
    # Remove stale PAUSED sentinel from a previous run
    rm -f "$LOG_DIR/PAUSED"
    # Kill any stale process holding the control plane port from a previous run
    local _stale_pid
    _stale_pid=$(lsof -ti "tcp:${CONTROL_PLANE_PORT}" 2>/dev/null || true)
    if [ -n "$_stale_pid" ]; then
        warning "Killing stale process on port ${CONTROL_PLANE_PORT} (PID $_stale_pid)"
        kill "$_stale_pid" 2>/dev/null || true
        sleep 0.3
    fi
    CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT}" \
    LOG_DIR="$LOG_DIR" \
        "$_node_bin" "$cp_script" >> "$CONTROL_PLANE_LOG" 2>&1 &
    CONTROL_PLANE_PID=$!
    sleep 0.5
    if ! ps -p "$CONTROL_PLANE_PID" > /dev/null 2>&1; then
        warning "Control plane exited immediately; see $CONTROL_PLANE_LOG"
        CONTROL_PLANE_PID=""
        return
    fi
    info "Control plane started (PID $CONTROL_PLANE_PID, port $CONTROL_PLANE_PORT)"
}

stop_control_plane() {
    if [ -z "$CONTROL_PLANE_PID" ]; then
        return
    fi
    if ps -p "$CONTROL_PLANE_PID" > /dev/null 2>&1; then
        kill "$CONTROL_PLANE_PID" 2>/dev/null || true
        wait "$CONTROL_PLANE_PID" 2>/dev/null || true
    fi
    CONTROL_PLANE_PID=""
}

# hot_swap_story_model_if_unstable <story_id>
# Called after a story's FIRST watchdog timeout, before the automatic retry.
# A timeout means the invocation produced NO signal at all within the full
# effort-scaled window — that's categorically different from a normal retry
# (which at least has failure content to learn from). Retrying with the exact
# same model+provider pairing risks repeating an unstable/misrouted
# combination for the full timeout window again.
#
# Root cause this addresses (found live, 2026-07-07): a story ended up with
# aiProvider="qwen" (OpenRouter) paired with model="MiniMax-M3" (a MiniMax-
# native model) after spec-mode's LLM model-review step changed .model without
# syncing .aiProvider — see resolveModelProvider()'s docstring in
# spec-mode-runner.js for the full story. That specific mismatch is now fixed
# at the source, but ANY model/provider pairing can still be transiently
# unstable (rate limits, upstream outage) — this is a general resilience
# measure, not just a patch for that one bug.
#
# Escalates exactly ONE ladder step (reusing the same EPAM_MODEL_LADDER_MEDIUM/
# HIGH / EPAM_MODEL_PROVIDER_MAP config already used by claude.sh's inference
# ladder — duplicated here in minimal form because run-agent-orchestration.sh
# invokes claude.sh as a SEPARATE PROCESS via `timeout`, not sourced, so
# claude.sh's bash functions aren't available in this process). No vendor/
# model names hardcoded — every decision reads from env-configured maps.
# No-op (silent) when no ladder step is configured for the current model.
hot_swap_story_model_if_unstable() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local current_model
    current_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null || echo "")
    # 1 = did not advance. The caller climbs while this succeeds, so a
    # "nothing to swap" path reporting 0 would re-run the SAME model.
    [ -z "$current_model" ] && return 1

    local tier
    tier=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .ladderTier // "medium"' "$prd_target" 2>/dev/null || echo "medium")
    local ladder="${EPAM_MODEL_LADDER:-}"
    if [ -z "$ladder" ]; then
        case "$tier" in
            high) ladder="${EPAM_MODEL_LADDER_HIGH:-}" ;;
            *)    ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
        esac
    fi
    [ -z "$ladder" ] && return 1

    local new_model="" pair from to IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$ladder"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"
        to="${pair#*=}"
        if [ "$from" = "$current_model" ]; then
            new_model="$to"
            break
        fi
    done

    # Top-of-ladder fallback (found live, 2026-07-12): a model that has NO
    # configured step FROM it (because it's already the ladder's own top rung
    # -- e.g. ESCALATION_MODEL_HIGH itself) used to leave this function a
    # silent no-op, so the retry re-invoked the IDENTICAL model+provider,
    # hit the same class of hang again, and the story was skipped entirely
    # after the second timeout. A watchdog timeout means genuinely zero
    # response within the full window (see this function's own docstring) --
    # that's real evidence the CURRENT pairing is unhealthy, not just slow,
    # so retrying it unchanged a second time is not a meaningful self-heal
    # attempt. Fall back to EPAM_FINAL_FALLBACK_MODEL/PROVIDER -- a
    # genuinely different pairing already configured for exactly this
    # "nowhere left to escalate" case (see claude.sh's own InferenceLadder
    # Rung3 fallback) -- rather than repeating a pairing already known to
    # have failed once.
    if [ -z "$new_model" ] && [ -n "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && [ "${EPAM_FINAL_FALLBACK_MODEL}" != "$current_model" ]; then
        new_model="${EPAM_FINAL_FALLBACK_MODEL}"
    fi
    [ -z "$new_model" ] && return 1   # ladder exhausted

    local new_provider="" map_pair map_from map_to
    if [ "$new_model" = "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && [ -n "${EPAM_FINAL_FALLBACK_PROVIDER:-}" ]; then
        new_provider="${EPAM_FINAL_FALLBACK_PROVIDER}"
    fi
    if [ -n "${EPAM_MODEL_PROVIDER_MAP:-}" ]; then
        IFS='|'
        read -ra map_pairs <<< "$EPAM_MODEL_PROVIDER_MAP"
        IFS="$IFS_SAVE"
        for map_pair in "${map_pairs[@]}"; do
            map_from="${map_pair%%=*}"
            map_to="${map_pair#*=}"
            case "$new_model" in
                $map_from) new_provider="$map_to"; break ;;
            esac
        done
    fi

    local jq_args=(--arg id "$story_id" --arg m "$new_model")
    local jq_filter='(.stories[] | select(.id == $id) | .model) = $m'
    if [ -n "$new_provider" ]; then
        jq_args+=(--arg p "$new_provider")
        jq_filter='(.stories[] | select(.id == $id) | .model) = $m | (.stories[] | select(.id == $id) | .aiProvider) = $p'
    fi
    local tmp_prd
    tmp_prd=$(mktemp)
    # mktemp defaults to mode 0600; mv preserves that onto the final PRD file,
    # which then becomes unreadable to anything not running as the same user
    # (e.g. the monitor dashboard's nginx worker, which runs as an
    # unprivileged 'nginx' user) -- found live 2026-07-14 as "Cannot load
    # prd.json" (HTTP 403) mid-run. chmod back to the standard 644 before the
    # rename so every atomic PRD write stays group/world-readable.
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq "${jq_args[@]}" "$jq_filter" "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        local _swap_reason="ladder step"
        [ "$new_model" = "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && _swap_reason="top-of-ladder fallback"
        warning "Watchdog: hot-swapping $story_id model after timeout ($_swap_reason): '$current_model' -> '$new_model'${new_provider:+ (provider -> $new_provider)}"
        # 0 = advanced to a new rung. The caller climbs while this succeeds, so
        # the return value is the ladder's "is there more?" signal.
        return 0
    else
        rm -f "$tmp_prd"
    fi
}

# maybe_upgrade_model_for_tc_density <story_id> <tc_facts_count>
# Re-assess a story's model tier once its real TC-fact density is known.
#
# Root cause this fixes (found live, 2026-07-13, SKY-002-test): spec-mode-
# runner.js's modelComplexitySignals() decides low/standard tier from
# acceptanceCriteria.length ALONE, during Step 0 — before the inline TC
# writer (post-impl-tc-writer.sh) has ever run for this story. A story with a
# modest AC count (e.g. 8, classified "low" effort) can still carry a much
# higher TC-fact density (22 granular, exact-match behavioral facts: exact
# error strings, env-var precedence, multi-key field-extraction fallbacks, a
# large bannedPatterns list) once TCs are actually written — data the Step 0
# classifier could not have had yet. Confirmed live: SKY-002-test (8 ACs, 22
# TC facts, MiniMax-M3) burned its full 8-attempt escalation ladder on small
# precision slips (wrong import name, one broken string literal) against all
# 22 checks, then failed on a watchdog timeout at the highest rung.
#
# Called right after the inline TC writer succeeds, before that story's own
# implementation attempt begins — reuses EPAM_MODEL_PROVIDER_MAP the same way
# hot_swap_story_model_if_unstable does, so provider stays in sync with model.
maybe_upgrade_model_for_tc_density() {
    local story_id="$1"
    local tc_facts_count="${2:-0}"
    local prd_target="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
    local threshold="${EPAM_TC_FACTS_UPGRADE_THRESHOLD:-15}"

    [ -z "${ORCH_UPGRADE_MODEL:-}" ] && return 0
    [ "$tc_facts_count" -le "$threshold" ] && return 0

    local current_model
    current_model=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null)
    [ -z "$current_model" ] && return 0
    [ "$current_model" = "$ORCH_UPGRADE_MODEL" ] && return 0

    local new_provider="" pair from to ifs_save="$IFS"
    if [ -n "${EPAM_MODEL_PROVIDER_MAP:-}" ]; then
        IFS='|'
        read -ra pairs <<< "$EPAM_MODEL_PROVIDER_MAP"
        IFS="$ifs_save"
        for pair in "${pairs[@]}"; do
            from="${pair%%=*}"
            to="${pair#*=}"
            # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
            case "$ORCH_UPGRADE_MODEL" in
                $from) new_provider="$to"; break ;;
            esac
        done
    fi

    local tmp_prd
    tmp_prd=$(mktemp)
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq --arg id "$story_id" --arg m "$ORCH_UPGRADE_MODEL" --arg p "$new_provider" \
          --arg reason "tc-facts=${tc_facts_count} exceeds threshold=${threshold}" \
          --arg ts "$(date -Iseconds)" --arg from_model "$current_model" \
          '(.stories[] | select(.id == $id)) |= (
               .model = $m
               | .aiProvider = (if $p == "" then .aiProvider else $p end)
               | .specification.tcDensityUpgrade = {from: $from_model, to: $m, reason: $reason, upgradedAt: $ts}
           )' \
          "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        warning "  [tc-density-upgrade] $story_id: ${tc_facts_count} TC facts exceeds threshold ($threshold) — upgrading model $current_model -> $ORCH_UPGRADE_MODEL${new_provider:+ (provider -> $new_provider)}"
    else
        rm -f "$tmp_prd"
        warning "  [tc-density-upgrade] jq update failed for $story_id — leaving model unchanged"
    fi
}

# Run a single story with effort-based timeout + one automatic retry.
# On double timeout:
#   EPAM_PAUSE_ON_TIMEOUT=true  → pause and wait for operator (max EPAM_MAX_PAUSE_SECS)
#   EPAM_PAUSE_ON_TIMEOUT=false → skip the story, log failure, continue (default)
# run_story_recovery_analyst <story_id> <log_file>
# Diagnose-then-restructure recovery for a story that hit a genuine watchdog
# double-timeout (marked status="failed", technicalNotes.failureReason
# starting "watchdog_timeout" -- see run_story_with_watchdog below).
#
# User request (2026-07-10, after SKY-002b and SKY-003-test both timed out
# twice in the same run): "we need to determine a self heal approach a full
# blown prd recovery perhaps" -- rejected a plain retry-with-escalated-model
# as "not really a healing approach". This treats a double-timeout as
# evidence the PLAN (the story's own scope/ACs) may be wrong, not just that
# the model got unlucky: it hands the story's full PRD entry and its own
# execution log tail to an analyst, asks whether the story's scope is
# genuinely too large/ambiguous, and if so has it propose a narrower,
# trimmed acceptanceCriteria list -- applied through the SAME reviewer-gated
# mechanism already used for ac_patch changes elsewhere in this file, not a
# new bespoke path. Deliberately scoped to watchdog-timeout failures ONLY (not
# HealingBroken-at-max-rung or other failure shapes) -- those are a different
# failure mode this pass doesn't attempt to cover.
#
# Bounded: at most ONE restructure + ONE retry per story. If the analyst finds
# no structural issue, the reviewer rejects the proposed ACs, or the retry
# still fails, this returns 1 and the caller counts it as a phase failure
# exactly like today.
run_story_recovery_analyst() {
    local story_id="$1"
    local log_file="$2"

    local _failure_reason
    _failure_reason=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.failureReason // ""' \
        "$PRD_FILE" 2>/dev/null || echo "")
    case "$_failure_reason" in
        watchdog_timeout*) ;;
        *) return 1 ;;
    esac

    local _story_json
    _story_json=$(jq -c --arg id "$story_id" '.stories[] | select(.id == $id)' "$PRD_FILE" 2>/dev/null)
    [ -z "$_story_json" ] && return 1

    local _log_tail
    _log_tail=$(tail -c 4000 "$log_file" 2>/dev/null || echo "")

    local _prompt="You are the story-recovery-analyst. Story ${story_id} timed out twice (watchdog) and was marked failed -- it never finished within its time budget. Diagnose whether the story's OWN scope is the root cause (too many acceptance criteria, ambiguous/contradictory requirements, an unbounded/open-ended task) as opposed to a transient model/infra hiccup.

Story (full PRD entry):
${_story_json}

Tail of its execution log (what it was doing when it timed out):
${_log_tail}

If the story's scope is genuinely too large or ambiguous: respond with JSON {\"restructure\": true, \"new_acs\": [\"...\", \"...\"], \"reason\": \"...\"} -- new_acs must be a TRIMMED, CONCRETE, non-overlapping replacement for the story's current acceptanceCriteria array (same intent, narrower/clearer scope, each one independently verifiable).
If this looks like a transient issue (model hiccup, infra flake) rather than a scope problem: respond with JSON {\"restructure\": false, \"reason\": \"...\"}.
Respond with ONLY the JSON object, nothing else."

    local _analyst_response="" _sra_attempt=0
    while [ "$_sra_attempt" -lt 2 ]; do
        local _sra_prompt="$_prompt"
        [ "$_sra_attempt" -ge 1 ] && _sra_prompt="RETRY (attempt 2): Your previous response was empty or unparseable. Respond with ONLY the JSON: {\"restructure\": true/false, \"reason\": \"...\", \"new_acs\": [...]}.

$_prompt"
        local _sra_raw
        _sra_raw=$(run_orch_prompt_with_tools "$_sra_prompt" "story_recovery" "$story_id" 2>/dev/null)
        if [ -n "$_sra_raw" ] && echo "$_sra_raw" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
            _analyst_response="$_sra_raw"
            break
        fi
        warning "  [StoryRecovery] story-recovery-analyst attempt $(( _sra_attempt + 1 )) returned no parseable JSON$([ "$_sra_attempt" -lt 1 ] && echo " — retrying" || echo "")"
        _sra_attempt=$(( _sra_attempt + 1 ))
    done
    if [ -z "$_analyst_response" ]; then
        warning "  [StoryRecovery] story-recovery-analyst returned no parseable response after 2 attempt(s) — leaving as failed"
        return 1
    fi
    local _restructure
    _restructure=$(echo "$_analyst_response" | jq -r '.restructure // false' 2>/dev/null || echo false)

    if [ "$_restructure" != "true" ]; then
        log "  [StoryRecovery] Analyst found no structural issue for $story_id — leaving as failed"
        return 1
    fi

    local _new_acs
    _new_acs=$(echo "$_analyst_response" | jq -c '.new_acs // []' 2>/dev/null || echo "[]")
    if [ "$(echo "$_new_acs" | jq 'length' 2>/dev/null || echo 0)" -eq 0 ]; then
        warning "  [StoryRecovery] Analyst said restructure=true but gave no new_acs — leaving as failed"
        return 1
    fi

    local _before_acs
    _before_acs=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | join("; ")' \
        "$PRD_FILE" 2>/dev/null || echo "")
    local _candidate
    _candidate=$(echo "$_new_acs" | jq -r 'join("; ")')

    # Reviewer gate — inline call (NOT a call to run_change_with_reviewer_retry,
    # which only exists in claude.sh's scope; this script never sources it).
    # Root cause this fixes (found live, 2026-07-12, tier3-travel-app run):
    # the previous call to that undefined function failed with bash's own
    # "command not found", and since that failure's stdout is empty (the
    # error goes to stderr), $_verdict became "" — which is NOT equal to
    # "fail", so the `if [ "$_verdict" = "fail" ]` check below always passed
    # and the restructured ACs were applied to the PRD with ZERO actual
    # review, every single time this path ran. The gate failed OPEN, not
    # closed. Fixed by inlining the same direct-LLM-call pattern already used
    # by every other in-file reviewer gate (e.g. the pre-phase-assessment
    # profile-change gate above) instead of referencing a function that was
    # never available in this script.
    local _verdict="pass"  # fail-safe only when reviewer is not configured
    if [ -n "${ORCH_GATE_PROVIDER:-}" ]; then
        local _src_reviewer_profile
        _src_reviewer_profile=$(jq -r '."prd-change-reviewer" // ""' "$AGENT_PROFILES_FILE" 2>/dev/null || echo "")
        if [ -n "$_src_reviewer_profile" ]; then
            local _rev_raw="" _rev_attempt=0
            while [ "$_rev_attempt" -lt 2 ] && [ -z "$_rev_raw" ]; do
                local _corrective_rev=""
                [ "$_rev_attempt" -gt 0 ] && _corrective_rev="CORRECTION: Your previous response did not contain parseable JSON with a verdict field. Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}

"
                local _rev_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
                [ "$_rev_attempt" -ge 1 ] && [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _rev_model="${ESCALATION_MODEL_HIGH}"
                _rev_raw=$(echo "${_corrective_rev}${_src_reviewer_profile}

STORY: ${story_id}
CHANGE TYPE: ac_patch

BEFORE:
${_before_acs:0:1000}

AFTER:
${_candidate:0:1000}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}" | \
                    AI_PROVIDER="${ORCH_GATE_PROVIDER}" \
                    AI_MODEL="${_rev_model}" \
                    EPAM_CLI="${EPAM_CLI:-epam}" \
                    "$AI_RUNNER_CMD" \
                        --provider "${ORCH_GATE_PROVIDER}" \
                        --model    "${_rev_model}" \
                    2>/dev/null | \
                    python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    v = obj.get('verdict','')
    if v in ('pass','fail'):
        print(v); sys.exit(0)
except Exception:
    pass
m = re.search(r'\"verdict\"\s*:\s*\"(pass|fail)\"', text)
if m: print(m.group(1)); sys.exit(0)
" 2>/dev/null || true)
                _rev_attempt=$(( _rev_attempt + 1 ))
            done
            if [ "$_rev_raw" = "pass" ] || [ "$_rev_raw" = "fail" ]; then
                _verdict="$_rev_raw"
            else
                warning "  [StoryRecovery] Reviewer failed to produce a valid verdict after 2 attempt(s) — defaulting to fail (fail-safe)"
                _verdict="fail"
            fi
        fi
    fi
    if [ "$_verdict" = "fail" ]; then
        warning "  [StoryRecovery] Reviewer rejected the restructured ACs for $story_id — leaving as failed"
        return 1
    fi

    jq --arg id "$story_id" --argjson acs "$_new_acs" \
        '(.stories[] | select(.id == $id) | .acceptanceCriteria) = $acs |
         (.stories[] | select(.id == $id) | .status) = "pending" |
         (.stories[] | select(.id == $id) | .completed) = false |
         (.stories[] | select(.id == $id) | .technicalNotes.failureReason) = null |
         (.stories[] | select(.id == $id) | .technicalNotes.recoveredFrom) = "watchdog_timeout"' \
        "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"

    jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg id "$story_id" --argjson acs "$_new_acs" \
        '{timestamp:$ts, story_id:$id, event:"story_restructured", new_acs:$acs}' \
        >> "$LOG_DIR/story-recovery-audit.jsonl" 2>/dev/null || true

    success "  [StoryRecovery] Restructured ACs for $story_id — retrying once with narrowed scope"
    run_story_with_watchdog "$story_id" "$log_file"
}

#
# Effort-based defaults (overridden by STORY_TIMEOUT_SECS or
# EPAM_STORY_TIMEOUT_SECS — the latter is what a project's llm-settings.json
# storyTimeoutSecs actually loads via _load_timeout_config(), see
# lib/story-guards.sh):
#   low    → 600s  (10 min) — EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS
#   medium → 1200s (20 min) — EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS
#   high   → 2400s (40 min) — EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS
#   *      → 900s  (15 min) — EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS
# Each tier is config-driven (llm-settings.json's timeouts.storyEffortTimeoutSecs)
# with the values above as the fallback when a project sets none — no
# project-specific fact should be baked into pipeline code as a bare literal.
# The effort-derived value is then scaled by a per-agentRole multiplier
# (EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP, default "test-engineer=1.5", also
# config-driven via timeouts.roleTimeoutMultipliers) — role names come from
# whatever the pipeline itself assigned to the story in prd.json (Step
# 0.5/0.9), never hardcoded to a specific project's stack; an unmatched role
# gets multiplier 1.0 (today's exact behavior).
resolve_role_timeout_multiplier() {
    local story_id="$1"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    [ -z "$role" ] && { echo "1.0"; return 0; }
    local map pair from to ifs_save="$IFS"
    map="${EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP:-test-engineer=1.5}"
    IFS='|'; read -ra pairs <<< "$map"; IFS="$ifs_save"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"; to="${pair#*=}"
        if [ "$role" = "$from" ]; then
            echo "$to"
            return 0
        fi
    done
    echo "1.0"
}

run_story_with_watchdog() {
    local story_id="$1"
    local log_file="$2"
    local _rc=0

    # Determine timeout: explicit override wins (STORY_TIMEOUT_SECS, a manual
    # per-invocation env var, takes priority over EPAM_STORY_TIMEOUT_SECS, the
    # project-config-loaded fallback — same "manual env var beats project
    # config" precedence load_llm_settings_json() already uses elsewhere),
    # else scale by effort.
    local timeout_secs
    if [ -n "${STORY_TIMEOUT_SECS:-}" ]; then
        timeout_secs="$STORY_TIMEOUT_SECS"
    elif [ -n "${EPAM_STORY_TIMEOUT_SECS:-}" ]; then
        timeout_secs="$EPAM_STORY_TIMEOUT_SECS"
    else
        local story_effort
        story_effort=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .effort // "medium"' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "medium")
        case "$story_effort" in
            low)    timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS:-600}"     ;;
            medium) timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS:-1200}" ;;
            high)   timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS:-2400}"   ;;
            *)      timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS:-900}" ;;
        esac
        local role_multiplier
        role_multiplier=$(resolve_role_timeout_multiplier "$story_id")
        timeout_secs=$(python3 -c "
import math
print(math.ceil(${timeout_secs} * ${role_multiplier}))
" 2>/dev/null || echo "$timeout_secs")
    fi

    set +e
    timeout "$timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee "$log_file"
    _rc=${PIPESTATUS[0]}
    set -e

    if [ $_rc -eq 124 ]; then
        # Scale the retry's timeout up (found live, 2026-07-07): a story that
        # timed out once has, by construction, already burned several internal
        # self-heal attempts within that window — each one appends more KB/
        # coordinator-guidance context, so by the time the SAME flat timeout
        # budget is handed to the retry, the cumulative prompt is already larger
        # than attempt 1's. A live process inspection during a real timeout
        # confirmed a genuinely in-flight, still-connected API call (not a
        # stuck/crashed one) — the retry deserves more room, not the same
        # budget that already proved insufficient once. Multiplier is
        # configurable (EPAM_WATCHDOG_RETRY_MULTIPLIER, default 1.5x); set to 1
        # to restore the old flat-timeout behavior.
        local retry_timeout_secs
        retry_timeout_secs=$(python3 -c "
import math
print(math.ceil(${timeout_secs} * ${EPAM_WATCHDOG_RETRY_MULTIPLIER:-1.5}))
" 2>/dev/null || echo "$timeout_secs")
        # ── Climb the ladder, do not merely swap once ─────────────────────
        # This was a single retry, so at most ONE escalation could ever happen.
        # The HIGH ladder is four rungs (MiniMax-M2.5 -> MiniMax-M3 ->
        # z-ai/glm-5.1 -> moonshotai/kimi-k3), which made everything above the
        # second rung unreachable BY CONSTRUCTION —
        # EPAM_FINAL_FALLBACK_MODEL=kimi-k3 could never be used, and hot_swap
        # even logs a "top-of-ladder fallback" case it could not reach. Live
        # AMSD-2041 2026-07-29: three lanes, one hot-swap each, kimi-k3 absent
        # from every log.
        #
        # An escalation is not a replacement: moving to a NEW rung must not
        # consume the story's last attempt, or "escalate" means "swap the model
        # and give up". So attempts continue while the ladder still offers a new
        # model, bounded by EPAM_MAX_LADDER_ATTEMPTS so a mis-configured ladder
        # cannot loop. When the swap yields nothing new the ladder is exhausted
        # and stopping is correct — retrying the same model is the same gamble.
        local _lad_attempt=1
        local _lad_max="${EPAM_MAX_LADDER_ATTEMPTS:-6}"
        while [ "$_rc" -eq 124 ] && [ "$_lad_attempt" -lt "$_lad_max" ]; do
            local _lad_swapped=0
            hot_swap_story_model_if_unstable "$story_id" || _lad_swapped=1
            # The FIRST retry happens regardless — that is the pre-existing
            # "retry once with an extended budget" behaviour, and a story whose
            # project configures no ladder must not lose it. Only the SECOND and
            # later retries require an actual escalation, because repeating a
            # model that did not finish twice is the gamble the ladder exists to
            # avoid.
            if [ "$_lad_attempt" -gt 1 ] && [ "$_lad_swapped" -ne 0 ]; then
                warning "Watchdog: $story_id — ladder exhausted, no further model to escalate to"
                break
            fi
            _lad_attempt=$(( _lad_attempt + 1 ))
            warning "Watchdog: $story_id timed out after ${timeout_secs}s — attempt ${_lad_attempt}/${_lad_max} on the next ladder rung with a ${retry_timeout_secs}s budget..."
            set +e
            timeout "$retry_timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee -a "$log_file"
            _rc=${PIPESTATUS[0]}
            set -e
        done
    fi

    if [ $_rc -eq 124 ]; then
        if [ "${EPAM_PAUSE_ON_TIMEOUT:-false}" = "true" ]; then
            error "Watchdog: $story_id timed out twice — pausing (max ${EPAM_MAX_PAUSE_SECS}s)"
            printf '%s' "$(jq -n \
                --arg reason  "story_timeout" \
                --arg story   "$story_id" \
                --arg phase   "$PHASE" \
                --argjson tsecs "$timeout_secs" \
                --argjson retryTsecs "${retry_timeout_secs:-$timeout_secs}" \
                '{reason:$reason,storyId:$story,phase:$phase,timeoutSecs:$tsecs,retryTimeoutSecs:$retryTsecs,pausedAt:(now|todate)}'
            )" > "$LOG_DIR/PAUSED"
            wait_if_paused
            # Operator resumed — continue past the timed-out story
            return 0
        else
            error "Watchdog: $story_id timed out twice (${timeout_secs}s then ${retry_timeout_secs:-$timeout_secs}s) — skipping story and continuing"
            warning "  Set EPAM_PAUSE_ON_TIMEOUT=true to pause for operator intervention instead"
            # Log the timeout as a failed cost record so dashboards reflect it
            jq -cn \
                --arg pid "${CURRENT_PHASE:-unknown}" \
                --arg sid "$story_id" \
                --arg s   "timeout" \
                '{phase_id:$pid, story_id:$sid, status:$s, timestamp:(now|todate)}' \
                >> "${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}" 2>/dev/null || true

            # Root cause fix (found live, 2026-07-10, tier3-travel-app run): this
            # branch used to `return 0` (success) after a double-timeout, so the
            # PRD kept the story at "pending" forever and the phase reported
            # success anyway — a silent deliverable loss, the same failure class
            # as the original vanishing-stories bug this pipeline guards
            # against elsewhere. Mark the story failed in the PRD and propagate
            # a real failure exit code so the caller's _phase_story_failures
            # counter (and the phase-abort gate) actually sees it.
            jq --arg id "$story_id" \
               '(.stories[] | select(.id == $id) | .status) = "failed" |
                (.stories[] | select(.id == $id) | .technicalNotes.failureReason) =
                    "watchdog_timeout: story exceeded timeout twice and was skipped"' \
               "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
            return 1
        fi
    fi

    return $_rc
}

# ── GAP-P13 checkpoint helpers ──────────────────────────────────────────────
# Write a completed checkpoint entry for a story.
checkpoint_complete() {
    local story_id="$1"
    local idem_key="${ORCH_RUN_ID}:${PHASE:-main}:${story_id}"
    jq -cn \
        --arg key   "$idem_key" \
        --arg sid   "$story_id" \
        --arg phase "${PHASE:-main}" \
        --arg runId "$ORCH_RUN_ID" \
        '{idempotencyKey:$key, storyId:$sid, phase:$phase, runId:$runId,
          status:"completed", completedAt:(now|todate)}' \
        >> "$CHECKPOINT_FILE" 2>/dev/null || true
}

# Returns 0 (true) if the story already has a completed checkpoint in this run.
# Used to skip stories that finished before a crash/restart.
checkpoint_already_done() {
    local story_id="$1"
    [ ! -f "$CHECKPOINT_FILE" ] && return 1
    local idem_key="${ORCH_RUN_ID}:${PHASE:-main}:${story_id}"
    grep -q "\"idempotencyKey\":\"${idem_key}\"" "$CHECKPOINT_FILE" 2>/dev/null
}

# Clear checkpoints for this phase+run (called when RESET_STORIES=true).
checkpoint_clear() {
    rm -f "$CHECKPOINT_FILE" 2>/dev/null || true
}

# wait_if_paused — now in lib/story-guards.sh (sourced above).

# Topologically sort a newline-separated list of story IDs by prd.json
# dependencies, preserving declaration order within the same tier.
# Cycles emit a warning and fall back to declaration order.
topo_sort_stories() {
    local story_list="$1"
    [ -z "$story_list" ] && return
    local _py='
import sys, json
from collections import deque
story_ids = [s for s in sys.stdin.read().strip().split("\n") if s.strip()]
if not story_ids:
    sys.exit(0)
prd_file = sys.argv[1]
try:
    with open(prd_file) as f:
        prd = json.load(f)
except Exception:
    print("\n".join(story_ids)); sys.exit(0)
story_map = {s["id"]: s for s in prd.get("stories", [])}
id_set    = set(story_ids)
# When a story depends on a deprecated parent (not in id_set), substitute its
# active split children — identified by specification.createdFrom pointing to
# the parent. This ensures stories depending on a deprecated parent run AFTER
# its replacement children without hardcoding any IDs.
split_children = {}
for s in prd.get("stories", []):
    parent_id = (s.get("specification") or {}).get("createdFrom")
    if parent_id and parent_id not in id_set and s["id"] in id_set:
        split_children.setdefault(parent_id, []).append(s["id"])
in_degree = {s: 0 for s in story_ids}
graph     = {s: [] for s in story_ids}
for sid in story_ids:
    raw_deps = story_map.get(sid, {}).get("dependencies") or []
    deps = []
    for d in raw_deps:
        if d in id_set:
            deps.append(d)
        elif d in split_children:
            deps.extend(split_children[d])
    for dep in deps:
        graph[dep].append(sid)
        in_degree[sid] += 1
queue  = deque(sorted([s for s in story_ids if in_degree[s] == 0], key=story_ids.index))
result = []
while queue:
    node = queue.popleft()
    result.append(node)
    for succ in sorted(graph[node], key=story_ids.index):
        in_degree[succ] -= 1
        if in_degree[succ] == 0:
            queue.append(succ)
if len(result) != len(story_ids):
    sys.stderr.write("WARNING: dependency cycle in story group — using declaration order\n")
    print("\n".join(story_ids))
else:
    print("\n".join(result))
'
    echo "$story_list" | python3 -c "$_py" "$PRD_FILE" 2>/dev/null || echo "$story_list"
}

# capture_story_ids_snapshot / assert_no_story_ids_lost — deterministic
# invariant check against silent story deletion.
#
# Root cause this guards against (found live, 2026-07-09, tier3-travel-app
# run): SKY-002/003/004 vanished ENTIRELY from prd.stories[] — not merely
# stripped of technicalNotes.files (the already-fixed orphaned-pending-story
# gate scenario) — sometime during the scaffold phase. A deliberate repro
# attempt (fresh teardown + a poller watching the story-ID list every second)
# did NOT reproduce it, meaning the defect is intermittent, most likely tied
# to a specific LLM response shape in one of the three steps that give an
# agent full Bash/WriteFile tool access to the PRD (Step 0.5, Step 0.9, and
# run_phase_assessment's Step 3.5/Step 6 calls) — each of these is explicitly
# instructed (in its own prompt) to only ADD to profiles.json or change
# narrow fields, never restructure stories[], but that instruction is prose,
# not enforcement. No deterministic remediation step ever removes a story
# from stories[] either — deprecation is tracked via status field, the
# record itself is always kept ("archive"), per _prd_remediate_impl.py's own
# documented convention. So the story-ID SET must never shrink, anywhere in
# this pipeline, once Step 0 (spec-pass, the one step that legitimately
# reshapes IDs via splits) has completed for this phase.
#
# This does not fix the root cause (which agent turn is doing this, and why)
# — it makes the NEXT occurrence hard-fail immediately with the exact
# missing ID(s) and the step that just ran, instead of silently producing a
# phase that "completes" having done zero real work.
STORY_ID_SNAPSHOT_DIR="${STORY_ID_SNAPSHOT_DIR:-$(mktemp -d)}"

# _epam_prompt_version — the epam-cli repo's own short git SHA, cached for
# the life of this process. Since the guarded-step prompts live embedded in
# these scripts (no separate template files), the commit hash of the script
# IS the version proxy — a violation-rate change in the history file (below)
# can be directly correlated to "what changed in this commit." Resolved
# relative to SCRIPT_DIR (this repo), never CWD/PROJECT_ROOT — for a tier3
# run PROJECT_ROOT is the EXTERNAL target project, not this repo.
_epam_prompt_version() {
    if [ -z "${_EPAM_PROMPT_VERSION:-}" ]; then
        _EPAM_PROMPT_VERSION=$(git -C "$SCRIPT_DIR/.." rev-parse --short HEAD 2>/dev/null || echo "unknown")
        export _EPAM_PROMPT_VERSION
    fi
    echo "$_EPAM_PROMPT_VERSION"
}

# _log_guarded_step_retry <json_line> — takes an ALREADY-BUILT JSON record
# (each call site's own jq -n -c ... call, which knows its own step-specific
# fields) and appends it, augmented with runId + promptVersion, to BOTH:
#   - $LOG_DIR/guarded-step-retries.jsonl (per-run, project-local, unchanged
#     from tonight's original retry-guard feature — useful for single-run
#     debugging)
#   - orchestrations/logs/guarded-step-retries-history.jsonl (persistent,
#     ENGINE-side — survives this pipeline's own "teardown" convention,
#     rm -rf OUTPUT_DIR, which wipes the per-run copy above before every
#     fresh launch). Mirrors phase-cost.jsonl's identical DASHBOARD_ROOT-
#     relative convention (see dashboards/build/snapshot.js's PATHS).
#
# Root cause this fixes (found live, 2026-07-13): without this, there was no
# way to see whether a prompt's violation rate is improving or regressing
# over time — every relaunch destroyed the only record of the previous run.
_log_guarded_step_retry() {
    local json_line="$1"
    local augmented
    augmented=$(echo "$json_line" | jq -c --arg runId "${ORCH_RUN_ID:-unknown}" --arg pv "$(_epam_prompt_version)" \
        '. + {runId: $runId, promptVersion: $pv}' 2>/dev/null)
    [ -z "$augmented" ] && augmented="$json_line"
    echo "$augmented" >> "$LOG_DIR/guarded-step-retries.jsonl" 2>/dev/null || true
    mkdir -p "$SCRIPT_DIR/../logs" 2>/dev/null || true
    echo "$augmented" >> "$SCRIPT_DIR/../logs/guarded-step-retries-history.jsonl" 2>/dev/null || true
}

# capture_story_ids_snapshot <label> — writes the current, sorted set of
# story IDs in prd.stories[] to a snapshot file named after <label>, plus the
# full story objects (used by assert_no_story_ids_lost to self-heal a loss
# instead of only detecting it — see that function's docstring).
capture_story_ids_snapshot() {
    local label="$1"
    jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort > "$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    jq -c '.stories' "$PRD_FILE" 2>/dev/null > "$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
}

# assert_no_story_ids_lost <label> <step_name> — re-reads the current story
# ID set and diffs it against the named snapshot. A GROWING set (new split
# children) is expected and not an error.
#
# Self-healing (added 2026-07-11, after this fired a SECOND time live —
# first found 2026-07-09 — on Step 0.5 wiping SKY-002/003/004 from a
# DIFFERENT phase's implementationOrder entirely): this is an intermittent
# LLM tool-use defect (the agent has raw Bash/jq PRD write access and its own
# prompt already forbids exactly this), not something a prompt tweak reliably
# prevents. Rather than hard-abort the whole pipeline every time it recurs,
# restore the exact vanished story object(s) from the full-object snapshot
# captured alongside the ID snapshot and continue. Only hard-fails (exit 1)
# if a story is missing AND wasn't in the snapshot either (nothing to
# restore from) — that shape is not self-healable and still needs a human.
assert_no_story_ids_lost() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    [ -f "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare
    local current_ids missing_ids
    current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
    missing_ids=$(comm -23 "$snapshot_file" <(echo "$current_ids"))
    if [ -n "$missing_ids" ]; then
        local stories_snapshot="$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
        if [ -s "$stories_snapshot" ]; then
            warning "STORY-ID-LOSS after ${step_name}: restoring vanished stor(y/ies) from the pre-step snapshot instead of aborting:"
            local missing_json tmp_prd
            missing_json=$(echo "$missing_ids" | jq -R -s 'split("\n") | map(select(length > 0))')
            tmp_prd=$(mktemp)
            chmod 644 "$tmp_prd" 2>/dev/null
            if jq --argjson missing "$missing_json" --slurpfile snap "$stories_snapshot" \
                '.stories += ($snap[0] | map(select(.id as $i | $missing | index($i) != null)))' \
                "$PRD_FILE" > "$tmp_prd" 2>/dev/null && jq empty "$tmp_prd" 2>/dev/null; then
                mv "$tmp_prd" "$PRD_FILE"
                while IFS= read -r _mid; do
                    [ -n "$_mid" ] && warning "    - restored: $_mid"
                done <<< "$missing_ids"
                current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
                missing_ids=$(comm -23 "$snapshot_file" <(echo "$current_ids"))
            else
                rm -f "$tmp_prd"
            fi
        fi
    fi
    if [ -n "$missing_ids" ]; then
        error "STORY-ID-LOSS INVARIANT VIOLATED after ${step_name}: the following stor(y/ies) vanished entirely from prd.stories[] and could not be restored:"
        while IFS= read -r _mid; do
            [ -n "$_mid" ] && error "    - $_mid"
        done <<< "$missing_ids"
        error "  This step has full tool-write access to the PRD but is only permitted to ADD"
        error "  to profiles.json or change agentRole/model/aiProvider/reasoningEffort fields."
        error "  Check the agent's own transcript for this step's assessment/coordinator log."
        exit 1
    fi
}

# assert_no_story_ids_gained <label> <step_name> — companion to
# assert_no_story_ids_lost, for steps that must NEVER add a brand-new
# top-level story (unlike Step 0/spec-pass, whose whole job is to grow the
# story set via legitimate splits — that step is what the "presplit"
# snapshot is taken AFTER, precisely so growth from spec-pass itself is
# never flagged here).
#
# Root cause this guards against (found live, 2026-07-10, tier3-travel-app
# run): 6 entirely fabricated stories (SKY-005 through SKY-010 — an HTML
# dashboard story, three "comprehensive test suite" stories, a code-review/
# security-audit story, a mutation-testing story) appeared in prd.stories[]
# between the Step 0.1 CPA pre-pass snapshot and the end of Step 0.5 —  the
# ONLY two steps that ran in that window. Step 0.5's own prompt explicitly
# says "NEVER rewrite the PRD file with a different story structure. You may
# only update agentRole fields and append to profiles.json" — its own text
# summary that run claimed exactly that (agentRole updates + profile
# enhancements only) — but the actual PRD content contradicts its own
# summary. One of the fabricated stories even carried a `specification`
# block mimicking real spec-pass output (same shape, same shared run ID),
# making the forgery look legitimate at a glance; spec-pass's own
# authoritative summary.json for that exact run ID shows it only ever
# touched SKY-001. No deterministic guardrail existed to catch an agent
# adding stories nobody asked for — this closes that gap the same way
# assert_no_story_ids_lost closes the shrinkage gap.
assert_no_story_ids_gained() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    [ -f "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare
    local current_ids gained_ids
    current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
    gained_ids=$(comm -13 "$snapshot_file" <(echo "$current_ids"))
    if [ -n "$gained_ids" ]; then
        error "UNAUTHORIZED STORY CREATION after ${step_name}: the following NEW stor(y/ies) appeared in prd.stories[] that were not there before this step ran:"
        while IFS= read -r _gid; do
            [ -n "$_gid" ] && error "    - $_gid"
        done <<< "$gained_ids"
        error "  This step has full tool-write access to the PRD but is only permitted to ADD"
        error "  to profiles.json or change agentRole/model/aiProvider/reasoningEffort fields —"
        error "  never to author brand-new top-level stories."
        error "  Check the agent's own transcript for this step's assessment/coordinator log."
        exit 1
    fi
}

# assert_no_illegitimate_deprecation <label> <step_name> — companion to
# assert_no_story_ids_lost/assert_no_story_ids_gained, closing a gap those two
# don't cover: a story whose ID survives (so ID-loss doesn't fire) but whose
# `status` field gets silently flipped to "deprecated" by one of the
# unrestricted-tool-write steps (Step 0.5, Step 0.9).
#
# Root cause this guards against (found live, 2026-07-12, tier3-travel-app
# run): SKY-001 was legitimately split into SKY-001-impl/SKY-001-test by
# Step 0 (spec-pass) — both created with status="pending", the correct,
# executable state captured in the "presplit" snapshot. By the time Step 1
# reached them, both had status="deprecated" (plus completed=true and
# removed from implementationOrder) — the exact signature applySpecChanges
# writes onto a PARENT story once ITS split succeeds (spec-mode-runner.js:
# 1865-1866/2392-2397), even though neither of these two stories was ever a
# parent of a further split (no grandchild story IDs exist anywhere in the
# PRD). Nothing between the presplit snapshot and Step 1 legitimately
# deprecates a scaffold-phase story — only Step 0 itself and the
# mid-execution split-gate may do that, and the split-gate explicitly logged
# "No unvalidated mid-execution splits" for this phase. The only steps that
# ran in that window with the unrestricted PRD write access needed to cause
# this are Step 0.5 and Step 0.9 (both explicitly instructed, in their own
# prompts, to touch only agentRole/model/aiProvider/reasoningEffort fields or
# profiles.json — same class of prompt-vs-actual-write mismatch already
# documented for assert_no_story_ids_gained). Net effect: the two stories
# that were actually supposed to write package.json/tsconfig.json/etc. were
# silently skipped all run, and the phase "completed" having done zero real
# scaffolding work.
#
# Scope deliberately narrow: only stories present in BOTH the snapshot and
# the current PRD (a story ID appearing/vanishing is assert_no_story_ids_lost/
# gained's job), and only a flip INTO "deprecated" from something else (a
# story that was already deprecated at snapshot time — e.g. a delegated
# parent — legitimately stays deprecated; that's not a regression).
assert_no_illegitimate_deprecation() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
    [ -s "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare

    local flipped_ids
    flipped_ids=$(jq -r --slurpfile snap "$snapshot_file" '
        ($snap[0] | map({(.id): (.status // "pending")}) | add) as $before |
        [.stories[] | select(
            ($before[.id] // null) != null and
            ($before[.id]) != "deprecated" and
            (.status // "pending") == "deprecated"
        ) | .id] | .[]
    ' "$PRD_FILE" 2>/dev/null || true)
    [ -z "$flipped_ids" ] && return 0

    warning "STATUS-CORRUPTION after ${step_name}: the following stor(y/ies) were flipped to \"deprecated\" with no legitimate split/delegation event — restoring from the pre-step snapshot:"
    local flipped_json tmp_prd
    flipped_json=$(echo "$flipped_ids" | jq -R -s 'split("\n") | map(select(length > 0))')
    tmp_prd=$(mktemp)
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq --argjson flipped "$flipped_json" --slurpfile snap "$snapshot_file" \
        '.stories = (.stories | map(
            . as $cur |
            ($snap[0][] | select(.id == $cur.id and ($flipped | index($cur.id) != null))) // $cur
        ))' \
        "$PRD_FILE" > "$tmp_prd" 2>/dev/null && jq empty "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$PRD_FILE"
        while IFS= read -r _fid; do
            [ -n "$_fid" ] && warning "    - restored: $_fid"
        done <<< "$flipped_ids"
    else
        rm -f "$tmp_prd"
        error "STATUS-CORRUPTION after ${step_name}: could not restore — check $PRD_FILE manually"
        exit 1
    fi
}

# apply_redirect_if_any — now in lib/story-guards.sh (sourced above).

start_dashboards_watch() {
    local dashboards_dir="$AUTOMATION_DIR/dashboards"
    local config_path="$dashboards_dir/.eleventy.js"
    local local_eleventy_bin="$dashboards_dir/node_modules/.bin/eleventy"

    if [ "${EPAM_DASH_AUTO_SERVE:-1}" != "1" ]; then
        info "Dashboard auto-serve disabled (EPAM_DASH_AUTO_SERVE=0)."
        return
    fi
    if [ ! -f "$config_path" ]; then
        warning "Dashboards config not found at $config_path; skipping auto-serve."
        return
    fi
    # A lane re-exec must never start its own watcher. The parent run already has
    # one, and the pid-file check below is NOT atomic: three lanes launched
    # together all read the file before any of them wrote it, so live metrolinx
    # 2026-07-29 ran three Eleventy stacks rebuilding the same dashboard from the
    # same LOG_DIR — ~120% CPU competing with the lanes for identical output.
    # Sequential lanes hid this by never overlapping. A lock would also close the
    # race; not starting it at all is simpler and strictly correct, because the
    # lane has nothing to serve that the parent is not already serving.
    if [ "${JIRA_CODELINE_RUN:-}" = "1" ]; then
        return
    fi
    if [ -n "$DASHBOARD_WATCH_PID" ]; then
        return
    fi
    if [ -f "$DASHBOARD_WATCH_PID_FILE" ]; then
        local existing_pid
        existing_pid="$(cat "$DASHBOARD_WATCH_PID_FILE" 2>/dev/null || true)"
        if [ -n "$existing_pid" ] && ps -p "$existing_pid" > /dev/null 2>&1; then
            info "Eleventy dashboards watcher already running (PID $existing_pid)."
            DASHBOARD_WATCH_PID="$existing_pid"
            return
        fi
    fi

    # NOTE: EPAM_PROJECT_OUTPUT_DIR is intentionally NOT exported to the Eleventy
    # subprocess here. snapshot.js's agentActivity/agentStatus/phaseCost paths use
    # process.env.EPAM_PROJECT_OUTPUT_DIR directly (not via resolveProjectOutputDir),
    # and those files live in orchestrations/logs — which the dashboard's logs/ symlink
    # already resolves correctly. Exporting EPAM_PROJECT_OUTPUT_DIR=OUTPUT_DIR would
    # redirect those reads to the project output dir (wrong place). The .active-output-dir
    # pointer written by pre-run-reset.sh is sufficient for resolveProjectOutputDir(),
    # which only feeds healingEvents/storyFailures/guardedStepRetries (files in OUTPUT_DIR).

    if [ -x "$local_eleventy_bin" ]; then
        info "Starting Eleventy dashboards watcher (local binary)..."
        (
            cd "$PROJECT_ROOT" || exit 1
            exec "$local_eleventy_bin" \
                "--config=$config_path" \
                "--input=$dashboards_dir" \
                "--output=$dashboards_dir/live" \
                --serve >> "$DASHBOARD_WATCH_LOG" 2>&1
        ) &
    elif command -v npx >/dev/null 2>&1; then
        info "Starting Eleventy dashboards watcher (npx --prefix)..."
        (
            cd "$PROJECT_ROOT" || exit 1
            exec npx --prefix "$dashboards_dir" @11ty/eleventy \
                "--config=$config_path" \
                "--input=$dashboards_dir" \
                "--output=$dashboards_dir/live" \
                --serve >> "$DASHBOARD_WATCH_LOG" 2>&1
        ) &
    else
        warning "Neither local Eleventy binary nor npx is available; skipping dashboard auto-serve."
        return
    fi

    DASHBOARD_WATCH_PID=$!
    DASHBOARD_WATCH_OWNED=true
    echo "$DASHBOARD_WATCH_PID" > "$DASHBOARD_WATCH_PID_FILE"
    sleep 1
    if ! ps -p "$DASHBOARD_WATCH_PID" > /dev/null 2>&1; then
        warning "Dashboards watcher exited immediately; see $DASHBOARD_WATCH_LOG"
        rm -f "$DASHBOARD_WATCH_PID_FILE"
        DASHBOARD_WATCH_PID=""
        DASHBOARD_WATCH_OWNED=false
    fi
}

# ── Codeline bridge agent ─────────────────────────────────────────────────────
# Runs after a codeline completes. Extracts its exported API surface and writes
# a cross-codeline contract to logs/cross-codeline-<cl>.md.
# Exports CROSS_CODELINE_CONTRACT_<CL_UPPER> so the next codeline's re-exec
# can inject the contract into its story agents' context.
#
# Retry policy: up to BRIDGE_MAX_RETRIES (default 2) re-attempts on failure or
# missing/empty output, with a corrective re-prompt on each retry explaining
# exactly what went wrong. After all retries:
#   CODELINE_BRIDGE_BLOCK_ON_FAILURE=true  → exit 1 (hard abort)
#   CODELINE_BRIDGE_BLOCK_ON_FAILURE=false → warn and continue (fe proceeds
#     without the contract — degraded but not pipeline-corrupting)
#
# $1 — completed codeline name (e.g. 'be')
# $2 — completed codeline worktree path
# $3 — filtered PRD path for the completed codeline
_run_codeline_bridge() {
  local _bcl="$1" _bwt="$2" _bprd="$3"
  local _bridge_out="${LOG_DIR}/cross-codeline-${_bcl}.md"
  local _profiles_file="$AUTOMATION_DIR/agents/profiles.json"
  local _bridge_max_retries="${BRIDGE_MAX_RETRIES:-2}"

  log "[bridge] Extracting cross-codeline contract for '${_bcl}' → ${_bridge_out}"

  # Load the codeline-bridge-agent profile
  local _bridge_profile=""
  if [ -f "$_profiles_file" ]; then
    _bridge_profile=$(python3 -c "
import sys, json
p = json.load(open('$_profiles_file'))
print(p.get('codeline-bridge-agent', ''))
" 2>/dev/null || true)
  fi
  if [ -z "$_bridge_profile" ]; then
    warning "[bridge] codeline-bridge-agent profile not found in profiles.json — skipping"
    return 0
  fi

  local _base_prompt="${_bridge_profile}

## Variables for this run

- BRIDGE_SRC_CODELINE: ${_bcl}
- BRIDGE_SRC_DIR: ${_bwt}
- BRIDGE_OUT_FILE: ${_bridge_out}
- BRIDGE_PRD_FILE: ${_bprd}

Extract the exported API surface from the '${_bcl}' codeline files and write the cross-codeline contract to ${_bridge_out}."

  local _bridge_attempt=0 _bridge_ok=0 _corrective_note=""
  while [ "$_bridge_attempt" -le "$_bridge_max_retries" ]; do
    # Prepend corrective note on retries so the agent knows exactly what failed
    local _bridge_prompt="${_corrective_note:+CORRECTION REQUIRED — YOUR PREVIOUS ATTEMPT FAILED: ${_corrective_note}

}${_base_prompt}"

    local _bridge_rc=0
    rm -f "$_bridge_out"
    # Tools granted below with no restricted allowlist (unlike the read-only
    # QA gates' ORCH_GATE_ALLOWED_TOOLS): this agent's whole job is
    # to read real source files in BRIDGE_SRC_DIR and WriteFile the extracted
    # contract to BRIDGE_OUT_FILE — the read-only allowlist would let it read
    # but never persist its own output. Found live (2026-07-31 agent audit):
    # this call went through plain run_orch_prompt with no tool grant at all,
    # under the pipeline's actual qwen/openai gate providers that means
    # --no-tools — the same class of gap already fixed once for
    # code-graph-detective/failure-analyst. Budgeted like every other
    # tool-bearing gate call in this file.
    AI_GATE_ALLOW_TOOLS=1 EPAM_MAX_TOOL_CALLS="${CODELINE_BRIDGE_MAX_TOOL_CALLS:-10}" \
        run_orch_prompt "$_bridge_prompt" "codeline-bridge-agent" "$_bcl" || _bridge_rc=$?

    # Determine success: exit 0 AND file exists AND file is non-empty
    if [ "$_bridge_rc" = "0" ] && [ -f "$_bridge_out" ] && [ -s "$_bridge_out" ]; then
      _bridge_ok=1
      break
    fi

    # Diagnose the specific failure for the corrective re-prompt
    if [ "$_bridge_rc" != "0" ]; then
      _corrective_note="run_orch_prompt exited with code ${_bridge_rc}. You must call WriteFile to write the contract to ${_bridge_out} before finishing."
    elif [ ! -f "$_bridge_out" ]; then
      _corrective_note="The file ${_bridge_out} was NOT written. You MUST call WriteFile with path=${_bridge_out} to produce the contract — do not finish without writing it."
    else
      _corrective_note="The file ${_bridge_out} was written but is EMPTY. The source directory ${_bwt} contains TypeScript files — read them and extract their exports before writing the contract."
    fi

    _bridge_attempt=$(( _bridge_attempt + 1 ))
    if [ "$_bridge_attempt" -le "$_bridge_max_retries" ]; then
      warning "[bridge] Attempt ${_bridge_attempt}/${_bridge_max_retries} failed for '${_bcl}' — retrying with corrective prompt"
    fi
  done

  if [ "$_bridge_ok" = "1" ]; then
    local _cl_upper="${_bcl^^}"
    export "CROSS_CODELINE_CONTRACT_${_cl_upper}=${_bridge_out}"
    export CROSS_CODELINE_CONTRACT="$_bridge_out"
    log "[bridge] ✓ Contract written: ${_bridge_out} (exported CROSS_CODELINE_CONTRACT_${_cl_upper})"
  else
    local _total_attempts=$(( _bridge_max_retries + 1 ))
    if [ "${CODELINE_BRIDGE_BLOCK_ON_FAILURE:-false}" = "true" ]; then
      error "[bridge] FATAL — contract extraction for '${_bcl}' failed after ${_total_attempts} attempt(s) and CODELINE_BRIDGE_BLOCK_ON_FAILURE=true. Aborting pipeline."
      return 1
    else
      warning "[bridge] Contract extraction for '${_bcl}' failed after ${_total_attempts} attempt(s) — downstream codelines proceed without cross-codeline contract (set CODELINE_BRIDGE_BLOCK_ON_FAILURE=true to abort instead)"
    fi
  fi
}
# Stop a lane and everything it spawned.
#
# A lane subshell is not the thing doing the work: it backgrounds `bash "$0"`,
# which runs the node LLM calls. `kill <lane pid>` orphans those rather than
# stopping them, so the halt reported an abort while the lane kept running and
# kept billing for ten more minutes (live AMSD-2041 2026-07-30). It only died
# by tripping over a PRD the parent's cleanup had already removed.
#
# Walks children before parents so nothing is reparented to init and left
# running. Deliberately NOT a process-group kill: lanes share this script's
# group, so `kill -- -$pgid` would take the orchestrator down with them.
_kill_lane_tree() {
  local _target="$1" _child
  [ -z "$_target" ] && return 0
  # Never accept our own PID or our parent's — that is self-termination
  # wearing a lane's clothes.
  if [ "$_target" = "$$" ] || [ "$_target" = "${BASHPID:-}" ] || [ "$_target" = "$PPID" ]; then
    return 0
  fi
  for _child in $(pgrep -P "$_target" 2>/dev/null); do
    _kill_lane_tree "$_child"
  done
  kill -TERM "$_target" 2>/dev/null || true
  return 0
}


# ── Jira pipeline mode ────────────────────────────────────────────────────────
# ── Shared codeline routing loop ──────────────────────────────────────────────
# Used by both Jira ingest flow and canonical PRD flow.
# Reads project.outputDirs from the PRD, validates/scaffolds worktrees, then
# re-execs itself (with JIRA_CODELINE_RUN=1) once per codeline per phase.
# The only difference between the two flows is how the PRD was sourced.
#
# $1 — path to PRD to route (synthesized or canonical)
# $2 — log file path (optional; defaults to a new tmp file)

# ── Run-scoped working directory ────────────────────────────────────────────
# Lane working files (per-codeline PRDs, cross-lane state) used to be written to a FLAT
# machine-global namespace: /tmp/orch-<codeline>-prd-<pid>.json. Every project and every
# concurrent run shared it, and archive-run-artifacts.sh then picked "the newest matching
# file" — so a clean mock1 run archived metrolinx's PRD, describing the wrong project, the
# wrong story and the wrong day (live 2026-08-05).
#
# Scoped to THIS run instead. Falls back to a private mktemp -d rather than the shared
# namespace when no run directory can be derived: a temp dir nobody else can glob is still
# isolated, which the old path never was.
_run_work_dir() {
    local _base="${EPAM_PROJECT_CONFIG_DIR:-}"
    if [ -n "$_base" ] && [ -n "${ORCH_RUN_ID:-}" ]; then
        local _d="$_base/runs/$ORCH_RUN_ID/work"
        mkdir -p "$_d" 2>/dev/null && { printf '%s' "$_d"; return 0; }
    fi
    mktemp -d "${TMPDIR:-/tmp}/orch-run-XXXXXX"
}

_run_codeline_loop() {
  local _prd_path="$1"
  local _log_file="${2:-/tmp/orch-$(date +%Y%m%dT%H%M%S).log}"
  # When the tier3 launcher (or any external phase-managing caller) drives the
  # phase loop itself (calling us once per phase via --phase X), set this to
  # run only that phase across all codelines. Empty = run every PRD phase.
  local _phase_filter="${3:-}"

  # Extract codeline:path entries from project.outputDirs.
  # Falls back to project.outputDir + JIRA_DEFAULT_CODELINE for single-codeline PRDs.
  local _cl_entries=()
  mapfile -t _cl_entries < <("$NODE_BIN" -e "
    const p = JSON.parse(require('fs').readFileSync('${_prd_path}','utf8'));
    const dirs = p.project && p.project.outputDirs ? p.project.outputDirs : [];
    if (dirs.length > 0) {
      dirs.forEach(d => console.log(d.codeline + ':' + d.path));
    } else {
      const cl  = process.env.JIRA_DEFAULT_CODELINE || '';
      const dir = p.project && p.project.outputDir ? p.project.outputDir : '';
      if (cl && dir) console.log(cl + ':' + dir);
    }
  " 2>/dev/null)

  if [ ${#_cl_entries[@]} -eq 0 ]; then
    error "[orch] No codeline/worktree entries found in PRD: ${_prd_path}"
    error "[orch] Add project.outputDirs to the PRD or set JIRA_DEFAULT_CODELINE + project.outputDir"
    return 1
  fi

  # ── Codeline health: assess every lane BEFORE spending anything ────────────
  # Live AMSD-2041, 2026-07-28: all three discovered codelines declared a test
  # script and a runner, and none could resolve one — two had no node_modules at
  # all. Until that morning Step 5 skipped silently on exactly this, so an
  # unverified baseline was accepted once per lane. Making it fail was right, but
  # it fails INSIDE the phase, after the spec pass is already paid for: the next
  # launch would have cost a full spec pass per lane to discover a dependency
  # problem visible in seconds.
  #
  # Runs on whatever DISCOVERY returned. The codelines are resolved per ticket at
  # runtime, so preparing a fixed list would hardcode discovery's output.
  # lib/codeline-health.sh knows no package manager, runner or language — it
  # reads what each codeline declares and prepares it accordingly.
  if [ -f "$SCRIPT_DIR/lib/codeline-health.sh" ]; then
    local _ch_paths=()
    for _entry in "${_cl_entries[@]}"; do _ch_paths+=("${_entry#*:}"); done
    log "[orch] Assessing health of ${#_ch_paths[@]} codeline(s) before starting work..."
    if ! NODE_BIN="$NODE_BIN" bash "$SCRIPT_DIR/lib/codeline-health.sh" "${_ch_paths[@]}"; then
      error "[orch] One or more codelines are UNHEALTHY — aborting before any spend."
      error "[orch]   A codeline that cannot resolve its own declared tooling cannot run its gates,"
      error "[orch]   so the run would accept an unverified baseline for that lane."
      error "[orch]   Set SKIP_CODELINE_HEALTH=1 to proceed knowing the gates cannot run."
      return 1
    fi
  fi

  # Tear down and re-scaffold every codeline worktree so each run starts clean.
  # Pre-existing worktrees from prior runs poison the next run (stale package.json,
  # accumulated artifacts, mid-run file mutations). Full deletion is the only safe state.
  for _entry in "${_cl_entries[@]}"; do
    local _cl="${_entry%%:*}" _wt="${_entry#*:}"
    log "[orch] Codeline '${_cl}' → ${_wt}"

    if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
      # ── Greenfield: full teardown + git init so every run starts clean ──
      # Stale package.json, accumulated artifacts, and mid-run file mutations from
      # prior runs all poison the next run. Full deletion is the only safe state.
      # Some node_modules subdirs end up 0444/0555 after npm install — force-write
      # access first so rm -rf is never blocked by restrictive permissions.
      if [ -d "$_wt" ]; then
        log "[orch] Tearing down '${_cl}' worktree at ${_wt}..."
        chmod -R u+w "$_wt" 2>/dev/null || true
        rm -rf "$_wt"
      fi

      local _scaffold="$SCRIPT_DIR/scaffold-${_cl}-repo.sh"
      if [ -f "$_scaffold" ]; then
        log "[orch] Scaffolding '${_cl}' repo at ${_wt}..."
        bash "$_scaffold" "$_wt" 2>&1 | tee -a "$_log_file"
      else
        # No scaffold script — create a bare git repo; agents fill in the stack.
        log "[orch] No scaffold-${_cl}-repo.sh found — creating bare git repo at ${_wt}..."
        mkdir -p "$_wt"
        git -C "$_wt" init --quiet
        git -C "$_wt" config user.email "epam-cli@local"
        git -C "$_wt" config user.name "epam-cli"
        git -C "$_wt" commit --allow-empty -m "init: ${_cl} codeline worktree" --quiet
      fi
    else
      # ── Brownfield: verify the existing repo; no teardown ──────────────────
      # The worktree must already exist as a git repository — agents modify
      # existing files in-place rather than building from scratch.
      if [ ! -d "$_wt" ]; then
        error "[orch] Brownfield worktree does not exist: ${_wt}"
        error "[orch] Codeline '${_cl}' must point to an existing local repository."
        return 1
      fi
      if [ ! -d "$_wt/.git" ]; then
        error "[orch] Brownfield worktree is not a git repository: ${_wt}"
        error "[orch] Ensure the path contains a .git directory."
        return 1
      fi
      log "[orch] Brownfield: using existing worktree '${_cl}' at ${_wt}"

      # Capture baseline SHA so gate diff oracles (review-ranger, mutant-hunter,
      # fuzz-weaver, sast-sentinel) diff only the story's changes against the
      # project's main branch — not the full commit history.
      local _baseline_branch="${JIRA_BASELINE_BRANCH:-main}"
      local _baseline_sha=""
      _baseline_sha=$(git -C "$_wt" rev-parse "origin/${_baseline_branch}" 2>/dev/null || \
                      git -C "$_wt" rev-parse "${_baseline_branch}" 2>/dev/null || \
                      git -C "$_wt" rev-parse HEAD 2>/dev/null || echo "")
      if [ -n "$_baseline_sha" ]; then
        echo "$_baseline_sha" > "$LOG_DIR/phase-baseline-sha.txt"
        log "[orch] Brownfield baseline: ${_baseline_branch} @ ${_baseline_sha:0:8}"
      else
        warning "[orch] Could not resolve baseline branch '${_baseline_branch}' — gate diffs will use HEAD"
      fi
    fi
    # Write .epam/ manifests if absent — these are consumed by run_dependency_check(),
    # generate_story_contract(), and apply_known_fix() in claude.sh. The tier3 launcher
    # writes them for canonical runs; the Jira codeline path must do the same so every
    # codeline worktree gets the manifests regardless of how many codelines exist.
    if [ ! -f "$_wt/.epam/dependency-check.json" ]; then
      mkdir -p "$_wt/.epam"
      cat > "$_wt/.epam/dependency-check.json" << 'DEPCHECK_EOF'
{
  "manifestFile": "package.json",
  "manifestKeys": ["dependencies", "devDependencies"],
  "scanFileExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  "importPattern": "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
  "installCommand": "npm install --save-dev {package}",
  "ignorePackages": ["assert","buffer","child_process","cluster","crypto","dgram","dns","domain","events","fs","http","http2","https","net","os","path","perf_hooks","process","punycode","querystring","readline","repl","stream","string_decoder","timers","tls","tty","url","util","v8","vm","worker_threads","zlib","node:assert","node:buffer","node:child_process","node:crypto","node:events","node:fs","node:http","node:https","node:net","node:os","node:path","node:process","node:stream","node:url","node:util","node:vm","node:zlib"],
  "requiredDevDependencies": ["typescript", "@types/node", "vitest", "tsx"],
  "vendorDirs": ["node_modules"]
}
DEPCHECK_EOF
      cat > "$_wt/.epam/contract-generation.json" << 'CONTRACTGEN_EOF'
{
  "language": "typescript",
  "sourceExtensions": [".ts"],
  "excludePattern": "\\.(test|spec)\\.ts$",
  "interfacePattern": "export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}",
  "classPattern": "export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{",
  "ctorPattern": "constructor\\s*\\(([^)]*)\\)",
  "methodPattern": "^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{",
  "interfaceRenderTemplate": "export interface {{name}} {{{body}}}",
  "classDeclarationTemplate": "export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}",
  "methodSignatureTemplate": "  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};",
  "asyncPrefixKeyword": "async ",
  "returnAnnotationPrefix": ": ",
  "mockFactoryTemplate": "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
  "mockMethodTemplateSync": "    {{methodName}}: vi.fn(),",
  "mockMethodTemplateAsync": "    {{methodName}}: vi.fn().mockResolvedValue(undefined),",
  "testFileExtensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  "testFilePattern": "\\.(test|spec)\\.[a-zA-Z0-9]+$",
  "mockFactoryStartPattern": "vi\\.mock\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\{",
  "mockClassPattern": "(\\w+)\\s*:\\s*vi\\.fn\\(\\)\\.mockImplementation\\(\\(\\)\\s*=>\\s*\\(\\{",
  "mockedMethodPattern": "^\\s*(\\w+)\\s*:",
  "testFileAgentRole": "test-engineer"
}
CONTRACTGEN_EOF
      cat > "$_wt/.epam/known-fixes.json" << 'KNOWNFIXES_EOF'
[
  {
    "id": "vitest-pass-with-no-tests",
    "symptomPattern": "(?:vitest|test).*(?:no test files|zero test files).*exit|exit.*1.*(?:no|zero) test files|passWithNoTests",
    "targetFile": "vitest.config.ts",
    "checkPattern": "passWithNoTests",
    "insertAfterPattern": "test:\\s*\\{",
    "insertText": "\n    passWithNoTests: true,"
  }
]
KNOWNFIXES_EOF
      log "[orch] Wrote .epam/ manifests to ${_wt} (dependency-check, contract-generation, known-fixes)"
    fi

    # ── Plugin provisioning: config-driven, zero project-specific hardcoding ──
    # This script has no idea what a "plugin" IS or does, with ONE exception:
    # CodeGraph's query tool (orchestrations/plugins/codegraph-tools.js) ships
    # with epam-cli itself — the same way ReadFile/Bash are always available
    # regardless of project — so it's provisioned for EVERY codeline
    # unconditionally, merged with whatever the project's own plugins.json
    # adds on top (never overwritten, never required to list it manually).
    # Everything else remains purely config-driven: EPAM_PROJECT_CONFIG_DIR/
    # codeline-facts.json (keyed by codeline name) has its entry for THIS
    # codeline extracted into .epam/codeline-facts.json. Adding, removing, or
    # repointing a PROJECT-specific plugin is purely a config edit in the
    # project's own directory — never a change to this script.
    local _project_tools_json="[]"
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" ]; then
      _project_tools_json=$(jq -c '.tools // []' "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" 2>/dev/null || echo "[]")
    fi
    local _codegraph_plugin_abs=""
    local _codegraph_plugin_src="${SCRIPT_DIR}/../plugins/codegraph-tools.js"
    if [ -f "$_codegraph_plugin_src" ]; then
      _codegraph_plugin_abs="$(cd "$(dirname "$_codegraph_plugin_src")" 2>/dev/null && pwd)/$(basename "$_codegraph_plugin_src")"
    fi
    if [ -n "$_codegraph_plugin_abs" ] || [ "$_project_tools_json" != "[]" ]; then
      mkdir -p "$_wt/.epam"
      jq -n --argjson project "$_project_tools_json" --arg cg "$_codegraph_plugin_abs" \
        '{tools: (((if $cg != "" then [$cg] else [] end) + $project) | unique)}' \
        > "$_wt/.epam/settings.json"
      log "[orch] Provisioned .epam/settings.json (plugins, incl. built-in CodeGraph tool) for '${_cl}'"
    fi

    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
      local _facts_cfg="${EPAM_PROJECT_CONFIG_DIR}/codeline-facts.json"
      if [ -f "$_facts_cfg" ]; then
        local _cl_facts
        _cl_facts=$(jq -c --arg cl "$_cl" '.[$cl] // empty' "$_facts_cfg" 2>/dev/null)
        if [ -n "$_cl_facts" ]; then
          mkdir -p "$_wt/.epam"
          echo "$_cl_facts" > "$_wt/.epam/codeline-facts.json"
          log "[orch] Provisioned .epam/codeline-facts.json for '${_cl}' from ${_facts_cfg}"
        fi
      fi

      # .env.local: derived from the codeline's OWN .env.local.sample, not an
      # engine-side list. See provision_env_local_from_sample().
      provision_env_local_from_sample "$_wt" "$_wt/.env.local"
      if [ -s "$_wt/.env.local" ]; then
        log "[orch] Provisioned .env.local for '${_cl}' from ${_wt}/.env.local.sample"
      fi

      # anti-patterns.json (optional, per-project): not keyed by codeline —
      # copied whole into .epam/ so the check_anti_patterns plugin tool (and
      # run_anti_pattern_check's deterministic gate) both read the same,
      # already-provisioned file instead of reaching across worktree
      # boundaries into EPAM_PROJECT_CONFIG_DIR directly.
      local _antipatterns_cfg="${EPAM_PROJECT_CONFIG_DIR}/anti-patterns.json"
      if [ -f "$_antipatterns_cfg" ]; then
        mkdir -p "$_wt/.epam"
        cp "$_antipatterns_cfg" "$_wt/.epam/anti-patterns.json"
        log "[orch] Provisioned .epam/anti-patterns.json for '${_cl}' from ${_antipatterns_cfg}"
      fi
    fi
  done



  # Per-codeline execution loop
  local _work_dir; _work_dir="$(_run_work_dir)"
  local _overall=0 _completed_list="" _cross_prd="$_work_dir/cross.json"
  local _cl_prds=()


  # Rebuild cumulative cross-codeline PRD so later codelines can check
  # completed stories from earlier codelines (is_story_completed fallback).
  _rebuild_cross() {
    [ -z "$_completed_list" ] && { unset CROSS_CODELINE_PRD; return; }
    COMPLETED_LIST="$_completed_list" \
    "$NODE_BIN" -e "
      const fs = require('fs');
      const paths = (process.env.COMPLETED_LIST||'').split(':').filter(Boolean);
      const stories = paths.flatMap(p => {
        try { return JSON.parse(fs.readFileSync(p,'utf8')).stories||[]; } catch { return []; }
      });
      fs.writeFileSync('${_cross_prd}', JSON.stringify({stories},null,2));
    " 2>/dev/null
    export CROSS_CODELINE_PRD="$_cross_prd"
  }

  # Build filtered PRD containing only stories for codeline $1, written to $2.
  # Returns story count on stdout.
  _filtered_prd() {
    local _fcl="$1" _fout="$2" _fsrc="$3"
    JIRA_DEFAULT_CODELINE="${JIRA_DEFAULT_CODELINE:-}" \
    "$NODE_BIN" -e "
      const fs  = require('fs');
      const prd = JSON.parse(fs.readFileSync('${_fsrc}','utf8'));
      const cl  = '${_fcl}', dcl = process.env.JIRA_DEFAULT_CODELINE||'';
      // A story may SPAN codelines. codelines[] is authoritative when present:
      // the story stays whole and participates in each lane's execution, rather
      // than being partitioned into exactly one. Without this it matches no
      // partition, appears in zero filtered PRDs, and is silently dropped from
      // the run — which is how a [GO, UP, MX] ticket reached ingest and died.
      const stories = prd.stories.filter(s =>
        (Array.isArray(s.codelines) && s.codelines.length
          ? s.codelines.includes(cl)
          : (s.codeline === cl || (!s.codeline && cl === dcl)))
      // THIS LANE'S PRD SAYS WHICH LANE IT IS.
      //
      // Stories were copied through unchanged, so a story spanning three codelines carried
      // its PRIMARY codeline into all three lane PRDs. Every consumer reading the singular
      // field then got the same answer everywhere: the detective resolved the first lane's
      // investigator in all three lanes and investigated two repositories with a brief written
      // for a different one. agentRole had the identical defect, and project.outputDir vs
      // outputDirs a third instance.
      //
      // Fixed HERE rather than in each reader. A lane's PRD describing a different lane is the
      // lie; once it tells the truth, every consumer — the detective, the guards, the manifest,
      // whatever is added next — is correct without knowing lanes exist. codelines[] is left
      // intact, so nothing loses the knowledge that the story spans more than this one.
      ).map(s => ({ ...s, codeline: cl }));
      const ids = new Set(stories.map(s => s.id));
      const order = {};
      for (const [phase, list] of Object.entries(prd.implementationOrder||{})) {
        const f = (list||[]).filter(id => ids.has(id));
        if (f.length > 0) order[phase] = f;
      }
      if (Object.keys(order).length === 0) order.core = stories.map(s => s.id);
      const out = {...prd, stories, implementationOrder: order};
      if (prd.project && prd.project.outputDirs) {
        const d = prd.project.outputDirs.find(d => d.codeline === cl);
        if (d) out.project = {...prd.project, outputDir: d.path};
      }
      fs.writeFileSync('${_fout}', JSON.stringify(out, null, 2));
      console.log(stories.length);
    " 2>/dev/null
  }

  _prd_phases() {
    "$NODE_BIN" -e "
      const p = JSON.parse(require('fs').readFileSync('$1','utf8'));
      console.log(Object.keys(p.implementationOrder||{}).join('\n'));
    " 2>/dev/null
  }

  # ── Lane execution: parallel by default ────────────────────────────────────
  # Lanes of a spanning story are independent units of work; running them in
  # sequence costs (N-1) x lane-duration in wall clock. On AMSD-2041 three
  # ~20-minute lanes take an hour to do 20 minutes of work.
  #
  # THREE THINGS SEQUENCING GAVE FOR FREE, and how each is kept:
  #
  #  1. The canonical PRD merge. Every lane writes the same file, so concurrent
  #     merges would clobber each other. Workers therefore never merge: each
  #     writes only its own filtered PRD, and the merges run here, after the
  #     wait, one at a time in declared order.
  #  2. The halt rule. Sequencing prevented spend outright. In parallel the
  #     lanes are already running, so the equivalent is to abort the survivors
  #     the moment one fails. Money already spent cannot be recovered; money not
  #     yet spent still can.
  #  3. The cross-codeline contract. _run_codeline_bridge feeds one lane's
  #     exported API into the NEXT lane's prompt, which presupposes an upstream
  #     that has already finished. In parallel there is no upstream, so it is
  #     skipped with a warning rather than silently writing a contract nobody
  #     consumed. Lanes that genuinely integrate must set
  #     EPAM_PARALLEL_CODELINES=0.
  _EPAM_PARALLEL_LANES="${EPAM_PARALLEL_CODELINES:-1}"
  if [ "$_EPAM_PARALLEL_LANES" = "1" ] && [ "${#_cl_entries[@]}" -gt 1 ]; then
    local _p_cls=() _p_wts=() _p_prds=() _p_pids=()
    local _p_statusdir; _p_statusdir="$(mktemp -d /tmp/orch-lanes-XXXXXX)"

    for _entry in "${_cl_entries[@]}"; do
      local _cl="${_entry%%:*}" _wt="${_entry#*:}"
      local _cl_prd="$_work_dir/${_cl}-prd.json"
      _cl_prds+=("$_cl_prd")
      local _n_stories
      _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")
      if [ "${_n_stories:-0}" -eq 0 ]; then
        log "[orch] Codeline '${_cl}': no stories — skipping"
        continue
      fi
      _p_cls+=("$_cl"); _p_wts+=("$_wt"); _p_prds+=("$_cl_prd")
      log "[orch] Codeline '${_cl}' — ${_n_stories} stories → ${_wt}"
    done

    if [ "${#_p_cls[@]}" -gt 1 ]; then
      warning "[orch] Parallel lanes: cross-codeline contract bridge SKIPPED — no lane is upstream of another."
      warning "[orch]   Set EPAM_PARALLEL_CODELINES=0 if these lanes integrate with each other."
    fi

    log "[orch] Launching ${#_p_cls[@]} codeline(s) in PARALLEL..."
    _lane_idx=0
    while [ "$_lane_idx" -lt "${#_p_cls[@]}" ]; do
      _cl="${_p_cls[$_lane_idx]}"
      _wt="${_p_wts[$_lane_idx]}"
      _cl_prd="${_p_prds[$_lane_idx]}"
      _lane_status="${_p_statusdir}/${_cl}.status"
      (
        _log_file="${LOG_DIR:-/tmp}/lane-${_cl}.log"
        # ── Per-lane LOG_DIR ──────────────────────────────────────────────
        # Lanes used to inherit ONE LOG_DIR, and several files in it are read
        # back as STATE rather than merely written as logs. The proven case is
        # phase-baseline-sha.txt, the git SHA every diff-based gate uses to
        # decide what a story changed. With three lanes on three different
        # repositories the last writer won, so two lanes diffed against a commit
        # that does not exist in them — an empty diff, and review-ranger /
        # mutant-hunter / team-lead-review passing on ZERO files. A false pass on
        # unreviewed code, which is worse than a crash because it looks like
        # success. Live metrolinx 2026-07-29, killed on discovery of this.
        #
        # Scoping LOG_DIR fixes every such file at once — the baseline SHA, the
        # review-incomplete-<phase> flag (PHASE is identical across lanes), the
        # story-outputs manifest and the worktree logs — instead of patching each
        # call site in seven scripts and missing the eighth.
        _lane_log_dir="${LOG_DIR:-/tmp}/lanes/${_cl}"
        mkdir -p "$_lane_log_dir" 2>/dev/null || true
        _cl_failed=0
    local _phases=()
    mapfile -t _phases < <(_prd_phases "$_cl_prd")
    local _cl_failed=0

    for _phase in "${_phases[@]}"; do
      [ -z "$_phase" ] && continue
      # When the tier3 launcher (or any external caller) manages phases externally
      # by calling run-agent-orchestration.sh once per phase, honour its filter so
      # only the requested phase runs. Without this, a --phase scaffold call would
      # still execute every phase across every codeline (double-execution bug).
      if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then
        log "[orch] Phase '${_phase}' — skipping (caller phase filter: '${_phase_filter}')"
        continue
      fi
      log "[orch] Phase '${_phase}' — codeline '${_cl}'..."
      local _pex=0
      JIRA_CODELINE_RUN=1 \
      EPAM_CODELINE="$_cl" \
      LOG_DIR="$_lane_log_dir" \
      PRD_FILE="$_cl_prd" \
      PROJECT_ROOT="$_wt" \
      OUTPUT_DIR="$_wt" \
      PHASE="$_phase" \
      CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
      bash "$0" --reset 2>&1 | tee -a "$_log_file"
      # No pipefail in this script, so `| tee || _pex=` tests tee's exit (0) and never
      # fires — a phase exit-2 (gate block) was masked to _pex=0 → "done" → PASSED
      # (live AMSD-1820 run #3). Capture the inner orch's real exit; tee exits 0 so set -e is fine.
      _pex=${PIPESTATUS[0]}

      # exit 2 = gate remediation applied — reset stories and retry once (mirrors tier3 launcher)
      if [ "$_pex" -eq 2 ]; then
        log "[orch] Gate remediation applied for '${_phase}' ('${_cl}') — retrying with SKIP_GATE_REMEDIATION=1"
        _pex=0
        JIRA_CODELINE_RUN=1 \
      EPAM_CODELINE="$_cl" \
      LOG_DIR="$_lane_log_dir" \
        PRD_FILE="$_cl_prd" \
        PROJECT_ROOT="$_wt" \
        OUTPUT_DIR="$_wt" \
        PHASE="$_phase" \
        SKIP_GATE_REMEDIATION=1 \
        CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
        bash "$0" --reset 2>&1 | tee -a "$_log_file"
        _pex=${PIPESTATUS[0]}
        if [ "$_pex" -ne 0 ]; then
          error "[orch] Phase '${_phase}' for '${_cl}' failed after self-healing retry (exit $_pex)"
        else
          log "[orch] Self-healing retry succeeded for '${_phase}' ('${_cl}')"
        fi
      fi

      if [ "$_pex" -ne 0 ]; then
        error "[orch] Phase '${_phase}' for '${_cl}' failed (exit $_pex)"
        _cl_failed=1; _overall=1; break
      fi
      log "[orch] Phase '${_phase}' — '${_cl}' done."
    done

    [ "$_cl_failed" = "0" ] && \
      _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"
        echo "$_cl_failed" > "$_lane_status"
      ) &
      _p_pids+=("$!")
      _lane_idx=$(( _lane_idx + 1 ))
    done

    _p_any_failed=0
    _p_running=1
    while [ "$_p_running" = "1" ]; do
      _p_running=0
      for _pid in "${_p_pids[@]}"; do
        kill -0 "$_pid" 2>/dev/null && _p_running=1
      done
      for _cl in "${_p_cls[@]}"; do
        if [ -f "${_p_statusdir}/${_cl}.status" ] && [ "$(cat "${_p_statusdir}/${_cl}.status" 2>/dev/null)" != "0" ]; then
          _p_any_failed=1
        fi
      done
      # Default: let sibling lanes run to natural completion even after one
      # lane has failed. Found live 2026-08-02 (Writer Retest, AMSD-2041):
      # gotransit failed on a deterministic gate blocking on a pre-existing,
      # unrelated broken import (see run_relative_import_check's scope fix,
      # same incident) — a FALSE failure — which killed upexpress and
      # metrolinx mid-attempt via SIGTERM, discarding real, valid,
      # independent work those lanes were producing. The per-lane fold-back
      # logic below already records each lane's own outcome independently
      # (a spanning story is complete only when NO lane is outstanding) —
      # nothing downstream needed the early kill. Set
      # EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1 to restore the old behavior
      # (stop spending immediately once any lane's outcome is known to have
      # failed) for cost-conscious runs where sibling lanes' work has no
      # independent value once one lane is lost.
      if [ "${EPAM_CASCADE_ABORT_ON_LANE_FAILURE:-0}" = "1" ] && [ "$_p_any_failed" = "1" ] && [ "$_p_running" = "1" ]; then
        error "[orch] HALT: a codeline failed after its retries and self-heal completed."
        error "[orch]   Aborting the codeline(s) still running (EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1) —"
        error "[orch]   recovery is exhausted, so letting them finish would spend on a run already decided."
        for _pid in "${_p_pids[@]}"; do _kill_lane_tree "$_pid"; done
        break
      fi
      [ "$_p_running" = "1" ] && sleep 5
    done
    wait 2>/dev/null || true

    _lane_idx=0
    while [ "$_lane_idx" -lt "${#_p_cls[@]}" ]; do
      _cl="${_p_cls[$_lane_idx]}"
      _cl_prd="${_p_prds[$_lane_idx]}"
      _cl_failed=1
      [ -f "${_p_statusdir}/${_cl}.status" ] && _cl_failed="$(cat "${_p_statusdir}/${_cl}.status" 2>/dev/null || echo 1)"
      # ── Fold this lane's ledgers back into the parent ────────────────────
      # Per-lane LOG_DIR fixed cross-lane state corruption, and fragmented the
      # cost ledger as a side effect: every reader of the canonical path — the
      # dashboard, validate-dashboards.sh, the run report — saw an EMPTY
      # phase-cost.jsonl for a parallel run while the real records sat in
      # lanes/<codeline>/. Cost tracking that silently reports zero is worse than
      # none, so the append-only ledgers are concatenated back, in declared lane
      # order, once the lane has finished writing them.
      for _ledger in phase-cost.jsonl agent-activity.jsonl healing-events.jsonl; do
        if [ -n "${LOG_DIR:-}" ] && [ -s "${LOG_DIR}/lanes/${_cl}/${_ledger}" ]; then
          cat "${LOG_DIR}/lanes/${_cl}/${_ledger}" >> "${LOG_DIR}/${_ledger}" 2>/dev/null || true
        fi
      done

      # PER-LANE OUTCOME, RECORDED. Lanes have their own log dir, PRD, worktree, investigator
      # and writer, run in parallel, and this script states that no lane is upstream of
      # another — then the result collapsed into one exit code, so one lane's gate decision
      # failed a run in which the others had cleared. Live 2026-08-07: two lanes reached the
      # writer pause cleanly and the run reported failure because a third was blocked by the
      # spec review gate. Nothing said which, or that two-thirds of the work was fine.
      _LANE_OUTCOMES="${_LANE_OUTCOMES:+${_LANE_OUTCOMES}
}${_cl}	$([ "$_cl_failed" = "0" ] && echo ok || echo blocked)"
      if [ "$_cl_failed" = "0" ]; then
        _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"
      else
        # Always explain a failed lane, even when every lane had already
        # finished by the time the abort poll noticed. Without this the run ends
        # non-zero with no statement of which lane died or why the others were
        # stopped — the operator is left diffing timestamps.
        error "[orch] codeline '${_cl}' did not complete — its retries and self-heal are exhausted."
        # LANE INDEPENDENCE HOLDS THROUGH FAILURE (operator decision, 2026-08-07).
        #
        # A lane that does not complete does not invalidate the ones that did. Nothing here
        # reaches a client remote: work lands on a per-story branch cut from origin/<baseline>,
        # and merging it is a human decision taken per codeline. Denying two lanes' work
        # because a third drew a gate failure — from a gate that has proven unstable — is the
        # worse trade.
        #
        # EPAM_LANE_FAILURE_IS_FATAL=1 restores all-or-nothing for a project where a change
        # must land everywhere or nowhere.
        if [ "${EPAM_LANE_FAILURE_IS_FATAL:-0}" = "1" ]; then
          error "[orch] HALT: EPAM_LANE_FAILURE_IS_FATAL=1 — one lane failing fails the run."
          _overall=1
        fi
      fi
    # Merge this codeline's final story state (status/completed/completedAt/
    # testCriteria/etc — whatever claude.sh/TC-writer wrote into the filtered
    # temp copy during real execution) back into the canonical PRD. Without
    # this, _cl_prd is the only file that ever held the real completion
    # result, and it was being deleted at the end of the loop — so the
    # canonical PRD (the file every downstream consumer, dashboard, and test
    # actually reads) stayed "pending" forever even after a real, successful
    # run. Found live 2026-07-23 via mock1.
    "$NODE_BIN" -e "
      const fs = require('fs');
      const canonical = JSON.parse(fs.readFileSync('${_prd_path}', 'utf8'));
      const updated = JSON.parse(fs.readFileSync('${_cl_prd}', 'utf8'));
      const byId = new Map(updated.stories.map(s => [s.id, s]));
      const CL = '${_cl}';
      canonical.stories = canonical.stories.map(s => {
        const u = byId.get(s.id);
        if (!u) return s;
        // A story confined to one codeline merges wholesale, exactly as before.
        const spans = Array.isArray(s.codelines) && s.codelines.length > 1;
        if (!spans) return u;
        // A SPANNING story is touched by every lane, so a whole-object merge is
        // last-writer-wins: a story that failed in one codeline and succeeded in
        // another would read as whichever lane happened to run last. Record each
        // lane's outcome separately and derive the story's own state from all of
        // them — it is complete only when NO lane is outstanding.
        const perCodeline = { ...(s.perCodeline || {}), [CL]: {
          status: u.status, completed: !!u.completed, completedAt: u.completedAt || null,
          reviewStatus: u.reviewStatus || null,
        } };
        const everyLaneDone = s.codelines.every(cl =>
          perCodeline[cl] && perCodeline[cl].completed === true);
        return {
          ...u,
          perCodeline,
          codelines: s.codelines,
          completed: everyLaneDone,
          status: everyLaneDone ? 'completed' : 'in-progress',
          completedAt: everyLaneDone ? (u.completedAt || new Date().toISOString()) : null,
        };
      });
      // Stories CREATED during the run exist only in the codeline PRD, and a map
      // over canonical can never add them. The spec pass splits a story into
      // <id>-impl / <id>-test there and marks the parent deprecated — so without
      // this, mock1 run 10 implemented, tested, reviewed and committed two child
      // stories, and canonical kept nothing but a deprecated parent. Every reader
      // of that PRD — the run report, a rerun deciding what is outstanding, a
      // human — would conclude the run delivered nothing.
      const known = new Set(canonical.stories.map(s => s.id));
      for (const u of updated.stories) {
        if (!known.has(u.id)) canonical.stories.push(u);
      }
      fs.writeFileSync('${_prd_path}', JSON.stringify(canonical, null, 2));
    " 2>/dev/null && log "[orch] Merged codeline '${_cl}' story state back into canonical PRD"
      _lane_idx=$(( _lane_idx + 1 ))
    done
    rm -rf "$_p_statusdir" 2>/dev/null || true
  else
  for _entry in "${_cl_entries[@]}"; do
    local _cl="${_entry%%:*}" _wt="${_entry#*:}"
    local _cl_prd="$_work_dir/${_cl}-prd.json"
    _cl_prds+=("$_cl_prd")

    local _n_stories
    _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")

    if [ "${_n_stories:-0}" -eq 0 ]; then
      log "[orch] Codeline '${_cl}': no stories — skipping"
      continue
    fi

    _rebuild_cross
    log "[orch] Codeline '${_cl}' — ${_n_stories} stories → ${_wt}"

    local _phases=()
    mapfile -t _phases < <(_prd_phases "$_cl_prd")
    local _cl_failed=0

    for _phase in "${_phases[@]}"; do
      [ -z "$_phase" ] && continue
      # When the tier3 launcher (or any external caller) manages phases externally
      # by calling run-agent-orchestration.sh once per phase, honour its filter so
      # only the requested phase runs. Without this, a --phase scaffold call would
      # still execute every phase across every codeline (double-execution bug).
      if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then
        log "[orch] Phase '${_phase}' — skipping (caller phase filter: '${_phase_filter}')"
        continue
      fi
      log "[orch] Phase '${_phase}' — codeline '${_cl}'..."
      local _pex=0
      JIRA_CODELINE_RUN=1 \
      PRD_FILE="$_cl_prd" \
      PROJECT_ROOT="$_wt" \
      OUTPUT_DIR="$_wt" \
      PHASE="$_phase" \
      CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
      bash "$0" --reset 2>&1 | tee -a "$_log_file"
      # No pipefail in this script, so `| tee || _pex=` tests tee's exit (0) and never
      # fires — a phase exit-2 (gate block) was masked to _pex=0 → "done" → PASSED
      # (live AMSD-1820 run #3). Capture the inner orch's real exit; tee exits 0 so set -e is fine.
      _pex=${PIPESTATUS[0]}

      # exit 2 = gate remediation applied — reset stories and retry once (mirrors tier3 launcher)
      if [ "$_pex" -eq 2 ]; then
        log "[orch] Gate remediation applied for '${_phase}' ('${_cl}') — retrying with SKIP_GATE_REMEDIATION=1"
        _pex=0
        JIRA_CODELINE_RUN=1 \
        PRD_FILE="$_cl_prd" \
        PROJECT_ROOT="$_wt" \
        OUTPUT_DIR="$_wt" \
        PHASE="$_phase" \
        SKIP_GATE_REMEDIATION=1 \
        CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
        bash "$0" --reset 2>&1 | tee -a "$_log_file"
        _pex=${PIPESTATUS[0]}
        if [ "$_pex" -ne 0 ]; then
          error "[orch] Phase '${_phase}' for '${_cl}' failed after self-healing retry (exit $_pex)"
        else
          log "[orch] Self-healing retry succeeded for '${_phase}' ('${_cl}')"
        fi
      fi

      if [ "$_pex" -ne 0 ]; then
        error "[orch] Phase '${_phase}' for '${_cl}' failed (exit $_pex)"
        _cl_failed=1; _overall=1; break
      fi
      log "[orch] Phase '${_phase}' — '${_cl}' done."
    done

    [ "$_cl_failed" = "0" ] && \
      _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"

    # Run codeline-bridge agent after each successful codeline (multi-codeline PRDs only).
    # Extracts exported types/functions/endpoints and writes a cross-codeline contract
    # consumed by downstream codeline agents via CROSS_CODELINE_CONTRACT_<CL_UPPER>.
    if [ "$_cl_failed" = "0" ] && [ "${#_cl_entries[@]}" -gt 1 ]; then
      _run_codeline_bridge "$_cl" "$_wt" "$_cl_prd"
    fi

    # Merge this codeline's final story state (status/completed/completedAt/
    # testCriteria/etc — whatever claude.sh/TC-writer wrote into the filtered
    # temp copy during real execution) back into the canonical PRD. Without
    # this, _cl_prd is the only file that ever held the real completion
    # result, and it was being deleted at the end of the loop — so the
    # canonical PRD (the file every downstream consumer, dashboard, and test
    # actually reads) stayed "pending" forever even after a real, successful
    # run. Found live 2026-07-23 via mock1.
    "$NODE_BIN" -e "
      const fs = require('fs');
      const canonical = JSON.parse(fs.readFileSync('${_prd_path}', 'utf8'));
      const updated = JSON.parse(fs.readFileSync('${_cl_prd}', 'utf8'));
      const byId = new Map(updated.stories.map(s => [s.id, s]));
      const CL = '${_cl}';
      canonical.stories = canonical.stories.map(s => {
        const u = byId.get(s.id);
        if (!u) return s;
        // A story confined to one codeline merges wholesale, exactly as before.
        const spans = Array.isArray(s.codelines) && s.codelines.length > 1;
        if (!spans) return u;
        // A SPANNING story is touched by every lane, so a whole-object merge is
        // last-writer-wins: a story that failed in one codeline and succeeded in
        // another would read as whichever lane happened to run last. Record each
        // lane's outcome separately and derive the story's own state from all of
        // them — it is complete only when NO lane is outstanding.
        const perCodeline = { ...(s.perCodeline || {}), [CL]: {
          status: u.status, completed: !!u.completed, completedAt: u.completedAt || null,
          reviewStatus: u.reviewStatus || null,
        } };
        const everyLaneDone = s.codelines.every(cl =>
          perCodeline[cl] && perCodeline[cl].completed === true);
        return {
          ...u,
          perCodeline,
          codelines: s.codelines,
          completed: everyLaneDone,
          status: everyLaneDone ? 'completed' : 'in-progress',
          completedAt: everyLaneDone ? (u.completedAt || new Date().toISOString()) : null,
        };
      });
      // Stories CREATED during the run exist only in the codeline PRD, and a map
      // over canonical can never add them. The spec pass splits a story into
      // <id>-impl / <id>-test there and marks the parent deprecated — so without
      // this, mock1 run 10 implemented, tested, reviewed and committed two child
      // stories, and canonical kept nothing but a deprecated parent. Every reader
      // of that PRD — the run report, a rerun deciding what is outstanding, a
      // human — would conclude the run delivered nothing.
      const known = new Set(canonical.stories.map(s => s.id));
      for (const u of updated.stories) {
        if (!known.has(u.id)) canonical.stories.push(u);
      }
      fs.writeFileSync('${_prd_path}', JSON.stringify(canonical, null, 2));
    " 2>/dev/null && log "[orch] Merged codeline '${_cl}' story state back into canonical PRD"

    # ── Halt once a lane has finally failed ───────────────────────────────────
    # The failure path inside the PHASE loop above ends in a bare `break`, which
    # leaves that inner loop only — the CODELINE loop carried on to the next
    # lane. Live AMSD-2041 (2026-07-28): 'gotransit' hit a FATAL after 3/3 spec
    # attempts and the self-heal retry, and five seconds later the run started
    # 'upexpress'. A comment below this loop asserted "Lane failures already stop
    # the loop"; it was never true, and being written down is what kept anyone
    # from checking.
    #
    # By this point retries, the ladder and self-heal have ALL completed and the
    # step is still failed — the standing mandate is to stop there. The merge
    # above runs first deliberately, so the canonical PRD still records where the
    # run died. Nothing is guessed about WHY it failed: a lane that reached here
    # exhausted every recovery the pipeline has.
    if [ "$_cl_failed" = "1" ]; then
      error "[orch] HALT: codeline '${_cl}' failed after its retries and self-heal completed."
      error "[orch]   Not starting the remaining codeline(s) — recovery is exhausted, so"
      error "[orch]   another lane would reproduce the same failure at full ladder price."
      break
    fi
  done
  fi

  # ── Partial coverage is a failure, not a pass ──────────────────────────────
  # A spanning story names the codelines it must be delivered in. Lane failures
  # already stop the loop; this catches the quieter case — a lane that never ran,
  # or ran and produced no result for this story — where every lane "succeeded",
  # the pipeline reports complete, and part of the work simply never happened.
  # Checked against what the story DECLARED, not against how many lanes we
  # happened to execute.
  if [ "$_overall" = "0" ] && [ -f "$_prd_path" ]; then
    _mc_incomplete=$("$NODE_BIN" -e "
      const fs = require('fs');
      const prd = JSON.parse(fs.readFileSync('${_prd_path}', 'utf8'));
      const bad = [];
      for (const s of (prd.stories || [])) {
        const want = Array.isArray(s.codelines) ? s.codelines : [];
        if (want.length < 2) continue;                 // not a spanning story
        const got = s.perCodeline || {};
        const missing = want.filter(cl => !got[cl]);
        if (missing.length) bad.push(s.id + ' → no result for: ' + missing.join(', '));
      }
      process.stdout.write(bad.join('; '));
    " 2>/dev/null || true)
    if [ -n "$_mc_incomplete" ]; then
      error "[orch] Spanning story INCOMPLETE — a declared codeline never ran: ${_mc_incomplete}"
      error "[orch] The run touched fewer codelines than the story requires; this is not a success."
      _overall=1
    fi
  fi

  # NOT deleted. This `rm -f` was /tmp hygiene: the lane PRDs used to live in a shared,
  # machine-global namespace and had to be swept. They now live in this run's OWN directory
  # (<project-config>/runs/<run-id>/work/), which makes them run EVIDENCE — the archiver
  # reads the working PRD from there, and deleting it first is why working-prd.json came
  # back "missing" on run 20260805T182214Z after the isolation fix.
  #
  # The cross-lane scratch file has no evidentiary value and is still removed.
  rm -f "$_cross_prd" 2>/dev/null || true
  unset CROSS_CODELINE_PRD

  # THE SUMMARY IS THE POINT. A story spanning codelines can now finish with some lanes
  # complete and some not, and the one thing that must never happen is someone merging two of
  # three without knowing the third is missing.
  if [ -n "${_LANE_OUTCOMES:-}" ]; then
    local _ok_n _blocked_n
    _ok_n=$(printf '%s\n' "$_LANE_OUTCOMES" | grep -c 'ok$' || true)
    _blocked_n=$(printf '%s\n' "$_LANE_OUTCOMES" | grep -c 'blocked$' || true)
    log "[orch] Lane outcomes — ${_ok_n} completed, ${_blocked_n} did not:"
    printf '%s\n' "$_LANE_OUTCOMES" | while IFS=$'\t' read -r _lc _ls; do
      [ -n "$_lc" ] || continue
      if [ "$_ls" = "ok" ]; then log "[orch]   ✓ ${_lc}"; else error "[orch]   ✗ ${_lc} — did not complete"; fi
    done
    if [ "${_blocked_n:-0}" != "0" ] && [ "${_ok_n:-0}" != "0" ]; then
      warning "[orch] This story spans codelines and did NOT complete on all of them."
      warning "[orch] Work sits on a per-story branch in each completed codeline; merging is yours to decide."
      warning "[orch] Set EPAM_LANE_FAILURE_IS_FATAL=1 if this project requires all-or-nothing."
    fi
  fi

  [ "$_overall" = "0" ] \
    && log "[orch] ✅ Pipeline complete." \
    || error "[orch] ⚠️  Pipeline completed with errors."

  return $_overall
}

# ── Jira ingest flow ───────────────────────────────────────────────────────────
# JIRA_PIPELINE=1: pull tickets, run AC gate, synthesize PRD, then route codelines.
_run_jira_pipeline() {
  local _jira_dir="$AUTOMATION_DIR/jira"
  local _log_file="/tmp/orch-$(date +%Y%m%dT%H%M%S).log"

  local _missing=()
  [ -z "${JIRA_URL:-}"         ] && _missing+=("JIRA_URL")
  [ -z "${JIRA_EMAIL:-}"       ] && _missing+=("JIRA_EMAIL")
  [ -z "${JIRA_TOKEN:-}"       ] && _missing+=("JIRA_TOKEN")
  [ -z "${JIRA_PROJECT_KEY:-}" ] && _missing+=("JIRA_PROJECT_KEY")
  # Worktree validation uses bash indirection to avoid relying on `env | grep`.
  # Brownfield mode: JIRA_CODELINE_ROOT is required; worktree paths are discovered
  # at runtime by codeline-discovery.js (ingest step 1.5) — no JIRA_WORKTREE_* needed.
  # Greenfield mode: JIRA_CODELINES + matching JIRA_WORKTREE_* must be pre-declared.
  local _found_wt=0
  if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
    [ -z "${JIRA_CODELINE_ROOT:-}" ] && _missing+=("JIRA_CODELINE_ROOT")
    [ -n "${JIRA_CODELINE_ROOT:-}" ] && _found_wt=1
  elif [ -n "${JIRA_CODELINES:-}" ]; then
    IFS=',' read -ra _wt_cls <<< "$JIRA_CODELINES"
    for _wt_cl in "${_wt_cls[@]}"; do
      local _wt_var="JIRA_WORKTREE_${_wt_cl^^}"
      if [ -n "${!_wt_var:-}" ]; then _found_wt=1; else _missing+=("$_wt_var"); fi
    done
  else
    [ -n "${JIRA_WORKTREE_BE:-}" ] && _found_wt=1
    [ "$_found_wt" = "0" ] && _missing+=("JIRA_WORKTREE_<CODELINE>")
  fi
  if [ ${#_missing[@]} -gt 0 ]; then
    error "[jira] Missing required env vars: ${_missing[*]}"
    error "[jira] Run: source orchestrations/jira/.env"
    return 1
  fi

  log "[jira] ${JIRA_URL} (project: ${JIRA_PROJECT_KEY}) → ${_log_file}"

  # Overridable so a test (or any concurrent, isolated Jira-pipeline run) can
  # point the synthesized PRD at its own disposable path instead of colliding
  # with whatever real project last used the shared default location.
  # Follows the run's own PRD_FILE. Defaulting to travel-app-prd.json meant every
  # Jira-driven project synthesized into the travel-app PRD (2026-07-25 clobber).
  local _synth_prd="${JIRA_SYNTH_PRD_PATH:-${PRD_FILE:-$AUTOMATION_DIR/travel-app-prd.json}}"
  local _ingest_exit=0
  # IMPORTANT: do NOT use `|| _ingest_exit=${PIPESTATUS[0]}` here.
  # Without pipefail, the pipeline exit code is tee's exit code (almost always 0),
  # so the || never fires even when ingest-jira-tickets.sh exits 1.
  # PIPESTATUS[0] captures bash ingest's exit code REGARDLESS of tee's success.
  bash "$SCRIPT_DIR/ingest-jira-tickets.sh" \
    --project "$JIRA_PROJECT_KEY" \
    --status  "${JIRA_STATUS_FILTER:-To Do}" \
    --out-prd "$_synth_prd" \
    2>&1 | tee -a "$_log_file"
  _ingest_exit="${PIPESTATUS[0]}"

  if [ "$_ingest_exit" = "2" ]; then
    error "[jira] Pipeline halted: insufficient ACs. Review Jira tickets and re-trigger."
    return 2
  elif [ "$_ingest_exit" != "0" ]; then
    error "[jira] Ingestion failed (exit $_ingest_exit)."
    return 1
  fi

  # Inject an empty scaffold phase into implementationOrder so the tier3 launcher's
  # run_phase "scaffold" call fires the pre-phase assessment agent. The scaffold phase
  # has 0 implementation stories but runs Step 3 (skill assessment) over ALL synthesized
  # Jira stories — this assesses and injects project-specific skills into each agent's
  # profile before any core implementation begins. Agent SKILLS are assessed per project
  # here; agent IDENTITIES are minted per project immediately below — they used to be kept
  # wholesale from the canonical, which is how a client codeline ran epam-cli's own roster.
  "$NODE_BIN" -e "
    const fs = require('fs');
    const prd = JSON.parse(fs.readFileSync('${_synth_prd}', 'utf8'));
    if (!prd.implementationOrder) prd.implementationOrder = {};
    if (!prd.implementationOrder.scaffold) {
      prd.implementationOrder = { scaffold: [], ...prd.implementationOrder };
    }
    fs.writeFileSync('${_synth_prd}', JSON.stringify(prd, null, 2));
  " 2>/dev/null && log "[jira] Injected empty scaffold phase for pre-phase skill assessment"

  # ── Mint this project's agents, then assign every story one ────────────────
  #
  # Ordering (operator direction, 2026-08-07): after ingest, before spec. The inputs that make
  # a proposed role project-specific rather than a restatement of the canonical core are the
  # tickets and the documents linked on them, and both exist only once ingest has run.
  #
  # Until now the roster was inherited wholesale: a client codeline ran with epam-cli's OWN
  # first-commit agents, and synthesize-prd-from-jira.js assigned every ticket to one of them
  # with a hardcoded literal. Nothing errored — it was simply always the wrong agent.
  if [ "${EPAM_SKIP_AGENT_MINT:-0}" != "1" ] || [ -n "${EPAM_RESUME_RUN:-}" ]; then
    log "[jira] Minting project agents and assigning roles..."
    if ! "$NODE_BIN" "$SCRIPT_DIR/mint-agents-step.js" \
        --prd "$_synth_prd" \
        --agents-dir "$AUTOMATION_DIR/agents" \
        --log-dir "$LOG_DIR" \
        --codeline-root "${PROJECT_ROOT:-}" 2>&1 | tee -a "$_log_file"; then
      error "[jira] Agent mint/assignment failed — refusing to run stories with no assigned agent."
      return 1
    fi
    if [ "${PIPESTATUS[0]}" != "0" ]; then
      error "[jira] Agent mint/assignment failed — refusing to run stories with no assigned agent."
      return 1
    fi
  fi

  # PAUSE 1 of 2 — the roster is minted and every story assigned, and nothing has been
  # specified or written yet. Which roles exist, how they are briefed, and which story each
  # owns shape every later stage, and they are cheap to correct here and expensive to correct
  # after the spec pass has built on them.
  if command -v should_pause_after_agent_mint >/dev/null 2>&1 && should_pause_after_agent_mint; then
    local _rckpt=""
    if _rckpt=$(save_run_checkpoint "${PHASE:-core}" post-roster 2>&1); then
      info "[orch] post-roster checkpoint saved: ${_rckpt}"
    else
      warning "[orch] could not save the post-roster checkpoint: ${_rckpt}"
    fi
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  PAUSED — agents minted and assigned, spec NOT started             ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  RUN NUMBER:  ${GREEN}${ORCH_RUN_ID:-unknown}${NC}"
    echo -e "  Roster:      ${AUTOMATION_DIR}/agents/profiles.json"
    echo -e "  Implementers:  ${EPAM_PROJECT_CONFIG_DIR:-${AUTOMATION_DIR}/agents}/project-roles.json"
    echo -e "  Investigators: ${EPAM_PROJECT_CONFIG_DIR:-${AUTOMATION_DIR}/agents}/project-investigators.json"
    echo -e "  Minted:      ${LOG_DIR}/agent-mint.json"
    echo -e "  Assignments: ${LOG_DIR}/role-assignments.json"
    echo -e "  ${GREEN}WHAT WAS GENERATED (vs canonical): ${LOG_DIR}/roster-diff.md${NC}"
    echo -e "  What the mint could SEE:            ${LOG_DIR}/mint-inputs.json"
    echo -e "  ${GREEN}ROSTER REVIEW:                      ${LOG_DIR}/roster-review.json${NC}"
    if [ -f "${LOG_DIR}/roster-review.json" ] && command -v jq >/dev/null 2>&1; then
      _rv=$(jq -r '.verdict // "?"' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      _rn=$(jq -r '.findings | length' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      _rb=$(jq -r '[.findings[]? | select(.severity=="blocking")] | length' "${LOG_DIR}/roster-review.json" 2>/dev/null)
      if [ "${_rb:-0}" != "0" ]; then
        echo -e "     ${RED}verdict: ${_rv} — ${_rn} finding(s), ${_rb} BLOCKING${NC}"
      else
        echo -e "     verdict: ${_rv} — ${_rn} finding(s)"
      fi
      jq -r '.findings[]? | "       [\(.severity)] \(.agent): \(.found)"' "${LOG_DIR}/roster-review.json" 2>/dev/null | head -8
    fi
    if [ -f "${LOG_DIR}/mint-inputs.json" ] && command -v jq >/dev/null 2>&1; then
      _mi_repo=$(jq -r '.codelineRepo // "NONE"' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_deps=$(jq -r '.declaredDependencies // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_df=$(jq -r '.documentsFetched // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      _mi_dl=$(jq -r '.documentsLinked // 0' "${LOG_DIR}/mint-inputs.json" 2>/dev/null)
      echo -e "     codeline repo:  ${_mi_repo}"
      echo -e "     declared deps:  ${_mi_deps}"
      if [ "${_mi_df}" != "${_mi_dl}" ]; then
        echo -e "     ${RED}documents:      ${_mi_df} of ${_mi_dl} fetched — the roster was derived WITHOUT them${NC}"
      else
        echo -e "     documents:      ${_mi_df} of ${_mi_dl} fetched"
      fi
    fi
    echo ""
    echo -e "  Inspect and EDIT if needed:"
    echo -e "    ${AUTOMATION_DIR}/agents/profiles.json         (each role's brief)"
    echo -e "    ${EPAM_PROJECT_CONFIG_DIR:-${AUTOMATION_DIR}/agents}/project-roles.json   (implementers — may author code, may own a story)"
    echo -e "    ${EPAM_PROJECT_CONFIG_DIR:-${AUTOMATION_DIR}/agents}/project-investigators.json   (investigators — read-only, one per codeline)"
    echo -e "    ${_synth_prd}   (each story's agentRole)"
    echo ""
    echo -e "  Then CONTINUE into the spec phase with:"
    echo -e "    ${GREEN}EPAM_RESUME_RUN=${ORCH_RUN_ID:-<run-id>} ${TIER3_LAUNCHER:-<your launcher>} --yes${NC}"
    echo ""
    echo -e "  Resume re-reads those files and VALIDATES your edits (every story assigned, every"
    echo -e "  role real and not a canonical process role). It does not re-mint and does not"
    echo -e "  re-assign over your changes."
    echo ""
    # END the run. The operator restarts it with the command above; resume validates the
    # roster rather than regenerating it, so hand edits survive.
    return 0
  fi

  _run_codeline_loop "$_synth_prd" "$_log_file"
}

# ── Entry point guards ─────────────────────────────────────────────────────────
# Both guards skip when JIRA_CODELINE_RUN=1 (re-exec for a single codeline/phase).

# Pre-parse --phase from CLI args BEFORE routing so _run_codeline_loop knows which
# phase the caller is requesting. Without this, the multi-codeline routing fires
# before argument parsing, causing the phase filter to be silently dropped — which
# makes every `run-agent-orchestration.sh --phase scaffold` call from the tier3
# launcher run ALL phases (double-execution across codelines).
_ep_caller_phase=""
for (( _ep_i=1; _ep_i<=$#; _ep_i++ )); do
  if [ "${!_ep_i}" = "--phase" ]; then
    _ep_j=$((_ep_i + 1))
    _ep_caller_phase="${!_ep_j:-}"
    break
  fi
done
unset _ep_i _ep_j

# RESUME IS DECIDED BEFORE ANY WORK, NOT AFTER IT.
#
# EPAM_RESUME_RUN restores what a previous run persisted and skips exactly what that
# checkpoint already paid for — derived from the stage it was taken at, never assumed.
#
# This block used to sit past the entry-point dispatch below, and a Jira run calls
# _run_jira_pipeline and EXITS there, so on that shape it was never reached. The checkpoint was
# never restored and the skip env was computed for a branch that never ran. Every "resume" was
# therefore a fresh run: it re-ingested, re-minted, and discarded the roster the operator had
# just reviewed at the pause — which made the roster pause ceremonial, since you reviewed one
# roster and ran a different one.
#
# A resume that cannot be honoured HALTS. Continuing would silently run against whatever stale
# state happened to be on disk, which is the failure this exists to prevent.
#
# Top level only: lanes re-invoke this script and would each restore the checkpoint over their
# own state. The parent decides what to resume; the lanes inherit the result.
if [ -z "${JIRA_CODELINE_RUN:-}" ] && [ -n "${EPAM_RESUME_RUN:-}" ]; then
    # The roster and its briefs are stored against the run that minted them, so a resumed run
    # must BE that run — otherwise the store reads as another run's and is not re-applied.
    export ORCH_RUN_ID="$EPAM_RESUME_RUN"

    if ! restore_run_checkpoint "$EPAM_RESUME_RUN"; then
        error "[orch] cannot resume run '${EPAM_RESUME_RUN}' — refusing to continue against un-restored state."
        error "[orch] available checkpoints: $(list_run_checkpoints | tr '\n' ' ' 2>/dev/null || echo none)"
        exit 1
    fi

    if ! _resume_env=$(resume_skip_env "$EPAM_RESUME_RUN"); then
        error "[orch] cannot determine what to skip for run '${EPAM_RESUME_RUN}' — refusing to guess."
        exit 1
    fi
    while IFS= read -r _assign; do
        [ -n "$_assign" ] || continue
        export "${_assign?}"
        info "[orch]   resume: ${_assign}"
    done <<< "$_resume_env"
    success "[orch] RESUMED run ${EPAM_RESUME_RUN} — continuing from its checkpoint"
fi

if [ -z "${JIRA_CODELINE_RUN:-}" ]; then
  if [ "${JIRA_PIPELINE:-0}" = "1" ]; then
    # Jira flow: ingest → synthesize → route codelines
    _run_jira_pipeline; exit $?
  else
    # Canonical PRD flow: if the PRD defines multiple codelines, route them.
    # Single-codeline PRDs fall through to the normal phase execution below.
    _cl_count=$("${NODE_BIN:-node}" -e "
      const p = JSON.parse(require('fs').readFileSync('$PRD_FILE','utf8'));
      console.log((p.project && p.project.outputDirs ? p.project.outputDirs : []).length);
    " 2>/dev/null || echo 0)
    if [ "${_cl_count:-0}" -gt 1 ]; then
      # Pass _ep_caller_phase as third arg so the loop runs only the requested phase.
      # Empty string = run all PRD phases (Jira path, or direct invocation without --phase).
      _run_codeline_loop "$PRD_FILE" "" "${_ep_caller_phase}"; exit $?
    fi
  fi
fi

# Default configuration
PHASE="${PHASE:-finops}"
DRY_RUN=false
SKIP_CLEANUP=false
# Orchestration mode: bash (default, no change to existing flow) or hybrid
# Override: ORCH_MODE=hybrid ./run-agent-orchestration.sh  OR  --mode hybrid
ORCH_MODE="${ORCH_MODE:-bash}"

# Cleanup on exit
cleanup() {
    local exit_code=$?
    stop_control_plane
    stop_dashboards_watch
    if [ "$SKIP_CLEANUP" = "true" ]; then
        warning "Skipping worktree cleanup (--skip-cleanup)"
        return
    fi
    if [ $exit_code -ne 0 ]; then
        error "Execution failed with exit code $exit_code"
    fi
    log "Cleaning up worktrees..."
    "$CLAUDE_SH" --cleanup-worktrees 2>/dev/null || true
}

trap cleanup EXIT

# ──────────────────────────────────────────────
# resolve_orch_mode <phase_id>
# Precedence: prd.json phasesConfig[phase].orchestrationMode
#             > ORCH_MODE env var > default "bash"
# ──────────────────────────────────────────────
resolve_orch_mode() {
    local phase_id="$1"
    local phase_mode
    phase_mode=$(jq -r \
        --arg p "$phase_id" \
        '.phasesConfig[$p].orchestrationMode // empty' \
        "$PRD_FILE" 2>/dev/null || true)
    if [ -n "$phase_mode" ] && [ "$phase_mode" != "null" ]; then
        echo "$phase_mode"
    else
        echo "${ORCH_MODE:-bash}"
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --phase)
            if [ -z "$2" ] || [[ "$2" == --* ]]; then
                error "--phase requires a phase name"
                exit 1
            fi
            PHASE="$2"
            shift 2
            ;;
        --reset)
            RESET_STORIES=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --skip-cleanup)
            SKIP_CLEANUP=true
            shift
            ;;
        --sandbox)
            EPAM_SANDBOX=true
            shift
            ;;
        --allow-network)
            EPAM_SANDBOX_ALLOW_NETWORK=true
            shift
            ;;
        --mode)
            if [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
                error "--mode requires a value: bash|hybrid"
                exit 1
            fi
            if [[ "$2" != "bash" && "$2" != "hybrid" ]]; then
                error "Invalid --mode: $2 (must be 'bash' or 'hybrid')"
                exit 1
            fi
            ORCH_MODE="$2"
            shift 2
            ;;
        --help|-h)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Orchestrates parallel execution of stories using git worktrees.
Runs setup stories on main, then launches primary and independent agents
in parallel, waits for completion, and runs review.

Options:
  --phase NAME        Phase to execute (default: phase_wearables_test)
  --mode MODE         Orchestration mode: bash (default) or hybrid
  --reset             Reset all story completed flags before running (clean re-run)
  --dry-run           Show execution plan without running
  --skip-cleanup      Don't cleanup worktrees on exit (for debugging)
  --sandbox           Run each agent invocation inside a Docker/Podman container
                      (filesystem isolation, resource limits, no privilege escalation)
  --allow-network     Used with --sandbox: documents intent to allow full network
                      (network is always required for LLM API calls)
  --help              Show this help message

Timeout env vars:
  STORY_TIMEOUT_SECS      Override flat timeout per story (skips effort-based scaling)
  EPAM_PAUSE_ON_TIMEOUT   "true" = pause for operator on double timeout (default: false)
  EPAM_MAX_PAUSE_SECS     Hard ceiling on pause duration (default: 300s); auto-resumes

Sandbox env vars (used with --sandbox):
  EPAM_SANDBOX_IMAGE   Container image  (default: epam-cli-sandbox:latest)
  EPAM_SANDBOX_CPUS    CPU limit        (default: 2)
  EPAM_SANDBOX_MEMORY  Memory limit     (default: 4g)

Examples:
  $(basename "$0")                                    # Run test phase
  $(basename "$0") --phase phase11_wearable_foundation
  $(basename "$0") --dry-run                          # Preview plan
  $(basename "$0") --skip-cleanup                     # Keep worktrees

EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# derive_sandbox_base_image <prd_file>
# Maps a project's OWN project.stack.language/.runtime (already written by
# the LLM-based `epam new generate` PRD pipeline for every scaffolded
# project — see src/scaffold/ManifestAnalyzer.ts's generatePrd(), currently
# unread by anything downstream) to a Docker base image for the sandbox.
# Generic pattern match, same shape as resolve_model_provider()'s
# EPAM_MODEL_PROVIDER_MAP glob convention elsewhere in this pipeline — no
# specific PROJECT is ever named here, only a small number of well-known
# language keywords. Falls back to node:20-slim (also correct for THIS
# project) when project.stack is missing/unrecognized, so an older PRD
# without stack data still gets a sane default rather than a build failure.
derive_sandbox_base_image() {
    local prd_file="$1"
    local stack_text=""
    if [ -f "$prd_file" ]; then
        stack_text=$(jq -r '[.project.stack.language, .project.stack.runtime] | map(select(. != null)) | join(" ")' "$prd_file" 2>/dev/null | tr '[:upper:]' '[:lower:]')
    fi
    case "$stack_text" in
        *python*)              echo "python:3.11-slim" ;;
        *golang*|*"go "*|*go)  echo "golang:1.22-bookworm" ;;
        *rust*)                echo "rust:1.75-slim" ;;
        *node*|*typescript*|*javascript*) echo "node:20-slim" ;;
        *)                     echo "node:20-slim" ;;
    esac
}

# ── Sandbox bootstrap ─────────────────────────────────────────────────────────
if [ "${EPAM_SANDBOX:-false}" = "true" ]; then
    SANDBOX_INVOKE="$SCRIPT_DIR/lib/sandbox-invoke.sh"
    SANDBOX_IMAGE="${EPAM_SANDBOX_IMAGE:-epam-cli-sandbox:latest}"
    SANDBOX_DOCKERFILE="$SCRIPT_DIR/Dockerfile.sandbox"
    SANDBOX_BASE_IMAGE="${EPAM_SANDBOX_BASE_IMAGE:-$(derive_sandbox_base_image "$PRD_FILE")}"
    _RUNTIME=""
    for _rt in docker podman; do
        command -v "$_rt" &>/dev/null && { _RUNTIME="$_rt"; break; }
    done
    if [ -z "$_RUNTIME" ]; then
        error "--sandbox requires docker or podman — neither found in PATH"
        exit 1
    fi
    if [ ! -f "$SANDBOX_INVOKE" ]; then
        error "sandbox-invoke.sh not found at $SANDBOX_INVOKE"
        exit 1
    fi
    chmod +x "$SANDBOX_INVOKE"
    # Build image if not already present
    if ! "$_RUNTIME" image inspect "$SANDBOX_IMAGE" &>/dev/null 2>&1; then
        log "[sandbox] Building image ${SANDBOX_IMAGE} from ${SANDBOX_DOCKERFILE} (base: ${SANDBOX_BASE_IMAGE})..."
        "$_RUNTIME" build -t "$SANDBOX_IMAGE" --build-arg "BASE_IMAGE=${SANDBOX_BASE_IMAGE}" -f "$SANDBOX_DOCKERFILE" "$SCRIPT_DIR" \
            | sed 's/^/  [docker] /' || {
            error "[sandbox] Image build failed — check Dockerfile.sandbox"
            exit 1
        }
        success "[sandbox] Image ${SANDBOX_IMAGE} ready"
    else
        log "[sandbox] Image ${SANDBOX_IMAGE} already present — skipping build"
    fi
    # Override CLAUDE_CMD so claude.sh uses the sandbox wrapper
    export CLAUDE_CMD="$SANDBOX_INVOKE"
    export EPAM_SANDBOX_IMAGE="$SANDBOX_IMAGE"
    export EPAM_SANDBOX_ALLOW_NETWORK="${EPAM_SANDBOX_ALLOW_NETWORK:-false}"
    log "[sandbox] ENABLED — agent invocations will run in ${SANDBOX_IMAGE}"
    log "[sandbox] Runtime: ${_RUNTIME} | CPUs: ${EPAM_SANDBOX_CPUS:-2} | Memory: ${EPAM_SANDBOX_MEMORY:-4g}"
fi

# Reset story completed flags if requested (idempotent re-runs)
# When PHASE is set, only reset stories belonging to that phase — preserving prior-phase completions.
if [ "${RESET_STORIES:-false}" = "true" ]; then
    log "Resetting story completed flags in $PRD_FILE..."
    local_tmp=$(mktemp)
    # mktemp defaults to mode 0600; mv preserves that onto the final PRD file,
    # breaking anything not running as this user (e.g. the monitor
    # dashboard's nginx worker) -- found live 2026-07-14, this exact block
    # (the highest-frequency PRD write in the pipeline, firing at the start
    # of every --reset invocation) was the primary repeat offender after an
    # earlier pass fixed 5 other mktemp-based PRD writes but missed this one.
    chmod 644 "$local_tmp" 2>/dev/null
    # "in-progress" included alongside "completed"/"failed" (found live
    # 2026-08-02 alongside the Step 9 auto-commit fix): a story left
    # mid-execution across a retry boundary (e.g. a later gate blocked
    # before the story's own commit landed) never had its status flipped to
    # "completed" or "failed", so it silently survived every reset as
    # "in-progress" — a transient state that must never persist past a
    # --reset boundary.
    if [ -n "${PHASE:-}" ]; then
        # Scoped reset: only touch stories in implementationOrder[PHASE]
        jq --arg phase "$PHASE" '
          (.implementationOrder[$phase] // []) as $ids |
          (.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed" or .status == "in-progress"))
            |= (.completed = false | .status = "pending") |
          (.phases[]?.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed" or .status == "in-progress"))
            |= (.completed = false | .status = "pending")' \
            "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
        success "Stories reset to pending (phase: $PHASE)"
    else
        # Global reset: no phase scoping
        jq '(.stories[]? | select(.completed == true or .status == "failed" or .status == "in-progress")) |= (.completed = false | .status = "pending") |
            (.phases[]?.stories[]? | select(.completed == true or .status == "failed" or .status == "in-progress")) |= (.completed = false | .status = "pending")' \
            "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
        success "Stories reset to pending (all phases)"
    fi
    checkpoint_clear

    # Clean up review artifacts for review stories being reset so AC pre-existing-file guard doesn't block re-runs
    while IFS= read -r _review_id; do
        [ -z "$_review_id" ] && continue
        _review_artifact="$PROJECT_ROOT/review/${_review_id}-review.md"
        if [ -f "$_review_artifact" ]; then
            rm -f "$_review_artifact"
            info "  Removed stale review artifact: review/${_review_id}-review.md"
        fi
    done < <(jq -r '.stories[]? | select(.agentRole == "review-agent") | .id' "$PRD_FILE" 2>/dev/null)
    # Immediately push reset state to dashboard so viewer shows clean slate
    if [ -n "${OUTPUT_DIR:-}" ]; then
        cp "$PRD_FILE" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
    fi
fi

# Verify prerequisites
if [ ! -f "$CLAUDE_SH" ]; then
    error "claude.sh not found at $CLAUDE_SH"
    exit 1
fi
if [ ! -f "$PRD_FILE" ]; then
    error "prd.json not found at $PRD_FILE"
    exit 1
fi
if ! command -v jq &> /dev/null; then
    error "jq is required but not installed"
    exit 1
fi

seed_runtime_logs

# Verify phase exists
phase_stories=$(jq -r --arg phase "$PHASE" '.implementationOrder[$phase] // empty' "$PRD_FILE")
if [ -z "$phase_stories" ] || [ "$phase_stories" = "null" ]; then
    error "Phase '$PHASE' not found in prd.json"
    echo ""
    echo "Available phases:"
    jq -r '.implementationOrder | keys[]' "$PRD_FILE" | while read p; do echo "  - $p"; done
    exit 1
fi

start_dashboards_watch
start_control_plane

# Resolve orch mode early so checklist can show accurate 0.6 status
RESOLVED_ORCH_MODE=$(resolve_orch_mode "$PHASE")

# Print step checklist BEFORE any step runs so user sees what's coming
STEP_STATUS_FILE="$LOG_DIR/step-status.json"
print_step_checklist

# ── Step 0: Specification pre-pass (OpenSpec/Speckit) ─────────────────────────
run_specification_pass() {
    local phase_id="$1"
    local spec_runner="$SCRIPT_DIR/spec-mode-runner.js"
    if [ ! -f "$spec_runner" ]; then
        info "Step 1: Specification runner not found (${spec_runner##*/}) — skipping"
        return 0
    fi
    local node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    if [ ! -x "$node_cmd" ]; then
        node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    fi
    if ! command -v "$node_cmd" >/dev/null 2>&1; then
        warning "Step 1: Node.js is required for specification mode but was not found"
        return 0
    fi
    step_emit "1" "running" "Step 1: Specification pass"
    log "Step 1: Running specification pass for phase '$phase_id'..."
    local _spec_started; _spec_started=$(date -Iseconds)
    set +e
    PRD_FILE="$PRD_FILE" OUTPUT_DIR="$LOG_DIR" CLAUDE_CMD="${CLAUDE_CMD}" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_ORCHESTRATION_PROVIDER="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}" \
        AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
        "$node_cmd" "$spec_runner" --phase "$phase_id" 2>&1 | tee "$LOG_DIR/spec-${phase_id}.log"
    local spec_rc=${PIPESTATUS[0]}
    set -e
    # GAP-P22: emit spec runner cost record (token/cost estimated — spec runner
    # doesn't expose per-call usage; a future improvement can parse spec logs)
    # Real usage, measured from the records spec-mode-runner already emits —
    # see _spec_pass_usage for why this used to be four literal zeros.
    local _spec_usage _spec_cost _spec_tin _spec_tout _spec_turns
    _spec_usage=$(_spec_pass_usage "$phase_id")
    read -r _spec_cost _spec_tin _spec_tout _spec_turns <<< "${_spec_usage:-0 0 0 0}"
    append_pipeline_cost_record "spec-pass" "$phase_id" \
        "${ORCH_GATE_MODEL:-z-ai/glm-5.2}" "$_spec_started" \
        "${_spec_cost:-0}" "${_spec_tin:-0}" "${_spec_tout:-0}" "${_spec_turns:-0}" 2>/dev/null || true
    # Surface openspec/speckit as visible checklist sub-steps instead of only
    # showing as "spec-mode: fast-path ..." log lines buried inside Step 0's
    # own log — parses the summary spec-mode-runner.js already writes
    # (summary.stats.agents: {agentName: invocationCount}) for a real story
    # count per agent; model comes from the same env vars the runner itself
    # uses (SPEC_MODE_OPENSPEC_MODEL/SPEC_MODE_SPECKIT_MODEL).
    local _spec_summary="$LOG_DIR/spec-summary.json"
    local _openspec_model="${SPEC_MODE_OPENSPEC_MODEL:-z-ai/glm-5.2}"
    local _speckit_model="${SPEC_MODE_SPECKIT_MODEL:-z-ai/glm-5.2}"
    local _openspec_count=0 _speckit_count=0
    if [ -f "$_spec_summary" ]; then
        _openspec_count=$(jq -r '.stats.agents.openspec // 0' "$_spec_summary" 2>/dev/null || echo 0)
        _speckit_count=$(jq -r '.stats.agents.speckit // 0' "$_spec_summary" 2>/dev/null || echo 0)
    fi

    if [ $spec_rc -eq 0 ]; then
        step_emit "1" "pass" "Step 1: Specification pass"
        step_emit "1a" "pass" "  openspec (elaboration)" "${_openspec_model}, ${_openspec_count} stor(y/ies)"
        step_emit "1b" "pass" "  speckit (verification)" "${_speckit_model}, ${_speckit_count} stor(y/ies)"
        success "Step 1: Specification pass completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "specification_pass" \
            "Specification agents completed (OpenSpec/Speckit)" "" "main" "spec-coordinator" 2>/dev/null || true
        # Block execution when spec-pass failed on stories that still need splitting
        # and the caller has opted in to hard blocking (SPEC_PASS_BLOCK_ON_TIMEOUT=true).
        if [ "${SPEC_PASS_BLOCK_ON_TIMEOUT:-false}" = "true" ]; then
            _failed_untuned=$(jq -r \
                '[.stories[] | select(.specification.specPassFailed == true)] | length' \
                "$PRD_FILE" 2>/dev/null || echo 0)
            if [ "${_failed_untuned:-0}" -gt 0 ]; then
                _failed_ids=$(jq -r \
                    '[.stories[] | select(.specification.specPassFailed == true) | .id] | join(", ")' \
                    "$PRD_FILE" 2>/dev/null || echo "unknown")
                error "Spec pass FAILED for untuned stories: $_failed_ids"
                error "  Execution blocked (SPEC_PASS_BLOCK_ON_TIMEOUT=true). Set to false to override."
                exit 1
            fi
        fi
        # SUFFICIENCY GATE (always on, NOT overridable): a brownfield story where
        # the detective found no fix site AND the ticket context is thin cannot be
        # implemented or verified — fail early with a clear reason rather than
        # burning a doomed run. Autonomous (no human halt); the flag is set by the
        # spec pass (spec-mode-runner.js sufficiency gate).
        _insufficient=$(jq -r \
            '[.stories[] | select(.specification.insufficientContext == true)] | length' \
            "$PRD_FILE" 2>/dev/null || echo 0)
        if [ "${_insufficient:-0}" -gt 0 ]; then
            _insufficient_ids=$(jq -r \
                '[.stories[] | select(.specification.insufficientContext == true) | .id] | join(", ")' \
                "$PRD_FILE" 2>/dev/null || echo "unknown")
            error "Step 1: INSUFFICIENT CONTEXT — $_insufficient_ids: the code-graph-detective located no fix site and the ticket's ACs + description are too thin to implement or to write a reproducing test."
            error "  Failing early rather than proceeding to a doomed run. Enrich the ticket (ACs or description) and re-run."
            exit 2
        fi
    else
        step_emit "1" "fail" "Step 1: Specification pass"
        step_emit "1a" "fail" "  openspec (elaboration)" "${_openspec_model}"
        step_emit "1b" "fail" "  speckit (verification)" "${_speckit_model}"
        error "Step 1: Specification pass FAILED for '$phase_id' — all agent invocations failed."
        error "  Check EPAM_ORCHESTRATION_PROVIDER is set and supported by ai-run.sh."
        error "  See: $LOG_DIR/spec-${phase_id}.log"
        exit 1
    fi
}

# ── Resume: start at implementation, not at the beginning ────────────────────
if [ "$DRY_RUN" = true ]; then
    step_emit "1" "skip" "Step 1: Specification pass" "dry-run"
    step_emit "1a" "skip" "  openspec (elaboration)" "dry-run"
    step_emit "1b" "skip" "  speckit (verification)" "dry-run"
    info "Step 1: Specification pass skipped during --dry-run"
elif [ "${EPAM_SPEC_MODE:-1}" = "0" ]; then
    step_emit "1" "skip" "Step 1: Specification pass" "EPAM_SPEC_MODE=0"
    step_emit "1a" "skip" "  openspec (elaboration)" "EPAM_SPEC_MODE=0"
    step_emit "1b" "skip" "  speckit (verification)" "EPAM_SPEC_MODE=0"
    info "Step 1: Specification pass disabled (EPAM_SPEC_MODE=0)"
else
    run_specification_pass "$PHASE"
fi

# Story-ID-loss invariant: snapshot the settled post-spec-pass story set for
# this phase. See capture_story_ids_snapshot's own docstring above for why.
capture_story_ids_snapshot "presplit"

# ── Checkpoint: the spec pass's output is now settled ────────────────────────
# Persist it UNCONDITIONALLY, whether or not we are pausing. Anything generated and not
# written to disc is a project violation, and until now the spec pass's output existed
# only as an in-place mutation of the runtime PRD — which pre-run-reset.sh's next launch
# would overwrite. Saving costs one file copy and buys a resumable run.
if _ckpt_path=$(save_run_checkpoint "$PHASE" 2>&1); then
    info "[orch] checkpoint saved: ${_ckpt_path}"
else
    warning "[orch] could not save the post-spec checkpoint: ${_ckpt_path}"
    warning "[orch] this run will NOT be resumable — a later failure costs a full spec pass to retry."
fi


# ── Infra test gate ──────────────────────────────────────────────────────────
# Block any phase that depends on infra_test (anything except infra_test itself)
# unless all SP-T0x stories are completed.
if [ "$PHASE" != "infra_test" ]; then
    infra_test_stories=$(jq -r '
        (.implementationOrder["infra_test"] // []) as $ids |
        .stories[] | select(.id as $id | $ids | index($id))
        | .id' "$PRD_FILE" 2>/dev/null)

    if [ -n "$infra_test_stories" ]; then
        infra_incomplete=""
        while IFS= read -r sid; do
            [ -z "$sid" ] && continue
            completed=$(jq -r --arg id "$sid" '.stories[] | select(.id==$id) | .completed' "$PRD_FILE")
            if [ "$completed" != "true" ]; then
                infra_incomplete="$infra_incomplete $sid"
            fi
        done <<< "$infra_test_stories"

        if [ -n "$infra_incomplete" ]; then
            echo ""
            echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
            echo -e "${RED}║  INFRA TEST GATE — Phase '$PHASE' is BLOCKED         ║${NC}"
            echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "${YELLOW}The following infra_test stories must complete before running '$PHASE':${NC}"
            for sid in $infra_incomplete; do
                title=$(jq -r --arg id "$sid" '.stories[] | select(.id==$id) | .title' "$PRD_FILE")
                echo -e "  ${RED}✗${NC} $sid: $title"
            done
            echo ""
            echo -e "${CYAN}Run the infra_test phase first:${NC}"
            echo -e "  $(basename "$0") --phase infra_test"
            echo ""
            echo -e "${YELLOW}If infra_test has been run but status not updated, check:${NC}"
            echo -e "  curl -s http://localhost:8090/api/stories | jq '[.[] | select(.phase==\"infra_test\") | {id,status,completed}]'"
            echo ""
            exit 1
        fi
    fi
fi

# Create log directory
mkdir -p "$LOG_DIR"

# ── Step 0.1: Contextual Purveyor Agent (CPA) pre-pass ───────────────────────
# Reviews upcoming phase stories, adjusts estimates, and gates on confidence.
# Skip with: SKIP_CPA=1 ./run-agent-orchestration.sh --phase <phase>
# For strict mode (halt on 'review' gate): STRICT_CPA=1
# ─────────────────────────────────────────────────────────────────────────────
CPA_SCRIPT="$SCRIPT_DIR/contextualize-stories.sh"

if ! is_truthy "${SKIP_CPA:-}" && [ -f "$CPA_SCRIPT" ]; then
    step_emit "2" "running" "Step 2: CPA pre-pass"
    log "Step 2: Running CPA pre-pass for phase '$PHASE'..."

    cpa_flags="--phase $PHASE --apply"
    [ "${STRICT_CPA:-0}" = "1" ] && cpa_flags="$cpa_flags --strict"

    # Inject most recent prior-phase handoff if available
    _prev_handoff=""
    _handoff_search_dir="$(dirname "$LOG_DIR")"
    # Look for handoff files under any logs/ sub-directory, pick the most recent by mtime
    _prev_handoff=$(find "$_handoff_search_dir" -maxdepth 3 -name "phase-handoff-*.md" \
        ! -name "phase-handoff-${PHASE}.md" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | awk '{print $2}' || true)
    [ -f "${_prev_handoff:-}" ] && info "Step 2: Injecting prior-phase context from: ${_prev_handoff##*/}"

    cpa_exit=0
    # IMPORTANT: do NOT use `|| cpa_exit=$?` here.
    # Without pipefail, the pipeline exit code is tee's exit code (almost always 0),
    # so BLOCK (exit 3) and REVIEW (exit 2) from $CPA_SCRIPT were silently discarded
    # and the case statement below always took the "0) pass" branch.
    # PIPESTATUS[0] captures $CPA_SCRIPT's real exit code regardless of tee's success.
    # shellcheck disable=SC2086
    CLAUDE_CMD="$CLAUDE_CMD" AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_CLI="${EPAM_CLI:-epam}" \
        PREV_PHASE_HANDOFF_FILE="${_prev_handoff:-}" \
        bash "$CPA_SCRIPT" $cpa_flags 2>&1 | tee "$LOG_DIR/cpa-${PHASE}.log"
    cpa_exit="${PIPESTATUS[0]}"

    case $cpa_exit in
        0)
            step_emit "2" "pass" "Step 2: CPA pre-pass"
            success "Step 2: CPA gate PASSED for phase '$PHASE'"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_pass" \
                "CPA gate passed — all stories cleared" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        2)
            step_emit "2" "warn" "Step 2: CPA pre-pass" "elevated risk — review"
            warning "Step 2: CPA gate REVIEW — some stories have elevated risk"
            warning "  Check: $LOG_DIR/cpa-${PHASE}.log"
            warning "  Continuing (use STRICT_CPA=1 to halt on review gates)"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_review" \
                "CPA gate REVIEW — proceeding with warnings" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        3)
            step_emit "2" "fail" "Step 2: CPA pre-pass"
            error "Step 2: CPA gate BLOCKED — one or more stories cannot proceed"
            error "  Check: $LOG_DIR/cpa-${PHASE}.log"
            error "  Resolve flagged issues, then re-run. Override: SKIP_CPA=1"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_block" \
                "CPA gate BLOCKED — pipeline halted" "" "main" "context-purveyor" 2>/dev/null || true
            exit 3
            ;;
        *)
            warning "Step 2: CPA script exited with code $cpa_exit (non-critical — continuing)"
            ;;
    esac
else
    if is_truthy "${SKIP_CPA:-}"; then
        step_emit "2" "skip" "Step 2: CPA pre-pass" "SKIP_CPA=1"
        info "Step 2: CPA pre-pass skipped (SKIP_CPA=1)"
    else
        step_emit "2" "skip" "Step 2: CPA pre-pass" "script not found"
        info "Step 2: CPA script not found — skipping pre-pass"
    fi
fi

echo ""
echo -e "${MAGENTA}============================================${NC}"
echo -e "${MAGENTA}  EPAM CLI Agent Orchestration${NC}"
echo -e "${MAGENTA}  Phase: ${WHITE}$PHASE${NC}"
echo -e "${MAGENTA}  Mode:  ${WHITE}$([ "$DRY_RUN" = true ] && echo "DRY RUN" || echo "LIVE")${NC}"
echo -e "${MAGENTA}  Orch:  ${WHITE}${RESOLVED_ORCH_MODE}$([ "$RESOLVED_ORCH_MODE" = "hybrid" ] && echo " (Agent Teams + MCP bus)" || echo " (bash-only)")${NC}"
echo -e "${MAGENTA}============================================${NC}"
echo ""

# Categorize stories by agent group
# Deprecated stories (e.g. a split child rejected for a same-file coherence
# violation) must never be selected here — found live 2026-07-10 when a
# deprecated SKY-002-test (completed == false, since it never ran) got
# re-queued and re-implemented on every orchestration loop restart, burning
# cost on work that had already been correctly abandoned.
main_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select((.agentGroup == "main" or .agentGroup == "preflight") and (.completed // false) == false) | .id' "$PRD_FILE")

primary_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "primary" and (.completed // false) == false) | .id' "$PRD_FILE")

independent_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "independent" and (.completed // false) == false) | .id' "$PRD_FILE")

review_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentRole == "review-agent" and (.completed // false) == false) | .id' "$PRD_FILE")

# Apply dependency-graph ordering within each group
main_stories=$(topo_sort_stories "$main_stories")
primary_stories=$(topo_sort_stories "$primary_stories")
independent_stories=$(topo_sort_stories "$independent_stories")
review_stories=$(topo_sort_stories "$review_stories")

# ── Topology routing (GAP-P11) ────────────────────────────────────────────────
# Build story metadata payload for the LLM router.
# Falls back to count heuristic when no API key is set or the call fails.
_wt_stories_list=""
[ -n "$primary_stories" ]     && _wt_stories_list="${_wt_stories_list}${primary_stories}"$'\n'
[ -n "$independent_stories" ] && _wt_stories_list="${_wt_stories_list}${independent_stories}"$'\n'
_wt_count=$(echo "$_wt_stories_list" | grep -c '[^[:space:]]') || _wt_count=0

_router_js="$SCRIPT_DIR/lib/topology-router.js"
_topology_decision=""
_topology_reason=""
_topology_source="heuristic"

if [ -f "$_router_js" ] && command -v node &>/dev/null; then
    # Build JSON payload: story metadata from PRD
    _story_ids_json=$(echo "$_wt_stories_list" | grep '[^[:space:]]' | \
        jq -R . | jq -s 'map(select(. != ""))' 2>/dev/null || echo "[]")

    _stories_payload=$(jq -n \
        --arg phase "$PHASE" \
        --argjson ids "$_story_ids_json" \
        --argjson prd "$(cat "$PRD_FILE" 2>/dev/null || echo '{}')" \
        '{
            phase: $phase,
            stories: [
                $prd.stories[]?
                | select(.id as $id | $ids | index($id))
                | { id, effort: (.effort // "low"), agentRole: (.agentRole // ""),
                    storyType: (.storyType // "implementation"),
                    dependencies: (.technicalNotes.dependsOn // []) }
            ],
            cpaSignals: [
                $prd.stories[]?
                | select(.id as $id | $ids | index($id))
                | { id, filesExist: (.technicalNotes.filesExist // 0),
                    estimatedTurns: (.estimatedTurns // null) }
            ]
        }' 2>/dev/null || echo '{"phase":"","stories":[],"cpaSignals":[]}')

    _router_started=$(date -Iseconds)
    _router_out=$(echo "$_stories_payload" | \
        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${EPAM_API_KEY_ANTHROPIC:-}}" \
        node "$_router_js" 2>/dev/null || echo "")

    if [ -n "$_router_out" ]; then
        _topology_decision=$(echo "$_router_out" | jq -r '.topology // empty' 2>/dev/null || echo "")
        _topology_reason=$(echo "$_router_out"   | jq -r '.reason   // empty' 2>/dev/null || echo "")
        _topology_source=$(echo "$_router_out"   | jq -r '.source   // "heuristic"' 2>/dev/null || echo "heuristic")
        # GAP-P22: track topology router cost when LLM was invoked
        if [ "$_topology_source" = "llm" ]; then
            _router_model=$(echo "$_router_out" | jq -r '.model // "z-ai/glm-5.2"' 2>/dev/null || echo "z-ai/glm-5.2")
            append_pipeline_cost_record "topology-router" "pipeline" "$_router_model" "$_router_started" \
                "0.001" "800" "50" "1" 2>/dev/null || true
        fi
    fi
fi

# Apply topology decision
if [ -z "$_topology_decision" ]; then
    # Pure count heuristic fallback
    if   [ "$_wt_count" -le 1 ]; then _topology_decision="single"
    elif [ "$_wt_count" -le 4 ]; then _topology_decision="parallel"
    else                               _topology_decision="sequential"; fi
    _topology_source="heuristic"
fi

# Log decision + reason to phase-cost.jsonl for dashboard visibility (compact — must be single-line JSONL)
jq -cn \
    --arg phase    "$PHASE" \
    --arg topology "$_topology_decision" \
    --arg reason   "${_topology_reason:-}" \
    --arg source   "$_topology_source" \
    '{ event:"topology_decision", phase:$phase, topology:$topology,
       reason:$reason, source:$source, timestamp:(now|todate) }' \
    >> "${PHASE_COST_FILE:-/dev/null}" 2>/dev/null || true

src_tag="[$_topology_source]"
[ "$_topology_source" = "llm" ] && src_tag="[llm:$(echo "$_router_out" | jq -r '.model // "haiku"' 2>/dev/null | sed 's/claude-//;s/-20[0-9]*//'  )]"
info "Topology: $_topology_decision $src_tag — ${_topology_reason:-count heuristic}"

# Collapse worktree lane when topology is single or sequential
if [ "$_topology_decision" = "single" ] || [ "$_topology_decision" = "sequential" ]; then
    if [ "$_wt_count" -ge 1 ]; then
        _collapsed=$(echo "$_wt_stories_list" | tr -s '\n' | grep '[^[:space:]]' || true)
        if [ -n "$main_stories" ]; then
            main_stories="${main_stories}
${_collapsed}"
        else
            main_stories="$_collapsed"
        fi
        main_stories=$(topo_sort_stories "$main_stories")
    fi
    primary_stories=""
    independent_stories=""
fi
# topology=parallel: leave primary_stories + independent_stories as-is for worktree execution

# Surface resume-from-failure: show progress if some stories already completed
_phase_total=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) | length' "$PRD_FILE" 2>/dev/null || echo 0)
_phase_done=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo 0)
if [ "${_phase_done:-0}" -gt 0 ] && [ "${_phase_total:-0}" -gt 0 ]; then
    _phase_remaining=$(( _phase_total - _phase_done ))
    info "Resuming phase '$PHASE': $_phase_done/$_phase_total stories already complete — $_phase_remaining remaining"
fi

# Display execution plan
echo -e "${CYAN}Execution Plan:${NC}"
echo ""
if [ -n "$main_stories" ]; then
    echo -e "  ${MAGENTA}Main branch (sequential):${NC}"
    echo "$main_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${CYAN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$primary_stories" ]; then
    echo -e "  ${GREEN}Worktree-1 (primary chain):${NC}"
    echo "$primary_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${GREEN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$independent_stories" ]; then
    echo -e "  ${CYAN}Worktree-2 (independent):${NC}"
    echo "$independent_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${CYAN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$review_stories" ]; then
    echo -e "  ${RED}Review (after worktrees complete):${NC}"
    echo "$review_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        echo -e "    $s: $title ${RED}[review-agent]${NC}"
    done
    echo ""
fi

if [ "$DRY_RUN" = true ]; then
    info "Dry run complete. No actions taken."
    exit 0
fi

# ── Periodic checklist heartbeat ─────────────────────────────────────────────
# Prints a compact step-status summary every 60s so long-running phases stay
# visible in the log without requiring tail.
_checklist_heartbeat() {
    while true; do
        sleep 60
        echo ""
        echo -e "${MAGENTA}━━━ Step Status @ $(date +%H:%M:%S) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        for _sid in \
            "1:Specification pass" "1a:openspec" "1b:speckit" "2:CPA pre-pass" \
            "3:Skill assessment" "4:Hybrid pre-coord" "5:Regression guard" \
            "6:mkdir src/ dirs" "7:PRD model coordinator" "8:Main-branch stories" \
            "9:Auto-commit" "10:TC writer gate" "11:Skills coordinator audit" \
            "12:Tools coordinator audit" "13:Create worktrees" "14:Primary agent" \
            "15:Independent agent" "16:Worktree health" "17:Merge worktrees" \
            "18:Post-parallel assessment" "19:Pre-review gate" "20:Lint gate" \
            "21:Review stories" "22a:SAST sentinel" "22b:Spec validator" \
            "22c:Review ranger" "22d:Mutant hunter" \
            "22e:Fuzz-weaver" "22f:Perf sentinel" "23:Browser E2E"; do
            local _key="${_sid%%:*}"
            local _st="${_STEP_STATUS[$_key]:-pending}"
            local _lbl="${_STEP_LABELS[$_key]:-${_sid#*:}}"
            local _icon
            case "$_st" in
                pass)    _icon="${GREEN}✓${NC}" ;;
                skip)    _icon="${YELLOW}⊘${NC}" ;;
                fail)    _icon="${RED}✗${NC}" ;;
                warn)    _icon="${YELLOW}⚠${NC}" ;;
                running) _icon="${CYAN}▶${NC}" ;;
                *)       _icon="${WHITE}○${NC}" ;;
            esac
            printf "  %b %-6s %s\n" "${_icon}" "$_key" "$_lbl"
        done
        echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
    done
}
_checklist_heartbeat &
_HEARTBEAT_PID=$!
# Kill heartbeat on exit
trap 'kill "$_HEARTBEAT_PID" 2>/dev/null || true' EXIT

# ──────────────────────────────────────────────
# Initialize monitor status file for HTML dashboard
# ──────────────────────────────────────────────
log "Initializing monitor status file..."

# Build initial stories map from phase
stories_init=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) |
      {key: .id, value: {status: (if .completed then "complete" else "pending" end), lane: .agentGroup, role: (.agentRole // ""), title: .title, updatedAt: null}}] |
     from_entries' "$PRD_FILE")

cat > "$MONITOR_STATUS_FILE" << JSONEOF
{
  "startedAt": "$(date -Iseconds)",
  "phase": "$PHASE",
  "orchMode": "$RESOLVED_ORCH_MODE",
  "lanes": {
    "main": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "primary": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "independent": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0}
  },
  "events": [],
  "stories": $stories_init
}
JSONEOF

info "Monitor file: $MONITOR_STATUS_FILE"
info "Open orchestrations/monitor.html in a browser to watch progress"

# ──────────────────────────────────────────────
# Step 0.5: Pre-phase skill assessment
# ──────────────────────────────────────────────
# _pfa_capability_failed <log> — did the agent exhaust its iteration cap?
#
# AgentRunner returns "Agent reached maximum iterations (N) without completing."
# as a NORMAL result with exit 0, so an agent that produced nothing is
# indistinguishable from one that succeeded unless someone reads the text.
# claude.sh, spec-mode-runner.js and brownfield-repro-test-writer.sh all check
# for it; the pre-phase assessment did not, and it is the most expensive call in
# the pipeline — 586K tokens and 57% of mock1 run 10, for 58 bytes saying it
# failed.
#
# Deliberately does NOT match the cap number: it is configurable, and a detector
# that only recognises 25 stops working the moment someone tunes it.
_pfa_capability_failed() {
    local _log="${1:-}"
    [ -n "$_log" ] && [ -s "$_log" ] || return 1
    grep -q "reached maximum iterations" "$_log" 2>/dev/null
}

run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    local profiles_backup="${profiles_file}.original"
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    # The canonical base. tier3-*-run.sh restores profiles.json FROM this file at
    # the start of every run, so this is the thing that actually propagates.
    #
    # It used to be created here silently on first use. Because it is created
    # once and only once, it snapshotted whatever profiles.json happened to hold
    # at that moment — by then already carrying another project's "Post-Spec
    # Skill Addendum" sections — and every run since restored that faithfully.
    # Months later a Metrolinx agent was being instructed to build a Skyscanner
    # API client. Cleaning profiles.json alone would have fixed nothing; the next
    # restore would have put it straight back.
    #
    # So: creating the canonical is now a LOUD, visible event, not a silent
    # side effect. It is a git-tracked file that should be curated deliberately
    # (see the standing rule: the canonical may be updated, but only as a
    # tracked, reviewed change). If it is missing, something deleted it, and
    # minting a new one from a possibly-mutated working copy is exactly how this
    # defect was born.
    if [ ! -f "$profiles_backup" ]; then
        warning "[pre-phase-assessment] canonical profiles missing: $profiles_backup"
        warning "  Creating it from the CURRENT profiles.json — if that file already carries"
        warning "  project-specific additions, they become canonical and every future run inherits them."
        warning "  Verify it, then commit it deliberately rather than leaving it as a run artefact."
        cp "$profiles_file" "$profiles_backup"
    fi

    log "Running pre-phase skill assessment for '$phase_id'..."

    # The output schema, bound at the provider rather than requested in prose.
    # Absent/malformed => AgentRunner warns and continues unbound, and
    # assessment_apply.py still recovers a JSON object from the answer.
    # ── Tool budget: ONE source, stated to the model AND enforced at the seam ──
    # This agent had neither. It got read tools and EPAM_MAX_ITERATIONS=25, and
    # nothing ever told it to stop exploring — so how many turns it spent was a
    # property of whichever repository the lane happened to draw. Live metrolinx
    # 2026-07-29 proved it: same prompt, same cap, gotransit and metrolinx
    # converged, upexpress exhausted. The agents that DO converge (the CodeGraph
    # detective, team-lead review) are the ones given a budget they can see.
    #
    # Both halves are required. A budget the model cannot see truncates it
    # mid-thought, and the response schema then returns a valid EMPTY object —
    # a loud failure turned silent, exactly as the note below this warns.
    local _pfa_tool_budget="${PRE_ASSESSMENT_MAX_TOOL_CALLS:-10}"
    local _pfa_schema=""
    _pfa_schema=$(python3 "$SCRIPT_DIR/lib/assessment_apply.py" --print-schema 2>/dev/null || echo "")

    # The facts, computed rather than discovered.
    #
    # Live AMSD-2041 run 4: turns=1, in=3,366, out=516 — the prompt alone is
    # ~2,100 tokens, so it never read the PRD, never ran find, never touched the
    # repo. It invented story IDs (core-1..core-6 for a phase containing exactly
    # AMSD-2041) and an "authorized" file list of four files that do not exist,
    # then told sast-sentinel to suppress everything else.
    #
    # Caused by fixing its previous failure: it used to burn 25 turns writing
    # files, and making it RETURN a decision removed the only thing that forced
    # it to look at anything. Removing the prompt's worked examples took away
    # what it fabricated WITH; this takes away the need to fabricate at all.
    local _pfa_facts=""
    if [ -f "$SCRIPT_DIR/lib/assessment_context.py" ]; then
        _pfa_facts=$(python3 "$SCRIPT_DIR/lib/assessment_context.py" \
            --prd "$PRD_FILE" --repo-root "$PROJECT_ROOT" --phase "$phase_id" 2>&1) || {
            warning "[pre-phase-assessment] fact injection failed — the agent has nothing to ground its answer in"
            _pfa_facts=""
        }
    fi

    # Build assessment prompt
    local assessment_prompt
    # shellcheck disable=SC2287
    assessment_prompt=$(cat << PROMPT_HEADER
CONVERGE FAST — HARD LIMIT: ${_pfa_tool_budget} tool calls total. This is not a suggestion.
By your ${_pfa_tool_budget}th tool call you MUST stop investigating and return your BEST current
answer. Exploring past the budget WITHOUT answering means you return nothing at all and every
bit of your investigation is discarded — a partially-informed augmentation is worth far more
than none. If you are unsure, decide from what you have already seen and answer now.

You are the skill assessment agent running in PRE-PHASE mode. Your job is to deeply reason about what each assigned agent will need to succeed — not just check a list of requiredSkills, but actively anticipate pitfalls given the tech stack, file types, and implementation patterns the stories demand. You augment agent profiles with the specific knowledge needed to avoid failures before they happen.

## PRD STRUCTURE (read this carefully before issuing any jq commands)
The PRD file uses a FLAT structure — not nested phases. Key paths:
- Story list: .stories[]
- Phase story order: .implementationOrder["${phase_id}"] — returns an array of story IDs
- Story lookup: .stories[] | select(.id == "<id>")
- Agent role field: .agentRole on each story object
- Files field: .technicalNotes.files[] on each story object

DO NOT use .phases[0] — that path does not exist in this PRD.

${_pfa_facts}

## Task
1. Run: jq -r '.implementationOrder["${phase_id}"][]' ${PRD_REL}
   This gives you the ordered list of story IDs for this phase.

2. For each story ID, run: jq -c --arg id "<id>" '.stories[] | select(.id == \$id) | {id, agentRole, unitTests, technicalNotes}' ${PRD_REL}

3. ROLE ASSIGNMENT — For any story where agentRole is null or empty:
   a. Examine the story's technicalNotes.files list
   b. If ALL files in the list are test files (matching *.test.ts or *.spec.ts), assign agentRole "test-engineer"
   c. If the story has unitTests:true AND its files include test files mixed with implementation files, this story MUST be split:
      - Implementation child: files without *.test.ts, agentRole "typescript-engineer"
      - Test child: only the *.test.ts files, agentRole "test-engineer"
      - Report the agentRole for each child in storyRoleAssignments
   d. Otherwise assign the most appropriate role from ${PROFILES_REL} based on the story's tech stack
   e. Report it in storyRoleAssignments. Do NOT edit ${PRD_REL} yourself.

4. PROFILE CREATION — For any agentRole assigned in step 3 that does NOT exist as a key in ${PROFILES_REL}:
   a. Read the project context from ${PRD_REL} (projectName, techStack, constraints)
   b. Read the story's technicalNotes to understand the testing conventions for this project
   c. Generate a new profile string for that role, derived from THIS project: its name, its test framework and version, its module system, its mocking convention, its forbidden packages, its test config path and include pattern — every one of these read from the project's own manifest and existing tests, never assumed. Include the instruction that a test-only role writes test files and never implementation files.
   d. Report it in newProfiles. Do NOT edit ${PROFILES_REL} yourself.

5. PROACTIVE SKILL INFERENCE — For each story's agentRole, reason beyond the requiredSkills list. Read the story's full technicalNotes, acceptanceCriteria, and files. Then ask: given this tech stack and these implementation patterns, what are the specific pitfalls an agent is likely to walk into that are NOT already covered in the profile?

   Infer gaps by reasoning about the code the agent will write, not the labels in requiredSkills. The SHAPE of the reasoning is:
     "<something concrete this story's code will do, read from THIS repository>
      → the specific mistake an agent tends to make there
      → the exact rule that prevents it"

   EVERY rule you report must come from THIS project's code. Name a real file, a
   real dependency, a real convention you have actually seen in this repository.
   You are given no worked examples on purpose: any example would be from some
   other project, and reproducing it here would hand this project's agents
   another codebase's rules. If you cannot ground a rule in something you have
   read, do not report it — an empty profileAdditions is a correct answer.

   Be specific and actionable — state the exact rule, not a general category. Do NOT edit ${PROFILES_REL} yourself.

6. EXPLICIT SKILL GAP FILL — After proactive inference, also do the traditional check:
   a. Compare each story's technicalNotes.requiredSkills against the agent's profile text
   b. For any skills explicitly listed but not covered in the profile, report them in profileAdditions

## YOUR OUTPUT — A DECISION, NOT AN EDIT

You do NOT write any file. You have no write tool, and hand-rolling scripts to
edit a 136,000-character JSON file is what made every previous attempt at this
task run out of iterations without ever finishing — one of them appended the same
rule four times and then spent its remaining turns undoing that.

Return ONE JSON object and nothing else. The pipeline applies it deterministically:

  {
    "storyRoleAssignments": [{"storyId": "<id>", "agentRole": "<role>"}],
    "profileAdditions":     [{"role": "<role>", "rules": ["<exact rule>", "..."]}],
    "newProfiles":          [{"role": "<role>", "profile": "<full profile text>"}]
  }

All three keys are required; use an empty array when there is nothing for one.
Rules already present in a profile are ignored, so do not try to de-duplicate.
A role that already has a profile is never replaced — use profileAdditions for it.
A story that already has an agentRole is never reassigned.

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

CRITICAL RULES:
- Keep ${PROFILES_REL} valid JSON at all times. Only ADD to existing profile strings, never remove content.
- A test-engineer profile must instruct the agent to ONLY write test files — never touch implementation files.
- The same agentRole must NEVER appear on both an implementation story and its paired test story in the same phase.
- Inferred skill additions must be specific and actionable (a concrete rule the agent can follow), not vague capability claims.
- NEVER write example API keys, tokens, or secrets into any source file — not even as placeholders. If example values are needed in documentation, read the credential from the environment (whatever variable THIS project already uses for it) or write the literal string \`YOUR_API_KEY_HERE\`. Any string matching \`/sk-[a-z]+-[a-zA-Z0-9]+/\` or resembling a credential will trigger a SAST blocker.
- NEVER modify package.json, tsconfig.json, vitest.config.ts, or any other scaffold-phase infrastructure file. These are owned by the scaffold phase and are immutable to all subsequent phases. If a story appears to require changing these files, flag it as a blocker in skills-gap-report.jsonl instead.
- NEVER rewrite the PRD file (${PRD_REL}) with a different story structure. You may only update agentRole fields and append to ${PROFILES_REL}. Any other structural change to the PRD is forbidden.
- NEVER modify .env, .env.*, *credentials*, or any file containing API keys or secrets. These files are immutable to all agents — modification would break the entire pipeline for all subsequent runs.
PROMPT_HEADER
    )

    # Append the phase-specific context
    assessment_prompt="${assessment_prompt}

## Phase: ${phase_id}

Read ${PRD_REL} implementationOrder[\"${phase_id}\"] for the story list, then proceed with the analysis above."

    # Fresh pre-call snapshot for reviewer diffing (profiles_backup is the
    # canonical original floor, not necessarily the immediately-prior state).
    local _pfa_profiles_before
    _pfa_profiles_before=$(cat "$profiles_file" 2>/dev/null || echo "{}")

    # PRD-side snapshot for the new field-allowlist checker/revert below.
    # Step 0.5 is only permitted to add new keys to profiles.json or change
    # agentRole/model/aiProvider/reasoningEffort on stories in THIS phase —
    # the same invariant already stated in assert_no_story_ids_lost's own
    # error text. Anything else (status flips, technicalNotes/AC rewrites,
    # story add/remove) is a violation worth retrying, not silently
    # accepting — this is the exact class of defect (found live 2026-07-12/
    # 13) that assert_no_story_ids_lost/assert_no_illegitimate_deprecation
    # could only detect and self-heal AFTER the fact; this loop tries to get
    # a correct answer from the model directly instead.
    local _pfa_prd_before_file
    _pfa_prd_before_file=$(mktemp)
    cp "$PRD_FILE" "$_pfa_prd_before_file"

    local _pfa_final_outcome="violated"
    local _pfa_attempt=0
    local _pfa_corrective_note=""

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): the prompt above
    # instructs the agent to run real jq commands against the PRD, read/write
    # profiles.json, and flock-append to JSONL files — without tool access the
    # agent can only print what it WOULD do, and no real change ever lands
    # (found live 2026-07-08, same class of bug already fixed for run_plan_mode
    # and claude.sh's run_pre_phase_assessment).
    for _pfa_attempt in 1 2 3; do
        local _pfa_prompt_this_attempt="$assessment_prompt"
        if [ -n "$_pfa_corrective_note" ]; then
            _pfa_prompt_this_attempt="${_pfa_prompt_this_attempt}

CRITICAL — YOUR PREVIOUS ATTEMPT VIOLATED YOUR OWN INSTRUCTIONS: ${_pfa_corrective_note}
Fix this and retry. Do not repeat the same mistake."
        fi

        local _pfa_call_ok=1
        # No story_id — this is a phase-level assessment, not tied to any single
        # story. Passing "${PHASE:-unknown}" here previously polluted agent-activity's
        # story_id field with the phase name ("core"), making "stories touched" counts
        # wrong (a 1-story PRD showed 2 distinct story_id values: the real story + "core").
        # B18 — write-scope. In the mock1 run (2026-07-24) this step issued
        # `write_file src/hello.ts`, editing the very application file the story was
        # about, BEFORE implementation ran — so impl no longer started from baseline.
        # The scope is now empty because the agent writes NOTHING: it returns a
        # decision and lib/assessment_apply.py applies it. Kept (empty) rather than
        # deleted so a future prompt change cannot quietly regain write access.
        # :- guards — under `set -u` an unset var here aborts the whole command and the
        # agent never runs at all (same class as the B14 bad-substitution abort).
        #
        # EPAM_RESPONSE_SCHEMA binds the output AT THE PROVIDER (AgentRunner sets
        # responseFormat strict:true) rather than asking for a shape in prose. It
        # is what makes the deterministic apply safe, and removing the writes is
        # what makes the schema safe: a schema over an agent that still exhausts
        # returns a valid EMPTY object, which is a loud failure turned silent.
        EPAM_ALLOWED_WRITE_PATHS="" \
        EPAM_MAX_TOOL_CALLS="${_pfa_tool_budget}" \
        EPAM_RESPONSE_SCHEMA="${_pfa_schema:-}" \
        run_orch_prompt_with_tools "$_pfa_prompt_this_attempt" "team-lead-agent" 2>&1 | tee "$assessment_log"
        # PIPESTATUS, not `|| _pfa_call_ok=0`: this is a PIPELINE, and its exit
        # status is tee's — always 0. The `||` branch could never fire on an agent
        # failure, so every failure here reported success. `set -e` does not save
        # it either, for the same reason (no `set -o pipefail`).
        [ "${PIPESTATUS[0]}" -eq 0 ] || _pfa_call_ok=0

        # A capability failure, not a content failure. The agent hit its iteration
        # cap and returned nothing, which means the TASK did not fit — not that it
        # misbehaved. The retry loop's corrective note ("YOUR PREVIOUS ATTEMPT
        # VIOLATED YOUR OWN INSTRUCTIONS") addresses the wrong thing, and the same
        # prompt at the same cap exhausts again: run 10 spent 2 attempts and $0.21
        # proving exactly that. Report it and stop, rather than buying another
        # identical failure at full price.
        if _pfa_capability_failed "$assessment_log"; then
            error "[pre-phase-assessment] agent exhausted its iteration cap without completing — NO profile augmentation happened for phase '$phase_id'"
            error "  The agent explored past its budget without answering, so nothing was applied."
            error "  NOT a fixed capability wall: on 2026-07-29 the same prompt at the same cap"
            error "  converged for two codelines and exhausted for a third — it varies with the"
            error "  repository. If this recurs, lower PRE_ASSESSMENT_MAX_TOOL_CALLS (currently"
            error "  ${_pfa_tool_budget}) so the agent commits earlier, rather than raising the iteration cap."
            error "  Not retrying: an identical prompt costs full price for the same roll. See $assessment_log"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            echo "$_pfa_profiles_before" > "$profiles_file"
            break
        fi

        # APPLY. The agent decided; the script writes. Every rule its prompt states
        # is enforced here instead of hoped for: a role is assigned only where one
        # is missing, a profile is created only when absent, and a rule already
        # present is never appended again — which is what run 12 could not manage
        # for itself ("The addendum was duplicated 4 times!").
        if [ -f "$SCRIPT_DIR/lib/assessment_apply.py" ]; then
            if ! python3 "$SCRIPT_DIR/lib/assessment_apply.py" \
                    --result "$assessment_log" --prd "$PRD_FILE" \
                    --profiles "$profiles_file" --phase "$phase_id" \
                    --repo-root "$PROJECT_ROOT"; then
                # Nothing was written — the module fails closed. Treat it as a
                # failed attempt so the loop's existing recovery handles it,
                # rather than proceeding as though the phase was assessed.
                warning "[pre-phase-assessment] the agent's decision could not be applied — see $assessment_log"
                _pfa_call_ok=0
            fi
        fi

        if [ "$_pfa_call_ok" -eq 0 ]; then
            _pfa_corrective_note="the tool call itself failed (non-zero exit) — check $assessment_log"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            echo "$_pfa_profiles_before" > "$profiles_file"
            continue
        fi

        "$SCRIPT_DIR/update-monitor.sh" event "pre_phase_assessment" "Pre-phase assessment completed" "" "main" "team-lead-agent" 2>/dev/null || true

        # Validate profiles.json is still valid JSON — a syntax corruption is
        # not retry-able (the model can't fix malformed JSON by trying the
        # exact same prompt again), so this stays an immediate hard stop.
        if ! jq empty "$profiles_file" 2>/dev/null; then
            error "Pre-phase assessment corrupted profiles.json! Restoring backup."
            cp "$profiles_backup" "$profiles_file"
            cp "$_pfa_prd_before_file" "$PRD_FILE"
            rm -f "$_pfa_prd_before_file"
            return 1
        fi

        local _pfa_violated=0
        local _pfa_violation_reason=""

        # Reviewer gate — Step 0.5 can create brand-new profiles from scratch
        # and append arbitrary skill rules to existing ones (typescript-engineer,
        # sast-sentinel, review-ranger, etc). The jq-empty check above only
        # catches JSON syntax corruption; this catches bad CONTENT.
        if [ -n "${ORCH_GATE_PROVIDER:-}" ]; then
            local _pfa_before_tmp
            _pfa_before_tmp=$(mktemp)
            printf '%s' "$_pfa_profiles_before" > "$_pfa_before_tmp"
            local _pfa_diff
            _pfa_diff=$(python3 - "$_pfa_before_tmp" "$profiles_file" <<'PFA_DIFF_PY'
import json, sys
with open(sys.argv[1]) as f:
    before = json.load(f)
with open(sys.argv[2]) as f:
    after = json.load(f)
new_keys = [k for k in after if k not in before]
changed_keys = [k for k in after if k in before and after[k] != before[k]]
out = {
    "new_profiles": {k: after[k][:1500] for k in new_keys},
    "changed_profiles": {k: {"before": before[k][-800:], "after": after[k][-800:]} for k in changed_keys}
}
print(json.dumps(out))
PFA_DIFF_PY
)
            rm -f "$_pfa_before_tmp"
            local _pfa_has_changes
            _pfa_has_changes=$(echo "$_pfa_diff" | python3 -c "import sys,json; d=json.load(sys.stdin); print(1 if d['new_profiles'] or d['changed_profiles'] else 0)" 2>/dev/null || echo 0)

            if [ "${_pfa_has_changes:-0}" = "1" ]; then
                local _pfa_reviewer_profile
                _pfa_reviewer_profile=$(jq -r '."prd-change-reviewer" // ""' "$profiles_file" 2>/dev/null || echo "")
                if [ -n "$_pfa_reviewer_profile" ]; then
                    local _pfa_verdict
                    _pfa_verdict=$(echo "${_pfa_reviewer_profile}

STORY: pre-phase-assessment-${phase_id}
CHANGE TYPE: profile_creation

BEFORE/AFTER DIFF:
${_pfa_diff:0:3000}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}" | \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER}" \
                        AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER}" \
                            --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
                        2>/dev/null | \
                        python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(obj.get('verdict','pass'))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'\"verdict\"\s*:\s*\"(pass|fail)\"', text)
print(m.group(1) if m else 'pass')
" 2>/dev/null || echo "pass")
                    if [ "$_pfa_verdict" = "fail" ]; then
                        _pfa_violated=1
                        _pfa_violation_reason="${_pfa_violation_reason}profiles.json content was rejected by the reviewer (bad/vague skill rule content); "
                    else
                        success "  [pre-phase-assessment] Profile changes approved by reviewer"
                    fi
                fi
            fi
        fi

        # NEW: deterministic PRD-side field-allowlist check. Unlike the
        # profiles reviewer above (a content-quality judgment call), this is
        # a 100% mechanical invariant — same "check it in code instead of
        # asking an LLM to eyeball it" philosophy as Step 0.9's MC_REVIEW_PY.
        local _pfa_prd_stderr_file
        _pfa_prd_stderr_file=$(mktemp)
        local _pfa_prd_verdict
        _pfa_prd_verdict=$(python3 - "$_pfa_prd_before_file" "$PRD_FILE" "$phase_id" 2>"$_pfa_prd_stderr_file" <<'PFA_PRD_DIFF_PY'
import json, sys

ALLOWED_FIELDS = {'agentRole', 'model', 'aiProvider', 'reasoningEffort'}

before_path, after_path, phase_id = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(before_path) as f:
        before = json.load(f)
    with open(after_path) as f:
        after = json.load(f)
except Exception as e:
    print('fail')
    print(f"VIOLATION: PRD is not valid JSON after write: {e}", file=sys.stderr)
    sys.exit(0)

phase_ids = set(before.get('implementationOrder', {}).get(phase_id, []))
before_by_id = {s['id']: s for s in before.get('stories', []) if 'id' in s}
after_by_id = {s['id']: s for s in after.get('stories', []) if 'id' in s}

violations = []
if set(before_by_id) != set(after_by_id):
    added = set(after_by_id) - set(before_by_id)
    removed = set(before_by_id) - set(after_by_id)
    if added:
        violations.append(f"stories added: {sorted(added)}")
    if removed:
        violations.append(f"stories removed: {sorted(removed)}")

for sid in phase_ids:
    b = before_by_id.get(sid)
    a = after_by_id.get(sid)
    if b is None or a is None:
        continue  # already reported above as added/removed
    all_keys = set(b.keys()) | set(a.keys())
    for key in all_keys:
        if key in ALLOWED_FIELDS:
            continue
        if b.get(key) != a.get(key):
            violations.append(f"{sid}.{key} changed (not an allowed field for pre-phase assessment)")

if violations:
    print('fail')
    for v in violations[:20]:
        print(f"VIOLATION: {v}", file=sys.stderr)
else:
    print('pass')
PFA_PRD_DIFF_PY
)
        if [ "$_pfa_prd_verdict" = "fail" ]; then
            _pfa_violated=1
            _pfa_violation_reason="${_pfa_violation_reason}$(tr '\n' ' ' < "$_pfa_prd_stderr_file")"
        fi
        rm -f "$_pfa_prd_stderr_file"

        if [ "$_pfa_violated" -eq 0 ]; then
            _pfa_final_outcome="pass"
            step_emit "3" "pass" "Step 3: Skill assessment"
            success "Pre-phase assessment completed for '$phase_id'"
            break
        fi

        # Violated (profiles content, PRD fields, or both) — revert BOTH
        # files to this attempt's pre-call state so retries never compound
        # on top of a partially-bad write, then either retry (attempts
        # remain) or accept the reverted state (exhausted).
        echo "$_pfa_profiles_before" > "$profiles_file" 2>/dev/null || true
        cp "$_pfa_prd_before_file" "$PRD_FILE"
        _pfa_corrective_note="$_pfa_violation_reason"
        _pfa_final_outcome="reverted"
        warning "  [pre-phase-assessment] Attempt ${_pfa_attempt}/3 violated scope: ${_pfa_violation_reason}"
    done

    local _pfa_violation_types="[]"
    if [ -n "$_pfa_corrective_note" ]; then
        _pfa_violation_types=$(printf '%s' "$_pfa_corrective_note" | python3 -c "
import json, sys
reason = sys.stdin.read()
types = []
if 'tool call itself failed' in reason:
    types.append('tool_call_failed')
if 'profiles.json content was rejected' in reason:
    types.append('profiles_content_rejected')
if 'not valid JSON' in reason:
    types.append('invalid_json')
if 'stories added' in reason:
    types.append('story_added')
if 'stories removed' in reason:
    types.append('story_removed')
if 'changed (not an allowed field' in reason:
    types.append('field_out_of_scope')
print(json.dumps(types))
" 2>/dev/null || echo "[]")
    fi

    _log_guarded_step_retry "$(jq -n -c \
        --arg step "0.5" \
        --arg phase "$phase_id" \
        --argjson attempts "$_pfa_attempt" \
        --arg outcome "$_pfa_final_outcome" \
        --arg reason "$_pfa_corrective_note" \
        --argjson violationTypes "$_pfa_violation_types" \
        '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, reason: $reason, violationTypes: $violationTypes}' \
        2>/dev/null)"
    rm -f "$_pfa_prd_before_file"

    if [ "$_pfa_final_outcome" != "pass" ]; then
        step_emit "3" "warn" "Step 3: Skill assessment" "non-critical"
        warning "Pre-phase assessment for '$phase_id' reverted after 3 attempts (non-critical, continuing): ${_pfa_corrective_note}"
    fi
}

step_emit "3" "running" "Step 3: Skill assessment"
log "Step 3: Running pre-phase skill assessment..."
if is_truthy "${SKIP_SKILL_ASSESSMENT:-}"; then
    step_emit "3" "skip" "Step 3: Skill assessment" "SKIP_SKILL_ASSESSMENT=1"
    log "Step 3: Skipped (SKIP_SKILL_ASSESSMENT=1)"
else
    run_pre_phase_assessment "$PHASE"
fi
assert_no_story_ids_lost "presplit" "Step 3: Skill assessment"
assert_no_story_ids_gained "presplit" "Step 3: Skill assessment"
assert_no_illegitimate_deprecation "presplit" "Step 3: Skill assessment"

# ── Mid-execution split validation ────────────────────────────────────────────
# Speckit must review ALL splits, not only those proposed by openspec during
# the spec pass (Step 0). The pre-phase assessment agent (Step 0.5) may write
# new stories directly to the PRD. Validate those before execution begins.
# validate_mid_execution_splits — now in lib/story-guards.sh (sourced above).
validate_mid_execution_splits "$PHASE"

# ── Post-assessment AC invariant check ────────────────────────────────────────
# No story in implementationOrder may have >24 ACs before execution begins.
# Catches spec-pass overflow or Step 0.5 agent writes that bypassed capSplitACs.
check_ac_invariant() {
    local _phase_id="$1"
    local _violations
    _violations=$(jq -r \
        --arg phase "$_phase_id" \
        --argjson max 24 \
        '(.implementationOrder[$phase] // []) as $order |
         .stories[] |
         select(
           (.id as $id | $order | index($id) != null) and
           ((.acceptanceCriteria // []) | length > $max)
         ) | "\(.id): \((.acceptanceCriteria // []) | length) ACs"' \
        "$PRD_FILE" 2>/dev/null)

    if [ -n "$_violations" ]; then
        warning "  [ac-invariant] Stories exceeding 24-AC limit (may cause spec-validator failures):"
        while IFS= read -r _v; do warning "    $_v"; done <<< "$_violations"
    else
        log "  [ac-invariant] All stories within 24-AC limit for phase '$_phase_id'"
    fi
}

check_ac_invariant "$PHASE"

# ──────────────────────────────────────────────
# Step 0.6 (hybrid only): Pre-phase coordination
# Seeds the MCP message bus with guidance messages
# and identifies any stories requiring plan mode.
# ──────────────────────────────────────────────
run_hybrid_precoordination() {
    local phase_id="$1"
    local coord_log="$LOG_DIR/hybrid-coord-${phase_id}.log"
    local coord_prompt
    touch "$MESSAGES_JSONL"

    coord_prompt=$(cat << COORD_EOF
You are the coordination agent running in HYBRID PRE-PHASE mode for phase: ${phase_id}.

## Task
1. Read ${PRD_REL} and locate all stories in implementationOrder["${phase_id}"].
2. Identify cross-lane dependencies between main, primary, and independent agent groups.
3. Flag any stories where estimatedHours >= 6 or dependencies count >= 2 — these require plan mode.
4. For each cross-lane dependency or plan-mode story, append a JSON message to orchestrations/logs/agent-messages.jsonl.
   Use this schema (one compact JSON line per message):
   {"id":"coord_<storyid>_<epoch>","timestamp":"<ISO8601>","from_agent":"coordination-agent","to_agent":"<agentRole>","story_id":"<id>","phase_id":"${phase_id}","message_type":"<handoff|plan_required|risk>","priority":"normal","subject":"<subject>","body":"<body>","status":"new"}
5. Post a final {"message_type":"phase_ready","to_agent":"orchestrator","phase_id":"${phase_id}",...} message when complete.
6. Use: (flock -w 10 9 >> orchestrations/logs/agent-messages.jsonl; printf '%s\n' '<json>' >&9) 9>>orchestrations/logs/agent-messages.jsonl for atomic writes.
7. Write a summary of actions to orchestrations/logs/hybrid-coord-${phase_id}.log.

## Constraints
- Do NOT modify source code or prd.json stories.
- Only write to orchestrations/logs/agent-messages.jsonl and orchestrations/logs/hybrid-coord-${phase_id}.log.
COORD_EOF
    )

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): the prompt above
    # instructs reading the PRD and flock-appending real JSONL messages — same
    # class of bug already fixed for the assessment agents above.
    local _hpc_attempt=0 _hpc_ok=0
    while [ "$_hpc_attempt" -lt 2 ] && [ "$_hpc_ok" = "0" ]; do
        local _hpc_prompt="$coord_prompt"
        [ "$_hpc_attempt" -ge 1 ] && _hpc_prompt="RETRY (attempt 2): The previous invocation produced no output. Use your tools to read the PRD, write coordination messages to agent-messages.jsonl, and write the summary log now.

$coord_prompt"
        # No story_id — phase-level coordination call, not tied to a single story.
        run_orch_prompt_with_tools "$_hpc_prompt" "spec-coordinator" 2>&1 | tee "$coord_log"
        if [ -s "$coord_log" ]; then
            _hpc_ok=1
        else
            [ "$_hpc_attempt" -lt 1 ] && warning "Hybrid pre-phase coordination attempt 1 produced no output — retrying" || warning "Hybrid pre-phase coordination had issues — continuing with bash fallback"
        fi
        _hpc_attempt=$(( _hpc_attempt + 1 ))
    done
    if [ "$_hpc_ok" = "1" ]; then
        step_emit "4" "pass" "Step 4: Hybrid pre-coord"
        success "Hybrid pre-phase coordination completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "hybrid_precoord" \
            "Hybrid pre-phase coordination completed" "" "main" "coordination-agent" 2>/dev/null || true
    else
        warning "Hybrid pre-phase coordination had issues — continuing with bash fallback"
    fi
}

if [ "$RESOLVED_ORCH_MODE" = "hybrid" ]; then
    log "Step 4: Hybrid mode — running pre-phase coordination..."
    run_hybrid_precoordination "$PHASE"
else
    step_emit "4" "skip" "Step 4: Hybrid pre-coord" "ORCH_MODE=${RESOLVED_ORCH_MODE}"
    info "Step 4: Skipped (ORCH_MODE=${RESOLVED_ORCH_MODE})"
fi

# ──────────────────────────────────────────────
# Step 0.7: Cross-phase regression guard
# Run the project's own test command before any story in this phase executes,
# introduced by the previous phase. Blocks on failure.
# Skip with: SKIP_REGRESSION_GUARD=true
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_REGRESSION_GUARD:-}"; then
    # Brownfield: run tests in the codeline directory, not PROJECT_ROOT.
    # The codeline has its own node_modules with its own test runner.
    _rg_root="$PROJECT_ROOT"
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -n "${JIRA_DEFAULT_CODELINE:-}" ]; then
        _cl_upper=$(echo "$JIRA_DEFAULT_CODELINE" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')
        # NOTE: `${!JIRA_WORKTREE_${_cl_upper}:-}` is NOT valid bash — nested
        # expansion inside an indirect reference is a FATAL "bad substitution" that
        # aborts the script. It sat here as dead code, immediately overwritten by
        # the correct two-step form below, and was only ever reachable when
        # JIRA_DEFAULT_CODELINE is set (no project set it until mock2 did on
        # 2026-07-24). Removed — the two-step form is the correct idiom.
        _wtvar="JIRA_WORKTREE_${_cl_upper}"
        _cl_path="${!_wtvar:-}"
        [ -n "$_cl_path" ] && _rg_root="$_cl_path"
    fi
    # Resolve node AFTER _rg_root is finalized — must be the version the
    # codeline itself declares (engines.node), not whatever version happens
    # to be active in the orchestrator's own shell. See resolve_codeline_node
    # above for why this matters (a Node major-version mismatch crashes
    # the test runner outright rather than reporting a normal test failure).
    _rg_node=$(resolve_codeline_node "$_rg_root" 2>/dev/null || true)
    # How this project runs its tests is the project's answer (see below).
    # HOW THIS PROJECT RUNS ITS TESTS IS THE PROJECT'S ANSWER, NOT OURS.
    #
    # This used to detect a runner by name and invoke `<runner> run`. Live
    # AMSD-2041 run 5: `run` is vitest's "run once" subcommand and a test PATH
    # PATTERN in jest, so jest searched 874 test files for paths matching "run",
    # found none, exited 1 — and the guard reported the client's baseline as
    # broken. A false red on the gate whose entire job is telling us whether the
    # baseline can be trusted, and it would have failed every lane in turn.
    #
    # Now: the project's own `scripts.test`, executed through the package manager
    # its lockfile names. No runner name and no runner-specific flag appears
    # here, so a stack neither of us has seen still works.
    _rg_test_declared=0
    if [ -f "$_rg_root/package.json" ] &&
       jq -e '(.scripts.test // "") != ""' "$_rg_root/package.json" >/dev/null 2>&1; then
        _rg_test_declared=1
    fi

    # The package manager, from the lockfile the project committed.
    _rg_pm=""
    [ -f "$_rg_root/pnpm-lock.yaml" ]      && _rg_pm="pnpm"
    [ -z "$_rg_pm" ] && [ -f "$_rg_root/yarn.lock" ] && _rg_pm="yarn"
    [ -z "$_rg_pm" ] && { [ -f "$_rg_root/package-lock.json" ] || [ -f "$_rg_root/npm-shrinkwrap.json" ]; } && _rg_pm="npm"
    [ -z "$_rg_pm" ] && [ "$_rg_test_declared" -eq 1 ] && _rg_pm="npm"

    # Kept for ensure_node_modules_healthy's smoke test below, which asks "is
    # node_modules usable" — any installed executable answers that.
    _rg_bin=""
    if [ -d "$_rg_root/node_modules/.bin" ]; then
        _rg_bin="$(find "$_rg_root/node_modules/.bin" -maxdepth 1 -type f -o -maxdepth 1 -type l 2>/dev/null | head -1)"
    fi
    # Brownfield environment prep: node_modules can be present-but-corrupted
    # (a prior interrupted install left truncated native binaries — real
    # incident, 2026-07-22) or missing entirely for a codeline the pipeline
    # hasn't touched before. Smoke-test + repair BEFORE trusting the test
    # runner, so a broken environment reads as a clear repair attempt, not a
    # confusing "tests broken" failure that's actually an environment issue.
    if [ -n "$_rg_node" ] && [ -f "$_rg_root/package.json" ]; then
        # CANNOT-VERIFY is a third outcome, and it is never a pass.
        #
        # This was `|| true`. Live metrolinx 2026-07-29: the repair guard reported
        # "REPAIR DESTROYED WHAT IT FOUND ... 1134 entries -> 1011 ... its gates
        # cannot run", ensure_node_modules_healthy returned non-zero to say so,
        # and `|| true` discarded it — the run continued on a wrecked toolchain
        # with 15 processes. A regression guard run against broken dependencies
        # does not report a regression; it reports whatever a broken toolchain
        # emits, which is as likely to be a false PASS as a failure. Same shape
        # as review gates passing on zero files: a verdict with no evidence.
        #
        # The halt rule covers "failed after retries and self-heal". This is the
        # other case — nothing failed, and nothing can be trusted either.
        if ! ensure_node_modules_healthy "$_rg_root" "$_rg_node" "$_rg_bin"; then
            step_emit "5" "fail" "Step 5: Regression guard"
            error "Step 5: codeline CANNOT BE VERIFIED — its dependencies are unusable in $_rg_root"
            error "  This is not a test failure: the tests were never run against a sound tree."
            error "  Reinstall this codeline's dependencies, then re-run."
            error "  Bypass with: SKIP_REGRESSION_GUARD=true (accepts an unverified baseline)"
            exit 1
        fi
        # Re-detect — a first-time install creates node_modules/.bin/* that
        # didn't exist a moment ago. Any entry answers "is node_modules usable".
        _rg_bin=""
        if [ -d "$_rg_root/node_modules/.bin" ]; then
            _rg_bin="$(find "$_rg_root/node_modules/.bin" -maxdepth 1 -type f -o -maxdepth 1 -type l 2>/dev/null | head -1)"
        fi
    fi
    if [ -n "$_rg_node" ] && [ "$_rg_test_declared" -eq 1 ] && [ -n "$_rg_pm" ] && [ -n "$_rg_bin" ]; then
        step_emit "5" "running" "Step 5: Regression guard"
        log "Step 5: Cross-phase regression guard ($_rg_pm test) in $_rg_root..."
        _rg_log="$LOG_DIR/regression-guard-${PHASE}.log"
        # ── Retry before calling it a regression ──────────────────────────────
        # The rule this gate enforces is that coding must not INCREASE the
        # failure count — which needs a count that means something twice running.
        # Live AMSD-2041 (2026-07-28), next.gotransit.com at origin/develop with
        # a clean tree and no implementation yet: the suite reported 4 failures,
        # then 1, then 0 across three runs, and the failing test CHANGED between
        # them. In isolation those same files passed 3/3. That is interference
        # under a 737-suite parallel run, not broken code — and blocking on it
        # stops a run for something no one can fix.
        #
        # The WHOLE command is retried rather than re-running the individually
        # named failures: extracting test names means parsing a specific runner's
        # output, and this engine has to work on the next unknown project without
        # being taught its grammar. A green attempt ends the loop immediately, so
        # the common case still costs exactly one run.
        #
        # This is NOT baseline subtraction. Recording pre-existing failures and
        # subtracting them assumes a stable baseline; against a flaky suite it
        # would permanently excuse whichever tests happened to fail at capture
        # time, including a real regression in the same file.
        _rg_retries="${EPAM_REGRESSION_GUARD_RETRIES:-2}"
        _rg_max=$(( _rg_retries + 1 ))
        _rg_rc=1
        for _rg_try in $(seq 1 "$_rg_max"); do
            # Each attempt keeps its own log — one path overwritten twice leaves
            # only the last attempt, and the first is usually the informative one.
            _rg_try_log="$_rg_log"
            [ "$_rg_try" -gt 1 ] && _rg_try_log="${_rg_log%.log}-attempt-${_rg_try}.log"
            set +e
            # The project's OWN command. Its node is put on PATH first so the script
            # resolves the version the codeline declares, without us naming a runner
            # or guessing its arguments.
            (cd "$_rg_root" && PATH="$(dirname "$_rg_node"):$PATH" "$_rg_pm" test) > "$_rg_try_log" 2>&1
            _rg_rc=$?
            set -e
            [ "$_rg_rc" -eq 0 ] && break
            if [ "$_rg_try" -lt "$_rg_max" ]; then
                warning "Step 5: attempt ${_rg_try}/${_rg_max} failed — re-running to tell a flaky suite from a real regression"
            fi
        done
        # RG-DELTA (backlog item, user requirement 2026-07-30): a fully-red
        # baseline used to be an unconditional hard-fail — live AMSD-2041,
        # 2026-07-31: gotransit had exactly ONE genuinely-failing test on
        # develop itself (unrelated to the story), and the guard blocked the
        # entire run over it. When the project declares testFailurePattern,
        # extract the failing-test IDENTITY from each attempt's log and take
        # the INTERSECTION — only tests failing in EVERY attempt are stable
        # (same bar the flake retry above already uses: "survives every
        # attempt"). A stable set is a trustworthy pre-existing baseline and
        # is tolerated; an UNSTABLE set (attempts disagree on what failed,
        # the exact live gotransit interference shape from 2026-07-28) cannot
        # be trusted and falls through to the existing hard-fail unchanged.
        # No testFailurePattern configured -> today's exact behavior, since
        # every existing project's manifest lacks this field.
        _rg_tolerated=0
        if [ $_rg_rc -ne 0 ]; then
            _rg_pattern=""
            if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
                _rg_pattern=$(jq -r '.testFailurePattern // empty' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null)
            fi
            if [ -n "$_rg_pattern" ]; then
                _rg_baseline_file="$LOG_DIR/regression-guard-baseline-${PHASE}.json"
                _rg_intersect=$(python3 - "$_rg_pattern" "$_rg_max" "$_rg_log" << 'RG_INTERSECT_PY'
import re, sys, json

pattern, max_attempts, log_base = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    rx = re.compile(pattern, re.MULTILINE)
except re.error:
    print(json.dumps({"stable": False, "failures": []}))
    sys.exit(0)

def attempt_log(i):
    if i == 1:
        return log_base
    if log_base.endswith('.log'):
        return log_base[:-4] + f"-attempt-{i}.log"
    return f"{log_base}-attempt-{i}"

sets = []
for i in range(1, max_attempts + 1):
    try:
        with open(attempt_log(i)) as f:
            text = f.read()
    except OSError:
        sets.append(None)
        continue
    ids = set()
    for m in rx.finditer(text):
        g = next((x for x in m.groups() if x), None)
        if g:
            ids.add(g)
    sets.append(ids)

# A missing log, or an attempt that parsed NO failing identity despite the
# command's own nonzero exit, means the pattern is not matching this run's
# real output — never silently treat "found nothing" as "an empty stable
# set", which would look identical to a genuinely green baseline.
if any(s is None or len(s) == 0 for s in sets):
    print(json.dumps({"stable": False, "failures": []}))
else:
    # Live AMSD-2041, 2026-07-31 (gotransit): a test surviving every attempt
    # (schedules.spec.tsx) is reproducible per the backlog's own bar — but
    # attempt 3 ALSO had two unrelated tests flake in under parallel-suite
    # interference. Requiring the WHOLE union to match across every attempt
    # (the original version here) let that one-off noise poison an
    # otherwise-clean, genuinely reproducible baseline and blocked a real
    # launch outright. The intersection ALONE is what's trustworthy —
    # tolerate exactly that, and simply drop the one-off extras as the
    # flakiness the 3-attempt retry exists to filter, never adding them to
    # the tolerated set (which would risk masking a real regression there).
    stable = set.intersection(*sets)
    print(json.dumps({"stable": len(stable) > 0, "failures": sorted(stable)}))
RG_INTERSECT_PY
)
                if echo "$_rg_intersect" | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('stable') else 1)" 2>/dev/null; then
                    echo "$_rg_intersect" > "$_rg_baseline_file"
                    _rg_tolerated_count=$(echo "$_rg_intersect" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['failures']))" 2>/dev/null || echo 0)
                    _rg_tolerated=1
                    _rg_rc=0
                fi
            fi
        fi
        if [ $_rg_rc -ne 0 ]; then
            step_emit "5" "fail" "Step 5: Regression guard"
            error "Step 5: Regression guard FAILED — tests red in all ${_rg_max} attempt(s) before phase '$PHASE' starts"
            error "  The failure survived every attempt, so it is reproducible, not a flake."
            error "  Fix failing tests from the previous phase before continuing."
            error "  See: $_rg_log"
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
        if [ "$_rg_tolerated" = "1" ]; then
            step_emit "5" "pass" "Step 5: Regression guard"
            warning "Step 5: Regression guard — ${_rg_tolerated_count} pre-existing failure(s) tolerated (stable across ${_rg_max} attempts; baseline: $_rg_baseline_file)"
            success "Step 5: Regression guard PASSED — pre-existing failures recorded as a tolerated RG-DELTA baseline"
        else
            if [ "${_rg_try:-1}" -gt 1 ]; then
                warning "Step 5: baseline green on attempt ${_rg_try}/${_rg_max} — the suite is FLAKY; earlier attempts failed"
                warning "  This is the codeline's own instability, not a regression. Worth reporting upstream."
            fi
            step_emit "5" "pass" "Step 5: Regression guard"
            success "Step 5: Regression guard PASSED — baseline tests green"
        fi
    else
        # "This repo has no tests" and "we could not run this repo's tests" are
        # opposite situations, and this branch used to treat them identically —
        # emitting `skip` at info level either way.
        #
        # Live metrolinx 2026-07-28: "Step 5: Regression guard — node/vitest not
        # found" against a real client repository. The gate that catches "the
        # previous phase broke existing tests" did not run, and the run carried
        # on with nothing reading as a problem. That is the fail-open class this
        # pipeline keeps producing — the same shape as a lint gate exiting 2
        # having examined zero files.
        #
        # The repo itself says which case it is: a `test` script, or vitest/jest
        # among its dependencies. No stack knowledge in the engine, no
        # per-project configuration.
        # Not `local`: Step 5 runs at top level, not inside a function.
        # "Declares tests" is the project's own scripts.test — nothing else.
        # An earlier version also looked for two runner names in the dependency
        # lists, which is the same hard-coding that produced the false red above:
        # a project using a third runner would have been judged by a list that
        # never mentioned it.
        if [ "$_rg_test_declared" -eq 1 ]; then
            step_emit "5" "fail" "Step 5: Regression guard" "declares a test script but it could not be run"
            error "Step 5: Regression guard COULD NOT RUN — $_rg_root declares a test script but it could not be executed"
            error "  node: ${_rg_node:-<not found>}   package manager: ${_rg_pm:-<none detected>}   node_modules: $([ -n "$_rg_bin" ] && echo present || echo empty)"
            error "  The baseline is therefore UNVERIFIED: a break introduced by an earlier phase would not be caught."
            error "  This is an environment failure, not an absence of tests — check the codeline's node_modules install."
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi

        step_emit "5" "skip" "Step 5: Regression guard" "repo declares no tests — not applicable"
        info "Step 5: Regression guard not applicable — $_rg_root declares no test script or test runner"
    fi
else
    step_emit "5" "skip" "Step 5: Regression guard" "SKIP_REGRESSION_GUARD=true"
    info "Step 5: Regression guard skipped (SKIP_REGRESSION_GUARD=true)"
fi

# ──────────────────────────────────────────────
# Step 0.8: Ensure standard src/ subdirectories exist so M3 can write into them
# without relying on the model creating the directory first.
# ──────────────────────────────────────────────
step_emit "6" "running" "Step 6: mkdir src/ dirs"
# Only generic scaffolding dirs. A client-named subdirectory here was created in
    # EVERY project the engine ran, regardless of what that project is.
    mkdir -p "$PROJECT_ROOT/src" "$PROJECT_ROOT/public" "$PROJECT_ROOT/review" 2>/dev/null || true
step_emit "6" "pass" "Step 6: mkdir src/ dirs"

# ──────────────────────────────────────────────
# Step 0.9: PRD model coordinator — ensures every pending story (base +
# split children created by the spec pass) has explicit model, aiProvider,
# and reasoningEffort fields written into the PRD itself. Without this,
# split children silently fall back to a provider's hardcoded default model
# (e.g. MiniMax-M2.5 instead of MiniMax-M3) because they inherit no fields
# from their parent story. The PRD, not env vars or provider defaults, is
# the single source of truth for per-story model assignment.
# ──────────────────────────────────────────────
step_emit "7" "running" "Step 7: PRD model coordinator"
_emit_agent start "prd-model-coordinator" "PRD Model Coordinator"
if is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}"; then
    info "  [prd-model-coordinator] Skipped (SKIP_PRD_MODEL_COORDINATOR=1)"
    _emit_agent complete "prd-model-coordinator" "skipped"
    step_emit "7" "skip" "Step 7: PRD model coordinator" "SKIP_PRD_MODEL_COORDINATOR=1"
else
    _mc_phase="${CURRENT_PHASE:-${PHASE:-unknown}}"
    _mc_prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    _mc_profiles_file="${AUTOMATION_DIR}/agents/profiles.json"

    _mc_missing_count=$(jq -r --arg ph "$_mc_phase" '
        [.stories[] | select((.phase // $ph) == $ph)
          | select(.status == "pending")
          | select((.model // "") == "" or (.aiProvider // "") == "" or (.reasoningEffort // "") == "")
        ] | length
    ' "$_mc_prd_target" 2>/dev/null || echo 0)

    if [ "${_mc_missing_count:-0}" -eq 0 ]; then
        info "  [prd-model-coordinator] All pending stories already have model/aiProvider/reasoningEffort"
    else
        info "  [prd-model-coordinator] ${_mc_missing_count} pending stor(y/ies) missing model assignment — coordinating..."
        _mc_prd_before=$(cat "$_mc_prd_target" 2>/dev/null || echo "{}")
        _mc_corrective_note=""
        _mc_final_outcome="noop"
        _mc_attempt=0

        # Retry-on-violation (2026-07-13): MC_REVIEW_PY below already computes
        # a clean, deterministic pass/fail signal — it just used to only ever
        # revert-and-give-up on 'fail', never tell the model what it did
        # wrong and let it try again. Same "detect, explain, retry" shape as
        # checkSplitMandateViolation's existing precedent in spec-mode-runner.js.
        for _mc_attempt in 1 2 3; do
        _mc_prompt=$(cat << ENDPROMPT_MC
$(cat "$_mc_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('prd-model-coordinator',''))" 2>/dev/null)

PRD file: ${_mc_prd_target}
Phase: ${_mc_phase}

Assign model, aiProvider, and reasoningEffort to every pending story in this phase that is missing one or more of these fields. Write the updated PRD back to the file, then emit the JSON summary.
ENDPROMPT_MC
)
        if [ -n "$_mc_corrective_note" ]; then
            _mc_prompt="${_mc_prompt}

CRITICAL — YOUR PREVIOUS ATTEMPT VIOLATED YOUR OWN INSTRUCTIONS: ${_mc_corrective_note}
Fix this and retry. Do not repeat the same mistake."
        fi
        _mc_result=$(echo "$_mc_prompt" | \
            AI_GATE_ALLOW_TOOLS=1 \
            AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
            AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
            EPAM_DANGEROUS_SKIP_APPROVAL=1 \
            EPAM_MAX_TOOL_CALLS="${PRD_MODEL_COORDINATOR_MAX_TOOL_CALLS:-12}" \
            CLAUDE_CMD="$CLAUDE_CMD" \
            EPAM_CLI="${EPAM_CLI:-epam}" \
            "$AI_RUNNER_CMD" \
                --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
            2>&1 | tee -a "$LOG_DIR/prd-model-coordinator-${_mc_phase}.log")

        _mc_assigned_count=$(echo "$_mc_result" | python3 -c "
import sys, re, json
txt = sys.stdin.read()
for m in re.finditer(r'\{[^{}]*\"assigned_count\"[^{}]*\}', txt, re.DOTALL):
    try:
        obj = json.loads(m.group(0))
        print(obj.get('assigned_count', 0))
        break
    except: pass
else: print(0)
" 2>/dev/null || echo 0)

        _mc_prd_after=$(cat "$_mc_prd_target" 2>/dev/null || echo "{}")
        # Gate on whether the PRD FILE actually changed, not the agent's own
        # self-reported assigned_count. Root cause of a live-run defect
        # (2026-07-03): the agent has tool access (AI_GATE_ALLOW_TOOLS=1) and
        # can write the PRD directly via WriteFile regardless of what its own
        # JSON summary claims. It silently split SKY-001 into SKY-001-A/B
        # while reporting "no assignments made" (assigned_count absent/0) —
        # so the old assigned_count-gated check never even looked at the
        # file, and the rogue split was never reviewed or reverted.
        if [ "${_mc_assigned_count:-0}" -gt 0 ] || [ "$_mc_prd_before" != "$_mc_prd_after" ]; then
            # Deterministic reviewer gate. This USED to ask an LLM to judge a
            # BEFORE/AFTER excerpt truncated to the LAST 1000 CHARACTERS of
            # the PRD — for any real multi-KB PRD, that is structurally
            # blind to a change anywhere earlier in the file. Root cause of a
            # live-run defect (2026-07-08/09): the coordinator silently
            # stripped technicalNotes.files from SKY-002/003/004 — nowhere
            # near the tail of the file — while the excerpt-based reviewer
            # saw nothing wrong and approved it; a later remediation step
            # then dropped those now-fileless stories from
            # implementationOrder.core, and the core phase silently ran as a
            # no-op with zero error.
            #
            # "A model-assignment write may only change model, aiProvider,
            # and reasoningEffort, on stories that were actually missing
            # them" is a 100% mechanically checkable invariant, not a
            # judgment call — so check it in code instead of asking an LLM to
            # eyeball a truncated excerpt. No blind spot, no token cost, no
            # chance of an LLM missing it. Enlarging the excerpt window would
            # only move the blind spot, never eliminate it.
            _mc_before_file=$(mktemp)
            _mc_after_file=$(mktemp)
            _mc_verdict_stderr=$(mktemp)
            printf '%s' "$_mc_prd_before" > "$_mc_before_file"
            printf '%s' "$_mc_prd_after" > "$_mc_after_file"
            _mc_verdict=$(python3 - "$_mc_before_file" "$_mc_after_file" 2>"$_mc_verdict_stderr" << 'MC_REVIEW_PY'
import json, sys

ALLOWED_FIELDS = {'model', 'aiProvider', 'reasoningEffort'}

before_path, after_path = sys.argv[1], sys.argv[2]
try:
    with open(before_path) as f:
        before = json.load(f)
    with open(after_path) as f:
        after = json.load(f)
except Exception as e:
    print('fail')
    print(f"  [prd-model-coordinator][reviewer] VIOLATION: PRD is not valid JSON after write: {e}", file=sys.stderr)
    sys.exit(0)

before_by_id = {s['id']: s for s in before.get('stories', []) if 'id' in s}
after_by_id = {s['id']: s for s in after.get('stories', []) if 'id' in s}

violations = []

if before_by_id.keys() != after_by_id.keys():
    added = after_by_id.keys() - before_by_id.keys()
    removed = before_by_id.keys() - after_by_id.keys()
    if added:
        violations.append(f"stories added: {sorted(added)}")
    if removed:
        violations.append(f"stories removed: {sorted(removed)}")

if before.get('implementationOrder') != after.get('implementationOrder'):
    violations.append("implementationOrder was modified")

for sid, before_story in before_by_id.items():
    after_story = after_by_id.get(sid)
    if after_story is None:
        continue
    all_keys = set(before_story.keys()) | set(after_story.keys())
    for key in all_keys:
        if key in ALLOWED_FIELDS:
            continue
        if before_story.get(key) != after_story.get(key):
            violations.append(f"{sid}.{key} changed (not an allowed model-assignment field)")

if violations:
    print('fail')
    for v in violations[:20]:
        print(f"  [prd-model-coordinator][reviewer] VIOLATION: {v}", file=sys.stderr)
else:
    print('pass')
MC_REVIEW_PY
)
            rm -f "$_mc_before_file" "$_mc_after_file"
            if [ "$_mc_verdict" = "fail" ]; then
                warning "  [prd-model-coordinator] Attempt ${_mc_attempt}/3 REJECTED by reviewer — reverting PRD"
                echo "$_mc_prd_before" > "$_mc_prd_target" 2>/dev/null || true
                _mc_corrective_note=$(tr '\n' ' ' < "$_mc_verdict_stderr")
                _mc_final_outcome="reverted"
                rm -f "$_mc_verdict_stderr"
                continue
            else
                success "  [prd-model-coordinator] ${_mc_assigned_count} stor(y/ies) assigned model/aiProvider/reasoningEffort (reviewer approved)"
                _mc_final_outcome="pass"
                rm -f "$_mc_verdict_stderr"
                break
            fi
        else
            info "  [prd-model-coordinator] No assignments made (agent found nothing to do or failed)"
            _mc_final_outcome="noop"
            break
        fi
        done

        _mc_violation_types="[]"
        if [ -n "$_mc_corrective_note" ]; then
            _mc_violation_types=$(printf '%s' "$_mc_corrective_note" | python3 -c "
import json, sys
reason = sys.stdin.read()
types = []
if 'not valid JSON' in reason:
    types.append('invalid_json')
if 'stories added' in reason:
    types.append('story_added')
if 'stories removed' in reason:
    types.append('story_removed')
if 'implementationOrder was modified' in reason:
    types.append('implementation_order_modified')
if 'changed (not an allowed model-assignment field)' in reason:
    types.append('field_out_of_scope')
print(json.dumps(types))
" 2>/dev/null || echo "[]")
        fi

        _log_guarded_step_retry "$(jq -n -c \
            --arg step "0.9" \
            --arg phase "$_mc_phase" \
            --argjson attempts "$_mc_attempt" \
            --arg outcome "$_mc_final_outcome" \
            --arg reason "$_mc_corrective_note" \
            --argjson violationTypes "$_mc_violation_types" \
            '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, reason: $reason, violationTypes: $violationTypes}' \
            2>/dev/null)"
    fi

    # Post-condition safety net: any pending story STILL missing a field after
    # the coordinator (agent unavailable, rejected, or skipped a story) falls
    # back to a fixed default so the pipeline never silently relies on a
    # provider's own hardcoded default model.
    ( flock -w 10 200 || { error "  [prd-model-coordinator] Could not acquire lock on $_mc_prd_target"; exit 1; }
    python3 - "$_mc_prd_target" "$_mc_phase" <<'MC_FALLBACK_PY'
import json, sys, os
prd_path, phase = sys.argv[1], sys.argv[2]
with open(prd_path) as f:
    prd = json.load(f)
changed = False
for s in prd.get('stories', []):
    if s.get('status') != 'pending':
        continue
    if s.get('phase', phase) != phase:
        continue
    if not s.get('model'):
        s['model'] = 'MiniMax-M3'
        changed = True
    if not s.get('aiProvider'):
        s['aiProvider'] = 'minimax'
        changed = True
    if not s.get('reasoningEffort'):
        eff = s.get('effort', 'medium')
        s['reasoningEffort'] = eff if eff in ('low', 'high') else 'medium'
        changed = True
if changed:
    _tmp_prd_path = prd_path + '.tmp'
    with open(_tmp_prd_path, 'w') as f:
        json.dump(prd, f, indent=2)
    os.replace(_tmp_prd_path, prd_path)
MC_FALLBACK_PY
    ) 200>"${_mc_prd_target}.lock"
fi
_emit_agent complete "prd-model-coordinator" "PRD model assignments done"
step_emit "7" "pass" "Step 7: PRD model coordinator"
assert_no_story_ids_lost "presplit" "Step 7: PRD model coordinator"
assert_no_story_ids_gained "presplit" "Step 7: PRD model coordinator"
assert_no_illegitimate_deprecation "presplit" "Step 7: PRD model coordinator"

# ──────────────────────────────────────────────
# Step 1: Run main-branch stories (no dependencies, sequential)
# ──────────────────────────────────────────────
# Root cause fix (found live, 2026-07-11, tier3-travel-app run): main_stories
# is a snapshot captured once at phase start (~line 1670), before Step 0.5's
# mid-execution-split validation can run (validate_mid_execution_splits,
# first call ~line 2198). That validation can legitimately RESTORE a parent
# story that was deprecated-via-split at snapshot time (see spec-mode-
# runner.js's coherence-violation parent-restoration) — the restored parent
# is real, pending work, but the stale snapshot never re-included it, so it
# silently never ran even though the PRD said it should. Live symptom:
# SKY-001's 4 split children collided and were deprecated, SKY-001 itself
# was correctly restored to pending in the PRD, but Step 1 only logged
# skipping the 4 dead children and declared "Main-branch stories complete"
# having run nothing — the scaffold phase never wrote a single file.
#
# Extended (same day, second live occurrence): a restored parent can carry
# agentGroup=primary or independent (its original, pre-split group) — the
# first version of this fix only refreshed the main/preflight lane, so
# SKY-002/SKY-003 (agentGroup=primary) fell into a complete gap when
# topology had already collapsed the primary lane into main_stories BEFORE
# the restoration happened (topology="sequential", 11 stories): Step 2
# (worktree creation) had already decided "no parallel stories" from the
# pre-restoration snapshot and never reconsiders, so the restored stories
# sat "pending" forever with literally no code path that would ever execute
# them this phase. Route each newly-eligible story to whichever lane is
# STILL doing work for its own agentGroup (primary_stories/
# independent_stories, if non-empty — Step 2 hasn't run yet at this point in
# the pipeline and will see the update); fall back to main_stories when that
# lane is empty (already collapsed, or never had work) since main_stories is
# the only lane guaranteed to still process further pending work this phase.
_main_stories_current=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select((.completed // false) == false) |
     select(.agentRole != "review-agent") |
     select((.agentGroup // "main") as $g | $g == "main" or $g == "preflight" or $g == "primary" or $g == "independent") |
     [.id, (.agentGroup // "main")] | @tsv' \
    "$PRD_FILE" 2>/dev/null || echo "")
if [ -n "$_main_stories_current" ]; then
    while IFS=$'\t' read -r _rid _rgroup; do
        [ -z "$_rid" ] && continue
        if grep -qxF "$_rid" <<< "$main_stories" \
            || { [ -n "$primary_stories" ] && grep -qxF "$_rid" <<< "$primary_stories"; } \
            || { [ -n "$independent_stories" ] && grep -qxF "$_rid" <<< "$independent_stories"; }; then
            continue
        fi
        _dest="main"
        case "$_rgroup" in
            primary)     [ -n "$primary_stories" ] && _dest="primary" ;;
            independent) [ -n "$independent_stories" ] && _dest="independent" ;;
        esac
        warning "  Story $_rid is newly pending for phase '$PHASE' (likely restored after a rejected split) — adding to the ${_dest} lane"
        case "$_dest" in
            primary)     primary_stories="${primary_stories}
${_rid}" ;;
            independent) independent_stories="${independent_stories}
${_rid}" ;;
            *)           main_stories="${main_stories}
${_rid}" ;;
        esac
    done <<< "$_main_stories_current"
    main_stories=$(topo_sort_stories "$main_stories")
    [ -n "$primary_stories" ] && primary_stories=$(topo_sort_stories "$primary_stories")
    [ -n "$independent_stories" ] && independent_stories=$(topo_sort_stories "$independent_stories")
fi

if [ -n "$main_stories" ]; then
    # Filter out review stories (those run at the end)
    non_review_main=$(echo "$main_stories" | while read s; do
        [ -z "$s" ] && continue
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE")
        if [ "$role" != "review-agent" ]; then
            echo "$s"
        fi
    done)

    # Per-story TypeScript compile gate — story_tsc_gate, now in
    # lib/story-guards.sh (sourced above) so every lane runs the identical
    # gate.

    if [ -n "$non_review_main" ]; then
        _ckpt_total=$(jq '[.stories[] | select(.status != "deprecated")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
        _ckpt_done=$(jq '[.stories[] | select(.status == "completed")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
        if [ "${_ckpt_total:-0}" -gt 0 ] && [ "${_ckpt_done:-0}" -ge "${_ckpt_total:-0}" ]; then
            info "[CHECKPOINT] All $_ckpt_total stories already completed — skipping Step 1 for phase '${PHASE:-main}'"
            step_emit "8" "pass" "Step 8: Main-branch stories (all checkpointed)"
        else
        # ── Gate: the specification review must have cleared these stories ───
        # The reviewer runs with filesystem access and checks each manifest against the
        # repository. Live 2026-08-04 it returned needs_review on all three lanes — two of
        # which had a manifest naming a file that does not exist — and the pipeline went
        # straight to implementation, because the only verdict the code branched on was
        # 'fail' and the schema never emits it. Enforced here, before the writer spends
        # anything. SPEC_REVIEW_ENFORCE=0 overrides deliberately.
        if ! spec_review_gate "$PRD_FILE"; then
            error "[orch] Halting phase '${PHASE}' before implementation — the spec review did not clear."
            exit 1
        fi

        # ── Checkpoint / pause: PRE-WRITER ───────────────────────────────────
        # Everything the writer consumes is settled by now — the spec pass, the CPA
        # pre-pass, the skill assessment and the detective have all run and written
        # their output into the PRD. This is the last point at which those inputs can
        # be inspected before any code is generated. Saved unconditionally: an artefact
        # that exists only in memory is a project violation.
        if _ckpt_path=$(save_run_checkpoint "$PHASE" pre-writer 2>&1); then
            info "[orch] pre-writer checkpoint saved: ${_ckpt_path}"
        else
            warning "[orch] could not save the pre-writer checkpoint: ${_ckpt_path}"
        fi
        if should_pause_before_writer; then
            echo ""
            echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
            echo -e "${GREEN}║  PAUSED — inputs ready, writer NOT started                         ║${NC}"
            echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "  RUN NUMBER:  ${GREEN}${ORCH_RUN_ID}${NC}"
            echo -e "  Phase:       ${PHASE}"
            echo -e "  Stories:     $(printf '%s\n' "$non_review_main" | awk 'NF{n++} END{print n+0}') queued for the writer"
            echo -e "  Artefacts:   ${_ckpt_path:-<not saved>}"
            echo ""
            echo -e "  Resume implementation with:"
            echo -e "    ${GREEN}EPAM_RESUME_RUN=${ORCH_RUN_ID}${NC} <your launcher>"
            echo ""
            step_emit "8" "skip" "Step 8: Main-branch stories" "paused before the writer (EPAM_PAUSE_BEFORE_WRITER)"
            exit 0
        fi

        step_emit "8" "running" "Step 8: Main-branch stories"
    log "Step 8: Running main-branch stories..."
        # Capture baseline SHA before any story commits so the testing-gates
        # git diff oracle can diff the full run's changes (not just HEAD~1).
        if [ -d "$PROJECT_ROOT/.git" ]; then
            git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null > "$LOG_DIR/phase-baseline-sha.txt" || true
        fi
        # _run_one_main_story: single-story execution body shared between the
        # main loop (fixed snapshot) and the tail-sweep pass (split children).
        # All required variables (PRD_FILE, PHASE, LOG_DIR, SCRIPT_DIR,
        # _phase_story_failures, ORCH_RUN_ID) are script-level so the function
        # reads/writes them directly without needing explicit arguments.
        _run_one_main_story() {
            local story="$1"
            # Root cause fix (found live, 2026-07-10, tier3-travel-app run):
            # non_review_main/main_stories is a SNAPSHOT captured once at
            # phase start (~line 1512-1555, before Step 0.5 and before this
            # loop even begins). validate_mid_execution_splits() runs AFTER
            # Step 0.5 and again after every story completes in this same
            # loop (line ~2535 below) — it can reject a same-file coherence
            # violation and mark a story deprecated that was ALREADY enqueued
            # in this stale snapshot before the violation was ever detected.
            # The earlier fix (main_stories query filters .status !=
            # "deprecated") only protects against a story that was ALREADY
            # deprecated before the snapshot was taken; it can't see a
            # deprecation that happens mid-phase, after the snapshot. Live
            # symptom: SKY-002-impl/-impl-1 both wrote client.ts, got
            # rejected and deprecated by the mid-execution split-gate right
            # after Step 0.5 — yet Step 1 still ran "Implementing story:
            # SKY-002-impl" moments later, burning real cost on a story that
            # had already been correctly abandoned. Re-check the CURRENT
            # status live, right before running each story, instead of
            # trusting the stale start-of-phase snapshot.
            local _story_current_status
            _story_current_status=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .status // "pending"' \
                "$PRD_FILE" 2>/dev/null || echo "pending")
            if [ "$_story_current_status" = "deprecated" ]; then
                info "  Skipping $story — deprecated after being enqueued (mid-execution split rejected this story)"
                return 0
            fi
            # "blocked" — set by the inline TC-writer retry gate below when 3
            # attempts still produce no valid testCriteria for this story. A
            # story blocked on an EARLIER iteration (or a prior run) must
            # never be picked up here — same live-status re-check pattern as
            # the deprecated-skip above, since implementation without real
            # grounding is worse than not running at all.
            if [ "$_story_current_status" = "blocked" ]; then
                info "  Skipping $story — blocked (no valid testCriteria after 3 attempts, see blocked-stories.jsonl)"
                return 0
            fi
            if [ "$_story_current_status" = "completed" ]; then
                info "  [CHECKPOINT] Skipping $story — already completed in prd.json"
                return 0
            fi
            if checkpoint_already_done "$story"; then
                info "  Skipping $story — already completed in checkpoint (run: $ORCH_RUN_ID)"
                return 0
            fi
            check_cost_budget
            wait_if_paused
            apply_redirect_if_any "$story"

            # Inline TC writer gate — single shared implementation (see
            # lib/tc-writer-gate.sh docstring for the full history/rationale;
            # this used to be duplicated inline here and was the reason
            # worktree lanes never got the same check). Runs right before a
            # pure-test story that still has zero testCriteria.facts
            # executes, so its paired impl story (which just ran earlier in
            # this same loop) grounds it. Returns 1 (BLOCKING this story,
            # not aborting the phase) if no valid testCriteria after 3
            # attempts.
            if ! run_inline_tc_writer_gate "$story" "$PHASE"; then
                return 0
            fi

            # Brownfield: this story commits to its own dedicated branch, not
            # directly onto the shared baseline branch. See ensure_story_branch
            # above for why (eliminates the stale-marker/reset-to-orphaned-
            # commit failure class entirely, rather than working around it).
            # `|| true` — a failed branch creation (e.g. no network, no origin
            # remote) must never abort the whole phase; the story just
            # proceeds on whatever branch is already checked out.
            ensure_story_branch "${PROJECT_ROOT:-}" "$story" "${JIRA_BASELINE_BRANCH:-}" || true

            log "  Running: $story"
            local _story_monitor_role _story_model_hint _story_provider_hint
            _story_monitor_role=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .agentRole // "typescript-engineer"' \
                "$PRD_FILE" 2>/dev/null || echo "typescript-engineer")
            _story_model_hint=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .model // ""' \
                "$PRD_FILE" 2>/dev/null || echo "")
            _story_provider_hint=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .provider // ""' \
                "$PRD_FILE" 2>/dev/null || echo "")
            # Export model/provider so claude.sh subprocess has them for its own
            # update_monitor_status calls (story_complete, error events, etc.).
            # ORCH_STORY_START_EMITTED suppresses claude.sh's redundant story_start
            # since we already emitted one here with the correct model.
            export STORY_MODEL="$_story_model_hint"
            export STORY_PROVIDER="$_story_provider_hint"
            export ORCH_STORY_START_EMITTED=1
            "$SCRIPT_DIR/update-monitor.sh" story_start "$story" "main" "$_story_monitor_role" "" \
                "$_story_provider_hint" "$_story_model_hint" 2>/dev/null || true
            local _story_exit=0
            run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log" || _story_exit=$?
            export ORCH_STORY_START_EMITTED=0
            # A genuine watchdog double-timeout gets ONE diagnose-then-restructure
            # recovery attempt before counting as a phase failure -- see
            # run_story_recovery_analyst's docstring for why this is scoped to
            # watchdog timeouts only (not every kind of story failure).
            if [ "$_story_exit" -ne 0 ]; then
                if run_story_recovery_analyst "$story" "$LOG_DIR/main-${story}.log"; then
                    _story_exit=0
                fi
            fi
            record_story_actual_cost "$story" "$LOG_DIR/main-${story}.log"
            if [ "$_story_exit" -ne 0 ]; then
                _phase_story_failures=$((_phase_story_failures+1))
                "$SCRIPT_DIR/update-monitor.sh" story_fail "$story" "main" "exit $_story_exit" 2>/dev/null || true
            else
                # Story reported success — verify TypeScript still compiles before moving on
                story_tsc_gate "$story" || _phase_story_failures=$((_phase_story_failures+1))
                "$SCRIPT_DIR/update-monitor.sh" story_complete "$story" "main" "" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
            fi
            checkpoint_complete "$story"
            # Validate any splits the agent registered mid-execution before the next story runs
            validate_mid_execution_splits "$PHASE"
        }
        _phase_story_failures=0
        while IFS= read -r story; do
            [ -z "$story" ] && continue
            _run_one_main_story "$story"
        done <<< "$non_review_main"
        # ── Tail sweep: pick up TC-density split children ─────────────────────
        # When run_inline_tc_writer_gate splits the LAST story in non_review_main
        # (facts exceed EPAM_TC_FACTS_SPLIT_THRESHOLD), the resulting children
        # are written to implementationOrder[$PHASE] in prd.json AFTER the
        # fixed-snapshot iterator is exhausted — they would otherwise be silently
        # dropped and never executed in the same phase pass.
        # Re-read prd.json for any pending stories not present in the original
        # snapshot and run them through the same per-story logic.
        _tail_sweep_candidates=$(jq -r --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories[] |
             select(
               (.id as $id | $ids | index($id) != null) and
               .status != "deprecated" and
               .status != "completed" and
               .status != "blocked"
             ) | .id' \
            "$PRD_FILE" 2>/dev/null || true)
        _tail_sweep_new=""
        while IFS= read -r _ts; do
            [ -z "$_ts" ] && continue
            case $'\n'"$non_review_main"$'\n' in
                *$'\n'"$_ts"$'\n'*) ;; # already in original snapshot
                *) _tail_sweep_new="${_tail_sweep_new}${_ts}"$'\n' ;;
            esac
        done <<< "$_tail_sweep_candidates"
        if [ -n "$_tail_sweep_new" ]; then
            log "  [tail-sweep] Picking up $(printf '%s' "$_tail_sweep_new" | grep -c .) split children: $(printf '%s' "$_tail_sweep_new" | tr '\n' ' ')"
            while IFS= read -r story; do
                [ -z "$story" ] && continue
                _run_one_main_story "$story"
            done <<< "$_tail_sweep_new"
        fi
        if [ "$_phase_story_failures" -gt 0 ]; then
            step_emit "8" "fail" "Step 8: Main-branch stories"
            error "Phase '$PHASE': $_phase_story_failures story/stories failed — aborting phase"
            exit 1
        fi
        step_emit "8" "pass" "Step 8: Main-branch stories"
        success "Main-branch stories complete"
        fi  # end checkpoint else
    fi
else
    step_emit "8" "skip" "Step 8: Main-branch stories" "no stories in lane"
    info "Step 8: No main-branch stories to run"
fi

# ──────────────────────────────────────────────
# Step 1.5: Auto-commit main-branch story output.
# Real agents may commit via git tools, but mock/epam-run agents only write files,
# and `_run_one_main_story` itself never commits (only the worktree-lane loop in
# claude.sh calls commit_completed_story()). Without this, a main-branch story's
# real output — including a brownfield fix's test file — never lands in git.
#
# Live bug (2026-07-22): this fired whenever there were worktree-bound
# stories AND the tree was dirty — with NO check that Step 8 actually ran
# any main-branch stories. A parallel-only run (all stories routed to
# worktrees, zero in the main lane — "no stories in lane" logged) still has
# a dirty tree from incidental pipeline writes (CodeGraph indexing,
# dependency-check manifests), which is NOT genuine story output. That fix
# gated on `$main_stories` also being non-empty, but LEFT the worktree-
# existence check in place as an ADDITIONAL required condition — which
# introduced a second, opposite bug: a phase with ONLY main-branch stories
# and ZERO worktree lanes (e.g. writer-retest.sh's single-story PRD) never
# gets committed AT ALL, no matter how real Step 8's output is. `implement_story`
# marks the story `completed:true` in the PRD regardless, so nothing downstream
# ever notices the missing commit — until the brownfield repro-gate (which
# diffs committed HEAD, never the working tree) permanently blocks with
# "no test file accompanies the change", because nothing was ever committed
# for it to see. Found live 2026-08-02 (AMSD-2041 Writer Retest: 3 codelines,
# all agentGroup=main, zero worktree lanes — every retry re-implemented the
# same fix, never landed it, forever).
#
# Fix: the worktree-existence check was never actually about whether Step 8
# needs a commit — drop it. Gate on `$main_stories` non-empty (Step 8's own
# condition, line ~4062) and a dirty tree; that's the complete, correct
# signal regardless of whether any worktree lane also exists this phase.
# When $main_stories WAS non-empty, the tree is already on the last story's
# ensure_story_branch branch (set inside the Step 8 loop above), so this
# commit correctly lands there too — no additional branch logic needed here.
if [ -n "${main_stories:-}" ] && \
   [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]; then
    step_emit "9" "running" "Step 9: Auto-commit"
    log "Step 9: Auto-committing main-branch deliverables before worktree creation..."
    # Was a bare `git add -A`. lib/git-ops.sh had carried the engine-artefact exclusions
    # since 2026-08-01 — this site never received them, so Step 9 staged
    # orchestrations/agents/KB.md and .epam/* into the client repo (live 20260804T225443Z,
    # where it also tripped SECRET_SCAN and blocked the commit on two lanes).
    git_add_client_outputs "$PROJECT_ROOT" || true
    # Generic credential scan (flow-gap analysis finding #2, 2026-07-12): see
    # orchestrations/scripts/scan-secrets.sh for rationale/patterns.
    if [ -f "$SCRIPT_DIR/scan-secrets.sh" ] && ! _scan_output=$(bash "$SCRIPT_DIR/scan-secrets.sh" "$PROJECT_ROOT" 2>&1); then
        warning "Step 9: $_scan_output"
        step_emit "9" "fail" "Step 9: Auto-commit" "secret detected"
        error "Step 9: Refusing to auto-commit — unstaging (SECRET_SCAN)"
        git -C "$PROJECT_ROOT" reset 2>/dev/null || true
    else
        # Ticket-ID-first message — same commitlint-compatibility fix as
        # commit_completed_story()'s 2026-08-02 fix (lib/git-ops.sh) and
        # brownfield-repro-test-writer.sh's identical issue found the same
        # day. Leads with the first main-branch story's ID (usually the
        # only one) rather than a bare "chore:" prefix, which a client
        # repo's commitlint (e.g. commitlint-plugin-jira-rules) can reject
        # outright for having no ticket ID as the first token.
        _step9_commit_lead="$(printf '%s\n' "$main_stories" | head -1)"
        _step9_commit_msg="${_step9_commit_lead}: auto-commit main-branch output (phase $PHASE)"
        # Real stderr is captured (not discarded) instead of collapsing every
        # failure into "nothing to commit" — a client repo's commit-msg hook
        # rejecting the message for its OWN reason (any reason; this
        # pipeline cannot and should not hardcode a specific hook's rule set
        # per project) previously looked identical to "the tree was already
        # clean", which is actively misleading: files remain staged in the
        # first case but not the second. Distinguish them by checking
        # whether anything is still staged after the failed attempt.
        # set +e/-e: this whole script runs under `set -e` (line 12) — a bare
        # `_step9_commit_output=$(failing_cmd)` assignment would abort the
        # script immediately on a real commit failure, silently
        # reintroducing the exact defect this capture exists to fix (same
        # guard commit_completed_story() uses, lib/git-ops.sh).
        set +e
        _step9_commit_output=$(git -C "$PROJECT_ROOT" commit -m "$_step9_commit_msg" 2>&1)
        _step9_commit_rc=$?
        set -e
        if [ "$_step9_commit_rc" -eq 0 ]; then
            step_emit "9" "pass" "Step 9: Auto-commit"
            success "Step 9: Committed main-branch output"
        elif [ -n "$(git -C "$PROJECT_ROOT" diff --cached --name-only 2>/dev/null)" ]; then
            step_emit "9" "fail" "Step 9: Auto-commit" "commit rejected"
            error "Step 9: Commit failed — work remains staged/uncommitted. Output:"
            error "$_step9_commit_output"
        else
            step_emit "9" "skip" "Step 9: Auto-commit" "nothing to commit"
            warning "Step 9: Nothing new to commit (working tree already clean)"
        fi
    fi
else
    if [ -z "${main_stories:-}" ]; then
        step_emit "9" "skip" "Step 9: Auto-commit" "no main-branch stories ran"
        info "Step 9: No main-branch stories ran this phase — any dirty tree state is pipeline noise, not a deliverable; skipping auto-commit"
    else
        step_emit "9" "skip" "Step 9: Auto-commit" "already clean"
        info "Step 9: No uncommitted main-branch changes — skipping auto-commit"
    fi
fi
# ──────────────────────────────────────────────
# Step 10 (TC writer gate) has moved — see after Step 17 below. Running it
# here (before Step 14's worktree implementation) meant it ALWAYS found zero
# source files for any phase using worktree topology, since main-branch Step 8
# is empty in that case ("no stories in lane") and the real implementation
# only exists after Step 14/15 run and Step 17 merges them back. Confirmed
# live: this hard-aborted the entire core phase before implementation ever ran.
# ──────────────────────────────────────────────
need_worktrees=false
[ -n "$primary_stories" ] && need_worktrees=true
[ -n "$independent_stories" ] && need_worktrees=true

if [ "$need_worktrees" = true ]; then
    step_emit "13" "running" "Step 13: Create worktrees"
    log "Step 13: Creating git worktrees..."
    "$CLAUDE_SH" --setup-worktrees || { error "Failed to create worktrees"; exit 1; }
    step_emit "13" "pass" "Step 13: Create worktrees"
else
    step_emit "13" "skip" "Step 13: Create worktrees" "no parallel stories"
    info "Step 13: No worktree stories — skipping worktree creation"
fi

# ──────────────────────────────────────────────
# Step 3: Launch parallel agents
# ──────────────────────────────────────────────
PRIMARY_PID=""
INDEPENDENT_PID=""

if [ -n "$primary_stories" ]; then
    step_emit "14" "running" "Step 14: Primary agent"
    log "Step 14: Starting primary agent..."
    "$CLAUDE_SH" --worktree primary --phase "$PHASE" \
        > "$LOG_DIR/wt-primary.log" 2>&1 &
    PRIMARY_PID=$!
    info "  Primary agent PID: $PRIMARY_PID"
fi

if [ -n "$independent_stories" ]; then
    step_emit "15" "running" "Step 15: Independent agent"
    log "Step 15: Starting independent agent..."
    "$CLAUDE_SH" --worktree independent --phase "$PHASE" \
        > "$LOG_DIR/wt-independent.log" 2>&1 &
    INDEPENDENT_PID=$!
    info "  Independent agent PID: $INDEPENDENT_PID"
else
    step_emit "15" "skip" "Step 15: Independent agent" "no independent stories"
    info "Step 15: No independent stories — skipping independent agent"
fi

# Wait for both agents
PRIMARY_EXIT=0
INDEPENDENT_EXIT=0

if [ -n "$PRIMARY_PID" ]; then
    log "Waiting for primary agent (PID $PRIMARY_PID)..."
    wait $PRIMARY_PID || PRIMARY_EXIT=$?
    if [ $PRIMARY_EXIT -eq 0 ]; then
        step_emit "14" "pass" "Step 14: Primary agent"
        success "Primary agent completed successfully"
    else
        step_emit "14" "fail" "Step 14: Primary agent"
        error "Primary agent failed with exit code $PRIMARY_EXIT"
        error "Check log: $LOG_DIR/wt-primary.log"
    fi
fi

if [ -n "$INDEPENDENT_PID" ]; then
    log "Waiting for independent agent (PID $INDEPENDENT_PID)..."
    wait $INDEPENDENT_PID || INDEPENDENT_EXIT=$?
    if [ $INDEPENDENT_EXIT -eq 0 ]; then
        step_emit "15" "pass" "Step 15: Independent agent"
        success "Independent agent completed successfully"
    else
        step_emit "15" "fail" "Step 15: Independent agent"
        error "Independent agent failed with exit code $INDEPENDENT_EXIT"
        error "Check log: $LOG_DIR/wt-independent.log"
    fi
fi

# Do NOT exit immediately on a worktree failure. Stories inside a worktree now
# commit their own work as they complete (see commit_completed_story() in
# claude.sh); if a LATER story in the same lane exhausts its retries, the lane's
# exit code is non-zero even though earlier stories genuinely succeeded. Skipping
# Step 3.1/3.2 here used to mean those earlier commits were never merged and were
# then destroyed when the worktree got force-removed. Instead, continue through
# health-check + merge so completed work lands on the main branch, then fail the
# phase afterward (WORKTREE_HAD_FAILURE) so the pipeline still stops correctly.
WORKTREE_HAD_FAILURE=false
if [ "$PRIMARY_EXIT" -ne 0 ] || [ "$INDEPENDENT_EXIT" -ne 0 ]; then
    WORKTREE_HAD_FAILURE=true
    error "One or more worktree agents failed — attempting to commit/merge whatever stories DID complete before failing the phase"
fi

# ──────────────────────────────────────────────
# Step 3.1: Worktree health check + auto-commit
# Ensures agent-produced code is committed before gate assessment.
# Agents sometimes write files without committing (common failure mode).
if [ "$need_worktrees" = true ]; then
    step_emit "16" "running" "Step 16: Worktree health"
    log "Step 16: Worktree health check..."
    GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}" \
        PHASE="$PHASE" AUTO_COMMIT=true "$SCRIPT_DIR/worktree-health-check.sh" \
        2>&1 | tee "$LOG_DIR/worktree-health-${PHASE}.log"
    _health_exit=${PIPESTATUS[0]}
    if [ "$_health_exit" -ne 0 ]; then
        step_emit "16" "warn" "Step 16: Worktree health" "health issues auto-fixed"
        error "Worktree health check failed — see $LOG_DIR/worktree-health-${PHASE}.log"
        exit 1
    else
        step_emit "16" "pass" "Step 16: Worktree health"
    fi
else
    step_emit "16" "skip" "Step 16: Worktree health" "no worktrees"
    info "Step 16: No worktrees — skipping health check"
fi

# ──────────────────────────────────────────────
# Step 3.2: Merge worktree branches back to main branch
# After agents complete and health-check auto-commits, merge their
# work into the main branch so the next phase (which recreates
# worktree branches from HEAD) inherits all prior code.
# ──────────────────────────────────────────────
if [ "$need_worktrees" = true ]; then
    log "Step 17: Merging worktree branches back to main branch..."

    # Resolve the git root and current branch
    _merge_git_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    # If HEAD cannot be read, fall back to the CONFIGURED integration branch — never to a
    # guessed name. `|| echo "master"` meant a repo whose trunk is develop silently merged
    # against a branch that may not exist.
    _merge_current_branch=$(git -C "$_merge_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${JIRA_BASELINE_BRANCH:-}")

    MERGE_FAILED=false

    _active_wt_branches=()
    [ -n "$primary_stories" ] && _active_wt_branches+=(wt-primary)
    [ -n "$independent_stories" ] && _active_wt_branches+=(wt-independent)

    for _wt_branch in "${_active_wt_branches[@]}"; do
        if ! git -C "$_merge_git_root" show-ref --verify --quiet "refs/heads/$_wt_branch"; then
            error "  Required branch $_wt_branch does not exist"
            MERGE_FAILED=true
            continue
        fi

        # Check if the branch has commits ahead of the current branch
        _ahead=$(git -C "$_merge_git_root" rev-list --count "$_merge_current_branch..$_wt_branch" 2>/dev/null || echo "0")
        if [ "${_ahead:-0}" -eq 0 ]; then
            error "  Active branch $_wt_branch has no new commits"
            MERGE_FAILED=true
            continue
        fi

        log "  Merging $_wt_branch ($_ahead commit(s) ahead) into $_merge_current_branch..."
        # Discard any uncommitted working-tree changes on the target branch before merging.
        # These can be left behind when the mock LLM writes wrong-branch files due to story
        # mis-detection, or from prior failed runs. Both tracked-modified and untracked files
        # that would block the merge are cleaned here.
        git -C "$_merge_git_root" checkout -- . 2>/dev/null || true
        # -e .codegraph: never delete the CodeGraph index (see
        # brownfield-preflight-reset.sh for the root cause — the .gitignore that
        # protects codegraph.db is itself removed by git clean's first pass,
        # exposing the db to deletion on any later clean like this one).
        git -C "$_merge_git_root" clean -fd -e .codegraph 2>/dev/null || true

        # Merge-integrity guard (found live via flow-gap analysis, 2026-07-12):
        # the real merge below uses `-X ours`, which silently resolves any
        # GENUINELY CONFLICTING hunk in favor of $_merge_current_branch's
        # content, discarding whatever $_wt_branch changed there — with no
        # error, no warning, and (confirmed empirically) no "CONFLICT" text
        # anywhere in git's own output; it exits 0 and looks identical to a
        # clean merge. Every downstream check (build gate, lint gate, Team
        # Lead Review, SAST) only ever sees the post-merge diff, so content
        # -X ours drops was never part of that diff — none of them can ever
        # catch this. `git merge-tree --write-tree` (git >= 2.38) computes
        # the same merge WITHOUT touching the working tree or creating a
        # commit, and exits non-zero with the conflicting file list when a
        # real conflict would occur — a pure git-history invariant, no
        # stack-specific logic, so refuse to silently auto-resolve instead.
        _mt_output=$(git -C "$_merge_git_root" merge-tree --write-tree --name-only \
            "$_merge_current_branch" "$_wt_branch" 2>&1)
        _mt_exit=$?
        if [ "$_mt_exit" -ne 0 ]; then
            _mt_conflict_files=$(echo "$_mt_output" | tail -n +2 | awk '/^$/{exit} {print}')
            error "  Merge-integrity guard: $_wt_branch conflicts with $_merge_current_branch in: ${_mt_conflict_files:-<unknown file>}"
            error "  Proceeding with '-X ours' would SILENTLY DISCARD $_wt_branch's changes there with no trace — refusing to auto-resolve."
            mkdir -p "${PROJECT_ROOT}/.epam/merge-conflicts"
            jq -n --arg branch "$_wt_branch" --arg target "$_merge_current_branch" \
                --arg files "$_mt_conflict_files" --arg phase "$PHASE" \
                '{phase: $phase, branch: $branch, target: $target, conflictingFiles: ($files | split("\n") | map(select(length > 0))), detectedAt: (now | todate)}' \
                > "${PROJECT_ROOT}/.epam/merge-conflicts/${PHASE}-${_wt_branch}.json" 2>/dev/null
            "$SCRIPT_DIR/update-monitor.sh" event "merge_conflict" \
                "Merge-integrity guard: $_wt_branch conflicts with $_merge_current_branch in ${_mt_conflict_files:-unknown file} — refusing silent -X ours resolution" "" "main" "orchestrator" 2>/dev/null || true
            MERGE_FAILED=true
            continue
        fi

        if git -C "$_merge_git_root" merge --no-ff -X ours "$_wt_branch" \
            -m "merge: phase $PHASE ${_wt_branch#wt-} lane ($_ahead commits)" 2>&1; then
            success "  Merged $_wt_branch into $_merge_current_branch"
            "$SCRIPT_DIR/update-monitor.sh" event "merge_back" \
                "Merged $_wt_branch into $_merge_current_branch ($_ahead commits)" "" "main" "orchestrator" 2>/dev/null || true
        else
            error "  Failed to merge $_wt_branch into $_merge_current_branch"
            error "  This may require manual conflict resolution"
            "$SCRIPT_DIR/update-monitor.sh" event "merge_conflict" \
                "CONFLICT merging $_wt_branch — manual resolution needed" "" "main" "orchestrator" 2>/dev/null || true
            MERGE_FAILED=true
            # Abort the failed merge so the repo is not left in a dirty state
            git -C "$_merge_git_root" merge --abort 2>/dev/null || true
        fi
    done

    if [ "$MERGE_FAILED" = true ]; then
        error "Step 17: One or more worktree merges failed — review conflicts before next phase"
        error "  Worktrees preserved for inspection. Re-run with --skip-cleanup to debug."
        exit 1
    else
        success "Step 17: All worktree branches merged back successfully"
    fi
else
    info "Step 17: No worktrees — skipping merge-back"
fi

# Now that any completed stories' commits have had a chance to merge, fail the
# phase if a worktree agent reported a failed story earlier.
if [ "$WORKTREE_HAD_FAILURE" = true ]; then
    error "One or more stories failed in a worktree agent — phase '$PHASE' did not fully succeed"
    error "  (completed stories in the same lane, if any, were committed and merged above)"
    exit 1
fi

# ──────────────────────────────────────────────
# Step 10: Post-impl TC (test criteria) writer gate.
# Runs HERE (after worktree merge-back, not before Step 3) so it always has
# real implementation to read regardless of topology — main-branch stories
# (Step 1) and worktree stories (Step 3a/3b, merged in Step 3.2) are both
# guaranteed to exist on the current branch by this point.
# Fires when impl stories have run and test stories in this phase need TCs.
# Reads actual .ts source files and writes testCriteria to prd.json.
# ACs are never modified — TCs are additive only.
# Skip with: SKIP_TC_WRITER=1
# ──────────────────────────────────────────────
# Unlike the INLINE gate above (Step 1 loop, pre-execution — see its own
# comment for why combo stories must be excluded there), this gate runs
# AFTER every Step 1 story has already completed: by now a combo story's own
# impl+test files genuinely exist on disk, so "any file is a test file" is
# the correct, safe classification here — this is deliberately NOT scoped to
# "all files" like the inline gate, since combo stories legitimately benefit
# from real TC generation once they're done (this is the original,
# unmodified behavior this gate always had).
if is_truthy "${SKIP_TC_WRITER:-}"; then
    step_emit "10" "skip" "Step 10: TC writer gate" "SKIP_TC_WRITER=1"
    info "Step 10: TC writer gate skipped (SKIP_TC_WRITER=1)"
    _tc_writer_needed=0
else
_tc_writer_needed=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) |
      select(
        (.technicalNotes.files // [] | map(endswith(".test.ts")) | any) and
        ((.testCriteria.facts // []) | length == 0)
      )] | length' "$PRD_FILE" 2>/dev/null || echo 0)
fi

# TC WRITER IS A GREENFIELD MECHANISM (decision, 2026-07-26).
#
# Brownfield proves a change differently and better: verification criteria
# describe the observable outcome, the repro-test-writer builds a test from them
# plus the real fix diff, and the bug-reproduction gate then EXECUTES that test
# against the pre-fix and post-fix code. A test criterion is a written
# intention; RED→GREEN is a demonstration.
#
# Adding TCs on top would restate the VCs one model call further from the
# source, and give the writer a second, overlapping requirement list to drift
# from. Greenfield has no bug to reproduce and no baseline to run against, so
# there TCs remain the mechanism that says what "done" means.
# NOVEL BROWNFIELD WORK STILL NEEDS TEST CRITERIA.
#
# The reasoning above holds for a DEFECT: the bug-reproduction gate executes a failing test
# against pre-fix and post-fix code, which beats a written intention. It does not hold for a
# novel story — phase_stories_for_repro_gate excludes storyKind "novel" because there is no
# prior bug to reproduce, so skipping the TC writer for ALL brownfield left novel work with
# NO test mechanism at all.
#
# Live 2026-08-07, AMSD-2041 (novel): Step 10 skipped, Step 3.55 "passed" with nothing to
# check, and no step owned tests. The reviewer requested them on seven cycles across two runs,
# the writer never wrote any, the reviewer never approved, and the phase halted every time.
_tc_novel_stories="$(phase_stories_for_tc_writer "$PRD_FILE" "$PHASE" 2>/dev/null || true)"
_tc_novel_count=$(printf '%s\n' "$_tc_novel_stories" | awk 'NF{n++} END{print n+0}')
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_tc_novel_count" -eq 0 ]; then
    step_emit "10" "skip" "Step 10: TC writer gate" "brownfield defects — bug-reproduction gate proves them instead"
    info "Step 10: TC writer gate skipped — every phase story is a defect, proven by the bug-reproduction gate rather than by test criteria"
elif [ "${_tc_writer_needed:-0}" -gt 0 ]; then
    step_emit "10" "running" "Step 10: TC writer gate"
    log "Step 10: TC writer gate — ${_tc_writer_needed} test story/stories need testCriteria..."
    # Retry-on-violation (2026-07-13), same shape as the inline gate above:
    # give the batch call up to 3 attempts, then BLOCK only the specific
    # story IDs still lacking real testCriteria (not exit 1 the whole phase
    # — a script crash bad enough to make $PRD_FILE itself unreadable is the
    # only case that still stays a hard failure).
    for _tc_batch_attempt in 1 2 3; do
        # `if CMD | tee file; then` checks tee's exit code, not CMD's — tee
        # almost always exits 0, so this previously reported PASS even when
        # the TC writer agent itself failed. Use PIPESTATUS[0] instead.
        bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
            --prd "$PRD_FILE" \
            --phase "$PHASE" \
            --output-dir "${OUTPUT_DIR:-$PROJECT_ROOT}" \
            2>&1 | tee "$LOG_DIR/tc-writer-${PHASE}.log"
        _tc_writer_exit=${PIPESTATUS[0]}

        if ! jq empty "$PRD_FILE" 2>/dev/null; then
            step_emit "10" "fail" "Step 10: TC writer gate"
            error "Step 10: TC writer gate FAILED — $PRD_FILE is not valid JSON after the writer ran (attempt ${_tc_batch_attempt}/3)"
            error "  Fix: check $LOG_DIR/tc-writer-${PHASE}.log"
            exit 1
        fi

        _tc_batch_still_missing=$(jq -r --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             [.stories[] | select(.id as $id | $ids | index($id)) |
              select(
                (.technicalNotes.files // [] | map(endswith(".test.ts")) | any) and
                ((.testCriteria.facts // []) | length == 0)
              ) | .id] | join(",")' "$PRD_FILE" 2>/dev/null || echo "")

        if [ -z "$_tc_batch_still_missing" ]; then
            step_emit "10" "pass" "Step 10: TC writer gate"
            success "Step 10: TC writer gate PASSED — testCriteria populated (attempt ${_tc_batch_attempt}/3)"
            break
        fi
        warning "  Step 10 attempt ${_tc_batch_attempt}/3: still missing testCriteria for: $_tc_batch_still_missing"
    done

    _tc_batch_violation_types="[]"
    if [ -n "$_tc_batch_still_missing" ]; then
        if [ "${_tc_writer_exit:-0}" -ne 0 ]; then
            _tc_batch_violation_types='["writer_exit_nonzero","empty_facts"]'
        else
            _tc_batch_violation_types='["empty_facts"]'
        fi
    fi

    _log_guarded_step_retry "$(jq -n -c \
        --arg step "tc-writer-batch" \
        --arg phase "$PHASE" \
        --argjson attempts "$_tc_batch_attempt" \
        --arg outcome "$([ -z "$_tc_batch_still_missing" ] && echo pass || echo blocked)" \
        --argjson violationTypes "$_tc_batch_violation_types" \
        '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, violationTypes: $violationTypes}' \
        2>/dev/null)"

    if [ -n "$_tc_batch_still_missing" ]; then
        step_emit "10" "warn" "Step 10: TC writer gate" "blocked stories, see blocked-stories.jsonl"
        warning "Step 10: TC writer gate — blocking $_tc_batch_still_missing after 3 attempts (not aborting the phase)"
        IFS=',' read -ra _tc_blocked_ids <<< "$_tc_batch_still_missing"
        for _tc_blocked_id in "${_tc_blocked_ids[@]}"; do
            jq --arg id "$_tc_blocked_id" '(.stories[] | select(.id == $id)).status = "blocked"' \
                "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
            jq -n -c --arg storyId "$_tc_blocked_id" --arg reason "no valid testCriteria after 3 attempts (batch gate)" \
                '{timestamp: (now | todate), storyId: $storyId, reason: $reason}' \
                >> "$LOG_DIR/blocked-stories.jsonl" 2>/dev/null || true
        done
    fi
else
    step_emit "10" "skip" "Step 10: TC writer gate" "all TCs present"
    info "Step 10: TC writer gate — all test stories already have TCs or no test stories in phase"
fi

# ──────────────────────────────────────────────
# Step 11: Skills coordinator audit
#
# Root cause this addresses (found live, 2026-07-10, tier3-travel-app run): a
# self-heal skill note ("Do not use 'as' keyword for type assertions... use
# 'value as Type'...") was persisted TWICE, verbatim, into typescript-
# engineer's profile during a single story's retry loop — the note is also
# internally self-contradictory (it recommends the exact syntax it says not
# to use). Nothing in the pipeline ever looks at the ACCUMULATED set of
# skill notes as a whole; FailureAnalyst only ever appends. This step audits
# profiles.json once per phase, after Step 1's healing activity has had a
# chance to add new notes:
#   1. Deterministic pass (run_skills_audit_scan.py): collapses exact-
#      duplicate [Self-Heal] paragraphs within each role's profile, and
#      flags (via a narrow regex heuristic) any note that says "do not use
#      'X'" while also recommending "use ... 'X'" elsewhere in the same
#      note — exactly the shape of bug that motivated this step.
#   2. Only if step 1 flags a suspected contradiction: invoke the
#      skills-coordinator agent (Bash+WriteFile tool access, same pattern as
#      run_pre_phase_assessment) to rewrite JUST that flagged note into
#      something internally coherent. The LLM is only ever invoked when the
#      deterministic scan found something to fix — most phases will run the
#      free, instant scan and skip the LLM call entirely.
# Bypass: SKIP_SKILLS_AUDIT=1
run_skills_audit_scan() {
    local profiles_file="$1"
    # Locked for the whole scan+conditional-write: fast, in-memory text
    # processing only (no LLM call inside), so holding the lock this long
    # never risks stalling a parallel worktree story on model latency.
    ( flock -w 10 200 || { error "  [SkillsAudit] Could not acquire lock on $profiles_file"; return 1; }
    python3 - "$profiles_file" << 'PYEOF'
import json, re, sys, os

path = sys.argv[1]
with open(path) as f:
    profiles = json.load(f)

duplicates_removed = 0
contradictions = []

for role, text in profiles.items():
    if not isinstance(text, str) or '[Self-Heal]' not in text:
        continue
    paragraphs = text.split('\n\n')
    seen = set()
    deduped = []
    for para in paragraphs:
        key = para.strip()
        if key.startswith('[Self-Heal]'):
            if key in seen:
                duplicates_removed += 1
                continue
            seen.add(key)
        deduped.append(para)
    new_text = '\n\n'.join(deduped)
    if new_text != text:
        profiles[role] = new_text
        text = new_text

    for para in text.split('\n\n'):
        if not para.strip().startswith('[Self-Heal]'):
            continue
        m = re.search(r"(?:do not|never|avoid)\s+use\s+'([^']+)'", para, re.IGNORECASE)
        if not m:
            continue
        token = re.escape(m.group(1))
        # Does the note ALSO recommend using the same token elsewhere (past
        # the "do not use" clause itself)? The token may reappear as its own
        # quoted string ('as') or embedded as a whole word inside a longer
        # quoted phrase ('value as Type') -- both are the same contradiction.
        rest = para[m.end():]
        if re.search(r"\buse\b[^.]*'[^']*\b" + token + r"\b[^']*'", rest, re.IGNORECASE):
            contradictions.append({'role': role, 'note': para.strip()})

if duplicates_removed > 0:
    _tmp_path = path + '.tmp'
    with open(_tmp_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    os.replace(_tmp_path, path)

print(json.dumps({'duplicates_removed': duplicates_removed, 'contradictions': contradictions}))
PYEOF
    ) 200>"${profiles_file}.lock"
}

if is_truthy "${SKIP_SKILLS_AUDIT:-}"; then
    step_emit "11" "skip" "Step 11: Skills coordinator audit" "SKIP_SKILLS_AUDIT=1"
else
    step_emit "11" "running" "Step 11: Skills coordinator audit"
    _skills_audit_result=$(run_skills_audit_scan "$AGENT_PROFILES_FILE" 2>/dev/null || echo '{"duplicates_removed":0,"contradictions":[]}')
    _skills_dupes_removed=$(echo "$_skills_audit_result" | jq -r '.duplicates_removed // 0' 2>/dev/null || echo 0)
    _skills_contradiction_count=$(echo "$_skills_audit_result" | jq -r '.contradictions | length' 2>/dev/null || echo 0)

    if [ "${_skills_dupes_removed:-0}" -gt 0 ]; then
        success "  [SkillsAudit] Removed ${_skills_dupes_removed} duplicate skill note(s) from profiles.json"
    fi

    if [ "${_skills_contradiction_count:-0}" -gt 0 ]; then
        warning "  [SkillsAudit] ${_skills_contradiction_count} suspected self-contradictory skill note(s) found — invoking skills-coordinator to rewrite"
        _skills_before=$(cat "$AGENT_PROFILES_FILE" 2>/dev/null || echo "{}")
        while IFS= read -r _sc_row; do
            [ -z "$_sc_row" ] && continue
            _sc_role=$(echo "$_sc_row" | jq -r '.role')
            _sc_note=$(echo "$_sc_row" | jq -r '.note')
            _sc_prompt="You are the skills-coordinator agent. A persisted self-heal skill note in profiles.json for the '${_sc_role}' role is suspected to be internally self-contradictory (it says not to use something, then recommends using that same thing). Read ${AGENT_PROFILES_FILE}, find the EXACT paragraph below inside the '${_sc_role}' profile string, and rewrite ONLY that paragraph so it states one clear, non-contradictory rule — keep the '[Self-Heal]' prefix and stay under 200 characters. Do not touch any other part of the profile.

Flagged note:
${_sc_note}"
            _sc_attempt=0
            while [ "$_sc_attempt" -lt 2 ]; do
                _sc_run_prompt="$_sc_prompt"
                [ "$_sc_attempt" -ge 1 ] && _sc_run_prompt="RETRY (attempt 2): Previous attempt did not update profiles.json. Read ${AGENT_PROFILES_FILE}, find the exact flagged note, and rewrite it now.

$_sc_prompt"
                # No story_id — phase-level audit, not tied to a single story.
                if run_orch_prompt_with_tools "$_sc_run_prompt" "skills_audit" > "$LOG_DIR/skills-coordinator-${PHASE}.log" 2>&1; then
                    if jq empty "$AGENT_PROFILES_FILE" 2>/dev/null; then
                        success "  [SkillsAudit] Rewrote contradictory note for [${_sc_role}]"
                        break
                    else
                        error "  [SkillsAudit] skills-coordinator corrupted profiles.json! Restoring pre-audit snapshot."
                        echo "$_skills_before" > "$AGENT_PROFILES_FILE"
                        break
                    fi
                fi
                _sc_attempt=$(( _sc_attempt + 1 ))
                [ "$_sc_attempt" -lt 2 ] && warning "  [SkillsAudit] skills-coordinator attempt 1 failed — retrying with corrective note" || warning "  [SkillsAudit] skills-coordinator failed to rewrite note for [${_sc_role}] — leaving as-is"
            done
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg role "$_sc_role" --arg note "$_sc_note" \
                '{timestamp:$ts, phase:$phase, role:$role, event:"contradiction_rewrite", flagged_note:$note}' \
                >> "$LOG_DIR/skills-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_skills_audit_result" | jq -c '.contradictions[]' 2>/dev/null)
    fi
    step_emit "11" "pass" "Step 11: Skills coordinator audit"
fi

# ──────────────────────────────────────────────
# Step 12: Tools coordinator audit
#
# Same rationale and shape as Step 11, applied to the dynamic-tools
# mechanism instead of skill notes: FailureAnalyst can write a tool script to
# .epam/dynamic-tools/<name>.sh (target=tool), and run_dynamic_tools_in_
# unlocked_window() (claude.sh) runs every reviewed, syntax-valid tool on
# every retry unconditionally — but nothing ever checks whether a tool
# actually WORKS, or whether two tools solve the same problem. Observed live
# this session: "[dynamic-tools] mock-fetch-in-test.sh exited non-zero
# (continuing)" — a tool got created, was broken, and the pipeline just
# logged a warning and moved on, paying its cost on every subsequent retry
# with no mechanism to ever fix or remove it.
#   1. Deterministic scan (run_tools_audit_scan): for each reviewed tool,
#      (a) a free bash -n syntax check, (b) counts "<tool>.sh exited
#      non-zero" occurrences across this phase's main-*.log files (a REAL
#      observed-failure signal, not a synthetic re-execution — tools aren't
#      re-run here to avoid side effects outside their sanctioned window),
#      (c) flags near-duplicate tools via purpose-comment similarity.
#   2. Only when something is flagged, invoke the tools-coordinator LLM
#      (Bash+WriteFile access) to fix the broken tool or consolidate a
#      duplicate pair.
# Bypass: SKIP_TOOLS_AUDIT=1
run_tools_audit_scan() {
    local tools_dir="$1"
    local log_dir="$2"
    python3 - "$tools_dir" "$log_dir" << 'PYEOF'
import glob, json, os, re, sys

tools_dir, log_dir = sys.argv[1], sys.argv[2]
result = {"broken": [], "duplicates": []}

if not os.path.isdir(tools_dir):
    print(json.dumps(result))
    sys.exit(0)

tool_files = sorted(glob.glob(os.path.join(tools_dir, "*.sh")))
reviewed = [t for t in tool_files if os.path.exists(t + ".reviewed")]

# Combined text of this phase's per-story logs, for the failure-count check.
log_text = ""
for log_file in glob.glob(os.path.join(log_dir, "main-*.log")):
    try:
        with open(log_file, errors="ignore") as f:
            log_text += f.read()
    except Exception:
        pass

purposes = {}
for tool_path in reviewed:
    name = os.path.basename(tool_path)[:-3]
    with open(tool_path) as f:
        content = f.read()

    syntax_rc = os.system(f"bash -n {tool_path!r} >/dev/null 2>&1")
    if syntax_rc != 0:
        result["broken"].append({"tool": name, "reason": "syntax"})
        continue

    fail_count = len(re.findall(re.escape(name) + r"\.sh exited non-zero", log_text))
    if fail_count >= 2:
        result["broken"].append({"tool": name, "reason": f"runtime ({fail_count} non-zero exits this phase)"})

    # Purpose is the second line: "# <purpose>" (first line is the shebang).
    lines = content.split("\n")
    purpose = lines[1][2:].strip() if len(lines) > 1 and lines[1].startswith("#") else ""
    purposes[name] = purpose

names = list(purposes.keys())
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = names[i], names[j]
        pa, pb = purposes[a].lower().split(), purposes[b].lower().split()
        if not pa or not pb:
            continue
        overlap = len(set(pa) & set(pb)) / max(len(set(pa) | set(pb)), 1)
        if overlap >= 0.6:
            result["duplicates"].append({"tool_a": a, "tool_b": b})

print(json.dumps(result))
PYEOF
}

if is_truthy "${SKIP_TOOLS_AUDIT:-}"; then
    step_emit "12" "skip" "Step 12: Tools coordinator audit" "SKIP_TOOLS_AUDIT=1"
else
    step_emit "12" "running" "Step 12: Tools coordinator audit"
    _tools_audit_result=$(run_tools_audit_scan "$PROJECT_ROOT/.epam/dynamic-tools" "$LOG_DIR" 2>/dev/null || echo '{"broken":[],"duplicates":[]}')
    _tools_broken_count=$(echo "$_tools_audit_result" | jq -r '.broken | length' 2>/dev/null || echo 0)
    _tools_dup_count=$(echo "$_tools_audit_result" | jq -r '.duplicates | length' 2>/dev/null || echo 0)

    if [ "${_tools_broken_count:-0}" -gt 0 ] || [ "${_tools_dup_count:-0}" -gt 0 ]; then
        warning "  [ToolsAudit] ${_tools_broken_count} broken tool(s), ${_tools_dup_count} duplicate pair(s) found — invoking tools-coordinator"
        while IFS= read -r _tc_row; do
            [ -z "$_tc_row" ] && continue
            _tc_tool=$(echo "$_tc_row" | jq -r '.tool')
            _tc_reason=$(echo "$_tc_row" | jq -r '.reason')
            _tc_path="$PROJECT_ROOT/.epam/dynamic-tools/${_tc_tool}.sh"
            _tc_before=$(cat "$_tc_path" 2>/dev/null || echo "")
            _tc_prompt="You are the tools-coordinator agent. A dynamic tool at ${_tc_path} is broken (${_tc_reason}). Read the file, fix it so it runs successfully and stays idempotent (safe to run multiple times), and write the corrected script back to the SAME path. Keep the '#!/usr/bin/env bash' shebang and the purpose comment on line 2. Do not touch any other file."
            _tc_attempt=0
            while [ "$_tc_attempt" -lt 2 ]; do
                _tc_run_prompt="$_tc_prompt"
                if [ "$_tc_attempt" -ge 1 ]; then
                    _tc_bn_err=""
                    _tc_bn_err=$(bash -n "$_tc_path" 2>&1 || true)
                    _tc_run_prompt="RETRY (attempt 2): Previous fix left ${_tc_tool}.sh syntactically broken. bash -n reports: ${_tc_bn_err}. Fix the syntax error and write the corrected script back now.

$_tc_prompt"
                fi
                # No story_id — phase-level audit, not tied to a single story.
                if run_orch_prompt_with_tools "$_tc_run_prompt" "tools_audit" > "$LOG_DIR/tools-coordinator-${PHASE}.log" 2>&1; then
                    if bash -n "$_tc_path" 2>/dev/null; then
                        success "  [ToolsAudit] Rewrote broken tool [${_tc_tool}]"
                        break
                    else
                        if [ "$_tc_attempt" -ge 1 ]; then
                            error "  [ToolsAudit] tools-coordinator left ${_tc_tool}.sh syntactically broken after 2 attempt(s)! Restoring pre-audit snapshot."
                            echo "$_tc_before" > "$_tc_path"
                            break
                        fi
                        warning "  [ToolsAudit] tools-coordinator left ${_tc_tool}.sh broken on attempt 1 — retrying with corrective note"
                    fi
                else
                    [ "$_tc_attempt" -ge 1 ] && warning "  [ToolsAudit] tools-coordinator failed to fix [${_tc_tool}] — leaving as-is"
                fi
                _tc_attempt=$(( _tc_attempt + 1 ))
            done
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg tool "$_tc_tool" --arg reason "$_tc_reason" \
                '{timestamp:$ts, phase:$phase, tool:$tool, reason:$reason, event:"broken_tool_rewrite"}' \
                >> "$LOG_DIR/tools-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_tools_audit_result" | jq -c '.broken[]' 2>/dev/null)

        while IFS= read -r _tc_dup_row; do
            [ -z "$_tc_dup_row" ] && continue
            _tc_a=$(echo "$_tc_dup_row" | jq -r '.tool_a')
            _tc_b=$(echo "$_tc_dup_row" | jq -r '.tool_b')
            warning "  [ToolsAudit] Duplicate tools detected: ${_tc_a}.sh and ${_tc_b}.sh solve overlapping problems — flagged for manual review (not auto-merged)"
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg a "$_tc_a" --arg b "$_tc_b" \
                '{timestamp:$ts, phase:$phase, tool_a:$a, tool_b:$b, event:"duplicate_flagged"}' \
                >> "$LOG_DIR/tools-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_tools_audit_result" | jq -c '.duplicates[]' 2>/dev/null)
    fi
    step_emit "12" "pass" "Step 12: Tools coordinator audit"
fi

# ──────────────────────────────────────────────
# Sync story data to monitor from cost log
"$SCRIPT_DIR/sync-monitor-stories.sh" 2>/dev/null || true

# _build_skill_domain_guidance <project_root>
# Generic, project-supplied mapping of tech-stack keywords to agentRole
# names for the phase-assessment agent's skill-domain-mismatch correction
# step (see run_phase_assessment's prompt). Never hardcoded in this engine
# -- a project may not use TypeScript/React/Docker/Vitest at all (found
# 2026-07-12 while fixing the Step 6 real-output-gate bug in the same
# function: the prompt hardcoded exactly that mapping directly in the
# engine). Reads .epam/skill-domain-map.json's "skillDomains" array:
# [{"role":"...", "keywords":["...", ...]}, ...] -- same opt-in convention
# as dependency-check.json's vendorDirs: no config file or no
# "skillDomains" key means no guidance; callers must supply their own
# generic fallback instruction.
_build_skill_domain_guidance() {
    local project_root="$1"
    local config_file="${project_root}/.epam/skill-domain-map.json"
    [ -f "$config_file" ] || return 0
    jq -r '
        (.skillDomains // [])
        | map("\"" + (.keywords | join("\" / \"")) + "\" → " + .role)
        | join(",\n     ")
    ' "$config_file" 2>/dev/null
}

# Step 18: Post-Parallel Skill Assessment
# (Runs immediately after parallel execution; captures mid-pipeline variance.
#  Step 6 at end of pipeline performs the final post-phase assessment.)
# ──────────────────────────────────────────────
run_phase_assessment() {
    local phase_id=$1
    local cost_file="$LOG_DIR/phase-cost.jsonl"
    local assessment_file="$LOG_DIR/phase-skill-assessments.jsonl"
    local improvement_dir="$LOG_DIR/phase-improvements"

    mkdir -p "$improvement_dir"

    # Check if phase-cost.jsonl has records for this phase
    if [ ! -s "$cost_file" ]; then
        warning "No cost records found in $cost_file — skipping assessment"
        return 0
    fi

    # grep -c already prints "0" on zero matches while also exiting 1 — `|| echo 0`
    # would double-print ("0\n0"), breaking the numeric -eq test below.
    local phase_records
    phase_records=$({ grep -c "\"phase_id\":\"$phase_id\"" "$cost_file" 2>/dev/null || true; })
    if [ "${phase_records:-0}" -eq 0 ]; then
        warning "No cost records for phase '$phase_id' — skipping assessment"
        return 0
    fi

    info "Found $phase_records cost records for phase '$phase_id'"

    local improvement_report_file="${improvement_dir}/${phase_id}.md"
    # Generic, project-supplied skill-domain guidance (see
    # _build_skill_domain_guidance's own docstring) -- falls back to a
    # conservative, non-stack-specific instruction when no
    # .epam/skill-domain-map.json is configured, rather than ever guessing
    # or hardcoding a keyword list here.
    local _skill_domain_guidance
    _skill_domain_guidance=$(_build_skill_domain_guidance "$PROJECT_ROOT")
    [ -z "$_skill_domain_guidance" ] && _skill_domain_guidance="not configured for this project (.epam/skill-domain-map.json) — use conservative judgment; only reassign a role when the mismatch between the task description and assigned agentRole is unambiguous"

    # Full agent audit, 2026-07-31 (mock1 investigation): this step used to
    # hand the agent two raw files (cost log + PRD) and ask it to read,
    # dedupe-by-latest-timestamp, cross-reference, sum, and write THREE
    # outputs (JSONL append, markdown report, conditional PRD mutation) —
    # all with only bash/read_file/list_files/search (no write_file) and a
    # 6-tool-call/300s budget. That's exactly the "unstructured, multi-file,
    # agent-does-its-own-data-gathering" pattern already fixed for every QA
    # gate this session (sast-sentinel, review-ranger, mutant-hunter,
    # perf-sentinel all get pre-computed evidence injected, never explore
    # for it themselves) — and it's what caused the mock1 timeout (attempt 1
    # exhausted 300s, attempt 2 succeeded only on an escalated model).
    #
    # Fixed the same way: the dedupe/cross-reference/arithmetic is 100%
    # deterministic (no judgment involved) and now happens here in
    # bash/python. The LLM's job is narrowed to genuine judgment only —
    # writing human-readable notes/recommendations and deciding skill-domain
    # role reassignments — and needs NO tools at all, since everything it
    # needs is injected and the orchestrator (not the agent) performs every
    # write, atomically and lock-guarded, exactly like story-ac-remediator's
    # deterministic-apply pattern.
    local _pa_summary_file
    _pa_summary_file=$(mktemp)
    python3 - "$cost_file" "$PRD_FILE" "$phase_id" "$_pa_summary_file" << 'ASSESS_PRECOMPUTE_PY'
import json, os, sys
from datetime import datetime

cost_file, prd_file, phase_id, out_file = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None

# Dedupe: for each story_id, keep only the record with the highest started_at
# (the log accumulates records across multiple runs of the same phase).
latest = {}
with open(cost_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get('phase_id') != phase_id:
            continue
        sid = rec.get('story_id')
        if not sid:
            continue
        prev = latest.get(sid)
        if prev is None or (rec.get('started_at') or '') > (prev.get('started_at') or ''):
            latest[sid] = rec

with open(prd_file) as f:
    prd = json.load(f)

stories_by_id = {s['id']: s for s in prd.get('stories', []) if s.get('id')}

# implementationOrder is the authoritative phase->story-ids mapping (a
# story's own optional .phase field is not reliably populated) — build a
# reverse lookup and use ordering position to find phases AFTER this one,
# for the corrective-action scope.
impl_order = prd.get('implementationOrder', {}) or {}
phase_names = list(impl_order.keys())
story_to_phase = {}
for pname, ids in impl_order.items():
    for sid in (ids or []):
        story_to_phase[sid] = pname
try:
    future_phases = set(phase_names[phase_names.index(phase_id) + 1:])
except ValueError:
    future_phases = set()

# Only records whose story_id matches a REAL PRD story are per-story
# variance data — other story_ids (e.g. "core", "pipeline") are gate/
# pipeline-level cost records, not story work, and are excluded here.
per_story = []
actual_minutes_total = 0.0
forecast_minutes_total = 0.0
actual_cost_total = 0.0
forecast_cost_total = 0.0

for sid, rec in latest.items():
    story = stories_by_id.get(sid)
    if not story:
        continue
    completed = bool(story.get('completed'))
    status = 'succeeded' if completed else rec.get('status', 'unknown')
    started = parse_ts(rec.get('started_at'))
    ended = parse_ts(rec.get('ended_at'))
    elapsed_minutes = 0.0
    if started and ended:
        elapsed_minutes = max(0.0, (ended - started).total_seconds() / 60.0)
    forecast_minutes = story.get('estimatedAiMinutes')
    if forecast_minutes is None:
        forecast_minutes = (story.get('estimatedHours') or 0) * 60
    forecast_cost = story.get('estimatedCost') or 0
    actual_cost = rec.get('task_cost_usd') or 0

    actual_minutes_total += elapsed_minutes
    forecast_minutes_total += forecast_minutes
    actual_cost_total += actual_cost
    forecast_cost_total += forecast_cost

    per_story.append({
        'story_id': sid,
        'status': status,
        'elapsed_minutes': round(elapsed_minutes, 3),
        'forecast_minutes': round(forecast_minutes, 3),
        'actual_cost_usd': round(actual_cost, 4),
        'forecast_cost_usd': round(forecast_cost, 4),
        'description': story.get('description', ''),
        'agentRole': story.get('agentRole', ''),
    })

variance_minutes = actual_minutes_total - forecast_minutes_total
variance_cost_usd = actual_cost_total - forecast_cost_total
threshold_pct = float(os.environ.get('PHASE_ASSESSMENT_OVER_THRESHOLD_PCT', '20'))
over_threshold = (
    forecast_minutes_total > 0
    and actual_minutes_total > forecast_minutes_total * (1 + threshold_pct / 100.0)
)

future_pending_stories = []
for s in prd.get('stories', []):
    sid = s.get('id')
    if story_to_phase.get(sid) in future_phases and s.get('status') == 'pending' and not s.get('completed'):
        future_pending_stories.append({
            'story_id': sid,
            'description': s.get('description', ''),
            'agentRole': s.get('agentRole', ''),
            'phase': story_to_phase.get(sid),
        })

summary = {
    'phase_id': phase_id,
    'actual_minutes': round(actual_minutes_total, 3),
    'forecast_minutes': round(forecast_minutes_total, 3),
    'actual_cost_usd': round(actual_cost_total, 4),
    'forecast_cost_usd': round(forecast_cost_total, 4),
    'variance_minutes': round(variance_minutes, 3),
    'variance_cost_usd': round(variance_cost_usd, 4),
    'over_threshold': over_threshold,
    'over_threshold_pct': threshold_pct,
    'per_story': per_story,
    'future_pending_stories': future_pending_stories,
    }

with open(out_file, 'w') as f:
    json.dump(summary, f, indent=2)
ASSESS_PRECOMPUTE_PY

    local _pa_summary
    _pa_summary=$(cat "$_pa_summary_file" 2>/dev/null || echo '{}')
    rm -f "$_pa_summary_file"

    local assessment_prompt
    assessment_prompt=$(cat << PROMPT_EOF
You are the skill assessment agent. All cost/variance data below is PRE-COMPUTED, real, and already deduplicated (latest record per story) and cross-referenced against the PRD's completion state — do not re-derive it, do not ask to see any file, just judge it.

## Phase: $phase_id

## Pre-computed assessment data
${_pa_summary}

## Your job (judgment only — you have no tools and do not need any)
1. Write "notes": a short human-readable summary of the variance (or "No improvements needed." if over_threshold is false and future_pending_stories is empty).
2. Write "agent_recommendations": an array of short strings (empty array if none).
3. CORRECTIVE ACTION: for each entry in future_pending_stories, decide whether its "description" clearly requires a
   different skill domain than its current "agentRole". Skill domain indicators: $_skill_domain_guidance
   Only propose a reassignment when the mismatch is unambiguous — conservative judgment, not a guess.
   Return "role_reassignments" as an array of {"story_id":"...","newAgentRole":"...","reason":"..."} (empty array if none).
   You do NOT write to any file yourself — the orchestrator applies your reassignments deterministically.

Output ONLY this JSON object, no markdown fences, no preamble:
{"notes":"...","agent_recommendations":["..."],"role_reassignments":[{"story_id":"...","newAgentRole":"...","reason":"..."}]}
PROMPT_EOF
    )

    log "Running assessment agent for phase '$phase_id'..."
    local assessment_log="$LOG_DIR/assessment-${phase_id}.log"

    local _pa_attempt=0 _pa_success=0 _pa_raw=""
    local _saved_pa_model="${ORCH_GATE_MODEL:-}"
    local _saved_gate_timeout="${EPAM_GATE_TIMEOUT_SECS:-}"
    # No tools needed anymore (see comment above) — this is now a pure
    # text-in/JSON-out judgment call, same class as openspec/speckit. The
    # 300s cap and 2-attempt/model-escalation retry are kept as a resilience
    # backstop, not because the task is expected to need them.
    EPAM_GATE_TIMEOUT_SECS="${PHASE_ASSESSMENT_TIMEOUT_SECS:-300}"
    while [ "$_pa_attempt" -lt 2 ] && [ "$_pa_success" = "0" ]; do
        local _pa_prompt="$assessment_prompt"
        if [ "$_pa_attempt" -ge 1 ]; then
            [ -n "${ESCALATION_MODEL_HIGH:-}" ] && ORCH_GATE_MODEL="${ESCALATION_MODEL_HIGH}"
            _pa_prompt="RETRY (attempt 2): Your previous response was not valid JSON in the required shape. Emit ONLY the JSON object now.

$assessment_prompt"
        fi
        local _assessment_rc=0
        run_orch_prompt "$_pa_prompt" "team-lead-agent" > "$assessment_log" 2>&1 || _assessment_rc=$?
        _pa_raw=$(cat "$assessment_log" 2>/dev/null)

        if [ "$_assessment_rc" -ne 0 ]; then
            warning "Phase assessment attempt $(( _pa_attempt + 1 )) failed for '$phase_id' (rc=${_assessment_rc})"
            _pa_attempt=$(( _pa_attempt + 1 ))
            continue
        fi

        if echo "$_pa_raw" | python3 -c "import sys,json,re
t=sys.stdin.read()
m=re.search(r'\{.*\}', t, re.DOTALL)
sys.exit(0 if m and isinstance(json.loads(m.group(0)), dict) else 1)" 2>/dev/null; then
            _pa_success=1
        else
            warning "Phase assessment attempt $(( _pa_attempt + 1 )) for '$phase_id' produced no valid JSON$([ "$_pa_attempt" -lt 1 ] && echo " — retrying with escalated model" || echo "")"
        fi
        _pa_attempt=$(( _pa_attempt + 1 ))
    done
    ORCH_GATE_MODEL="$_saved_pa_model"
    EPAM_GATE_TIMEOUT_SECS="$_saved_gate_timeout"

    if [ "$_pa_success" = "0" ]; then
        warning "Phase assessment for '$phase_id' failed after 2 attempt(s) — no assessment record written; non-critical, continuing"
        return 1
    fi

    # Deterministic apply: build the final assessment record from the
    # PRE-COMPUTED totals (never from the LLM's own arithmetic) plus the
    # LLM's judgment fields, flock-append it, write the markdown report, and
    # apply role reassignments — re-validated against the SAME
    # future_pending_stories list computed above, not blindly trusted from
    # the LLM's response. Mirrors story-ac-remediator's deterministic-apply
    # pattern (flock -w 10 200, python3 heredoc, atomic os.replace).
    local _pa_raw_tmp _pa_summary_tmp
    _pa_raw_tmp=$(mktemp); echo "$_pa_raw" > "$_pa_raw_tmp"
    _pa_summary_tmp=$(mktemp); echo "$_pa_summary" > "$_pa_summary_tmp"
    ( flock -w 10 200 || { error "  [phase-assessment] Could not acquire lock on $assessment_file"; rm -f "$_pa_raw_tmp" "$_pa_summary_tmp"; return 1; }
    python3 - "$_pa_summary_tmp" "$_pa_raw_tmp" "$assessment_file" "$improvement_report_file" "${MAIN_PRD_FILE:-$PRD_FILE}" <<'ASSESS_APPLY_PY'
import json, re, sys, os
from datetime import datetime, timezone

summary_file, raw_file, assessment_file, report_file, prd_file = sys.argv[1:6]

with open(summary_file) as f:
    summary = json.load(f)
raw = open(raw_file).read()

decoder = json.JSONDecoder()
payload = {}
idx = 0
while True:
    start = raw.find('{', idx)
    if start == -1:
        break
    try:
        obj, end = decoder.raw_decode(raw, start)
        if isinstance(obj, dict) and ('notes' in obj or 'agent_recommendations' in obj or 'role_reassignments' in obj):
            payload = obj
            break
        idx = end
    except json.JSONDecodeError:
        idx = start + 1

notes = payload.get('notes') or ('No improvements needed.' if not summary['over_threshold'] and not summary['future_pending_stories'] else '')
recommendations = payload.get('agent_recommendations') or []
reassignments = payload.get('role_reassignments') or []

record = {
    'phase_id': summary['phase_id'],
    'phase_name': summary['phase_id'],
    'actual_minutes': summary['actual_minutes'],
    'forecast_minutes': summary['forecast_minutes'],
    'actual_cost_usd': summary['actual_cost_usd'],
    'forecast_cost_usd': summary['forecast_cost_usd'],
    'variance_minutes': summary['variance_minutes'],
    'variance_cost_usd': summary['variance_cost_usd'],
    'over_threshold': summary['over_threshold'],
    'agent_recommendations': recommendations,
    'notes': notes,
    }
with open(assessment_file, 'a') as f:
    f.write(json.dumps(record) + '\n')

# Re-validate reassignments against the SAME future_pending_stories set the
# LLM was given — never trust a story_id/role pair from the model's own
# text without re-checking it against real, deterministically-computed
# eligibility (pending, not completed, phase strictly after this one).
eligible = {s['story_id']: s for s in summary['future_pending_stories']}
applied = []
if reassignments:
    with open(prd_file) as f:
        prd = json.load(f)
    stories_by_id = {s['id']: s for s in prd.get('stories', []) if s.get('id')}
    changed = False
    for r in reassignments:
        sid = r.get('story_id')
        new_role = r.get('newAgentRole')
        if not sid or not new_role or sid not in eligible:
            continue
        story = stories_by_id.get(sid)
        if not story or story.get('status') != 'pending' or story.get('completed'):
            continue
        if story.get('agentRole') == new_role:
            continue
        if 'originalAgentRole' not in story:
            story['originalAgentRole'] = story.get('agentRole')
        story['agentRole'] = new_role
        applied.append({'story_id': sid, 'newAgentRole': new_role, 'reason': r.get('reason', '')})
        changed = True
    if changed:
        tmp_path = prd_file + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(prd, f, indent=2)
        os.replace(tmp_path, prd_file)

ts = datetime.now(timezone.utc).isoformat()
lines = [
    f"# Phase Improvement Report: {summary['phase_id']}",
    f"_Generated: {ts}_",
    "",
    f"- Actual: {summary['actual_minutes']} min / ${summary['actual_cost_usd']}",
    f"- Forecast: {summary['forecast_minutes']} min / ${summary['forecast_cost_usd']}",
    f"- Variance: {summary['variance_minutes']} min / ${summary['variance_cost_usd']}",
    f"- Over threshold ({summary['over_threshold_pct']}%): {summary['over_threshold']}",
    "",
    "## Notes",
    notes,
]
if recommendations:
    lines += ["", "## Recommendations"] + [f"- {r}" for r in recommendations]
if applied:
    lines += ["", "## Role reassignments applied"] + [
        f"- {a['story_id']}: -> {a['newAgentRole']} ({a['reason']})" for a in applied
    ]
with open(report_file, 'w') as f:
    f.write("\n".join(lines) + "\n")

print(f"assessment record written; {len(applied)} role reassignment(s) applied")
ASSESS_APPLY_PY
    ) 200>"${assessment_file}.lock"
    rm -f "$_pa_raw_tmp" "$_pa_summary_tmp"

    success "Phase assessment completed for '$phase_id'"
    return 0
}

# Snapshot taken AFTER the parallel Step 1 loop (and any TC-writer-gate splits
# that ran inside it) but BEFORE Step 3.5's assessment agent runs. Used for
# assert_no_story_ids_gained at Step 3.5 and Step 6 — the "presplit" snapshot
# predates the parallel loop, so any stories added by the legitimate
# TC-fact-density split mechanism during Step 1 would appear as false-positive
# "unauthorized creations" if we used it here. "post-parallel" sees the
# already-split PRD and only flags stories added by the assessment agent itself.
capture_story_ids_snapshot "post-parallel"

# Only run assessment if cost tracking data exists
if is_truthy "${SKIP_SKILL_ASSESSMENT:-}"; then
    step_emit "18" "skip" "Step 18: Post-parallel assessment" "SKIP_SKILL_ASSESSMENT=1"
    info "Step 18: Skipped (SKIP_SKILL_ASSESSMENT=1)"
elif [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    step_emit "18" "running" "Step 18: Post-parallel assessment"
    log "Step 18: Running post-parallel skill assessment..."
    if run_phase_assessment "$PHASE"; then
        step_emit "18" "pass" "Step 18: Post-parallel assessment"
    else
        step_emit "18" "warn" "Step 18: Post-parallel assessment" "non-critical issues"
    fi
else
    step_emit "18" "skip" "Step 18: Post-parallel assessment" "no cost data"
    info "Step 18: No cost data yet — skipping post-parallel assessment"
fi
assert_no_story_ids_lost "presplit" "Step 18: Post-parallel assessment"
assert_no_story_ids_gained "post-parallel" "Step 18: Post-parallel assessment"

# ──────────────────────────────────────────────
    "$SCRIPT_DIR/update-monitor.sh" event "phase_assessment" "Running post-phase assessment" "" "main" "team-lead-agent" 2>/dev/null || true

# ──────────────────────────────────────────────
# Step 3.54: Dedicated reproducing-test writer (brownfield) — runs BEFORE the gate.
# Asking the impl agent to do BOTH the fix and a good reproducing test in one budget
# failed live (AMSD-1820 run #3: agent ran out of turns, shipped no test). Give
# test-writing its OWN agent turn here — it sees the committed fix diff + the VCs and
# writes a test that MATCHES the repo's convention (so the gate can run it). No-op if
# a test already accompanies the change. The Step 3.55 gate still independently
# validates fail-on-baseline/pass-with-fix; this only ensures a test EXISTS to check.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/brownfield-repro-test-writer.sh" ]; then
    while IFS= read -r _tw_story; do
        [ -z "$_tw_story" ] && continue
        PROJECT_ROOT="$PROJECT_ROOT" PRD_FILE="$PRD_FILE" LOG_DIR="$LOG_DIR" \
        JIRA_BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}" \
            bash "$SCRIPT_DIR/brownfield-repro-test-writer.sh" "$_tw_story" 2>&1 | tee -a "$LOG_DIR/repro-test-writer-${PHASE}.log"
    # EVERY story in the phase, novel included. This selector was narrowed to
    # exclude novel by fe5d6cb, which was fixing the GATE below — the writer was
    # collateral. It does not need a bug: it reads the committed fix diff and the
    # story's verificationCriteria, and validates that its test PASSES against the
    # fix. See lib/story-guards.sh for the full history.
    done < <(phase_stories_brownfield_scope "$PRD_FILE" "$PHASE")
fi

# ──────────────────────────────────────────────
# Step 3.545: Update tests the fix legitimately INVALIDATED (brownfield).
# A defect fix changes behaviour that pre-existing tests asserted — those tests
# encoded the BUG. impl may not edit tests (it writes only the fix) and the
# test-writer only AUTHORS the new repro test, so without this step nobody updates
# them: Step 5's regression guard then blocks on a broken test the pipeline itself
# produced, and the self-heal retry fails identically (caught by mock1 2026-07-24,
# same shape as the metrolinx deadlock).
# It is deliberately narrow — it BLOCKS rather than editing whenever a failure is
# not explained by the story's Verification Criteria, so a wrong fix can never
# rewrite its own oracle to go green.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/update-invalidated-tests.sh" ]; then
    _uit_failed=0
    while IFS= read -r _uit_story; do
        [ -z "$_uit_story" ] && continue
        _uit_vcs=$(jq -r --arg id "$_uit_story" \
            '(.stories[] | select(.id == $id) | .verificationCriteria // []) | join("\n- ")' \
            "$PRD_FILE" 2>/dev/null || echo "")
        PROJECT_ROOT="$PROJECT_ROOT" PRD_FILE="$PRD_FILE" LOG_DIR="$LOG_DIR" \
        JIRA_BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}" \
        STORY_VERIFICATION_CRITERIA="$_uit_vcs" \
            bash "$SCRIPT_DIR/update-invalidated-tests.sh" "$_uit_story" 2>&1 \
            | tee -a "$LOG_DIR/update-invalidated-tests-${PHASE}.log"
        # No pipefail in this script — read the real exit code from PIPESTATUS.
        [ "${PIPESTATUS[0]}" -ne 0 ] && _uit_failed=1
    done < <(jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id) != null) | .id' \
        "$PRD_FILE" 2>/dev/null)
    # NON-BLOCKING (2026-07-25). This step exists to UPDATE pre-existing tests the
    # fix invalidated — it is not an enforcement gate and must never fail a phase.
    # It gated on the WHOLE suite being red, which includes the brand-new repro test
    # the test-writer had just committed. Judging that test belongs to the repro-gate
    # at Step 3.55, which knows how to do it properly (revert the fix, confirm the
    # test fails, restore, confirm it passes). Live 2026-07-24: this step pre-empted
    # the gate and killed a run whose fix and test were both committed and whose
    # reviewer had approved the same change standalone.
    # The repro-gate remains the enforcer.
    if [ "$_uit_failed" -ne 0 ]; then
        warning "Step 3.545: could not reconcile a failing test — leaving it for the repro-gate (Step 3.55) to judge. NOT blocking."
    fi
fi

# ──────────────────────────────────────────────
# Step 3.55: Bug-reproduction test gate (brownfield, hard) — runs BEFORE review.
# The fix + test are committed by now; require that each story's new test actually
# REPRODUCES the bug (fails on the pre-fix baseline, passes with the fix). A change
# that ships no test, or a test that passes without the fix, BLOCKS the phase.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/brownfield-repro-test-gate.sh" ]; then
    log "Step 3.55: Bug-reproduction test gate (brownfield)..."
    _repro_blocked=0
    while IFS= read -r _rg_story; do
        [ -z "$_rg_story" ] && continue
        # This script runs under `set -e` WITHOUT pipefail, so `if ! gate | tee`
        # tests tee's exit (always 0) — the gate's `exit 1` on BLOCK was swallowed
        # and a testless change PASSED (live AMSD-1820 run #3). Capture the gate's
        # real exit via ${PIPESTATUS[0]}; tee exits 0 so `set -e` is not tripped.
        PROJECT_ROOT="$PROJECT_ROOT" JIRA_BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-develop}" \
             bash "$SCRIPT_DIR/brownfield-repro-test-gate.sh" "$_rg_story" 2>&1 | tee -a "$LOG_DIR/repro-gate-${PHASE}.log"
        _rg_rc=${PIPESTATUS[0]}
        if [ "${_rg_rc:-1}" -ne 0 ]; then
            warning "Step 3.55: reproduction gate BLOCKED $_rg_story (gate exit ${_rg_rc})"
            _repro_blocked=1
            _tmp_prd="$(mktemp)"; jq --arg id "$_rg_story" \
                '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "escalated", reproGate: "failed"})' \
                "$PRD_FILE" > "$_tmp_prd" 2>/dev/null && mv "$_tmp_prd" "$PRD_FILE" || rm -f "$_tmp_prd"
        fi
    # Only stories with a bug to reproduce. A novel story cannot satisfy
    # fail-on-baseline and is deliberately not gated here (fe5d6cb).
    done < <(phase_stories_for_repro_gate "$PRD_FILE" "$PHASE")
    if [ "$_repro_blocked" -eq 1 ]; then
        error "Step 3.55: one or more stories failed the bug-reproduction test gate — the fix does not ship a test that reproduces the bug. Blocking before review."
        exit 2
    fi
    success "Step 3.55: bug-reproduction test gate passed for all phase stories"
fi

# ──────────────────────────────────────────────
# Step 3.56: Verification-criteria coverage report (brownfield, advisory).
# Does the story's test cover every verification criterion it was accepted
# against? Run 7 covered two of three and silently skipped the negative case —
# the repro gate cannot see that, because it only asks whether the test fails
# before the fix and passes after.
#
# ADVISORY: reports, never blocks.
#
# Runs over the FULL brownfield scope, not the repro gate's narrower set. This
# lived inside the gate's success branch, so a novel story — which the gate never
# selects — skipped coverage reporting as silently as it skipped test authoring.
# A novel story is precisely the case where VCs are the only definition of done,
# so it is the last one that should go unreported.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/vc-coverage-check.sh" ]; then
    # story_outputs_tests lives in lib/story-outputs.sh, which is otherwise only
    # sourced inside _brownfield_gate_scope — so at this point in the run it may
    # not exist yet. Run 8: it did not, the call failed into /dev/null, and the
    # check vanished without a word.
    [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
    while IFS= read -r _vc_story; do
        [ -z "$_vc_story" ] && continue
        _vc_test_file=$(story_outputs_tests "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | head -1)
        if [ -n "$_vc_test_file" ]; then
            bash "$SCRIPT_DIR/vc-coverage-check.sh" \
                --prd "$PRD_FILE" --story "$_vc_story" \
                --test-file "$PROJECT_ROOT/$_vc_test_file" \
                --out "$LOG_DIR/vc-coverage-${_vc_story}.json" 2>&1 \
                | tee -a "$LOG_DIR/vc-coverage-${PHASE}.log" || true
        else
            # Never silent: "no test to check" and "everything covered" must not
            # look the same in the report.
            warning "  [vc-coverage] no test file in the writer manifest for ${_vc_story} — coverage NOT checked"
        fi
    done < <(phase_stories_brownfield_scope "$PRD_FILE" "$PHASE")
fi

# Step 3.58: Regression delta gate (RG-DELTA) — the "after" half of the
# before/after comparison Step 5's baseline capture set up. Compares the
# failing-test set AFTER this phase's implementation against Step 5's
# tolerated baseline (regression-guard-baseline-<phase>.json) — pass only if
# after is a subset of the baseline (nothing NEW broke), fail if a test that
# was NOT in the baseline now fails. A count-only comparison would miss a
# real regression when the total count stays the same but the IDENTITY
# differs, so this compares real test identities via testFailurePattern, not
# counts.
#
# Gated to effort:"high" stories only (user decision, 2026-07-31): re-running
# the entire suite a second time has a real cost, and most brownfield stories
# are narrow enough that their own TC-writer test + team-lead review is
# sufficient coverage. AMSD-2041 itself — effort:"low" despite spanning 3
# codelines — is the concrete case that should NOT pay this cost; complexity
# (CPA's own classification), not file/codeline count, is the trigger.
#
# Same fallback semantics as Step 5: no testFailurePattern configured, or no
# effort:"high" story in this phase, or SKIP_REGRESSION_GUARD=true, and this
# step is a no-op — never changes behavior for a project that hasn't opted in.
if ! is_truthy "${SKIP_REGRESSION_GUARD:-}"; then
    _rgd_pattern=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
        _rgd_pattern=$(jq -r '.testFailurePattern // empty' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null)
    fi
    _rgd_high_effort=0
    if [ -n "$_rgd_pattern" ] && [ -f "${PRD_FILE:-}" ]; then
        if jq -e --arg phase "$PHASE" '
              (.implementationOrder[$phase] // []) as $ids |
              any(.stories[]?; (.id as $sid | ($ids | index($sid)) != null) and .effort == "high")
            ' "$PRD_FILE" >/dev/null 2>&1; then
            _rgd_high_effort=1
        fi
    fi
    if [ -n "$_rgd_pattern" ] && [ "$_rgd_high_effort" = "1" ] && \
       [ -n "${_rg_root:-}" ] && [ -n "${_rg_pm:-}" ] && [ "${_rg_test_declared:-0}" -eq 1 ]; then
        step_emit "3.58" "running" "Step 3.58: Regression delta gate"
        log "Step 3.58: Regression delta gate — re-running $_rg_pm test in $_rg_root (effort:high story in phase '$PHASE')..."
        _rgd_baseline_file="$LOG_DIR/regression-guard-baseline-${PHASE}.json"
        _rgd_max="${EPAM_REGRESSION_GUARD_RETRIES:-2}"
        _rgd_max=$(( _rgd_max + 1 ))
        _rgd_log="$LOG_DIR/regression-delta-${PHASE}.log"
        for _rgd_try in $(seq 1 "$_rgd_max"); do
            _rgd_try_log="$_rgd_log"
            [ "$_rgd_try" -gt 1 ] && _rgd_try_log="${_rgd_log%.log}-attempt-${_rgd_try}.log"
            (cd "$_rg_root" && PATH="$(dirname "$_rg_node"):$PATH" "$_rg_pm" test) > "$_rgd_try_log" 2>&1 || true
        done
        _rgd_result=$(python3 - "$_rgd_pattern" "$_rgd_max" "$_rgd_log" "$_rgd_baseline_file" << 'RGD_DIFF_PY'
import re, sys, json

pattern, max_attempts, log_base, baseline_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
try:
    rx = re.compile(pattern, re.MULTILINE)
except re.error:
    print(json.dumps({"verdict": "unknown", "new_failures": []}))
    sys.exit(0)

def attempt_log(i):
    if i == 1:
        return log_base
    if log_base.endswith('.log'):
        return log_base[:-4] + f"-attempt-{i}.log"
    return f"{log_base}-attempt-{i}"

sets = []
for i in range(1, max_attempts + 1):
    try:
        with open(attempt_log(i)) as f:
            text = f.read()
    except OSError:
        sets.append(set())
        continue
    ids = set()
    for m in rx.finditer(text):
        g = next((x for x in m.groups() if x), None)
        if g:
            ids.add(g)
    sets.append(ids)

# Same correction as Step 5's baseline capture (live AMSD-2041, 2026-07-31):
# the intersection ALONE is the reproducible signal. A test failing in every
# after-attempt is a real, confirmed new failure; a one-off flake in a single
# attempt (present in the union but not the intersection) is exactly the
# noise the 3-attempt retry exists to filter, on EITHER side of this
# comparison — it must not block a clean phase, and it must not be silently
# folded into "new failures" either.
stable_after = set.intersection(*sets) if sets else set()

baseline = set()
try:
    with open(baseline_file) as f:
        baseline = set(json.load(f).get('failures', []))
except OSError:
    pass

new_failures = sorted(stable_after - baseline)
print(json.dumps({"verdict": "fail" if new_failures else "pass", "new_failures": new_failures}))
RGD_DIFF_PY
)
        _rgd_verdict=$(echo "$_rgd_result" | python3 -c "import json,sys; print(json.load(sys.stdin)['verdict'])" 2>/dev/null || echo unknown)
        if [ "$_rgd_verdict" = "pass" ]; then
            step_emit "3.58" "pass" "Step 3.58: Regression delta gate"
            success "Step 3.58: Regression delta gate PASSED — no new test failures beyond the tolerated baseline"
        else
            step_emit "3.58" "fail" "Step 3.58: Regression delta gate"
            _rgd_new=$(echo "$_rgd_result" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin)['new_failures']))" 2>/dev/null || echo "")
            if [ "$_rgd_verdict" = "unknown" ]; then
                error "Step 3.58: Regression delta gate CANNOT VERIFY — testFailurePattern does not compile as a regex"
                error "  This is not a confirmed regression, but it cannot be ruled out either — fix the pattern in dependency-check.json."
            else
                error "Step 3.58: Regression delta gate FAILED — this phase's changes broke test(s) that were passing at baseline: $_rgd_new"
                error "  Pre-existing failures are tolerated; these are NEW."
            fi
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
    else
        step_emit "3.58" "skip" "Step 3.58: Regression delta gate" "no effort:high story in this phase, or testFailurePattern not configured"
    fi
else
    step_emit "3.58" "skip" "Step 3.58: Regression delta gate" "SKIP_REGRESSION_GUARD=true"
fi

# Step 3.6: Team Lead Code Review — with a review → re-implement → re-review loop.
# ──────────────────────────────────────────────
# The reviewer can now TELL the impl agent to make changes: on changes_requested
# it writes review-feedback-<id>.json, which the re-implementation reads (see
# build_implementation_prompt) and the impl agent's own self-heal (failure-analyst
# + agent-KB) refines. Bounded by REVIEW_MAX_CYCLES; on exhaustion the story is
# marked escalated and the pipeline hard-blocks (a change that keeps failing
# review must never silently merge).
log "Step 3.6: Running Team Lead code review for phase..."
_emit_agent start "review-agent" "Team Lead Code Review"
# _reset_story_for_reimplementation <story_id>
# Clears completed/status on exactly ONE story so a review-driven
# re-implementation attempt is not a guaranteed no-op against
# is_story_completed. Same semantics as the outer whole-phase reset
# (`.completed = false | .status = "pending"`, see the RESET_STORIES block
# above) — that one already resets correctly at phase-restart scope; this is
# the missing per-story equivalent at the Step 3.6 retry-cycle scope.
# Scoped to one id deliberately: a sibling that already passed review must not
# be re-run. Tolerates a missing/unknown id — jq's select simply matches
# nothing, same as every other targeted PRD mutation in this file.
_reset_story_for_reimplementation() {
    local _story_id="$1"
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    [ -f "$_prd_target" ] || return 0
    local _tmp_prd
    _tmp_prd="$(mktemp)"
    chmod 644 "$_tmp_prd" 2>/dev/null
    if jq --arg id "$_story_id" \
        '(.stories[]? | select(.id == $id)) |= (.completed = false | .status = "pending")' \
        "$_prd_target" > "$_tmp_prd" 2>/dev/null; then
        mv "$_tmp_prd" "$_prd_target"
    else
        rm -f "$_tmp_prd"
    fi
    return 0
}

# The ladder-exhaustion default: same default MAX_RETRIES claude.sh itself
# uses (rung = retry_count/2, so MAX_RETRIES=7 -> 4 rungs, top rung 3).
_review_max_retries="${EPAM_MAX_RETRIES:-7}"
# SAFETY VALVE ONLY, not the primary escalation trigger. Standing requirement:
# "Retries MUST proceed up the rungs — nothing is allowed to intercede." A
# story may only be escalated once ITS OWN ladder is exhausted (checked below
# via story_ladder_exhausted), never on a bare cycle count. This cap exists
# purely so a misconfigured or never-settling reviewer cannot loop forever;
# set comfortably above the ladder's own depth so it should not fire in
# normal operation — if it does, that itself is a signal worth investigating,
# logged as such below rather than silently treated as ordinary exhaustion.
# DERIVED from the ladder's real depth, never a magic number. The ladder is
# 2 attempts per rung (rung = retry_count/2), so it has (MAX_RETRIES/2)+1 rungs;
# a review cycle can advance at most one rung, and +2 leaves headroom for the
# cycles that re-run the REVIEWER rather than the writer (review_feedback_is_
# incomplete). Ladder exhaustion is what actually stops the loop — this only
# has to be large enough never to fire first. An explicit REVIEW_MAX_CYCLES
# still wins for an operator who wants a hard ceiling.
_review_max_cycles="${REVIEW_MAX_CYCLES:-$(( _review_max_retries / 2 + 3 ))}"
_review_cycle=1
# Direct escalation flag. The hard-block below USED to rely solely on stories
# being tagged reviewStatus=escalated by iterating review-feedback-*.json files —
# but when the reviewer produced NO such files (found live 2026-07-24, AMSD-1820:
# review escalated after 2 cycles yet 0 feedback files existed), nothing got
# tagged, the jq count was 0, and a change the reviewer NEVER approved fell
# through to PASSED. The loop itself knows it escalated; block on that fact
# directly, independent of any file the reviewer may or may not have written.
_review_escalated=0

# Marks ONE rejected story escalated: persists the reviewer's blockers to both
# the review-agent KB and the writer's own profile, then tags
# reviewStatus:"escalated" on the PRD. Factored out because it now fires from
# TWO places — a story whose ladder is exhausted, and (rarely) every
# still-climbable story caught by the safety valve above — and both must
# behave identically.
_escalate_review_story() {
    local _fb="$1" _fb_story="$2"
    mkdir -p "$LOG_DIR/kb-scratchpad" 2>/dev/null || true
    # Stamp provenance. A blocker sentence written once becomes a standing
    # "LEARNED REVIEW RULE" applied to all later work, so it must say which
    # story and run produced it — otherwise a rule learned from a bad input is
    # indistinguishable from a well-founded one, and neither can be expired.
    jq -r --arg sid "$_fb_story" --arg run "${ORCH_RUN_ID:-unknown}" \
        '.issues[]? | select((.severity // "") == "blocker") | "- [" + $sid + " @" + $run + "] " + (.description // "")' "$_fb" \
        >> "$LOG_DIR/kb-scratchpad/KB-review-agent.md" 2>/dev/null || true
    # Also persist the SAME lesson to the WRITER's own profile (found live,
    # 2026-08-02: only the reviewer's own KB got this — nothing ever told the
    # WRITER across runs, so a story that repeatedly fails review for the
    # identical reason had no accumulating guidance, unlike FailureAnalyst's
    # tsc/test-failure diagnoses, which already persist via
    # _persist_skill_note_simple's stricter cousin in claude.sh). Gated
    # through the same deterministic anti-pattern check (lib/story-guards.sh)
    # for consistency/safety.
    local _fb_role _fb_blockers
    _fb_role=$(jq -r --arg id "$_fb_story" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null)
    _fb_blockers=$(jq -r '.issues[]? | select((.severity // "") == "blocker") | "- " + (.description // "")' "$_fb" 2>/dev/null)
    if [ -n "$_fb_role" ] && [ -n "$_fb_blockers" ]; then
        _persist_skill_note_simple "$AGENT_PROFILES_FILE" "$_fb_role" \
            "Review REPEATEDLY rejected ${_fb_story} (ladder exhausted) for:
${_fb_blockers}"
    fi
    local _tmp_prd
    _tmp_prd="$(mktemp)"; jq --arg id "$_fb_story" \
        '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "escalated"})' \
        "$PRD_FILE" > "$_tmp_prd" 2>/dev/null && mv "$_tmp_prd" "$PRD_FILE" || rm -f "$_tmp_prd"
}

# APPROVAL AFTER AN UNRESOLVED BLOCKER, WITH THE CODE UNCHANGED, IS A GIVE-UP.
#
# Live 2026-08-07: the reviewer raised one blocker — "no tests were added" — on three
# consecutive cycles, no test file was ever created, and cycle 4 APPROVED. The story was
# marked complete with nothing verifying it.
#
# The rule needs no vocabulary and reads nothing about WHAT the blocker said: if the previous
# cycle rejected with a blocker and the codeline is byte-identical now, the verdict changed
# while the code did not. That is the reviewer relenting, not the writer fixing.
#
# Records a fingerprint of the working tree per cycle. Cheap, and it cannot be fooled by a
# reworded blocker or a reworded approval.
_review_tree_fingerprint() {
    local _root="${JIRA_CODELINE_ROOT:-}" _sum=""
    [ -n "$_root" ] && [ -d "$_root" ] || { echo "no-codeline-root"; return 0; }
    local _cl
    for _cl in "$_root"/*/; do
        [ -e "${_cl}.git" ] || continue
        _sum="${_sum}$(git -C "${_cl%/}" diff HEAD 2>/dev/null | sha1sum 2>/dev/null | cut -d' ' -f1)"
    done
    printf '%s' "$_sum" | sha1sum 2>/dev/null | cut -d' ' -f1
}

# Did the last cycle reject with a blocker AND leave the tree unchanged since?
_review_approval_is_giveup() {
    local _prev_had_blocker="$1" _prev_fp="$2" _now_fp="$3"
    [ "$_prev_had_blocker" = "1" ] || return 1
    # UNKNOWN IS NOT UNCHANGED. With no codeline root — a greenfield run — the fingerprint is a
    # constant sentinel, so it always compares equal and EVERY approval following a blocker
    # would be condemned as a give-up. "We cannot tell whether the code changed" must never be
    # read as "the code did not change".
    [ "$_prev_fp" = "no-codeline-root" ] && return 1
    [ -n "$_prev_fp" ] && [ "$_prev_fp" = "$_now_fp" ] || return 1
    return 0
}

while true; do
    _review_fp_now="$(_review_tree_fingerprint)"
    if "$SCRIPT_DIR/team-lead-review.sh" "$PHASE"; then
        if _review_approval_is_giveup "${_review_prev_blocker:-0}" "${_review_prev_fp:-}" "$_review_fp_now"; then
            error "Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED since that rejection."
            error "Step 3.6: the verdict changed and the code did not — the blocker was never resolved. Escalating instead of approving."
            _emit_agent complete "review-agent" "Code review escalated (approval after unresolved blocker)"
            for _entry in "${_review_climbable_stories[@]:-}"; do
                [ -n "$_entry" ] && _escalate_story_review "${_entry%%:*}" || true
            done
            break
        fi
        success "Team Lead code review APPROVED for phase '$PHASE' (cycle $_review_cycle)"
        # Clear a reviewStatus:"escalated" tag left by an EARLIER cycle of
        # this same phase-retry sequence — found live 2026-08-02 (Writer
        # Retest run): a phase-level retry (after an unrelated later gate
        # failure) re-ran Step 3.6 from scratch; its first pass escalated
        # after 2 cycles (tagging reviewStatus:escalated), a LATER retry's
        # review then genuinely APPROVED the same story, but the hard-block
        # check below still found the stale tag from the earlier escalation
        # and blocked a change the reviewer HAD approved. Nothing ever
        # cleared it on a subsequent real approval — scoped to this phase's
        # own story IDs, same scoping the hard-block check itself uses.
        _tmp_prd_clear="$(mktemp)"; jq --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories |= map(if (.id as $id | $ids | index($id) != null) and .reviewStatus == "escalated"
                              then . + {reviewStatus: null} else . end)' \
            "$PRD_FILE" > "$_tmp_prd_clear" 2>/dev/null && mv "$_tmp_prd_clear" "$PRD_FILE" || rm -f "$_tmp_prd_clear"
        _emit_agent complete "review-agent" "Code review approved"
        break
    fi
    # changes_requested — team-lead-review.sh wrote review-feedback-<id>.json per story.
    # B24 — is this "the code needs changing" or "the REVIEWER failed"?
    # (predicate: review_feedback_is_incomplete, defined near the top)
    # team-lead-review.sh fails SAFE when its agent produces no verdict: it emits a
    # synthetic changes_requested so an unreviewed change can never auto-approve.
    # But that verdict is PHASE-level, so no per-story review-feedback-<id>.json
    # exists — and the loop below then "re-implements" nothing at all. Live
    # 2026-07-24: two entirely empty cycles, then escalation with tagged-stories=0,
    # on a story whose fix AND verified reproducing test had passed every gate.
    # Re-implementing is the wrong response when the story was never the problem.
    if review_feedback_is_incomplete; then
        rm -f "$LOG_DIR/review-incomplete-${PHASE}.flag" 2>/dev/null || true
        warning "Step 3.6: the REVIEWER did not produce a verdict (no per-story feedback) — re-running the REVIEW, not re-implementing (cycle $_review_cycle → $((_review_cycle + 1)))"
        _review_cycle=$((_review_cycle + 1))
        continue
    fi
    # Partition rejected stories: a story whose ladder is ALREADY exhausted
    # (its persisted rung has reached the top — see lib/story-retry-state.sh)
    # has nothing left to try and escalates now, regardless of cycle count. A
    # story that can still climb is re-implemented. Standing requirement:
    # "Retries MUST proceed up the rungs — nothing is allowed to intercede" —
    # a fixed cycle cap must never cut a climbable story off early.
    _review_climbable_stories=()
    for _fb in "$LOG_DIR"/review-feedback-*.json; do
        [ -f "$_fb" ] || continue
        _fb_story="$(basename "$_fb" | sed 's/^review-feedback-//; s/\.json$//')"
        if story_ladder_exhausted "$LOG_DIR" "$_fb_story" "$_review_max_retries"; then
            warning "Step 3.6: $_fb_story's ladder is exhausted (already tried its top rung) — escalating"
            _review_escalated=1
            _escalate_review_story "$_fb" "$_fb_story"
        else
            _review_climbable_stories+=("$_fb_story:$_fb")
        fi
    done

    if [ "${#_review_climbable_stories[@]}" -eq 0 ]; then
        # Every rejected story has exhausted its ladder — nothing left to retry.
        _emit_agent complete "review-agent" "Code review escalated (every rejected story's ladder is exhausted)"
        break
    fi

    if [ "$_review_cycle" -ge "$_review_max_cycles" ]; then
        # Safety valve. Should not fire in normal operation — ladder
        # exhaustion above bounds this first at 4 rungs (default
        # MAX_RETRIES=7). If it does fire, that itself means the ladder-
        # exhaustion accounting is out of sync with reality; log loudly
        # rather than silently treating it as ordinary exhaustion.
        warning "Step 3.6: hit the ${_review_max_cycles}-cycle SAFETY VALVE with ${#_review_climbable_stories[@]} stor(y/ies) still not ladder-exhausted — escalating anyway. This should not happen; investigate the ladder-exhaustion accounting."
        _review_escalated=1
        for _entry in "${_review_climbable_stories[@]}"; do
            _fb_story="${_entry%%:*}"; _fb="${_entry#*:}"
            _escalate_review_story "$_fb" "$_fb_story"
        done
        _emit_agent complete "review-agent" "Code review escalated (safety-valve cycle cap)"
        break
    fi

    # Remember whether THIS rejection carried a blocker, and what the tree looked like, so the
    # next cycle's approval can be checked against it.
    _review_prev_blocker=0
    for _fbf in "${LOG_DIR}"/review-feedback-*.json; do
        [ -f "$_fbf" ] || continue
        if jq -e '[.issues // [] | .[] | select((.severity // "") == "blocker")] | length > 0' "$_fbf" >/dev/null 2>&1; then
            _review_prev_blocker=1; break
        fi
    done
    _review_prev_fp="$_review_fp_now"
    warning "Step 3.6: review requested changes — re-implementing (cycle $_review_cycle → $((_review_cycle + 1)))"
    for _entry in "${_review_climbable_stories[@]}"; do
        _fb_story="${_entry%%:*}"
        # A review rejection is itself evidence this attempt did not succeed,
        # even when the code built/tested fine internally — advance the
        # story's persisted rung BEFORE re-invoking, or the next claude.sh
        # subprocess (run_story_with_watchdog spawns a fresh one) silently
        # resumes at the SAME rung, and the ladder never climbs on a
        # review-rejection-only failure. This is the exact live bug fixed
        # this session: two review cycles both logged Rung0/R1.
        advance_story_retry_rung "$LOG_DIR" "$_fb_story" "$_review_max_retries"
        # Without this reset, the retry below is a guaranteed no-op. Step 8 marks a
        # story `completed` the moment the agent's turn ends — regardless of
        # whether the reviewer will accept it — and run_story_with_watchdog
        # invokes claude.sh "$story_id", whose FIRST check is
        # is_story_completed. Live AMSD-2041 2026-07-30: the reviewer rejected
        # with 7 blockers, this loop logged "Re-implementing... (self-heal
        # enabled)", and within the same second: "Story AMSD-2041 is already
        # completed, skipping" / "Implemented: 0, Failed: 0, Skipped: 1" — zero
        # new code, zero new review evidence, one of REVIEW_MAX_CYCLES's two
        # cycles wasted on every rejection. Scoped to exactly this ONE story:
        # a sibling that already passed review must not be re-run.
        _reset_story_for_reimplementation "$_fb_story"
        log "  Re-implementing $_fb_story to address reviewer feedback (self-heal enabled)..."
        # claude.sh reads review-feedback-<id>.json (injects it into the impl
        # prompt) and its existing failure-analyst self-heal + agent-KB run on any
        # test failure during the re-implementation.
        run_story_with_watchdog "$_fb_story" "$LOG_DIR/main-${_fb_story}-rereview${_review_cycle}.log" || true
    done
    _review_cycle=$((_review_cycle + 1))
done

# Hard-block if any story was escalated (review loop exhausted without approval).
_escalated=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id) != null) |
      select(.reviewStatus == "escalated")] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0")
if [ "${_review_escalated:-0}" -eq 1 ] || [ "${_escalated:-0}" -gt 0 ]; then
    error "Step 3.6: review changes unresolved after $_review_cycle cycle(s), ladder exhausted (escalated: flag=${_review_escalated:-0} tagged-stories=${_escalated:-0})"
    error "         A change the reviewer never approved must NOT proceed — human review required."
    exit 2
fi

# ──────────────────────────────────────────────
# Step 3.7: Pre-review build gate
# Runs vitest + tsc unconditionally before review agents see the code.
# Blocks review if tests fail. Skip with SKIP_PRE_REVIEW_GATE=true.
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && [ -f "$PROJECT_ROOT/package.json" ]; then
    step_emit "19" "running" "Step 19: Pre-review gate"
    log "Step 19: Pre-review build gate (vitest + tsc)..."
    _pre_review_log="$LOG_DIR/pre-review-gate-${PHASE}.log"
    _pre_review_failed=0
    _node_bin="$(detect_node)"

    if [ -z "$_node_bin" ]; then
        warning "Step 19: Node binary not found — skipping pre-review gate"
    else
        echo "=== Pre-Review Gate: $PHASE @ $(date -Iseconds) ===" > "$_pre_review_log"
        cd "$PROJECT_ROOT"

        log "  Running vitest..."
        # Bounded timeout (added 2026-07-06): every vitest/npm invocation in
        # this file and claude.sh was unguarded — a live run's story-level
        # watchdog silently absorbed a hang in one of these (network-dependent
        # npm install, or a test that leaves a server/resource open) with zero
        # diagnostic signal about which command was actually stuck. Same fix
        # applied consistently across every instance in this file.
        if timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" "$_node_bin" ./node_modules/.bin/vitest run \
                2>&1 | tee -a "$_pre_review_log"; then
            success "  vitest: PASS"
            "$SCRIPT_DIR/update-monitor.sh" event "pre_review_test_pass" \
                "Pre-review vitest passed for $PHASE" "" "main" "unit-test-runner" 2>/dev/null || true
        else
            error "  vitest: FAIL — fix test failures before review proceeds"
            "$SCRIPT_DIR/update-monitor.sh" event "pre_review_test_fail" \
                "Pre-review vitest FAILED for $PHASE" "" "main" "unit-test-runner" 2>/dev/null || true
            _pre_review_failed=1
        fi

        log "  Running tsc --noEmit..."
        _tsc_exit=0
        _pre_review_ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l)
        if [ "$_pre_review_ts_count" -eq 0 ]; then
            success "  tsc: SKIP (no .ts files in src/ yet)"
        else
            "$_node_bin" ./node_modules/.bin/tsc --noEmit 2>&1 | tee -a "$_pre_review_log"
            _tsc_exit=${PIPESTATUS[0]}
            if [ "$_tsc_exit" -eq 0 ]; then
                success "  tsc: PASS"
            else
                error "  tsc: FAIL — fix type errors before review proceeds"
                # Diagnostic instrumentation (2026-07-23): a recurring, so-far
                # unreproducible-in-isolation TS5108 (moduleResolution=node10)
                # failure at this exact step, with a tsconfig.json PROVEN
                # byte-identical to a known-good, passing config both before
                # and after. `tsc --showConfig` prints TypeScript's actual
                # RESOLVED configuration (post any `extends`/inheritance/
                # implicit-default resolution) — this is the ground truth,
                # not a guess, for what TS is really using, independent of
                # what the raw tsconfig.json file's text says.
                {
                    echo "=== DIAGNOSTIC: tsc --showConfig (resolved config TS is actually using) ==="
                    "$_node_bin" ./node_modules/.bin/tsc --showConfig 2>&1
                    echo "=== DIAGNOSTIC: node/tsc binary identity ==="
                    echo "node_bin=$_node_bin -> $(readlink -f "$_node_bin" 2>/dev/null || echo "$_node_bin")"
                    echo "tsc=./node_modules/.bin/tsc -> $(readlink -f ./node_modules/.bin/tsc 2>/dev/null || echo unknown)"
                    echo "typescript package version: $(cat ./node_modules/typescript/package.json 2>/dev/null | grep -m1 '"version"')"
                    echo "=== DIAGNOSTIC: every tsconfig*.json under PROJECT_ROOT ==="
                    find "$PROJECT_ROOT" -iname "tsconfig*.json" -not -path "*/node_modules/*" 2>/dev/null | while read -r _tc; do
                        echo "--- $_tc ---"
                        cat "$_tc"
                    done
                    echo "=== DIAGNOSTIC: pwd and git state ==="
                    pwd
                    git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null
                    git -C "$PROJECT_ROOT" status --short 2>/dev/null
                } >> "$_pre_review_log" 2>&1
                _pre_review_failed=1
            fi
        fi

        echo "=== Gate Result: $([ $_pre_review_failed -eq 0 ] && echo PASS || echo FAIL) ===" \
            >> "$_pre_review_log"

        if [ $_pre_review_failed -ne 0 ]; then
            step_emit "19" "fail" "Step 19: Pre-review gate"
            error "Step 19: Pre-review gate FAILED — review agents blocked on broken build"
            error "  Fix failures, then re-run: $0 --phase $PHASE"
            error "  Bypass (emergency only): SKIP_PRE_REVIEW_GATE=true $0 --phase $PHASE"
            error "  Log: $_pre_review_log"
            exit 1
        fi

        step_emit "19" "pass" "Step 19: Pre-review gate"
            success "Step 19: Pre-review gate PASSED"
    fi
else
    is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && \
        step_emit "19" "skip" "Step 19: Pre-review gate" "SKIP_PRE_REVIEW_GATE=true"
        info "Step 19: Pre-review gate skipped (SKIP_PRE_REVIEW_GATE=true)"
fi

# ──────────────────────────────────────────────
# Step 3.8: Lint gate — tsc + eslint on PROJECT_ROOT/src
# Runs after the pre-review vitest/tsc gate and before review stories.
# Catches syntax and type errors that agents introduce during Step 1 so they
# don't propagate to expensive quality gates (SAST, perf-sentinel, etc.).
# Bypass: SKIP_LINT_GATE=true
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_LINT_GATE:-}" && [ -n "$_node_bin" ] && [ -x "$_node_bin" ]; then
    step_emit "20" "running" "Step 20: Lint gate"
    log "Step 20: Lint gate (tsc + eslint)..."
    _lint_log="$LOG_DIR/lint-gate-${PHASE}.log"
    _lint_failed=0
    echo "=== Lint Gate: $PHASE @ $(date -Iseconds) ===" > "$_lint_log"

    # ── tsc --noEmit ──────────────────────────────────────────────────────────
    log "  [lint] Running tsc --noEmit..."
    _lint_tsc_exit=0
    _lint_ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l)
    if [ "$_lint_ts_count" -eq 0 ]; then
        success "  [lint] tsc: SKIP (no .ts files in src/ yet)"
    else
        cd "$PROJECT_ROOT" && "$_node_bin" ./node_modules/.bin/tsc --noEmit 2>&1 | tee -a "$_lint_log"
        _lint_tsc_exit=${PIPESTATUS[0]}
        if [ "$_lint_tsc_exit" -eq 0 ]; then
            success "  [lint] tsc: PASS"
        else
            error "  [lint] tsc: FAIL (exit $_lint_tsc_exit) — fix TypeScript errors before proceeding"
            _lint_failed=1
        fi
    fi

    # ── eslint (if binary present) ────────────────────────────────────────────
    _eslint_bin=""
    for _candidate in \
        "$PROJECT_ROOT/node_modules/.bin/eslint" \
        "$(command -v eslint 2>/dev/null)"; do
        [ -x "$_candidate" ] && { _eslint_bin="$_candidate"; break; }
    done

    # Verify eslint can actually resolve its config before running on src/.
    # File-existence checks alone are insufficient: ESLint 6.x doesn't support .cjs/.mjs
    # config formats even if the file exists. Use --print-config as a dry-run probe.
    # Probe with a file eslint will really be asked to lint — probing a stack the
    # run then fails to cover is how this gate passed its own preflight and still
    # examined nothing.
    _probe_file=""
    if [ -n "$_eslint_bin" ]; then
        for _ext in js jsx mjs cjs ts tsx mts cts vue svelte; do
            _probe_file="$(find "$PROJECT_ROOT/src" -type f -name "*.${_ext}" \
                            -not -path '*/node_modules/*' -print -quit 2>/dev/null)"
            [ -n "$_probe_file" ] && break
        done
    fi
    _eslint_config=""
    if [ -n "$_eslint_bin" ] && [ -n "$_probe_file" ] && \
       cd "$PROJECT_ROOT" && "$_eslint_bin" --print-config "$_probe_file" > /dev/null 2>&1; then
        _eslint_config="confirmed"
    fi

    if [ -n "$_eslint_bin" ] && [ -z "$_probe_file" ]; then
        # Not a failure: there is nothing here for ESLint to have an opinion
        # about. Reporting this as FAIL would push an empty finding into the
        # remediation pipeline, which can only answer "could not map lint
        # failure to a story".
        info "  [lint] eslint: SKIP (no lintable source files under src/)"
        echo "eslint: no lintable source files under src/ — nothing examined" >> "$_lint_log"
    elif [ -n "$_eslint_bin" ] && [ -n "$_eslint_config" ]; then
        # Delegated to lib/eslint-baseline-gate.sh — see that file's header for
        # why. In short: this used to be `eslint src/ --max-warnings 0`, which
        # (a) expands a bare directory using --ext, default .js, so on the live
        # TypeScript codeline it examined ZERO files and failed with exit 2, and
        # (b) judged the whole tree, so on any codeline carrying pre-existing
        # lint debt it fails on files no agent ever touched. The gate now judges
        # the writers' output against the phase baseline, and fixes what is
        # auto-fixable rather than buying a full phase re-run to correct
        # whitespace.
        # shellcheck disable=SC1090
        . "$SCRIPT_DIR/lib/eslint-baseline-gate.sh"
        _eslint_gate_rc=0
        eslint_baseline_gate "$PROJECT_ROOT" "$_eslint_bin" "$LOG_DIR" "$_lint_log" || _eslint_gate_rc=$?
        [ "$_eslint_gate_rc" -ne 0 ] && _lint_failed=1
    elif [ -n "$_eslint_bin" ]; then
        info "  [lint] eslint found but no config in PROJECT_ROOT — skipping eslint (tsc only)"
        echo "eslint: binary present but no config file found" >> "$_lint_log"
    else
        info "  [lint] eslint not found in project — skipping eslint (tsc only)"
        echo "eslint: not configured in project" >> "$_lint_log"
    fi

    echo "=== Gate Result: $([ "$_lint_failed" -eq 0 ] && echo PASS || echo FAIL) ===" >> "$_lint_log"

    if [ "$_lint_failed" -ne 0 ]; then
        # Try the cheap repair FIRST. Run 7 ended here with everything it existed
        # for already correct — grounded diagnosis, minimal fix, a test proven
        # RED→GREEN, review approved — over a string literal repeated four times
        # in fixture data. The only remediation on offer was to rewrite the story
        # and rebuild the entire phase, discarding a correct fix and a proven test
        # to address a duplicated string. Fix the finding; do not rebuild around it.
        #
        # Every edit is verified (lint clean, types compile, tests still pass) and
        # reverted on any failure, so the worst case is exactly where we were.
        if _lint_fix_findings_directly "$_lint_log" "$PHASE"; then
            step_emit "20" "pass" "Step 20: Lint gate" "findings repaired in place"
            _lint_failed=0
        fi
    fi

    if [ "$_lint_failed" -ne 0 ]; then
        step_emit "20" "fail" "Step 20: Lint gate"
        error "Step 20: Lint gate FAILED — running self-healing remediation pipeline..."

        # ── Self-healing: route lint failure through gate-finding-analyst ─────
        # Same three-agent pipeline as testing gates (step 4.2):
        #   Agent 1 (gate-finding-analyst):  extracts grounded finding from lint log
        #   Agent 2 (story-ac-remediator):   augments owning story ACs in PRD
        #   Agent 3 (profile-augmentor):     records anti-pattern in agent profile
        _lint_remediation_applied=0
        _lint_rem_log="$LOG_DIR/lint-remediation-${PHASE}.log"
        _profiles_file="${AUTOMATION_DIR}/agents/profiles.json"

        if ! is_truthy "${SKIP_GATE_REMEDIATION:-}" && [ -f "$_lint_log" ]; then
            # ── Self-heal KB (episodic tier) ─────────────────────────────────
            # The lint log is tsc --noEmit + eslint output — deterministic tool
            # signal, exactly what the signature must be derived from. Recorded
            # here because gate remediation is a DIFFERENT mechanism from
            # claude.sh's story-implementation heal: a mock run proved the story
            # path never fires for a gate failure, so wiring only that one left
            # this whole class unrecorded. Flag-guarded; never fails the gate.
            if [ -f "$SCRIPT_DIR/lib/kb-apply.sh" ]; then
                # shellcheck disable=SC1090
                . "$SCRIPT_DIR/lib/kb-apply.sh"
                head -c 8000 "$_lint_log" 2>/dev/null | \
                    kb_record_episode "${_phase:-${PHASE:-core}}" "lint-gate" "lint gate failed" || true
            fi
            info "  [lint-gate:analyst] Extracting grounded finding from lint log..."
            _lint_finding_prompt="$(cat <<LINT_FIND_EOF
You are the gate-finding-analyst. A lint gate (tsc --noEmit + eslint) failed during the '$PHASE' phase of an automated TypeScript project build.

## Lint Gate Log
$(cat "$_lint_log" 2>/dev/null | head -200)

## Files THIS RUN produced or modified (the writer-output manifest)
$(if [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ]; then . "$SCRIPT_DIR/lib/story-outputs.sh" 2>/dev/null; story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | head -30; fi)

A finding in ANY file above was produced by this run and is in scope, even if
that file is not declared in a story's technicalNotes.files. Reproducing tests are written by a separate
agent AFTER the story declares its files, so a .spec.ts/.test.ts will normally be
absent from the declared list while still being this run's work — live
2026-07-26, a real finding in a newly-written test file was dropped for exactly
that reason. Attribute such a file to the story whose source file it tests.

## PRD Stories (active)
$(python3 -c "import json,sys; d=json.load(open('${MAIN_PRD_FILE:-$PRD_FILE}')); active=set(s for p in d['implementationOrder'].values() for s in p); [print(json.dumps({'id':s['id'],'title':s.get('title',''),'files':s.get('technicalNotes',{}).get('files',[])})) for s in d['stories'] if s['id'] in active]" 2>/dev/null | head -50)

## Agent Profile
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('gate-finding-analyst',''))" 2>/dev/null)

Identify: which story owns the file with the lint/type error? Output JSON only:
{"gate":"lint","story_id":"<id>","file":"<path>","line":<n>,"rule":"<tsc-error-code or eslint-rule>","message":"<description>","suggested_fix":"<one-line fix>"}
LINT_FIND_EOF
)"
            _lint_finding_raw=""
            _lga_attempt=0
            while [ "$_lga_attempt" -lt 2 ] && [ -z "$_lint_finding_raw" ]; do
                _lga_prompt="$_lint_finding_prompt"
                _lga_model="${ORCH_GATE_MODEL:-z-ai/glm-5.2}"
                if [ "$_lga_attempt" -ge 1 ]; then
                    [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _lga_model="${ESCALATION_MODEL_HIGH}"
                    _lga_prompt="RETRY (attempt 2): Your previous response was empty. Read the lint log at ${_lint_log}, identify the failing file and story, and emit ONLY the JSON output.

$_lint_finding_prompt"
                fi
                # Full agent audit, 2026-07-31: gate-finding-analyst gets tool
                # access via TWO DIFFERENT mechanisms at its two call sites —
                # here, calling `epam run` directly bypasses ai-run.sh
                # entirely, so ai-run.sh's --no-tools-by-default gating never
                # applies and the CLI's own default (tools ON) is used. The
                # OTHER call site (self-heal remediation, agent 1/3, further
                # below) goes through ai-run.sh with an explicit
                # AI_GATE_ALLOW_TOOLS=1. Both are correct TODAY — this is a
                # maintainability tripwire, not a bug: if a future refactor
                # routes this call through ai-run.sh (e.g. for consistency
                # with the retry/cost-tracking helpers elsewhere in this
                # file) without also adding AI_GATE_ALLOW_TOOLS=1, it will
                # silently lose tool access the same way codeline-bridge-agent
                # did. See gate-finding-analyst-dual-mechanism.test.ts.
                _lga_raw="$(echo "$_lga_prompt" | \
                    timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run --provider "${ORCH_GATE_PROVIDER:-qwen}" \
                        --model "${_lga_model}" \
                        --json - 2>>"$_lint_rem_log" || echo "")"
                if [ -n "$_lga_raw" ]; then
                    _lint_finding_raw="$_lga_raw"
                else
                    [ "$_lga_attempt" -lt 1 ] && warning "  [lint-gate:analyst] attempt 1 returned no output — retrying with escalated model" || warning "  [lint-gate:analyst] all 2 attempts returned no output — skipping lint remediation"
                fi
                _lga_attempt=$(( _lga_attempt + 1 ))
            done
            _lint_story_id="$(echo "$_lint_finding_raw" | python3 -c "
import sys,json,re
raw=sys.stdin.read()
m=re.search(r'\{[^{}]*\"story_id\"[^{}]*\}', raw, re.DOTALL)
if m:
    try: print(json.loads(m.group(0)).get('story_id',''))
    except: pass
" 2>/dev/null || echo "")"

            if [ -n "$_lint_story_id" ]; then
                info "  [lint-gate:analyst] Finding mapped to story: $_lint_story_id"
                # Agent 2: story-ac-remediator — add AC to prevent recurrence
                info "  [lint-gate:remediator] Augmenting ACs for story $_lint_story_id..."
                _lint_ac_prompt="$(cat <<LINT_AC_EOF
You are the story-ac-remediator. A lint gate failure was mapped to story '$_lint_story_id'.

## Finding
$_lint_finding_raw

## Current story ACs
$(python3 -c "import json; d=json.load(open('${MAIN_PRD_FILE:-$PRD_FILE}')); [print(json.dumps(s.get('acceptanceCriteria',[]))) for s in d['stories'] if s['id']=='$_lint_story_id']" 2>/dev/null)

## Agent Profile
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('story-ac-remediator',''))" 2>/dev/null)

Add 1-2 ACs to story '$_lint_story_id' that would prevent this lint failure. Output JSON only:
{"story_id":"$_lint_story_id","new_acs":["<ac text>"],"rationale":"<why>"}
LINT_AC_EOF
)"
                _lint_ac_raw=""
                _lrem_attempt=0
                while [ "$_lrem_attempt" -lt 2 ] && [ -z "$_lint_ac_raw" ]; do
                    _lrem_prompt="$_lint_ac_prompt"
                    _lrem_model="${ORCH_GATE_MODEL:-z-ai/glm-5.2}"
                    if [ "$_lrem_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _lrem_model="${ESCALATION_MODEL_HIGH}"
                        _lrem_prompt="RETRY (attempt 2): Your previous response was empty or missing the 'new_acs' field. Emit ONLY the JSON: {\"story_id\":\"...\",\"new_acs\":[\"...\"]}.

$_lint_ac_prompt"
                    fi
                    _lrem_raw="$(echo "$_lrem_prompt" | \
                        timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run --provider "${ORCH_GATE_PROVIDER:-qwen}" \
                            --model "${_lrem_model}" \
                            --json - 2>>"$_lint_rem_log" || echo "")"
                    if [ -n "$_lrem_raw" ]; then
                        _lint_ac_raw="$_lrem_raw"
                    else
                        [ "$_lrem_attempt" -lt 1 ] && warning "  [lint-gate:remediator] attempt 1 returned no output — retrying with escalated model" || warning "  [lint-gate:remediator] all 2 attempts returned no output — skipping AC augmentation"
                    fi
                    _lrem_attempt=$(( _lrem_attempt + 1 ))
                done
                _lint_ac_tmp="$(mktemp)"
                echo "$_lint_ac_raw" > "$_lint_ac_tmp"
                _lint_acs_added="$( ( flock -w 10 200 || { error "  [lint-gate:remediator] Could not acquire lock on ${MAIN_PRD_FILE:-$PRD_FILE}"; return 1; }
                python3 - "${MAIN_PRD_FILE:-$PRD_FILE}" "$_lint_story_id" "$_lint_ac_tmp" <<'LINT_AC_PY'
import sys,json,os
prd_path=sys.argv[1]; story_id=sys.argv[2]; raw_file=sys.argv[3]
raw=open(raw_file).read()
# Robust JSON-object scan, not a brace-depth-free regex -- see the sibling
# fix in the Step 4.2 story-ac-remediator above for why: a suggested AC's
# own verification snippet (e.g. `node -e "...{...}..."`) can contain
# literal braces inside a JSON string value, which a regex requiring ZERO
# braces in the whole match can never find. json.JSONDecoder.raw_decode
# respects real JSON nesting/escaping regardless of string contents.
decoder=json.JSONDecoder()
payload=None
idx=0
while True:
    start=raw.find('{', idx)
    if start==-1: break
    try:
        obj,end=decoder.raw_decode(raw, start)
        if isinstance(obj, dict) and 'new_acs' in obj:
            payload=obj
            break
        idx=end
    except json.JSONDecodeError:
        idx=start+1
if not payload: sys.exit(0)
new_acs=payload.get('new_acs',[])
if not new_acs: sys.exit(0)
with open(prd_path) as f: d=json.load(f)
added=0
for s in d['stories']:
    if s['id']==story_id:
        existing=[a.get('text','') if isinstance(a,dict) else str(a) for a in s.get('acceptanceCriteria',[])]
        for ac in new_acs:
            if ac and ac not in existing and len(existing)<24:
                s.setdefault('acceptanceCriteria',[]).append({'text':ac,'status':'pending'})
                added+=1
_tmp_prd_path=prd_path+'.tmp'
with open(_tmp_prd_path,'w') as f: json.dump(d,f,indent=2)
os.replace(_tmp_prd_path, prd_path)
print(added)
LINT_AC_PY
                2>/dev/null || echo "0"
                ) 200>"${MAIN_PRD_FILE:-$PRD_FILE}.lock" )"
                rm -f "$_lint_ac_tmp"
                if [ "${_lint_acs_added:-0}" -gt 0 ]; then
                    success "  [lint-gate:remediator] ${_lint_acs_added} AC(s) added to $_lint_story_id"
                    _lint_remediation_applied=1
                fi

                # Agent 3: profile-augmentor — 1 retry on empty output
                info "  [lint-gate:augmentor] Recording lint anti-pattern in profile..."
                _laug_raw="$(echo "$_lint_finding_raw" | \
                    timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run --provider "${ORCH_GATE_PROVIDER:-qwen}" \
                        --model "${ORCH_GATE_MODEL:-z-ai/glm-5.2}" \
                        --json - 2>>"$_lint_rem_log" || echo "")"
                if [ -z "$_laug_raw" ]; then
                    warning "  [lint-gate:augmentor] attempt 1 returned no output — retrying"
                    echo "$_lint_finding_raw" | \
                        timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run --provider "${ORCH_GATE_PROVIDER:-qwen}" \
                            --model "${ORCH_GATE_MODEL:-z-ai/glm-5.2}" \
                            --json - 2>>"$_lint_rem_log" || true
                fi
            else
                warning "  [lint-gate:analyst] Could not map lint failure to a story — skipping AC remediation"
            fi
        fi

        if [ "$_lint_remediation_applied" = "1" ]; then
            warning "Step 20: Lint gate remediation applied — caller should retry phase"
            error "Step 20: Lint gate FAILED — remediation applied, retry required"
            error "  Remediation log: $_lint_rem_log"
            exit 2  # exit 2 = remediated, tier3 runner resets and retries phase
        fi

        error "Step 20: Lint gate FAILED — fix errors before review proceeds"
        error "  Log: $_lint_log"
        error "  Bypass (emergency only): SKIP_LINT_GATE=true $0 --phase $PHASE"
        exit 1
    fi
    step_emit "20" "pass" "Step 20: Lint gate"
    success "Step 20: Lint gate PASSED"
else
    if is_truthy "${SKIP_LINT_GATE:-}"; then
        step_emit "20" "skip" "Step 20: Lint gate" "SKIP_LINT_GATE=true"
        info "Step 20: Lint gate skipped (SKIP_LINT_GATE=true)"
    else
        step_emit "20" "skip" "Step 20: Lint gate" "no node binary"
        info "Step 20: Lint gate skipped (node binary not found)"
    fi
fi

# ──────────────────────────────────────────────
# Step 4: Run review stories
# ──────────────────────────────────────────────
if [ -n "$review_stories" ]; then
    step_emit "21" "running" "Step 21: Review stories"
    log "Step 21: Running review stories..."
    while IFS= read -r story; do
        [ -z "$story" ] && continue
        check_cost_budget
        wait_if_paused
        apply_redirect_if_any "$story"
        "$SCRIPT_DIR/update-monitor.sh" event "code_review" "Team Lead code review completed" "" "main" "team-lead-agent" 2>/dev/null || true
        # Remove stale review artifact before each run so the pre-existing-file AC never blocks a retry
        _stale_review="$PROJECT_ROOT/review/${story}-review.md"
        if [ -f "$_stale_review" ]; then
            rm -f "$_stale_review"
            info "  Removed stale review artifact before retry: review/${story}-review.md"
        fi
        log "  Running review: $story"
        run_story_with_watchdog "$story" "$LOG_DIR/review-${story}.log"
        record_story_actual_cost "$story" "$LOG_DIR/review-${story}.log"
    done <<< "$review_stories"
    if [ "${_review_failed:-0}" -gt 0 ]; then
        step_emit "21" "fail" "Step 21: Review stories"
    else
        step_emit "21" "pass" "Step 21: Review stories"
    fi
    success "Review stories complete"
else
    step_emit "21" "skip" "Step 21: Review stories" "no review stories"
    info "Step 21: No review stories in this phase"
fi

# ──────────────────────────────────────────────
# run_testing_gates <phase_id>
# Steps 4.2–4.4: Testing coordinator gate (three phases).
# Phase A (Step 4.2): sast-sentinel + spec-validator in parallel.
# Phase B (Step 4.3): review-ranger + mutant-hunter in parallel (only if A passes).
# Phase C (Step 4.4): fuzz-weaver + perf-sentinel in parallel (only if A+B pass).
# Blocks phase gate if any agent returns a blocker-severity finding.
# Skippable with SKIP_TESTING_GATES=true.
# ──────────────────────────────────────────────
run_testing_gates() {
    local phase_id="$1"
    local gate_log="$LOG_DIR/testing-gates-${phase_id}.log"
    local gate_jsonl="$LOG_DIR/testing-gates.jsonl"
    local profiles_file="$AGENT_PROFILES_FILE"
    local failed=0
    # Declared here (not down at the remediation block) because several gates'
    # "agent ran fine, content says fail" branches need to append to these
    # AS THEY EVALUATE — declaring them later in the same function would wipe
    # out those earlier appends via `local`'s scope-wide (not block-wide) effect.
    local _failing_logs=()
    local _log_labels=()
    local force_lightpanda="${FORCE_LIGHTPANDA:-0}"
    local force_playwright="${FORCE_PLAYWRIGHT:-0}"
    local routing_decision="auto"
    local routing_reason="complexity_policy"
    local start_ts
    start_ts=$(date +%s%3N 2>/dev/null || date +%s)

    if [ "$force_lightpanda" = "1" ] && [ "$force_playwright" = "1" ]; then
        warning "Both FORCE_LIGHTPANDA=1 and FORCE_PLAYWRIGHT=1 set; FORCE_PLAYWRIGHT takes precedence"
    fi
    if [ "$force_playwright" = "1" ]; then
        routing_decision="force_playwright"
        routing_reason="env_override"
    elif [ "$force_lightpanda" = "1" ]; then
        routing_decision="force_lightpanda"
        routing_reason="env_override"
    fi

    if is_truthy "${SKIP_TESTING_GATES:-}"; then
        step_emit "22a" "skip" "Step 22a: SAST sentinel" "SKIP_TESTING_GATES=true"
step_emit "22b" "skip" "Step 22b: Spec validator" "SKIP_TESTING_GATES=true"
step_emit "22c" "skip" "Step 22c: Review ranger" "SKIP_TESTING_GATES=true"
step_emit "22d" "skip" "Step 22d: Mutant hunter" "SKIP_TESTING_GATES=true"
step_emit "22e" "skip" "Step 22e: Fuzz-weaver" "SKIP_TESTING_GATES=true"
step_emit "22f" "skip" "Step 22f: Perf sentinel" "SKIP_TESTING_GATES=true"
step_emit "23"  "skip" "Step 23: Browser E2E" "SKIP_TESTING_GATES=true"
        info "Step 4.2: Testing gates skipped (SKIP_TESTING_GATES=true)"
        return 0
    fi

    # Check if phase has code stories (skip for docs-only phases)
    local phase_story_count
    phase_story_count=$(jq -r --arg phase "$phase_id" \
        '(.implementationOrder[$phase] // []) | length' \
        "$PRD_FILE" 2>/dev/null || echo "0")
    if [ "${phase_story_count:-0}" -eq 0 ]; then
        info "Step 4.2: No stories in phase '$phase_id' — skipping testing gates"
        return 0
    fi

    cd "$PROJECT_ROOT"
    log "Step 4.2: Running testing gates for phase '$phase_id'..."
    info "  E2E routing overrides: FORCE_LIGHTPANDA=$force_lightpanda FORCE_PLAYWRIGHT=$force_playwright (decision=$routing_decision)"
    echo "=== Testing Gates: $phase_id @ $(date -Iseconds) ===" > "$gate_log"
    echo "Routing override decision: $routing_decision ($routing_reason), FORCE_LIGHTPANDA=$force_lightpanda, FORCE_PLAYWRIGHT=$force_playwright" >> "$gate_log"
    "$SCRIPT_DIR/update-monitor.sh" event "testing_gate_start" \
        "Starting testing gates for $phase_id" "" "main" "test-coordinator-agent" 2>/dev/null || true

    # Load browser E2E profiles for routing execution (Step 4.6).
    local lightpanda_profile=""
    local playwright_profile=""
    if [ -f "$profiles_file" ]; then
        lightpanda_profile=$(jq -r '.["lightpanda-agent"] // ""' "$profiles_file")
        playwright_profile=$(jq -r '.["playwright-agent"] // ""' "$profiles_file")
    fi
    local e2e_route_runs=0
    local e2e_route_lightpanda=0
    local e2e_route_playwright=0
    local e2e_route_failed=0
    local e2e_route_log="$LOG_DIR/e2e-routing-${phase_id}.log"
    local max_routing_stories="${MAX_BROWSER_ROUTING_STORIES:-3}"
    echo "=== Browser E2E Routing: $phase_id @ $(date -Iseconds) ===" > "$e2e_route_log"

    e2e_story_score() {
        local story_id="$1"
        local score=0
        local hours
        local priority
        local haystack
        hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.estimatedHours // 0)' "$PRD_FILE" 2>/dev/null || echo "0")
        priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.priority // "")' "$PRD_FILE" 2>/dev/null || echo "")
        haystack=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | ((.title // "") + " " + (.description // "")) | ascii_downcase' "$PRD_FILE" 2>/dev/null || echo "")

        if [ "${hours%.*}" -ge 8 ] 2>/dev/null; then score=$((score + 3));
        elif [ "${hours%.*}" -ge 5 ] 2>/dev/null; then score=$((score + 2));
        elif [ "${hours%.*}" -ge 3 ] 2>/dev/null; then score=$((score + 1));
        fi

        case "$(echo "$priority" | tr '[:upper:]' '[:lower:]')" in
            critical|high) score=$((score + 2)) ;;
        esac
        if echo "$haystack" | grep -Eq '(auth|payment|checkout|billing)'; then score=$((score + 2)); fi
        if echo "$haystack" | grep -Eq '(ui|frontend|screen|page|form|browser|e2e)'; then score=$((score + 1)); fi
        echo "$score"
    }

    should_route_browser_story() {
        local story_id="$1"
        local haystack
        haystack=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | ((.title // "") + " " + (.description // "") + " " + (.storyType // "")) | ascii_downcase' "$PRD_FILE" 2>/dev/null || echo "")
        if [ "$force_lightpanda" = "1" ] || [ "$force_playwright" = "1" ]; then
            return 0
        fi
        echo "$haystack" | grep -Eq '(ui|frontend|screen|page|form|browser|e2e|auth|checkout|payment)' && return 0
        return 1
    }

    run_browser_e2e_routing() {
        local phase_ids
        local routed=0
        local story_id
        local route
        local route_reason
        local route_score
        local story_log
        local agent_profile
        local story_title
        local prompt
        local rc

        if [ "${SKIP_BROWSER_E2E_ROUTING:-false}" = "true" ]; then
            step_emit "23" "skip" "Step 23: Browser E2E" "SKIP_BROWSER_E2E_ROUTING=true"
            info "  Step 4.6: Browser E2E routing skipped (SKIP_BROWSER_E2E_ROUTING=true)"
            return 0
        fi

        phase_ids=$(jq -r --arg phase "$phase_id" '(.implementationOrder[$phase] // [])[]' "$PRD_FILE" 2>/dev/null || true)
        if [ -z "$phase_ids" ]; then
            info "  Step 4.6: No phase stories for browser E2E routing"
            return 0
        fi

        step_emit "23" "running" "Step 23: Browser E2E"
        log "  Step 4.6: Browser E2E routing checks (Lightpanda/Playwright)..."
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            should_route_browser_story "$story_id" || continue
            if [ "$routed" -ge "$max_routing_stories" ]; then
                warning "  Step 4.6: Reached MAX_BROWSER_ROUTING_STORIES=$max_routing_stories (remaining stories skipped)"
                break
            fi

            route_score=$(e2e_story_score "$story_id")
            route="lightpanda-agent"
            route_reason="complexity_low_or_medium"
            if [ "$force_playwright" = "1" ]; then
                route="playwright-agent"
                route_reason="env_force_playwright"
            elif [ "$force_lightpanda" = "1" ]; then
                route="lightpanda-agent"
                route_reason="env_force_lightpanda"
            elif [ "${route_score:-0}" -ge 7 ]; then
                route="playwright-agent"
                route_reason="complexity_high"
            elif [ "${route_score:-0}" -ge 4 ]; then
                route="lightpanda-agent"
                route_reason="complexity_medium"
            fi

            if [ "$route" = "playwright-agent" ] && [ -z "$playwright_profile" ]; then
                route="lightpanda-agent"
                route_reason="fallback_playwright_profile_missing"
                warning "  Step 4.6: playwright-agent profile missing; falling back to lightpanda-agent for $story_id"
            fi
            if [ "$route" = "lightpanda-agent" ] && [ -z "$lightpanda_profile" ]; then
                warning "  Step 4.6: lightpanda-agent profile missing; skipping $story_id"
                continue
            fi

            story_title=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.title // $id)' "$PRD_FILE" 2>/dev/null || echo "$story_id")
            "$SCRIPT_DIR/update-monitor.sh" event "e2e_route" \
                "Routed $story_id to $route (score=$route_score, reason=$route_reason)" "$story_id" "main" "test-coordinator-agent" 2>/dev/null || true

            routed=$((routed + 1))
            e2e_route_runs=$((e2e_route_runs + 1))
            if [ "$route" = "playwright-agent" ]; then
                e2e_route_playwright=$((e2e_route_playwright + 1))
                agent_profile="$playwright_profile"
            else
                e2e_route_lightpanda=$((e2e_route_lightpanda + 1))
                agent_profile="$lightpanda_profile"
            fi

            story_log="$LOG_DIR/${route}-${phase_id}-${story_id}.log"
            prompt="$agent_profile

You are running as $route inside Step 4.6 Browser E2E routing checks.
Phase: $phase_id
Story: $story_id
Story title: $story_title
Route reason: $route_reason
Complexity score: $route_score

Return strict JSON only:
{
  \"agent\": \"$route\",
  \"storyId\": \"$story_id\",
  \"phase\": \"$phase_id\",
  \"verdict\": \"pass|warn|fail\",
  \"findings\": [{\"severity\": \"blocker|major|minor\", \"message\": \"...\", \"file\": \"...\", \"line\": 0}],
  \"summary\": \"...\"
}"

            echo "[$(date -Iseconds)] story=$story_id route=$route score=$route_score reason=$route_reason" >> "$e2e_route_log"
            set +e
            # run_orch_prompt_with_tools (not plain run_orch_prompt): the
            # playwright-agent/lightpanda-agent profiles instruct actually
            # running browser E2E tests — impossible without Bash tool access,
            # so this call was guaranteed to hallucinate its verdict every time
            # (found live 2026-07-08, same class of bug already fixed for the
            # assessment agents above).
            _run_qa_gate_with_retry "$prompt" "qa-gate:e2e" "${story_id:-unknown}" "$story_log"
            rc=$?
            set -e
            if [ $rc -ne 0 ]; then
                error "  Step 4.6: $route failed for $story_id (exit $rc)"
                e2e_route_failed=$((e2e_route_failed + 1))
                failed=1
                continue
            fi
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$story_log" 2>/dev/null; then
                error "  Step 4.6: $route reported FAIL for $story_id"
                e2e_route_failed=$((e2e_route_failed + 1))
                failed=1
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$story_log" 2>/dev/null; then
                warning "  Step 4.6: $route reported WARN for $story_id"
            else
                success "  Step 4.6: $route PASS for $story_id"
            fi
        done <<< "$phase_ids"

        if [ $e2e_route_runs -eq 0 ]; then
            step_emit "23" "skip" "Step 23: Browser E2E" "no stories matched"
            info "  Step 4.6: No stories matched browser E2E routing criteria"
        elif [ "$e2e_route_failed" -gt 0 ]; then
            step_emit "23" "fail" "Step 23: Browser E2E"
        else
            step_emit "23" "pass" "Step 23: Browser E2E"
        fi
        echo "Summary: runs=$e2e_route_runs lightpanda=$e2e_route_lightpanda playwright=$e2e_route_playwright failed=$e2e_route_failed" >> "$e2e_route_log"
        return 0
    }

    # ── Phase A: SAST sentinel + spec validator (parallel) ──
    local sast_log="$LOG_DIR/sast-sentinel-${phase_id}.log"
    local spec_log="$LOG_DIR/spec-validator-${phase_id}.log"
    local sast_exit=0
    local spec_exit=0

    # Load QA gate agent profiles
    local sast_profile=""
    local spec_profile=""
    if [ -f "$profiles_file" ]; then
        sast_profile=$(jq -r '.["sast-sentinel"] // ""' "$profiles_file")
        spec_profile=$(jq -r '.["spec-validator"] // ""' "$profiles_file")
    fi

    # ── SAST Sentinel ──
    step_emit "22a" "running" "Step 22a: SAST sentinel"
    log "  Step 4.2a: Running SAST sentinel..."
    {
        local sast_prompt="You are acting as the sast-sentinel agent.

Phase: $phase_id
Project root: $PROJECT_ROOT

IMPORTANT: All evidence has been pre-computed and is injected above. Do NOT attempt to call any shell commands, bash, or tools. Analyze ONLY the injected Semgrep, npm audit, and TypeScript compiler data.
$(_brownfield_gate_scope sast-sentinel)

Analyze the pre-computed evidence above and produce a structured JSON report covering:

1. TypeScript compiler diagnostics: Results are pre-injected as '## TypeScript Compiler Results'. Each 'error TS' line is a finding with severity 'major'.

2. Security pattern scan: Based on the Semgrep results injected above, classify findings:
   - ERROR/WARNING severity Semgrep findings → severity 'major' or 'blocker'
   - INFO severity findings → severity 'minor'
   - Patterns to flag if Semgrep missed them (text scan only, no tool calls):
     command injection, path traversal, hardcoded secrets, unsafe eval

3. Dependency CVE classification (npm audit results):
   - CVEs in RUNTIME dependencies (listed under "dependencies" in package.json) → severity 'blocker' if critical, 'major' if high
   - CVEs in DEV-ONLY dependencies (listed under "devDependencies" in package.json, e.g. vitest, esbuild, vite, typescript, tsup, eslint) → severity 'minor' regardless of CVSS score. Dev tools never run in production and their CVEs do not affect application security.
   - NEVER classify a dev-dependency CVE as 'blocker' or 'major'.

If the injected evidence is insufficient to determine a verdict with confidence, output \"verdict\": \"pass\" with 0 findings rather than fabricating a failure.

Output format (strict JSON, no markdown fences, no preamble):
{
  \"agent\": \"sast-sentinel\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"filesScanned\": N, \"findingsCount\": N, \"blockerCount\": N },
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"rule\": \"...\", \"file\": \"...\", \"line\": N, \"description\": \"...\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|fail\"
}"

        if [ -n "$sast_profile" ]; then
            sast_prompt="$sast_profile

$sast_prompt"
        fi

        # ── Semgrep Oracle: inject static analysis evidence before LLM invocation ──
        local semgrep_json="$LOG_DIR/semgrep-oracle-${phase_id}.json"
        local semgrep_summary=""
        if command -v semgrep > /dev/null 2>&1 && [ -d "$PROJECT_ROOT/src" ]; then
            set +e
            semgrep scan \
                --config=auto \
                --json \
                --quiet \
                --timeout=60 \
                --max-target-bytes=500000 \
                "$PROJECT_ROOT/src" \
                > "$semgrep_json" 2>/dev/null
            local _semgrep_rc=$?
            set -e
            if [ -f "$semgrep_json" ] && [ -s "$semgrep_json" ]; then
                semgrep_summary=$(python3 - "$semgrep_json" <<'PYEOF'
import sys, json
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    results = data.get("results", [])
    errors_count = len(data.get("errors", []))
    by_sev = {}
    for r in results:
        sev = r.get("extra", {}).get("severity", "INFO").upper()
        by_sev.setdefault(sev, []).append(r)
    lines = [f"totalFindings={len(results)}  scanErrors={errors_count}"]
    for sev in ("ERROR", "WARNING", "INFO"):
        items = by_sev.get(sev, [])
        if not items:
            continue
        lines.append(f"\n{sev} ({len(items)}):")
        for r in items[:10]:
            path = r.get("path", "?")
            line = r.get("start", {}).get("line", 0)
            rule = r.get("check_id", "?").split(".")[-1]
            msg  = r.get("extra", {}).get("message", "")[:120]
            lines.append(f"  [{rule}] {path}:{line} — {msg}")
        if len(items) > 10:
            lines.append(f"  ... and {len(items)-10} more {sev} findings")
    print("\n".join(lines))
except Exception as e:
    print(f"(semgrep parse error: {e})")
PYEOF
2>/dev/null || echo "(semgrep unavailable)")
            else
                semgrep_summary="(semgrep produced no output — exit code $_semgrep_rc)"
            fi
        else
            semgrep_summary="(semgrep oracle skipped — semgrep not in PATH or src/ missing)"
        fi

        sast_prompt="## Semgrep Static Analysis Results (hard evidence — treat as ground truth)
$semgrep_summary

$sast_prompt"

        # ── npm audit Oracle: inject dependency CVE evidence ──
        local audit_json="$LOG_DIR/npm-audit-oracle-${phase_id}.json"
        local audit_summary=""
        local _npm_bin
        _npm_bin=$(command -v npm 2>/dev/null || true)
        if [ -n "$_npm_bin" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
            set +e
            "$_npm_bin" audit --json --prefix "$PROJECT_ROOT" \
                > "$audit_json" 2>/dev/null
            local _audit_rc=$?
            set -e
            if [ -f "$audit_json" ] && [ -s "$audit_json" ]; then
                local _audit_py='
import sys, json
# Each package is tagged runtime / dev / transitive. The SAST prompt REQUIRES
# that classification (runtime high = major, dev-only = minor regardless of
# CVSS) but the evidence never carried it, so the agent could not comply. Live
# 2026-07-26 it said so and left 70 CVEs unclassified. This is a dictionary
# lookup, not a judgement — the pipeline should answer it, not delegate it.
runtime_deps, dev_deps = set(), set()
if len(sys.argv) > 2:
    try:
        with open(sys.argv[2]) as f:
            pkg = json.load(f)
        runtime_deps = set((pkg.get("dependencies") or {}).keys()) | set((pkg.get("optionalDependencies") or {}).keys())
        dev_deps = set((pkg.get("devDependencies") or {}).keys())
    except Exception:
        pass

def classify(name):
    if name in runtime_deps: return "runtime"
    if name in dev_deps: return "dev"
    if not runtime_deps and not dev_deps: return "unclassified"
    return "transitive"

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    vulns = data.get("vulnerabilities", {})
    meta  = data.get("metadata", {}).get("vulnerabilities", {})
    total      = sum(meta.values()) if meta else len(vulns)
    critical   = meta.get("critical", 0)
    high       = meta.get("high", 0)
    moderate   = meta.get("moderate", 0)
    low        = meta.get("low", 0)
    lines = [f"total={total}  critical={critical}  high={high}  moderate={moderate}  low={low}"]
    if runtime_deps or dev_deps:
        lines.append("  (each package tagged runtime|dev|transitive from package.json — apply the major/minor rule directly)")
    shown = 0
    for name, v in vulns.items():
        if shown >= 15:
            lines.append(f"  ... and {len(vulns)-shown} more packages")
            break
        sev  = v.get("severity", "?")
        via  = ", ".join(str(x.get("title", x) if isinstance(x, dict) else x)
                         for x in (v.get("via") or [])[:2])
        lines.append(f"  [{sev}] ({classify(name)}) {name}: {via[:100]}")
        shown += 1
    print("\n".join(lines))
except Exception as e:
    print(f"(audit parse error: {e})")
'
                audit_summary=$(echo "$_audit_py" | python3 - "$audit_json" "$PROJECT_ROOT/package.json" 2>/dev/null \
                    || echo "(audit parse error)")
            else
                audit_summary="(npm audit produced no output — exit code $_audit_rc)"
            fi
        else
            audit_summary="(npm audit skipped — npm not found or no package.json)"
        fi

        sast_prompt="## npm Audit Results (hard evidence — dependency CVEs)
$audit_summary

$sast_prompt"

        # ── TypeScript Oracle: run tsc in shell and inject results ──
        local tsc_summary=""
        local _tsc_node_bin
        _tsc_node_bin=$(detect_node 2>/dev/null || true)
        if [ -n "$_tsc_node_bin" ] && [ -f "$PROJECT_ROOT/node_modules/.bin/tsc" ]; then
            set +e
            local _tsc_out
            _tsc_out=$( cd "$PROJECT_ROOT" && "$_tsc_node_bin" ./node_modules/.bin/tsc --noEmit 2>&1 )
            local _tsc_rc=$?
            set -e

            # Deterministic self-heal for TS18003 ("No inputs were found") —
            # recurred 3x live (2026-07-08): spec-pass sometimes splits the
            # scaffold story so that NO child story ever creates a real source
            # file, leaving tsconfig.json's own include glob matching zero
            # files. This is 100% mechanically diagnosable (tsc says exactly
            # this) and mechanically fixable — no LLM judgment needed, so fix
            # it here instead of letting it fall through to SAST/remediation,
            # which already proved unable to ground a fix for a finding that
            # points at a config file no story owns. Fully generic: reads
            # tsconfig.json's OWN include patterns already on disk — no
            # hardcoded file names, no assumption beyond "this is a tsconfig.json".
            if [ $_tsc_rc -ne 0 ] && echo "$_tsc_out" | grep -q "error TS18003"; then
                local _placeholder_created=""
                _placeholder_created=$(python3 - "$PROJECT_ROOT" << 'PYEOF'
import json, os, re, glob, sys

project_root = sys.argv[1] if len(sys.argv) > 1 else "."
tsconfig_path = os.path.join(project_root, "tsconfig.json")
try:
    with open(tsconfig_path) as f:
        raw = f.read()
    raw_nocomments = re.sub(r'^\s*//.*$', '', raw, flags=re.MULTILINE)
    cfg = json.loads(raw_nocomments)
except Exception:
    print("")
    sys.exit(0)

includes = cfg.get("include") or []
if not includes:
    print("")
    sys.exit(0)

# Already has real inputs somewhere? Nothing to heal.
for pattern in includes:
    matches = [m for m in glob.glob(os.path.join(project_root, pattern), recursive=True) if os.path.isfile(m)]
    if matches:
        print("")
        sys.exit(0)

# Derive a placeholder path from the first include pattern's static (non-glob) prefix.
first_pattern = includes[0]
m = re.match(r'^([^*?{}\[\]]*)', first_pattern)
base = m.group(1) if m else ""
base_dir = os.path.dirname(os.path.join(project_root, base)) or project_root
if not base_dir.startswith(project_root):
    base_dir = project_root

os.makedirs(base_dir, exist_ok=True)
placeholder_path = os.path.join(base_dir, "index.ts")
if not os.path.exists(placeholder_path):
    with open(placeholder_path, "w") as f:
        f.write("export {};\n")
print(os.path.relpath(placeholder_path, project_root))
PYEOF
2>/dev/null || echo "")

                if [ -n "$_placeholder_created" ]; then
                    warning "  [scaffold-self-heal] tsconfig.json include glob matched zero files (TS18003) — created minimal placeholder: $_placeholder_created"
                    set +e
                    _tsc_out=$( cd "$PROJECT_ROOT" && "$_tsc_node_bin" ./node_modules/.bin/tsc --noEmit 2>&1 )
                    _tsc_rc=$?
                    set -e
                    if [ $_tsc_rc -eq 0 ]; then
                        success "  [scaffold-self-heal] tsc now passes after placeholder creation"
                        ( cd "$PROJECT_ROOT" && git add "$_placeholder_created" 2>/dev/null && \
                          git commit -m "chore(scaffold-self-heal): add placeholder ${_placeholder_created} so tsc has a real input" --quiet 2>/dev/null ) || true
                    else
                        warning "  [scaffold-self-heal] placeholder created but tsc still fails for other reasons — falling through to normal gate evaluation"
                    fi
                fi
            fi

            if [ $_tsc_rc -eq 0 ]; then
                local _src_count
                _src_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | wc -l || echo "?")
                tsc_summary="tsc: PASS (exit 0) — $_src_count .ts files checked, no errors"
            else
                # grep -c already prints "0" on zero matches while also exiting 1 —
                # `|| echo "?"` would double-print ("0\n?"), garbling this message.
                local _err_count
                _err_count=$(echo "$_tsc_out" | { grep -c "error TS" 2>/dev/null || true; })
                tsc_summary="tsc: FAIL (exit $_tsc_rc) — $_err_count error(s)
$(echo "$_tsc_out" | head -40)"
            fi
        else
            tsc_summary="(tsc oracle skipped — node or tsc binary not found at $PROJECT_ROOT)"
        fi

        sast_prompt="## TypeScript Compiler Results (hard evidence — treat as ground truth)
$tsc_summary

$sast_prompt"

        _run_qa_gate_with_retry "$sast_prompt" "qa-gate:sast" "${PHASE:-unknown}" "$sast_log"
    } &
    local sast_pid=$!
    _emit_agent start "sast-sentinel" "SAST Sentinel"

    # ── Spec Validator ──
    step_emit "22b" "running" "Step 22b: Spec validator"
    log "  Step 4.2b: Running spec validator..."
    {
        # ── Spec validator: implementation evidence oracle ──
        # Pre-inject git diff + key source files so the agent does NOT need tool
        # calls to examine the implementation. Without this, 7+ stories × ~3 file
        # reads per story exceeds the 20-iteration agent cap before a verdict is
        # written. Pattern mirrors review-ranger's oracle injection.
        local _spec_impl_evidence=""
        local _spec_git_bin
        _spec_git_bin=$(command -v git 2>/dev/null || true)
        if [ -n "$_spec_git_bin" ] && [ -d "$PROJECT_ROOT/.git" ]; then
            local _spec_baseline_sha=""
            [ -f "$LOG_DIR/phase-baseline-sha.txt" ] && \
                _spec_baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
            local _spec_diff_ref="${_spec_baseline_sha:+${_spec_baseline_sha}..HEAD}"
            _spec_diff_ref="${_spec_diff_ref:-HEAD~1}"
            set +e
            local _spec_diff_stat
            _spec_diff_stat=$(cd "$PROJECT_ROOT" && "$_spec_git_bin" diff --stat "$_spec_diff_ref" 2>/dev/null || echo "(no diff)")
            local _spec_diff_patch
            _spec_diff_patch=$(cd "$PROJECT_ROOT" && "$_spec_git_bin" diff -U2 "$_spec_diff_ref" -- '*.ts' '*.json' 2>/dev/null | head -400 || echo "")
            set -e
            # Also inject content of expected files listed in technicalNotes.files
            local _spec_file_excerpts=""
            _spec_file_excerpts=$(python3 - "$PRD_FILE" "$phase_id" "$PROJECT_ROOT" <<'PYEOF'
import sys, json, os
prd_path, phase_id, proj = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(prd_path) as f:
        prd = json.load(f)
    phase_ids = set(prd.get('implementationOrder', {}).get(phase_id, []))
    story_map = {s['id']: s for s in prd.get('stories', [])}
    out, total_lines = [], 0
    for sid in prd.get('implementationOrder', {}).get(phase_id, []):
        s = story_map.get(sid, {})
        tn = s.get('technicalNotes')
        files = tn.get('files', []) if isinstance(tn, dict) else []
        for rel in files[:3]:
            full = os.path.join(proj, rel)
            if not os.path.isfile(full):
                continue
            try:
                lines = open(full).readlines()
                excerpt = ''.join(lines[:80])
                out.append(f'\n### {rel} (first {min(80,len(lines))} lines)\n{excerpt}')
                total_lines += min(80, len(lines))
                if total_lines > 600:
                    out.append('\n(file evidence truncated — limit reached)')
                    break
            except Exception:
                pass
        if total_lines > 600:
            break
    print(''.join(out) if out else '(no expected files found in technicalNotes)')
except Exception as e:
    print(f'(file oracle error: {e})')
PYEOF
2>/dev/null || echo "(file oracle unavailable)")
            _spec_impl_evidence="## Implementation Evidence (pre-computed — do NOT call any tools)

### Git diff since phase start ($phase_id)
$_spec_diff_stat

TypeScript/JSON changes (first 400 lines):
$_spec_diff_patch

### Key implementation files (excerpts from technicalNotes.files)
$_spec_file_excerpts"
        else
            _spec_impl_evidence="## Implementation Evidence
(git oracle skipped — git not found or no .git directory; use untestable for ACs that cannot be verified from the story oracle alone)"
        fi

        local spec_prompt="You are acting as the spec-validator agent.
$(_brownfield_gate_scope spec-validator)

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

IMPORTANT: All evidence has been pre-injected below. Do NOT call any tools, ReadFile, or Bash commands. Classify each AC using ONLY the injected story oracle, test oracle, and implementation evidence.

For each story in the phase:
1. Use the pre-injected criteria from the Story Oracle section — it states which\n   kind the story is judged against. If it records none, you cannot report\n   compliance against an empty set: say so, do not pass.
2. Use the pre-injected git diff and file excerpts as implementation evidence
3. Classify each criterion as: met, partial, unmet, or untestable
   - untestable: evidence is insufficient to determine status — do NOT call tools to investigate further

Output format (strict JSON, no markdown fences, no preamble — emit directly as your final message, do NOT write to a file):
{
  \"agent\": \"spec-validator\",
  \"phase\": \"$phase_id\",
  \"stories\": [{
    \"storyId\": \"...\",
    \"title\": \"...\",
    \"criteria\": [{ \"text\": \"...\", \"status\": \"met|partial|unmet|untestable\", \"evidence\": \"...\", \"gaps\": \"...\" }],
    \"overallCompliance\": 85,
    \"verdict\": \"pass|warn|fail\"
  }],
  \"overallVerdict\": \"pass|warn|fail\"
}"

        if [ -n "$spec_profile" ]; then
            spec_prompt="$spec_profile

$spec_prompt"
        fi

        # ── Test Oracle: inject hard vitest evidence before LLM invocation ──
        local oracle_json="$LOG_DIR/vitest-oracle-${phase_id}.json"
        local oracle_summary=""
        local _node_bin
        _node_bin=$(detect_node 2>/dev/null || true)
        if [ -n "$_node_bin" ] && [ -f "$PROJECT_ROOT/package.json" ] && \
           [ -f "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
            set +e
            "$_node_bin" "$PROJECT_ROOT/node_modules/.bin/vitest" run \
                --reporter=json \
                --outputFile="$oracle_json" \
                --root "$PROJECT_ROOT" \
                > /dev/null 2>&1
            local _oracle_rc=$?
            set -e
            if [ -f "$oracle_json" ]; then
                oracle_summary=$(python3 - "$oracle_json" <<'PYEOF'
import sys, json
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    num_passed   = data.get("numPassedTests", 0)
    num_failed   = data.get("numFailedTests", 0)
    num_total    = data.get("numTotalTests", 0)
    num_skipped  = data.get("numPendingTests", 0)
    failed_names = []
    for suite in data.get("testResults", []):
        for t in suite.get("testResults", []):
            if t.get("status") == "failed":
                failed_names.append(t.get("fullName", t.get("title", "?")))
    lines = [
        f"numTotal={num_total}  numPassed={num_passed}  numFailed={num_failed}  numSkipped={num_skipped}"
    ]
    if failed_names:
        lines.append("Failed tests:")
        for n in failed_names[:20]:
            lines.append(f"  - {n}")
        if len(failed_names) > 20:
            lines.append(f"  ... and {len(failed_names)-20} more")
    print("\n".join(lines))
except Exception as e:
    print(f"(oracle parse error: {e})")
PYEOF
2>/dev/null || echo "(oracle unavailable)")
            else
                oracle_summary="(vitest ran but produced no JSON output — exit code $_oracle_rc)"
            fi
        else
            oracle_summary="(vitest oracle skipped — node or vitest binary not found)"
        fi

        spec_prompt="## Actual Test Results (hard evidence — use this as ground truth)
$oracle_summary

$spec_prompt"

        # ── Story Oracle: inject the criteria the story is JUDGED against ──
        # Not acceptanceCriteria specifically: brownfield stories carry
        # verificationCriteria, and run 8 scored 100% over an empty set because
        # this read the wrong field. lib/story_oracle.py decides and labels.
        local story_oracle=""
        story_oracle=$(python3 "$SCRIPT_DIR/lib/story_oracle.py" "$PRD_FILE" "$phase_id" \
            2>/dev/null || echo "(story oracle unavailable)")
        spec_prompt="## Story Criteria (hard evidence from prd.json — classify each criterion)
$story_oracle

$_spec_impl_evidence

$spec_prompt"

        _run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator" "${PHASE:-unknown}" "$spec_log"
    } &
    local spec_pid=$!
    _emit_agent start "spec-validator" "Spec Validator"

    # Wait for both agents
    wait $sast_pid || sast_exit=$?
    { [ $sast_exit -eq 0 ] && _emit_agent complete "sast-sentinel"; } || _emit_agent fail "sast-sentinel" "exit $sast_exit"
    wait $spec_pid || spec_exit=$?
    { [ $spec_exit -eq 0 ] && _emit_agent complete "spec-validator"; } || _emit_agent fail "spec-validator" "exit $spec_exit"

    local end_ts
    end_ts=$(date +%s%3N 2>/dev/null || date +%s)
    local duration_ms=$(( end_ts - start_ts ))

    # Evaluate results
    if [ $sast_exit -ne 0 ]; then
        error "  SAST sentinel FAILED (exit $sast_exit)"
        failed=1
    else
        # Check for blocker findings in SAST output.
        # Trust blockerCount from the oracle-injected evidence, not the LLM's self-reported verdict
        # field — the LLM defaults to "fail" when it can't run tools, even with 0 blockers.
        local _sast_blockers
        _sast_blockers=$(python3 -c "
import sys, json, re
try:
    text = open('$sast_log').read()
    parsed = None
    # Try full JSON parse
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            pass
    if parsed is not None:
        # Prefer summary.blockerCount
        summary_count = parsed.get('summary', {}).get('blockerCount', None)
        if summary_count is not None:
            print(summary_count)
        else:
            findings = parsed.get('findings', [])
            print(sum(1 for f in findings if str(f.get('severity','')).lower() == 'blocker'))
    else:
        # Malformed JSON — extract summary block directly (it appears before findings)
        sm = re.search(r'\"summary\"\s*:\s*\{([^}]*)\}', text, re.DOTALL)
        if sm:
            try:
                summary = json.loads('{' + sm.group(1) + '}')
                bc = summary.get('blockerCount', None)
                if bc is not None:
                    print(bc)
                    sys.exit(0)
            except Exception:
                pass
        # Last resort: count severity:blocker occurrences in raw text
        hits = len(re.findall(r'\"severity\"\s*:\s*\"blocker\"', text, re.IGNORECASE))
        print(hits)
except Exception:
    print(-1)
" 2>/dev/null || echo "-1")
        if [ "$_sast_blockers" = "-1" ]; then
            # Fallback: no parseable JSON — check raw verdict string
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$sast_log" 2>/dev/null; then
                step_emit "22a" "fail" "Step 22a: SAST sentinel"
                error "  SAST sentinel: FAIL verdict (could not parse blockerCount)"
                failed=1
                _failing_logs+=("$sast_log")
                _log_labels+=("sast-sentinel")
            else
                step_emit "22a" "warn" "Step 22a: SAST sentinel" "no parseable findings"
                success "  SAST sentinel: PASS (no parseable findings)"
            fi
        elif [ "$_sast_blockers" -gt 0 ]; then
            step_emit "22a" "fail" "Step 22a: SAST sentinel"
            error "  SAST sentinel: FAIL — $_sast_blockers blocker finding(s) detected"
            failed=1
            # sast_exit=0 here (agent exited clean) so the later exit-code check
            # in the remediation-log collector won't pick this up — add it
            # explicitly so the self-heal remediation pipeline actually fires
            # (same fix already applied to perf-sentinel below; this failure mode
            # — agent runs fine, content says fail — is the COMMON case, not the
            # exception, so skipping remediation for it defeated self-heal for
            # the majority of real testing-gate failures).
            _failing_logs+=("$sast_log")
            _log_labels+=("sast-sentinel")
        else
            step_emit "22a" "pass" "Step 22a: SAST sentinel"
            success "  SAST sentinel: PASS (blockerCount=$_sast_blockers)"
        fi
    fi

    if [ $spec_exit -ne 0 ]; then
        step_emit "22b" "fail" "Step 22b: Spec validator"
        error "  Spec validator FAILED (exit $spec_exit)"
        failed=1
    else
        # Check for actual failing stories, not just the top-level overallVerdict.
        # An empty stories[] with overallVerdict:fail means the agent had no data — treat as warn.
        local _spec_failing
        # BUG (found live, 2026-07-07): '$spec_log' was single-quoted — bash never
        # expanded it, so python3 received the literal 8-character string
        # "$spec_log" as sys.argv[1], not the real log path. open() then raised
        # FileNotFoundError every single time, caught by the blanket except and
        # mapped to the generic "no story data"/"error" path — meaning a REAL
        # spec-validator "fail" verdict (e.g. SKY-004 missing /search, /cheapest,
        # dashboard) was silently downgraded to a non-blocking warning on every
        # run, never once actually parsed. Fixed: double-quote so bash expands it.
        _spec_failing=$(python3 - "$spec_log" <<'SPEC_EXTRACTOR_PY'
import sys, re

# The spec-validator agent often emits JSON with unescaped newlines inside string
# values, making the output unparseable by json.loads regardless of extraction strategy.
# Use targeted line-level pattern matching instead — robust against malformed JSON.
try:
    text = open(sys.argv[1]).read()

    # Check the agent ran at all (must contain storyId references)
    if '"storyId"' not in text and '"stories"' not in text:
        print('no-json')
        sys.exit(0)

    if not re.search(r'"verdict"\s*:', text):
        print('no-data')
        sys.exit(0)

    # Grounding check (same principle already applied to fuzz-weaver/perf-sentinel):
    # a story's "fail" verdict is only trustworthy if the agent actually verified
    # SOMETHING about it. When every one of a story's criteria is self-reported
    # as "untestable" (the agent had no real evidence — e.g. it never actually
    # used its Read tool despite having access), that "fail" is a hallucinated
    # conclusion with nothing behind it, not a real finding. Slice the text by
    # story boundary (storyId occurrence) so each story's own verdict/criteria
    # are only matched against its OWN slice, not the whole document.
    story_starts = [m.start() for m in re.finditer(r'"storyId"\s*:\s*"[^"]*"', text)]
    grounded_failing = 0
    for i, start in enumerate(story_starts):
        end = story_starts[i + 1] if i + 1 < len(story_starts) else len(text)
        story_slice = text[start:end]
        if not re.search(r'"verdict"\s*:\s*"fail"', story_slice):
            continue
        statuses = re.findall(r'"status"\s*:\s*"(met|partial|unmet|untestable)"', story_slice)
        has_grounded_criterion = any(s != 'untestable' for s in statuses)
        if has_grounded_criterion:
            grounded_failing += 1
        # else: every criterion is untestable — ungrounded fail, don't count it

    # The overallVerdict line is a top-level field — distinct from per-story verdict
    overall_m = re.search(r'"overallVerdict"\s*:\s*"(\w+)"', text)
    overall = overall_m.group(1) if overall_m else None

    if grounded_failing > 0:
        print(grounded_failing)
    elif overall == 'warn':
        # Non-blocking partial — treat as 0 failures (warn path handled separately)
        print(0)
    else:
        print(0)
except Exception:
    print('error')
SPEC_EXTRACTOR_PY
2>/dev/null || echo "error")
        if [ "$_spec_failing" = "no-data" ] || [ "$_spec_failing" = "no-json" ] || [ "$_spec_failing" = "error" ]; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "no story data"
            warning "  Spec validator: WARN — agent returned no story data (oracle injection needed)"
        elif [ "$_spec_failing" -gt 0 ]; then
            step_emit "22b" "fail" "Step 22b: Spec validator"
            error "  Spec validator: FAIL — $_spec_failing story/stories failed criteria"
            failed=1
            # spec_exit=0 here (agent exited clean) — append explicitly so
            # self-heal remediation fires; see the SAST fix above for why.
            _failing_logs+=("$spec_log")
            _log_labels+=("spec-validator")
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"warn"' "$spec_log" 2>/dev/null; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "partial"
            warning "  Spec validator: WARN — some criteria partially met (non-blocking)"
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"fail"' "$spec_log" 2>/dev/null; then
            step_emit "22b" "warn" "Step 22b: Spec validator" "ungrounded findings downgraded"
            warning "  Spec validator: FAIL verdict downgraded to WARN — every criterion in every failing story was self-reported as 'untestable' (agent had no real evidence, likely didn't use its tools; re-check manually)"
        else
            step_emit "22b" "pass" "Step 22b: Spec validator"
            success "  Spec validator: PASS"
        fi
    fi

    # ── Phase B: review-ranger + mutant-hunter (parallel, only if Phase A passed) ──
    local review_exit=0
    local mutant_exit=0
    if [ $failed -eq 0 ]; then
        local review_log="$LOG_DIR/review-ranger-${phase_id}.log"
        local mutant_log="$LOG_DIR/mutant-hunter-${phase_id}.log"

        local review_profile=""
        local mutant_profile=""
        if [ -f "$profiles_file" ]; then
            review_profile=$(jq -r '.["review-ranger"] // ""' "$profiles_file")
            mutant_profile=$(jq -r '.["mutant-hunter"] // ""' "$profiles_file")
        fi

        # ── Review Ranger ──
        step_emit "22c" "running" "Step 22c: Review ranger"
        log "  Step 4.3a: Running review-ranger..."
        {
            # ── Git diff oracle: inject changed files and their content ──
            local review_diff_summary=""
            local _git_bin
            _git_bin=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                # Use the pre-story-loop baseline SHA when available so the diff
                # covers ALL commits from this run, not just the last one.
                local _baseline_sha=""
                if [ -f "$LOG_DIR/phase-baseline-sha.txt" ]; then
                    _baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
                fi
                local _diff_ref
                if [ -n "$_baseline_sha" ]; then
                    _diff_ref="${_baseline_sha}..HEAD"
                else
                    _diff_ref="HEAD~1"
                fi
                # Scope from the writers' output when the story loop recorded it
                # (lib/story-outputs.sh); the diff below stays as the fallback.
                # shellcheck disable=SC1090
                [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
                local _diff_files
                _diff_files=$(story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null || echo "")
                [ -z "$_diff_files" ] && \
                    _diff_files=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --name-only "$_diff_ref" 2>/dev/null || echo "")
                local _diff_stat
                _diff_stat=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --stat "$_diff_ref" 2>/dev/null || echo "(no diff available)")
                local _diff_patch
                _diff_patch=$(cd "$PROJECT_ROOT" && "$_git_bin" diff -U3 "$_diff_ref" -- '*.ts' 2>/dev/null | head -300 || echo "")
                set -e
                review_diff_summary="Files changed:
$_diff_stat

TypeScript diff (first 300 lines):
$_diff_patch"
            else
                review_diff_summary="(git diff oracle skipped — git not found or no .git directory)"
            fi

            local review_prompt="You are acting as the review-ranger agent.

Phase: $phase_id
Project root: $PROJECT_ROOT

IMPORTANT: All evidence has been pre-computed and is injected below. Do NOT attempt to call any shell commands, bash, or tools. Analyze ONLY the injected git diff data.
$(_brownfield_gate_scope review-ranger)

## Git Diff Evidence (hard evidence — treat as ground truth)
$review_diff_summary

Analyze the pre-computed diff above and produce a structured JSON report covering:
1. Complexity hotspots (cyclomatic complexity > 10, nesting > 4)
2. Code duplication (near-identical blocks > 5 lines)
3. API contract drift (exported signature changes without test updates)
4. Error handling completeness (swallowed errors in critical paths)
5. Test coverage gaps (new public functions without tests)
6. Naming consistency (camelCase vars, PascalCase types, UPPER_SNAKE constants)

If the injected evidence is insufficient to determine a verdict with confidence, output \"verdict\": \"pass\" with 0 findings rather than fabricating a failure.

Output format (strict JSON, no markdown fences, no preamble):
{
  \"agent\": \"review-ranger\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"filesReviewed\": N, \"findingsCount\": N, \"blockerCount\": N, \"majorCount\": N, \"minorCount\": N },
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"category\": \"...\", \"file\": \"...\", \"line\": N, \"codeSnippet\": \"<the EXACT line(s) from the file that show the problem, copied verbatim — required for any blocker-severity finding, or it will be treated as unverified>\", \"description\": \"...\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|fail\"
}"

            if [ -n "$review_profile" ]; then
                review_prompt="$review_profile

$review_prompt"
            fi

            _run_qa_gate_with_retry "$review_prompt" "qa-gate:review-ranger" "${PHASE:-unknown}" "$review_log"
        } &
        local review_pid=$!
        _emit_agent start "review-ranger" "Review Ranger"

        # ── Mutant Hunter ──
        step_emit "22d" "running" "Step 22d: Mutant hunter"
        log "  Step 4.3b: Running mutant-hunter..."
        {
            # ── Source + test oracle: inject changed files and test files ──
            local mutant_oracle_summary=""
            local _git_bin2
            _git_bin2=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin2" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                # Use the same pre-story baseline SHA as review-ranger for consistency.
                local _mut_baseline_sha=""
                if [ -f "$LOG_DIR/phase-baseline-sha.txt" ]; then
                    _mut_baseline_sha=$(cat "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')
                fi
                local _mut_diff_ref
                if [ -n "$_mut_baseline_sha" ]; then
                    _mut_diff_ref="${_mut_baseline_sha}..HEAD"
                else
                    _mut_diff_ref="HEAD~1"
                fi
                # shellcheck disable=SC1090
                [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
                local _changed_src
                _changed_src=$(story_outputs_sources "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | \
                               grep -E '\.ts$' | head -10 || echo "")
                [ -z "$_changed_src" ] && \
                    _changed_src=$(cd "$PROJECT_ROOT" && "$_git_bin2" diff --name-only "$_mut_diff_ref" -- '*.ts' 2>/dev/null | \
                                   grep -v '\.test\.ts$' | head -10 || echo "")
                set -e
                local _src_content=""
                if [ -n "$_changed_src" ]; then
                    while IFS= read -r _f; do
                        [ -f "$PROJECT_ROOT/$_f" ] || continue
                        local _mut_src_total_lines _mut_src_marker=""
                        _mut_src_total_lines=$(wc -l < "$PROJECT_ROOT/$_f" 2>/dev/null || echo 0)
                        # Full agent audit, 2026-07-31: this excerpt was silently
                        # capped with no signal to the agent, unlike review-ranger's
                        # diff injection (which appends a "[TRUNCATED...]" marker
                        # when its own cap is hit). A file longer than 100 lines
                        # was invisible past that point with no indication anything
                        # was cut — the agent could confidently judge mutations
                        # against a partial file and never know it.
                        if [ "${_mut_src_total_lines:-0}" -gt 100 ]; then
                            _mut_src_marker="
[TRUNCATED — ${_mut_src_total_lines} total lines, showing first 100. Do not assume the omitted tail is unmutated.]"
                        fi
                        _src_content="$_src_content
--- $_f ---
$(head -100 "$PROJECT_ROOT/$_f" 2>/dev/null || echo '(unreadable)')${_mut_src_marker}"
                    done <<< "$_changed_src"
                fi
                # The tests to judge are THIS RUN'S tests. This used to be
                # `find -name "*.test.ts"` over the whole tree, which (a) picked
                # arbitrary unrelated tests when it matched and (b) matched
                # NOTHING on a codeline whose tests are named `.spec.ts` — as
                # the live metrolinx one is. It reported "(no test files found)"
                # on a run that had just written a reproducing spec, so the
                # mutation oracle judged the change against no tests at all.
                local _test_files
                _test_files=$(story_outputs_tests "$PROJECT_ROOT" "$LOG_DIR" 2>/dev/null | \
                              sed "s#^#$PROJECT_ROOT/#" | head -5 || echo "")
                [ -z "$_test_files" ] && \
                    _test_files=$(find "$PROJECT_ROOT" \( -name "*.test.ts" -o -name "*.spec.ts" \) \
                                       -not -path "*/node_modules/*" 2>/dev/null | head -5)
                local _test_content=""
                while IFS= read -r _tf; do
                    [ -f "$_tf" ] || continue
                    local _mut_test_total_lines _mut_test_marker=""
                    _mut_test_total_lines=$(wc -l < "$_tf" 2>/dev/null || echo 0)
                    if [ "${_mut_test_total_lines:-0}" -gt 60 ]; then
                        _mut_test_marker="
[TRUNCATED — ${_mut_test_total_lines} total lines, showing first 60. Do not assume the omitted tail has no assertions.]"
                    fi
                    _test_content="$_test_content
--- $_tf ---
$(head -60 "$_tf" 2>/dev/null || echo '(unreadable)')${_mut_test_marker}"
                done <<< "$_test_files"
                mutant_oracle_summary="Changed source files:
${_src_content:-  (none — no TypeScript source changes in this phase)}

Existing test files (first 60 lines each):
${_test_content:-  (no test files found)}"
            else
                mutant_oracle_summary="(mutation oracle skipped — git not found or no .git directory)"
            fi

            local mutant_prompt="You are acting as the mutant-hunter agent.

Phase: $phase_id
Project root: $PROJECT_ROOT

IMPORTANT: All evidence has been pre-computed and is injected below. Do NOT attempt to call any shell commands, bash, or tools. Analyze ONLY the injected source and test file data.
$(_brownfield_gate_scope mutant-hunter)

## Source and Test Evidence (hard evidence — treat as ground truth)
$mutant_oracle_summary

Analyze the pre-computed source and test code above. For each changed source file:
1. Propose mutations: operator swaps, comparison inversions, boolean negations,
   early returns, boundary shifts, removed null checks, swapped arguments
2. For each mutation, determine if the existing tests shown above would catch it
3. Focus on critical paths: provider failover, tool safety, auth, billing, agent state

If no source changes are detected or evidence is insufficient, output \"verdict\": \"warn\" with mutationScore of 100 and 0 mutations (non-blocking — nothing to test).

Output format (strict JSON, no markdown fences, no preamble):
{
  \"agent\": \"mutant-hunter\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"mutationsProposed\": N, \"killed\": N, \"survived\": N, \"noCoverage\": N, \"mutationScore\": 75 },
  \"mutations\": [{ \"file\": \"...\", \"line\": N, \"originalCode\": \"<the EXACT line(s) from the file being mutated, copied verbatim — required for any status:survived mutation, or it will be treated as unverified>\", \"mutatedCode\": \"...\", \"status\": \"killed|survived|no-coverage\", \"relatedTest\": \"...\", \"recommendation\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}
The summary.survived count MUST equal the number of status:survived entries in the mutations array — they describe the same thing and must agree."

            if [ -n "$mutant_profile" ]; then
                mutant_prompt="$mutant_profile

$mutant_prompt"
            fi

            _run_qa_gate_with_retry "$mutant_prompt" "qa-gate:mutant-hunter" "${PHASE:-unknown}" "$mutant_log"
        } &
        local mutant_pid=$!
        _emit_agent start "mutant-hunter" "Mutant Hunter"

        # Wait for both Phase B agents
        wait $review_pid || review_exit=$?
        { [ $review_exit -eq 0 ] && _emit_agent complete "review-ranger"; } || _emit_agent fail "review-ranger" "exit $review_exit"
        wait $mutant_pid || mutant_exit=$?
        { [ $mutant_exit -eq 0 ] && _emit_agent complete "mutant-hunter"; } || _emit_agent fail "mutant-hunter" "exit $mutant_exit"

        # Evaluate Phase B results
        if [ $review_exit -ne 0 ]; then
            step_emit "22c" "fail" "Step 22c: Review ranger"
            error "  Review-ranger FAILED (exit $review_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$review_log" 2>/dev/null; then
                # Full agent audit re-audit, 2026-07-31: this used to trust a bare
                # self-reported "verdict":"fail" with NO check that any named
                # file:line actually exists — unlike sast-sentinel (real
                # Semgrep/tsc/npm-audit oracle) or perf-sentinel (codeSnippet
                # verified against the real file). An agent could cite a
                # plausible but fabricated file:line and still block the
                # pipeline. Same "quote it, then verify the quote" pattern now
                # applied here: require at least one blocker finding whose
                # codeSnippet is a literal substring of the real file on disk.
                _review_grounded=$(python3 - "$review_log" "$PROJECT_ROOT" << 'REVIEW_PYEOF'
import json, sys, re, os

log_file, project_root = sys.argv[1], sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"review-ranger".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

findings = data.get("findings", [])
grounded = 0
for f in findings:
    if str(f.get("severity", "")).lower() != "blocker":
        continue
    file_rel = f.get("file", "")
    snippet = (f.get("codeSnippet") or "").strip()
    if not file_rel or not snippet:
        continue
    file_path = file_rel if os.path.isabs(file_rel) else os.path.join(project_root, file_rel)
    try:
        with open(file_path) as fh:
            real_content = fh.read()
    except Exception:
        continue
    if snippet in real_content:
        grounded = 1
        break

print(str(grounded))
REVIEW_PYEOF
2>/dev/null || echo "0")
                if [ "${_review_grounded:-0}" -gt 0 ]; then
                    step_emit "22c" "fail" "Step 22c: Review ranger"
                    error "  Review-ranger: FAIL — confirmed blocker (codeSnippet verified against the real file)"
                    failed=1
                    # review_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$review_log")
                    _log_labels+=("review-ranger")
                else
                    step_emit "22c" "warn" "Step 22c: Review ranger" "unverified findings downgraded"
                    warning "  Review-ranger: FAIL verdict downgraded to WARN — no blocker finding's codeSnippet could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$review_log" 2>/dev/null; then
                step_emit "22c" "warn" "Step 22c: Review ranger" "non-blocking findings"
                warning "  Review-ranger: WARN — non-blocking findings (continuing)"
            else
                step_emit "22c" "pass" "Step 22c: Review ranger"
                success "  Review-ranger: PASS"
            fi
        fi

        if [ $mutant_exit -ne 0 ]; then
            step_emit "22d" "fail" "Step 22d: Mutant hunter"
            error "  Mutant-hunter FAILED (exit $mutant_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$mutant_log" 2>/dev/null; then
                # Full agent audit re-audit, 2026-07-31: mutationScore/survived
                # counts were entirely self-reported with zero independent
                # verification — an agent could report a low score with no
                # basis in its own listed mutations and still block the
                # pipeline. Now requires: (1) summary.survived agrees with the
                # actual count of status:survived entries in the mutations
                # array (self-consistency — catches a score disconnected from
                # its own detail), AND (2) at least one survived mutation's
                # originalCode is a literal substring of the real file on disk
                # (catches a fabricated file/line/code claim, same "quote it,
                # verify it" pattern as review-ranger/perf-sentinel).
                _mutant_grounded=$(python3 - "$mutant_log" "$PROJECT_ROOT" << 'MUTANT_PYEOF'
import json, sys, re, os

log_file, project_root = sys.argv[1], sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"mutant-hunter".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

summary = data.get("summary") or {}
mutations = data.get("mutations", [])
survived = [m for m in mutations if str(m.get("status", "")).lower() == "survived"]

# Self-consistency: the aggregate score must agree with the model's own detail.
if summary.get("survived", -1) != len(survived):
    print("0"); sys.exit(0)

grounded = 0
for m in survived:
    file_rel = m.get("file", "")
    snippet = (m.get("originalCode") or "").strip()
    if not file_rel or not snippet:
        continue
    file_path = file_rel if os.path.isabs(file_rel) else os.path.join(project_root, file_rel)
    try:
        with open(file_path) as fh:
            real_content = fh.read()
    except Exception:
        continue
    if snippet in real_content:
        grounded = 1
        break

print(str(grounded))
MUTANT_PYEOF
2>/dev/null || echo "0")
                if [ "${_mutant_grounded:-0}" -gt 0 ]; then
                    step_emit "22d" "fail" "Step 22d: Mutant hunter"
                    error "  Mutant-hunter: FAIL — confirmed surviving mutation (originalCode verified against the real file, survived count self-consistent)"
                    failed=1
                    # mutant_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$mutant_log")
                    _log_labels+=("mutant-hunter")
                else
                    step_emit "22d" "warn" "Step 22d: Mutant hunter" "unverified findings downgraded"
                    warning "  Mutant-hunter: FAIL verdict downgraded to WARN — survived count disagreed with its own mutations detail, or no surviving mutation's originalCode could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$mutant_log" 2>/dev/null; then
                step_emit "22d" "warn" "Step 22d: Mutant hunter" "score 50-69%"
                warning "  Mutant-hunter: WARN — mutation score 50-69% (non-blocking)"
            else
                step_emit "22d" "pass" "Step 22d: Mutant hunter"
                success "  Mutant-hunter: PASS"
            fi
        fi
    else
        step_emit "22c" "skip" "Step 22c: Review ranger" "Phase A failed"
        step_emit "22d" "skip" "Step 22d: Mutant hunter" "Phase A failed"
        info "  Phase B (review-ranger + mutant-hunter) skipped — Phase A had failures"
    fi

    # ── Phase C: fuzz-weaver + perf-sentinel (parallel, only if A+B passed) ──
    local fuzz_exit=0
    local perf_exit=0
    if [ $failed -eq 0 ]; then
        local fuzz_log="$LOG_DIR/fuzz-weaver-${phase_id}.log"
        local perf_log="$LOG_DIR/perf-sentinel-${phase_id}.log"

        local fuzz_profile=""
        local perf_profile=""
        if [ -f "$profiles_file" ]; then
            fuzz_profile=$(jq -r '.["fuzz-weaver"] // ""' "$profiles_file")
            perf_profile=$(jq -r '.["perf-sentinel"] // ""' "$profiles_file")
        fi

        # ── Fuzz Weaver ──
        step_emit "22e" "running" "Step 22e: Fuzz-weaver"
        log "  Step 4.4a: Running fuzz-weaver..."
        {
            local fuzz_prompt="You are acting as the fuzz-weaver agent.
$(_brownfield_gate_scope fuzz-weaver)

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Perform property-based / fuzz testing analysis on changed files in this phase.
Use git diff to identify changed source files, then for each public function:
1. Derive input domains from TypeScript parameter types
2. Propose fuzz test cases with fast-check style property definitions
3. Assess whether existing tests cover each edge case

Focus on: config parsing, provider request construction, billing calculations,
tool input validation (path traversal, shell metacharacters), auth token parsing.

For any case with status=\"vulnerability\", you MAY include an optional
\"executableTest\" field: a vitest test skeleton (as a single string) showing
the import path and the assertion that SHOULD pass if the code is correct —
e.g. \`import { parseAdults } from '../src/server'; expect(parseAdults('0')).toBeNull()\`.
IMPORTANT: Do NOT run or execute any tests. Do NOT use Bash to run vitest or
any test runner. Write the test structure only — it will be reviewed by a
human. A vulnerability claim is valid without an executableTest; do not spend
time executing code to verify findings.

Output format (strict JSON, no markdown fences, no preamble — emit directly as your final message, do NOT write to a file):
{
  \"agent\": \"fuzz-weaver\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"functionsAnalysed\": N, \"fuzzCasesProposed\": N, \"covered\": N, \"gaps\": N, \"vulnerabilities\": N },
  \"cases\": [{ \"function\": \"...\", \"file\": \"...\", \"line\": N, \"property\": \"...\", \"generator\": \"...\", \"invariant\": \"...\", \"status\": \"covered|gap|vulnerability\", \"recommendation\": \"...\", \"executableTest\": \"...(only when status=vulnerability)...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$fuzz_profile" ]; then
                fuzz_prompt="$fuzz_profile

$fuzz_prompt"
            fi

            _run_qa_gate_with_retry "$fuzz_prompt" "qa-gate:fuzz-weaver" "${PHASE:-unknown}" "$fuzz_log"
        } &
        local fuzz_pid=$!
        _emit_agent start "fuzz-weaver" "Fuzz Weaver"

        # ── Perf Sentinel ──
        step_emit "22f" "running" "Step 22f: Perf sentinel"
        log "  Step 4.4b: Running perf-sentinel..."
        {
            local perf_prompt="You are acting as the perf-sentinel agent.
$(_brownfield_gate_scope perf-sentinel)

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Perform performance analysis on files changed in this phase.
Use git diff to identify changed source files, then analyse:
1. Algorithmic complexity (flag O(n²)+ on unbounded inputs)
2. Memory allocation hotspots (object creation in loops, unbounded caches)
3. Async performance (sequential awaits → Promise.all, missing timeouts, stream backpressure)
4. Startup time impact (heavy imports, sync I/O at module load)
5. Provider-specific (unnecessary Message[] copies, redundant token counting)

Output format (strict JSON, no markdown fences, no preamble — emit directly as your final message, do NOT write to a file):
{
  \"agent\": \"perf-sentinel\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"filesAnalysed\": N, \"findingsCount\": N, \"blockerCount\": N, \"estimatedStartupImpactMs\": N },
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"category\": \"complexity|memory|async|startup|provider\", \"file\": \"...\", \"line\": N, \"codeSnippet\": \"<the EXACT line(s) from the file that show the problem, copied verbatim — required for any blocker-severity finding, or it will be treated as unverified>\", \"description\": \"...\", \"estimatedImpact\": \"high|medium|low\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$perf_profile" ]; then
                perf_prompt="$perf_profile

$perf_prompt"
            fi

            _run_qa_gate_with_retry "$perf_prompt" "qa-gate:perf-sentinel" "${PHASE:-unknown}" "$perf_log"
        } &
        local perf_pid=$!
        _emit_agent start "perf-sentinel" "Perf Sentinel"

        # Wait for both Phase C agents
        wait $fuzz_pid || fuzz_exit=$?
        { [ $fuzz_exit -eq 0 ] && _emit_agent complete "fuzz-weaver"; } || _emit_agent fail "fuzz-weaver" "exit $fuzz_exit"
        wait $perf_pid || perf_exit=$?
        { [ $perf_exit -eq 0 ] && _emit_agent complete "perf-sentinel"; } || _emit_agent fail "perf-sentinel" "exit $perf_exit"

        # Evaluate Phase C results
        # Fuzz-weaver: validate that any "fail" verdict is grounded in real files.
        # An agent with no tool access will hallucinate findings about non-existent files.
        # We downgrade "fail" to "warn" when no vulnerability finding references a file
        # that actually exists under PROJECT_ROOT/src.
        if [ $fuzz_exit -ne 0 ]; then
            # exit 1 means _run_qa_gate_with_retry exhausted all retries with no
            # structured output — the model produced nothing parseable. Treat as
            # non-blocking warn: a gate that couldn't run is NOT a confirmed failure.
            # Only a grounded "verdict":"fail" in the log (exit 0 path below) blocks.
            warning "  Fuzz-weaver: no structured output after all retries — treating as non-blocking warn"
            fuzz_exit=0
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$fuzz_log" 2>/dev/null; then
                # Ground-truth check, two layers:
                #  1. File-exists — same as before, catches claims about non-existent files.
                #  2. Executable-evidence — a claim referencing a REAL file can still be
                #     wrong about that file's actual behavior (e.g. misreading a regex).
                #     Each vulnerability case must supply an "executableTest" (a real vitest
                #     test the agent wrote asserting the SAFE/expected behavior); we actually
                #     RUN it against the real code. If the assertion FAILS, the code really
                #     doesn't behave safely — the vulnerability is confirmed. If it PASSES,
                #     the code was already correct and the claim was a hallucination. Cases
                #     with no executableTest (or where vitest isn't available) are treated
                #     as unverified and do not block the gate — this only counts claims that
                #     were actually demonstrated against the real source, not merely asserted.
                local _node_bin
                _node_bin=$(detect_node 2>/dev/null || true)
                _fuzz_grounded=$(python3 - "$fuzz_log" "$PROJECT_ROOT" "${_node_bin:-}" << 'PYEOF'
import json, sys, os, re, subprocess, shutil

log_file, project_root, node_bin = sys.argv[1], sys.argv[2], sys.argv[3]

# Extract JSON from the log (agent may emit preamble text)
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"fuzz-weaver".*\}', content, re.DOTALL)
if not json_match:
    print("0")
    sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0")
    sys.exit(0)

verify_dir = os.path.join(project_root, ".fuzz-verify")
os.makedirs(verify_dir, exist_ok=True)
vitest_bin = os.path.join(project_root, "node_modules", ".bin", "vitest")
can_run = bool(node_bin) and os.path.exists(vitest_bin)

confirmed = 0
for i, case in enumerate(data.get("cases", [])):
    if case.get("status") != "vulnerability":
        continue
    f = case.get("file", "")
    candidates = [
        f,
        os.path.join(project_root, f),
        os.path.join(project_root, "src", os.path.basename(f)),
    ]
    if not any(os.path.exists(p) for p in candidates):
        continue  # unverifiable file reference — likely hallucinated, skip

    test_src = case.get("executableTest", "")
    if not test_src or not can_run:
        continue  # no executable evidence supplied — do not block on an unverified claim

    # One file at a time in verify_dir: vitest's path argument is a filter,
    # not a hard restriction, so a leftover file from a PREVIOUS case would
    # get swept into THIS case's run and could contaminate the result.
    test_path = os.path.join(verify_dir, f"case-{i}.test.ts")
    try:
        with open(test_path, "w") as tf:
            tf.write(test_src)
        result = subprocess.run(
            [node_bin, vitest_bin, "run", test_path, "--reporter=json"],
            cwd=project_root, capture_output=True, text=True, timeout=60,
        )
        # A nonzero exit code alone doesn't distinguish "assertion genuinely
        # failed" from "syntax/transform error, zero tests ever ran" — both
        # exit nonzero. Only a REAL assertion failure (numFailedTests > 0,
        # meaning at least one test actually executed and failed) counts as
        # confirmation; a test that never ran proves nothing about the code.
        try:
            report = json.loads(result.stdout)
            if report.get("numFailedTests", 0) > 0:
                confirmed += 1
        except Exception:
            pass  # no parseable report — unverified, don't block
    except Exception:
        continue  # test didn't even run (timeout, etc.) — unverified, don't block
    finally:
        try:
            os.remove(test_path)
        except OSError:
            pass

shutil.rmtree(verify_dir, ignore_errors=True)
print(str(confirmed))
PYEOF
2>/dev/null || echo "0")
                if [ "${_fuzz_grounded:-0}" -gt 0 ]; then
                    step_emit "22e" "fail" "Step 22e: Fuzz-weaver"
                    error "  Fuzz-weaver: FAIL — ${_fuzz_grounded} confirmed vulnerability/vulnerabilities (verified by actually running the agent's own test against the real code)"
                    failed=1
                    # fuzz_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$fuzz_log")
                    _log_labels+=("fuzz-weaver")
                else
                    step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "unverified findings downgraded"
                    warning "  Fuzz-weaver: FAIL verdict downgraded to WARN — no vulnerability finding could be verified by executing a real test against the real code (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$fuzz_log" 2>/dev/null; then
                step_emit "22e" "warn" "Step 22e: Fuzz-weaver" "gaps>30%"
            warning "  Fuzz-weaver: WARN — coverage gaps > 30% (non-blocking)"
            else
                step_emit "22e" "pass" "Step 22e: Fuzz-weaver"
                success "  Fuzz-weaver: PASS"
            fi
        fi

        if [ $perf_exit -ne 0 ]; then
            # exit 1 means _run_qa_gate_with_retry exhausted all retries with no
            # structured output — the model produced nothing parseable. Treat as
            # non-blocking warn: a gate that couldn't run is NOT a confirmed failure.
            # Only a grounded "verdict":"fail" in the log (exit 0 path below) blocks.
            step_emit "22f" "warn" "Step 22f: Perf sentinel" "no structured output — non-blocking warn"
            warning "  Perf-sentinel: no structured output after all retries — treating as non-blocking warn"
            perf_exit=0
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$perf_log" 2>/dev/null; then
                # Ground-truth check: a "fail" is only valid if the agent found real blocker
                # findings. An agent with no tool access reports verdict:fail with empty findings
                # and null/zero summary — downgrade these hallucinated fails to WARN.
                # Full agent audit, 2026-07-31: the old check only verified the
                # agent's OWN summary numbers were internally self-consistent
                # (blockerCount>0 and filesAnalysed>0/blockerCount>0) — never
                # confirmed the claimed hotspot actually exists in the named
                # file at the named line. An agent could hallucinate a
                # self-consistent blocker and it would pass grounding and
                # block a clean pipeline. Now requires, for at least one
                # blocker finding: the referenced file exists on disk AND its
                # codeSnippet is a literal substring of that file's real
                # content — same "quote it, then we verify the quote"
                # pattern already used for the code-graph-detective's
                # brokenLine field.
                _perf_grounded=$(python3 - "$perf_log" "$PROJECT_ROOT" << 'PERF_PYEOF'
import json, sys, re, os

log_file, project_root = sys.argv[1], sys.argv[2]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"perf-sentinel".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

findings = data.get("findings", [])
grounded = 0
for f in findings:
    if str(f.get("severity", "")).lower() != "blocker":
        continue
    file_rel = f.get("file", "")
    snippet = (f.get("codeSnippet") or "").strip()
    if not file_rel or not snippet:
        continue
    file_path = file_rel if os.path.isabs(file_rel) else os.path.join(project_root, file_rel)
    try:
        with open(file_path) as fh:
            real_content = fh.read()
    except Exception:
        continue
    if snippet in real_content:
        grounded = 1
        break

print(str(grounded))
PERF_PYEOF
2>/dev/null || echo "0")
                if [ "${_perf_grounded:-0}" -gt 0 ]; then
                    step_emit "22f" "fail" "Step 22f: Perf sentinel"
                    error "  Perf-sentinel: FAIL — confirmed performance blocker (codeSnippet verified against the real file)"
                    failed=1
                    # perf_exit=0 here (agent exited clean) so _failing_logs won't pick it up
                    # via the exit-code check below — add it explicitly so remediation fires.
                    _failing_logs+=("$perf_log")
                    _log_labels+=("perf-sentinel")
                else
                    step_emit "22f" "warn" "Step 22f: Perf sentinel" "unverified findings downgraded"
                    warning "  Perf-sentinel: FAIL verdict downgraded to WARN — no blocker finding's codeSnippet could be verified against the real file (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$perf_log" 2>/dev/null; then
                step_emit "22f" "warn" "Step 22f: Perf sentinel" "concerns non-blocking"
                warning "  Perf-sentinel: WARN — performance concerns (non-blocking)"
            else
                step_emit "22f" "pass" "Step 22f: Perf sentinel"
                success "  Perf-sentinel: PASS"
            fi
        fi
    else
        step_emit "22e" "skip" "Step 22e: Fuzz-weaver" "Phase A/B failed"
step_emit "22f" "skip" "Step 22f: Perf sentinel" "Phase A/B failed"
        info "  Phase C (fuzz-weaver + perf-sentinel) skipped — earlier phases had failures"
    fi

    # ── Step 4.6: Browser E2E routing execution (Lightpanda / Playwright) ──
    if [ $failed -eq 0 ]; then
        run_browser_e2e_routing
    else
        info "  Step 4.6: Skipped — earlier testing phases failed"
    fi

    # Recalculate duration to include all phases
    end_ts=$(date +%s%3N 2>/dev/null || date +%s)
    duration_ms=$(( end_ts - start_ts ))

    # Log gate result to JSONL
    local verdict="pass"
    [ $failed -ne 0 ] && verdict="fail"
    echo "{\"timestamp\":\"$(date -Iseconds)\",\"phase_id\":\"$phase_id\",\"event\":\"testing_gate\",\"sast_exit\":$sast_exit,\"spec_exit\":$spec_exit,\"review_exit\":$review_exit,\"mutant_exit\":$mutant_exit,\"fuzz_exit\":$fuzz_exit,\"perf_exit\":$perf_exit,\"verdict\":\"$verdict\",\"duration_ms\":$duration_ms,\"routingDecision\":\"$routing_decision\",\"routingReason\":\"$routing_reason\",\"forceLightpanda\":$force_lightpanda,\"forcePlaywright\":$force_playwright,\"e2eRouteRuns\":$e2e_route_runs,\"e2eRouteLightpanda\":$e2e_route_lightpanda,\"e2eRoutePlaywright\":$e2e_route_playwright,\"e2eRouteFailures\":$e2e_route_failed}" >> "$gate_jsonl"

    echo "=== Testing Gate Result: $([ $failed -eq 0 ] && echo PASS || echo FAIL) ===" >> "$gate_log"

    "$SCRIPT_DIR/update-monitor.sh" event "testing_gate_${verdict}" \
        "Testing gates $verdict for $phase_id (${duration_ms}ms)" "" "main" "test-coordinator-agent" 2>/dev/null || true

    if [ $failed -ne 0 ]; then
        # ── Self-healing: three-agent pipeline feeds gate findings back into PRD + profiles ──
        # Agent 1 (gate-finding-analyst):  extracts grounded structured finding from gate log
        # Agent 2 (story-ac-remediator):   augments the owning story's ACs in PRD
        # Agent 3 (profile-augmentor):     appends novel anti-pattern to the relevant profile

        # Collect all failing gate logs for this phase. _failing_logs/_log_labels
        # were already declared at the top of this function (not re-declared here
        # with `local`, which would wipe the content-based-failure appends made
        # during each gate's own evaluation above) — this only adds the
        # complementary case of a genuine agent-process crash (exit code != 0),
        # which is mutually exclusive with the content-based appends since those
        # only run in the exit-code-0 branch.
        [ "${sast_exit:-0}"   -ne 0 ] && _failing_logs+=("$sast_log")   && _log_labels+=("sast-sentinel")
        [ "${spec_exit:-0}"   -ne 0 ] && _failing_logs+=("$spec_log")   && _log_labels+=("spec-validator")
        [ "${review_exit:-0}" -ne 0 ] && _failing_logs+=("$review_log") && _log_labels+=("review-ranger")
        [ "${mutant_exit:-0}" -ne 0 ] && _failing_logs+=("$mutant_log") && _log_labels+=("mutant-hunter")
        [ "${fuzz_exit:-0}"   -ne 0 ] && _failing_logs+=("$fuzz_log")   && _log_labels+=("fuzz-weaver")
        [ "${perf_exit:-0}"   -ne 0 ] && _failing_logs+=("$perf_log")   && _log_labels+=("perf-sentinel")

        local _profiles_file="${AUTOMATION_DIR}/agents/profiles.json"

        if ! is_truthy "${SKIP_GATE_REMEDIATION:-}" && [ ${#_failing_logs[@]} -gt 0 ]; then
            warning "Step 4.2: Testing gates FAILED — running self-healing remediation pipeline..."
            local _remediation_applied=0
            # Set when profile-augmentor successfully (reviewer-approved) updates
            # the OFFENDING story's own agentRole profile — a genuine "the agent
            # who'll rewrite this code now has new guidance" signal, just as
            # real as an AC addition, and must retry the same way (found live,
            # 2026-07-09: this used to be silently dropped, so a successful
            # profile fix — the more common outcome of this pipeline in
            # practice — never led to a retry, only a hard stop).
            local _profile_remediation_applied=0
            local _rem_log="$LOG_DIR/gate-remediation-${phase_id}.log"

            for i in "${!_failing_logs[@]}"; do
                local _glog="${_failing_logs[$i]}"
                local _glabel="${_log_labels[$i]}"
                [ -f "$_glog" ] || continue

                info "  [gate-finding-analyst] Extracting grounded finding from ${_glabel} log..."

                # ── Agent 1: gate-finding-analyst ──────────────────────────────────
                # Reads gate log + PRD, emits JSON { gate, story_id, file, line, rule, message, suggested_fix }
                local _finding_prompt
                _finding_prompt=$(cat << ENDPROMPT1
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('gate-finding-analyst',''))")

Gate: ${_glabel}
Gate log file: ${_glog}
PRD file: ${PRD_FILE}
Current phase: ${phase_id}

Run your analysis now. Paste the verbatim log line proving the finding, then emit the JSON output.
ENDPROMPT1
)
                local _finding_json="" _gfa_attempt=0
                while [ "$_gfa_attempt" -lt 2 ] && [ -z "$_finding_json" ]; do
                    local _gfa_prompt="$_finding_prompt"
                    local _gfa_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
                    if [ "$_gfa_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _gfa_model="${ESCALATION_MODEL_HIGH}"
                        _gfa_prompt="RETRY (attempt 2): Your previous response was empty. Use ReadFile to read the gate log at ${_glog}, extract the finding, and emit ONLY the JSON output.

$_finding_prompt"
                    fi
                    local _gfa_raw
                    _gfa_raw=$(echo "$_gfa_prompt" | \
                        AI_GATE_ALLOW_TOOLS=1 \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                        AI_MODEL="${_gfa_model}" \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        CLAUDE_CMD="$CLAUDE_CMD" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                            --model    "${_gfa_model}" \
                        2>&1 | tee -a "$_rem_log")
                    if [ -n "$_gfa_raw" ]; then
                        _finding_json="$_gfa_raw"
                    else
                        [ "$_gfa_attempt" -lt 1 ] && warning "  [gate-finding-analyst] attempt 1 returned no output — retrying with escalated model" || warning "  [gate-finding-analyst] all 2 attempts returned no output"
                    fi
                    _gfa_attempt=$(( _gfa_attempt + 1 ))
                done
                if [ -z "$_finding_json" ]; then
                    warning "  [gate-finding-analyst] returned no output after 2 attempt(s) — skipping remediation for ${_glabel}"
                    continue
                fi

                # Check analyst returned a grounded finding (has story_id and rule)
                local _story_id
                _story_id=$(echo "$_finding_json" | python3 -c "
import sys, re, json
txt = sys.stdin.read()
for m in re.finditer(r'\{[^{}]*\"story_id\"[^{}]*\}', txt, re.DOTALL):
    try:
        obj = json.loads(m.group(0))
        sid = obj.get('story_id')
        if sid and sid != 'null':
            print(sid)
            break
    except: pass
" 2>/dev/null || true)

                if [ -z "$_story_id" ] || [ "$_story_id" = "null" ]; then
                    # Deterministic fallback (found live 2026-07-08): the analyst
                    # can't ground a finding into a story_id when the finding's
                    # `file` isn't listed in any story's technicalNotes.files —
                    # e.g. shared scaffold config (tsconfig.json, package.json)
                    # that no single story "owns" on paper. But every file that
                    # was ever actually written IS attributable, deterministically,
                    # via git: post-story commits always use the exact message
                    # "<id>: story complete (N file(s))" — ticket ID leads,
                    # colon-separated, to satisfy commit-message linters that
                    # require it there (see claude.sh's post-story commit
                    # step). Ask git who last touched the finding's file
                    # instead of asking the LLM to guess.
                    local _gf_file
                    _gf_file=$(grep -o '"file"[[:space:]]*:[[:space:]]*"[^"]*"' "$_glog" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
                    if [ -n "$_gf_file" ] && [ -f "$_gf_file" ]; then
                        local _gf_commit_subject
                        _gf_commit_subject=$(git -C "$PROJECT_ROOT" log --follow -1 --format=%s -- "$_gf_file" 2>/dev/null || echo "")
                        _story_id=$(echo "$_gf_commit_subject" | grep -oP '^\K[^:]+(?=: story complete)' 2>/dev/null || echo "")
                    fi
                    if [ -z "$_story_id" ]; then
                        warning "  [gate-finding-analyst] No grounded finding for ${_glabel} — skipping remediation for this gate"
                        continue
                    fi
                    info "  [gate-finding-analyst] LLM could not ground the finding, but git history attributes ${_gf_file} to: ${_story_id}"
                fi
                info "  [gate-finding-analyst] Finding mapped to story: ${_story_id}"

                # The story's OWN agentRole — ground truth for which agent
                # actually wrote the offending code, used below by
                # profile-augmentor instead of guessing from the gate name
                # (found live, 2026-07-09: profile-augmentor's own prompt
                # hardcoded a static "sast-sentinel finding -> typescript-
                # engineer profile" table, which only happens to be right
                # when the story's real role IS typescript-engineer — for
                # any other role, it silently updates a profile no agent
                # who touches this story will ever read).
                local _story_agent_role
                _story_agent_role=$(jq -r --arg id "$_story_id" \
                    '.stories[] | select(.id == $id) | .agentRole // "typescript-engineer"' \
                    "$PRD_FILE" 2>/dev/null || echo "typescript-engineer")

                # ── Agent 2: story-ac-remediator ───────────────────────────────────
                # Reads the finding JSON + PRD, proposes ACs for the owning story.
                #
                # Deterministic-apply, NOT agent-tool-write (fixed 2026-07-11, after
                # a live run: the agent's own response contained a well-formed
                # {"acs_added":2,"acs":[...]} with genuinely concrete, verifiable ACs
                # for a real tsconfig.json typo -- but the PRD was never actually
                # updated (confirmed directly via jq afterward), because the prior
                # version trusted the agent's own tool call (AI_GATE_ALLOW_TOOLS=1,
                # instructed to "write the updated PRD back to the file") instead of
                # applying the change ourselves. An LLM narrating "I wrote the file"
                # in its final text response is not the same as it having actually
                # called a write tool -- same class of bug already fixed for
                # run_plan_mode and run_pre_phase_assessment. This now mirrors the
                # Step 3.8 lint-gate remediator just above, which already applies ACs
                # deterministically in Python rather than trusting the agent to.
                info "  [story-ac-remediator] Augmenting ACs for story ${_story_id}..."
                local _ac_prompt
                _ac_prompt=$(cat << ENDPROMPT2
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('story-ac-remediator',''))")

## Finding to remediate
\`\`\`json
${_finding_json}
\`\`\`

Story to update: ${_story_id}

## Story's existing acceptanceCriteria
$(jq -c --arg id "$_story_id" '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | map(if type == "object" then .text else . end)' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")

Draft the new ACs now and emit ONLY the JSON summary — do not write any files yourself; the orchestrator applies your proposed ACs to the PRD deterministically.
ENDPROMPT2
)
                local _ac_result="" _acr_attempt=0
                while [ "$_acr_attempt" -lt 2 ] && [ -z "$_ac_result" ]; do
                    local _acr_prompt="$_ac_prompt"
                    local _acr_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
                    if [ "$_acr_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _acr_model="${ESCALATION_MODEL_HIGH}"
                        _acr_prompt="RETRY (attempt 2): Your previous response was empty or missing the 'acs' field. Emit ONLY the JSON: {\"acs_added\": N, \"acs\": [\"...\"]}.

$_ac_prompt"
                    fi
                    local _acr_raw
                    _acr_raw=$(echo "$_acr_prompt" | \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                        AI_MODEL="${_acr_model}" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                            --model    "${_acr_model}" \
                        2>&1 | tee -a "$_rem_log")
                    if [ -n "$_acr_raw" ]; then
                        _ac_result="$_acr_raw"
                    else
                        [ "$_acr_attempt" -lt 1 ] && warning "  [story-ac-remediator] attempt 1 returned no output — retrying with escalated model" || warning "  [story-ac-remediator] all 2 attempts returned no output — skipping AC augmentation for ${_story_id}"
                    fi
                    _acr_attempt=$(( _acr_attempt + 1 ))
                done

                local _ac_result_tmp
                _ac_result_tmp=$(mktemp)
                echo "$_ac_result" > "$_ac_result_tmp"
                local _acs_added
                _acs_added=$( ( flock -w 10 200 || { error "  [story-ac-remediator] Could not acquire lock on ${MAIN_PRD_FILE:-$PRD_FILE}"; return 1; }
                python3 - "${MAIN_PRD_FILE:-$PRD_FILE}" "$_story_id" "$_ac_result_tmp" <<'AC_APPLY_PY'
import sys, json, os

prd_path, story_id, raw_file = sys.argv[1], sys.argv[2], sys.argv[3]
txt = open(raw_file).read()

# Robust JSON-object scan (NOT a brace-depth-free regex): the agent's own
# suggested ACs frequently embed verification snippets like
# `node -e "...{...}..."`, whose literal { } characters inside a JSON
# string value broke the old regex (`\{[^{}]*"acs_added"[^{}]*\}` requires
# ZERO braces anywhere in the match, including inside string content).
# json.JSONDecoder.raw_decode respects real JSON string escaping/nesting,
# so it finds the object regardless of what's inside its string values.
decoder = json.JSONDecoder()
payload = None
idx = 0
while True:
    start = txt.find('{', idx)
    if start == -1:
        break
    try:
        obj, end = decoder.raw_decode(txt, start)
        if isinstance(obj, dict) and 'acs' in obj:
            payload = obj
            break
        idx = end
    except json.JSONDecodeError:
        idx = start + 1

if not payload:
    print(0)
    sys.exit(0)

new_acs = payload.get('acs', [])
if not new_acs:
    print(0)
    sys.exit(0)

with open(prd_path) as f:
    prd = json.load(f)

added = 0
for s in prd.get('stories', []):
    if s.get('id') != story_id:
        continue
    existing = [a.get('text', '') if isinstance(a, dict) else str(a) for a in s.get('acceptanceCriteria', [])]
    for ac in new_acs:
        if ac and ac not in existing and len(existing) < 24:
            s.setdefault('acceptanceCriteria', []).append({'text': ac, 'status': 'pending'})
            existing.append(ac)
            added += 1

if added > 0:
    _tmp_prd_path = prd_path + '.tmp'
    with open(_tmp_prd_path, 'w') as f:
        json.dump(prd, f, indent=2)
    os.replace(_tmp_prd_path, prd_path)

print(added)
AC_APPLY_PY
                2>/dev/null || echo 0
                ) 200>"${MAIN_PRD_FILE:-$PRD_FILE}.lock" )
                rm -f "$_ac_result_tmp"

                if [ "${_acs_added:-0}" -gt 0 ]; then
                    success "  [story-ac-remediator] ${_acs_added} AC(s) added to ${_story_id}"
                    _remediation_applied=1
                else
                    info "  [story-ac-remediator] No new ACs added (already covered or agent skipped)"
                fi

                # ── Agent 3: profile-augmentor ─────────────────────────────────────
                # Checks if the pattern is novel; if so, appends to the relevant profile
                #
                # KNOWN GAP (2026-07-11, file-locking pass): unlike every other
                # profiles.json/PRD writer in this file, this agent still has its
                # own Bash/WriteFile tool access (AI_GATE_ALLOW_TOOLS=1 below) and
                # writes profiles.json itself, mid-LLM-call -- that write can't be
                # wrapped in a shell-level flock the way the deterministic
                # story-ac-remediator/lint-gate/skills-audit writes above are,
                # since we don't control the exact moment the agent's own tool call
                # happens. Two parallel worktree stories both triggering this path
                # around the same time could still race on profiles.json (the disk-
                # verification check just below catches a NO-OP claim, but not a
                # genuine lost-update race between two real concurrent writes).
                # Converting this to the same deterministic-apply pattern used for
                # story-ac-remediator would close this gap; out of scope for this
                # pass.
                info "  [profile-augmentor] Checking if pattern is novel for profiles..."
                # Snapshot profiles.json before augmentor writes so reviewer can compare + revert
                local _profiles_before
                _profiles_before=$(cat "$_profiles_file" 2>/dev/null || echo "{}")
                local _prof_prompt
                _prof_prompt=$(cat << ENDPROMPT3
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('profile-augmentor',''))")

## Finding to evaluate
\`\`\`json
${_finding_json}
\`\`\`

Profiles file: ${_profiles_file}
Story that wrote the offending code: ${_story_id}
That story's agentRole (target THIS profile, not a guess from the gate name): ${_story_agent_role}

Check if the pattern is novel and append a rule if needed. Write the updated profiles.json back, then emit the JSON summary.
ENDPROMPT3
)
                local _prof_result="" _pfa3_attempt=0 _pfa3_disk_changed=0
                local _profiles_after=""
                while [ "$_pfa3_attempt" -lt 2 ] && [ "$_pfa3_disk_changed" = "0" ]; do
                    local _pfa3_prompt="$_prof_prompt"
                    [ "$_pfa3_attempt" -ge 1 ] && _pfa3_prompt="RETRY (attempt 2): You claimed profile_updated:true but profiles.json is byte-identical to before your call — you did not actually write the file. Use WriteFile to write the updated profiles.json to ${_profiles_file} now, then emit the JSON summary.

$_prof_prompt"
                    _prof_result=$(echo "$_pfa3_prompt" | \
                        AI_GATE_ALLOW_TOOLS=1 \
                        AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                        AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_MAX_TOOL_CALLS="${PROFILE_AUGMENTOR_MAX_TOOL_CALLS:-10}" \
                        CLAUDE_CMD="$CLAUDE_CMD" \
                        EPAM_CLI="${EPAM_CLI:-epam}" \
                        "$AI_RUNNER_CMD" \
                            --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                            --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
                        2>&1 | tee -a "$_rem_log")
                    if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true'; then
                        _profiles_after=$(cat "$_profiles_file" 2>/dev/null || echo "{}")
                        if [ "$_profiles_after" != "$_profiles_before" ]; then
                            _pfa3_disk_changed=1
                        else
                            [ "$_pfa3_attempt" -lt 1 ] && warning "  [profile-augmentor] Claimed profile_updated:true but profiles.json unchanged on disk — retrying with corrective note" || warning "  [profile-augmentor] Claimed profile_updated:true but profiles.json still unchanged on disk after 2 attempt(s) — treating as no-op, not applied"
                        fi
                    else
                        _pfa3_disk_changed=1
                    fi
                    _pfa3_attempt=$(( _pfa3_attempt + 1 ))
                done
                # If both attempts claimed profile_updated but disk never changed, skip this gate
                if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true' && [ "$_pfa3_disk_changed" = "0" ]; then
                    continue
                fi

                if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true'; then
                    # GROUNDING PRE-CHECK — is the proposed rule TRUE of this repo?
                    #
                    # The LLM reviewer below is handed the last 500 chars of
                    # profiles.json before/after, with no tools and no access to
                    # the repo under work. It cannot verify a claim about the
                    # codebase, only judge whether the wording looks reasonable.
                    # Live 2026-07-26 it approved a rule hardcoding
                    # `${file%.ts}.test.ts` for a codebase where every test is
                    # .spec.ts — encoding, as permanent guidance, the exact
                    # naming assumption that had blinded mutant-hunter, derived
                    # from a finding that was itself an artefact of a manifest
                    # bug. `.test.ts` is entirely plausible in isolation; it is
                    # false only against code the reviewer never sees.
                    #
                    # A file-convention claim is verifiable, so verify it. Runs
                    # first so an unfounded rule costs no LLM call, and fails
                    # OPEN on any error of its own.
                    # Guarded against unset SCRIPT_DIR/PROJECT_ROOT: this check
                    # must never be the reason remediation breaks.
                    local _pa_ground_lib="${SCRIPT_DIR:-}/lib/profile_rule_grounding.py"
                    if [ -n "${SCRIPT_DIR:-}" ] && [ -n "${PROJECT_ROOT:-}" ] && [ -f "$_pa_ground_lib" ]; then
                        local _pa_before_f _pa_after_f
                        _pa_before_f=$(mktemp); _pa_after_f=$(mktemp)
                        printf '%s' "$_profiles_before" > "$_pa_before_f"
                        printf '%s' "$_profiles_after"  > "$_pa_after_f"
                        # NOT piped into tee: `cmd | tee` yields TEE's exit
                        # status, so the rejection below would never fire. That
                        # pipe-masking is the same defect that made the
                        # repro-gate and review-escalation log a block without
                        # enforcing one.
                        local _pa_ground_out _pa_ground_rc=0
                        _pa_ground_out=$(python3 "$_pa_ground_lib" "$_pa_before_f" "$_pa_after_f" "${PROJECT_ROOT:-}" 2>&1) || _pa_ground_rc=$?
                        [ -n "$_pa_ground_out" ] && printf '%s\n' "$_pa_ground_out" >> "${LOG_DIR:-/tmp}/profile-grounding-${PHASE:-core}.log"
                        if [ "$_pa_ground_rc" -ne 0 ]; then
                            [ -n "$_pa_ground_out" ] && warning "  [profile-augmentor] $_pa_ground_out"
                            warning "  [profile-augmentor] Profile change REJECTED — it asserts a file convention this repo does not use; reverting profiles.json"
                            echo "$_profiles_before" > "$_profiles_file" 2>/dev/null || true
                            rm -f "$_pa_before_f" "$_pa_after_f"
                            continue
                        fi
                        rm -f "$_pa_before_f" "$_pa_after_f"
                    fi

                    # Reviewer gate — validate the change before accepting it
                    local _reviewer_profile
                    _reviewer_profile=$(echo "$_profiles_after" | \
                        python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('prd-change-reviewer',''))" 2>/dev/null || echo "")
                    local _review_verdict="pass"  # fail-safe only when reviewer not configured
                    if [ -n "${ORCH_GATE_PROVIDER:-}" ] && [ -n "$_reviewer_profile" ]; then
                        local _pa_rev_raw="" _pa_rev_attempt=0
                        while [ "$_pa_rev_attempt" -lt 2 ] && [ -z "$_pa_rev_raw" ]; do
                            local _pa_corrective=""
                            [ "$_pa_rev_attempt" -gt 0 ] && _pa_corrective="CORRECTION: Your previous response did not contain parseable JSON with a verdict field. Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}

"
                            local _pa_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
                            [ "$_pa_rev_attempt" -ge 1 ] && [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _pa_model="${ESCALATION_MODEL_HIGH}"
                            _pa_rev_raw=$(echo "${_pa_corrective}${_reviewer_profile}

STORY: gate-remediation
CHANGE TYPE: profile_addendum

BEFORE (excerpt, last 500 chars):
${_profiles_before: -500}

AFTER (excerpt, last 500 chars):
${_profiles_after: -500}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}" | \
                                AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                                AI_MODEL="${_pa_model}" \
                                EPAM_CLI="${EPAM_CLI:-epam}" \
                                "$AI_RUNNER_CMD" \
                                    --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                                    --model    "${_pa_model}" \
                                2>/dev/null | \
                                python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    v = obj.get('verdict','')
    if v in ('pass','fail'):
        print(v); sys.exit(0)
except Exception:
    pass
m = re.search(r'\"verdict\"\s*:\s*\"(pass|fail)\"', text)
if m: print(m.group(1)); sys.exit(0)
" 2>/dev/null || true)
                            _pa_rev_attempt=$(( _pa_rev_attempt + 1 ))
                        done
                        if [ "$_pa_rev_raw" = "pass" ] || [ "$_pa_rev_raw" = "fail" ]; then
                            _review_verdict="$_pa_rev_raw"
                        else
                            warning "  [profile-augmentor] Reviewer failed to produce a valid verdict after 2 attempt(s) — defaulting to fail (fail-safe)"
                            _review_verdict="fail"
                        fi
                    fi
                    if [ "$_review_verdict" = "fail" ]; then
                        warning "  [profile-augmentor] Profile change REJECTED by reviewer — reverting profiles.json"
                        echo "$_profiles_before" > "$_profiles_file" 2>/dev/null || true
                    else
                        success "  [profile-augmentor] Profile updated with new rule for ${_glabel} pattern (reviewer approved)"
                        _profile_remediation_applied=1
                    fi
                else
                    info "  [profile-augmentor] No profile update (pattern already covered)"
                fi

            done  # end per-gate loop

            if [ "$_remediation_applied" = "1" ] || [ "$_profile_remediation_applied" = "1" ]; then
                # Signal the caller (tier3 runner) to prd-remediate and retry the phase
                warning "Step 4.2: Remediation applied — caller should reset stories and retry phase"
                error "Step 4.2: Testing gates FAILED — remediation applied, retry required"
                error "  Remediation log: $_rem_log"
                error "  Bypass (skip remediation): SKIP_GATE_REMEDIATION=1 $0 --phase $phase_id"
                return 2  # exit code 2 = "remediated, retry the phase"
            fi
        fi

        error "Step 4.2: Testing gates FAILED — fix findings and re-run"
        error "  SAST log: $sast_log"
        error "  Spec log: $spec_log"
        error "  Bypass: SKIP_TESTING_GATES=true $0 --phase $phase_id"
        return 1
    fi

    success "Step 4.2: Testing gates PASSED"
    return 0
}

# ──────────────────────────────────────────────
# Step 4.2: Testing gates (SAST + spec validation)
# ──────────────────────────────────────────────
run_testing_gates "$PHASE"

# ──────────────────────────────────────────────
# run_unit_tests_gate <phase_id>
# Step 4.5: Independent unit test verification.
# Runs vitest (unit tests) and tsc --noEmit (type check) directly.
# Blocks phase gate if any suite fails. Skippable with SKIP_UNIT_TEST_GATE=true.
# ──────────────────────────────────────────────
# ── _run_vitest_and_tsc <gate_log> ────────────────────────────────────────────
# Returns 0 if both pass. Outputs vitest_output to stdout for capture.
# Sets VITEST_OUTPUT and VITEST_EXIT as side-effects via files to avoid
# subshell scoping issues.
_run_vitest_check() {
    local gate_log="$1"
    local _node_bin="$2"
    local out_file
    out_file=$(mktemp)

    local vitest_exit=0
    timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" "$_node_bin" ./node_modules/.bin/vitest run > "$out_file" 2>&1 || vitest_exit=$?
    cat "$out_file" >> "$gate_log"

    if [ "$vitest_exit" -ne 0 ]; then
        cat "$out_file"
        rm -f "$out_file"
        return 1
    fi

    local tsc_exit=0
    "$_node_bin" ./node_modules/.bin/tsc --noEmit >> "$gate_log" 2>&1 || tsc_exit=$?
    if [ "$tsc_exit" -ne 0 ]; then
        error "  Type check FAILED (tsc)"
        rm -f "$out_file"
        return 2  # tsc failure — not retryable via bug stories
    fi

    rm -f "$out_file"
    return 0
}

# ── _create_bug_fix_phase <vitest_output> <parent_phase> <bug_phase> <model> <provider> ──
# Writes BUG-* stories into PRD and registers them under implementationOrder[$bug_phase].
# Returns 1 if no failing files could be parsed.
_create_bug_fix_phase() {
    local vitest_output="$1"
    local parent_phase="$2"
    local bug_phase="$3"
    local model_override="$4"
    local provider_override="$5"

    local failing_files
    failing_files=$(echo "$vitest_output" | grep -E '^ FAIL ' | awk '{print $2}' | sort -u)
    if [ -z "$failing_files" ]; then
        error "  Could not parse failing test files from vitest output"
        return 1
    fi

    local seen_owners=""
    while IFS= read -r failing_file; do
        [ -z "$failing_file" ] && continue

        local owner_story
        owner_story=$(jq -r --arg rel "$failing_file" --arg phase "$parent_phase" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories[] |
             select(.id as $id | $ids | index($id)) |
             select(.technicalNotes.files // [] | any(endswith($rel) or . == $rel)) |
             .id' \
            "$PRD_FILE" 2>/dev/null | head -1)

        if [ -z "$owner_story" ]; then
            warning "  No owner found for '$failing_file' — skipping"
            continue
        fi
        echo "$seen_owners" | grep -qw "$owner_story" && continue
        seen_owners="$seen_owners $owner_story"

        local bug_id="BUG-${owner_story}-${bug_phase}"
        # Root cause this fixes (2026-07-09 pipeline audit): a 45-line cap
        # (grep -A 40 + head -45) on the failure excerpt fed into the bug-fix
        # story's own description risked truncating a genuinely long test
        # failure (multiple assertion failures for the same file, or a long
        # stack trace) before the actual root cause ever appeared — the
        # bug-fix story would then be given an incomplete picture of what's
        # broken. Cap raised substantially; truncation (if it still happens)
        # is now an explicit marker, not silent.
        local failure_excerpt _failure_excerpt_full _failure_excerpt_lines
        _failure_excerpt_full=$(echo "$vitest_output" | grep -A 150 "$failing_file")
        _failure_excerpt_lines=$(printf '%s\n' "$_failure_excerpt_full" | wc -l)
        if [ "$_failure_excerpt_lines" -gt 150 ]; then
            failure_excerpt=$(printf '%s\n' "$_failure_excerpt_full" | head -150)
            failure_excerpt="${failure_excerpt}
[TRUNCATED — ${_failure_excerpt_lines} total lines, only the first 150 shown.]"
        else
            failure_excerpt="$_failure_excerpt_full"
        fi

        local story_model story_provider
        if [ -n "$model_override" ]; then
            story_model="$model_override"
            story_provider="$provider_override"
        else
            story_model=$(jq -r --arg id "$owner_story" \
                '.stories[] | select(.id == $id) | .model // "MiniMax-M3"' \
                "$PRD_FILE" 2>/dev/null)
            story_provider=$(jq -r --arg id "$owner_story" \
                '.stories[] | select(.id == $id) | .aiProvider // "qwen"' \
                "$PRD_FILE" 2>/dev/null)
        fi

        local owner_notes
        owner_notes=$(jq -c --arg id "$owner_story" \
            '.stories[] | select(.id == $id) | .technicalNotes' \
            "$PRD_FILE" 2>/dev/null || echo '{}')

        local tmp_prd
        tmp_prd=$(mktemp)
        chmod 644 "$tmp_prd" 2>/dev/null
        jq \
            --arg bid "$bug_id" \
            --arg model "$story_model" \
            --arg provider "$story_provider" \
            --arg title "Bug fix: failing tests in ${failing_file}" \
            --arg desc "Fix the failing vitest tests in ${failing_file}. Do not rewrite the whole file — make the minimum change to fix the failures below. The technicalNotes carry the original story CRITICAL constraints — they still apply.\n\nFAILING TESTS:\n${failure_excerpt}" \
            --arg phase "$bug_phase" \
            --arg ffile "${PROJECT_ROOT}/${failing_file}" \
            --argjson onotes "$owner_notes" \
            '
            .stories += [{
                id: $bid,
                title: $title,
                description: $desc,
                status: "pending",
                completed: false,
                aiProvider: $provider,
                model: $model,
                agentRole: "typescript-engineer",
                unitTests: false,
                technicalNotes: ($onotes + {
                    files: [$ffile],
                    testCommand: "echo '\''tests deferred to Step 4.5 unit test gate'\''"
                })
            }] |
            .implementationOrder[$phase] = ((.implementationOrder[$phase] // []) + [$bid])
            ' "$PRD_FILE" > "$tmp_prd" && mv "$tmp_prd" "$PRD_FILE"

        log "  Created bug story: $bug_id ($provider_override$story_provider / $model_override$story_model)"
    done <<< "$failing_files"

    [ -z "$seen_owners" ] && return 1
    return 0
}

# ── _emit_unfixed_bug_list <vitest_output> ────────────────────────────────────
# Structured output printed when Sonnet escalation did not resolve failures.
_emit_unfixed_bug_list() {
    local vitest_output="$1"
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  UNFIXED BUGS — survived Sonnet escalation               ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    # Failing test files
    echo "$vitest_output" | grep -E '^ FAIL ' | while read -r line; do
        echo "  FILE  $line"
    done
    echo ""
    # Individual failing test names
    echo "$vitest_output" | grep -E '^ ❯ .* > ' | while read -r line; do
        echo "  TEST  $line"
    done
    echo ""
    # Top-level error messages
    echo "$vitest_output" | grep -E '^ +→ ' | while read -r line; do
        echo "  WHY   $line"
    done
    echo ""
}

# ── run_unit_tests_gate <phase_id> ────────────────────────────────────────────
# Step 4.5: Run vitest + tsc after all phase stories complete.
# On failure: creates BUG-* stories, runs them through the full pipeline
# (openspec → story agent → QA gates) in a bug_fix sub-phase.
# Round 1 uses the original story model; round 2 escalates to
# ESCALATION_MODEL (same model the InferenceLadder uses, default z-ai/glm-5.2)
# via the qwen (OpenRouter) provider.
# If the escalated model cannot fix it → hard fail with structured bug list.
# UNIT_TEST_BUG_DEPTH env var prevents recursive bug story creation.
run_unit_tests_gate() {
    local phase_id="$1"
    local gate_log="$LOG_DIR/unit-test-gate-${phase_id}.log"
    local bug_depth="${UNIT_TEST_BUG_DEPTH:-0}"

    if is_truthy "${SKIP_UNIT_TEST_GATE:-}"; then
        info "Step 4.5: Unit test gate skipped (SKIP_UNIT_TEST_GATE=true)"
        return 0
    fi

    local phase_has_unit_tests
    phase_has_unit_tests=$(jq -r --arg phase "$phase_id" \
        '(.implementationOrder[$phase] // []) as $ids |
         [.stories[] | select(.id as $id | $ids | index($id)) | select(.unitTests == true)] | length' \
        "$PRD_FILE" 2>/dev/null || echo "0")
    if [ "${phase_has_unit_tests:-0}" -eq 0 ]; then
        info "Step 4.5: No unit-test stories in phase '$phase_id' — skipping unit test gate"
        return 0
    fi

    if [ ! -f "$PROJECT_ROOT/package.json" ]; then
        info "Step 4.5: No package.json at PROJECT_ROOT — skipping vitest/tsc"
        return 0
    fi

    local _node_bin
    _node_bin="$(detect_node)"
    if [ -z "$_node_bin" ]; then
        warning "Step 4.5: Node binary not found — skipping unit test gate"
        return 0
    fi

    echo "=== Unit Test Gate: $phase_id @ $(date -Iseconds) ===" > "$gate_log"
    log "Step 4.5: Running unit test gate for '$phase_id'..."

    # ── Ensure node_modules exist before running vitest ────────────────────────
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        log "  node_modules missing — running npm install..."
        local install_output install_exit=0
        install_output=$(cd "$PROJECT_ROOT" && timeout "${EPAM_INSTALL_TIMEOUT_SECS:-180}" npm install 2>&1) || install_exit=$?
        echo "$install_output" >> "$gate_log"
        if [ "$install_exit" -eq 124 ]; then
            error "  npm install TIMED OUT after ${EPAM_INSTALL_TIMEOUT_SECS:-180}s — cannot run vitest"
            echo "$install_output" | tail -20 >&2
            return 1
        fi
        if [ "$install_exit" -ne 0 ]; then
            error "  npm install failed — cannot run vitest"
            echo "$install_output" | tail -20 >&2
            return 1
        fi
        log "  npm install completed"
    fi

    if [ ! -f "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
        error "  node_modules/.bin/vitest not found after npm install — vitest may not be in package.json"
        return 1
    fi

    # ── Initial vitest run ─────────────────────────────────────────────────────
    local vitest_output vitest_exit=0
    vitest_output=$(cd "$PROJECT_ROOT" && timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" "$_node_bin" ./node_modules/.bin/vitest run 2>&1) || vitest_exit=$?
    echo "$vitest_output" >> "$gate_log"

    if [ "$vitest_exit" -eq 0 ]; then
        log "  Running type check (tsc --noEmit)..."
        local tsc_exit=0
        cd "$PROJECT_ROOT" && "$_node_bin" ./node_modules/.bin/tsc --noEmit >> "$gate_log" 2>&1 || tsc_exit=$?
        if [ "$tsc_exit" -eq 0 ]; then
            success "Step 4.5: Unit test gate PASSED"
            "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                "Unit tests + type check passed" "" "main" "unit-test-runner" 2>/dev/null || true
            return 0
        fi
        error "  Type check FAILED (tsc) — not retryable via bug stories"
        error "Log: $gate_log"
        return 1
    fi

    error "  Unit tests FAILED (vitest)"
    "$SCRIPT_DIR/update-monitor.sh" event "unit_test_fail" \
        "Unit tests FAILED (vitest)" "" "main" "unit-test-runner" 2>/dev/null || true

    # ── If we are already inside a bug-fix phase, hard-fail immediately ────────
    if [ "$bug_depth" -ge 1 ]; then
        error "Step 4.5: Tests still failing inside bug-fix phase — escalation limit reached"
        _emit_unfixed_bug_list "$vitest_output"
        error "Log: $gate_log"
        return 1
    fi

    # ── Bug-fix rounds: round 1 = original model, round 2 = escalated model ───
    # Uses the same ESCALATION_MODEL as the InferenceLadder (claude.sh Rung 2/3)
    # rather than a separate hardcoded model/provider — this pipeline's model
    # roster is deliberately scoped to MiniMax + OpenRouter (kimi-k2/GLM); a
    # hardcoded Anthropic model here would be a third, inconsistent path.
    local bug_round model_override provider_override
    for bug_round in 1 2; do
        if [ "$bug_round" -eq 1 ]; then
            model_override=""
            provider_override=""
            log "Step 4.5: Creating bug fix stories (round $bug_round — original model)..."
        else
            model_override="${ESCALATION_MODEL:-z-ai/glm-5.2}"
            provider_override="qwen"
            log "Step 4.5: Creating bug fix stories (round $bug_round — escalated model: ${model_override})..."
        fi

        local bug_phase="bug_fix_${phase_id}_r${bug_round}"

        _create_bug_fix_phase \
            "$vitest_output" "$phase_id" "$bug_phase" \
            "$model_override" "$provider_override" || {
            error "  Could not create bug fix stories — giving up"
            break
        }

        log "Step 4.5: Running bug fix phase '$bug_phase' through full pipeline..."
        UNIT_TEST_BUG_DEPTH=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
            --phase "$bug_phase" --reset \
            2>&1 | tee -a "$gate_log" || true

        # Re-run vitest after bug fix phase completes
        vitest_exit=0
        vitest_output=$(cd "$PROJECT_ROOT" && timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" "$_node_bin" ./node_modules/.bin/vitest run 2>&1) || vitest_exit=$?
        echo "=== Post-bug-fix vitest (round $bug_round) ===" >> "$gate_log"
        echo "$vitest_output" >> "$gate_log"

        if [ "$vitest_exit" -eq 0 ]; then
            log "  Running type check (tsc --noEmit)..."
            tsc_exit=0
            cd "$PROJECT_ROOT" && "$_node_bin" ./node_modules/.bin/tsc --noEmit >> "$gate_log" 2>&1 || tsc_exit=$?
            if [ "$tsc_exit" -eq 0 ]; then
                success "Step 4.5: Unit test gate PASSED after bug fix round $bug_round"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                    "Unit tests passed after bug fix round $bug_round" "" "main" "unit-test-runner" 2>/dev/null || true
                return 0
            fi
            error "  Type check FAILED (tsc) after bug fix round $bug_round — not retryable"
            return 1
        fi

        error "  Tests still failing after bug fix round $bug_round"
    done

    # ── Both rounds exhausted — emit structured list ───────────────────────────
    _emit_unfixed_bug_list "$vitest_output"
    error "Step 4.5: Unit test gate FAILED — Sonnet could not fix remaining bugs"
    error "Bypass (non-code phases): SKIP_UNIT_TEST_GATE=true $0 --phase $phase_id"
    error "Log: $gate_log"
    return 1
}

# ──────────────────────────────────────────────
# run_interstitial_e2e_phase <phase_id>
# Step 5.5: After phase gate passes, check for a <phase_id>_e2e phase
# in implementationOrder and run it. Blocks next phase if E2E fails.
# ──────────────────────────────────────────────
run_interstitial_e2e_phase() {
    local phase_id="$1"
    local e2e_phase="${phase_id}_e2e"

    local has_e2e_phase
    has_e2e_phase=$(jq -r --arg p "$e2e_phase" \
        'if .implementationOrder[$p] then "yes" else "no" end' \
        "$PRD_FILE" 2>/dev/null || echo "no")

    if [ "$has_e2e_phase" = "no" ]; then
        info "Step 5.5: No interstitial E2E phase for '$phase_id' — skipping"
        return 0
    fi

    log "Step 5.5: Running interstitial E2E phase '$e2e_phase'..."
    "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_start" \
        "Starting E2E phase $e2e_phase" "" "main" "qa-engineer" 2>/dev/null || true

    local e2e_log="$LOG_DIR/e2e-phase-${e2e_phase}.log"
    if bash "$0" --phase "$e2e_phase" 2>&1 | tee "$e2e_log"; then
        success "Interstitial E2E phase '$e2e_phase' PASSED"
        "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_pass" \
            "E2E phase $e2e_phase passed" "" "main" "qa-engineer" 2>/dev/null || true
    else
        local e2e_exit=$?
        error "Interstitial E2E phase '$e2e_phase' FAILED (exit $e2e_exit)"
        error "Fix E2E failures then re-run: $0 --phase $e2e_phase"
        error "Log: $e2e_log"
        "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_fail" \
            "E2E phase $e2e_phase FAILED" "" "main" "qa-engineer" 2>/dev/null || true
        return 1
    fi
}

# ──────────────────────────────────────────────
# Step 4.5: Unit test gate
# ──────────────────────────────────────────────
run_unit_tests_gate "$PHASE"

# ──────────────────────────────────────────────
# Step 4.8: Pre-gate worktree health verification
# Second chance to catch uncommitted files before gate assessment.
# (Step 3.1 auto-commits; this surfaces any residual issues clearly.)
log "Step 4.8: Pre-gate worktree verification..."
if ! PHASE="$PHASE" "$SCRIPT_DIR/worktree-health-check.sh" > /dev/null 2>&1; then
    warning "Step 4.8: Uncommitted files remain in worktrees after auto-commit — manual review recommended"
    warning "  Run: PHASE=$PHASE AUTO_COMMIT=true $SCRIPT_DIR/worktree-health-check.sh"
fi

# ──────────────────────────────────────────────
# Step 5: Check phase gate
# ──────────────────────────────────────────────
log "Step 5: Checking phase gate..."
"$SCRIPT_DIR/update-monitor.sh" event "phase_gate_check" "Checking phase gate for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true

# Run phase gate check (skip tests for now - future enhancement)
gate_result=0
SKIP_TESTS=true "$SCRIPT_DIR/check-phase-gate.sh" "$PHASE" 2>&1 | tee "$LOG_DIR/phase-gate-${PHASE}.log" || gate_result=$?

case $gate_result in
    0)
        success "Phase gate: GO - All criteria passed"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_pass" "Phase gate passed for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        # Step 5.5: Interstitial E2E phase (runs <PHASE>_e2e if it exists)
        run_interstitial_e2e_phase "$PHASE"

        # Step 5.8: Auto-create PR if gh is available and there are commits ahead of origin
        if ! is_truthy "${SKIP_AUTO_PR:-}" && command -v gh >/dev/null 2>&1; then
            _current_branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
            # The remote's own HEAD is the answer; when it cannot be read, use the
            # CONFIGURED branch rather than guessing a name. A wrong guess here compares
            # against a nonexistent ref, so _commits_ahead comes back 0 and the PR step
            # silently does nothing.
            _default_branch=$(git -C "$PROJECT_ROOT" remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')
            [ -n "$_default_branch" ] || _default_branch="${JIRA_BASELINE_BRANCH:-}"
            _commits_ahead=$(git -C "$PROJECT_ROOT" rev-list --count "origin/${_default_branch}...HEAD" 2>/dev/null || echo 0)
            if [ "${_commits_ahead:-0}" -gt 0 ] && [ "${_current_branch}" != "${_default_branch}" ]; then
                log "Step 5.8: Creating PR for phase '$PHASE' (${_commits_ahead} commits ahead of origin/${_default_branch})..."
                _pr_title="feat: ${PHASE} phase complete"
                _completed_titles=$(jq -r --arg phase "$PHASE" \
                    '(.implementationOrder[$phase] // []) as $ids |
                     .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
                     "- \(.title)"' "$PRD_FILE" 2>/dev/null | head -10 || true)
                _pr_body="## Phase: ${PHASE}

### Stories Completed
${_completed_titles}

### Gate
Phase gate passed ✓

🤖 Auto-created by epam-cli orchestration"
                gh pr create \
                    --title "$_pr_title" \
                    --body "$_pr_body" \
                    --base "$_default_branch" \
                    --head "$_current_branch" \
                    >> "$LOG_DIR/pr-create-${PHASE}.log" 2>&1 && \
                    success "Step 5.8: PR created for phase '$PHASE'" || \
                    warning "Step 5.8: PR creation failed (may already exist) — see $LOG_DIR/pr-create-${PHASE}.log"
            else
                info "Step 5.8: Skipping PR creation (no commits ahead of origin or already on default branch)"
            fi
        fi
        ;;
    1)
        warning "Phase gate: RETRY - Issues found but fixable"
        warning "Check log for details: $LOG_DIR/phase-gate-${PHASE}.log"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_retry" "Phase gate requires retry for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        error "Pipeline blocked — fix issues then re-run this phase"
        exit 1
        ;;
    2)
        error "Phase gate: ESCALATE - Variance exceeds GATE_ESCALATE_THRESHOLD (${GATE_ESCALATE_THRESHOLD:-150}%)"
        error "Check log for details: $LOG_DIR/phase-gate-${PHASE}.log"
        error "Override: GATE_ESCALATE_THRESHOLD=200 $0 --phase NEXT_PHASE"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_escalate" "Phase gate requires escalation for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        exit 2
        ;;
esac

# ──────────────────────────────────────────────
# Step 6: Final Post-Phase Assessment
# ──────────────────────────────────────────────
log "Step 24: Running final post-phase assessment..."
if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    # Non-critical, same as Step 3.5's identical call (line ~3671): under
    # `set -e`, a bare call to a function that can `return 1` (the real-
    # evidence gate added 2026-07-12) aborts the ENTIRE script, not just this
    # step. Found live the same night that gate shipped: a real,
    # already-GO-gated, fully-completed scaffold phase had its whole tier3
    # pipeline killed (exit 1, "Phase 'scaffold' failed — aborting pipeline")
    # over nothing but this LAST, informational assessment call producing no
    # new record — Step 3.5's own identical call earlier in the same run
    # correctly treated the same failure mode as a warning.
    if run_phase_assessment "$PHASE"; then
        step_emit "24" "pass" "Step 24: Final post-phase assessment"
    else
        step_emit "24" "warn" "Step 24: Final post-phase assessment" "non-critical issues"
    fi
else
    info "Step 24: No cost data — skipping final post-phase assessment"
fi
assert_no_story_ids_lost "presplit" "Step 24: Final post-phase assessment"
assert_no_story_ids_gained "post-parallel" "Step 24: Final post-phase assessment"

# ──────────────────────────────────────────────
# Step 7: Load Phase Graph into Neo4j
# ──────────────────────────────────────────────
LOAD_GRAPH_SH="$SCRIPT_DIR/load-phase-graph.sh"
if [ -f "$LOAD_GRAPH_SH" ]; then
    log "Step 7: Loading phase graph into Neo4j..."
    if PHASE="$PHASE" bash "$LOAD_GRAPH_SH" --phase "$PHASE" >> "$LOG_DIR/neo4j-import.log" 2>&1; then
        success "Step 7: Phase graph loaded — Bloom: http://localhost:7474/browser/bloom"
    else
        warning "Step 7: Neo4j graph load skipped (Neo4j may not be running)"
    fi
fi

# ──────────────────────────────────────────────
# Step 7.5: Write cross-phase handoff document
# ──────────────────────────────────────────────
_handoff_file="$LOG_DIR/phase-handoff-${PHASE}.md"
{
    echo "# Phase Handoff: ${PHASE}"
    echo "Generated: $(date -Iseconds)"
    echo ""
    echo "## Completed Stories"
    jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
         "- \(.id): \(.title)"' "$PRD_FILE" 2>/dev/null || true
    echo ""
    echo "## Key Artifacts"
    jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
         .technicalNotes.files[]? // empty' "$PRD_FILE" 2>/dev/null | sort -u | sed 's/^/- /' || true
    echo ""
    echo "## Cost Summary"
    if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
        python3 -c "
import sys, json
total = 0.0
entries = []
for line in open('$LOG_DIR/phase-cost.jsonl'):
    try:
        e = json.loads(line)
        total += float(e.get('actual_cost_usd', 0) or 0)
        entries.append(e)
    except Exception:
        pass
print(f'Total cost: \${total:.4f}')
print(f'Entries: {len(entries)}')
" 2>/dev/null || echo "(cost data unavailable)"
    else
        echo "(no cost data)"
    fi
    echo ""
    echo "## Review Results"
    if [ -s "$AUTOMATION_DIR/logs/code-reviews.jsonl" ]; then
        grep "\"phase_id\":\"${PHASE}\"" "$AUTOMATION_DIR/logs/code-reviews.jsonl" 2>/dev/null | \
            python3 -c "
import sys, json
for line in sys.stdin:
    try:
        e = json.loads(line)
        status = e.get('review_status','?')
        issues = e.get('issues_found', 0)
        ts = e.get('timestamp','?')
        print(f'- {ts}: {status} ({issues} issues)')
    except Exception:
        pass
" 2>/dev/null || echo "(review data unavailable)"
    else
        echo "(no review data)"
    fi
} > "$_handoff_file"
info "Step 7.5: Phase handoff written: $_handoff_file"

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo -e "${MAGENTA}============================================${NC}"
echo -e "${MAGENTA}  Orchestration Complete${NC}"
echo -e "${MAGENTA}============================================${NC}"
echo ""

# Show final story status for this phase
jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     "\(if .completed then "  ✓" else "  ○" end) \(.id): \(.title) [\(.status // "pending")]"' \
    "$PRD_FILE"

echo ""

# Sync live prd.json to dashboard directory so dashboards reflect completed status
if [ -n "${OUTPUT_DIR:-}" ] && [ -f "$PRD_FILE" ]; then
    cp "$PRD_FILE" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
fi

# Finalize monitor
"$SCRIPT_DIR/update-monitor.sh" finalize 2>/dev/null || true
log "Log files:"
[ -f "$LOG_DIR/wt-primary.log" ] && info "  Primary:     $LOG_DIR/wt-primary.log"
[ -f "$LOG_DIR/wt-independent.log" ] && info "  Independent: $LOG_DIR/wt-independent.log"
info "  Claude outputs: $LOG_DIR/claude_outputs/"
info "  Monitor:     $MONITOR_STATUS_FILE"
[ -s "$LOG_DIR/phase-cost.jsonl" ] && info "  Phase costs: $LOG_DIR/phase-cost.jsonl"
[ -s "$LOG_DIR/phase-skill-assessments.jsonl" ] && info "  Assessments: $LOG_DIR/phase-skill-assessments.jsonl"

# Mark orchestration complete in monitor file
if [ -f "$MONITOR_STATUS_FILE" ]; then
    jq --arg ts "$(date -Iseconds)" \
        '.completedAt = $ts | .events += [{"type": "orchestration_complete", "story": "", "lane": "main", "role": "", "message": "All steps finished", "timestamp": $ts}]' \
        "$MONITOR_STATUS_FILE" > "$MONITOR_STATUS_FILE.tmp" && mv "$MONITOR_STATUS_FILE.tmp" "$MONITOR_STATUS_FILE"
fi

# Exit with error if any agent failed
if [ $PRIMARY_EXIT -ne 0 ] || [ $INDEPENDENT_EXIT -ne 0 ]; then
    exit 1
fi

# ──────────────────────────────────────────────
# Step 8: Automated phase promotion (opt-in)
# Set AUTO_PROMOTE_PHASE=true to chain into the next phase automatically.
# Phases with description containing "excluded from normal execution paths"
# (e.g. backlog_only) are skipped.
# ──────────────────────────────────────────────
if [ "${AUTO_PROMOTE_PHASE:-false}" = "true" ]; then
    # Verify all stories in current phase are complete before promoting
    _incomplete_count=$(jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         [.stories[] | select(.id as $id | $ids | index($id)) | select(.completed != true)] | length' \
        "$PRD_FILE" 2>/dev/null || echo 1)

    if [ "${_incomplete_count:-1}" -gt 0 ]; then
        warning "Step 8: Phase promotion skipped — $_incomplete_count stories still incomplete in '$PHASE'"
    else
        # Find next phase in insertion order, skipping excluded phases
        _next_phase=$(python3 -c "
import sys, json
prd = json.load(open('$PRD_FILE'))
phases = list(prd.get('implementationOrder', {}).keys())
phases_config = prd.get('phasesConfig', {})
current = '$PHASE'
try:
    idx = phases.index(current)
except ValueError:
    sys.exit(1)
for candidate in phases[idx+1:]:
    cfg = phases_config.get(candidate, {})
    desc = (cfg.get('description') or '').lower()
    if 'excluded from normal execution paths' in desc:
        continue
    # Skip if all stories already complete
    ids = prd['implementationOrder'].get(candidate, [])
    pending = [s for s in prd.get('stories', []) if s['id'] in ids and not s.get('completed')]
    if not ids or not pending:
        continue
    print(candidate)
    sys.exit(0)
sys.exit(1)
" 2>/dev/null || true)

        if [ -n "$_next_phase" ]; then
            success "Step 8: Promoting to next phase: '$_next_phase'"
            "$SCRIPT_DIR/update-monitor.sh" event "phase_promotion" \
                "Auto-promoting to phase '$_next_phase'" "" "main" "team-lead-agent" 2>/dev/null || true
            exec "$0" --phase "$_next_phase"
        else
            info "Step 8: No eligible next phase found — all phases complete or excluded"
        fi
    fi
fi
