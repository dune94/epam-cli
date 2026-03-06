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
# Note: By default, runs with --dangerously-skip-permissions for autonomous operation.
#       Use --interactive flag if you want to approve each file operation.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
LOG_DIR="${OUTPUT_DIR:-$AUTOMATION_DIR/logs}"
PROGRESS_LOG="$LOG_DIR/progress.txt"
AGENTS_FILE="$AUTOMATION_DIR/agents/AGENTS.md"
CLAUDE_OUTPUT_DIR="$LOG_DIR/claude_outputs"
AGENT_PROFILES_FILE="$AUTOMATION_DIR/agents/profiles.json"
MONITOR_STATUS_FILE="$LOG_DIR/agent-status.json"

# Worktree configuration (set by --worktree flag)
WORKTREE_MODE=""        # "primary", "independent", or "" for main
MAIN_PRD_FILE=""        # Points to main repo's prd.json when in worktree mode
REVIEW_PHASE=""         # Phase name for --review-phase mode
CURRENT_PHASE=""        # Current phase being executed (for cost tracking)

# Configuration
CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # Allow override via environment
EPAM_CLI="${EPAM_CLI:-epam}"        # epam-cli binary; override with mock for testing
MAX_RETRIES=2
RETRY_DELAY=5
# Orchestration mode — inherited from run-agent-orchestration.sh or set directly
ORCH_MODE="${ORCH_MODE:-bash}"

# Effort -> model + max-turns mapping
# Stories carry an optional "effort" field: low | medium (default) | high
# These map to a model and a max-turns cap for the Claude CLI invocation.
EFFORT_MODEL_LOW="claude-haiku-4-5-20251001"
EFFORT_MODEL_MEDIUM="claude-sonnet-4-5-20250929"
EFFORT_MODEL_HIGH="claude-opus-4-6"

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
            STORY_MAX_TURNS=10
            ;;
        high)
            STORY_MODEL="$EFFORT_MODEL_HIGH"
            STORY_MAX_TURNS=""
            ;;
        *)  # medium (default)
            STORY_MODEL="$EFFORT_MODEL_MEDIUM"
            STORY_MAX_TURNS=30
            ;;
    esac
    log "  Effort[$effort] -> model=$(basename $STORY_MODEL) turns=${STORY_MAX_TURNS:-unlimited}"
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

# resolve_provider_settings <story_id>
# Reads aiProvider from the story and sets STORY_PROVIDER global.
# Values: claude-sonnet | claude-opus | opencode | codex | epam (default: claude-sonnet)
resolve_provider_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PROVIDER=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .aiProvider // "claude-sonnet"' \
        "$prd_target" 2>/dev/null || echo "claude-sonnet")
    log "  Provider[$STORY_PROVIDER] -> CLI=$(provider_to_cli "$STORY_PROVIDER")"
}

# provider_to_cli <provider>
# Returns the CLI binary name for a given aiProvider value.
provider_to_cli() {
    case "$1" in
        opencode)                    echo "opencode" ;;
        codex)                       echo "codex" ;;
        codemie-claude)              echo "codemie-claude" ;;
        copilot|openai|qwen|cursor)  echo "$EPAM_CLI" ;;
        epam)                        echo "$CLAUDE_CMD" ;;  # epam: treat same as claude for now
        *)                           echo "$CLAUDE_CMD" ;;  # claude-sonnet, claude-opus, etc.
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
            # Normalize to the standard orchestration schema used by append_cost_record.
            jq '{
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

# Claude CLI permission flags
# These allow Claude to read/write files and execute commands without prompting
CLAUDE_PERMISSIONS=(
    "--dangerously-skip-permissions"  # Skip all permission prompts for autonomous operation
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

    # Check for Claude CLI
    if ! command -v "$CLAUDE_CMD" &> /dev/null; then
        error "Claude CLI not found. Expected command: $CLAUDE_CMD"
        error "Install Claude Code CLI or set CLAUDE_CMD environment variable"
        exit 1
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
    local messages_jsonl="$AUTOMATION_DIR/logs/agent-messages.jsonl"

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
Append a single-line JSON record to orchestrations/logs/agent-messages.jsonl:
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
Write it atomically: (flock -w 10 9 >> orchestrations/logs/agent-messages.jsonl; printf '%s\n' '<json>' >&9) 9>>orchestrations/logs/agent-messages.jsonl

## Story to Plan
Read orchestrations/prd.json for story ${story_id} full details, then produce the plan above.
PLAN_PROMPT_EOF
    )

    log "Plan mode: generating execution plan for $story_id..."
    touch "$messages_jsonl"
    cd "$PROJECT_ROOT"
    if echo "$plan_prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --print --output-format json \
            "${CLAUDE_PERMISSIONS[@]}" 2>/dev/null > "$plan_json"; then
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
    local messages_jsonl="$AUTOMATION_DIR/logs/agent-messages.jsonl"
    local lock_file="${messages_jsonl}.lock"

    # Skip if bash-only mode and bus hasn't been seeded yet
    if [ "${ORCH_MODE:-bash}" != "hybrid" ] && [ ! -f "$messages_jsonl" ]; then
        return 0
    fi

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
    local monitor_file="$AUTOMATION_DIR/logs/agent-status.json"

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
    local dependencies=$(echo "$story_json" | jq -r '.dependencies | join(", ")')

    cat << EOF
Implement user story $story_id: $title

## Story Description
$description

## Acceptance Criteria
- $acceptance_criteria

## Technical Notes
$([ -n "$technical_notes" ] && echo "$technical_notes" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")' 2>/dev/null || echo "None specified")

## Files to Create/Modify
$files

## Dependencies
${dependencies:-None}

## Instructions
1. Implement all acceptance criteria for this story
2. Follow the project's existing code patterns and conventions
3. Create any necessary files in the locations specified
4. Ensure code compiles/runs without errors
5. Do NOT create tests unless explicitly required in acceptance criteria

After implementation, provide a brief summary of what was created/modified.
EOF
}

# Update monitor lane/story status via update-monitor.sh
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
    # Resolve aiProvider -> which CLI binary to use
    resolve_provider_settings "$story_id"
    # For epam-run providers, prd.json .model field overrides effort-based model
    case "${STORY_PROVIDER:-claude-sonnet}" in
        copilot|openai|qwen|cursor) resolve_model_from_story "$story_id" ;;
    esac
    local model_flag=()
    local turns_flag=()
    [ -n "${STORY_MODEL:-}" ]     && model_flag=(--model "$STORY_MODEL")
    [ -n "${STORY_MAX_TURNS:-}" ] && turns_flag=(--max-turns "$STORY_MAX_TURNS")
    local story_cli
    story_cli=$(provider_to_cli "${STORY_PROVIDER:-claude-sonnet}")

    while [ $retry_count -le $MAX_RETRIES ]; do
        # Rebuild prompt each attempt: retry_count and KB ID must reflect current state
        local next_kb_id
        next_kb_id=$(get_next_kb_id)
        local prompt
        prompt="$(build_implementation_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"

        # Log the prompt
        echo "=== Prompt for $story_id (attempt $((retry_count + 1))) ===" >> "$output_file"
        echo "$prompt" >> "$output_file"
        echo "=== End Prompt ===" >> "$output_file"
        echo "" >> "$output_file"

        log "Invoking $story_cli (attempt $((retry_count + 1))/$((MAX_RETRIES + 1)))..."

        # Change to project root for the CLI to have correct context
        cd "$PROJECT_ROOT"

        echo "=== $story_cli Output (attempt $((retry_count + 1))) ===" >> "$output_file"

        local json_result_file="${output_file%.log}_result.json"
        local invoke_success=false

        case "${STORY_PROVIDER:-claude-sonnet}" in
            opencode)
                # OpenCode: pass prompt via temp file (prompts can exceed arg limits)
                # --format json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local prompt_file="${json_result_file%.json}_prompt.txt"
                echo "$prompt" > "$prompt_file"
                if opencode run --format json "$(cat "$prompt_file")" \
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
                if echo "$prompt" | codex exec --json - \
                        > "$raw_file" 2>/dev/null; then
                    normalize_provider_json "codex" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                        | jq -r '.item.text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            codemie-claude)
                # codemie-claude: same invocation pattern as claude — --print --output-format json
                if echo "$prompt" | env -u CLAUDECODE codemie-claude --print --output-format json \
                        "${model_flag[@]}" "${turns_flag[@]}" "${CLAUDE_PERMISSIONS[@]}" \
                        2>/dev/null > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            copilot|openai|qwen|cursor)
                # epam-run providers: invoke via `epam run --provider X --model M --json`
                # EPAM_CLI can be overridden with a mock for zero-token testing.
                local raw_file="${json_result_file%.json}_raw.json"
                local epam_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && epam_model_flag=(--model "$STORY_MODEL")
                if echo "$prompt" | "$EPAM_CLI" run \
                        --provider "$STORY_PROVIDER" \
                        "${epam_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>/dev/null; then
                    normalize_provider_json "epam-run" "$raw_file" "$json_result_file"
                    jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            epam)
                # epam: treat same as claude — same CLI, same output format
                if echo "$prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --print --output-format json \
                        "${model_flag[@]}" "${turns_flag[@]}" "${CLAUDE_PERMISSIONS[@]}" \
                        2>/dev/null > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            *)
                # Claude (claude-sonnet, claude-opus, or any claude-* value)
                # --print --output-format json captures cost+tokens in a single JSON object
                if echo "$prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --print --output-format json \
                        "${model_flag[@]}" "${turns_flag[@]}" "${CLAUDE_PERMISSIONS[@]}" \
                        2>/dev/null > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
        esac

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

            retry_count=$((retry_count + 1))
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
        # Sync PRD_FILE to orchestrations/game-prd.json if it's a non-default PRD (for dashboard viewers)
        local default_prd="$AUTOMATION_DIR/prd.json"
        if [ "$prd_target" != "$default_prd" ] && [ -f "$prd_target" ]; then
            local sync_dest="$AUTOMATION_DIR/game-prd.json"
            cp "$prd_target" "$sync_dest" 2>/dev/null || true
        fi
    ) 200>"$lock_file"
}

# Append a cost/time record to phase-cost.jsonl
# Called after each story completes (success or failure) for phase-aware tracking
append_cost_record() {
    local story_id=$1 status=$2 started_at=$3 ended_at=$4 output_file=$5 json_result_file=${6:-}
    local cost_file="$AUTOMATION_DIR/logs/phase-cost.jsonl"
    local lock_file="${cost_file}.lock"

    # Read story metadata from prd.json
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // "unknown"' "$prd_target")
    local agent_id=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target")
    local forecast_hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target")
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

    # Atomic JSONL append with flock
    (
        flock -w 10 200 || { error "Could not acquire lock on $cost_file"; return 1; }
        jq -cn \
            --arg pid "$phase_id" --arg pn "$phase_id" \
            --arg sid "$story_id" --arg st "$title" \
            --arg aid "$agent_id" --arg an "$agent_id" \
            --argjson fh "${forecast_hours:-0}" --argjson fc 0 \
            --arg sa "$started_at" --arg ea "$ended_at" \
            --argjson em "${elapsed_minutes:-0}" --argjson cu "$cost_usd" \
            --argjson ti "${tokens_in:-0}" --argjson to "${tokens_out:-0}" \
            --argjson tt "${task_turns:-0}" \
            --argjson cr "${cache_read:-0}" --argjson cc "${cache_create:-0}" \
            --arg s "$status" --arg n "" \
            '{phase_id:$pid, phase_name:$pn, story_id:$sid, story_title:$st,
              agent_id:$aid, agent_name:$an, forecast_hours:$fh, forecast_cost_usd:$fc,
              started_at:$sa, ended_at:$ea, elapsed_minutes:$em,
              task_cost_usd:$cu, task_tokens_in:$ti, task_tokens_out:$to,
              task_turns:$tt, cache_read_tokens:$cr, cache_create_tokens:$cc,
              status:$s, notes:$n}' >> "$cost_file"
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

# Return KB entries from orchestrations/agents/KB.md whose AgentRole matches the current story
get_relevant_kb_entries() {
    local story_id=$1
    local kb_file="$AUTOMATION_DIR/agents/KB.md"
    [ ! -f "$kb_file" ] && return

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' "$prd_target")
    [ -z "$agent_role" ] && return

    # Extract full entry blocks whose AgentRole line contains the role
    awk -v role="$agent_role" '
        /^## KB-[0-9]/ {
            if (entry != "" && matched) printf "%s\n", entry
            entry = $0 "\n"; matched = 0; next
        }
        { entry = entry $0 "\n" }
        /\*\*AgentRole:\*\*/ { if (index($0, role) > 0) matched = 1 }
        END { if (entry != "" && matched) printf "%s\n", entry }
    ' "$kb_file"
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

    printf '\n## Relevant Knowledge Base Entries\n'
    if [ -n "$kb_entries" ]; then
        printf 'The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:\n\n'
        printf '%s\n' "$kb_entries"
    else
        printf 'No prior KB entries match your agent role yet.\n'
    fi

    printf '\n## Knowledge Base Contribution\n'
    printf 'Your assigned KB entry ID for this run: **%s**\n' "$next_kb_id"
    [ -n "$retry_note" ] && printf '%s\n' "$retry_note"
    printf '\nIf you discover a non-obvious pattern, gotcha, or anti-pattern during this implementation (or this is a retry), append exactly one entry to `orchestrations/agents/KB.md` using this format:\n\n'
    printf '```markdown\n'
    printf '## %s -- %s\n\n' "$next_kb_id" "$today"
    printf '**Category:** <backend|frontend|infrastructure|testing|orchestration>\n'
    printf '**AgentRole:** <your agentRole from the story>\n'
    printf '**Tags:** <comma-separated tech keywords, e.g. typescript, node, cli>\n'
    printf '**Trigger:** <retry|first-success>\n'
    printf '**StoryRef:** %s\n\n' "$story_id"
    printf '<One concise paragraph: the specific pattern, gotcha, or anti-pattern. Precise enough that a future Claude instance can apply it without re-discovering it.>\n'
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
setup_worktrees() {
    local worktrees=("primary" "independent")

    log "Setting up git worktrees..."

    for wt in "${worktrees[@]}"; do
        local wt_path="$PROJECT_ROOT/../epam-cli-wt-$wt"
        local wt_branch="wt-$wt"

        # Check if worktree already exists
        if [ -d "$wt_path" ]; then
            warning "Worktree already exists: $wt_path"
            continue
        fi

        # Delete branch if it exists from previous run
        if git show-ref --verify --quiet "refs/heads/$wt_branch"; then
            info "Deleting existing branch: $wt_branch"
            git branch -D "$wt_branch" 2>/dev/null || true
        fi

        # Create worktree with a new branch based on current HEAD
        info "Creating worktree: $wt ($wt_path) on branch $wt_branch"
        git worktree add -b "$wt_branch" "$wt_path" HEAD || {
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

    log "Cleaning up git worktrees..."

    for wt in "${worktrees[@]}"; do
        local wt_path="$PROJECT_ROOT/../epam-cli-wt-$wt"

        # Check if worktree exists
        if [ ! -d "$wt_path" ]; then
            info "Worktree does not exist: $wt_path (already removed)"
            continue
        fi

        # Remove worktree
        info "Removing worktree: $wt ($wt_path)"
        git worktree remove "$wt_path" --force || {
            warning "Failed to remove worktree: $wt (may need manual cleanup)"
        }
    done

    # Prune worktree references
    git worktree prune

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
  By default, the script runs with --dangerously-skip-permissions to allow
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
                # Update PROJECT_ROOT to worktree for file operations
                PROJECT_ROOT="$PROJECT_ROOT/../epam-cli-wt-$WORKTREE_MODE"
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
    [ -z "$WORKTREE_MODE" ] && run_pre_phase_assessment "$phase_filter"

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
    local profiles_file="$AUTOMATION_DIR/agents/profiles.json"
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
You are the skill assessment agent running in PRE-PHASE mode. Your job is to detect skill gaps in agent profiles BEFORE the phase runs, and augment profiles with missing knowledge.

## Task
1. Read ${prd_rel} and find the stories in the current phase's implementationOrder
2. For each story, extract required skills from description + technicalNotes (especially technicalNotes.requiredSkills)
3. Read orchestrations/agents/profiles.json and find the profile for each story's agentRole
4. Compare: does the agent's profile text mention each required skill?
5. For any GAPS found:
   a. Append a sentence to the agent's profile in profiles.json mentioning the missing skill
   b. Append a JSONL record to orchestrations/logs/profiles-audit.jsonl:
      {"timestamp":"<ISO8601>","phase_id":"<phase>","agent_role":"<role>","event":"skill_added","skill":"<skill>","skill_category":"<category>","context":"Story <id> requires <skill>","added_by":"pre-phase-assessment"}
   c. Use flock when writing to JSONL files
6. Write a summary to orchestrations/logs/phase-improvements/pre-${phase_id}.md

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

IMPORTANT: Keep profiles.json valid JSON at all times. Only ADD to existing profile strings, never remove content.

## Phase: ${phase_id}

Read ${prd_rel} implementationOrder["${phase_id}"] for the story list, then proceed with the analysis above.
PROMPT_HEADER
    )

    cd "$PROJECT_ROOT"
    if echo "$assessment_prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --dangerously-skip-permissions 2>&1 | tee "$assessment_log"; then
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
