#!/bin/bash

# EPAM CLI Orchestration Script - AI-driven development loop
# This script orchestrates Claude Code CLI for autonomous story implementation
#
# Usage:
#   ./claude.sh                      # Implement next stories (priority order)
#   ./claude.sh --phase phase1       # Implement all stories in a phase
#   ./claude.sh --list-phases        # Show available phases
#   ./claude.sh US-001 US-002        # Implement specific stories
#   ./claude.sh --dry-run            # Show what would be implemented
#   ./claude.sh --status             # Show current PRD status
#   ./claude.sh --interactive        # Run with permission prompts (safer)
#
# Note: By default, runs with --dangerously-bypass-approvals-and-sandbox for autonomous operation.
#       Use --interactive flag if you want to approve each file operation.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
# Respect PROJECT_ROOT from environment (set by run-agent-orchestration.sh when PRD_FILE is external)
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$AUTOMATION_DIR")}"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
LOG_DIR="${OUTPUT_DIR:-$AUTOMATION_DIR/logs}"
PROGRESS_LOG="$LOG_DIR/progress.txt"
AGENTS_FILE="$AUTOMATION_DIR/agents/AGENTS.md"
CLAUDE_OUTPUT_DIR="$LOG_DIR/claude_outputs"
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
MONITOR_STATUS_FILE="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"
export MONITOR_FILE="$MONITOR_STATUS_FILE"
export ACTIVITY_FILE="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}"

load_env_file() {
    local env_file="$1"
    [ -f "$env_file" ] || return 0
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
}

# Save caller-set gate overrides BEFORE loading .env so tier-script values survive.
# .env contains stale defaults; the tier script intentionally overrides them at runtime.
_claude_pre_gate_provider="${ORCH_GATE_PROVIDER:-}"
_claude_pre_gate_model="${ORCH_GATE_MODEL:-}"
_claude_pre_orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"

load_env_file "$(dirname "$AUTOMATION_DIR")/.env"
load_env_file "$PROJECT_ROOT/.env"

# Restore: tier-script values win over .env defaults
[ -n "$_claude_pre_gate_provider" ] && ORCH_GATE_PROVIDER="$_claude_pre_gate_provider"
[ -n "$_claude_pre_gate_model"    ] && ORCH_GATE_MODEL="$_claude_pre_gate_model"
[ -n "$_claude_pre_orch_provider" ] && EPAM_ORCHESTRATION_PROVIDER="$_claude_pre_orch_provider"
unset _claude_pre_gate_provider _claude_pre_gate_model _claude_pre_orch_provider
export ORCH_GATE_PROVIDER ORCH_GATE_MODEL EPAM_ORCHESTRATION_PROVIDER

# Git work root — the directory containing .git (defaults to PROJECT_ROOT)
# Override when the git repo lives in a subdirectory (e.g., PROJECT_ROOT/application)
GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}"

# Worktree configuration (set by --worktree flag)
WORKTREE_MODE=""        # "primary", "independent", or "" for main
MAIN_PRD_FILE=""        # Points to main repo's prd.json when in worktree mode
REVIEW_PHASE=""         # Phase name for --review-phase mode
CURRENT_PHASE=""        # Current phase being executed (for cost tracking)

# Configuration
CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # Allow override via environment
EPAM_CLI="${EPAM_CLI:-epam}"        # epam-cli binary; override with mock for testing
MAX_RETRIES="${EPAM_MAX_RETRIES:-7}"
RETRY_DELAY=5
# Orchestration mode — inherited from run-agent-orchestration.sh or set directly
ORCH_MODE="${ORCH_MODE:-bash}"
# SDK invocation mode — when 1, routes Claude provider calls through invoke.py
# using the Anthropic Python SDK instead of the claude CLI.
# All other providers (opencode, codex, copilot, openai, qwen, cursor) are unaffected.
# Requires: pip install -r orchestrations/scripts/requirements.txt
# and ANTHROPIC_API_KEY to be set in the environment.
EPAM_SDK_INVOKE="${EPAM_SDK_INVOKE:-0}"
INVOKE_PY="$SCRIPT_DIR/invoke.py"
INVOKE_PYTHON="${INVOKE_PYTHON:-$SCRIPT_DIR/.venv/bin/python3}"
# Fall back to system python3 if venv not present
[ -x "$INVOKE_PYTHON" ] || INVOKE_PYTHON="python3"

# Effort -> model + max-turns mapping
# Stories carry an optional "effort" field: low | medium (default) | high
# These map to a model and a max-turns cap for the Claude CLI invocation.
EFFORT_MODEL_LOW="gpt-5-codex"
EFFORT_MODEL_MEDIUM="gpt-5-codex"
EFFORT_MODEL_HIGH="gpt-5-codex"
# Set by resolve_planner_settings; empty means single-invocation mode (no split)
STORY_PLANNER_MODEL=""
# Set by resolve_effort_settings; controls EPAM_MAX_ITERATIONS for epam-run stories.
# Low=6 (write 2 files + tsc + vitest + one fix), medium=10, high=15
STORY_MAX_ITERATIONS=6
# Set by resolve_effort_settings; controls EPAM_MAX_OUTPUT_TOKENS for epam-run stories.
STORY_MAX_OUTPUT_TOKENS=3072
# Set by resolve_generator_settings; true when agentRole=generator (pure file creation, no context reads).
STORY_GENERATOR_MODE=""

# resolve_effort_settings <story_id>
# Sets STORY_MODEL and STORY_MAX_TURNS globals based on story's effort field.
resolve_effort_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local effort
    effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .effort // "medium"' \
        "$prd_target" 2>/dev/null || echo "medium")

    case "$effort" in
        low)
            STORY_MODEL="$EFFORT_MODEL_LOW"
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=6
            STORY_MAX_OUTPUT_TOKENS=3072
            ;;
        high)
            STORY_MODEL="$EFFORT_MODEL_HIGH"
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=15
            STORY_MAX_OUTPUT_TOKENS=6144
            ;;
        *)  # medium (default)
            STORY_MODEL="$EFFORT_MODEL_MEDIUM"
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=10
            STORY_MAX_OUTPUT_TOKENS=6144
            ;;
    esac
    log "  Effort[$effort] -> model=$(basename $STORY_MODEL) turns=${STORY_MAX_TURNS:-unlimited} maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"
}

# resolve_generator_settings <story_id>
# When agentRole=generator, overrides iteration/token settings for pure file-creation stories.
# Generator stories write one new file from spec — they need no context reads, few iterations,
# and a large output token budget for the generated content.
resolve_generator_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_GENERATOR_MODE=""
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ "$role" = "generator" ]; then
        STORY_GENERATOR_MODE="true"
        STORY_MAX_ITERATIONS=3
        STORY_MAX_OUTPUT_TOKENS=16384
        log "  GeneratorMode: enabled (agentRole=generator) — maxIter=3 maxOutTok=16384"
    fi
}

# resolve_model_from_story <story_id>
# For epam-run providers (copilot/openai/qwen/cursor), the prd.json story carries
# a .model field directly.  If set, it overrides the effort-based STORY_MODEL.
resolve_model_from_story() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_model" ]; then
        STORY_MODEL="$story_model"
        log "  Model[prd.json] -> $STORY_MODEL (overrides effort default)"
    fi
}

# compute_token_cost <model> <tokens_in> <tokens_out>
# Returns USD cost using model-pricing.json. Outputs "0" if model unknown or tokens are zero.
# Handles "standard-tier" / "mini-tier" labels by falling back to STORY_MODEL.
compute_token_cost() {
    local model="$1"
    local tin="${2:-0}"
    local tout="${3:-0}"
    local pricing_file
    pricing_file="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/model-pricing.json"
    [ -f "$pricing_file" ] || { echo "0"; return; }
    # Resolve tier labels to the actual model
    case "$model" in
        standard-tier|mini-tier|"") model="${STORY_MODEL:-}" ;;
    esac
    [ -z "$model" ] && { echo "0"; return; }
    python3 - "$pricing_file" "$model" "$tin" "$tout" <<'PYEOF'
import sys, json
pricing_file, model, tin, tout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(pricing_file) as f:
        table = json.load(f)
    prices = table.get(model)
    if not prices:
        # Try prefix match (e.g. model has date suffix)
        for k, v in table.items():
            if model.startswith(k) or k.startswith(model):
                prices = v
                break
    if prices:
        cost = (tin * prices["input"] + tout * prices["output"]) / 1_000_000
        print("{:.6f}".format(cost))
    else:
        print("0")
except Exception:
    print("0")
PYEOF
}

resolve_codex_model_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model runtime_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    runtime_model=$(jq -r '.configuration.aiRuntime.defaultModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    STORY_MODEL="${story_model:-${runtime_model:-gpt-5-codex}}"
    log "  Model[codex] -> $STORY_MODEL"
}

# resolve_planner_settings <story_id>
# Reads optional plannerModel from story spec and sets STORY_PLANNER_MODEL global.
# When set, the first invocation uses STORY_PLANNER_MODEL to produce a structured
# execution plan; subsequent (execution) invocations use STORY_MODEL.
# When absent, STORY_PLANNER_MODEL is cleared and behaviour is unchanged.
resolve_planner_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PLANNER_MODEL=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .plannerModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$STORY_PLANNER_MODEL" ]; then
        log "  PlannerModel[$STORY_PLANNER_MODEL] -> planning turn, then execution on $STORY_MODEL"
    fi
}

# resolve_dynamic_constitution <story_id>
# Reads .epam/constitution-rules.json in PROJECT_ROOT and appends any rules
# whose match criteria overlap the story's requiredSkills or agentRole to the
# DYNAMIC_CONSTITUTION global. Resets the global on every call so rules from a
# previous story never bleed into the next one.
# When the rules file is absent, DYNAMIC_CONSTITUTION is empty (P8 behaviour).
resolve_dynamic_constitution() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    DYNAMIC_CONSTITUTION=""

    local rules_file="${PROJECT_ROOT}/.epam/constitution-rules.json"
    [ -f "$rules_file" ] || return 0

    # Extract story metadata used for matching
    local story_skills story_role
    story_skills=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.requiredSkills // [] | .[]' \
        "$prd_target" 2>/dev/null | tr '\n' ' ' | xargs)
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # Match each rule entry against skills and role; collect matched rules
    local rule_count matched_rules
    rule_count=$(jq 'length' "$rules_file" 2>/dev/null || echo "0")
    matched_rules=""

    local i=0
    while [ "$i" -lt "$rule_count" ]; do
        local match_skills match_role
        match_skills=$(jq -r --argjson idx "$i" '.[$idx].match.skills // [] | .[]' \
            "$rules_file" 2>/dev/null | tr '\n' ' ' | xargs)
        match_role=$(jq -r --argjson idx "$i" '.[$idx].match.agentRole // ""' \
            "$rules_file" 2>/dev/null || echo "")

        local hit=false
        # Skill overlap: any match skill present in story skills
        for ms in $match_skills; do
            if echo " $story_skills " | grep -qi " $ms "; then
                hit=true; break
            fi
        done
        # Role match: agentRole in rule matches story role
        if [ -n "$match_role" ] && [ "$match_role" = "$story_role" ]; then
            hit=true
        fi

        if [ "$hit" = true ]; then
            local rules_text
            rules_text=$(jq -r --argjson idx "$i" '.[$idx].rules | .[]' \
                "$rules_file" 2>/dev/null | while IFS= read -r rule; do
                    echo "- $rule"
                done)
            matched_rules="${matched_rules}${rules_text}"$'\n'
        fi
        i=$((i + 1))
    done

    if [ -n "$matched_rules" ]; then
        DYNAMIC_CONSTITUTION=$'\n'"ADDITIONAL BEHAVIORAL RULES FOR THIS STORY:"$'\n'"$matched_rules"
        log "  DynamicConstitution: matched rules injected for story $story_id"
    fi
}

# resolve_provider_settings <story_id>
# Reads aiProvider from the story and sets STORY_PROVIDER global.
# Values: opencode | codex | epam | provider aliases (default: codex)
resolve_provider_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PROVIDER=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .aiProvider // "codex"' \
        "$prd_target" 2>/dev/null | head -1)
    STORY_PROVIDER="${STORY_PROVIDER:-codex}"
    log "  Provider[$STORY_PROVIDER] -> CLI=$(provider_to_cli "$STORY_PROVIDER")"
}

# provider_to_cli <provider>
# Returns the CLI binary name for a given aiProvider value.
# Exits with an error for unknown providers — no silent Claude fallback.
provider_to_cli() {
    case "$1" in
        opencode)                    echo "opencode" ;;
        codex)                       echo "codex" ;;
        codemie-claude)              echo "codemie-claude" ;;
        copilot|openai|qwen|cursor|minimax)  echo "$EPAM_CLI" ;;
        epam)                        echo "$EPAM_CLI" ;;
        *)
            error "Unknown aiProvider '$1' — set aiProvider in prd.json to one of: opencode|codex|copilot|openai|qwen|cursor|minimax|codemie-claude"
            return 1
            ;;
    esac
}

# normalize_provider_json <provider> <raw_jsonl_file> <out_json_file>
# Converts provider-specific JSONL output into a normalized JSON object
# matching Claude's format: {result, total_cost_usd, usage.{input_tokens,output_tokens}}
normalize_provider_json() {
    local provider="$1"
    local raw_file="$2"
    local out_file="$3"
    case "$provider" in
        opencode)
            # OpenCode emits JSONL stream; try step_finish first, then fall back to any cost/usage field
            local sf_line
            sf_line=$(grep '"type":"step_finish"' "$raw_file" 2>/dev/null | tail -1)
            if [ -z "$sf_line" ]; then
                sf_line=$(grep -E '"cost"|"total_cost"' "$raw_file" 2>/dev/null | tail -1 || echo '{}')
            fi
            sf_line="${sf_line:-{\}}"
            # Extract text parts for result summary
            local result_text
            result_text=$(grep '"type":"text"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].part.text // .[].text // ""] | join("")' 2>/dev/null || echo "opencode run completed")
            jq -n \
                --arg rt "$result_text" \
                --argjson sf "$sf_line" \
                '{result: $rt,
                  total_cost_usd: ($sf.cost // $sf.part.cost // $sf.total_cost // 0),
                  usage: {
                      input_tokens:  ($sf.tokens.input  // $sf.part.tokens.input  // $sf.usage.input_tokens  // 0),
                      output_tokens: ($sf.tokens.output // $sf.part.tokens.output // $sf.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codex)
            # Codex emits JSONL stream; turn.completed has usage (no cost field)
            local tc_line
            tc_line=$(grep '"type":"turn.completed"' "$raw_file" 2>/dev/null | tail -1)
            tc_line="${tc_line:-{\}}"
            local result_text
            result_text=$(grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].item.text // ""] | join("")' 2>/dev/null || echo "codex exec completed")
            jq -n \
                --arg rt "$result_text" \
                --argjson tc "$tc_line" \
                '{result: $rt,
                  total_cost_usd: 0,
                  usage: {
                      input_tokens:  ($tc.usage.input_tokens  // 0),
                      output_tokens: ($tc.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codemie-claude)
            # codemie-claude: same output format as Claude — nothing to normalize
            ;;
        epam)
            # epam: same output format as Claude — nothing to normalize
            ;;
        epam-run)
            # epam run --json output: {result, cost_usd, usage:{inputTokens,outputTokens}}
            # Pick the last JSON object with a non-empty result (guards against pino log lines).
            jq -s '[.[] | select(.result != null and .result != "")] | last // {result:"",cost_usd:0,usage:{inputTokens:0,outputTokens:0}} | {
                result:          (.result // ""),
                total_cost_usd:  (.cost_usd // 0),
                usage: {
                    input_tokens:  (.usage.inputTokens  // 0),
                    output_tokens: (.usage.outputTokens // 0)
                }
            }' "$raw_file" > "$out_file" 2>/dev/null || true
            ;;
        *)
            # Claude: already emits normalized JSON; nothing to do
            ;;
    esac
}

# Agent behavioral contract — injected into every claude invocation as a system
# prompt prefix. Rules are non-negotiable; they cannot be overridden by story
# prompts or KB content. Kept minimal: only invariants that prevent data loss or
# security incidents if violated.
AGENT_CONSTITUTION="AGENT BEHAVIORAL CONTRACT — NON-NEGOTIABLE:
1. Filesystem boundary: Never write, edit, or delete files outside PROJECT_ROOT (${PROJECT_ROOT}). All output must land inside the project directory.
2. Write code only: Write all files required by the story spec. Do NOT run compilers (tsc), test suites (vitest/jest/npm test), or linters. The orchestrator verifies correctness externally after your turn completes.
3. No pre-flight reads: Do NOT read any files before writing your first implementation file. Start writing immediately. Do NOT read KB.md, AGENTS.md, or any existing source files for context — all necessary context is in this prompt. Only read a file if you must modify it (and only after writing all new files first).
4. Protected paths: Never modify, rename, or delete files under .epam/, orchestrations/, or any path listed in .epam/protected-files. Never modify .env or any file matching *.env, .env.*, or *credentials* — these contain secrets and are immutable to agents.
5. Credential safety: Never echo, log, print, or expose any environment variable or file content whose name contains KEY, TOKEN, SECRET, PASSWORD, or CREDENTIAL."

# Claude CLI permission flags
# These allow Claude to read/write files and execute commands without prompting
CLAUDE_PERMISSIONS=(
    "--dangerously-skip-permissions"
    "--append-system-prompt"
    "$AGENT_CONSTITUTION"
)

# Alternative: Use granular permissions (uncomment if preferred over skip-permissions)
# CLAUDE_PERMISSIONS=(
#     "--allowedTools" "Read,Write,Edit,Glob,Grep,Bash"
# )

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    echo "[ERROR] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
    echo "[SUCCESS] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
    echo "[WARNING] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

info() {
    echo -e "${CYAN}[INFO]${NC} $1"
}

# Initialize directories and logs
initialize() {
    mkdir -p "$(dirname "$PROGRESS_LOG")"
    mkdir -p "$CLAUDE_OUTPUT_DIR"

    if [ ! -f "$PROGRESS_LOG" ]; then
        cat > "$PROGRESS_LOG" << EOF
=== EPAM CLI Orchestration Progress Log ===
Started: $(date)
Project: $(jq -r '.project.name // "Unknown"' "$PRD_FILE" 2>/dev/null || echo "Unknown")
==========================================

EOF
    fi
}

# Check prerequisites
check_prerequisites() {
    # Check for jq
    if ! command -v jq &> /dev/null; then
        error "jq is required but not installed. Install with: sudo apt install jq"
        exit 1
    fi

    # Check for Claude CLI only when actually needed (provider=claude or codemie-claude)
    # For qwen/openai/copilot/cursor/codex all traffic goes through epam CLI or ai-run.sh
    if command -v "$CLAUDE_CMD" &> /dev/null; then
        : # claude is available — all paths work
    else
        # Only fatal if stories are configured to use the claude provider
        if grep -q '"aiProvider"' "${PRD_FILE:-/dev/null}" 2>/dev/null && \
           jq -e '.stories[].aiProvider // "codex" | select(. == "claude" or . == "codemie-claude")' \
               "${PRD_FILE:-/dev/null}" >/dev/null 2>&1; then
            error "Claude CLI not found. Expected command: $CLAUDE_CMD"
            error "Install Claude Code CLI or set CLAUDE_CMD environment variable"
            exit 1
        fi
        log "Claude CLI not found — OK since no stories use the claude provider"
    fi

    # Check PRD file
    if [ ! -f "$PRD_FILE" ]; then
        error "PRD file not found at $PRD_FILE"
        exit 1
    fi

    # Validate PRD JSON
    if ! jq empty "$PRD_FILE" 2>/dev/null; then
        error "PRD file is not valid JSON"
        exit 1
    fi

    success "Prerequisites check passed"
}

# Get story details from PRD
get_story_details() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id)' "$PRD_FILE"
}

# Get story title
get_story_title() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title' "$PRD_FILE"
}

# Get story priority (high=1, medium=2, low=3)
get_story_priority() {
    local story_id=$1
    local priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .priority // "medium"' "$PRD_FILE")
    case $priority in
        high) echo 1 ;;
        medium) echo 2 ;;
        low) echo 3 ;;
        *) echo 2 ;;
    esac
}

# Check if story exists
story_exists() {
    local story_id=$1
    local exists=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .id' "$PRD_FILE")
    [ -n "$exists" ]
}

# Check if story is completed
is_story_completed() {
    local story_id=$1
    local completed=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .completed' "$PRD_FILE")
    [ "$completed" = "true" ]
}

# Get story dependencies
get_story_dependencies() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .dependencies // [] | .[]' "$PRD_FILE"
}

# Check if all dependencies are satisfied (completed)
are_dependencies_satisfied() {
    local story_id=$1
    local deps=$(get_story_dependencies "$story_id")

    if [ -z "$deps" ]; then
        return 0  # No dependencies
    fi

    while IFS= read -r dep; do
        if [ -n "$dep" ] && ! is_story_completed "$dep"; then
            return 1  # Dependency not satisfied
        fi
    done <<< "$deps"

    return 0  # All dependencies satisfied
}

# ──────────────────────────────────────────────
# check_plan_mode_required <story_id>
# Returns 0 (true) when the story's complexity triggers plan mode.
# Triggers: estimatedHours >= 6, OR deps >= 2, OR planModeRequired flag.
# Bypass: SKIP_PLAN_MODE=true env var.
# ──────────────────────────────────────────────
check_plan_mode_required() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    [ "${SKIP_PLAN_MODE:-false}" = "true" ] && return 1

    local estimated_hours dep_count plan_flag
    estimated_hours=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target" 2>/dev/null || echo 0)
    dep_count=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.dependencies // []) | length' "$prd_target" 2>/dev/null || echo 0)
    plan_flag=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.planModeRequired // false' "$prd_target" 2>/dev/null || echo false)

    [ "$plan_flag" = "true" ] && return 0
    # Use awk for float comparison (avoids bc dependency for this check)
    awk -v h="$estimated_hours" 'BEGIN{exit !(h >= 6)}' && return 0
    [ "${dep_count:-0}" -ge 2 ] && return 0
    return 1
}

# ──────────────────────────────────────────────
# run_plan_mode <story_id>
# Invokes Claude in planning mode to produce execution-ready artifacts.
# Posts a plan_summary message to agent-messages.jsonl when complete.
# ──────────────────────────────────────────────
run_plan_mode() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local plan_log="$CLAUDE_OUTPUT_DIR/${story_id}_plan_$(date +'%Y%m%d_%H%M%S').log"
    local plan_json="${plan_log%.log}_result.json"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"

    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local plan_prompt
    plan_prompt=$(cat << PLAN_PROMPT_EOF
You are a planning agent. Produce an execution-ready plan for story ${story_id} BEFORE implementation begins.

## Required Outputs
1. Implementation steps with target file paths
2. Dependency validation (each dep: satisfied yes/no, reason)
3. Risk register (top 3 risks + mitigations)
4. Test plan (new tests required + regression scope)
5. Acceptance criteria mapping (each criterion -> implementation step)
6. Cost/effort forecast (confirm or adjust estimatedHours)

## On Completion
Append a single-line JSON record to ${messages_jsonl}:
{
  "id":"plan_${story_id}_\$(date +%s)",
  "timestamp":"\$(date -Iseconds)",
  "from_agent":"plan-agent",
  "to_agent":"${agent_role}",
  "story_id":"${story_id}",
  "phase_id":"${CURRENT_PHASE:-unknown}",
  "message_type":"plan_summary",
  "priority":"normal",
  "subject":"Plan ready for ${story_id}",
  "body":"<one-sentence summary of key risks/steps>",
  "status":"new"
}
Write it atomically: (flock -w 10 9 >> ${messages_jsonl}; printf '%s\n' '<json>' >&9) 9>>${messages_jsonl}

## Story to Plan
Read orchestrations/prd.json for story ${story_id} full details, then produce the plan above.
PLAN_PROMPT_EOF
    )

    log "Plan mode: generating execution plan for $story_id..."
    touch "$messages_jsonl"
    cd "$PROJECT_ROOT"

    local plan_ok=false
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        # SDK path: extended thinking enabled for plan mode (high-complexity reasoning)
        if echo "$plan_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                --model "${STORY_MODEL:-gpt-5-codex}" \
                --thinking-budget 8000 \
                --output "$plan_json" 2>/dev/null; then
            plan_ok=true
        fi
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${ORCH_GATE_MODEL:-}"
        if [ -z "$_orch_provider" ]; then
            warning "Plan mode: EPAM_ORCHESTRATION_PROVIDER not set — skipping plan"
        elif echo "$plan_prompt" | \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                > "$plan_json" 2>>"$plan_log"; then
            # Wrap plain text output into the expected {result:...} shape
            plan_text_raw=$(cat "$plan_json")
            printf '{"result":%s}' "$(echo "$plan_text_raw" | jq -Rs .)" > "$plan_json"
            plan_ok=true
        fi
    fi

    if [ "$plan_ok" = true ]; then
        jq -r '.result // empty' "$plan_json" 2>/dev/null >> "$plan_log" || true
        success "Plan mode completed for $story_id — see $plan_log"
    else
        warning "Plan mode failed for $story_id — continuing with direct implementation"
    fi
}

# ──────────────────────────────────────────────
# post_completion_message <story_id> <status>
# Appends a status message to agent-messages.jsonl after each story run.
# Only writes when ORCH_MODE=hybrid OR the bus file already exists.
# ──────────────────────────────────────────────
post_completion_message() {
    local story_id="$1"
    local status="$2"   # "completed" | "failed"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"
    local lock_file="${messages_jsonl}.lock"

    # Always write — file is created by orchestration init for both bash and hybrid modes
    touch "$messages_jsonl"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local phase_id="${CURRENT_PHASE:-unknown}"
    local timestamp
    timestamp=$(date -Iseconds)
    local epoch
    epoch=$(date +%s)
    local msg_id="status_${story_id}_${epoch}"

    local message
    message=$(jq -cn \
        --arg id      "$msg_id" \
        --arg ts      "$timestamp" \
        --arg from    "$agent_role" \
        --arg to      "orchestrator" \
        --arg sid     "$story_id" \
        --arg pid     "$phase_id" \
        --arg subj    "Story $story_id $status" \
        --arg body    "Story $story_id finished with status: $status" \
        --arg sstatus "$status" \
        '{
            id: $id, timestamp: $ts,
            from_agent: $from, to_agent: $to,
            story_id: $sid, phase_id: $pid,
            message_type: "status",
            priority: "normal",
            subject: $subj, body: $body,
            story_status: $sstatus,
            status: "new"
        }')

    touch "$messages_jsonl"
    (
        flock -w 10 200 || return 0
        echo "$message" | jq -c '.' >> "$messages_jsonl"
    ) 200>"$lock_file"
}

# Log event to agent-status.json if running in orchestration mode
log_to_monitor() {
    local event_type=$1
    local story_id=$2
    local message=$3
    local monitor_file="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"

    # Only log if monitor file exists (orchestration mode)
    if [ ! -f "$monitor_file" ]; then
        return 0
    fi

    local lane="${WORKTREE_MODE:-main}"
    local role=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local timestamp=$(date -Iseconds)

    # Use flock to prevent race conditions
    (
        flock -w 5 200 || return 1

        # Add event to events array
        local tmp_file="${monitor_file}.tmp.$$"
        jq --arg type "$event_type" \
           --arg story "$story_id" \
           --arg lane "$lane" \
           --arg role "$role" \
           --arg msg "$message" \
           --arg ts "$timestamp" \
           '.events += [{"type": $type, "story": $story, "lane": $lane, "role": $role, "message": $msg, "timestamp": $ts}]' \
           "$monitor_file" > "$tmp_file" && mv "$tmp_file" "$monitor_file"
    ) 200>"${monitor_file}.lock"
}

# Get list of available phases
get_phases() {
    jq -r '.implementationOrder | keys[]' "$PRD_FILE" 2>/dev/null
}

# Get stories for a specific phase
get_phase_stories() {
    local phase=$1
    jq -r --arg phase "$phase" '.implementationOrder[$phase] // [] | .[]' "$PRD_FILE"
}

# Get the phase a story belongs to
get_story_phase() {
    local story_id=$1
    jq -r --arg id "$story_id" '.implementationOrder | to_entries[] | select(.value | contains([$id])) | .key' "$PRD_FILE" | head -1
}

# Get list of incomplete stories
get_incomplete_stories() {
    jq -r '.stories[] | select(.completed == false) | .id' "$PRD_FILE"
}

# Get prioritized list of incomplete stories (respects phases, dependencies, priority)
get_prioritized_stories() {
    local result=()

    # Get phases in order
    local phases=$(get_phases)

    if [ -z "$phases" ]; then
        # No phases defined, fall back to all incomplete stories sorted by priority
        jq -r '.stories[] | select(.completed == false) | "\(.priority // "medium")|\(.id)"' "$PRD_FILE" | \
            sort -t'|' -k1,1 | cut -d'|' -f2
        return
    fi

    # Process each phase in order
    while IFS= read -r phase; do
        [ -z "$phase" ] && continue

        # Get stories in this phase
        local phase_stories=$(get_phase_stories "$phase")

        # For each story in the phase, check if it's incomplete and dependencies are met
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue

            if ! is_story_completed "$story_id" && are_dependencies_satisfied "$story_id"; then
                echo "$story_id"
            fi
        done <<< "$phase_stories"
    done <<< "$phases"
}

# Get next story to implement (first incomplete with satisfied dependencies)
get_next_story() {
    get_prioritized_stories | head -1
}

# List available phases with status
list_phases() {
    echo ""
    echo -e "${MAGENTA}=== Implementation Phases ===${NC}"
    echo ""

    local phases=$(get_phases)

    if [ -z "$phases" ]; then
        echo -e "${YELLOW}No phases defined in implementationOrder${NC}"
        return
    fi

    while IFS= read -r phase; do
        [ -z "$phase" ] && continue

        local total=0
        local completed=0
        local stories=$(get_phase_stories "$phase")

        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            total=$((total + 1))
            if is_story_completed "$story_id"; then
                completed=$((completed + 1))
            fi
        done <<< "$stories"

        local status_color=$YELLOW
        local status_icon="o"
        if [ $completed -eq $total ] && [ $total -gt 0 ]; then
            status_color=$GREEN
            status_icon="+"
        elif [ $completed -gt 0 ]; then
            status_color=$CYAN
            status_icon="~"
        fi

        echo -e "${status_color}${status_icon}${NC} ${WHITE}$phase${NC} ($completed/$total completed)"

        # Show stories in phase
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            local title=$(get_story_title "$story_id")
            if is_story_completed "$story_id"; then
                echo -e "    ${GREEN}+${NC} $story_id: $title"
            else
                local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                local deps_info=""
                if [ -n "$deps" ]; then
                    if are_dependencies_satisfied "$story_id"; then
                        deps_info=" ${CYAN}(deps: $deps)${NC}"
                    else
                        deps_info=" ${RED}(blocked by: $deps)${NC}"
                    fi
                fi
                echo -e "    ${YELLOW}o${NC} $story_id: $title$deps_info"
            fi
        done <<< "$stories"
        echo ""
    done <<< "$phases"
}

# Get project context for Claude
get_project_context() {
    local stack=$(jq -r '.project.stack | to_entries | map("\(.key): \(.value)") | join(", ")' "$PRD_FILE" 2>/dev/null || echo "")
    local criteria=$(jq -r '.acceptanceCriteria | join("\n- ")' "$PRD_FILE" 2>/dev/null || echo "")

    cat << EOF
Project: $(jq -r '.project.name' "$PRD_FILE")
Description: $(jq -r '.project.description' "$PRD_FILE")
Tech Stack: $stack

Global Acceptance Criteria:
- $criteria
EOF
}

# Build prompt for Claude to implement a story
build_implementation_prompt() {
    local story_id=$1
    local story_json=$(get_story_details "$story_id")

    local title=$(echo "$story_json" | jq -r '.title')
    local description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    local files=$(echo "$story_json" | jq -r '.technicalNotes.files // [] | join(", ")')
    local dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # In worktree mode, rewrite ALL occurrences of the main repo absolute path in the
    # prompt text. The canonical PRD embeds absolute paths in acceptanceCriteria,
    # technicalNotes, and files — agents read these and write to those exact paths,
    # bypassing any write-first directive. Replace every reference so the agent only
    # ever sees the worktree path and writes files to the correct directory.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    # testCriteria — written by TC writer from actual source; ground truth for test stories.
    # Extracted after worktree path rewriting (TC fields don't contain absolute paths).
    local tc_facts tc_mock_strategy tc_banned
    tc_facts=$(echo "$story_json" | jq -r '.testCriteria.facts // [] | map("- " + .) | join("\n")' 2>/dev/null || echo "")
    tc_mock_strategy=$(echo "$story_json" | jq -r '.testCriteria.mockStrategy // ""' 2>/dev/null || echo "")
    tc_banned=$(echo "$story_json" | jq -r '.testCriteria.bannedPatterns // [] | join(", ")' 2>/dev/null || echo "")

    # Build a write-first directive listing each file with its exact absolute path
    local write_first_lines=""
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        # Resolve to absolute path; in worktree mode, rewrite main-repo absolute paths
        # to the worktree so the agent writes files in the correct directory.
        local abs_f
        if [[ "$f" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$f" = "${MAIN_PROJECT_ROOT}"* ]]; then
                abs_f="${PROJECT_ROOT}${f#${MAIN_PROJECT_ROOT}}"
            else
                abs_f="$f"
            fi
        else
            abs_f="$PROJECT_ROOT/$f"
        fi
        write_first_lines="${write_first_lines}   - WRITE ${abs_f} first, before any other action\n"
    done < <(echo "$story_json" | jq -r '.technicalNotes.files[]? // empty')

    cat << EOF
CRITICAL — WRITE FILES FIRST. Your FIRST tool call MUST be WriteFile.
Do NOT output any text before calling WriteFile. Do NOT plan or say "I will...".
Call WriteFile NOW for the EXACT ABSOLUTE PATHS listed below:

$(printf '%b' "$write_first_lines")
---

Implement user story $story_id: $title

## Story Description
$description

## Acceptance Criteria
- $acceptance_criteria
$([ -n "$tc_facts" ] && printf '\n## Test Criteria (ground truth — written from actual source; overrides any conflicting AC)\n%s\n' "$tc_facts" || true)
$([ -n "$tc_mock_strategy" ] && printf '\n## Mock Strategy\n%s\n' "$tc_mock_strategy" || true)
$([ -n "$tc_banned" ] && printf '\n## Banned Patterns (must NOT appear in your file)\n%s\n' "$tc_banned" || true)

## Technical Notes
$([ -n "$technical_notes" ] && echo "$technical_notes" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")' 2>/dev/null || echo "None specified")

## Files to Create/Modify (EXACT ABSOLUTE PATHS — write to these paths exactly)
$files

## Dependencies
${dependencies:-None}

## Instructions
**CRITICAL — WRITE FILES FIRST:**
$(printf '%b' "$write_first_lines")
**You MUST write every file listed above to its EXACT absolute path. Do NOT write to a different path, do NOT write to the current directory unless it matches the path above. Use your WriteFile or Edit tools with the full absolute path shown.**

1. Write each required file to its exact absolute path listed above — do this FIRST before anything else
2. Implement all acceptance criteria for this story
$([ -n "$tc_facts" ] && echo "3. Test Criteria facts above are ground truth — your test assertions MUST match them exactly" || echo "3. Follow the project's existing code patterns and conventions")
4. Do NOT create tests unless explicitly required in acceptance criteria

After implementation, provide a brief summary of what was created/modified.
EOF
}

build_generator_prompt() {
    local story_id=$1
    local story_json=$(get_story_details "$story_id")

    local title=$(echo "$story_json" | jq -r '.title')
    local description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    local files=$(echo "$story_json" | jq -r '.technicalNotes.files // [] | join(", ")')
    local dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # Rewrite main-repo absolute paths to worktree path in all prompt fields
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    cat << EOF
Generate file for story $story_id: $title

## Story Description
$description

## Acceptance Criteria
- $acceptance_criteria

## Technical Notes
$([ -n "$technical_notes" ] && echo "$technical_notes" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")' 2>/dev/null || echo "None specified")

## Files to Create
$files

## Dependencies (already implemented — do NOT read them)
${dependencies:-None}

## GENERATOR CONTRACT — READ THIS FIRST
You are a FILE GENERATOR. Your ONLY job is to write the file listed under "Files to Create".

**MANDATORY FIRST ACTION: Call WriteFile immediately. Do NOT call any other tool first.**

Rules:
1. Your FIRST tool call MUST be WriteFile to the target path above.
2. Do NOT call ReadFile, ListFiles, Bash, Search, or any other tool before WriteFile.
3. Write the COMPLETE file content in a single WriteFile call.
4. After WriteFile succeeds, you are done. No verification reads, no follow-up patches.
5. All information you need is in this prompt. The spec is authoritative — do NOT read existing files for context.

Generation approach: read every acceptance criterion once, hold them all in mind, then write a file that satisfies all of them in one shot.
EOF
}

# Verify every file declared by the story exists in the execution root.
# This prevents a successful provider response from completing a story that
# produced no deliverables.
verify_story_deliverables() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local missing=()
    local declared=0
    local file

    while IFS= read -r file; do
        [ -n "$file" ] || continue
        declared=$((declared + 1))
        # Support both absolute paths and paths relative to PROJECT_ROOT.
        # In worktree mode, absolute paths in technicalNotes.files point to the main
        # repo (e.g. /skyscanner-app/src/foo.ts). Rewrite them to the worktree path
        # so the deliverable check and agent prompt target the correct directory.
        local check_path
        if [[ "$file" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$file" = "${MAIN_PROJECT_ROOT}"* ]]; then
                check_path="${PROJECT_ROOT}${file#${MAIN_PROJECT_ROOT}}"
            else
                check_path="$file"
            fi
        else
            check_path="$PROJECT_ROOT/$file"
        fi
        if [ ! -e "$check_path" ]; then
            missing+=("$file")
        fi
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    if [ ${#missing[@]} -gt 0 ]; then
        error "Story $story_id is missing ${#missing[@]} declared deliverable(s) in $PROJECT_ROOT:"
        for file in "${missing[@]}"; do
            error "  $file"
        done
        return 1
    fi

    if [ "$declared" -gt 0 ]; then
        success "Verified $declared declared deliverable(s) for $story_id"
    fi
    return 0
}

# _scope_lock <story_id>
# Makes every .ts file in PROJECT_ROOT/src that is NOT in the story's declared
# technicalNotes.files read-only (chmod 444) before the agent runs. This is an
# OS-level pre-emptive guard: Bash, WriteFile, or any other mechanism that tries
# to write an out-of-scope file will get EACCES — no tool-layer workaround exists.
_scope_lock() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local -A _decl
    while IFS= read -r _f; do
        [ -n "$_f" ] && _decl["$_f"]=1
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    [ ${#_decl[@]} -eq 0 ] && return 0

    local _locked=0
    while IFS= read -r _f; do
        [ -n "${_decl[$_f]+x}" ] && continue
        chmod 444 "$_f" 2>/dev/null && ((_locked++))
    done < <(find "$PROJECT_ROOT/src" -name "*.ts" -type f 2>/dev/null)

    [ "$_locked" -gt 0 ] && log "  [scope-guard] Locked $_locked out-of-scope .ts file(s) (read-only) for $story_id"
}

# _scope_unlock
# Restores write permissions on all .ts files in PROJECT_ROOT/src.
# Always called after the agent finishes (success or failure).
_scope_unlock() {
    find "$PROJECT_ROOT/src" -name "*.ts" -type f -exec chmod 644 {} + 2>/dev/null || true
}

# run_external_verification <story_id> <output_file>
# Runs the project test suite externally after the agent writes files.
# This keeps the agent loop short (write-only) while still enforcing AC tests.
# Returns 0 on pass. On failure, appends a ## Verification Failure section
# to output_file so the retry prompt includes the actual test output.
VERIFICATION_FAILURE=""
run_external_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    VERIFICATION_FAILURE=""

    # Read optional testCommand from PRD story.technicalNotes
    local test_cmd
    test_cmd=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.testCommand // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # Fall back to npm test if package.json has a test script
    if [ -z "$test_cmd" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
        local has_test
        has_test=$(jq -r '.scripts.test // ""' "$PROJECT_ROOT/package.json" 2>/dev/null || echo "")
        [ -n "$has_test" ] && test_cmd="npm test"
    fi

    [ -z "$test_cmd" ] && return 0  # no test command configured — skip

    # Scope guard: restore .ts files outside this story's declared scope from
    # the pre-run snapshot. Agents frequently use Bash (not WriteFile) to write
    # files, bypassing tool-level guards. This restores them before npm test so
    # a story's verification only reflects the files it actually owns.
    local _sg_backup="${SCOPE_GUARD_BACKUP_DIR:-}"
    if [ -n "$_sg_backup" ] && [ -d "$_sg_backup" ]; then
        # Build declared set (absolute paths)
        local -A _sg_decl
        while IFS= read -r _f; do
            [ -n "$_f" ] && _sg_decl["$_f"]=1
        done < <(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
            "$prd_target" 2>/dev/null)

        if [ ${#_sg_decl[@]} -gt 0 ]; then
            local _sg_restored=0
            while IFS= read -r _rel; do
                local _abs="$PROJECT_ROOT/$_rel"
                # Skip if this file is in the story's declared scope
                [ -n "${_sg_decl[$_abs]+x}" ] && continue
                local _bak="$_sg_backup/$_rel"
                if [ -f "$_bak" ]; then
                    cp "$_bak" "$_abs" 2>/dev/null && ((_sg_restored++))
                fi
            done < <(find "$_sg_backup" -type f | sed "s|^$_sg_backup/||")
            if [ "$_sg_restored" -gt 0 ]; then
                warning "  [scope-guard] Restored $_sg_restored out-of-scope .ts file(s) before verification (agent wrote outside ${story_id}'s declared scope)"
            fi
        fi
    fi

    # Ensure node_modules exist in the worktree — git worktrees don't inherit gitignored dirs.
    # Without this, npm test fails with exit 127 (vitest binary not found).
    if [ -f "$PROJECT_ROOT/package.json" ] && [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        log "  Installing dependencies (node_modules missing in worktree)..."
        (cd "$PROJECT_ROOT" && npm install --silent 2>&1) || warning "  npm install failed — test may still fail"
    fi

    log "  Running external verification: $test_cmd"
    local test_output
    local test_exit=0
    test_output=$(cd "$PROJECT_ROOT" && eval "$test_cmd" 2>&1) || test_exit=$?

    if [ "$test_exit" -ne 0 ]; then
        warning "External verification failed for $story_id (exit $test_exit)"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran `%s` after your files were written and it failed (exit code %d). Fix the code so the tests pass.\n\n```\n%s\n```\n' \
            "$test_cmd" "$test_exit" "${test_output:0:4000}")
        {
            echo ""
            echo "=== External verification failed (exit $test_exit) ==="
            echo "$test_output" | head -60
        } >> "$output_file"
        return 1
    fi

    success "External verification passed for $story_id"
    return 0
}


update_monitor_status() {
    local event="$1"   # "start" | "complete" | "fail"
    local story_id="$2"
    local message="${3:-}"
    local lane="${WORKTREE_MODE:-main}"
    local title
    title=$(get_story_title "$story_id" 2>/dev/null || echo "$story_id")
    local role
    role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local update_script="$SCRIPT_DIR/update-monitor.sh"
    [ ! -x "$update_script" ] && return 0
    case "$event" in
        start)
            "$update_script" story_start "$story_id" "$lane" "$role" "$title" 2>/dev/null || true
            ;;
        complete)
            "$update_script" story_complete "$story_id" "$lane" "$title" 2>/dev/null || true
            ;;
        fail)
            "$update_script" story_fail "$story_id" "$lane" "$message" 2>/dev/null || true
            ;;
    esac
}

# run_planning_phase <story_id> <planner_model>
# Invokes the planner model with a focused planning prompt.
# Outputs a structured step-by-step execution plan as plain text on stdout.
# Uses the same SDK/CLI path as execution invocations.
run_planning_phase() {
    local story_id="$1"
    local planner_model="$2"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(get_story_title "$story_id")
    local ac
    ac=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/- /' || echo "")

    local planning_prompt="You are a planning agent. Produce a concise, numbered execution plan for the coding agent that will implement the following story. Output ONLY a numbered step list — no prose, no code.

Story: ${story_id} — ${title}

Acceptance criteria:
${ac}

Produce 5-10 numbered implementation steps that a coding agent will follow exactly. Be specific about file names, function signatures, and test requirements."

    local plan_result_file
    plan_result_file=$(mktemp /tmp/plan-${story_id}-XXXXXX.json)
    local plan_text=""

    local plan_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}"
    local plan_permissions=("--dangerously-skip-permissions" "--append-system-prompt" "$plan_constitution")
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        echo "$planning_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
            --model "$planner_model" \
            --system-prompt "$plan_constitution" \
            --output "$plan_result_file" 2>/dev/null || true
        plan_text=$(jq -r '.result // empty' "$plan_result_file" 2>/dev/null || cat "$plan_result_file" 2>/dev/null || echo "")
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${planner_model:-${ORCH_GATE_MODEL:-}}"
        if [ -n "$_orch_provider" ]; then
            plan_text=$(echo "$planning_prompt" | \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                2>/dev/null || echo "")
        fi
    fi

    rm -f "$plan_result_file"
    echo "$plan_text"
}

# ── Inference Ladder Coordinator ─────────────────────────────────────────────
#
# Two-layer gate that runs BEFORE each model-up event:
#
#   Layer 1 (rule-based triage, always on, zero cost):
#     Inspects raw result file and result text to classify the failure into:
#       env        — CLI crashed before any API call (raw = 0 bytes, non-zero exit)
#       capability — model ran but hit max iterations or produced no deliverables
#       quality    — deliverables exist but external tests failed
#     Class "env" immediately suppresses escalation (a stronger model won't fix it).
#
#   Layer 2 (LLM gate, opt-in via EPAM_MODEL_COORDINATOR_ENABLED=1):
#     For Class B/C failures, calls ORCH_GATE_MODEL with a structured prompt that
#     includes the failure log snippet. The gate returns:
#       escalate: yes|no        — whether to upgrade the model
#       failure_class: <class>  — refined classification
#       prompt_amendment: <txt> — optional targeted addition to the retry prompt
#     This layer distinguishes "context limit hit" (upgrade helps) from
#     "hallucination loop" (prompt amendment more effective than model upgrade).
#
# Sets globals:
#   COORDINATOR_ESCALATE        — "yes" | "no"
#   COORDINATOR_FAILURE_CLASS   — "env" | "capability" | "quality" | "unknown"
#   COORDINATOR_PROMPT_AMENDMENT — additional text to append to retry prompt, or ""

COORDINATOR_ESCALATE="yes"
COORDINATOR_FAILURE_CLASS="unknown"
COORDINATOR_PROMPT_AMENDMENT=""

# classify_failure_class <raw_file> <result_json> <exit_code>
# Layer 1: rule-based triage. Sets COORDINATOR_FAILURE_CLASS and COORDINATOR_ESCALATE.
classify_failure_class() {
    local raw_file="${1:-}"
    local result_json="${2:-}"
    local exit_code="${3:-1}"

    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"

    # Class A: environment crash — raw output is empty and exit code != 0
    local raw_size=0
    [ -f "$raw_file" ] && raw_size=$(wc -c < "$raw_file" 2>/dev/null || echo 0)
    if [ "$raw_size" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
        COORDINATOR_FAILURE_CLASS="env"
        COORDINATOR_ESCALATE="no"
        warning "  Coordinator[L1]: environment failure detected (raw=0 bytes, exit=$exit_code) — diagnosing before escalation decision"
        # Active crash diagnosis: check API key and binary health
        local _diag_ok=true
        # 1. Check epam binary is executable
        if ! command -v "${EPAM_CLI:-epam}" >/dev/null 2>&1; then
            warning "  Coordinator[Diag]: epam binary not found on PATH — check EPAM_CLI or PATH"
            _diag_ok=false
        fi
        # 2. Check OpenRouter key validity (fast: uses cached auth endpoint)
        local _or_key="${OPENROUTER_API_KEY:-${EPAM_API_KEY_OPENROUTER:-}}"
        if [ -n "$_or_key" ]; then
            local _key_status
            _key_status=$(curl -s --max-time 5 \
                "https://openrouter.ai/api/v1/auth/key" \
                -H "Authorization: Bearer $_or_key" 2>/dev/null \
                | jq -r '.data.label // "invalid"' 2>/dev/null || echo "unreachable")
            if [ "$_key_status" = "invalid" ] || [ "$_key_status" = "unreachable" ]; then
                warning "  Coordinator[Diag]: OPENROUTER_API_KEY check returned '$_key_status' — key may be expired or network is down"
                _diag_ok=false
            else
                log "  Coordinator[Diag]: OpenRouter key OK (label=$_key_status)"
            fi
        else
            warning "  Coordinator[Diag]: OPENROUTER_API_KEY is empty — provider will fail on any API call"
            _diag_ok=false
        fi
        if [ "$_diag_ok" = true ]; then
            log "  Coordinator[Diag]: binary and key are healthy — model/timeout issue; allowing escalation to retryModel"
            COORDINATOR_ESCALATE="yes"
        fi
        return
    fi

    # Class B: capability failure — "reached maximum iterations" in result
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    if echo "$result_text" | grep -qi "maximum iterations\|max.*iter"; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: capability failure (max iterations) — escalation approved"
        return
    fi

    # Class B variant: ran with tokens but no deliverables
    local tokens_out=0
    [ -f "$result_json" ] && tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$result_json" 2>/dev/null || echo 0)
    if [ "${tokens_out:-0}" -gt 100 ] && [ -z "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: capability failure (tokens consumed, no result) — escalation approved"
        return
    fi

    # Class C: quality failure — result exists, deliverables may exist, but tests failed
    # This is identified by the caller (verify_story_deliverables or run_external_verification failing)
    # If we reach here with non-empty result, it's likely quality
    if [ -n "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="quality"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: quality failure (agent ran, result produced) — escalation tentatively approved"
        return
    fi

    # Unknown: default to escalate (safe fallback)
    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"
    log "  Coordinator[L1]: unknown failure class — escalation approved (safe default)"

    # Cross-run memory check: read story-failures.jsonl for repeated patterns.
    # After 2+ consecutive env failures on the same story, suppress escalation and
    # flag it as a persistent environment problem requiring operator intervention.
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _prior_env_count
        _prior_env_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "env") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_env_count:-0}" -ge 2 ]; then
            COORDINATOR_FAILURE_CLASS="env"
            COORDINATOR_ESCALATE="no"
            warning "  Coordinator[L1]: story $story_id has ${_prior_env_count} prior env failures across runs — suppressing escalation, flagging for operator review"
        fi
        local _prior_cap_count
        _prior_cap_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "capability") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_cap_count:-0}" -ge 3 ]; then
            log "  Coordinator[L1]: story $story_id has ${_prior_cap_count} prior capability failures — story may need decomposition (too many ACs for any single invocation)"
            # Cross-run KB synthesis: emit a pattern entry after 3+ capability failures
            # so future runs benefit from the accumulated failure pattern.
            local _kb_file="$AUTOMATION_DIR/agents/KB.md"
            local _today; _today=$(date +'%Y-%m-%d')
            local _kb_entry_marker="KB-PERSIST-${story_id}"
            if [ -f "$_kb_file" ] && ! grep -q "$_kb_entry_marker" "$_kb_file" 2>/dev/null; then
                local _ac_count
                _ac_count=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | length' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "unknown")
                {
                    printf '\n## %s -- %s\n\n' "$_kb_entry_marker" "$_today"
                    printf '**Category:** orchestration\n'
                    printf '**AgentRole:** any\n'
                    printf '**Tags:** inference-ladder, story-decomposition, capability-failure\n'
                    printf '**Trigger:** cross-run-synthesis\n'
                    printf '**StoryRef:** %s\n\n' "$story_id"
                    printf 'Story %s has failed %s times with capability class (max iterations / empty output). ' "$story_id" "$_prior_cap_count"
                    printf 'It has %s ACs. Model escalation alone has not resolved this — the story likely needs to be ' "$_ac_count"
                    printf 'decomposed into smaller children (≤8 ACs each) before the next run. '
                    printf 'OpenSpec/SpecKit should split this story at Step 0 in the next pipeline run.\n'
                } >> "$_kb_file" 2>/dev/null || true
                log "  Coordinator[L1]: cross-run KB entry written for $story_id (${_prior_cap_count} capability failures)"
            fi
        fi
    fi
}

# get_model_ladder_step <current_model>
# Reads EPAM_MODEL_LADDER (pipe-separated "from=to" pairs) and returns the next model.
# Fully configurable — no hardcoded model names in this function.
# Set EPAM_MODEL_LADDER in the tier/run script to define the escalation path.
# Example:
#   export EPAM_MODEL_LADDER="MiniMax-M3=zhipuai/glm-z1-32b|moonshotai/kimi-k2=zhipuai/glm-4-plus"
# Returns empty string when current model is not in the ladder or EPAM_MODEL_LADDER is unset.
get_model_ladder_step() {
    local current_model="$1"
    local ladder="${EPAM_MODEL_LADDER:-}"
    [ -z "$ladder" ] && { echo ""; return; }
    local pair from to IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$ladder"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"
        to="${pair#*=}"
        if [ "$from" = "$current_model" ]; then
            echo "$to"
            return
        fi
    done
    echo ""
}

# assess_model_escalation <story_id> <raw_file> <result_json> <log_file>
# Layer 2 (opt-in): LLM coordinator gate for Class B/C failures.
# Sets COORDINATOR_ESCALATE and COORDINATOR_PROMPT_AMENDMENT.
# Only called when EPAM_MODEL_COORDINATOR_ENABLED=1.
assess_model_escalation() {
    local story_id="$1"
    local raw_file="${2:-}"
    local result_json="${3:-}"
    local log_file="${4:-}"
    local target_model="${5:-}"  # the model we're about to escalate to

    [ "${EPAM_MODEL_COORDINATOR_ENABLED:-0}" != "1" ] && return

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${ORCH_GATE_MODEL:-}"
    [ -z "$gate_provider" ] && return

    # Read failure evidence (cap at 3000 chars to stay within gate model budget)
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null | head -c 1500 || echo "")
    local log_tail=""
    [ -f "$log_file" ] && log_tail=$(tail -30 "$log_file" 2>/dev/null | head -c 1500 || echo "")
    # Include specific test failure output when available (Quality class failures)
    local test_failure_snippet="${VERIFICATION_FAILURE:0:1000}"
    # Cross-run memory: include prior failure pattern count for context
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    local prior_failure_summary=""
    if [ -f "$_failures_file" ]; then
        local _pf_count
        _pf_count=$(jq -r --arg sid "$story_id" 'select(.storyId == $sid) | .failureClass' \
            "$_failures_file" 2>/dev/null | sort | uniq -c | sort -rn | head -5 || echo "")
        [ -n "$_pf_count" ] && prior_failure_summary="Prior failure pattern (this story across runs): ${_pf_count}"
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_title
    story_title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // ""' "$prd_target" 2>/dev/null || echo "")
    local current_model="${STORY_MODEL:-unknown}"

    local coordinator_prompt
    coordinator_prompt=$(cat << COORD_PROMPT
You are the inference ladder coordinator. A story implementation just failed. You must decide whether to escalate to a stronger model for the retry, and whether a targeted prompt amendment would help.

## Story
- ID: ${story_id}
- Title: ${story_title}
- Current model: ${current_model}
- Proposed escalation model: ${target_model}
- Failure class (preliminary): ${COORDINATOR_FAILURE_CLASS}

## Failure Evidence (last attempt result)
${result_text:-"(empty — agent produced no result)"}

## Log Tail
${log_tail:-"(no log available)"}

## Test Failure Output (if tests ran)
${test_failure_snippet:-"(no test failure output)"}

## Cross-Run History
${prior_failure_summary:-"(no prior failures recorded for this story)"}

## Your Assessment
Answer ONLY with a single-line JSON object (no markdown, no prose):
{"escalate":"yes|no","failure_class":"env|capability|quality|unknown","prompt_amendment":"<targeted instruction to add to retry prompt, or empty string>","rationale":"<one sentence>"}

Rules:
- escalate "yes" ONLY when the failure is due to model capability limits (max iterations, context window, weak reasoning, missing knowledge)
- escalate "no" when the failure is environmental (missing API key, binary crash, file permission) — a stronger model won't fix it
- escalate "no" when the failure is a prompt misunderstanding — suggest a prompt_amendment instead
- prompt_amendment should be a concrete instruction (e.g., "Do not import from node-fetch — use native global fetch only") not a vague suggestion
- Keep rationale under 15 words
COORD_PROMPT
    )

    local coord_result_file
    coord_result_file=$(mktemp /tmp/coord-${story_id}-XXXXXX.json)

    local coord_raw=""
    if coord_raw=$(echo "$coordinator_prompt" | \
            AI_PROVIDER="$gate_provider" \
            AI_MODEL="$gate_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
            ${gate_model:+--model "$gate_model"} \
            2>/dev/null); then
        # Parse coordinator response
        local coord_json=""
        # Extract JSON object from response (strip any preamble)
        coord_json=$(echo "$coord_raw" | grep -o '{[^}]*}' | head -1 || echo "")
        if [ -n "$coord_json" ] && echo "$coord_json" | jq empty 2>/dev/null; then
            local coord_escalate
            coord_escalate=$(echo "$coord_json" | jq -r '.escalate // "yes"' 2>/dev/null || echo "yes")
            local coord_class
            coord_class=$(echo "$coord_json" | jq -r '.failure_class // "unknown"' 2>/dev/null || echo "unknown")
            local coord_amendment
            coord_amendment=$(echo "$coord_json" | jq -r '.prompt_amendment // ""' 2>/dev/null || echo "")
            local coord_rationale
            coord_rationale=$(echo "$coord_json" | jq -r '.rationale // ""' 2>/dev/null || echo "")

            COORDINATOR_ESCALATE="$coord_escalate"
            COORDINATOR_FAILURE_CLASS="$coord_class"
            COORDINATOR_PROMPT_AMENDMENT="$coord_amendment"
            log "  Coordinator[L2]: escalate=$coord_escalate class=$coord_class rationale='$coord_rationale'"
            [ -n "$coord_amendment" ] && log "  Coordinator[L2]: prompt_amendment injected (${#coord_amendment} chars)"
        else
            warning "  Coordinator[L2]: could not parse coordinator response — keeping L1 decision"
        fi
    else
        warning "  Coordinator[L2]: coordinator call failed — keeping L1 decision"
    fi

    rm -f "$coord_result_file"
}

# run_failure_analyst <story_id> <output_file> <retry_num>
# Layer 3 (self-heal): AI reads the test failure, diagnoses root cause, then patches
# PRD ACs (for ambiguous specs) or injects skill guidance into the coordinator
# amendment (for bad coding patterns) — before the next retry.
# Only meaningful when VERIFICATION_FAILURE is set (external test suite failed).
# Uses ORCH_GATE_PROVIDER/ORCH_GATE_MODEL (same gate as assess_model_escalation).
run_failure_analyst() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local retry_num="${3:-0}"

    # Only analyze test-suite failures; missing-deliverable failures lack useful output
    [ -z "${VERIFICATION_FAILURE:-}" ] && return 0

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${ORCH_GATE_MODEL:-}"
    if [ -z "$gate_provider" ]; then
        log "  [FailureAnalyst] No gate provider configured — skipping self-heal analysis"
        return 0
    fi

    log "  [FailureAnalyst] Analyzing test failure for $story_id (gate=$gate_model)..."

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Build spec context: prefer testCriteria.facts (ground truth from TC writer) over ACs
    local story_acs story_role skill_addendum profiles_file
    local tc_facts_raw
    tc_facts_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .testCriteria.facts // [] | to_entries | map("TC\(.key+1): \(.value)") | join("\n")' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$tc_facts_raw" ]; then
        story_acs="$tc_facts_raw"
    else
        story_acs=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | to_entries | map("AC\(.key+1): \(.value)") | join("\n")' \
            "$prd_target" 2>/dev/null || echo "(no ACs found)")
    fi
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "typescript-engineer"' \
        "$prd_target" 2>/dev/null || echo "typescript-engineer")
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    skill_addendum=""
    if [ -f "$profiles_file" ]; then
        # profiles.json is flat {role: "prompt string"} — extract [Self-Heal] lines only
        skill_addendum=$(jq -r --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null | \
            grep '\[Self-Heal\]' | head -c 1500 || echo "")
    fi

    local analyst_prompt
    analyst_prompt=$(cat << 'ANALYST_PROMPT_END'
You are a self-healing pipeline analyst. A coding agent has failed its test suite. Diagnose the exact root cause and prescribe the minimum fix so the NEXT retry succeeds.

STORY: __STORY_ID__
AGENT ROLE: __STORY_ROLE__

CURRENT TEST CRITERIA (TC facts when available, ACs as fallback):
__STORY_ACS__

AGENT SKILL ADDENDUM (instructions in the agent's system prompt):
__SKILL_ADDENDUM__

TEST FAILURE OUTPUT:
__VERIFICATION_FAILURE__

Output ONLY a single JSON object. No markdown fences, no prose outside the JSON:
{"diagnosis":"<one sentence: what specifically went wrong in the code>","target":"prd|skill|kb|none","ac_patches":[{"index":<0-based AC index>,"new_text":"<exact replacement text for that AC>"}],"skill_note":"<if target=skill or target=kb: concrete coding instruction>","reason":"<why this change prevents the same failure on retry>"}

Decision rules:
- target=prd: the AC wording was ambiguous or contradictory, causing the agent to write wrong code. Fix the AC.
- target=skill: the agent used a bad coding pattern that should be injected into this retry's prompt only.
- target=kb: the failure reveals a reusable coding rule that ALL future agents with this agent role should know — append to the role-specific KB.
- target=none: ACs and skill are both correct; the agent made a transient code mistake. Retry with stronger model should fix it.
- Only include ac_patches entries when target=prd; use [] for other targets.
- skill_note must be a concrete "do/don't" instruction (e.g. "Never use backtick template literals in test files — use single-quoted strings only").
- Keep diagnosis under 20 words, reason under 15 words.
ANALYST_PROMPT_END
    )
    # Substitute placeholders (safe substitution avoids heredoc quoting issues)
    analyst_prompt="${analyst_prompt//__STORY_ID__/$story_id}"
    analyst_prompt="${analyst_prompt//__STORY_ROLE__/$story_role}"
    analyst_prompt="${analyst_prompt//__STORY_ACS__/$story_acs}"
    analyst_prompt="${analyst_prompt//__SKILL_ADDENDUM__/$skill_addendum}"
    analyst_prompt="${analyst_prompt//__VERIFICATION_FAILURE__/${VERIFICATION_FAILURE:0:2500}}"

    local analyst_raw=""
    if analyst_raw=$(echo "$analyst_prompt" | \
            AI_PROVIDER="$gate_provider" \
            AI_MODEL="$gate_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
            ${gate_model:+--model "$gate_model"} \
            2>>"$output_file"); then

        # Extract first valid JSON object (handles nested structures via Python)
        local analyst_json=""
        analyst_json=$(echo "$analyst_raw" | python3 -c "
import sys, json
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(json.dumps(obj))
    sys.exit(0)
except Exception:
    pass
depth = 0; start = -1
for i, c in enumerate(text):
    if c == '{':
        if depth == 0: start = i
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0 and start >= 0:
            try:
                obj = json.loads(text[start:i+1])
                print(json.dumps(obj))
                sys.exit(0)
            except Exception:
                pass
" 2>/dev/null || echo "")

        if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
            local diagnosis target skill_note reason patch_count _profile_updated
            diagnosis=$(echo "$analyst_json" | jq -r '.diagnosis // "unknown"' 2>/dev/null || echo "unknown")
            target=$(echo "$analyst_json" | jq -r '.target // "none"' 2>/dev/null || echo "none")
            skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""' 2>/dev/null || echo "")
            reason=$(echo "$analyst_json" | jq -r '.reason // ""' 2>/dev/null || echo "")
            patch_count=0
            _profile_updated="false"

            log "  [FailureAnalyst] Diagnosis: $diagnosis"
            log "  [FailureAnalyst] Target=$target — $reason"

            case "$target" in
                prd)
                    local patches_json
                    patches_json=$(echo "$analyst_json" | jq -c '.ac_patches // []' 2>/dev/null || echo "[]")
                    if [ "$patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching PRD ACs for $story_id..."
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local idx new_text
                            idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$idx" ] && [ -n "$new_text" ]; then
                                python3 - "$new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys
prd_path = '$prd_target'
story_id = '$story_id'
idx = $idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            old = acs[idx]
            acs[idx] = new_text
            print(f'AC{idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'AC index {idx} out of range (story has {len(acs)} ACs)', file=sys.stderr)
        break
with open(prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
PYEOF
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$patches_json" | jq -c '.[]' 2>/dev/null)
                        log "  [FailureAnalyst] Applied $patch_count AC patch(es) — retry will use updated spec"
                    else
                        log "  [FailureAnalyst] target=prd but no ac_patches provided — no change made"
                    fi
                    ;;
                skill)
                    if [ -n "$skill_note" ]; then
                        log "  [FailureAnalyst] Injected skill guidance into retry prompt (${#skill_note} chars)"
                        # Persist skill note to profiles.json so future runs inherit this learning
                        if [ -f "$profiles_file" ]; then
                            python3 - << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys
profiles_path = '$profiles_file'
role = '$story_role'
note = '[Self-Heal] ' + r'''$skill_note'''
with open(profiles_path) as f:
    profiles = json.load(f)
# profiles.json is flat {role: "prompt string"} — append note to the string value
if role in profiles:
    existing = profiles[role]
    sep = '\n\n' if existing else ''
    profiles[role] = existing + sep + note
    with open(profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    print(f'Skill note appended to [{role}] profile — persisted for future runs')
else:
    print(f'Profile role [{role}] not found in profiles.json — skill note NOT persisted', file=sys.stderr)
PYEOF
                            _profile_updated="true"
                        fi
                    else
                        log "  [FailureAnalyst] target=skill but skill_note empty — falling back to diagnosis only"
                    fi
                    ;;
                kb)
                    if [ -n "$skill_note" ]; then
                        # Agent-specific KB: KB-{agentRole}.md — keeps context injection small.
                        # Shared rules go to KB-shared.md; agent-specific rules go to role file.
                        local kb_dir
                        kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                        local kb_file="${kb_dir}/KB-${story_role}.md"
                        local kb_ts
                        kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
                        # Truncate to 200 chars — entries are single actionable rules, not essays
                        local short_note="${skill_note:0:200}"
                        # Compact 2-line format: timestamp + rule only (no verbose headers)
                        printf '\n- [%s] %s\n' "$kb_ts" "$short_note" >> "$kb_file" 2>/dev/null || true
                        log "  [FailureAnalyst] KB entry appended to KB-${story_role}.md (${#short_note} chars)"
                        _profile_updated="true"
                    else
                        log "  [FailureAnalyst] target=kb but skill_note empty — no KB entry written"
                    fi
                    ;;
                none)
                    log "  [FailureAnalyst] No structural fix needed — model escalation ladder handles retry"
                    ;;
                *)
                    log "  [FailureAnalyst] Unknown target '$target' — injecting diagnosis only"
                    ;;
            esac
            # Record the healing event for observability and post-run audit
            run_healing_recorder "$story_id" "$retry_num" "$target" "$diagnosis" "$patch_count" "$_profile_updated"
            # Detect repeat failures — same diagnosis 2+ times means healing is broken
            check_healing_effectiveness "$story_id" "$diagnosis"
            # Always inject the failure summary into the coordinator amendment so the
            # downstream retry agent knows EXACTLY what went wrong and how to avoid it.
            local _analyst_guidance="Root cause: ${diagnosis}"
            [ -n "$skill_note" ] && _analyst_guidance="${_analyst_guidance}
Fix: ${skill_note}"
            [ "$target" = "prd" ] && _analyst_guidance="${_analyst_guidance}
The acceptance criteria for this story have been updated — re-read them carefully before writing code."
            [ "$target" = "none" ] && _analyst_guidance="${_analyst_guidance}
The spec is correct — the model made a code-level mistake. Write correct code this time."
            local _existing="${COORDINATOR_PROMPT_AMENDMENT:-}"
            COORDINATOR_PROMPT_AMENDMENT="${_existing}
## Self-Heal: Failure Analyst Summary
${_analyst_guidance}"
        else
            warning "  [FailureAnalyst] Could not parse JSON from analyst response — proceeding with retry as-is"
        fi
    else
        warning "  [FailureAnalyst] Gate model call failed — proceeding with retry as-is"
    fi
}

# run_healing_recorder <story_id> <retry_num> <target> <diagnosis> <patches_applied> <profile_updated>
# Appends a JSONL record to $OUTPUT_DIR/healing-events.jsonl after each analyst cycle.
# Each record is independently parseable so the log survives partial runs.
run_healing_recorder() {
    local story_id="$1"
    local retry_num="${2:-0}"
    local target="${3:-none}"
    local diagnosis="${4:-unknown}"
    local patches_applied="${5:-0}"
    local profile_updated="${6:-false}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
    local heal_log="${OUTPUT_DIR:-$LOG_DIR}/healing-events.jsonl"
    mkdir -p "$(dirname "$heal_log")"
    # Safe JSON serialisation — escape quotes and backslashes in diagnosis
    local safe_diagnosis
    safe_diagnosis=$(printf '%s' "$diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"ts":"%s","story_id":"%s","retry":%s,"target":"%s","diagnosis":"%s","patches_applied":%s,"profile_updated":%s}\n' \
        "$ts" "$story_id" "$retry_num" "$target" "$safe_diagnosis" \
        "$patches_applied" "$profile_updated" \
        >> "$heal_log"
    log "  [HealingRecorder] Event written (story=$story_id retry=$retry_num target=$target)"
}

# check_healing_effectiveness <story_id> <current_diagnosis>
# Reads healing-events.jsonl and checks if the same diagnosis has appeared 2+ times
# for this story without a different diagnosis in between. If so, self-healing is
# not working — log a CRITICAL alert and set HEALING_BROKEN=1 to abort retries.
check_healing_effectiveness() {
    local story_id="$1"
    local current_diagnosis="$2"
    local heal_log="${OUTPUT_DIR:-$LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0
    # Count consecutive same-diagnosis events for this story (most recent N events)
    local repeat_count
    repeat_count=$(python3 - << PYEOF 2>/dev/null || echo 0
import json, sys
path = '${heal_log}'
story = '${story_id}'
diag  = '''${current_diagnosis}'''[:20]  # 20-char prefix tolerates analyst rephrasing of same root cause
events = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis','')[:20])
        except Exception:
            pass
# Count how many of the last events share the same root cause (prefix match)
count = 0
for d in reversed(events):
    if d == diag:
        count += 1
    else:
        break
print(count)
PYEOF
)
    if [ "${repeat_count:-0}" -ge 2 ]; then
        error "  [HealingBroken] CRITICAL: '${current_diagnosis}' has recurred ${repeat_count}+ times for $story_id without a different fix — self-healing is NOT working."
        error "  [HealingBroken] Check: (1) gate model is reachable (2) failure analyst is diagnosing correctly (3) patches are being applied"
        # Write a HEALING_BROKEN sentinel record so the run summary captures this
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
        local safe_diag
        safe_diag=$(printf '%s' "$current_diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
        printf '{"ts":"%s","story_id":"%s","event":"HEALING_BROKEN","repeated_diagnosis":"%s","count":%s}\n' \
            "$ts" "$story_id" "$safe_diag" "$repeat_count" >> "$heal_log"
        HEALING_BROKEN=1
        export HEALING_BROKEN
    fi
}

# Invoke Claude CLI to implement a story
implement_story() {
    local story_id=$1
    local retry_count=0
    local output_file="$CLAUDE_OUTPUT_DIR/${story_id}_$(date +'%Y%m%d_%H%M%S').log"
    local story_started_at=$(date -Iseconds)

    local title=$(get_story_title "$story_id")
    log "Implementing story: $story_id - $title"
    update_monitor_status "start" "$story_id"

    # Check dependencies first
    if ! are_dependencies_satisfied "$story_id"; then
        local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
        error "Cannot implement $story_id - dependencies not satisfied: $deps"
        return 1
    fi

    # Plan mode check: run planning agent before implementation if complexity thresholds met
    if check_plan_mode_required "$story_id"; then
        log "Plan mode required for $story_id (estimatedHours>=6, deps>=2, or flag set)"
        run_plan_mode "$story_id"
    fi

    # Resolve effort -> model + max-turns for this story (stable across retries)
    resolve_effort_settings "$story_id"
    # Resolve generator mode — overrides effort settings when agentRole=generator
    resolve_generator_settings "$story_id"
    # Resolve aiProvider -> which CLI binary to use
    resolve_provider_settings "$story_id"
    # Capture original model so phase R3 can detect whether R2 escalated it
    STORY_MODEL_ORIGINAL="${STORY_MODEL:-}"
    # Reset reasoning effort to default at story start (previous story's setting must not leak)
    export EPAM_REASONING_EFFORT="low"
    # For epam-run providers, prd.json .model field overrides effort-based model
    case "${STORY_PROVIDER:-codex}" in
        codex) resolve_codex_model_settings "$story_id" ;;
        copilot|openai|qwen|cursor|minimax) resolve_model_from_story "$story_id" ;;
    esac
    # Resolve optional plannerModel — runs a planning pass before execution
    resolve_planner_settings "$story_id"
    # Resolve dynamic constitution rules for this story (appends to AGENT_CONSTITUTION)
    resolve_dynamic_constitution "$story_id"
    # GAP-P17: inject outputSchema instruction when story defines one
    local schema_block=""
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_output_schema
    story_output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_output_schema" ]; then
        schema_block=$'\n\nOUTPUT SCHEMA REQUIREMENT:\nYou MUST conclude your response with a JSON object that conforms to the following JSON Schema. Wrap it in a ```json code block.\n```json\n'"$story_output_schema"$'\n```'
        log "  OutputSchema: structured output required for $story_id"
    fi
    # Build effective constitution = static base + dynamic rules + optional schema block.
    # Mirrors CLAUDE_PERMISSIONS: empty in interactive mode (no skip-permissions).
    local effective_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}${schema_block}"
    local effective_permissions=()
    if [ ${#CLAUDE_PERMISSIONS[@]} -gt 0 ]; then
        effective_permissions=(
            "--dangerously-skip-permissions"
            "--append-system-prompt"
            "$effective_constitution"
        )
    fi
    local model_flag=()
    local turns_flag=()
    [ -n "${STORY_MODEL:-}" ]     && model_flag=(--model "$STORY_MODEL")
    [ -n "${STORY_MAX_TURNS:-}" ] && turns_flag=(--max-turns "$STORY_MAX_TURNS")
    local story_cli
    story_cli=$(provider_to_cli "${STORY_PROVIDER:-codex}")

    # Planning phase: when plannerModel is set, run one planning invocation first.
    # The returned plan is injected into every execution attempt as fixed context.
    local story_plan=""
    if [ -n "${STORY_PLANNER_MODEL:-}" ]; then
        log "  Running planning phase with $STORY_PLANNER_MODEL..."
        story_plan=$(run_planning_phase "$story_id" "$STORY_PLANNER_MODEL")
        local plan_words
        plan_words=$(echo "$story_plan" | wc -w)
        log "  Planning phase complete ($plan_words words)"
    fi

    while [ $retry_count -le $MAX_RETRIES ]; do
        # Inference ladder: on retry, escalate to a stronger model + increase reasoning effort.
        # Priority: PRD retryModel > EPAM_RETRY_MODEL env var > built-in get_model_ladder_step().
        # Principle: NEVER retry with the same model — every failure steps up. Logged visibly.
        if [ "$retry_count" -gt 0 ]; then
            # ── Rung-based inference ladder ────────────────────────────────────────
            # 2 attempts per rung: attempt 1 (cold), self-healing fires, attempt 2
            # (informed). Escalate only when entering a new rung.
            #
            # Rung 0 (retries 0-1): base model, base effort
            # Rung 1 (retries 2-3): same model, reasoning effort → medium
            # Rung 2 (retries 4-5): escalated model, reasoning effort → medium
            # Rung 3 (retries 6-7): escalated model, reasoning effort → high
            # ──────────────────────────────────────────────────────────────────────
            local _rung=$(( retry_count / 2 ))
            local _entering_rung=$(( retry_count % 2 == 0 ))   # 1 = first attempt of rung

            if [ "$_entering_rung" -eq 1 ]; then
                case "$_rung" in
                    1)
                        # Rung 1: same model, effort → medium
                        export EPAM_REASONING_EFFORT="medium"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        log "  InferenceLadder[Rung1/R${retry_count}]: model='${STORY_MODEL:-default}' unchanged — effort → medium"
                        ;;
                    2)
                        # Rung 2: model escalation, effort → medium
                        local retry_model_prd ladder_step_r2
                        retry_model_prd=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        local escalated_model_r2="${retry_model_prd:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$escalated_model_r2" ]; then
                            ladder_step_r2=$(get_model_ladder_step "${STORY_MODEL:-}" 2)
                            [ -n "$ladder_step_r2" ] && escalated_model_r2="$ladder_step_r2"
                        fi
                        if [ -n "$escalated_model_r2" ] && [ "$escalated_model_r2" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung2/R${retry_count}]: model '${STORY_MODEL:-default}' → '$escalated_model_r2' — effort → medium"
                            STORY_MODEL="$escalated_model_r2"
                            case "$escalated_model_r2" in
                                zhipuai/*|moonshotai/*|glm-*|kimi-*) STORY_PROVIDER="qwen" ;;
                                MiniMax-*)                            STORY_PROVIDER="minimax" ;;
                            esac
                        else
                            log "  InferenceLadder[Rung2/R${retry_count}]: no ladder step — keeping model, effort → medium"
                        fi
                        export EPAM_REASONING_EFFORT="medium"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        ;;
                    *)
                        # Rung 3+: escalated model, effort → high (maximum)
                        local _ffm="${EPAM_FINAL_FALLBACK_MODEL:-}" _ffp="${EPAM_FINAL_FALLBACK_PROVIDER:-}"
                        if [ -n "$_ffm" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_ORIGINAL:-}" ]; then
                            log "  InferenceLadder[Rung3/R${retry_count}]: no prior escalation — routing to fallback '$_ffm'"
                            STORY_MODEL="$_ffm"
                            [ -n "$_ffp" ] && STORY_PROVIDER="$_ffp"
                        fi
                        export EPAM_REASONING_EFFORT="high"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        log "  InferenceLadder[Rung3/R${retry_count}]: model='${STORY_MODEL:-default}' — effort → high (maximum)"
                        ;;
                esac
            else
                log "  InferenceLadder[Rung${_rung}/R${retry_count}]: same rung — no escalation, self-heal guidance active"
            fi
        fi
        # Rebuild prompt each attempt: retry_count and KB ID must reflect current state
        local next_kb_id
        next_kb_id=$(get_next_kb_id)
        local prompt
        if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
            prompt="$(build_generator_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
        else
            prompt="$(build_implementation_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
        fi
        # Inject execution plan when planner/executor split is active
        if [ -n "${story_plan:-}" ]; then
            prompt="$prompt

## Execution Plan
Follow this plan step by step:
$story_plan"
        fi

        # Inject coordinator prompt amendment when available (retry attempts only)
        if [ "$retry_count" -gt 0 ] && [ -n "${COORDINATOR_PROMPT_AMENDMENT:-}" ]; then
            prompt="$prompt

## Coordinator Guidance (retry ${retry_count})
The following targeted instruction was identified from the previous failure:
${COORDINATOR_PROMPT_AMENDMENT}"
        fi

        # Log the prompt
        echo "=== Prompt for $story_id (attempt $((retry_count + 1))) ===" >> "$output_file"
        echo "$prompt" >> "$output_file"
        echo "=== End Prompt ===" >> "$output_file"
        echo "" >> "$output_file"

        log "Invoking $story_cli (attempt $((retry_count + 1))/$((MAX_RETRIES + 1)))..."

        # Scope guard: lock .ts files outside this story's declared scope read-only.
        # Any write attempt — Bash, WriteFile, or otherwise — gets EACCES.
        _scope_lock "$story_id"

        # Change to project root for the CLI to have correct context
        cd "$PROJECT_ROOT"

        echo "=== $story_cli Output (attempt $((retry_count + 1))) ===" >> "$output_file"

        local json_result_file="${output_file%.log}_result.json"
        local invoke_success=false
        # Track the raw output file across all provider branches for coordinator triage
        local attempt_raw_file="${json_result_file%.json}_raw.json"

        # Optional per-story wall-clock timeout — set EPAM_STORY_TIMEOUT_SECS in the tier script.
        # No default: if unset, no timeout is applied (behaviour is unchanged).
        local _timeout_prefix=()
        [ -n "${EPAM_STORY_TIMEOUT_SECS:-}" ] && _timeout_prefix=(timeout "$EPAM_STORY_TIMEOUT_SECS")

        case "${STORY_PROVIDER:-codex}" in
            opencode)
                # OpenCode: pass prompt via temp file (prompts can exceed arg limits)
                # --format json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local prompt_file="${json_result_file%.json}_prompt.txt"
                echo "$prompt" > "$prompt_file"
                if "${_timeout_prefix[@]}" opencode run --format json "$(cat "$prompt_file")" \
                        > "$raw_file" 2>/dev/null; then
                    normalize_provider_json "opencode" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"text"' "$raw_file" 2>/dev/null \
                        | jq -r '.part.text // .text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                rm -f "$prompt_file"
                ;;
            codex)
                # Codex: reads prompt from stdin when '-' is passed
                # --json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local codex_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && codex_model_flag=(--model "$STORY_MODEL")
                if echo "$prompt" | "${_timeout_prefix[@]}" codex exec \
                        --ephemeral \
                        --skip-git-repo-check \
                        --dangerously-bypass-approvals-and-sandbox \
                        "${codex_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>>"$output_file"; then
                    normalize_provider_json "codex" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                        | jq -r '.item.text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            codemie-claude)
                # codemie-claude: same invocation pattern as claude — --print --output-format json
                if echo "$prompt" | "${_timeout_prefix[@]}" codemie-claude --print --output-format json \
                        "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                        2>>"$output_file" > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            copilot|openai|qwen|cursor|minimax)
                # epam-run providers: invoke via `epam run --provider X --model M --json`
                # EPAM_CLI can be overridden with a mock for zero-token testing.
                # Explicitly forward API keys so subshells that didn't inherit them still work.
                local raw_file="${json_result_file%.json}_raw.json"
                local epam_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && epam_model_flag=(--model "$STORY_MODEL")
                # Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story's declared files.
                # WriteFile.ts uses this to block TS writes outside the story's scope.
                local _allowed_write_paths
                _allowed_write_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                # Rewrite allowed paths to worktree when in worktree mode.
                # Without this, WriteFile.ts blocks writes to the worktree path and reports
                # "Permitted paths: /main-repo/src/foo.ts" — the model reads that error and
                # writes to the main repo instead of the worktree.
                if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
                    _allowed_write_paths="${_allowed_write_paths//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
                fi
                if echo "$prompt" | \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_ALLOWED_WRITE_PATHS="${_allowed_write_paths}" \
                        EPAM_MAX_ITERATIONS="${STORY_MAX_ITERATIONS:-6}" \
                        EPAM_MAX_OUTPUT_TOKENS="${STORY_MAX_OUTPUT_TOKENS:-3072}" \
                        OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-}" \
                        EPAM_QWEN_MODEL_OVERRIDE="${EPAM_QWEN_MODEL_OVERRIDE:-}" \
                        DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
                        EPAM_API_KEY_QWEN="${EPAM_API_KEY_QWEN:-}" \
                        MINIMAX_API_KEY="${MINIMAX_API_KEY:-}" \
                        EPAM_API_KEY_MINIMAX="${EPAM_API_KEY_MINIMAX:-}" \
                        MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-}" \
                        EPAM_MINIMAX_MODEL_OVERRIDE="${EPAM_MINIMAX_MODEL_OVERRIDE:-}" \
                        EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-}" \
                        EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-}" \
                        OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
                        EPAM_API_KEY_OPENAI="${EPAM_API_KEY_OPENAI:-}" \
                        EPAM_RALPH_WIGGUM_ENABLED="${EPAM_RALPH_WIGGUM_ENABLED:-}" \
                        EPAM_RALPH_WIGGUM_AGENTS="${EPAM_RALPH_WIGGUM_AGENTS:-}" \
                        EPAM_RALPH_WIGGUM_TIMEOUT_MS="${EPAM_RALPH_WIGGUM_TIMEOUT_MS:-}" \
                        "${_timeout_prefix[@]}" "$EPAM_CLI" run \
                        --provider "$STORY_PROVIDER" \
                        "${epam_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>> "$output_file"; then
                    normalize_provider_json "epam-run" "$raw_file" "$json_result_file"
                    jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            epam)
                # epam: treat same as claude — same CLI, same output format
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    local sdk_think_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" "${sdk_think_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
            *)
                # Claude-compatible providers use the Claude CLI JSON output shape.
                # SDK path: invoke.py via Anthropic Python SDK (EPAM_SDK_INVOKE=1)
                # CLI path: claude --print --output-format json (default)
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
        esac

        # Scope guard: restore write permissions now that the agent has finished.
        # Verification (npm test) only reads files — no write access needed.
        _scope_unlock

        if [ "$invoke_success" = true ] && ! verify_story_deliverables "$story_id"; then
            warning "$story_cli returned success but story deliverables are incomplete"
            invoke_success=false
        fi

        # External test verification — runs tests outside the agent loop so the
        # agent only needs to write files (keeping iterations low).
        if [ "$invoke_success" = true ] && ! run_external_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but external tests failed"
            invoke_success=false
        fi

        if [ "$invoke_success" = true ]; then
            # Extract human-readable result text and append to output log
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== End $story_cli Output ===" >> "$output_file"
            success "$story_cli completed implementation for $story_id"
            update_monitor_status "complete" "$story_id" "Implementation succeeded"
            append_cost_record "$story_id" "completed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
            post_completion_message "$story_id" "completed"
            return 0
        else
            local exit_code=$?
            # Still capture any partial JSON output
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== $story_cli exited with code $exit_code ===" >> "$output_file"

            # ── Coordinator pre-assessment before next retry ──────────────────
            # Resolve the actual raw file path (may differ by provider).
            local _raw_for_coord="$attempt_raw_file"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord="${json_result_file%.json}_raw.jsonl"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord=""

            # Layer 1: rule-based triage (always runs)
            classify_failure_class "$_raw_for_coord" "$json_result_file" "$exit_code"

            # Layer 2: LLM gate (only for capability/quality failures, only when enabled)
            local _next_model
            _next_model=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .retryModel // ""' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
            _next_model="${_next_model:-${EPAM_RETRY_MODEL:-}}"
            if [ "$COORDINATOR_ESCALATE" = "yes" ] && \
               [ "$COORDINATOR_FAILURE_CLASS" != "env" ] && \
               [ -n "$_next_model" ]; then
                assess_model_escalation "$story_id" "$_raw_for_coord" "$json_result_file" "$output_file" "$_next_model"
            fi

            # Cross-run memory: persist failure evidence so future runs and the
            # coordinator can detect repeated failure patterns across multiple runs.
            local _failures_file="${LOG_DIR}/story-failures.jsonl"
            local _raw_sz=0
            [ -f "$_raw_for_coord" ] && _raw_sz=$(wc -c < "$_raw_for_coord" 2>/dev/null || echo 0)
            local _tokens_out_mem=0
            [ -f "$json_result_file" ] && _tokens_out_mem=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo 0)
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn \
                    --arg sid "$story_id" \
                    --arg fc "$COORDINATOR_FAILURE_CLASS" \
                    --arg model "${STORY_MODEL:-unknown}" \
                    --argjson attempt "$retry_count" \
                    --argjson exit_c "$exit_code" \
                    --argjson raw_sz "${_raw_sz:-0}" \
                    --argjson toks "${_tokens_out_mem:-0}" \
                    --argjson iters "${STORY_MAX_ITERATIONS:-0}" \
                    '{storyId:$sid, failureClass:$fc, model:$model,
                      attempt:$attempt, exitCode:$exit_c, rawBytes:$raw_sz,
                      outputTokens:$toks, maxIterations:$iters,
                      timestamp:(now|todate)}' >> "$_failures_file"
            ) 300>>"${_failures_file}.lock"

            # Layer 3: failure analyst — diagnose test failure and patch PRD or inject
            # skill guidance before the next retry. Only runs when more retries remain.
            if [ $retry_count -lt $MAX_RETRIES ]; then
                run_failure_analyst "$story_id" "$output_file" "$retry_count"
            fi

            retry_count=$((retry_count + 1))
            # If self-healing is confirmed broken, skip to the start of the next rung
            # rather than burning the second attempt. At the last rung (3), abort instead.
            if [ "${HEALING_BROKEN:-0}" -eq 1 ]; then
                local _cur_rung=$(( (retry_count - 1) / 2 ))
                local _next_rung_start=$(( (_cur_rung + 1) * 2 ))
                HEALING_BROKEN=0
                export HEALING_BROKEN
                if [ "$_cur_rung" -ge 3 ] || [ "$_next_rung_start" -gt "$MAX_RETRIES" ]; then
                    error "  [HealingBroken] At max rung — aborting $story_id"
                    break
                else
                    warning "  [HealingBroken] Skipping to rung $((_cur_rung + 1)) (retry $_next_rung_start) for $story_id"
                    retry_count=$_next_rung_start
                fi
            fi
            if [ $retry_count -le $MAX_RETRIES ]; then
                warning "$story_cli failed, retrying in ${RETRY_DELAY}s..."
                sleep $RETRY_DELAY
            fi
        fi
    done

    error "Failed to implement $story_id after $((MAX_RETRIES + 1)) attempts"
    update_monitor_status "fail" "$story_id" "Failed after $((MAX_RETRIES + 1)) attempts"
    append_cost_record "$story_id" "failed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
    post_completion_message "$story_id" "failed"
    return 1
}

# Update story status in PRD
update_story_status() {
    local story_id=$1
    local status=$2  # "completed" or "failed"
    local timestamp=$(date -Iseconds)
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local lock_file="${prd_target}.lock"

    local tmp_file="${prd_target}.tmp.$$"

    (
        flock -w 10 200 || { error "Could not acquire lock on $prd_target"; return 1; }

        if [ "$status" = "completed" ]; then
            jq --arg id "$story_id" --arg ts "$timestamp" \
                '(.stories[] | select(.id == $id)) |= . + {completed: true, status: "completed", completedAt: $ts}' \
                "$prd_target" > "$tmp_file" && mv "$tmp_file" "$prd_target"
            success "Story $story_id marked as completed"
            update_agents_file "$story_id" "completed"
        else
            jq --arg id "$story_id" --arg ts "$timestamp" \
                '(.stories[] | select(.id == $id)) |= . + {status: "failed", lastAttempt: $ts}' \
                "$prd_target" > "$tmp_file" && mv "$tmp_file" "$prd_target"
            warning "Story $story_id marked as failed"
            update_agents_file "$story_id" "failed"
        fi
        # Sync live PRD to dashboard prd.json so viewers update in real-time
        if [ -n "${OUTPUT_DIR:-}" ] && [ -f "$prd_target" ]; then
            cp "$prd_target" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
        fi
    ) 200>"$lock_file"
}

# Append a cost/time record to phase-cost.jsonl
# Called after each story completes (success or failure) for phase-aware tracking
append_cost_record() {
    local story_id=$1 status=$2 started_at=$3 ended_at=$4 output_file=$5 json_result_file=${6:-}
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"

    # Read story metadata from prd.json
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // "unknown"' "$prd_target")
    local agent_id=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target")
    local forecast_hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target")
    local forecast_cost=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedCost // 0' "$prd_target" 2>/dev/null || echo 0)
    local story_effort=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .effort // "medium"' "$prd_target")
    local story_type=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .storyType // "implementation"' "$prd_target")
    local resolved_model="${STORY_MODEL:-}"
    local planner_model="${STORY_PLANNER_MODEL:-}"
    local prompt_tokens_measured="${STORY_PRECOUNT_TOKENS:-0}"
    local invoke_mode="cli"
    [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && invoke_mode="sdk"
    local phase_id="${CURRENT_PHASE:-}"
    if [ -z "$phase_id" ]; then
        # Look up phase from implementationOrder when not set by --phase flag
        phase_id=$(jq -r --arg id "$story_id" \
            '.implementationOrder | to_entries[] | select(.value | contains([$id])) | .key' \
            "$prd_target" | head -1)
        [ -z "$phase_id" ] && phase_id="unknown"
    fi

    # Compute elapsed minutes
    local start_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo 0)
    local end_epoch=$(date -d "$ended_at" +%s 2>/dev/null || echo 0)
    local elapsed_minutes=0
    if [ "$start_epoch" -gt 0 ] && [ "$end_epoch" -gt 0 ]; then
        elapsed_minutes=$(echo "scale=2; ($end_epoch - $start_epoch) / 60" | bc 2>/dev/null || echo "0")
    fi

    # Parse cost/token/turn usage from Claude CLI JSON result (--output-format json)
    local tokens_in=0 tokens_out=0 cost_usd=0 task_turns=0
    if [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        cost_usd=$(jq -r '.total_cost_usd // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_in=$(jq -r '.usage.input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_out=$(jq -r '.usage.output_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Turn count: Claude CLI may report num_turns or turns
        task_turns=$(jq -r '.num_turns // .turns // .usage.turns // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Also capture cache tokens if present
        local cache_create=$(jq -r '.usage.cache_creation_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        local cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Total input includes base + cache tokens
        tokens_in=$(( ${tokens_in:-0} + ${cache_create:-0} + ${cache_read:-0} ))
    fi
    [ -z "$tokens_in" ] && tokens_in=0
    [ -z "$tokens_out" ] && tokens_out=0
    [ -z "$cost_usd" ] && cost_usd=0
    [ -z "$task_turns" ] && task_turns=0

    # If provider returned no cost (e.g. OpenRouter/qwen), compute from pricing table
    if [ "${cost_usd}" = "0" ] || [ "${cost_usd}" = "0.0" ] || [ -z "${cost_usd}" ]; then
        if [ "${tokens_in:-0}" -gt 0 ] || [ "${tokens_out:-0}" -gt 0 ]; then
            local computed_cost
            computed_cost=$(compute_token_cost "${resolved_model:-}" "$tokens_in" "$tokens_out")
            [ -n "$computed_cost" ] && [ "$computed_cost" != "0" ] && cost_usd="$computed_cost"
        fi
    fi

    # Atomic JSONL append with flock
    (
        flock -w 10 200 || { error "Could not acquire lock on $cost_file"; return 1; }
        jq -cn \
            --arg pid "$phase_id" --arg pn "$phase_id" \
            --arg sid "$story_id" --arg st "$title" \
            --arg aid "$agent_id" --arg an "$agent_id" \
            --argjson fh "${forecast_hours:-0}" --argjson fc "${forecast_cost:-0}" \
            --arg sa "$started_at" --arg ea "$ended_at" \
            --argjson em "${elapsed_minutes:-0}" --argjson cu "$cost_usd" \
            --argjson ti "${tokens_in:-0}" --argjson to "${tokens_out:-0}" \
            --argjson tt "${task_turns:-0}" \
            --argjson cr "${cache_read:-0}" --argjson cc "${cache_create:-0}" \
            --arg s "$status" --arg n "" \
            --arg ef "${story_effort:-medium}" --arg stype "${story_type:-implementation}" \
            --arg rm "${resolved_model:-}" \
            --arg pm "${planner_model:-}" \
            --argjson ptm "${prompt_tokens_measured:-0}" \
            --arg im "${invoke_mode}" \
            '{phase_id:$pid, phase_name:$pn, story_id:$sid, story_title:$st,
              agent_id:$aid, agent_name:$an, forecast_hours:$fh, forecast_cost_usd:$fc,
              started_at:$sa, ended_at:$ea, elapsed_minutes:$em,
              task_cost_usd:$cu, task_tokens_in:$ti, task_tokens_out:$to,
              task_turns:$tt, cache_read_tokens:$cr, cache_create_tokens:$cc,
              status:$s, notes:$n,
              effort:$ef, storyType:$stype, resolvedModel:$rm,
              plannerModel:$pm,
              prompt_tokens_measured:$ptm, invokeMode:$im}' >> "$cost_file"
    ) 200>"$lock_file"

    # Emit human-readable cost summary to the run log so it appears in pipeline output.
    log "  Cost[$story_id] model=${resolved_model:-unknown} in=${tokens_in} out=${tokens_out} cost=\$${cost_usd} elapsed=${elapsed_minutes}min status=${status}"

    # GAP-P17: emit StoryArtifact record to story-artifacts.jsonl
    emit_story_artifact "$story_id" "$status" "$phase_id" "$elapsed_minutes" "$cost_usd" "$task_turns" "$json_result_file"
}

# GAP-P17 — Emit a StoryArtifact record to logs/story-artifacts.jsonl.
# When the story has an outputSchema field in the PRD, the agent result text
# is validated against it and the parsed object is included in the artifact.
emit_story_artifact() {
    local story_id=$1 status=$2 phase_id=$3 elapsed_minutes=$4 cost_usd=$5 task_turns=$6 json_result_file=${7:-}
    local artifact_file="${LOG_DIR}/story-artifacts.jsonl"
    local lock_file="${artifact_file}.lock"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Read outputSchema if defined for this story
    local output_schema
    output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")

    # Try to parse structured output from the result file when schema is present
    local structured_output="null"
    if [ -n "$output_schema" ] && [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        local result_text
        result_text=$(jq -r '.result // ""' "$json_result_file" 2>/dev/null || echo "")
        # Extract first JSON object/array from result text
        local extracted
        extracted=$(echo "$result_text" | node -e "
const chunks = []; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => {
    const text = chunks.join('');
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) { try { JSON.parse(m[0]); process.stdout.write(m[0]); } catch { process.stdout.write('null'); } }
    else process.stdout.write('null');
});" 2>/dev/null || echo "null")
        [ -n "$extracted" ] && structured_output="$extracted"
    fi

    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg sid "$story_id" \
            --arg phase "$phase_id" \
            --arg status "$status" \
            --argjson elapsed "${elapsed_minutes:-0}" \
            --argjson cost "${cost_usd:-0}" \
            --argjson turns "${task_turns:-0}" \
            --argjson schema "${output_schema:-null}" \
            --argjson structured "$structured_output" \
            '{storyId:$sid, phase:$phase, status:$status,
              elapsedMinutes:$elapsed, costUsd:$cost, turns:$turns,
              outputSchema:$schema, structuredOutput:$structured,
              timestamp:(now|todate)}' >> "$artifact_file"
    ) 200>"$lock_file"
}

# Return the next sequential KB entry ID (KB-001, KB-002, ...) by reading orchestrations/agents/KB.md
get_next_kb_id() {
    local kb_file="$AUTOMATION_DIR/agents/KB.md"
    if [ ! -f "$kb_file" ]; then
        echo "KB-001"
        return
    fi
    local last_num
    last_num=$(grep -oP '(?<=^## KB-)\d+' "$kb_file" | sort -n | tail -1)
    if [ -z "$last_num" ]; then
        echo "KB-001"
    else
        printf "KB-%03d" $((last_num + 1))
    fi
}

# Return KB entries relevant to a story's agent role.
# Reads from KB-{agentProfile}.md (role-specific) and KB-shared.md.
# Returns at most 10 entries total to bound context injection size.
get_relevant_kb_entries() {
    local story_id=$1
    local kb_dir="$AUTOMATION_DIR/agents"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_profile
    agent_profile=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' "$prd_target" 2>/dev/null || echo "")
    [ -z "$agent_profile" ] && return

    # Collect last 10 lines from role-specific KB + shared KB (shared is a fallback)
    local role_kb="${kb_dir}/KB-${agent_profile}.md"
    local shared_kb="${kb_dir}/KB-shared.md"
    local combined=""
    [ -f "$role_kb"   ] && combined="${combined}$(tail -n 20 "$role_kb" 2>/dev/null)"$'\n'
    [ -f "$shared_kb" ] && combined="${combined}$(tail -n 10 "$shared_kb" 2>/dev/null)"$'\n'

    # Strip blank lines and return at most 10 bullet entries
    printf '%s' "$combined" | grep -v '^[[:space:]]*$' | tail -n 10
}

# Build the KB section appended to every implementation prompt
build_kb_prompt_section() {
    local story_id=$1
    local retry_count=${2:-0}
    local next_kb_id=${3:-KB-001}
    local today
    today=$(date +'%Y-%m-%d')

    local kb_entries
    kb_entries=$(get_relevant_kb_entries "$story_id")

    local retry_note=""
    [ "$retry_count" -gt 0 ] && \
        retry_note="**This is retry attempt ${retry_count}** — a previous attempt failed. You MUST write a KB entry documenting what went wrong and what you changed."

    # Inject external test failure context when available
    if [ -n "${VERIFICATION_FAILURE:-}" ]; then
        printf '%s\n' "$VERIFICATION_FAILURE"
    fi

    printf '\n## Relevant Knowledge Base Entries\n'
    if [ -n "$kb_entries" ]; then
        printf 'The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:\n\n'
        printf '%s\n' "$kb_entries"
    else
        printf 'No prior KB entries match your agent role yet.\n'
    fi

    printf '\n## Knowledge Base Contribution (do this LAST — after writing all implementation files)\n'
    printf 'Your assigned KB entry ID for this run: **%s**\n' "$next_kb_id"
    [ -n "$retry_note" ] && printf '%s\n' "$retry_note"
    printf '\nIMPORTANT: Write ALL implementation files first. Only AFTER writing every required file should you optionally append a KB entry.\n'
    printf 'Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.\n\n'
    printf 'If (and only if) you discover a non-obvious pattern during implementation, append one entry to `orchestrations/agents/KB.md`:\n\n'
    printf '```markdown\n'
    printf '## %s -- %s\n\n' "$next_kb_id" "$today"
    printf '**Category:** <backend|frontend|infrastructure|testing|orchestration>\n'
    printf '**AgentRole:** <your agentRole from the story>\n'
    printf '**Tags:** <comma-separated tech keywords, e.g. typescript, node, cli>\n'
    printf '**Trigger:** <retry|first-success>\n'
    printf '**StoryRef:** %s\n\n' "$story_id"
    printf '<One concise paragraph: the specific pattern, gotcha, or anti-pattern.>\n'
    printf '```\n\n'
    printf 'Only write an entry if the knowledge is genuinely non-obvious. Skip trivial observations.\n'
}

# Update AGENTS.md with implementation record
update_agents_file() {
    local story_id=$1
    local status=$2
    local title=$(get_story_title "$story_id")
    local phase=$(get_story_phase "$story_id")

    if [ ! -f "$AGENTS_FILE" ]; then
        mkdir -p "$(dirname "$AGENTS_FILE")"
        cat > "$AGENTS_FILE" << EOF
# EPAM CLI Agent Learned Patterns

This file tracks implementation history and patterns discovered during autonomous development.

---

EOF
    fi

    cat >> "$AGENTS_FILE" << EOF
## $story_id: $title
- **Date**: $(date +'%Y-%m-%d %H:%M:%S')
- **Phase**: ${phase:-unassigned}
- **Status**: $status
- **Log**: logs/claude_outputs/${story_id}_*.log

EOF
}

# Increment iteration counter
increment_iteration() {
    local current=$(jq -r '.currentIteration' "$PRD_FILE")
    local next=$((current + 1))
    jq ".currentIteration = $next" "$PRD_FILE" > "$PRD_FILE.tmp" && mv "$PRD_FILE.tmp" "$PRD_FILE"
}

# Show PRD status with phase information
show_status() {
    echo ""
    echo -e "${MAGENTA}=== PRD Status ===${NC}"
    echo ""

    local total=$(jq '.stories | length' "$PRD_FILE")
    local completed=$(jq '[.stories[] | select(.completed == true)] | length' "$PRD_FILE")
    local pending=$((total - completed))

    echo -e "Project: ${CYAN}$(jq -r '.project.name' "$PRD_FILE")${NC}"
    echo -e "Total Stories: $total"
    echo -e "Completed: ${GREEN}$completed${NC}"
    echo -e "Pending: ${YELLOW}$pending${NC}"
    echo ""

    # Show next recommended story
    local next=$(get_next_story)
    if [ -n "$next" ]; then
        echo -e "Next recommended: ${WHITE}$next${NC} - $(get_story_title "$next")"
        local phase=$(get_story_phase "$next")
        [ -n "$phase" ] && echo -e "                 Phase: ${CYAN}$phase${NC}"
    fi
    echo ""

    echo -e "${CYAN}Stories by Phase:${NC}"

    local phases=$(get_phases)
    if [ -n "$phases" ]; then
        while IFS= read -r phase; do
            [ -z "$phase" ] && continue
            echo -e "\n  ${WHITE}$phase:${NC}"

            local stories=$(get_phase_stories "$phase")
            while IFS= read -r story_id; do
                [ -z "$story_id" ] && continue
                local title=$(get_story_title "$story_id")
                local priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .priority // "medium"' "$PRD_FILE")
                local priority_badge=""
                case $priority in
                    high) priority_badge=" ${RED}[H]${NC}" ;;
                    low) priority_badge=" ${BLUE}[L]${NC}" ;;
                esac

                if is_story_completed "$story_id"; then
                    echo -e "    ${GREEN}+${NC} $story_id: $title$priority_badge"
                elif are_dependencies_satisfied "$story_id"; then
                    echo -e "    ${YELLOW}o${NC} $story_id: $title$priority_badge ${CYAN}(ready)${NC}"
                else
                    local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                    echo -e "    ${RED}x${NC} $story_id: $title$priority_badge ${RED}(blocked: $deps)${NC}"
                fi
            done <<< "$stories"
        done <<< "$phases"
    else
        # No phases, show flat list
        jq -r '.stories[] | "\(.id): \(.title) [\(if .completed then "DONE" else "PENDING" end)]"' "$PRD_FILE" | while read line; do
            if [[ "$line" == *"[DONE]"* ]]; then
                echo -e "  ${GREEN}+${NC} $line"
            else
                echo -e "  ${YELLOW}o${NC} $line"
            fi
        done
    fi
    echo ""
}

# Dry run - show what would be implemented
dry_run() {
    local stories=("$@")
    local phase_filter=""

    echo ""
    echo -e "${MAGENTA}=== Dry Run ===${NC}"
    echo ""

    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        echo -e "${GREEN}All stories are already completed (or blocked by dependencies)!${NC}"
        return
    fi

    echo "The following stories would be implemented (in order):"
    echo ""

    local order=1
    for story_id in "${stories[@]}"; do
        if ! story_exists "$story_id"; then
            echo -e "  ${RED}x${NC} $story_id - NOT FOUND"
            continue
        fi

        local phase=$(get_story_phase "$story_id")
        local phase_info=""
        [ -n "$phase" ] && phase_info=" ${CYAN}[$phase]${NC}"

        if is_story_completed "$story_id"; then
            echo -e "  ${YELLOW}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [ALREADY COMPLETED]"
        elif ! are_dependencies_satisfied "$story_id"; then
            local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
            echo -e "  ${RED}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [BLOCKED: $deps]"
        else
            echo -e "  ${CYAN}$order.${NC} $story_id - $(get_story_title "$story_id")$phase_info"
            order=$((order + 1))
        fi
    done
    echo ""
}

# Main implementation loop
run_implementation() {
    local stories=("$@")
    local implemented=0
    local failed=0
    local skipped=0

    # If no specific stories provided, get prioritized list
    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        success "All stories are already completed (or blocked by dependencies)!"
        return 0
    fi

    log "======================================"
    log "EPAM CLI Orchestration Loop Starting"
    log "Stories to implement: ${stories[*]}"
    log "======================================"

    echo ""
    get_project_context
    echo ""

    for story_id in "${stories[@]}"; do
        log "--------------------------------------"

        # Validate story exists
        if ! story_exists "$story_id"; then
            error "Story $story_id not found in PRD"
            failed=$((failed + 1))
            continue
        fi

        # Skip if already completed
        if is_story_completed "$story_id"; then
            warning "Story $story_id is already completed, skipping"
            skipped=$((skipped + 1))
            continue
        fi

        # Check dependencies using check-dependencies.sh if available
        local dep_checker="$SCRIPT_DIR/check-dependencies.sh"
        if [ -x "$dep_checker" ]; then
            # Use dedicated dependency checker for better validation and output
            if ! PRD_FILE="$PRD_FILE" "$dep_checker" "$story_id" 2>&1; then
                local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        else
            # Fallback to inline dependency check
            if ! are_dependencies_satisfied "$story_id"; then
                local deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        fi

        # Implement the story
        if implement_story "$story_id"; then
            update_story_status "$story_id" "completed"
            implemented=$((implemented + 1))
        else
            update_story_status "$story_id" "failed"
            failed=$((failed + 1))
        fi

        increment_iteration
    done

    log "======================================"
    log "EPAM CLI Orchestration Loop Complete"
    log "Implemented: $implemented, Failed: $failed, Skipped: $skipped"
    log "======================================"

    if [ $failed -gt 0 ]; then
        return 1
    fi
    return 0
}

# Setup git worktrees for parallel execution
# Runs git commands from GIT_WORK_ROOT (the directory containing .git)
# Worktrees are created as siblings of GIT_WORK_ROOT
setup_worktrees() {
    local worktrees=("primary" "independent")
    local git_root
    git_root="$(cd "$GIT_WORK_ROOT" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Setting up git worktrees (git root: $git_root)..."

    # Validate GIT_WORK_ROOT is a git repo
    if ! git -C "$git_root" rev-parse --is-inside-work-tree &>/dev/null; then
        error "GIT_WORK_ROOT ($git_root) is not a git repository"
        return 1
    fi

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"
        local wt_branch="wt-$wt"

        # Check if worktree already exists
        if [ -d "$wt_path" ]; then
            warning "Worktree already exists: $wt_path"
            continue
        fi

        # Delete branch if it exists from previous run
        if git -C "$git_root" show-ref --verify --quiet "refs/heads/$wt_branch"; then
            info "Deleting existing branch: $wt_branch"
            git -C "$git_root" branch -D "$wt_branch" 2>/dev/null || true
        fi

        # Create worktree with a new branch based on current HEAD
        info "Creating worktree: $wt ($wt_path) on branch $wt_branch"
        git -C "$git_root" worktree add -b "$wt_branch" "$wt_path" HEAD || {
            error "Failed to create worktree: $wt"
            return 1
        }
    done

    success "Worktrees created successfully"
    return 0
}

# Cleanup git worktrees
cleanup_worktrees() {
    local worktrees=("primary" "independent")
    local git_root
    git_root="$(cd "$GIT_WORK_ROOT" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Cleaning up git worktrees..."

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"

        # Check if worktree exists
        if [ ! -d "$wt_path" ]; then
            info "Worktree does not exist: $wt_path (already removed)"
            continue
        fi

        # Remove worktree
        info "Removing worktree: $wt ($wt_path)"
        git -C "$git_root" worktree remove "$wt_path" --force || {
            warning "Failed to remove worktree: $wt (may need manual cleanup)"
        }
    done

    # Prune worktree references
    git -C "$git_root" worktree prune

    success "Worktrees cleaned up"
    return 0
}

# Print usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [STORY_IDS...]

EPAM CLI Orchestration script for implementing PRD stories.

Options:
  --status              Show current PRD status with phase information
  --list-phases         Show all implementation phases and their stories
  --phase NAME          Implement all incomplete stories in a specific phase
  --worktree NAME       Run in worktree mode (primary|independent)
  --setup-worktrees     Create git worktrees for parallel execution
  --cleanup-worktrees   Remove git worktrees
  --dry-run             Show what would be implemented without running
  --interactive         Run with permission prompts (safer, requires approval)
  --help                Show this help message

Arguments:
  STORY_IDS       Specific story IDs to implement (e.g., US-001 US-002)
                  If not provided, implements stories in priority order

Story Prioritization:
  Stories are implemented based on:
  1. Phase order (from implementationOrder in prd.json)
  2. Dependency satisfaction (blocked stories are skipped)
  3. Priority field (high > medium > low)

Environment Variables:
  CLAUDE_CMD      Path to Claude CLI (default: claude)

Permissions:
  By default, the script runs with --dangerously-bypass-approvals-and-sandbox to allow
  autonomous file read/write operations. Use --interactive if you want to
  manually approve each operation.

Examples:
  $(basename "$0")                      # Implement next stories (priority order)
  $(basename "$0") --phase phase1       # Implement phase1 stories only
  $(basename "$0") --list-phases        # Show all phases and progress
  $(basename "$0") US-001 US-002        # Implement specific stories
  $(basename "$0") --dry-run            # Preview implementation order
  $(basename "$0") --status             # Show PRD status
  $(basename "$0") --interactive        # Run with manual approval prompts

EOF
}

# Main entry point
main() {
    local dry_run_mode=false
    local status_mode=false
    local list_phases_mode=false
    local interactive_mode=false
    local phase_filter=""
    local stories=()

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                usage
                exit 0
                ;;
            --status)
                status_mode=true
                shift
                ;;
            --list-phases)
                list_phases_mode=true
                shift
                ;;
            --phase)
                if [ -z "$2" ] || [[ "$2" == --* ]]; then
                    error "--phase requires a phase name"
                    exit 1
                fi
                phase_filter="$2"
                shift 2
                ;;
            --dry-run)
                dry_run_mode=true
                shift
                ;;
            --worktree)
                if [ -z "$2" ] || [[ "$2" == --* ]]; then
                    error "--worktree requires a worktree name (primary|independent)"
                    exit 1
                fi
                if [[ "$2" != "primary" && "$2" != "independent" ]]; then
                    error "Invalid worktree name: $2 (must be 'primary' or 'independent')"
                    exit 1
                fi
                WORKTREE_MODE="$2"
                # Save main PRD location for reference
                MAIN_PRD_FILE="$PRD_FILE"
                # Save main project root BEFORE switching to worktree path.
                # technicalNotes.files in the PRD contain absolute paths referencing
                # the main repo (e.g. /path/to/skyscanner-app/src/foo.ts).
                # We rewrite these to the worktree path in verify_story_deliverables
                # and in the agent prompt so agents write to the worktree, not the main repo.
                MAIN_PROJECT_ROOT="$(cd "$GIT_WORK_ROOT" && pwd)"
                # Update GIT_WORK_ROOT and PROJECT_ROOT to worktree for file operations
                local _git_basename
                _git_basename="$(basename "$MAIN_PROJECT_ROOT")"
                GIT_WORK_ROOT="$(cd "$GIT_WORK_ROOT/.." && pwd)/${_git_basename}-wt-$WORKTREE_MODE"
                PROJECT_ROOT="$GIT_WORK_ROOT"
                # Keep PRD_FILE pointing to MAIN - single source of truth
                # (Do NOT set PRD_FILE to worktree's prd.json - it will be stale)
                shift 2
                ;;
            --setup-worktrees)
                initialize
                check_prerequisites
                setup_worktrees
                exit $?
                ;;
            --cleanup-worktrees)
                cleanup_worktrees
                exit $?
                ;;
            --interactive)
                interactive_mode=true
                shift
                ;;
            -*)
                error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                stories+=("$1")
                shift
                ;;
        esac
    done

    # If interactive mode, clear the permission flags
    if [ "$interactive_mode" = true ]; then
        CLAUDE_PERMISSIONS=()
        warning "Running in interactive mode - you will be prompted for permissions"
    fi

    # Initialize
    initialize
    check_prerequisites

    # Execute requested mode
    if [ "$status_mode" = true ]; then
        show_status
        exit 0
    fi

    if [ "$list_phases_mode" = true ]; then
        list_phases
        exit 0
    fi

    # If phase filter specified, get stories for that phase
    if [ -n "$phase_filter" ]; then
        local phase_stories=$(get_phase_stories "$phase_filter")
        if [ -z "$phase_stories" ]; then
            error "Phase '$phase_filter' not found or has no stories"
            echo ""
            echo "Available phases:"
            get_phases | while read p; do echo "  - $p"; done
            exit 1
        fi

        # When in worktree mode, filter phase stories by agent group
        if [ -n "$WORKTREE_MODE" ]; then
            local filtered_stories=()
            while IFS= read -r sid; do
                [ -z "$sid" ] && continue
                local story_group=$(jq -r --arg id "$sid" \
                    '.stories[] | select(.id == $id) | .agentGroup // "main"' "$PRD_FILE")
                if [ "$story_group" = "$WORKTREE_MODE" ]; then
                    filtered_stories+=("$sid")
                fi
            done <<< "$phase_stories"
            stories=("${filtered_stories[@]}")
            info "Filtered to ${#stories[@]} stories for agent group: $WORKTREE_MODE"
        else
            mapfile -t stories < <(echo "$phase_stories")
        fi
        CURRENT_PHASE="$phase_filter"
        info "Running phase: $phase_filter"

        # Initialize/update monitor status file for this phase, merging with existing stories
        local existing_phase
        existing_phase=$(jq -r '.phase // ""' "$MONITOR_STATUS_FILE" 2>/dev/null || echo "")
        if [ ! -f "$MONITOR_STATUS_FILE" ] || [ "$existing_phase" != "$phase_filter" ]; then
            local new_stories
            new_stories=$(jq -r --arg phase "$phase_filter" \
                '(.implementationOrder[$phase] // []) as $ids |
                 [.stories[] | select(.id as $id | $ids | index($id)) |
                  {key: .id, value: {status: (if .completed then "complete" else "pending" end),
                   lane: (.agentGroup // "main"), role: (.agentRole // ""),
                   title: .title, updatedAt: null}}] |
                 from_entries' "$PRD_FILE" 2>/dev/null || echo '{}')
            local orch_mode
            orch_mode=$(jq -r --arg ph "$phase_filter" '.phasesConfig[$ph].orchestrationMode // "bash"' "$PRD_FILE" 2>/dev/null || echo "bash")
            # Merge: keep existing stories, add new phase stories on top
            local existing_stories='{}'
            if [ -f "$MONITOR_STATUS_FILE" ]; then
                existing_stories=$(jq -r '.stories // {}' "$MONITOR_STATUS_FILE" 2>/dev/null || echo '{}')
            fi
            local merged_stories
            merged_stories=$(jq -n --argjson existing "$existing_stories" --argjson new "$new_stories" \
                '$existing * $new')
            local tmp_init
            tmp_init=$(mktemp "${MONITOR_STATUS_FILE}.init.XXXXXX")
            jq -n \
                --arg started "$(date -Iseconds)" \
                --arg phase "$phase_filter" \
                --arg mode "$orch_mode" \
                --argjson stories "$merged_stories" \
                '{startedAt: $started, phase: $phase, orchMode: $mode,
                  lanes: {
                    main:        {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0},
                    primary:     {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0},
                    independent: {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0}
                  },
                  events: [], stories: $stories}' > "$tmp_init" && mv "$tmp_init" "$MONITOR_STATUS_FILE"
            info "Monitor status file updated for phase: $phase_filter"
        fi
    fi

    if [ "$dry_run_mode" = true ]; then
        dry_run "${stories[@]}"
        exit 0
    fi

    # Step 0.5: Pre-phase skill assessment (main process only, not worktree subprocesses)
    # Skip when phase_filter is empty — per-story invocations have no phase context
    [ -z "$WORKTREE_MODE" ] && [ "${SKIP_SKILL_ASSESSMENT:-0}" != "1" ] && [ -n "$phase_filter" ] && run_pre_phase_assessment "$phase_filter"

    # -- Parallel lane execution --
    # When not already in worktree mode, partition stories by agentGroup.
    # main stories run sequentially first; primary + independent launch in parallel.
    if [ -z "$WORKTREE_MODE" ] && [ -n "$phase_filter" ]; then
        local main_stories=() primary_stories=() independent_stories=()
        for sid in "${stories[@]}"; do
            local grp
            grp=$(jq -r --arg id "$sid" \
                '.stories[] | select(.id == $id) | .agentGroup // "main"' "$PRD_FILE")
            case "$grp" in
                primary)     primary_stories+=("$sid") ;;
                independent) independent_stories+=("$sid") ;;
                *)           main_stories+=("$sid") ;;
            esac
        done

        # Run main-lane stories sequentially first
        if [ ${#main_stories[@]} -gt 0 ]; then
            info "Running ${#main_stories[@]} main-lane stories sequentially..."
            run_implementation "${main_stories[@]}"
        fi

        # If there are worktree-lane stories, set up worktrees and launch in parallel
        local need_worktrees=false
        [ ${#primary_stories[@]} -gt 0 ]     && need_worktrees=true
        [ ${#independent_stories[@]} -gt 0 ] && need_worktrees=true

        if [ "$need_worktrees" = true ]; then
            info "Setting up git worktrees for parallel execution..."
            setup_worktrees || warning "Worktree setup had errors — continuing"

            local PRIMARY_PID="" INDEPENDENT_PID=""
            local SCRIPT_PATH
            SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"

            if [ ${#primary_stories[@]} -gt 0 ]; then
                info "Launching primary lane (${#primary_stories[@]} stories) in background..."
                PRD_FILE="$PRD_FILE" "$SCRIPT_PATH" --worktree primary --phase "$phase_filter" \
                    > "$LOG_DIR/wt-primary.log" 2>&1 &
                PRIMARY_PID=$!
                info "  Primary agent PID: $PRIMARY_PID"
            fi

            if [ ${#independent_stories[@]} -gt 0 ]; then
                info "Launching independent lane (${#independent_stories[@]} stories) in background..."
                PRD_FILE="$PRD_FILE" "$SCRIPT_PATH" --worktree independent --phase "$phase_filter" \
                    > "$LOG_DIR/wt-independent.log" 2>&1 &
                INDEPENDENT_PID=$!
                info "  Independent agent PID: $INDEPENDENT_PID"
            fi

            # Wait for parallel lanes to finish
            local primary_exit=0 independent_exit=0
            if [ -n "$PRIMARY_PID" ]; then
                wait "$PRIMARY_PID" || primary_exit=$?
                [ $primary_exit -eq 0 ] \
                    && success "Primary lane completed" \
                    || warning "Primary lane exited with code $primary_exit — see $LOG_DIR/wt-primary.log"
            fi
            if [ -n "$INDEPENDENT_PID" ]; then
                wait "$INDEPENDENT_PID" || independent_exit=$?
                [ $independent_exit -eq 0 ] \
                    && success "Independent lane completed" \
                    || warning "Independent lane exited with code $independent_exit — see $LOG_DIR/wt-independent.log"
            fi
        fi

        return 0
    fi

    # Fallback: no phase filter or already in worktree mode — run sequentially
    run_implementation "${stories[@]}"
}

run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    local profiles_backup="${profiles_file}.original"
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    if [ ! -f "$profiles_backup" ]; then
        cp "$profiles_file" "$profiles_backup"
        info "Backed up original profiles to $profiles_backup"
    fi

    info "Running pre-phase skill assessment for '$phase_id'..."

    local prd_rel
    prd_rel=$(realpath --relative-to="$PROJECT_ROOT" "$PRD_FILE" 2>/dev/null || echo "orchestrations/prd.json")

    local assessment_prompt
    assessment_prompt=$(cat << PROMPT_HEADER
You are the skill assessment agent running in PRE-PHASE mode. Your job is to detect skill gaps in agent profiles BEFORE the phase runs, augment profiles with missing knowledge, and ensure test stories have the correct agent role.

## PRD STRUCTURE (read this carefully before issuing any jq commands)
The PRD file uses a FLAT structure — not nested phases. Key paths:
- Story list: .stories[]
- Phase story order: .implementationOrder["${phase_id}"] — returns an array of story IDs
- Story lookup: .stories[] | select(.id == "<id>")
- Agent role: .stories[] | select(.id == "<id>") | .agentRole
- Files: .stories[] | select(.id == "<id>") | .technicalNotes.files[]

DO NOT use .phases[0] — that path does not exist in this PRD.

## Task
1. Run: jq -r '.implementationOrder["${phase_id}"][]' ${prd_rel}
   This gives you the list of story IDs for this phase.

2. For each story ID, run: jq -c '.stories[] | select(.id == "<id>") | {id, agentRole, unitTests, technicalNotes}' ${prd_rel}

3. ROLE VERIFICATION: For any story where all files in technicalNotes.files match *.test.ts or *.spec.ts:
   - If agentRole is not "test-engineer", update it: jq --arg id "<id>" '(.stories[] | select(.id == \$id)).agentRole = "test-engineer"' ${prd_rel} > /tmp/prd_tmp.json && mv /tmp/prd_tmp.json ${prd_rel}
   - Ensure the test-engineer profile exists in orchestrations/agents/profiles.json

4. PROFILE CREATION: If "test-engineer" key is missing from profiles.json, add it based on the project's techStack in the PRD (read .project.techStack).

5. SKILL GAP FILL: For each story, compare agentRole profile text against technicalNotes.requiredSkills. Add missing skills as sentences. Keep profiles.json valid JSON.

6. Append JSONL audit records to orchestrations/logs/profiles-audit.jsonl using flock.

7. Write summary to orchestrations/logs/phase-improvements/pre-${phase_id}.md

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

CRITICAL: Keep profiles.json valid JSON. Only ADD content, never remove. Use the exact jq paths above.

## Phase: ${phase_id}
PROMPT_HEADER
    )

    cd "$PROJECT_ROOT"
    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    local _orch_model="${ORCH_GATE_MODEL:-}"
    if [ -z "$_orch_provider" ]; then
        warning "Pre-phase assessment: EPAM_ORCHESTRATION_PROVIDER not set — skipping (non-critical)"
    elif echo "$assessment_prompt" | \
            AI_PROVIDER="$_orch_provider" \
            AI_MODEL="$_orch_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
            ${_orch_model:+--model "$_orch_model"} \
            2>&1 | tee "$assessment_log"; then
        success "Pre-phase assessment completed for '$phase_id'"
        if ! jq empty "$profiles_file" 2>/dev/null; then
            warning "Pre-phase assessment may have corrupted profiles.json! Restoring backup."
            cp "$profiles_backup" "$profiles_file"
        fi
    else
        warning "Pre-phase assessment failed for '$phase_id' (non-critical, continuing)"
    fi
}

# Run main
main "$@"
