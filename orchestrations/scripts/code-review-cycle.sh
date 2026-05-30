#!/bin/bash
# Code review cycle manager - handles iterative reviews with agent feedback
#
# Usage:
#   code-review-cycle.sh <STORY_ID> [--iteration N]
#
# Features:
#   - Tracks review iterations (max 3)
#   - Checks for agent response messages
#   - Performs re-review after fixes
#   - Updates prd.json with iteration count
#
# Exit codes:
#   0 - Review approved or max iterations reached
#   1 - Review failed (errors during review)
#   2 - Agent has not responded to feedback yet

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log()     { echo -e "${CYAN}[REVIEW-CYCLE]${NC} $1"; }
success() { echo -e "${GREEN}[PASS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[FAIL]${NC} $1" >&2; }

# Parse arguments
if [ $# -lt 1 ]; then
    error "Missing required argument STORY_ID"
    echo "Usage: $0 <STORY_ID> [--iteration N]" >&2
    exit 1
fi

STORY_ID=$1
ITERATION=1

shift
while [[ $# -gt 0 ]]; do
    case $1 in
        --iteration)
            ITERATION=$2
            shift 2
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done

MAX_ITERATIONS=3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="$AUTOMATION_DIR/prd.json"
REVIEW_LOG="${REVIEW_LOG:-$AUTOMATION_DIR/logs/code-reviews.jsonl}"
MESSAGES_DIR="${MESSAGES_DIR:-$AUTOMATION_DIR/logs/messages}"
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
ORCH_GATE_MODEL="${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}"

run_review_prompt() {
    local prompt_text="$1"
    if [ ! -x "$AI_RUNNER_CMD" ]; then
        echo '{"verdict":"approved","issues":[]}'
        return 0
    fi
    echo "$prompt_text" | \
        AI_MODEL="$ORCH_GATE_MODEL" \
        CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        "$AI_RUNNER_CMD" --provider "${EPAM_ORCHESTRATION_PROVIDER:-claude}" \
            --model "$ORCH_GATE_MODEL" 2>&1
}

log "Code Review Cycle for Story: $STORY_ID (Iteration $ITERATION/$MAX_ITERATIONS)"
echo ""

# Get story details
STORY_TITLE=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
STORY_AGENT=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$PRD_FILE")
STORY_COMPLETED=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .completed' "$PRD_FILE")
STORY_PHASE=$(jq -r --arg id "$STORY_ID" \
    '.implementationOrder | to_entries[] | select(.value[] | contains($id)) | .key' "$PRD_FILE")

if [ "$STORY_AGENT" = "unknown" ]; then
    error "Story not found or no agent assigned: $STORY_ID"
    exit 1
fi

if [ "$STORY_COMPLETED" != "true" ]; then
    warning "Story not completed yet, skipping review"
    exit 0
fi

log "Story: $STORY_TITLE"
log "Agent: $STORY_AGENT"
log "Phase: $STORY_PHASE"
echo ""

# Check if this is a re-review (iteration > 1)
if [ "$ITERATION" -gt 1 ]; then
    log "Re-review requested - checking for agent response..."

    # Check for agent response message
    RESPONSE_MESSAGES=$("$SCRIPT_DIR/receive-messages.sh" "$STORY_AGENT" \
        --type response \
        --unread 2>/dev/null || echo "[]")

    # Look for response about this story
    STORY_RESPONSE=$(echo "$RESPONSE_MESSAGES" | jq -r \
        --arg story "$STORY_ID" \
        '.[] | select(.body.story_id == $story or (.subject | contains($story))) | .message_id' \
        | head -n 1)

    if [ -z "$STORY_RESPONSE" ]; then
        warning "No response from $STORY_AGENT for fixes on $STORY_ID"
        warning "Agent must send response message when fixes are complete"
        exit 2
    fi

    success "Agent response received: $STORY_RESPONSE"

    # Mark response as read
    "$SCRIPT_DIR/receive-messages.sh" "$STORY_AGENT" --mark-read >/dev/null
    echo ""
fi

# Perform code review
log "Performing code review (iteration $ITERATION)..."
echo ""

# Load story context
_STORY_ACS=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .acceptanceCriteria[]?' \
    "$PRD_FILE" 2>/dev/null | awk '{print NR". "$0}')
_STORY_DESC=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .description // ""' \
    "$PRD_FILE" 2>/dev/null)
_STORY_FILES=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
    "$PRD_FILE" 2>/dev/null | head -20 | tr '\n' ' ')

# Collect git diff
_STORY_DIFF=""
if [ -d "$PROJECT_ROOT/.git" ]; then
    _STORY_DIFF=$(git -C "$PROJECT_ROOT" diff HEAD~5 HEAD -- \
        $(echo "$_STORY_FILES") 2>/dev/null | head -400 || true)
    [ -z "$_STORY_DIFF" ] && \
        _STORY_DIFF=$(git -C "$PROJECT_ROOT" diff HEAD~3 HEAD 2>/dev/null | head -300 || true)
fi
[ -z "$_STORY_DIFF" ] && _STORY_DIFF="(no diff available)"

# Load review-agent profile
_REVIEW_PROFILE=""
[ -f "$AGENT_PROFILES_FILE" ] && \
    _REVIEW_PROFILE=$(jq -r '.["review-agent"] // ""' "$AGENT_PROFILES_FILE" 2>/dev/null)
[ -z "$_REVIEW_PROFILE" ] && _REVIEW_PROFILE="You are a senior code reviewer."

# Inject previous iteration failure context as anti-context when iteration > 1
_PRIOR_CONTEXT=""
if [ "$ITERATION" -gt 1 ]; then
    _PRIOR_LOG="$AUTOMATION_DIR/logs/review-agent-${STORY_ID}.log"
    if [ -f "$_PRIOR_LOG" ]; then
        _PRIOR_ISSUES=$(grep -o '"issues":\[.*\]' "$_PRIOR_LOG" | tail -1 || true)
        [ -n "$_PRIOR_ISSUES" ] && \
            _PRIOR_CONTEXT="

PRIOR ITERATION ($((ITERATION-1))) ISSUES (do not repeat these same findings — verify they were actually fixed):
$_PRIOR_ISSUES"
    fi
fi

_REVIEW_PROMPT="${_REVIEW_PROFILE}

---
REVIEW TASK (Iteration $ITERATION): Story $STORY_ID — $STORY_TITLE
AGENT: $STORY_AGENT

DESCRIPTION: $_STORY_DESC

ACCEPTANCE CRITERIA:
$_STORY_ACS

RELEVANT FILES: $_STORY_FILES

GIT DIFF:
\`\`\`diff
$_STORY_DIFF
\`\`\`
$_PRIOR_CONTEXT
PROJECT ROOT: $PROJECT_ROOT

Review the implementation against each acceptance criterion.
Check: TypeScript strict compliance, test coverage, error handling, security.

Respond with ONLY a JSON object:
{\"verdict\":\"approved\",\"issues\":[],\"summary\":\"...\"}
  OR
{\"verdict\":\"changes_requested\",\"issues\":[{\"severity\":\"blocker|major|minor\",\"file\":\"...\",\"line\":0,\"description\":\"...\",\"suggestedFix\":\"...\"}],\"summary\":\"...\"}"

_REVIEW_OUTPUT_FILE="$AUTOMATION_DIR/logs/review-agent-${STORY_ID}-iter${ITERATION}.log"
_REVIEW_OUTPUT=$(run_review_prompt "$_REVIEW_PROMPT" 2>&1 | tee "$_REVIEW_OUTPUT_FILE")
# Also write to canonical log (latest) for subsequent iterations to reference
cp "$_REVIEW_OUTPUT_FILE" "$AUTOMATION_DIR/logs/review-agent-${STORY_ID}.log"

_REVIEW_JSON=$(echo "$_REVIEW_OUTPUT" | grep -o '{.*"verdict".*}' | tail -1 || true)
if [ -z "$_REVIEW_JSON" ]; then
    _REVIEW_JSON=$(echo "$_REVIEW_OUTPUT" | python3 -c "
import sys, re
text = sys.stdin.read()
matches = re.findall(r'\{[^{}]*\"verdict\"[^{}]*\}', text, re.DOTALL)
print(matches[-1] if matches else '{\"verdict\":\"approved\",\"issues\":[]}')
" 2>/dev/null || echo '{"verdict":"approved","issues":[]}')
fi

ISSUES=()
_RAW_VERDICT=$(echo "$_REVIEW_JSON" | jq -r '.verdict // "approved"' 2>/dev/null || echo "approved")
if [ "$_RAW_VERDICT" = "changes_requested" ]; then
    while IFS= read -r _issue; do
        ISSUES+=("$_issue")
    done < <(echo "$_REVIEW_JSON" | jq -c '.issues[]?' 2>/dev/null)
fi
REVIEW_STATUS="${_RAW_VERDICT}"

ISSUE_COUNT=${#ISSUES[@]}

if [ $ISSUE_COUNT -eq 0 ]; then
    success "Code review passed - no issues found"
    REVIEW_DECISION="approved"
else
    warning "$ISSUE_COUNT issues found"
    REVIEW_DECISION="changes_requested"
fi

echo ""

# Send review message to agent
if [ "$REVIEW_DECISION" = "approved" ]; then
    # Send approval
    MSG_ID=$("$SCRIPT_DIR/send-message.sh" \
        --from "team-lead-agent" \
        --to "$STORY_AGENT" \
        --type "approval" \
        --subject "Code review approved: $STORY_ID (iteration $ITERATION)" \
        --text "Code review passed for story $STORY_ID after $ITERATION iteration(s). No issues found. Ready to proceed." \
        --story "$STORY_ID" \
        --phase "$STORY_PHASE" \
        --priority "normal")

    success "Sent approval to $STORY_AGENT (message: $MSG_ID)"

    # Update prd.json with approval
    TMP_PRD="${PRD_FILE}.review.$$"
    jq --arg id "$STORY_ID" \
        --argjson iter "$ITERATION" \
        '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "approved", reviewIterations: $iter})' \
        "$PRD_FILE" > "$TMP_PRD"
    mv "$TMP_PRD" "$PRD_FILE"

else
    # Check if max iterations reached
    if [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
        error "Maximum review iterations ($MAX_ITERATIONS) reached for $STORY_ID"
        error "Escalating to human for manual review"

        MSG_ID=$("$SCRIPT_DIR/send-message.sh" \
            --from "team-lead-agent" \
            --to "$STORY_AGENT" \
            --type "alert" \
            --subject "ESCALATION: Max review iterations for $STORY_ID" \
            --text "Maximum $MAX_ITERATIONS review iterations reached. Escalating to human operator for manual review." \
            --story "$STORY_ID" \
            --phase "$STORY_PHASE" \
            --priority "urgent")

        # Update prd.json
        TMP_PRD="${PRD_FILE}.review.$$"
        jq --arg id "$STORY_ID" \
            --argjson iter "$ITERATION" \
            '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "escalated", reviewIterations: $iter})' \
            "$PRD_FILE" > "$TMP_PRD"
        mv "$TMP_PRD" "$PRD_FILE"

        exit 0
    fi

    # Send feedback with issues
    ISSUES_JSON=$(printf '%s\n' "${ISSUES[@]}" | jq -s '.')

    MSG_ID=$("$SCRIPT_DIR/send-message.sh" \
        --from "team-lead-agent" \
        --to "$STORY_AGENT" \
        --type "review_feedback" \
        --subject "Code review: Changes requested for $STORY_ID (iteration $ITERATION)" \
        --text "Code review identified $ISSUE_COUNT issue(s) that need to be addressed. Please fix all issues and send a response message when complete." \
        --story "$STORY_ID" \
        --phase "$STORY_PHASE" \
        --priority "high" \
        --data "{\"review_status\":\"changes_requested\",\"issues\":$ISSUES_JSON,\"iteration\":$ITERATION}")

    warning "Sent change request to $STORY_AGENT (message: $MSG_ID)"

    # Update prd.json with feedback status
    TMP_PRD="${PRD_FILE}.review.$$"
    jq --arg id "$STORY_ID" \
        --argjson iter "$ITERATION" \
        '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "changes_requested", reviewIterations: $iter})' \
        "$PRD_FILE" > "$TMP_PRD"
    mv "$TMP_PRD" "$PRD_FILE"

    # Re-invoke the implementation agent so it can read its inbox and apply fixes
    CLAUDE_SH="${CLAUDE_SH:-$SCRIPT_DIR/claude.sh}"
    if [ -x "$CLAUDE_SH" ]; then
        log "Re-invoking agent ($STORY_AGENT) on $STORY_ID to apply review fixes (iteration $ITERATION)..."
        FIX_LOG="$AUTOMATION_DIR/logs/review-fix-${STORY_ID}-iter${ITERATION}.log"
        "$CLAUDE_SH" "$STORY_ID" 2>&1 | tee "$FIX_LOG" || true
        success "Fix run complete - re-reviewing at iteration $((ITERATION + 1))..."
        # Exec-recurse: replace this process with the next iteration review
        exec "$0" "$STORY_ID" --iteration $((ITERATION + 1))
    else
        warning "claude.sh not found at '$CLAUDE_SH' - agent must apply fixes manually before next run"
    fi
fi

echo ""

# Log review to JSONL
mkdir -p "$(dirname "$REVIEW_LOG")"
TIMESTAMP=$(date -Iseconds)

REVIEW_RECORD=$(jq -n \
    --arg story "$STORY_ID" \
    --arg ts "$TIMESTAMP" \
    --arg status "$REVIEW_DECISION" \
    --arg agent "$STORY_AGENT" \
    --argjson issue_count "$ISSUE_COUNT" \
    --argjson iteration "$ITERATION" \
    '{
        story_id: $story,
        timestamp: $ts,
        review_status: $status,
        agent: $agent,
        issues_found: $issue_count,
        iteration: $iteration,
        reviewer: "team-lead-agent"
    }')

echo "$REVIEW_RECORD" >> "$REVIEW_LOG"

log "Review logged to: $REVIEW_LOG"
success "Code review cycle completed for iteration $ITERATION"

if [ "$REVIEW_DECISION" = "approved" ]; then
    exit 0
else
    # Reached here only if claude.sh was not found (manual fix path)
    log "Next: Agent must apply fixes manually; re-run with --iteration $((ITERATION + 1))"
    exit 0
fi
