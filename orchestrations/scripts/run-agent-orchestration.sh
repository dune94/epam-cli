#!/bin/bash

# Master orchestration script for parallel multi-agent execution
# Coordinates worktree-based parallel Claude agents across all EPAM CLI project phases
#
# Usage:
#   ./run-agent-orchestration.sh                                    # Run default phase (finops)
#   ./run-agent-orchestration.sh --phase finops                     # Run specific phase
#   ./run-agent-orchestration.sh --dry-run                          # Preview execution plan
#   ./run-agent-orchestration.sh --skip-cleanup                     # Keep worktrees for inspection

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
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
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
# Compute PRD path relative to PROJECT_ROOT for injecting into agent prompts
PRD_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$PRD_FILE")" 2>/dev/null || echo "orchestrations/prd.json")"
# Select wrapper script based on PROVIDER override or CLAUDE_CMD
case "${EPAM_ORCHESTRATION_PROVIDER:-${CLAUDE_CMD}}" in
    codemie-claude) CLAUDE_SH="$SCRIPT_DIR/codemie-claude.sh" ;;
    copilot)        CLAUDE_SH="$SCRIPT_DIR/copilot.sh" ;;
    openai)         CLAUDE_SH="$SCRIPT_DIR/openai.sh" ;;
    qwen)           CLAUDE_SH="$SCRIPT_DIR/qwen.sh" ;;
    cursor)         CLAUDE_SH="$SCRIPT_DIR/cursor.sh" ;;
    codex)          CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    *)              CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
esac
LOG_DIR="${OUTPUT_DIR:-$AUTOMATION_DIR/logs}"
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
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
if [ -n "${CLAUDE_CMD:-}" ]; then
    CLAUDE_CMD="$CLAUDE_CMD"
elif [ "${EPAM_ORCHESTRATION_PROVIDER:-}" = "codex" ]; then
    CLAUDE_CMD="codex"
else
    CLAUDE_CMD="claude"
fi
mkdir -p "$LOG_DIR"
DASHBOARD_WATCH_PID_FILE="$LOG_DIR/dashboards-watch.pid"
DASHBOARD_WATCH_LOG="$LOG_DIR/dashboards-watch.log"
DASHBOARD_WATCH_PID=""
DASHBOARD_WATCH_OWNED=false
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"
CONTROL_PLANE_PID=""
CONTROL_PLANE_LOG="$LOG_DIR/control-plane.log"

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

run_orch_prompt() {
    local prompt_text="$1"
    local provider_hint
    provider_hint="$(resolve_prompt_provider)"

    if [ ! -x "$AI_RUNNER_CMD" ]; then
        error "ai runner not executable: $AI_RUNNER_CMD"
        return 1
    fi

    # Default gate model to Haiku (low-effort, structured JSON output tasks)
    local gate_model="${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}"
    local model_args=()
    [ -n "$gate_model" ] && model_args=(--model "$gate_model")

    echo "$prompt_text" | \
        AI_PROVIDER="$provider_hint" \
        AI_MODEL="$gate_model" \
        CLAUDE_CMD="$CLAUDE_CMD" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        "$AI_RUNNER_CMD" --provider "$provider_hint" "${model_args[@]}"
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
    CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}" \
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

# Check actual phase spend against prd.json budget.
# If exceeded, writes a JSON PAUSED sentinel so wait_if_paused() blocks and
# the dashboard can display the reason. Operator resumes via dashboard Resume button.
# Bypass: SKIP_COST_GUARD=true
check_cost_budget() {
    [ "${SKIP_COST_GUARD:-false}" = "true" ] && return
    local cost_file="$LOG_DIR/phase-cost.jsonl"
    [ -f "$cost_file" ] || return
    local budget
    budget=$(jq -r '.budget // empty' "$PRD_FILE" 2>/dev/null || true)
    [ -z "$budget" ] || [ "$budget" = "null" ] && return
    local actual
    local _cost_py='
import sys, json
cost_file, phase = sys.argv[1], sys.argv[2]
total = 0.0
with open(cost_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            if rec.get("phase_id") == phase or rec.get("phase") == phase:
                total += float(rec.get("actual_cost_usd", rec.get("cost_usd", 0)) or 0)
        except Exception:
            pass
print(f"{total:.4f}")
'
    actual=$(echo "$_cost_py" | python3 - "$cost_file" "$PHASE" 2>/dev/null || echo "0")
    if python3 -c "import sys; sys.exit(0 if float('${actual}') >= float('${budget}') else 1)" 2>/dev/null; then
        warning "Cost circuit breaker: actual=\$${actual} >= budget=\$${budget} for phase '$PHASE'"
        warning "Orchestration paused — resume from dashboard after reviewing spend"
        printf '%s' "$(jq -n \
            --arg reason "budget_exceeded" \
            --arg phase "$PHASE" \
            --argjson actual "$actual" \
            --argjson budget "$budget" \
            '{reason:$reason, phase:$phase, actualCost:$actual, budget:$budget, pausedAt:(now|todate)}'
        )" > "$LOG_DIR/PAUSED"
    fi
}

  # Run a single story with timeout + one automatic retry on timeout.
# On double timeout: writes a PAUSED sentinel so the operator can decide via
# the dashboard whether to resume (skip the story) or kill the run.
# Configurable: STORY_TIMEOUT_SECS (default 1800 = 30 min)
run_story_with_watchdog() {
    local story_id="$1"
    local log_file="$2"
    local timeout_secs="${STORY_TIMEOUT_SECS:-1800}"
    local _rc=0

    set +e
    timeout "$timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee "$log_file"
    _rc=${PIPESTATUS[0]}
    set -e

    if [ $_rc -eq 124 ]; then
        warning "Watchdog: $story_id timed out after ${timeout_secs}s — retrying once..."
        set +e
        timeout "$timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee -a "$log_file"
        _rc=${PIPESTATUS[0]}
        set -e
    fi

    if [ $_rc -eq 124 ]; then
        error "Watchdog: $story_id timed out twice (${timeout_secs}s × 2) — pausing orchestration"
        printf '%s' "$(jq -n \
            --arg reason  "story_timeout" \
            --arg story   "$story_id" \
            --arg phase   "$PHASE" \
            --argjson tsecs "$timeout_secs" \
            '{reason:$reason,storyId:$story,phase:$phase,timeoutSecs:$tsecs,pausedAt:(now|todate)}'
        )" > "$LOG_DIR/PAUSED"
        wait_if_paused
        # Operator chose to resume — continue past the timed-out story
        return 0
    fi

    return $_rc
}

# Block until the PAUSED sentinel is removed (operator resumes via dashboard).
# Checks every 5 seconds; logs a reminder every 60 seconds.
wait_if_paused() {
    if [ ! -f "$LOG_DIR/PAUSED" ]; then
        return
    fi
    local _waited=0
    warning "Orchestration PAUSED by operator — waiting for resume signal..."
    while [ -f "$LOG_DIR/PAUSED" ]; do
        sleep 5
        _waited=$(( _waited + 5 ))
        if (( _waited % 60 == 0 )); then
            warning "Still paused (${_waited}s elapsed). POST http://localhost:${CONTROL_PLANE_PORT}/resume to continue."
        fi
    done
    success "Orchestration RESUMED after ${_waited}s pause."
}

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
in_degree = {s: 0 for s in story_ids}
graph     = {s: [] for s in story_ids}
for sid in story_ids:
    deps = [d for d in (story_map.get(sid, {}).get("dependencies") or []) if d in id_set]
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

# Apply any pending redirect for a story.
# Usage: apply_redirect_if_any <story_id>
# Prints the (possibly redirected) agent role to stdout.
apply_redirect_if_any() {
    local story_id="$1"
    local redirect_file="$LOG_DIR/redirect-${story_id}.json"
    if [ -f "$redirect_file" ]; then
        local target_agent
        target_agent=$(jq -r '.targetAgent // empty' "$redirect_file" 2>/dev/null || true)
        if [ -n "$target_agent" ]; then
            warning "REDIRECT: story $story_id → $target_agent (operator override)"
            rm -f "$redirect_file"
            # Update prd.json agentRole for this story
            local _tmp
            _tmp="${PRD_FILE}.redirect.$$"
            jq --arg id "$story_id" --arg role "$target_agent" \
                '(.stories[] | select(.id == $id)).agentRole = $role' \
                "$PRD_FILE" > "$_tmp" && mv "$_tmp" "$PRD_FILE"
            info "prd.json updated: $story_id.agentRole = $target_agent"
        fi
    fi
}

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
  --help              Show this help message

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

# Reset story completed flags if requested (idempotent re-runs)
if [ "${RESET_STORIES:-false}" = "true" ]; then
    log "Resetting story completed flags in $PRD_FILE..."
    local_tmp=$(mktemp)
    jq '(.stories[]? | select(.completed == true or .status == "failed")) |= (.completed = false | .status = "pending") |
        (.phases[]?.stories[]? | select(.completed == true or .status == "failed")) |= (.completed = false | .status = "pending")' \
        "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
    success "Stories reset to pending"
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

# ── Step 0: Specification pre-pass (OpenSpec/Speckit) ─────────────────────────
run_specification_pass() {
    local phase_id="$1"
    local spec_runner="$SCRIPT_DIR/spec-mode-runner.js"
    if [ ! -f "$spec_runner" ]; then
        info "Step 0: Specification runner not found (${spec_runner##*/}) — skipping"
        return 0
    fi
    local node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    if [ ! -x "$node_cmd" ]; then
        node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    fi
    if ! command -v "$node_cmd" >/dev/null 2>&1; then
        warning "Step 0: Node.js is required for specification mode but was not found"
        return 0
    fi
    log "Step 0: Running specification pass for phase '$phase_id'..."
    set +e
    PRD_FILE="$PRD_FILE" OUTPUT_DIR="$LOG_DIR" CLAUDE_CMD="${CLAUDE_CMD}" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_ORCHESTRATION_PROVIDER="${EPAM_ORCHESTRATION_PROVIDER:-}" \
        "$node_cmd" "$spec_runner" --phase "$phase_id" 2>&1 | tee "$LOG_DIR/spec-${phase_id}.log"
    local spec_rc=${PIPESTATUS[0]}
    set -e
    if [ $spec_rc -eq 0 ]; then
        success "Step 0: Specification pass completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "specification_pass" \
            "Specification agents completed (OpenSpec/Speckit)" "" "main" "spec-coordinator" 2>/dev/null || true
    else
        warning "Step 0: Specification pass encountered issues (see $LOG_DIR/spec-${phase_id}.log)"
    fi
}

if [ "$DRY_RUN" = true ]; then
    info "Step 0: Specification pass skipped during --dry-run"
elif [ "${EPAM_SPEC_MODE:-1}" = "0" ]; then
    info "Step 0: Specification pass disabled (EPAM_SPEC_MODE=0)"
else
    run_specification_pass "$PHASE"
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

if [ "${SKIP_CPA:-0}" != "1" ] && [ -f "$CPA_SCRIPT" ]; then
    log "Step 0.1: Running CPA pre-pass for phase '$PHASE'..."

    cpa_flags="--phase $PHASE --apply"
    [ "${STRICT_CPA:-0}" = "1" ] && cpa_flags="$cpa_flags --strict"

    # Inject most recent prior-phase handoff if available
    _prev_handoff=""
    _handoff_search_dir="$(dirname "$LOG_DIR")"
    # Look for handoff files under any logs/ sub-directory, pick the most recent by mtime
    _prev_handoff=$(find "$_handoff_search_dir" -maxdepth 3 -name "phase-handoff-*.md" \
        ! -name "phase-handoff-${PHASE}.md" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | awk '{print $2}' || true)
    [ -f "${_prev_handoff:-}" ] && info "Step 0.1: Injecting prior-phase context from: ${_prev_handoff##*/}"

    cpa_exit=0
    # shellcheck disable=SC2086
    CLAUDE_CMD="$CLAUDE_CMD" AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_CLI="${EPAM_CLI:-epam}" \
        PREV_PHASE_HANDOFF_FILE="${_prev_handoff:-}" \
        bash "$CPA_SCRIPT" $cpa_flags 2>&1 | tee "$LOG_DIR/cpa-${PHASE}.log" || cpa_exit=$?

    case $cpa_exit in
        0)
            success "Step 0.1: CPA gate PASSED for phase '$PHASE'"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_pass" \
                "CPA gate passed — all stories cleared" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        2)
            warning "Step 0.1: CPA gate REVIEW — some stories have elevated risk"
            warning "  Check: $LOG_DIR/cpa-${PHASE}.log"
            warning "  Continuing (use STRICT_CPA=1 to halt on review gates)"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_review" \
                "CPA gate REVIEW — proceeding with warnings" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        3)
            error "Step 0.1: CPA gate BLOCKED — one or more stories cannot proceed"
            error "  Check: $LOG_DIR/cpa-${PHASE}.log"
            error "  Resolve flagged issues, then re-run. Override: SKIP_CPA=1"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_block" \
                "CPA gate BLOCKED — pipeline halted" "" "main" "context-purveyor" 2>/dev/null || true
            exit 3
            ;;
        *)
            warning "Step 0.1: CPA script exited with code $cpa_exit (non-critical — continuing)"
            ;;
    esac
else
    if [ "${SKIP_CPA:-0}" = "1" ]; then
        info "Step 0.1: CPA pre-pass skipped (SKIP_CPA=1)"
    else
        info "Step 0.1: CPA script not found — skipping pre-pass"
    fi
fi

# Resolve orchestration mode for this phase (phase config > ORCH_MODE env > bash default)
RESOLVED_ORCH_MODE=$(resolve_orch_mode "$PHASE")

echo ""
echo -e "${MAGENTA}============================================${NC}"
echo -e "${MAGENTA}  EPAM CLI Agent Orchestration${NC}"
echo -e "${MAGENTA}  Phase: ${WHITE}$PHASE${NC}"
echo -e "${MAGENTA}  Mode:  ${WHITE}$([ "$DRY_RUN" = true ] && echo "DRY RUN" || echo "LIVE")${NC}"
echo -e "${MAGENTA}  Orch:  ${WHITE}${RESOLVED_ORCH_MODE}$([ "$RESOLVED_ORCH_MODE" = "hybrid" ] && echo " (Agent Teams + MCP bus)" || echo " (bash-only)")${NC}"
echo -e "${MAGENTA}============================================${NC}"
echo ""

# Categorize stories by agent group
main_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select((.agentGroup == "main" or .agentGroup == "preflight") and .completed == false) | .id' "$PRD_FILE")

primary_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.agentGroup == "primary" and .completed == false) | .id' "$PRD_FILE")

independent_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.agentGroup == "independent" and .completed == false) | .id' "$PRD_FILE")

review_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.agentRole == "review-agent" and .completed == false) | .id' "$PRD_FILE")

# Apply dependency-graph ordering within each group
main_stories=$(topo_sort_stories "$main_stories")
primary_stories=$(topo_sort_stories "$primary_stories")
independent_stories=$(topo_sort_stories "$independent_stories")
review_stories=$(topo_sort_stories "$review_stories")

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
run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    local profiles_backup="${profiles_file}.original"
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    # Backup profiles.json on first pre-phase run (idempotent)
    if [ ! -f "$profiles_backup" ]; then
        cp "$profiles_file" "$profiles_backup"
        log "Backed up original profiles to $profiles_backup"
    fi

    log "Running pre-phase skill assessment for '$phase_id'..."

    # Build assessment prompt
    local assessment_prompt
    assessment_prompt=$(cat << PROMPT_HEADER
You are the skill assessment agent running in PRE-PHASE mode. Your job is to detect skill gaps in agent profiles BEFORE the phase runs, and augment profiles with missing knowledge.

## Task
1. Read ${PRD_REL} and find the stories in the current phase's implementationOrder
2. For each story, extract required skills from description + technicalNotes (especially technicalNotes.requiredSkills)
3. Read orchestrations/agents/profiles.json and find the profile for each story's agentRole
4. Compare: does the agent's profile text mention each required skill?
5. For any GAPS found:
   a. Append a sentence to the agent's profile in profiles.json mentioning the missing skill
   b. Append a JSONL record to orchestrations/logs/profiles-audit.jsonl:
      {"timestamp":"<ISO8601>","phase_id":"<phase>","agent_role":"<role>","event":"skill_added","skill":"<skill>","skill_category":"<category>","context":"Story <id> requires <skill>","added_by":"pre-phase-assessment"}
   c. Use flock when writing to JSONL files
6. Write a summary to orchestrations/logs/phase-improvements/pre-<phase_id>.md

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

IMPORTANT: Keep profiles.json valid JSON at all times. Only ADD to existing profile strings, never remove content.
PROMPT_HEADER
    )

    # Append the phase-specific context
    assessment_prompt="${assessment_prompt}

## Phase: ${phase_id}

Read ${PRD_REL} implementationOrder[\"${phase_id}\"] for the story list, then proceed with the analysis above."

    cd "$PROJECT_ROOT"
    if run_orch_prompt "$assessment_prompt" 2>&1 | tee "$assessment_log"; then
        success "Pre-phase assessment completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "pre_phase_assessment" "Pre-phase assessment completed" "" "main" "team-lead-agent" 2>/dev/null || true
        # Validate profiles.json is still valid JSON
        if ! jq empty "$profiles_file" 2>/dev/null; then
            error "Pre-phase assessment corrupted profiles.json! Restoring backup."
            cp "$profiles_backup" "$profiles_file"
            return 1
        fi
    else
        warning "Pre-phase assessment failed for '$phase_id' (non-critical, continuing)"
    fi
}

log "Step 0.5: Running pre-phase skill assessment..."
run_pre_phase_assessment "$PHASE"

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
    if run_orch_prompt "$coord_prompt" 2>&1 | tee "$coord_log"; then
        success "Hybrid pre-phase coordination completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "hybrid_precoord" \
            "Hybrid pre-phase coordination completed" "" "main" "coordination-agent" 2>/dev/null || true
    else
        warning "Hybrid pre-phase coordination had issues — continuing with bash fallback"
    fi
}

if [ "$RESOLVED_ORCH_MODE" = "hybrid" ]; then
    log "Step 0.6: Hybrid mode — running pre-phase coordination..."
    run_hybrid_precoordination "$PHASE"
else
    info "Step 0.6: Skipped (ORCH_MODE=${RESOLVED_ORCH_MODE})"
fi

# ──────────────────────────────────────────────
# Step 0.7: Cross-phase regression guard
# Run vitest before any story in this phase executes to catch regressions
# introduced by the previous phase. Blocks on failure.
# Skip with: SKIP_REGRESSION_GUARD=true
# ──────────────────────────────────────────────
if [ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]; then
    _rg_node=$(detect_node 2>/dev/null || true)
    if [ -n "$_rg_node" ] && [ -f "$PROJECT_ROOT/package.json" ] && \
       [ -f "$PROJECT_ROOT/node_modules/.bin/vitest" ]; then
        log "Step 0.7: Cross-phase regression guard (vitest)..."
        _rg_log="$LOG_DIR/regression-guard-${PHASE}.log"
        set +e
        "$_rg_node" "$PROJECT_ROOT/node_modules/.bin/vitest" run \
            --root "$PROJECT_ROOT" > "$_rg_log" 2>&1
        _rg_rc=$?
        set -e
        if [ $_rg_rc -ne 0 ]; then
            error "Step 0.7: Regression guard FAILED — tests broken before phase '$PHASE' starts"
            error "  Fix failing tests from the previous phase before continuing."
            error "  See: $_rg_log"
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
        success "Step 0.7: Regression guard PASSED — baseline tests green"
    else
        info "Step 0.7: Regression guard skipped — node or vitest not found"
    fi
else
    info "Step 0.7: Regression guard skipped (SKIP_REGRESSION_GUARD=true)"
fi

# ──────────────────────────────────────────────
# Step 1: Run main-branch stories (no dependencies, sequential)
# ──────────────────────────────────────────────
if [ -n "$main_stories" ]; then
    # Filter out review stories (those run at the end)
    non_review_main=$(echo "$main_stories" | while read s; do
        [ -z "$s" ] && continue
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE")
        if [ "$role" != "review-agent" ]; then
            echo "$s"
        fi
    done)

    if [ -n "$non_review_main" ]; then
        log "Step 1: Running main-branch stories..."
        while IFS= read -r story; do
            [ -z "$story" ] && continue
            check_cost_budget
            wait_if_paused
            apply_redirect_if_any "$story"
            log "  Running: $story"
            run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log"
        done <<< "$non_review_main"
        success "Main-branch stories complete"
    fi
else
    info "Step 1: No main-branch stories to run"
fi

# ──────────────────────────────────────────────
# Step 2: Create worktrees
# ──────────────────────────────────────────────
need_worktrees=false
[ -n "$primary_stories" ] && need_worktrees=true
[ -n "$independent_stories" ] && need_worktrees=true

if [ "$need_worktrees" = true ]; then
    log "Step 2: Creating git worktrees..."
    "$CLAUDE_SH" --setup-worktrees || { error "Failed to create worktrees"; exit 1; }
else
    info "Step 2: No worktree stories — skipping worktree creation"
fi

# ──────────────────────────────────────────────
# Step 3: Launch parallel agents
# ──────────────────────────────────────────────
PRIMARY_PID=""
INDEPENDENT_PID=""

if [ -n "$primary_stories" ]; then
    log "Step 3a: Starting primary agent..."
    "$CLAUDE_SH" --worktree primary --phase "$PHASE" \
        > "$LOG_DIR/wt-primary.log" 2>&1 &
    PRIMARY_PID=$!
    info "  Primary agent PID: $PRIMARY_PID"
fi

if [ -n "$independent_stories" ]; then
    log "Step 3b: Starting independent agent..."
    "$CLAUDE_SH" --worktree independent --phase "$PHASE" \
        > "$LOG_DIR/wt-independent.log" 2>&1 &
    INDEPENDENT_PID=$!
    info "  Independent agent PID: $INDEPENDENT_PID"
fi

# Wait for both agents
PRIMARY_EXIT=0
INDEPENDENT_EXIT=0

if [ -n "$PRIMARY_PID" ]; then
    log "Waiting for primary agent (PID $PRIMARY_PID)..."
    wait $PRIMARY_PID || PRIMARY_EXIT=$?
    if [ $PRIMARY_EXIT -eq 0 ]; then
        success "Primary agent completed successfully"
    else
        error "Primary agent failed with exit code $PRIMARY_EXIT"
        error "Check log: $LOG_DIR/wt-primary.log"
    fi
fi

if [ -n "$INDEPENDENT_PID" ]; then
    log "Waiting for independent agent (PID $INDEPENDENT_PID)..."
    wait $INDEPENDENT_PID || INDEPENDENT_EXIT=$?
    if [ $INDEPENDENT_EXIT -eq 0 ]; then
        success "Independent agent completed successfully"
    else
        error "Independent agent failed with exit code $INDEPENDENT_EXIT"
        error "Check log: $LOG_DIR/wt-independent.log"
    fi
fi

# ──────────────────────────────────────────────
# Step 3.1: Worktree health check + auto-commit
# Ensures agent-produced code is committed before gate assessment.
# Agents sometimes write files without committing (common failure mode).
log "Step 3.1: Worktree health check..."
PHASE="$PHASE" AUTO_COMMIT=true "$SCRIPT_DIR/worktree-health-check.sh" \
    2>&1 | tee "$LOG_DIR/worktree-health-${PHASE}.log" || {
    warning "Worktree health check reported issues — see $LOG_DIR/worktree-health-${PHASE}.log"
    warning "Continuing (auto-commit attempted) — verify files manually if build fails"
}

# ──────────────────────────────────────────────
# Step 3.2: Merge worktree branches back to main branch
# After agents complete and health-check auto-commits, merge their
# work into the main branch so the next phase (which recreates
# worktree branches from HEAD) inherits all prior code.
# ──────────────────────────────────────────────
if [ "$need_worktrees" = true ]; then
    log "Step 3.2: Merging worktree branches back to main branch..."

    # Resolve the git root and current branch
    _merge_git_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    _merge_current_branch=$(git -C "$_merge_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "master")

    MERGE_FAILED=false

    for _wt_branch in wt-primary wt-independent; do
        # Skip branches that don't exist (no stories for that lane)
        if ! git -C "$_merge_git_root" show-ref --verify --quiet "refs/heads/$_wt_branch"; then
            info "  Branch $_wt_branch does not exist — skipping"
            continue
        fi

        # Check if the branch has commits ahead of the current branch
        _ahead=$(git -C "$_merge_git_root" rev-list --count "$_merge_current_branch..$_wt_branch" 2>/dev/null || echo "0")
        if [ "${_ahead:-0}" -eq 0 ]; then
            info "  Branch $_wt_branch has no new commits — nothing to merge"
            continue
        fi

        log "  Merging $_wt_branch ($_ahead commit(s) ahead) into $_merge_current_branch..."
        if git -C "$_merge_git_root" merge --no-ff "$_wt_branch" \
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
        error "Step 3.2: One or more worktree merges failed — review conflicts before next phase"
        error "  Worktrees preserved for inspection. Re-run with --skip-cleanup to debug."
    else
        success "Step 3.2: All worktree branches merged back successfully"
    fi
else
    info "Step 3.2: No worktrees — skipping merge-back"
fi

# ──────────────────────────────────────────────
# Sync story data to monitor from cost log
"$SCRIPT_DIR/sync-monitor-stories.sh" 2>/dev/null || true

# Step 3.5: Post-Parallel Skill Assessment
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

    local phase_records=$(grep -c "\"phase_id\":\"$phase_id\"" "$cost_file" 2>/dev/null || echo 0)
    if [ "${phase_records:-0}" -eq 0 ]; then
        warning "No cost records for phase '$phase_id' — skipping assessment"
        return 0
    fi

    info "Found $phase_records cost records for phase '$phase_id'"

    # Build assessment prompt
    local assessment_prompt
    assessment_prompt=$(cat << PROMPT_EOF
You are the skill assessment agent. Analyze the phase cost data and produce an assessment.

## Phase: $phase_id

## Task
1. Read orchestrations/logs/phase-cost.jsonl and filter for phase_id="$phase_id"
   IMPORTANT: The log accumulates records across multiple runs. For each story_id, use ONLY the
   most recent record (highest started_at timestamp). Discard all earlier records for the same story_id.
2. Cross-reference each story's status against ${PRD_REL}: if the story has "completed": true in the
   PRD, treat it as succeeded regardless of older cost-log entries. The PRD is the source of truth for
   current completion state; the cost log is used only for timing/cost figures from the latest run.
3. For each task (using latest record only), compare elapsed_minutes vs forecast_hours (converted to minutes)
4. Calculate phase-level totals and variance
5. Write a single-line JSON assessment to orchestrations/logs/phase-skill-assessments.jsonl with fields:
   phase_id, phase_name, actual_minutes, forecast_minutes, actual_cost_usd, forecast_cost_usd,
   variance_minutes, variance_cost_usd, over_threshold (bool), agent_recommendations (array), notes
6. Write a human-readable improvement report to orchestrations/logs/phase-improvements/${phase_id}.md
7. CORRECTIVE ACTION: If any task's description clearly requires a different skill domain than the assigned agentRole,
   update ${PRD_REL} to change agentRole for FUTURE phase stories that have the same mismatch.
   - Only modify stories that are status "pending" and completed false
   - Only modify stories in phases AFTER the current phase (do NOT modify completed phase stories)
   - When changing agentRole, preserve the original value in the "originalAgentRole" field (already present)
   - Document every role change in the improvement report
   - Skill domain indicators: "TypeScript" / "Node.js" / "CLI" → backend-engineer,
     "React" / "UI" / "frontend" → frontend-engineer, "Docker" / "infrastructure" → devops-engineer,
     "Vitest" / "testing" / "E2E" → qa-engineer

Use flock when appending to JSONL files. If all tasks were within forecast, note "No improvements needed."
PROMPT_EOF
    )

    log "Running assessment agent for phase '$phase_id'..."
    local assessment_log="$LOG_DIR/assessment-${phase_id}.log"

    # Backup prd.json before assessment modifies it
    cp "$PRD_FILE" "${PRD_FILE}.pre-assessment"
    log "Backed up prd.json to ${PRD_FILE}.pre-assessment"

    cd "$PROJECT_ROOT"
    if run_orch_prompt "$assessment_prompt" 2>&1 | tee "$assessment_log"; then
        success "Phase assessment completed for '$phase_id'"
    else
        warning "Phase assessment failed for '$phase_id' (non-critical)"
    fi
}

# Only run assessment if cost tracking data exists
if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    log "Step 3.5: Running post-parallel skill assessment..."
    run_phase_assessment "$PHASE"
else
    info "Step 3.5: No cost data yet — skipping post-parallel assessment"
fi

# ──────────────────────────────────────────────
    "$SCRIPT_DIR/update-monitor.sh" event "phase_assessment" "Running post-phase assessment" "" "main" "team-lead-agent" 2>/dev/null || true
# Step 3.6: Team Lead Code Review
# ──────────────────────────────────────────────
log "Step 3.6: Running Team Lead code review for phase..."
if "$SCRIPT_DIR/team-lead-review.sh" "$PHASE"; then
    success "Team Lead code review completed for phase '$PHASE'"
else
    warning "Team Lead code review had issues (check logs)"
fi

# Hard-block if any story was escalated (max iterations exhausted without approval)
_escalated=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id) != null) |
      select(.reviewStatus == "escalated")] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0")
if [ "${_escalated:-0}" -gt 0 ]; then
    error "Step 3.6: $_escalated escalated story/stories — max review iterations exhausted without approval"
    error "         Human review required before pipeline can proceed"
    exit 2
fi

# ──────────────────────────────────────────────
# Step 3.7: Pre-review build gate
# Runs vitest + tsc unconditionally before review agents see the code.
# Blocks review if tests fail. Skip with SKIP_PRE_REVIEW_GATE=true.
# ──────────────────────────────────────────────
if [ "${SKIP_PRE_REVIEW_GATE:-false}" != "true" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
    log "Step 3.7: Pre-review build gate (vitest + tsc)..."
    _pre_review_log="$LOG_DIR/pre-review-gate-${PHASE}.log"
    _pre_review_failed=0
    _node_bin="$(detect_node)"

    if [ -z "$_node_bin" ]; then
        warning "Step 3.7: Node binary not found — skipping pre-review gate"
    else
        echo "=== Pre-Review Gate: $PHASE @ $(date -Iseconds) ===" > "$_pre_review_log"
        cd "$PROJECT_ROOT"

        log "  Running vitest..."
        if "$_node_bin" ./node_modules/.bin/vitest run \
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
        if "$_node_bin" ./node_modules/.bin/tsc --noEmit \
                2>&1 | tee -a "$_pre_review_log"; then
            success "  tsc: PASS"
        else
            error "  tsc: FAIL — fix type errors before review proceeds"
            _pre_review_failed=1
        fi

        echo "=== Gate Result: $([ $_pre_review_failed -eq 0 ] && echo PASS || echo FAIL) ===" \
            >> "$_pre_review_log"

        if [ $_pre_review_failed -ne 0 ]; then
            error "Step 3.7: Pre-review gate FAILED — review agents blocked on broken build"
            error "  Fix failures, then re-run: $0 --phase $PHASE"
            error "  Bypass (emergency only): SKIP_PRE_REVIEW_GATE=true $0 --phase $PHASE"
            error "  Log: $_pre_review_log"
            exit 1
        fi

        success "Step 3.7: Pre-review gate PASSED"
    fi
else
    [ "${SKIP_PRE_REVIEW_GATE:-false}" = "true" ] && \
        info "Step 3.7: Pre-review gate skipped (SKIP_PRE_REVIEW_GATE=true)"
fi

# ──────────────────────────────────────────────
# Step 4: Run review stories
# ──────────────────────────────────────────────
if [ -n "$review_stories" ]; then
    log "Step 4: Running review stories..."
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
    done <<< "$review_stories"
    success "Review stories complete"
else
    info "Step 4: No review stories in this phase"
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

    if [ "${SKIP_TESTING_GATES:-false}" = "true" ]; then
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
            info "  Step 4.6: Browser E2E routing skipped (SKIP_BROWSER_E2E_ROUTING=true)"
            return 0
        fi

        phase_ids=$(jq -r --arg phase "$phase_id" '(.implementationOrder[$phase] // [])[]' "$PRD_FILE" 2>/dev/null || true)
        if [ -z "$phase_ids" ]; then
            info "  Step 4.6: No phase stories for browser E2E routing"
            return 0
        fi

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
            run_orch_prompt "$prompt" 2>&1 | tee "$story_log"
            rc=${PIPESTATUS[0]:-1}
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
            info "  Step 4.6: No stories matched browser E2E routing criteria"
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
    log "  Step 4.2a: Running SAST sentinel..."
    {
        local sast_prompt="You are acting as the sast-sentinel agent.

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Run the following checks and produce a structured JSON report:

1. TypeScript compiler diagnostics:
   Find the node binary: try 'node', then check ~/.nvm/versions/node/*/bin/node and ~/.local/share/fnm/node-versions/*/installation/bin/node (pick the highest version).
   Run: <node> ./node_modules/.bin/tsc --noEmit 2>&1 (from project root: $PROJECT_ROOT)
   Parse output for errors. Each error is a finding with severity 'major'. If no node_modules/.bin/tsc exists, skip this check and note it in the report.

2. Security pattern scan on changed/new files in this phase:
   - Command injection: unsanitised input to child_process.exec/spawn
   - Path traversal: user input in fs paths without validation
   - Hardcoded secrets: API keys, tokens, passwords in source
   - Unsafe eval/Function constructor usage

Output format (strict JSON):
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
    shown = 0
    for name, v in vulns.items():
        if shown >= 15:
            lines.append(f"  ... and {len(vulns)-shown} more packages")
            break
        sev  = v.get("severity", "?")
        via  = ", ".join(str(x.get("title", x) if isinstance(x, dict) else x)
                         for x in (v.get("via") or [])[:2])
        lines.append(f"  [{sev}] {name}: {via[:100]}")
        shown += 1
    print("\n".join(lines))
except Exception as e:
    print(f"(audit parse error: {e})")
'
                audit_summary=$(echo "$_audit_py" | python3 - "$audit_json" 2>/dev/null \
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

        run_orch_prompt "$sast_prompt" 2>&1 | tee "$sast_log"
    } &
    local sast_pid=$!

    # ── Spec Validator ──
    log "  Step 4.2b: Running spec validator..."
    {
        local spec_prompt="You are acting as the spec-validator agent.

Phase: $phase_id
PRD file: $PRD_FILE
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Read the stories for phase '$phase_id' from the PRD file. For each story:
1. Read its acceptanceCriteria array
2. Examine the implementation files (check src/, test/, and recent git changes)
3. Classify each criterion as: met, partial, unmet, or untestable

Output format (strict JSON):
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

        run_orch_prompt "$spec_prompt" 2>&1 | tee "$spec_log"
    } &
    local spec_pid=$!

    # Wait for both agents
    wait $sast_pid || sast_exit=$?
    wait $spec_pid || spec_exit=$?

    local end_ts
    end_ts=$(date +%s%3N 2>/dev/null || date +%s)
    local duration_ms=$(( end_ts - start_ts ))

    # Evaluate results
    if [ $sast_exit -ne 0 ]; then
        error "  SAST sentinel FAILED (exit $sast_exit)"
        failed=1
    else
        # Check for blocker findings in SAST output
        if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$sast_log" 2>/dev/null; then
            error "  SAST sentinel: FAIL verdict — blocker findings detected"
            failed=1
        else
            success "  SAST sentinel: PASS"
        fi
    fi

    if [ $spec_exit -ne 0 ]; then
        error "  Spec validator FAILED (exit $spec_exit)"
        failed=1
    else
        if grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"fail"' "$spec_log" 2>/dev/null; then
            error "  Spec validator: FAIL verdict — critical criteria unmet"
            failed=1
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"warn"' "$spec_log" 2>/dev/null; then
            warning "  Spec validator: WARN — some criteria partially met (non-blocking)"
        else
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
        log "  Step 4.3a: Running review-ranger..."
        {
            local review_prompt="You are acting as the review-ranger agent.

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Perform a deep diff-level code review on files changed in this phase.
Use git diff to identify changed files, then analyse:
1. Complexity hotspots (cyclomatic complexity > 10, nesting > 4)
2. Code duplication (near-identical blocks > 5 lines)
3. API contract drift (exported signature changes without test updates)
4. Error handling completeness (swallowed errors in critical paths)
5. Test coverage gaps (new public functions without tests)
6. Naming consistency (camelCase vars, PascalCase types, UPPER_SNAKE constants)

Output format (strict JSON):
{
  \"agent\": \"review-ranger\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"filesReviewed\": N, \"findingsCount\": N, \"blockerCount\": N, \"majorCount\": N, \"minorCount\": N },
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"category\": \"...\", \"file\": \"...\", \"line\": N, \"description\": \"...\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|fail\"
}"

            if [ -n "$review_profile" ]; then
                review_prompt="$review_profile

$review_prompt"
            fi

            run_orch_prompt "$review_prompt" 2>&1 | tee "$review_log"
        } &
        local review_pid=$!

        # ── Mutant Hunter ──
        log "  Step 4.3b: Running mutant-hunter..."
        {
            local mutant_prompt="You are acting as the mutant-hunter agent.

Phase: $phase_id
Project root: $PROJECT_ROOT
E2E routing override context:
- FORCE_LIGHTPANDA=$force_lightpanda
- FORCE_PLAYWRIGHT=$force_playwright
- routingDecision=$routing_decision

Perform mutation testing analysis on files changed in this phase.
Use git diff to identify changed source files, then for each:
1. Propose mutations: operator swaps, comparison inversions, boolean negations,
   early returns, boundary shifts, removed null checks, swapped arguments
2. Focus on critical paths: provider failover, tool safety, auth, billing, agent state
3. For each mutation, determine if existing tests in test/unit/ would catch it

Output format (strict JSON):
{
  \"agent\": \"mutant-hunter\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"mutationsProposed\": N, \"killed\": N, \"survived\": N, \"noCoverage\": N, \"mutationScore\": 75 },
  \"mutations\": [{ \"file\": \"...\", \"line\": N, \"originalCode\": \"...\", \"mutatedCode\": \"...\", \"status\": \"killed|survived|no-coverage\", \"relatedTest\": \"...\", \"recommendation\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$mutant_profile" ]; then
                mutant_prompt="$mutant_profile

$mutant_prompt"
            fi

            run_orch_prompt "$mutant_prompt" 2>&1 | tee "$mutant_log"
        } &
        local mutant_pid=$!

        # Wait for both Phase B agents
        wait $review_pid || review_exit=$?
        wait $mutant_pid || mutant_exit=$?

        # Evaluate Phase B results
        if [ $review_exit -ne 0 ]; then
            error "  Review-ranger FAILED (exit $review_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$review_log" 2>/dev/null; then
                error "  Review-ranger: FAIL verdict — blocker findings detected"
                failed=1
            else
                success "  Review-ranger: PASS"
            fi
        fi

        if [ $mutant_exit -ne 0 ]; then
            error "  Mutant-hunter FAILED (exit $mutant_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$mutant_log" 2>/dev/null; then
                error "  Mutant-hunter: FAIL verdict — mutation score below threshold"
                failed=1
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$mutant_log" 2>/dev/null; then
                warning "  Mutant-hunter: WARN — mutation score 50-69% (non-blocking)"
            else
                success "  Mutant-hunter: PASS"
            fi
        fi
    else
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
        log "  Step 4.4a: Running fuzz-weaver..."
        {
            local fuzz_prompt="You are acting as the fuzz-weaver agent.

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

Output format (strict JSON):
{
  \"agent\": \"fuzz-weaver\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"functionsAnalysed\": N, \"fuzzCasesProposed\": N, \"covered\": N, \"gaps\": N, \"vulnerabilities\": N },
  \"cases\": [{ \"function\": \"...\", \"file\": \"...\", \"line\": N, \"property\": \"...\", \"generator\": \"...\", \"invariant\": \"...\", \"status\": \"covered|gap|vulnerability\", \"recommendation\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$fuzz_profile" ]; then
                fuzz_prompt="$fuzz_profile

$fuzz_prompt"
            fi

            run_orch_prompt "$fuzz_prompt" 2>&1 | tee "$fuzz_log"
        } &
        local fuzz_pid=$!

        # ── Perf Sentinel ──
        log "  Step 4.4b: Running perf-sentinel..."
        {
            local perf_prompt="You are acting as the perf-sentinel agent.

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

Output format (strict JSON):
{
  \"agent\": \"perf-sentinel\",
  \"phase\": \"$phase_id\",
  \"summary\": { \"filesAnalysed\": N, \"findingsCount\": N, \"blockerCount\": N, \"estimatedStartupImpactMs\": N },
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"category\": \"complexity|memory|async|startup|provider\", \"file\": \"...\", \"line\": N, \"description\": \"...\", \"estimatedImpact\": \"high|medium|low\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$perf_profile" ]; then
                perf_prompt="$perf_profile

$perf_prompt"
            fi

            run_orch_prompt "$perf_prompt" 2>&1 | tee "$perf_log"
        } &
        local perf_pid=$!

        # Wait for both Phase C agents
        wait $fuzz_pid || fuzz_exit=$?
        wait $perf_pid || perf_exit=$?

        # Evaluate Phase C results
        if [ $fuzz_exit -ne 0 ]; then
            error "  Fuzz-weaver FAILED (exit $fuzz_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$fuzz_log" 2>/dev/null; then
                error "  Fuzz-weaver: FAIL verdict — vulnerabilities detected"
                failed=1
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$fuzz_log" 2>/dev/null; then
                warning "  Fuzz-weaver: WARN — coverage gaps > 30% (non-blocking)"
            else
                success "  Fuzz-weaver: PASS"
            fi
        fi

        if [ $perf_exit -ne 0 ]; then
            error "  Perf-sentinel FAILED (exit $perf_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$perf_log" 2>/dev/null; then
                error "  Perf-sentinel: FAIL verdict — performance blocker detected"
                failed=1
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$perf_log" 2>/dev/null; then
                warning "  Perf-sentinel: WARN — performance concerns (non-blocking)"
            else
                success "  Perf-sentinel: PASS"
            fi
        fi
    else
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
run_unit_tests_gate() {
    local phase_id="$1"
    local gate_log="$LOG_DIR/unit-test-gate-${phase_id}.log"
    local failed=0

    if [ "${SKIP_UNIT_TEST_GATE:-false}" = "true" ]; then
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

    log "Step 4.5: Independent unit test gate for '$phase_id'..."
    echo "=== Unit Test Gate: $phase_id @ $(date -Iseconds) ===" > "$gate_log"

    # Node.js project: run vitest + tsc
    if [ -f "$PROJECT_ROOT/package.json" ]; then
        local _node_bin
        _node_bin="$(detect_node)"
        if [ -z "$_node_bin" ]; then
            warning "  Node binary not found — skipping vitest/tsc"
        else
            log "  Running unit tests (vitest)..."
            if "$_node_bin" ./node_modules/.bin/vitest run \
                    2>&1 | tee -a "$gate_log"; then
                success "  Unit tests passed (vitest)"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                    "Unit tests passed (vitest)" "" "main" "unit-test-runner" 2>/dev/null || true
            else
                error "  Unit tests FAILED (vitest)"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_fail" \
                    "Unit tests FAILED (vitest) — blocking phase gate" "" "main" "unit-test-runner" 2>/dev/null || true
                failed=1
            fi

            log "  Running type check (tsc --noEmit)..."
            if "$_node_bin" ./node_modules/.bin/tsc --noEmit \
                    2>&1 | tee -a "$gate_log"; then
                success "  Type check passed (tsc)"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_pass" \
                    "Type check passed (tsc)" "" "main" "unit-test-runner" 2>/dev/null || true
            else
                error "  Type check FAILED (tsc)"
                "$SCRIPT_DIR/update-monitor.sh" event "unit_test_fail" \
                    "Type check FAILED (tsc) — blocking phase gate" "" "main" "unit-test-runner" 2>/dev/null || true
                failed=1
            fi
        fi
    else
        info "  No package.json at PROJECT_ROOT — skipping vitest/tsc"
    fi

    echo "=== Gate Result: $([ $failed -eq 0 ] && echo PASS || echo FAIL) ===" >> "$gate_log"

    if [ $failed -ne 0 ]; then
        error "Unit test gate FAILED — fix failures and re-run this phase"
        error "Bypass (for non-code phases): SKIP_UNIT_TEST_GATE=true $0 --phase $phase_id"
        error "Log: $gate_log"
        return 1
    fi

    success "Unit test gate PASSED"
    return 0
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
        if [ "${SKIP_AUTO_PR:-false}" != "true" ] && command -v gh >/dev/null 2>&1; then
            _current_branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
            _default_branch=$(git -C "$PROJECT_ROOT" remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}' || echo "main")
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
log "Step 6: Running final post-phase assessment..."
if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    run_phase_assessment "$PHASE"
else
    info "Step 6: No cost data — skipping final post-phase assessment"
fi

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
