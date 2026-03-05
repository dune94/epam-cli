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
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
# Compute PRD path relative to PROJECT_ROOT for injecting into agent prompts
PRD_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$PRD_FILE")" 2>/dev/null || echo "orchestrations/prd.json")"
# Select wrapper script based on PROVIDER override or CLAUDE_CMD
case "${EPAM_ORCHESTRATION_PROVIDER:-${CLAUDE_CMD}}" in
    codemie-claude) CLAUDE_SH="$SCRIPT_DIR/codemie-claude.sh" ;;
    copilot)        CLAUDE_SH="$SCRIPT_DIR/copilot.sh" ;;
    openai)         CLAUDE_SH="$SCRIPT_DIR/openai.sh" ;;
    qwen)           CLAUDE_SH="$SCRIPT_DIR/qwen.sh" ;;
    cursor)         CLAUDE_SH="$SCRIPT_DIR/cursor.sh" ;;
    *)              CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
esac
LOG_DIR="$AUTOMATION_DIR/logs"
MONITOR_STATUS_FILE="$LOG_DIR/agent-status.json"
MESSAGES_JSONL="$LOG_DIR/agent-messages.jsonl"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"

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

# Default configuration
PHASE="finops"
DRY_RUN=false
SKIP_CLEANUP=false
# Orchestration mode: bash (default, no change to existing flow) or hybrid
# Override: ORCH_MODE=hybrid ./run-agent-orchestration.sh  OR  --mode hybrid
ORCH_MODE="${ORCH_MODE:-bash}"

# Cleanup on exit
cleanup() {
    local exit_code=$?
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

# Verify phase exists
phase_stories=$(jq -r --arg phase "$PHASE" '.implementationOrder[$phase] // empty' "$PRD_FILE")
if [ -z "$phase_stories" ] || [ "$phase_stories" = "null" ]; then
    error "Phase '$PHASE' not found in prd.json"
    echo ""
    echo "Available phases:"
    jq -r '.implementationOrder | keys[]' "$PRD_FILE" | while read p; do echo "  - $p"; done
    exit 1
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

    cpa_exit=0
    # shellcheck disable=SC2086
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
     select(.agentGroup == "main" and .completed == false) | .id' "$PRD_FILE")

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
    local profiles_file="$AUTOMATION_DIR/agents/profiles.json"
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
    if echo "$assessment_prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --dangerously-skip-permissions 2>&1 | tee "$assessment_log"; then
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
    if echo "$coord_prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --dangerously-skip-permissions 2>&1 | tee "$coord_log"; then
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
            log "  Running: $story"
            "$CLAUDE_SH" "$story" 2>&1 | tee "$LOG_DIR/main-${story}.log"
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
2. For each task, compare elapsed_minutes vs forecast_hours (converted to minutes)
3. Calculate phase-level totals and variance
4. Write a single-line JSON assessment to orchestrations/logs/phase-skill-assessments.jsonl with fields:
   phase_id, phase_name, actual_minutes, forecast_minutes, actual_cost_usd, forecast_cost_usd,
   variance_minutes, variance_cost_usd, over_threshold (bool), agent_recommendations (array), notes
5. Write a human-readable improvement report to orchestrations/logs/phase-improvements/${phase_id}.md
6. CORRECTIVE ACTION: If any task's description clearly requires a different skill domain than the assigned agentRole,
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
    if echo "$assessment_prompt" | env -u CLAUDECODE "$CLAUDE_CMD" --dangerously-skip-permissions 2>&1 | tee "$assessment_log"; then
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
# Step 4: Run review stories
# ──────────────────────────────────────────────
if [ -n "$review_stories" ]; then
    log "Step 4: Running review stories..."
    while IFS= read -r story; do
        [ -z "$story" ] && continue
    "$SCRIPT_DIR/update-monitor.sh" event "code_review" "Team Lead code review completed" "" "main" "team-lead-agent" 2>/dev/null || true
        log "  Running review: $story"
        "$CLAUDE_SH" "$story" 2>&1 | tee "$LOG_DIR/review-${story}.log"
    done <<< "$review_stories"
    success "Review stories complete"
else
    info "Step 4: No review stories in this phase"
fi

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
        log "  Running unit tests (vitest)..."
        if ~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/vitest run \
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
        if ~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsc --noEmit \
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
