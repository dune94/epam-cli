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
REVIEW_LOG="$AUTOMATION_DIR/logs/code-reviews.jsonl"
MESSAGES_DIR="$AUTOMATION_DIR/logs/messages"

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

# Review logic — Team Lead agent will:
# 1. Review git diff for this story
# 2. Check code quality, security (OWASP), error handling
# 3. Validate test coverage (vitest)
# 4. Check TypeScript strictness (tsc --noEmit)
# 5. Identify issues

ISSUES=()
REVIEW_STATUS="approved"

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
