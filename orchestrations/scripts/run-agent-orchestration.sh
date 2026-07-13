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
# Always resolve to absolute path — relative paths break when CWD changes in worktrees
PRD_FILE="$(cd "$(dirname "$PRD_FILE")" && pwd)/$(basename "$PRD_FILE")"

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
  echo "       Convention: /home/bradleyjerome/projects/ai/epam-test-apps/<app-name>" >&2
  exit 1
fi

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
    *)
        error "Unknown EPAM_ORCHESTRATION_PROVIDER '${EPAM_ORCHESTRATION_PROVIDER:-}'. Set it to one of: qwen|openai|copilot|cursor|codex|codemie-claude|claude in your .env file."
        exit 1
        ;;
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
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"
CONTROL_PLANE_PID=""
CONTROL_PLANE_LOG="$LOG_DIR/control-plane.log"

# GAP-P13 Phase 1 — Durable orchestration: idempotency key + file checkpoints
# Each run gets a unique ID. After each story completes, a checkpoint entry is
# written so a crash-restart can skip already-finished stories without needing
# RESET_STORIES=false (which would otherwise re-run everything from scratch).
ORCH_RUN_ID="${ORCH_RUN_ID:-$(date +%Y%m%dT%H%M%SZ)}"
CHECKPOINT_FILE="${LOG_DIR}/checkpoint-${PHASE:-main}-${ORCH_RUN_ID}.jsonl"

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

step_emit() {
    local step_id="$1"
    local status="$2"
    local label="$3"
    local reason="${4:-}"
    local ts
    ts=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)

    _STEP_LABELS["$step_id"]="$label"
    _STEP_STATUS["$step_id"]="$status"

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
        local _sid _slabel _sstatus
        for _sid in \
            "0:spec" "0a:openspec" "0b:speckit" "0.1:cpa" "0.5:skill-pre" "0.6:hybrid-coord" "0.7:regression" \
            "0.8:mkdir" "0.9:model-coord" "1:main-stories" "1.5:auto-commit" "1.6:tc-writer" \
            "2:worktrees" "3a:primary" "3b:independent" "3.1:wt-health" \
            "3.2:wt-merge" "3.5:skill-post" "3.7:pre-review" "3.8:lint-gate" \
            "4:review-stories" "4.2a:sast" "4.2b:spec-val" \
            "4.3a:review-ranger" "4.3b:mutant-hunter" \
            "4.4a:fuzz-weaver" "4.4b:perf-sentinel" "4.6:e2e"; do
            local _key="${_sid%%:*}"
            _slabel="${_STEP_LABELS[$_key]:-${_sid#*:}}"
            _sstatus="${_STEP_STATUS[$_key]:-pending}"
            [ "$first" = "true" ] && first=false || echo ","
            printf '    {"id":"%s","label":"%s","status":"%s"}' \
                "$_key" "$_slabel" "$_sstatus"
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

    _checklist_row "0"    "Specification pass"       "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "EPAM_SPEC_MODE=0"
    _checklist_row "0a"   "  openspec (elaboration)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "${SPEC_MODE_OPENSPEC_MODEL:-moonshotai/kimi-k2}"
    _checklist_row "0b"   "  speckit (verification)" "$([ "${EPAM_SPEC_MODE:-1}" = "0" ] && echo SKIP || echo ACTIVE)" "${SPEC_MODE_SPECKIT_MODEL:-moonshotai/kimi-k2}"
    _checklist_row "0.1"  "CPA pre-pass"             "$([ "${SKIP_CPA:-0}" = "1" ] && echo SKIP || echo ACTIVE)"           "SKIP_CPA=1"
    _checklist_row "0.5"  "Pre-phase skill assess"   "$([ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ] && echo SKIP || echo ACTIVE)" "$([ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ] && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "0.6"  "Hybrid pre-coord"         "$([ "${RESOLVED_ORCH_MODE:-bash}" = "hybrid" ] && echo ACTIVE || echo SKIP)" "ORCH_MODE≠hybrid"
    _checklist_row "0.7"  "Regression guard"         "$([ "${SKIP_REGRESSION_GUARD:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_REGRESSION_GUARD=true"
    _checklist_row "0.8"  "mkdir src/ dirs"          "ACTIVE"
    _checklist_row "0.9"  "PRD model coordinator"    "$([ "${SKIP_PRD_MODEL_COORDINATOR:-0}" = "1" ] && echo SKIP || echo ACTIVE)" "$([ "${SKIP_PRD_MODEL_COORDINATOR:-0}" = "1" ] && echo SKIP_PRD_MODEL_COORDINATOR=1 || true)"
    _checklist_row "1"    "Main-branch stories"      "ACTIVE"
    _checklist_row "1.5"  "Auto-commit"              "COND"  "if uncommitted changes"
    _checklist_row "1.6"  "TC writer gate"           "$([ "${SKIP_TC_WRITER:-0}" = "1" ] && echo SKIP || echo COND)" "SKIP_TC_WRITER=1 or no test stories"
    _checklist_row "1.65" "Skills coordinator audit" "$([ "${SKIP_SKILLS_AUDIT:-0}" = "1" ] && echo SKIP || echo ACTIVE)" "SKIP_SKILLS_AUDIT=1"
    _checklist_row "1.66" "Tools coordinator audit"  "$([ "${SKIP_TOOLS_AUDIT:-0}" = "1" ] && echo SKIP || echo ACTIVE)" "SKIP_TOOLS_AUDIT=1"
    _checklist_row "2"    "Create worktrees"         "COND"  "if parallel stories exist"
    _checklist_row "3a"   "Primary agent"            "COND"  "if primary stories"
    _checklist_row "3b"   "Independent agent"        "COND"  "if independent stories"
    _checklist_row "3.1"  "Worktree health check"    "COND"  "if worktrees created"
    _checklist_row "3.2"  "Merge worktrees"          "COND"  "if worktrees created"
    _checklist_row "3.5"  "Post-parallel assessment" "$([ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ] && echo SKIP || echo ACTIVE)" "$([ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ] && echo SKIP_SKILL_ASSESSMENT=1 || true)"
    _checklist_row "3.7"  "Pre-review gate"          "$([ "${SKIP_PRE_REVIEW_GATE:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_PRE_REVIEW_GATE=true"
    _checklist_row "3.8"  "Lint gate"                "$([ "${SKIP_LINT_GATE:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_LINT_GATE=true"
    _checklist_row "4"    "Review stories"           "COND"  "if review stories exist"
    _checklist_row "4.2a" "SAST sentinel"            "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.2b" "Spec validator"           "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.3a" "Review ranger"            "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.3b" "Mutant hunter"            "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.4a" "Fuzz-weaver"              "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.4b" "Perf sentinel"            "$([ "${SKIP_TESTING_GATES:-false}" = "true" ] && echo SKIP || echo ACTIVE)" "SKIP_TESTING_GATES=true"
    _checklist_row "4.6"  "Browser E2E routing"     "$([ "${SKIP_BROWSER_E2E_ROUTING:-false}" = "true" ] && echo SKIP || echo COND)" "SKIP_BROWSER_E2E_ROUTING=true"

    local skips=0
    for key in "0" "0.1" "0.5" "0.6" "0.7" "0.8" "0.9" "1" "1.5" "1.6" "1.65" "1.66" "2" "3a" "3b" "3.1" "3.2" "3.5" "3.7" "4" "4.2a" "4.2b" "4.3a" "4.3b" "4.4a" "4.4b" "4.6"; do
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

# record_story_actual_cost <story_id> <log_file>
# Extracts cost_usd from the story's JSONL log output and writes it back to
# prd.json as .actualCost so estimates-vs-actuals can be compared per story.
record_story_actual_cost() {
    local story_id="$1"
    local log_file="$2"
    [ -f "$log_file" ] || return 0
    # Extract cost from JSONL lines: epam run --json emits lines with cost_usd field
    local actual_cost
    actual_cost=$(grep -o '"cost_usd":[0-9.]*\|"total_cost_usd":[0-9.]*' "$log_file" 2>/dev/null \
        | tail -1 | grep -o '[0-9.]*$' || echo "")
    # Fallback: sum all task_cost_usd records for this story from phase-cost.jsonl
    if [ -z "$actual_cost" ] || [ "$actual_cost" = "0" ]; then
        local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
        if [ -f "$cost_file" ]; then
            actual_cost=$(jq -rs --arg sid "$story_id" \
                '[.[] | select(.story_id == $sid) | .task_cost_usd // 0] | add // 0' \
                "$cost_file" 2>/dev/null || echo "")
        fi
    fi
    [ -z "$actual_cost" ] && return 0
    [ "$actual_cost" = "0" ] && [ -z "$(grep -c 'cost_usd' "$log_file" 2>/dev/null)" ] && return 0
    # Write actualCost back to prd.json for this story
    local prd="${MAIN_PRD_FILE:-$PRD_FILE}"
    if [ -f "$prd" ]; then
        local tmp
        tmp=$(mktemp)
        jq --arg sid "$story_id" --argjson cost "$actual_cost" \
            '(.stories[] | select(.id == $sid)) |= (.actualCost = $cost)' \
            "$prd" > "$tmp" && mv "$tmp" "$prd" || rm -f "$tmp"
    fi
}

# run_orch_prompt <prompt> [agent_type] [story_id]
# Runs a pipeline agent prompt, tracks cost to phase-cost.jsonl (GAP-P22),
# and returns the text output.
run_orch_prompt() {
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

    # Run with JSON output so we can capture cost/token data
    local _rc=0
    echo "$prompt_text" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        CLAUDE_CMD="$CLAUDE_CMD" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        ORCH_JSON_RESULT="$json_result_file" \
        "$AI_RUNNER_CMD" --provider "$gate_provider" "${model_args[@]}" || _rc=$?

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
        rm -f "$json_result_file"
    fi

    return $_rc
}

# run_orch_prompt_with_tools <prompt> [agent_type] [story_id]
# Identical to run_orch_prompt but enables ReadFile + Bash tool access for the agent.
# Required for QA gate agents that must read source files to ground their analysis:
# sast-sentinel, spec-validator, review-ranger, mutant-hunter, fuzz-weaver, perf-sentinel.
# Without tool access these agents hallucinate findings about files they cannot verify.
run_orch_prompt_with_tools() {
    AI_GATE_ALLOW_TOOLS=1 run_orch_prompt "$@"
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
    _stale_pid=$(lsof -ti "tcp:${CONTROL_PLANE_PORT:-8094}" 2>/dev/null || true)
    if [ -n "$_stale_pid" ]; then
        warning "Killing stale process on port ${CONTROL_PLANE_PORT:-8094} (PID $_stale_pid)"
        kill "$_stale_pid" 2>/dev/null || true
        sleep 0.3
    fi
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
    [ -z "$current_model" ] && return 0

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
    [ -z "$ladder" ] && return 0

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
    [ -z "$new_model" ] && return 0

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
    if jq "${jq_args[@]}" "$jq_filter" "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        local _swap_reason="ladder step"
        [ "$new_model" = "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && _swap_reason="top-of-ladder fallback"
        warning "Watchdog: hot-swapping $story_id model after timeout ($_swap_reason): '$current_model' -> '$new_model'${new_provider:+ (provider -> $new_provider)}"
    else
        rm -f "$tmp_prd"
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

    local _analyst_response
    _analyst_response=$(run_orch_prompt_with_tools "$_prompt" "story_recovery" "$story_id" 2>/dev/null)
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
    local _verdict="pass"
    if [ -n "${ORCH_GATE_PROVIDER:-}" ]; then
        local _src_reviewer_profile
        _src_reviewer_profile=$(jq -r '."prd-change-reviewer" // ""' "$AGENT_PROFILES_FILE" 2>/dev/null || echo "")
        if [ -n "$_src_reviewer_profile" ]; then
            _verdict=$(echo "${_src_reviewer_profile}

STORY: ${story_id}
CHANGE TYPE: ac_patch

BEFORE:
${_before_acs:0:1000}

AFTER:
${_candidate:0:1000}

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
# Effort-based defaults (overridden by STORY_TIMEOUT_SECS):
#   low    → 600s  (10 min)
#   medium → 1200s (20 min)
#   high   → 2400s (40 min)
#   *      → 900s  (15 min)
run_story_with_watchdog() {
    local story_id="$1"
    local log_file="$2"
    local _rc=0

    # Determine timeout: explicit override wins, else scale by effort
    local timeout_secs
    if [ -n "${STORY_TIMEOUT_SECS:-}" ]; then
        timeout_secs="$STORY_TIMEOUT_SECS"
    else
        local story_effort
        story_effort=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .effort // "medium"' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "medium")
        case "$story_effort" in
            low)    timeout_secs=600  ;;
            medium) timeout_secs=1200 ;;
            high)   timeout_secs=2400 ;;
            *)      timeout_secs=900  ;;
        esac
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
        warning "Watchdog: $story_id timed out after ${timeout_secs}s — retrying once with an extended ${retry_timeout_secs}s budget..."
        hot_swap_story_model_if_unstable "$story_id"
        set +e
        timeout "$retry_timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee -a "$log_file"
        _rc=${PIPESTATUS[0]}
        set -e
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

# Block until the PAUSED sentinel is removed (operator resumes via dashboard).
# Checks every 5 seconds; logs a reminder every 60 seconds.
wait_if_paused() {
    if [ ! -f "$LOG_DIR/PAUSED" ]; then
        return
    fi
    local _waited=0
    local _max="${EPAM_MAX_PAUSE_SECS:-300}"
    warning "Orchestration PAUSED — waiting for resume signal (auto-resume in ${_max}s)..."
    warning "  Resume: POST http://localhost:${CONTROL_PLANE_PORT}/resume"
    warning "  Abort:  DELETE $LOG_DIR/PAUSED then kill the orchestration process"
    while [ -f "$LOG_DIR/PAUSED" ]; do
        sleep 5
        _waited=$(( _waited + 5 ))
        if (( _waited % 60 == 0 )); then
            warning "Still paused (${_waited}s / ${_max}s max). POST http://localhost:${CONTROL_PLANE_PORT}/resume to continue."
        fi
        # Hard ceiling — auto-resume after EPAM_MAX_PAUSE_SECS to prevent indefinite hangs
        if [ "$_waited" -ge "$_max" ]; then
            warning "Auto-resuming after ${_max}s pause ceiling — continuing past paused story."
            rm -f "$LOG_DIR/PAUSED" 2>/dev/null || true
            break
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

# ── Sandbox bootstrap ─────────────────────────────────────────────────────────
if [ "${EPAM_SANDBOX:-false}" = "true" ]; then
    SANDBOX_INVOKE="$SCRIPT_DIR/lib/sandbox-invoke.sh"
    SANDBOX_IMAGE="${EPAM_SANDBOX_IMAGE:-epam-cli-sandbox:latest}"
    SANDBOX_DOCKERFILE="$SCRIPT_DIR/Dockerfile.sandbox"
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
        log "[sandbox] Building image ${SANDBOX_IMAGE} from ${SANDBOX_DOCKERFILE}..."
        "$_RUNTIME" build -t "$SANDBOX_IMAGE" -f "$SANDBOX_DOCKERFILE" "$SCRIPT_DIR" \
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
    if [ -n "${PHASE:-}" ]; then
        # Scoped reset: only touch stories in implementationOrder[PHASE]
        jq --arg phase "$PHASE" '
          (.implementationOrder[$phase] // []) as $ids |
          (.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed"))
            |= (.completed = false | .status = "pending") |
          (.phases[]?.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed"))
            |= (.completed = false | .status = "pending")' \
            "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
        success "Stories reset to pending (phase: $PHASE)"
    else
        # Global reset: no phase scoping
        jq '(.stories[]? | select(.completed == true or .status == "failed")) |= (.completed = false | .status = "pending") |
            (.phases[]?.stories[]? | select(.completed == true or .status == "failed")) |= (.completed = false | .status = "pending")' \
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
    step_emit "0" "running" "Step 0: Specification pass"
    log "Step 0: Running specification pass for phase '$phase_id'..."
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
    append_pipeline_cost_record "spec-pass" "$phase_id" \
        "${ORCH_GATE_MODEL:-qwen/qwen3-coder-30b-a3b-instruct}" "$_spec_started" \
        "0" "0" "0" "0" 2>/dev/null || true
    # Surface openspec/speckit as visible checklist sub-steps instead of only
    # showing as "spec-mode: fast-path ..." log lines buried inside Step 0's
    # own log — parses the summary spec-mode-runner.js already writes
    # (summary.stats.agents: {agentName: invocationCount}) for a real story
    # count per agent; model comes from the same env vars the runner itself
    # uses (SPEC_MODE_OPENSPEC_MODEL/SPEC_MODE_SPECKIT_MODEL).
    local _spec_summary="$LOG_DIR/spec-summary.json"
    local _openspec_model="${SPEC_MODE_OPENSPEC_MODEL:-moonshotai/kimi-k2}"
    local _speckit_model="${SPEC_MODE_SPECKIT_MODEL:-moonshotai/kimi-k2}"
    local _openspec_count=0 _speckit_count=0
    if [ -f "$_spec_summary" ]; then
        _openspec_count=$(jq -r '.stats.agents.openspec // 0' "$_spec_summary" 2>/dev/null || echo 0)
        _speckit_count=$(jq -r '.stats.agents.speckit // 0' "$_spec_summary" 2>/dev/null || echo 0)
    fi

    if [ $spec_rc -eq 0 ]; then
        step_emit "0" "pass" "Step 0: Specification pass"
        step_emit "0a" "pass" "  openspec (elaboration)" "${_openspec_model}, ${_openspec_count} stor(y/ies)"
        step_emit "0b" "pass" "  speckit (verification)" "${_speckit_model}, ${_speckit_count} stor(y/ies)"
        success "Step 0: Specification pass completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "specification_pass" \
            "Specification agents completed (OpenSpec/Speckit)" "" "main" "spec-coordinator" 2>/dev/null || true
    else
        step_emit "0" "fail" "Step 0: Specification pass"
        step_emit "0a" "fail" "  openspec (elaboration)" "${_openspec_model}"
        step_emit "0b" "fail" "  speckit (verification)" "${_speckit_model}"
        error "Step 0: Specification pass FAILED for '$phase_id' — all agent invocations failed."
        error "  Check EPAM_ORCHESTRATION_PROVIDER is set and supported by ai-run.sh."
        error "  See: $LOG_DIR/spec-${phase_id}.log"
        exit 1
    fi
}

if [ "$DRY_RUN" = true ]; then
    step_emit "0" "skip" "Step 0: Specification pass" "dry-run"
    step_emit "0a" "skip" "  openspec (elaboration)" "dry-run"
    step_emit "0b" "skip" "  speckit (verification)" "dry-run"
    info "Step 0: Specification pass skipped during --dry-run"
elif [ "${EPAM_SPEC_MODE:-1}" = "0" ]; then
    step_emit "0" "skip" "Step 0: Specification pass" "EPAM_SPEC_MODE=0"
    step_emit "0a" "skip" "  openspec (elaboration)" "EPAM_SPEC_MODE=0"
    step_emit "0b" "skip" "  speckit (verification)" "EPAM_SPEC_MODE=0"
    info "Step 0: Specification pass disabled (EPAM_SPEC_MODE=0)"
else
    run_specification_pass "$PHASE"
fi

# Story-ID-loss invariant: snapshot the settled post-spec-pass story set for
# this phase. See capture_story_ids_snapshot's own docstring above for why.
capture_story_ids_snapshot "presplit"

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
    step_emit "0.1" "running" "Step 0.1: CPA pre-pass"
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
            step_emit "0.1" "pass" "Step 0.1: CPA pre-pass"
            success "Step 0.1: CPA gate PASSED for phase '$PHASE'"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_pass" \
                "CPA gate passed — all stories cleared" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        2)
            step_emit "0.1" "warn" "Step 0.1: CPA pre-pass" "elevated risk — review"
            warning "Step 0.1: CPA gate REVIEW — some stories have elevated risk"
            warning "  Check: $LOG_DIR/cpa-${PHASE}.log"
            warning "  Continuing (use STRICT_CPA=1 to halt on review gates)"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_review" \
                "CPA gate REVIEW — proceeding with warnings" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        3)
            step_emit "0.1" "fail" "Step 0.1: CPA pre-pass"
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
        step_emit "0.1" "skip" "Step 0.1: CPA pre-pass" "SKIP_CPA=1"
        info "Step 0.1: CPA pre-pass skipped (SKIP_CPA=1)"
    else
        step_emit "0.1" "skip" "Step 0.1: CPA pre-pass" "script not found"
        info "Step 0.1: CPA script not found — skipping pre-pass"
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
     select((.agentGroup == "main" or .agentGroup == "preflight") and .completed == false) | .id' "$PRD_FILE")

primary_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "primary" and .completed == false) | .id' "$PRD_FILE")

independent_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "independent" and .completed == false) | .id' "$PRD_FILE")

review_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentRole == "review-agent" and .completed == false) | .id' "$PRD_FILE")

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
            _router_model=$(echo "$_router_out" | jq -r '.model // "qwen/qwen3-coder-30b-a3b-instruct"' 2>/dev/null || echo "qwen/qwen3-coder-30b-a3b-instruct")
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
            "0:spec" "0a:openspec" "0b:speckit" "0.1:cpa" "0.5:skill-pre" "0.6:hybrid-coord" "0.7:regression" \
            "0.8:mkdir" "0.9:model-coord" "1:main-stories" "1.5:auto-commit" "1.6:tc-writer" \
            "2:worktrees" "3a:primary" "3b:independent" "3.1:wt-health" \
            "3.2:wt-merge" "3.5:skill-post" "3.7:pre-review" "3.8:lint-gate" \
            "4:review-stories" "4.2a:sast" "4.2b:spec-val" \
            "4.3a:review-ranger" "4.3b:mutant-hunter" \
            "4.4a:fuzz-weaver" "4.4b:perf-sentinel" "4.6:e2e"; do
            local _key="${_sid%%:*}"
            local _st="${_STEP_STATUS[$_key]:-pending}"
            local _lbl="${_STEP_LABELS[$_key]:-$_key}"
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
    # shellcheck disable=SC2287
    assessment_prompt=$(cat << PROMPT_HEADER
You are the skill assessment agent running in PRE-PHASE mode. Your job is to deeply reason about what each assigned agent will need to succeed — not just check a list of requiredSkills, but actively anticipate pitfalls given the tech stack, file types, and implementation patterns the stories demand. You augment agent profiles with the specific knowledge needed to avoid failures before they happen.

## PRD STRUCTURE (read this carefully before issuing any jq commands)
The PRD file uses a FLAT structure — not nested phases. Key paths:
- Story list: .stories[]
- Phase story order: .implementationOrder["${phase_id}"] — returns an array of story IDs
- Story lookup: .stories[] | select(.id == "<id>")
- Agent role field: .agentRole on each story object
- Files field: .technicalNotes.files[] on each story object

DO NOT use .phases[0] — that path does not exist in this PRD.

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
      - Update ${PRD_REL} with the split and assign agentRoles on both children
   d. Otherwise assign the most appropriate role from profiles.json based on the story's tech stack
   e. Write the assigned agentRole back to the story in ${PRD_REL}

4. PROFILE CREATION — For any agentRole assigned in step 3 that does NOT exist as a key in profiles.json:
   a. Read the project context from ${PRD_REL} (projectName, techStack, constraints)
   b. Read the story's technicalNotes to understand the testing conventions for this project
   c. Generate a new profile string for that role that includes: project name, test framework + version, module system (CJS vs ESM), mock patterns (vi.stubGlobal vs vi.spyOn), forbidden packages, constructor signatures, vitest config path and include pattern, and the instruction that this agent ONLY writes test files — never implementation files
   d. Add the new profile as a key in profiles.json
   e. Append a JSONL record to orchestrations/logs/profiles-audit.jsonl:
      {"timestamp":"<ISO8601>","phase_id":"<phase>","agent_role":"<role>","event":"profile_created","skill":"test-engineering","skill_category":"testing","context":"Story <id> requires dedicated test agent","added_by":"pre-phase-assessment"}

5. PROACTIVE SKILL INFERENCE — For each story's agentRole, reason beyond the requiredSkills list. Read the story's full technicalNotes, acceptanceCriteria, and files. Then ask: given this tech stack and these implementation patterns, what are the specific pitfalls an agent is likely to walk into that are NOT already covered in the profile?

   Infer gaps by reasoning about the code the agent will write, not just the labels in requiredSkills. Examples of the reasoning required:
   - Story uses native fetch (Node 18+) with TypeScript strict mode → infer: agent may import from 'node-fetch' as a type source, which conflicts with the global fetch types and causes TS7022 cascades. Add explicit rule to profile.
   - Story writes a function returning a union type (success | error) → infer: agent may omit the explicit return type annotation, causing TypeScript to fail to narrow the union at call sites. Add rule.
   - Story writes variables inside a do-while or complex ternary → infer: agent may rely on TypeScript to infer types through complex control flow; add rule to annotate explicitly.
   - Story uses vi.stubGlobal for fetch mocking → infer: agent may write untyped mock parameters, causing noImplicitAny errors. Add rule.
   - Story writes CLI argument parsing with process.stderr output → infer: agent may use console.error instead of process.stderr.write, breaking test spies. Add rule.
   - Story writes an Express route handler with optional numeric query params → infer: agent may pass number|undefined where number is required without explicit type narrowing. Add rule.
   - Story has multiple deliverable files (e.g. cli.ts AND cli.test.ts) → infer: agent may write implementation first and run out of context before writing the test. Add rule: write test file first.

   For each inferred gap, append a targeted skill to the agent's profile in profiles.json. Be specific and actionable — state the exact rule, not a general category.

5b. QA AGENT SKILL INJECTION — After inferring implementation gaps, also inject project-specific context into the QA agent profiles (sast-sentinel, review-ranger, spec-validator, mutant-hunter). These agents run against every phase and must know the project's actual file structure and conventions to avoid hallucinating findings about non-existent code. For each QA agent profile:
   a. Read the current list of source files: find . -name "*.ts" -not -path "*/node_modules/*"
   b. Append to sast-sentinel profile: the exact list of source files it is authorized to report findings on. Any finding referencing a file not in this list must be suppressed as a hallucination.
   c. Append to review-ranger profile: the exact list of exported symbols (from grep -rn "^export" src/ --include="*.ts") that exist. Any finding about an untested function must reference a symbol from this list — findings about non-existent functions are hallucinations and must be suppressed.
   d. Append to both: the project's test file naming convention (*.test.ts in src/) and the fact that a function tested in any test file in src/ counts as covered — not just a dedicated file.

6. EXPLICIT SKILL GAP FILL — After proactive inference, also do the traditional check:
   a. Compare each story's technicalNotes.requiredSkills against the agent's profile text
   b. For any skills explicitly listed but not covered in the profile, append them
   c. Append a JSONL record for each addition: {"timestamp":"<ISO8601>","phase_id":"<phase>","agent_role":"<role>","event":"skill_added","skill":"<skill>","skill_category":"<category>","context":"Story <id> requires <skill>","added_by":"pre-phase-assessment"}
   d. Use flock when writing to JSONL files

7. Write a summary to orchestrations/logs/phase-improvements/pre-<phase_id>.md. Include a section "Inferred Gaps" listing every proactively added skill and the reasoning chain that led to it.

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

CRITICAL RULES:
- Keep profiles.json valid JSON at all times. Only ADD to existing profile strings, never remove content.
- A test-engineer profile must instruct the agent to ONLY write test files — never touch implementation files.
- The same agentRole must NEVER appear on both an implementation story and its paired test story in the same phase.
- Inferred skill additions must be specific and actionable (a concrete rule the agent can follow), not vague capability claims.
- NEVER write example API keys, tokens, or secrets into any source file — not even as placeholders. If example values are needed in documentation, use the pattern \`process.env.SKYSCANNER_API_KEY\` or the literal string \`YOUR_API_KEY_HERE\`. Any string matching \`/sk-[a-z]+-[a-zA-Z0-9]+/\` or resembling a credential will trigger a SAST blocker.
- NEVER modify package.json, tsconfig.json, vitest.config.ts, or any other scaffold-phase infrastructure file. These are owned by the scaffold phase and are immutable to all subsequent phases. If a story appears to require changing these files, flag it as a blocker in skills-gap-report.jsonl instead.
- NEVER rewrite the PRD file (${PRD_REL}) with a different story structure. You may only update agentRole fields and append to profiles.json. Any other structural change to the PRD is forbidden.
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

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): the prompt above
    # instructs the agent to run real jq commands against the PRD, read/write
    # profiles.json, and flock-append to JSONL files — without tool access the
    # agent can only print what it WOULD do, and no real change ever lands
    # (found live 2026-07-08, same class of bug already fixed for run_plan_mode
    # and claude.sh's run_pre_phase_assessment).
    if run_orch_prompt_with_tools "$assessment_prompt" "assessment" "${PHASE:-unknown}" 2>&1 | tee "$assessment_log"; then
        step_emit "0.5" "pass" "Step 0.5: Skill assessment"
        success "Pre-phase assessment completed for '$phase_id'"
        "$SCRIPT_DIR/update-monitor.sh" event "pre_phase_assessment" "Pre-phase assessment completed" "" "main" "team-lead-agent" 2>/dev/null || true
        # Validate profiles.json is still valid JSON
        if ! jq empty "$profiles_file" 2>/dev/null; then
            error "Pre-phase assessment corrupted profiles.json! Restoring backup."
            cp "$profiles_backup" "$profiles_file"
            return 1
        fi

        # Reviewer gate — Step 0.5 can create brand-new profiles from scratch
        # and append arbitrary skill rules to existing ones (typescript-engineer,
        # sast-sentinel, review-ranger, etc). The jq-empty check above only
        # catches JSON syntax corruption; this catches bad CONTENT before it
        # reaches every agent invocation for the rest of the run.
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
                        warning "  [pre-phase-assessment] Profile changes REJECTED by reviewer — reverting profiles.json"
                        echo "$_pfa_profiles_before" > "$profiles_file" 2>/dev/null || true
                    else
                        success "  [pre-phase-assessment] Profile changes approved by reviewer"
                    fi
                fi
            fi
        fi
    else
        step_emit "0.5" "warn" "Step 0.5: Skill assessment" "non-critical"
        warning "Pre-phase assessment failed for '$phase_id' (non-critical, continuing)"
    fi
}

step_emit "0.5" "running" "Step 0.5: Skill assessment"
log "Step 0.5: Running pre-phase skill assessment..."
if [ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ]; then
    step_emit "0.5" "skip" "Step 0.5: Skill assessment" "SKIP_SKILL_ASSESSMENT=1"
    log "Step 0.5: Skipped (SKIP_SKILL_ASSESSMENT=1)"
else
    run_pre_phase_assessment "$PHASE"
fi
assert_no_story_ids_lost "presplit" "Step 0.5: Skill assessment"
assert_no_story_ids_gained "presplit" "Step 0.5: Skill assessment"
assert_no_illegitimate_deprecation "presplit" "Step 0.5: Skill assessment"

# ── Mid-execution split validation ────────────────────────────────────────────
# Speckit must review ALL splits, not only those proposed by openspec during
# the spec pass (Step 0). The pre-phase assessment agent (Step 0.5) may write
# new stories directly to the PRD. Validate those before execution begins.
validate_mid_execution_splits() {
    local _phase_id="$1"
    local _spec_runner="$SCRIPT_DIR/spec-mode-runner.js"
    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"

    if [ ! -f "$_spec_runner" ] || ! command -v "$_node_cmd" >/dev/null 2>&1; then
        return 0
    fi

    # Find stories in implementationOrder for this phase that have createdFrom set
    # but have NOT been speckit-validated (i.e., mid-execution splits)
    local _new_split_ids
    _new_split_ids=$(jq -r \
        --arg phase "$_phase_id" \
        '(.implementationOrder[$phase] // []) as $order |
         .stories[] |
         select(
           (.id as $id | $order | index($id) != null) and
           (.specification.createdFrom != null) and
           (.specification.speckitValidated != true) and
           (.specification.splitRejected != true)
         ) | .id' \
        "$PRD_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//')

    if [ -z "$_new_split_ids" ]; then
        log "  [split-gate] No unvalidated mid-execution splits for phase '$_phase_id'"
        return 0
    fi

    log "  [split-gate] Running speckit on mid-execution splits: $_new_split_ids"
    set +e
    PRD_FILE="$PRD_FILE" OUTPUT_DIR="$LOG_DIR" \
        AI_RUNNER_CMD="$AI_RUNNER_CMD" \
        EPAM_ORCHESTRATION_PROVIDER="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}" \
        SPEC_MODE_PROVIDER="${SPEC_MODE_PROVIDER:-}" \
        SPEC_MODE_SPECKIT_MODEL="${SPEC_MODE_SPECKIT_MODEL:-}" \
        PHASE="$_phase_id" ORCH_RUN_ID="$ORCH_RUN_ID" \
        "$_node_cmd" "$_spec_runner" --validate-splits "$PRD_FILE" "$_new_split_ids" \
        2>&1 | tee "$LOG_DIR/split-validate-${_phase_id}.log"
    local _sv_exit=${PIPESTATUS[0]}
    set -e
    if [ "$_sv_exit" -ne 0 ]; then
        warning "  [split-gate] Split validation found hard violations — check $LOG_DIR/split-validate-${_phase_id}.log"
    else
        success "  [split-gate] Mid-execution splits validated for phase '$_phase_id'"
    fi
}

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
    if run_orch_prompt_with_tools "$coord_prompt" "spec-coordinator" "${PHASE:-unknown}" 2>&1 | tee "$coord_log"; then
        step_emit "0.6" "pass" "Step 0.6: Hybrid pre-coord"
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
    step_emit "0.6" "skip" "Step 0.6: Hybrid pre-coord" "ORCH_MODE=${RESOLVED_ORCH_MODE}"
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
        step_emit "0.7" "running" "Step 0.7: Regression guard"
        log "Step 0.7: Cross-phase regression guard (vitest)..."
        _rg_log="$LOG_DIR/regression-guard-${PHASE}.log"
        set +e
        "$_rg_node" "$PROJECT_ROOT/node_modules/.bin/vitest" run \
            --root "$PROJECT_ROOT" > "$_rg_log" 2>&1
        _rg_rc=$?
        set -e
        if [ $_rg_rc -ne 0 ]; then
            step_emit "0.7" "fail" "Step 0.7: Regression guard"
            error "Step 0.7: Regression guard FAILED — tests broken before phase '$PHASE' starts"
            error "  Fix failing tests from the previous phase before continuing."
            error "  See: $_rg_log"
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
        step_emit "0.7" "pass" "Step 0.7: Regression guard"
        success "Step 0.7: Regression guard PASSED — baseline tests green"
    else
        step_emit "0.7" "skip" "Step 0.7: Regression guard" "node/vitest not found"
        info "Step 0.7: Regression guard skipped — node or vitest not found"
    fi
else
    step_emit "0.7" "skip" "Step 0.7: Regression guard" "SKIP_REGRESSION_GUARD=true"
    info "Step 0.7: Regression guard skipped (SKIP_REGRESSION_GUARD=true)"
fi

# ──────────────────────────────────────────────
# Step 0.8: Ensure standard src/ subdirectories exist so M3 can write into them
# without relying on the model creating the directory first.
# ──────────────────────────────────────────────
step_emit "0.8" "running" "Step 0.8: mkdir src/ dirs"
mkdir -p "$PROJECT_ROOT/src" "$PROJECT_ROOT/src/skyscanner" "$PROJECT_ROOT/public" "$PROJECT_ROOT/review" 2>/dev/null || true
step_emit "0.8" "pass" "Step 0.8: mkdir src/ dirs"

# ──────────────────────────────────────────────
# Step 0.9: PRD model coordinator — ensures every pending story (base +
# split children created by the spec pass) has explicit model, aiProvider,
# and reasoningEffort fields written into the PRD itself. Without this,
# split children silently fall back to a provider's hardcoded default model
# (e.g. MiniMax-M2.5 instead of MiniMax-M3) because they inherit no fields
# from their parent story. The PRD, not env vars or provider defaults, is
# the single source of truth for per-story model assignment.
# ──────────────────────────────────────────────
step_emit "0.9" "running" "Step 0.9: PRD model coordinator"
if [ "${SKIP_PRD_MODEL_COORDINATOR:-0}" = "1" ]; then
    info "  [prd-model-coordinator] Skipped (SKIP_PRD_MODEL_COORDINATOR=1)"
    step_emit "0.9" "skip" "Step 0.9: PRD model coordinator" "SKIP_PRD_MODEL_COORDINATOR=1"
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

        _mc_prompt=$(cat << ENDPROMPT_MC
$(cat "$_mc_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('prd-model-coordinator',''))" 2>/dev/null)

PRD file: ${_mc_prd_target}
Phase: ${_mc_phase}

Assign model, aiProvider, and reasoningEffort to every pending story in this phase that is missing one or more of these fields. Write the updated PRD back to the file, then emit the JSON summary.
ENDPROMPT_MC
)
        _mc_result=$(echo "$_mc_prompt" | \
            AI_GATE_ALLOW_TOOLS=1 \
            AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
            AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
            EPAM_DANGEROUS_SKIP_APPROVAL=1 \
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
            printf '%s' "$_mc_prd_before" > "$_mc_before_file"
            printf '%s' "$_mc_prd_after" > "$_mc_after_file"
            _mc_verdict=$(python3 - "$_mc_before_file" "$_mc_after_file" << 'MC_REVIEW_PY'
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
                warning "  [prd-model-coordinator] REJECTED by reviewer — reverting PRD"
                echo "$_mc_prd_before" > "$_mc_prd_target" 2>/dev/null || true
            else
                success "  [prd-model-coordinator] ${_mc_assigned_count} stor(y/ies) assigned model/aiProvider/reasoningEffort (reviewer approved)"
            fi
        else
            info "  [prd-model-coordinator] No assignments made (agent found nothing to do or failed)"
        fi
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
step_emit "0.9" "pass" "Step 0.9: PRD model coordinator"
assert_no_story_ids_lost "presplit" "Step 0.9: PRD model coordinator"
assert_no_story_ids_gained "presplit" "Step 0.9: PRD model coordinator"
assert_no_illegitimate_deprecation "presplit" "Step 0.9: PRD model coordinator"

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
     select(.completed == false) |
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

    # Per-story TypeScript compile gate — runs tsc --noEmit after each story succeeds.
    # Catches TS errors at the responsible story rather than at phase level (step 3.7).
    # Bypassed when: tsconfig.json not yet present, SKIP_STORY_TSC_GATE=1, or test-only stories.
    story_tsc_gate() {
        local _sid="$1"
        [ "${SKIP_STORY_TSC_GATE:-0}" = "1" ] && return 0
        [ ! -f "$PROJECT_ROOT/tsconfig.json" ] && return 0
        # Skip when no .ts source files exist yet (scaffold phase creates structure but no source)
        local _ts_count
        _ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l)
        [ "$_ts_count" -eq 0 ] && return 0
        # Skip tsc gate for test-only stories (they extend existing files, not create TS modules)
        local _role
        _role=$(jq -r --arg id "$_sid" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null)
        [ "$_role" = "test-engineer" ] && return 0

        local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
        [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"
        local _tsc_log="$LOG_DIR/tsc-gate-${_sid}.log"

        set +e
        cd "$PROJECT_ROOT" && "$_node_cmd" ./node_modules/.bin/tsc --noEmit 2>&1 | tee "$_tsc_log"
        local _tsc_exit=${PIPESTATUS[0]}
        set -e

        if [ "$_tsc_exit" -ne 0 ]; then
            error "  [tsc-gate] $story: TypeScript errors after story completed — story marked failed"
            error "  [tsc-gate] Fix required before next story runs. Log: ${_tsc_log##*/}"
            return 1
        fi
        success "  [tsc-gate] $story: tsc --noEmit passed"
        return 0
    }

    if [ -n "$non_review_main" ]; then
        step_emit "1" "running" "Step 1: Main-branch stories"
    log "Step 1: Running main-branch stories..."
        _phase_story_failures=0
        while IFS= read -r story; do
            [ -z "$story" ] && continue
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
            _story_current_status=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .status // "pending"' \
                "$PRD_FILE" 2>/dev/null || echo "pending")
            if [ "$_story_current_status" = "deprecated" ]; then
                info "  Skipping $story — deprecated after being enqueued (mid-execution split rejected this story)"
                continue
            fi
            if checkpoint_already_done "$story"; then
                info "  Skipping $story — already completed in checkpoint (run: $ORCH_RUN_ID)"
                continue
            fi
            check_cost_budget
            wait_if_paused
            apply_redirect_if_any "$story"

            # Inline TC writer gate: the OLD placement (after this entire loop,
            # even after Step 3.2 worktree merge) is structurally too late for
            # main-branch topology — this loop runs impl AND test stories
            # back-to-back in implementationOrder, so by the time the
            # post-loop gate ran, every test story here had ALREADY executed
            # without any testCriteria grounding (confirmed live, 2026-07-08:
            # SKY-002-test started implementing while testCriteria was still
            # null, and the gate's own log line never appeared until after
            # the whole batch — SKY-003-test, etc. — had also already run).
            # Fix: run the (idempotent, phase-scoped) TC writer HERE, right
            # before a story that itself needs TCs executes, so its paired
            # impl story (which just ran earlier in this same loop) grounds
            # it. The later post-Step-3.2 call is kept as-is for worktree-
            # topology test stories, which never pass through this loop.
            #
            # Root cause this fixes (found live, 2026-07-10, tier3-travel-app
            # run): "any file ends in .test.ts" also matches a COMBO story
            # that owns BOTH its own impl file(s) AND its own test file (an
            # unsplit story implementing both together in one turn, e.g.
            # SKY-002 when spec-pass chose not to split it this run) — this
            # gate then assumed a paired impl story had ALREADY run and tried
            # to generate TCs for source files that don't exist yet (the
            # combo story hasn't even started), hard-aborting the whole
            # pipeline. A story only needs pre-grounding from a SEPARATE impl
            # story when ALL its declared files are test files — same
            # "is this a pure test story" convention already used by
            # correctSplitChildAgentRoleIfTestOnly/wireSplitSiblingDependencies
            # in spec-mode-runner.js (all files match, not any).
            # Root cause this fixes (found live, 2026-07-10, tier3-travel-app
            # run): a story can legitimately become 'deprecated' AFTER this
            # gate would otherwise match it — e.g. a mid-execution re-split
            # rejected for a same-file coherence violation (both children
            # write to server.test.ts) deprecates the story with no valid
            # replacement. The TC-writer script already defensively skips
            # deprecated stories (a stale/delegated-parent guard), so it
            # correctly no-ops — but this gate never checked status, so it
            # still expected TCs for a story that was CORRECTLY abandoned,
            # tripping the post-condition check below on a false alarm.
            _needs_tc=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | select(.status != "deprecated") |
                 select((.technicalNotes.files // []) as $f |
                        ($f | length > 0) and ($f | map(endswith(".test.ts")) | all)) |
                 select((.testCriteria.facts // []) | length == 0) | .id' \
                "$PRD_FILE" 2>/dev/null || echo "")
            if [ -n "$_needs_tc" ]; then
                log "  Story $story needs testCriteria — running TC writer inline before it starts..."
                bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
                    --prd "$PRD_FILE" \
                    --phase "$PHASE" \
                    --output-dir "${OUTPUT_DIR:-$PROJECT_ROOT}" \
                    --story "$story" \
                    2>&1 | tee -a "$LOG_DIR/tc-writer-${PHASE}.log"
                _inline_tc_exit=${PIPESTATUS[0]}
                if [ "$_inline_tc_exit" -ne 0 ]; then
                    error "  Inline TC writer gate FAILED for $story — cannot proceed"
                    error "  Fix: check $LOG_DIR/tc-writer-${PHASE}.log"
                    error "  Bypass: SKIP_TC_WRITER=1"
                    exit 1
                fi
                # Post-condition check (found live, 2026-07-09): post-impl-tc-writer.sh
                # can exit 0 as a legitimate no-op ("No test stories need TCs in
                # phase ... — skipping") when its OWN internal implementationOrder[phase]-
                # scoped query doesn't (yet) see $story — e.g. right after a mid-execution
                # split. Exit 0 alone does not mean testCriteria was actually written for
                # THIS story — confirmed live: SKY-003-test got this exact "SUCCESS" log
                # line while its testCriteria.facts remained empty, and it then ran its
                # first coding attempt with zero grounding.
                _post_tc_facts_len=$(jq -r --arg id "$story" \
                    '.stories[] | select(.id == $id) | (.testCriteria.facts // []) | length' \
                    "$PRD_FILE" 2>/dev/null || echo 0)
                if [ "${_post_tc_facts_len:-0}" -eq 0 ]; then
                    error "  Inline TC writer gate reported success but $story still has no testCriteria.facts"
                    error "  Fix: check $LOG_DIR/tc-writer-${PHASE}.log ; confirm $story is in implementationOrder.$PHASE"
                    error "  Bypass: SKIP_TC_WRITER=1"
                    exit 1
                fi
                success "  TC writer populated testCriteria for $story"
            fi

            log "  Running: $story"
            _story_exit=0
            run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log" || _story_exit=$?
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
            else
                # Story reported success — verify TypeScript still compiles before moving on
                story_tsc_gate "$story" || _phase_story_failures=$((_phase_story_failures+1))
            fi
            checkpoint_complete "$story"
            # Validate any splits the agent registered mid-execution before the next story runs
            validate_mid_execution_splits "$PHASE"
        done <<< "$non_review_main"
        if [ "$_phase_story_failures" -gt 0 ]; then
            step_emit "1" "fail" "Step 1: Main-branch stories"
            error "Phase '$PHASE': $_phase_story_failures story/stories failed — aborting phase"
            exit 1
        fi
        step_emit "1" "pass" "Step 1: Main-branch stories"
        success "Main-branch stories complete"
    fi
else
    step_emit "1" "skip" "Step 1: Main-branch stories" "no stories in lane"
    info "Step 1: No main-branch stories to run"
fi

# ──────────────────────────────────────────────
# Step 1.5: Auto-commit any main-branch story output so worktrees inherit it.
# Real agents may commit via git tools, but mock/epam-run agents only write files.
# Without this commit, worktrees created from HEAD lack the main-branch deliverables,
# causing tests that import shared code (e.g. greet.ts) to fail in the worktrees.
# ──────────────────────────────────────────────
_has_worktree_stories=false
{ [ -n "${primary_stories:-}" ] || [ -n "${independent_stories:-}" ]; } && _has_worktree_stories=true
if [ "$_has_worktree_stories" = true ] && \
   [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]; then
    step_emit "1.5" "running" "Step 1.5: Auto-commit"
    log "Step 1.5: Auto-committing main-branch deliverables before worktree creation..."
    git -C "$PROJECT_ROOT" add -A 2>/dev/null || true
    # Generic credential scan (flow-gap analysis finding #2, 2026-07-12): see
    # orchestrations/scripts/scan-secrets.sh for rationale/patterns.
    if [ -f "$SCRIPT_DIR/scan-secrets.sh" ] && ! _scan_output=$(bash "$SCRIPT_DIR/scan-secrets.sh" "$PROJECT_ROOT" 2>&1); then
        warning "Step 1.5: $_scan_output"
        step_emit "1.5" "fail" "Step 1.5: Auto-commit" "secret detected"
        error "Step 1.5: Refusing to auto-commit — unstaging (SECRET_SCAN)"
        git -C "$PROJECT_ROOT" reset 2>/dev/null || true
    else
        git -C "$PROJECT_ROOT" commit -m "chore: auto-commit main-branch story output for phase $PHASE" \
            2>/dev/null \
            && { step_emit "1.5" "pass" "Step 1.5: Auto-commit"; success "Step 1.5: Committed main-branch output"; } \
            || { step_emit "1.5" "skip" "Step 1.5: Auto-commit" "nothing to commit"; warning "Step 1.5: Nothing new to commit (working tree already clean)"; }
    fi
else
    step_emit "1.5" "skip" "Step 1.5: Auto-commit" "already clean"
    info "Step 1.5: No uncommitted main-branch changes — skipping auto-commit"
fi
# ──────────────────────────────────────────────
# Step 1.6 (TC writer gate) has moved — see after Step 3.2 below. Running it
# here (before Step 3's worktree implementation) meant it ALWAYS found zero
# source files for any phase using worktree topology, since main-branch Step 1
# is empty in that case ("no stories in lane") and the real implementation
# only exists after Step 3a/3b run and Step 3.2 merges them back. Confirmed
# live: this hard-aborted the entire core phase before implementation ever ran.
# ──────────────────────────────────────────────
need_worktrees=false
[ -n "$primary_stories" ] && need_worktrees=true
[ -n "$independent_stories" ] && need_worktrees=true

if [ "$need_worktrees" = true ]; then
    step_emit "2" "running" "Step 2: Create worktrees"
    log "Step 2: Creating git worktrees..."
    "$CLAUDE_SH" --setup-worktrees || { error "Failed to create worktrees"; exit 1; }
    step_emit "2" "pass" "Step 2: Create worktrees"
else
    step_emit "2" "skip" "Step 2: Create worktrees" "no parallel stories"
    info "Step 2: No worktree stories — skipping worktree creation"
fi

# ──────────────────────────────────────────────
# Step 3: Launch parallel agents
# ──────────────────────────────────────────────
PRIMARY_PID=""
INDEPENDENT_PID=""

if [ -n "$primary_stories" ]; then
    step_emit "3a" "running" "Step 3a: Primary agent"
    log "Step 3a: Starting primary agent..."
    "$CLAUDE_SH" --worktree primary --phase "$PHASE" \
        > "$LOG_DIR/wt-primary.log" 2>&1 &
    PRIMARY_PID=$!
    info "  Primary agent PID: $PRIMARY_PID"
fi

if [ -n "$independent_stories" ]; then
    step_emit "3b" "running" "Step 3b: Independent agent"
    log "Step 3b: Starting independent agent..."
    "$CLAUDE_SH" --worktree independent --phase "$PHASE" \
        > "$LOG_DIR/wt-independent.log" 2>&1 &
    INDEPENDENT_PID=$!
    info "  Independent agent PID: $INDEPENDENT_PID"
else
    step_emit "3b" "skip" "Step 3b: Independent agent" "no independent stories"
    info "Step 3b: No independent stories — skipping independent agent"
fi

# Wait for both agents
PRIMARY_EXIT=0
INDEPENDENT_EXIT=0

if [ -n "$PRIMARY_PID" ]; then
    log "Waiting for primary agent (PID $PRIMARY_PID)..."
    wait $PRIMARY_PID || PRIMARY_EXIT=$?
    if [ $PRIMARY_EXIT -eq 0 ]; then
        step_emit "3a" "pass" "Step 3a: Primary agent"
        success "Primary agent completed successfully"
    else
        step_emit "3a" "fail" "Step 3a: Primary agent"
        error "Primary agent failed with exit code $PRIMARY_EXIT"
        error "Check log: $LOG_DIR/wt-primary.log"
    fi
fi

if [ -n "$INDEPENDENT_PID" ]; then
    log "Waiting for independent agent (PID $INDEPENDENT_PID)..."
    wait $INDEPENDENT_PID || INDEPENDENT_EXIT=$?
    if [ $INDEPENDENT_EXIT -eq 0 ]; then
        step_emit "3b" "pass" "Step 3b: Independent agent"
        success "Independent agent completed successfully"
    else
        step_emit "3b" "fail" "Step 3b: Independent agent"
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
    step_emit "3.1" "running" "Step 3.1: Worktree health"
    log "Step 3.1: Worktree health check..."
    GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}" \
        PHASE="$PHASE" AUTO_COMMIT=true "$SCRIPT_DIR/worktree-health-check.sh" \
        2>&1 | tee "$LOG_DIR/worktree-health-${PHASE}.log"
    _health_exit=${PIPESTATUS[0]}
    if [ "$_health_exit" -ne 0 ]; then
        step_emit "3.1" "warn" "Step 3.1: Worktree health" "health issues auto-fixed"
        error "Worktree health check failed — see $LOG_DIR/worktree-health-${PHASE}.log"
        exit 1
    else
        step_emit "3.1" "pass" "Step 3.1: Worktree health"
    fi
else
    step_emit "3.1" "skip" "Step 3.1: Worktree health" "no worktrees"
    info "Step 3.1: No worktrees — skipping health check"
fi

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
        git -C "$_merge_git_root" clean -fd 2>/dev/null || true

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
        error "Step 3.2: One or more worktree merges failed — review conflicts before next phase"
        error "  Worktrees preserved for inspection. Re-run with --skip-cleanup to debug."
        exit 1
    else
        success "Step 3.2: All worktree branches merged back successfully"
    fi
else
    info "Step 3.2: No worktrees — skipping merge-back"
fi

# Now that any completed stories' commits have had a chance to merge, fail the
# phase if a worktree agent reported a failed story earlier.
if [ "$WORKTREE_HAD_FAILURE" = true ]; then
    error "One or more stories failed in a worktree agent — phase '$PHASE' did not fully succeed"
    error "  (completed stories in the same lane, if any, were committed and merged above)"
    exit 1
fi

# ──────────────────────────────────────────────
# Step 1.6: Post-impl TC (test criteria) writer gate.
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
_tc_writer_needed=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) |
      select(
        (.technicalNotes.files // [] | map(endswith(".test.ts")) | any) and
        ((.testCriteria.facts // []) | length == 0)
      )] | length' "$PRD_FILE" 2>/dev/null || echo 0)

if [ "${_tc_writer_needed:-0}" -gt 0 ]; then
    step_emit "1.6" "running" "Step 1.6: TC writer gate"
    log "Step 1.6: TC writer gate — ${_tc_writer_needed} test story/stories need testCriteria..."
    # `if CMD | tee file; then` checks tee's exit code, not CMD's — tee almost
    # always exits 0, so this previously reported PASS even when the TC writer
    # agent itself failed. Use PIPESTATUS[0] to check the real exit code.
    bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
        --prd "$PRD_FILE" \
        --phase "$PHASE" \
        --output-dir "${OUTPUT_DIR:-$PROJECT_ROOT}" \
        2>&1 | tee "$LOG_DIR/tc-writer-${PHASE}.log"
    _tc_writer_exit=${PIPESTATUS[0]}
    if [ "$_tc_writer_exit" -eq 0 ]; then
        step_emit "1.6" "pass" "Step 1.6: TC writer gate"
        success "Step 1.6: TC writer gate PASSED — testCriteria populated"
    else
        step_emit "1.6" "fail" "Step 1.6: TC writer gate"
        error "Step 1.6: TC writer gate FAILED — cannot proceed to test stories"
        error "  Fix: check $LOG_DIR/tc-writer-${PHASE}.log"
        error "  Bypass: SKIP_TC_WRITER=1"
        exit 1
    fi
else
    step_emit "1.6" "skip" "Step 1.6: TC writer gate" "all TCs present"
    info "Step 1.6: TC writer gate — all test stories already have TCs or no test stories in phase"
fi

# ──────────────────────────────────────────────
# Step 1.65: Skills coordinator audit
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

if [ "${SKIP_SKILLS_AUDIT:-0}" = "1" ]; then
    step_emit "1.65" "skip" "Step 1.65: Skills coordinator audit" "SKIP_SKILLS_AUDIT=1"
else
    step_emit "1.65" "running" "Step 1.65: Skills coordinator audit"
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
            if run_orch_prompt_with_tools "$_sc_prompt" "skills_audit" "${PHASE:-unknown}" > "$LOG_DIR/skills-coordinator-${PHASE}.log" 2>&1; then
                if jq empty "$AGENT_PROFILES_FILE" 2>/dev/null; then
                    success "  [SkillsAudit] Rewrote contradictory note for [${_sc_role}]"
                else
                    error "  [SkillsAudit] skills-coordinator corrupted profiles.json! Restoring pre-audit snapshot."
                    echo "$_skills_before" > "$AGENT_PROFILES_FILE"
                fi
            else
                warning "  [SkillsAudit] skills-coordinator failed to rewrite note for [${_sc_role}] — leaving as-is"
            fi
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg role "$_sc_role" --arg note "$_sc_note" \
                '{timestamp:$ts, phase:$phase, role:$role, event:"contradiction_rewrite", flagged_note:$note}' \
                >> "$LOG_DIR/skills-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_skills_audit_result" | jq -c '.contradictions[]' 2>/dev/null)
    fi
    step_emit "1.65" "pass" "Step 1.65: Skills coordinator audit"
fi

# ──────────────────────────────────────────────
# Step 1.66: Tools coordinator audit
#
# Same rationale and shape as Step 1.65, applied to the dynamic-tools
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

if [ "${SKIP_TOOLS_AUDIT:-0}" = "1" ]; then
    step_emit "1.66" "skip" "Step 1.66: Tools coordinator audit" "SKIP_TOOLS_AUDIT=1"
else
    step_emit "1.66" "running" "Step 1.66: Tools coordinator audit"
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
            if run_orch_prompt_with_tools "$_tc_prompt" "tools_audit" "${PHASE:-unknown}" > "$LOG_DIR/tools-coordinator-${PHASE}.log" 2>&1; then
                if bash -n "$_tc_path" 2>/dev/null; then
                    success "  [ToolsAudit] Rewrote broken tool [${_tc_tool}]"
                else
                    error "  [ToolsAudit] tools-coordinator left ${_tc_tool}.sh syntactically broken! Restoring pre-audit snapshot."
                    echo "$_tc_before" > "$_tc_path"
                fi
            else
                warning "  [ToolsAudit] tools-coordinator failed to fix [${_tc_tool}] — leaving as-is"
            fi
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
    step_emit "1.66" "pass" "Step 1.66: Tools coordinator audit"
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

    # grep -c already prints "0" on zero matches while also exiting 1 — `|| echo 0`
    # would double-print ("0\n0"), breaking the numeric -eq test below.
    local phase_records
    phase_records=$({ grep -c "\"phase_id\":\"$phase_id\"" "$cost_file" 2>/dev/null || true; })
    if [ "${phase_records:-0}" -eq 0 ]; then
        warning "No cost records for phase '$phase_id' — skipping assessment"
        return 0
    fi

    info "Found $phase_records cost records for phase '$phase_id'"

    # Build assessment prompt
    # Real, verified-to-exist absolute paths for the prompt below -- found
    # live (2026-07-07): the prompt used to hardcode the literal relative
    # string "orchestrations/logs/phase-cost.jsonl", but LOG_DIR (where
    # $cost_file/$assessment_file actually live) is
    # "${OUTPUT_DIR:-$AUTOMATION_DIR/logs}", which in the tier3 setup IS
    # PROJECT_ROOT directly, not a nested "orchestrations/logs"
    # subdirectory of it. After the agent `cd`s to PROJECT_ROOT below, that
    # literal path pointed at a directory structure that doesn't exist --
    # the agent was GUESSING because it was handed a made-up path, not a
    # real one, and ended up asking an unanswerable interactive question
    # instead of doing the work.
    local improvement_report_file="${improvement_dir}/${phase_id}.md"
    # Generic, project-supplied skill-domain guidance (see
    # _build_skill_domain_guidance's own docstring) -- falls back to a
    # conservative, non-stack-specific instruction when no
    # .epam/skill-domain-map.json is configured, rather than ever guessing
    # or hardcoding a keyword list here.
    local _skill_domain_guidance
    _skill_domain_guidance=$(_build_skill_domain_guidance "$PROJECT_ROOT")
    [ -z "$_skill_domain_guidance" ] && _skill_domain_guidance="not configured for this project (.epam/skill-domain-map.json) — use conservative judgment; only reassign a role when the mismatch between the task description and assigned agentRole is unambiguous"
    local assessment_prompt
    assessment_prompt=$(cat << PROMPT_EOF
You are the skill assessment agent. Analyze the phase cost data and produce an assessment.

## Phase: $phase_id

## Task
1. Read $cost_file and filter for phase_id="$phase_id"
   IMPORTANT: The log accumulates records across multiple runs. For each story_id, use ONLY the
   most recent record (highest started_at timestamp). Discard all earlier records for the same story_id.
2. Cross-reference each story's status against ${PRD_REL}: if the story has "completed": true in the
   PRD, treat it as succeeded regardless of older cost-log entries. The PRD is the source of truth for
   current completion state; the cost log is used only for timing/cost figures from the latest run.
3. For each task (using latest record only), compare elapsed_minutes vs forecast_hours (converted to minutes)
4. Calculate phase-level totals and variance
5. Write a single-line JSON assessment to $assessment_file with fields:
   phase_id, phase_name, actual_minutes, forecast_minutes, actual_cost_usd, forecast_cost_usd,
   variance_minutes, variance_cost_usd, over_threshold (bool), agent_recommendations (array), notes
6. Write a human-readable improvement report to $improvement_report_file
7. CORRECTIVE ACTION: If any task's description clearly requires a different skill domain than the assigned agentRole,
   update ${PRD_REL} to change agentRole for FUTURE phase stories that have the same mismatch.
   - Only modify stories that are status "pending" and completed false
   - Only modify stories in phases AFTER the current phase (do NOT modify completed phase stories)
   - When changing agentRole, preserve the original value in the "originalAgentRole" field (already present)
   - Document every role change in the improvement report
   - Skill domain indicators: $_skill_domain_guidance

Use flock when appending to JSONL files. If all tasks were within forecast, note "No improvements needed."
PROMPT_EOF
    )

    log "Running assessment agent for phase '$phase_id'..."
    local assessment_log="$LOG_DIR/assessment-${phase_id}.log"

    # Backup prd.json before assessment modifies it
    cp "$PRD_FILE" "${PRD_FILE}.pre-assessment"
    log "Backed up prd.json to ${PRD_FILE}.pre-assessment"

    # Snapshot how many records already exist for this phase BEFORE the call
    # -- needed to tell a genuinely NEW assessment apart from an old one left
    # over from an earlier run (see the real-evidence check below).
    # grep -c prints "0" (correctly) but exits 1 on zero matches; `|| true`
    # (not `|| echo 0`) neutralizes that under this script's `set -e`
    # without double-printing (same class of bug fixed earlier this session
    # in compute_retry_extension_evidence).
    local _assessment_count_before
    _assessment_count_before=$(grep -c "\"phase_id\":\"$phase_id\"" "$assessment_file" 2>/dev/null || true)
    _assessment_count_before="${_assessment_count_before:-0}"

    cd "$PROJECT_ROOT"
    # run_orch_prompt_with_tools (not plain run_orch_prompt): this prompt
    # instructs writing a report file, updating the PRD's agentRole fields, and
    # flock-appending to JSONL — same class of bug already fixed above for the
    # pre-phase (Step 0.5) assessment call.
    #
    # PIPESTATUS[0] (not the pipeline's own exit code): this script has no
    # `set -o pipefail`, so `if cmd | tee file; then` was ALWAYS evaluating
    # tee's exit status (virtually always 0), never run_orch_prompt_with_
    # tools's real one -- a tool-call failure could never be detected at
    # all. Capture the first command's real exit status explicitly instead.
    run_orch_prompt_with_tools "$assessment_prompt" "assessment" "${PHASE:-unknown}" 2>&1 | tee "$assessment_log"
    local _assessment_rc=${PIPESTATUS[0]}

    if [ "$_assessment_rc" -ne 0 ]; then
        warning "Phase assessment failed for '$phase_id' (non-critical)"
        return 1
    fi

    # Deterministic evidence check (found live, 2026-07-07): a successful
    # exit code alone doesn't mean the agent actually did the work -- it can
    # exit 0 after asking an unanswerable interactive question instead of
    # writing anything. Verify a genuinely NEW assessment record was
    # appended for THIS phase, not just trust the exit code.
    local _assessment_count_after
    _assessment_count_after=$(grep -c "\"phase_id\":\"$phase_id\"" "$assessment_file" 2>/dev/null || true)
    _assessment_count_after="${_assessment_count_after:-0}"

    if [ "$_assessment_count_after" -le "$_assessment_count_before" ]; then
        warning "Phase assessment for '$phase_id' completed but no new assessment record was written — agent may have failed to produce real output (see $assessment_log)"
        return 1
    fi

    success "Phase assessment completed for '$phase_id'"
    return 0
}

# Only run assessment if cost tracking data exists
if [ "${SKIP_SKILL_ASSESSMENT:-0}" = "1" ]; then
    step_emit "3.5" "skip" "Step 3.5: Post-parallel assessment" "SKIP_SKILL_ASSESSMENT=1"
    info "Step 3.5: Skipped (SKIP_SKILL_ASSESSMENT=1)"
elif [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    step_emit "3.5" "running" "Step 3.5: Post-parallel assessment"
    log "Step 3.5: Running post-parallel skill assessment..."
    if run_phase_assessment "$PHASE"; then
        step_emit "3.5" "pass" "Step 3.5: Post-parallel assessment"
    else
        step_emit "3.5" "warn" "Step 3.5: Post-parallel assessment" "non-critical issues"
    fi
else
    step_emit "3.5" "skip" "Step 3.5: Post-parallel assessment" "no cost data"
    info "Step 3.5: No cost data yet — skipping post-parallel assessment"
fi
assert_no_story_ids_lost "presplit" "Step 3.5: Post-parallel assessment"
assert_no_story_ids_gained "presplit" "Step 3.5: Post-parallel assessment"

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
    step_emit "3.7" "running" "Step 3.7: Pre-review gate"
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
                _pre_review_failed=1
            fi
        fi

        echo "=== Gate Result: $([ $_pre_review_failed -eq 0 ] && echo PASS || echo FAIL) ===" \
            >> "$_pre_review_log"

        if [ $_pre_review_failed -ne 0 ]; then
            step_emit "3.7" "fail" "Step 3.7: Pre-review gate"
            error "Step 3.7: Pre-review gate FAILED — review agents blocked on broken build"
            error "  Fix failures, then re-run: $0 --phase $PHASE"
            error "  Bypass (emergency only): SKIP_PRE_REVIEW_GATE=true $0 --phase $PHASE"
            error "  Log: $_pre_review_log"
            exit 1
        fi

        step_emit "3.7" "pass" "Step 3.7: Pre-review gate"
            success "Step 3.7: Pre-review gate PASSED"
    fi
else
    [ "${SKIP_PRE_REVIEW_GATE:-false}" = "true" ] && \
        step_emit "3.7" "skip" "Step 3.7: Pre-review gate" "SKIP_PRE_REVIEW_GATE=true"
        info "Step 3.7: Pre-review gate skipped (SKIP_PRE_REVIEW_GATE=true)"
fi

# ──────────────────────────────────────────────
# Step 3.8: Lint gate — tsc + eslint on PROJECT_ROOT/src
# Runs after the pre-review vitest/tsc gate and before review stories.
# Catches syntax and type errors that agents introduce during Step 1 so they
# don't propagate to expensive quality gates (SAST, perf-sentinel, etc.).
# Bypass: SKIP_LINT_GATE=true
# ──────────────────────────────────────────────
if [ "${SKIP_LINT_GATE:-false}" != "true" ] && [ -n "$_node_bin" ] && [ -x "$_node_bin" ]; then
    step_emit "3.8" "running" "Step 3.8: Lint gate"
    log "Step 3.8: Lint gate (tsc + eslint)..."
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
    _eslint_config=""
    if [ -n "$_eslint_bin" ]; then
        _probe_file="$PROJECT_ROOT/src/index.ts"
        [ -f "$_probe_file" ] || _probe_file="$(find "$PROJECT_ROOT/src" -name "*.ts" | head -1)"
        if [ -n "$_probe_file" ] && \
           cd "$PROJECT_ROOT" && "$_eslint_bin" --print-config "$_probe_file" > /dev/null 2>&1; then
            _eslint_config="confirmed"
        fi
    fi

    if [ -n "$_eslint_bin" ] && [ -n "$_eslint_config" ]; then
        log "  [lint] Running eslint src/..."
        _lint_eslint_exit=0
        cd "$PROJECT_ROOT" && "$_eslint_bin" src/ --max-warnings 0 2>&1 | tee -a "$_lint_log"
        _lint_eslint_exit=${PIPESTATUS[0]}
        if [ "$_lint_eslint_exit" -eq 0 ]; then
            success "  [lint] eslint: PASS"
        else
            error "  [lint] eslint: FAIL (exit $_lint_eslint_exit) — fix lint errors before proceeding"
            _lint_failed=1
        fi
    elif [ -n "$_eslint_bin" ]; then
        info "  [lint] eslint found but no config in PROJECT_ROOT — skipping eslint (tsc only)"
        echo "eslint: binary present but no config file found" >> "$_lint_log"
    else
        info "  [lint] eslint not found in project — skipping eslint (tsc only)"
        echo "eslint: not configured in project" >> "$_lint_log"
    fi

    echo "=== Gate Result: $([ "$_lint_failed" -eq 0 ] && echo PASS || echo FAIL) ===" >> "$_lint_log"

    if [ "$_lint_failed" -ne 0 ]; then
        step_emit "3.8" "fail" "Step 3.8: Lint gate"
        error "Step 3.8: Lint gate FAILED — running self-healing remediation pipeline..."

        # ── Self-healing: route lint failure through gate-finding-analyst ─────
        # Same three-agent pipeline as testing gates (step 4.2):
        #   Agent 1 (gate-finding-analyst):  extracts grounded finding from lint log
        #   Agent 2 (story-ac-remediator):   augments owning story ACs in PRD
        #   Agent 3 (profile-augmentor):     records anti-pattern in agent profile
        _lint_remediation_applied=0
        _lint_rem_log="$LOG_DIR/lint-remediation-${PHASE}.log"
        _profiles_file="${AUTOMATION_DIR}/agents/profiles.json"

        if [ "${SKIP_GATE_REMEDIATION:-0}" != "1" ] && [ -f "$_lint_log" ]; then
            info "  [lint-gate:analyst] Extracting grounded finding from lint log..."
            _lint_finding_prompt="$(cat <<LINT_FIND_EOF
You are the gate-finding-analyst. A lint gate (tsc --noEmit + eslint) failed during the '$PHASE' phase of an automated TypeScript project build.

## Lint Gate Log
$(cat "$_lint_log" 2>/dev/null | head -200)

## PRD Stories (active)
$(python3 -c "import json,sys; d=json.load(open('${MAIN_PRD_FILE:-$PRD_FILE}')); active=set(s for p in d['implementationOrder'].values() for s in p); [print(json.dumps({'id':s['id'],'title':s.get('title',''),'files':s.get('technicalNotes',{}).get('files',[])})) for s in d['stories'] if s['id'] in active]" 2>/dev/null | head -50)

## Agent Profile
$(cat "$_profiles_file" | python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('gate-finding-analyst',''))" 2>/dev/null)

Identify: which story owns the file with the lint/type error? Output JSON only:
{"gate":"lint","story_id":"<id>","file":"<path>","line":<n>,"rule":"<tsc-error-code or eslint-rule>","message":"<description>","suggested_fix":"<one-line fix>"}
LINT_FIND_EOF
)"
            _lint_finding_raw="$(echo "$_lint_finding_prompt" | \
                timeout 120 epam run --provider "${ORCH_GATE_PROVIDER:-anthropic}" \
                    --model "${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}" \
                    --json - 2>>"$_lint_rem_log" || echo "")"
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
                _lint_ac_raw="$(echo "$_lint_ac_prompt" | \
                    timeout 120 epam run --provider "${ORCH_GATE_PROVIDER:-anthropic}" \
                        --model "${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}" \
                        --json - 2>>"$_lint_rem_log" || echo "")"
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

                # Agent 3: profile-augmentor (fire-and-forget)
                info "  [lint-gate:augmentor] Recording lint anti-pattern in profile..."
                echo "$_lint_finding_raw" | \
                    timeout 60 epam run --provider "${ORCH_GATE_PROVIDER:-anthropic}" \
                        --model "${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}" \
                        --json - 2>>"$_lint_rem_log" || true
            else
                warning "  [lint-gate:analyst] Could not map lint failure to a story — skipping AC remediation"
            fi
        fi

        if [ "$_lint_remediation_applied" = "1" ]; then
            warning "Step 3.8: Lint gate remediation applied — caller should retry phase"
            error "Step 3.8: Lint gate FAILED — remediation applied, retry required"
            error "  Remediation log: $_lint_rem_log"
            exit 2  # exit 2 = remediated, tier3 runner resets and retries phase
        fi

        error "Step 3.8: Lint gate FAILED — fix errors before review proceeds"
        error "  Log: $_lint_log"
        error "  Bypass (emergency only): SKIP_LINT_GATE=true $0 --phase $PHASE"
        exit 1
    fi
    step_emit "3.8" "pass" "Step 3.8: Lint gate"
    success "Step 3.8: Lint gate PASSED"
else
    if [ "${SKIP_LINT_GATE:-false}" = "true" ]; then
        step_emit "3.8" "skip" "Step 3.8: Lint gate" "SKIP_LINT_GATE=true"
        info "Step 3.8: Lint gate skipped (SKIP_LINT_GATE=true)"
    else
        step_emit "3.8" "skip" "Step 3.8: Lint gate" "no node binary"
        info "Step 3.8: Lint gate skipped (node binary not found)"
    fi
fi

# ──────────────────────────────────────────────
# Step 4: Run review stories
# ──────────────────────────────────────────────
if [ -n "$review_stories" ]; then
    step_emit "4" "running" "Step 4: Review stories"
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
        record_story_actual_cost "$story" "$LOG_DIR/review-${story}.log"
    done <<< "$review_stories"
    if [ "${_review_failed:-0}" -gt 0 ]; then
        step_emit "4" "fail" "Step 4: Review stories"
    else
        step_emit "4" "pass" "Step 4: Review stories"
    fi
    success "Review stories complete"
else
    step_emit "4" "skip" "Step 4: Review stories" "no review stories"
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

    if [ "${SKIP_TESTING_GATES:-false}" = "true" ]; then
        step_emit "4.2a" "skip" "Step 4.2a: SAST sentinel" "SKIP_TESTING_GATES=true"
step_emit "4.2b" "skip" "Step 4.2b: Spec validator" "SKIP_TESTING_GATES=true"
step_emit "4.3a" "skip" "Step 4.3a: Review ranger" "SKIP_TESTING_GATES=true"
step_emit "4.3b" "skip" "Step 4.3b: Mutant hunter" "SKIP_TESTING_GATES=true"
step_emit "4.4a" "skip" "Step 4.4a: Fuzz-weaver" "SKIP_TESTING_GATES=true"
step_emit "4.4b" "skip" "Step 4.4b: Perf sentinel" "SKIP_TESTING_GATES=true"
step_emit "4.6"  "skip" "Step 4.6: Browser E2E" "SKIP_TESTING_GATES=true"
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
            step_emit "4.6" "skip" "Step 4.6: Browser E2E" "SKIP_BROWSER_E2E_ROUTING=true"
            info "  Step 4.6: Browser E2E routing skipped (SKIP_BROWSER_E2E_ROUTING=true)"
            return 0
        fi

        phase_ids=$(jq -r --arg phase "$phase_id" '(.implementationOrder[$phase] // [])[]' "$PRD_FILE" 2>/dev/null || true)
        if [ -z "$phase_ids" ]; then
            info "  Step 4.6: No phase stories for browser E2E routing"
            return 0
        fi

        step_emit "4.6" "running" "Step 4.6: Browser E2E"
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
            run_orch_prompt_with_tools "$prompt" "qa-gate:e2e" "${story_id:-unknown}" 2>&1 | tee "$story_log"
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
            step_emit "4.6" "skip" "Step 4.6: Browser E2E" "no stories matched"
            info "  Step 4.6: No stories matched browser E2E routing criteria"
        elif [ "$e2e_route_failed" -gt 0 ]; then
            step_emit "4.6" "fail" "Step 4.6: Browser E2E"
        else
            step_emit "4.6" "pass" "Step 4.6: Browser E2E"
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
    step_emit "4.2a" "running" "Step 4.2a: SAST sentinel"
    log "  Step 4.2a: Running SAST sentinel..."
    {
        local sast_prompt="You are acting as the sast-sentinel agent.

Phase: $phase_id
Project root: $PROJECT_ROOT

IMPORTANT: All evidence has been pre-computed and is injected above. Do NOT attempt to call any shell commands, bash, or tools. Analyze ONLY the injected Semgrep, npm audit, and TypeScript compiler data.

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

        run_orch_prompt_with_tools "$sast_prompt" "qa-gate:sast" "${PHASE:-unknown}" 2>&1 | tee "$sast_log"
    } &
    local sast_pid=$!

    # ── Spec Validator ──
    step_emit "4.2b" "running" "Step 4.2b: Spec validator"
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

        # ── Story Oracle: inject ACs from prd.json so agent doesn't need file tools ──
        local story_oracle=""
        story_oracle=$(python3 - "$PRD_FILE" "$phase_id" <<'PYEOF'
import sys, json
prd_path, phase_id = sys.argv[1], sys.argv[2]
try:
    with open(prd_path) as f:
        prd = json.load(f)
    phase_ids = prd.get('implementationOrder', {}).get(phase_id, [])
    story_map = {s['id']: s for s in prd.get('stories', [])}
    lines = ["Stories in phase '{}': {}".format(phase_id, len(phase_ids))]
    for sid in phase_ids:
        s = story_map.get(sid)
        if not s:
            continue
        completed = s.get('completed', False)
        status = s.get('status', '?')
        acs = s.get('acceptanceCriteria', [])
        lines.append("\n### {}: {} [status={}, completed={}]".format(sid, s.get('title','?'), status, completed))
        lines.append("AgentRole: {}".format(s.get('agentRole','?')))
        tn = s.get('technicalNotes')
        files = tn.get('files', []) if isinstance(tn, dict) else []
        if files:
            lines.append("Expected files: {}".format(', '.join(files)))
        lines.append("Acceptance criteria ({}):".format(len(acs)))
        for i, ac in enumerate(acs, 1):
            lines.append("  {}. {}".format(i, ac))
    print('\n'.join(lines))
except Exception as e:
    print("(story oracle error: {})".format(e))
PYEOF
2>/dev/null || echo "(story oracle unavailable)")
        spec_prompt="## Story Acceptance Criteria (hard evidence from prd.json — classify each criterion)
$story_oracle

$spec_prompt"

        run_orch_prompt_with_tools "$spec_prompt" "qa-gate:spec-validator" "${PHASE:-unknown}" 2>&1 | tee "$spec_log"
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
                step_emit "4.2a" "fail" "Step 4.2a: SAST sentinel"
                error "  SAST sentinel: FAIL verdict (could not parse blockerCount)"
                failed=1
                _failing_logs+=("$sast_log")
                _log_labels+=("sast-sentinel")
            else
                step_emit "4.2a" "warn" "Step 4.2a: SAST sentinel" "no parseable findings"
                success "  SAST sentinel: PASS (no parseable findings)"
            fi
        elif [ "$_sast_blockers" -gt 0 ]; then
            step_emit "4.2a" "fail" "Step 4.2a: SAST sentinel"
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
            step_emit "4.2a" "pass" "Step 4.2a: SAST sentinel"
            success "  SAST sentinel: PASS (blockerCount=$_sast_blockers)"
        fi
    fi

    if [ $spec_exit -ne 0 ]; then
        step_emit "4.2b" "fail" "Step 4.2b: Spec validator"
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
            step_emit "4.2b" "warn" "Step 4.2b: Spec validator" "no story data"
            warning "  Spec validator: WARN — agent returned no story data (oracle injection needed)"
        elif [ "$_spec_failing" -gt 0 ]; then
            step_emit "4.2b" "fail" "Step 4.2b: Spec validator"
            error "  Spec validator: FAIL — $_spec_failing story/stories failed criteria"
            failed=1
            # spec_exit=0 here (agent exited clean) — append explicitly so
            # self-heal remediation fires; see the SAST fix above for why.
            _failing_logs+=("$spec_log")
            _log_labels+=("spec-validator")
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"warn"' "$spec_log" 2>/dev/null; then
            step_emit "4.2b" "warn" "Step 4.2b: Spec validator" "partial"
            warning "  Spec validator: WARN — some criteria partially met (non-blocking)"
        elif grep -q '"overallVerdict"[[:space:]]*:[[:space:]]*"fail"' "$spec_log" 2>/dev/null; then
            step_emit "4.2b" "warn" "Step 4.2b: Spec validator" "ungrounded findings downgraded"
            warning "  Spec validator: FAIL verdict downgraded to WARN — every criterion in every failing story was self-reported as 'untestable' (agent had no real evidence, likely didn't use its tools; re-check manually)"
        else
            step_emit "4.2b" "pass" "Step 4.2b: Spec validator"
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
        step_emit "4.3a" "running" "Step 4.3a: Review ranger"
        log "  Step 4.3a: Running review-ranger..."
        {
            # ── Git diff oracle: inject changed files and their content ──
            local review_diff_summary=""
            local _git_bin
            _git_bin=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                local _diff_files
                _diff_files=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --name-only HEAD 2>/dev/null || \
                              "$_git_bin" diff --name-only HEAD~1 2>/dev/null || echo "")
                local _diff_stat
                _diff_stat=$(cd "$PROJECT_ROOT" && "$_git_bin" diff --stat HEAD 2>/dev/null || \
                             "$_git_bin" diff --stat HEAD~1 2>/dev/null || echo "(no diff available)")
                local _diff_patch
                _diff_patch=$(cd "$PROJECT_ROOT" && "$_git_bin" diff -U3 HEAD -- '*.ts' 2>/dev/null | head -300 || \
                              "$_git_bin" diff -U3 HEAD~1 -- '*.ts' 2>/dev/null | head -300 || echo "")
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
  \"findings\": [{ \"severity\": \"blocker|major|minor\", \"category\": \"...\", \"file\": \"...\", \"line\": N, \"description\": \"...\", \"suggestedFix\": \"...\" }],
  \"verdict\": \"pass|fail\"
}"

            if [ -n "$review_profile" ]; then
                review_prompt="$review_profile

$review_prompt"
            fi

            run_orch_prompt_with_tools "$review_prompt" "qa-gate:review-ranger" "${PHASE:-unknown}" 2>&1 | tee "$review_log"
        } &
        local review_pid=$!

        # ── Mutant Hunter ──
        step_emit "4.3b" "running" "Step 4.3b: Mutant hunter"
        log "  Step 4.3b: Running mutant-hunter..."
        {
            # ── Source + test oracle: inject changed files and test files ──
            local mutant_oracle_summary=""
            local _git_bin2
            _git_bin2=$(command -v git 2>/dev/null || true)
            if [ -n "$_git_bin2" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                set +e
                local _changed_src
                _changed_src=$(cd "$PROJECT_ROOT" && "$_git_bin2" diff --name-only HEAD -- '*.ts' 2>/dev/null | \
                               grep -v '\.test\.ts$' | head -10 || echo "")
                set -e
                local _src_content=""
                if [ -n "$_changed_src" ]; then
                    while IFS= read -r _f; do
                        [ -f "$PROJECT_ROOT/$_f" ] || continue
                        _src_content="$_src_content
--- $_f ---
$(head -100 "$PROJECT_ROOT/$_f" 2>/dev/null || echo '(unreadable)')"
                    done <<< "$_changed_src"
                fi
                local _test_files
                _test_files=$(find "$PROJECT_ROOT" -name "*.test.ts" -not -path "*/node_modules/*" 2>/dev/null | head -5)
                local _test_content=""
                while IFS= read -r _tf; do
                    [ -f "$_tf" ] || continue
                    _test_content="$_test_content
--- $_tf ---
$(head -60 "$_tf" 2>/dev/null || echo '(unreadable)')"
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
  \"mutations\": [{ \"file\": \"...\", \"line\": N, \"originalCode\": \"...\", \"mutatedCode\": \"...\", \"status\": \"killed|survived|no-coverage\", \"relatedTest\": \"...\", \"recommendation\": \"...\" }],
  \"verdict\": \"pass|warn|fail\"
}"

            if [ -n "$mutant_profile" ]; then
                mutant_prompt="$mutant_profile

$mutant_prompt"
            fi

            run_orch_prompt_with_tools "$mutant_prompt" "qa-gate:mutant-hunter" "${PHASE:-unknown}" 2>&1 | tee "$mutant_log"
        } &
        local mutant_pid=$!

        # Wait for both Phase B agents
        wait $review_pid || review_exit=$?
        wait $mutant_pid || mutant_exit=$?

        # Evaluate Phase B results
        if [ $review_exit -ne 0 ]; then
            step_emit "4.3a" "fail" "Step 4.3a: Review ranger"
            error "  Review-ranger FAILED (exit $review_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$review_log" 2>/dev/null; then
                step_emit "4.3a" "fail" "Step 4.3a: Review ranger"
                error "  Review-ranger: FAIL verdict — blocker findings detected"
                failed=1
                # review_exit=0 here (agent exited clean) — append explicitly so
                # self-heal remediation fires; see the SAST fix above for why.
                _failing_logs+=("$review_log")
                _log_labels+=("review-ranger")
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$review_log" 2>/dev/null; then
                step_emit "4.3a" "warn" "Step 4.3a: Review ranger" "non-blocking findings"
                warning "  Review-ranger: WARN — non-blocking findings (continuing)"
            else
                step_emit "4.3a" "pass" "Step 4.3a: Review ranger"
                success "  Review-ranger: PASS"
            fi
        fi

        if [ $mutant_exit -ne 0 ]; then
            step_emit "4.3b" "fail" "Step 4.3b: Mutant hunter"
            error "  Mutant-hunter FAILED (exit $mutant_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$mutant_log" 2>/dev/null; then
                step_emit "4.3b" "fail" "Step 4.3b: Mutant hunter"
                error "  Mutant-hunter: FAIL verdict — mutation score below threshold"
                failed=1
                # mutant_exit=0 here (agent exited clean) — append explicitly so
                # self-heal remediation fires; see the SAST fix above for why.
                _failing_logs+=("$mutant_log")
                _log_labels+=("mutant-hunter")
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$mutant_log" 2>/dev/null; then
                step_emit "4.3b" "warn" "Step 4.3b: Mutant hunter" "score 50-69%"
                warning "  Mutant-hunter: WARN — mutation score 50-69% (non-blocking)"
            else
                step_emit "4.3b" "pass" "Step 4.3b: Mutant hunter"
                success "  Mutant-hunter: PASS"
            fi
        fi
    else
        step_emit "4.3a" "skip" "Step 4.3a: Review ranger" "Phase A failed"
        step_emit "4.3b" "skip" "Step 4.3b: Mutant hunter" "Phase A failed"
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
        step_emit "4.4a" "running" "Step 4.4a: Fuzz-weaver"
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

For any case with status=\"vulnerability\", you MUST also include an
\"executableTest\" field: a complete, self-contained vitest test file (as a
single string) that imports the REAL function from its real relative path
and asserts the CORRECT/SAFE behavior for the specific input you claim is
mishandled — e.g. \`expect(parseAdults('0')).toBeNull()\`. Do NOT write a
test that asserts the bug exists; assert what SHOULD happen if the code is
correct. This file will be written to
\"$PROJECT_ROOT/.fuzz-verify/case-N.test.ts\" and actually executed — write
your import path relative to that location (e.g.
\`import { parseAdults } from '../src/server'\`). A vulnerability claim
without a real, executable test that actually exercises the real function
will be treated as unverified and will NOT block the pipeline — do not
guess at file contents you have not actually read with your tools.

Output format (strict JSON):
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

            run_orch_prompt_with_tools "$fuzz_prompt" "qa-gate:fuzz-weaver" "${PHASE:-unknown}" 2>&1 | tee "$fuzz_log"
        } &
        local fuzz_pid=$!

        # ── Perf Sentinel ──
        step_emit "4.4b" "running" "Step 4.4b: Perf sentinel"
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

            run_orch_prompt_with_tools "$perf_prompt" "qa-gate:perf-sentinel" "${PHASE:-unknown}" 2>&1 | tee "$perf_log"
        } &
        local perf_pid=$!

        # Wait for both Phase C agents
        wait $fuzz_pid || fuzz_exit=$?
        wait $perf_pid || perf_exit=$?

        # Evaluate Phase C results
        # Fuzz-weaver: validate that any "fail" verdict is grounded in real files.
        # An agent with no tool access will hallucinate findings about non-existent files.
        # We downgrade "fail" to "warn" when no vulnerability finding references a file
        # that actually exists under PROJECT_ROOT/src.
        if [ $fuzz_exit -ne 0 ]; then
            error "  Fuzz-weaver FAILED (exit $fuzz_exit)"
            failed=1
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
                    step_emit "4.4a" "fail" "Step 4.4a: Fuzz-weaver"
                    error "  Fuzz-weaver: FAIL — ${_fuzz_grounded} confirmed vulnerability/vulnerabilities (verified by actually running the agent's own test against the real code)"
                    failed=1
                    # fuzz_exit=0 here (agent exited clean) — append explicitly so
                    # self-heal remediation fires; see the SAST fix above for why.
                    _failing_logs+=("$fuzz_log")
                    _log_labels+=("fuzz-weaver")
                else
                    step_emit "4.4a" "warn" "Step 4.4a: Fuzz-weaver" "unverified findings downgraded"
                    warning "  Fuzz-weaver: FAIL verdict downgraded to WARN — no vulnerability finding could be verified by executing a real test against the real code (likely hallucinated; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$fuzz_log" 2>/dev/null; then
                step_emit "4.4a" "warn" "Step 4.4a: Fuzz-weaver" "gaps>30%"
            warning "  Fuzz-weaver: WARN — coverage gaps > 30% (non-blocking)"
            else
                step_emit "4.4a" "pass" "Step 4.4a: Fuzz-weaver"
                success "  Fuzz-weaver: PASS"
            fi
        fi

        if [ $perf_exit -ne 0 ]; then
            step_emit "4.4b" "fail" "Step 4.4b: Perf sentinel"
            error "  Perf-sentinel FAILED (exit $perf_exit)"
            failed=1
        else
            if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$perf_log" 2>/dev/null; then
                # Ground-truth check: a "fail" is only valid if the agent found real blocker
                # findings. An agent with no tool access reports verdict:fail with empty findings
                # and null/zero summary — downgrade these hallucinated fails to WARN.
                _perf_grounded=$(python3 - "$perf_log" << 'PERF_PYEOF'
import json, sys, re, os

log_file = sys.argv[1]
content = open(log_file).read()
json_match = re.search(r'\{.*"agent".*"perf-sentinel".*\}', content, re.DOTALL)
if not json_match:
    print("0"); sys.exit(0)

try:
    data = json.loads(json_match.group(0))
except Exception:
    print("0"); sys.exit(0)

summary = data.get("summary") or {}
blocker_count = summary.get("blockerCount", 0) if summary else 0
files_analysed = summary.get("filesAnalysed", 0) if summary else 0
findings = data.get("findings", [])
real_blockers = sum(1 for f in findings if str(f.get("severity","")).lower() == "blocker")

# Grounded = has actual blocker findings AND agent analysed at least one file
grounded = 1 if (real_blockers > 0 and (files_analysed > 0 or blocker_count > 0)) else 0
print(str(grounded))
PERF_PYEOF
2>/dev/null || echo "0")
                if [ "${_perf_grounded:-0}" -gt 0 ]; then
                    step_emit "4.4b" "fail" "Step 4.4b: Perf sentinel"
                    error "  Perf-sentinel: FAIL — confirmed performance blocker in analysed files"
                    failed=1
                    # perf_exit=0 here (agent exited clean) so _failing_logs won't pick it up
                    # via the exit-code check below — add it explicitly so remediation fires.
                    _failing_logs+=("$perf_log")
                    _log_labels+=("perf-sentinel")
                else
                    step_emit "4.4b" "warn" "Step 4.4b: Perf sentinel" "hallucinated fail downgraded"
                    warning "  Perf-sentinel: FAIL verdict downgraded to WARN — no blocker findings with analysed files (agent had no tool access; re-check manually)"
                fi
            elif grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$perf_log" 2>/dev/null; then
                step_emit "4.4b" "warn" "Step 4.4b: Perf sentinel" "concerns non-blocking"
                warning "  Perf-sentinel: WARN — performance concerns (non-blocking)"
            else
                step_emit "4.4b" "pass" "Step 4.4b: Perf sentinel"
                success "  Perf-sentinel: PASS"
            fi
        fi
    else
        step_emit "4.4a" "skip" "Step 4.4a: Fuzz-weaver" "Phase A/B failed"
step_emit "4.4b" "skip" "Step 4.4b: Perf sentinel" "Phase A/B failed"
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

        if [ "${SKIP_GATE_REMEDIATION:-0}" != "1" ] && [ ${#_failing_logs[@]} -gt 0 ]; then
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
                local _finding_json
                _finding_json=$(echo "$_finding_prompt" | \
                    AI_GATE_ALLOW_TOOLS=1 \
                    AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                    AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                    CLAUDE_CMD="$CLAUDE_CMD" \
                    EPAM_CLI="${EPAM_CLI:-epam}" \
                    "$AI_RUNNER_CMD" \
                        --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                        --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    2>&1 | tee -a "$_rem_log")

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
                    # "story: complete <id> (N file(s))" (see claude.sh's
                    # post-story commit step). Ask git who last touched the
                    # finding's file instead of asking the LLM to guess.
                    local _gf_file
                    _gf_file=$(grep -o '"file"[[:space:]]*:[[:space:]]*"[^"]*"' "$_glog" 2>/dev/null | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
                    if [ -n "$_gf_file" ] && [ -f "$_gf_file" ]; then
                        local _gf_commit_subject
                        _gf_commit_subject=$(git -C "$PROJECT_ROOT" log --follow -1 --format=%s -- "$_gf_file" 2>/dev/null || echo "")
                        _story_id=$(echo "$_gf_commit_subject" | grep -oP 'story: complete \K\S+' 2>/dev/null || echo "")
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
                local _ac_result
                _ac_result=$(echo "$_ac_prompt" | \
                    AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                    AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    EPAM_CLI="${EPAM_CLI:-epam}" \
                    "$AI_RUNNER_CMD" \
                        --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                        --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    2>&1 | tee -a "$_rem_log")

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
                local _prof_result
                _prof_result=$(echo "$_prof_prompt" | \
                    AI_GATE_ALLOW_TOOLS=1 \
                    AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                    AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                    CLAUDE_CMD="$CLAUDE_CMD" \
                    EPAM_CLI="${EPAM_CLI:-epam}" \
                    "$AI_RUNNER_CMD" \
                        --provider "${ORCH_GATE_PROVIDER:-minimax}" \
                        --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
                    2>&1 | tee -a "$_rem_log")

                if echo "$_prof_result" | grep -q '"profile_updated"[[:space:]]*:[[:space:]]*true'; then
                    local _profiles_after
                    _profiles_after=$(cat "$_profiles_file" 2>/dev/null || echo "{}")
                    # Trust the DISK STATE, not the agent's own claim (fixed
                    # 2026-07-11, same class of defect already fixed for
                    # story-ac-remediator): the agent has real Bash/WriteFile
                    # tool access and is instructed to "write the updated
                    # profiles.json back, then emit the JSON summary" — but an
                    # LLM claiming "profile_updated": true in its text response
                    # is not the same as it having actually called a write
                    # tool. If profiles.json is byte-identical to before this
                    # call despite the claim, nothing was really persisted;
                    # proceeding to the reviewer/apply-flag logic below would
                    # mark remediation as applied for a change that never
                    # happened.
                    if [ "$_profiles_after" = "$_profiles_before" ]; then
                        warning "  [profile-augmentor] Claimed profile_updated:true but profiles.json is unchanged on disk — treating as no-op, not applied"
                        continue
                    fi
                    # Reviewer gate — validate the change before accepting it
                    local _reviewer_profile
                    _reviewer_profile=$(echo "$_profiles_after" | \
                        python3 -c "import sys,json; p=json.load(sys.stdin); print(p.get('prd-change-reviewer',''))" 2>/dev/null || echo "")
                    local _review_verdict="pass"
                    if [ -n "${ORCH_GATE_PROVIDER:-}" ] && [ -n "$_reviewer_profile" ]; then
                        _review_verdict=$(echo "${_reviewer_profile}

STORY: gate-remediation
CHANGE TYPE: profile_addendum

BEFORE (excerpt, last 500 chars):
${_profiles_before: -500}

AFTER (excerpt, last 500 chars):
${_profiles_after: -500}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}" | \
                            AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \
                            AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
                            EPAM_CLI="${EPAM_CLI:-epam}" \
                            "$AI_RUNNER_CMD" \
                                --provider "${ORCH_GATE_PROVIDER:-minimax}" \
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
        step_emit "6" "pass" "Step 6: Final post-phase assessment"
    else
        step_emit "6" "warn" "Step 6: Final post-phase assessment" "non-critical issues"
    fi
else
    info "Step 6: No cost data — skipping final post-phase assessment"
fi
assert_no_story_ids_lost "presplit" "Step 6: Final post-phase assessment"
assert_no_story_ids_gained "presplit" "Step 6: Final post-phase assessment"

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
