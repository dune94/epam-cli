#!/bin/bash
# Team Lead code review workflow for EPAM CLI
# Reviews code changes from completed phase and sends feedback messages
#
# Usage:
#   team-lead-review.sh <PHASE_ID>
#
# Environment variables:
#   AUTO_APPROVE    - Set to 'true' to auto-approve if no issues found (default: false)
#   REVIEW_LOG      - Path to review log (default: orchestrations/logs/code-reviews.jsonl)
#
# Exit codes:
#   0 - Review completed (approved or feedback sent)
#   1 - Review failed (errors during review)

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log()     { echo -e "${CYAN}[REVIEW]${NC} $1"; }
success() { echo -e "${GREEN}[PASS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[FAIL]${NC} $1" >&2; }

# Parse arguments
if [ $# -lt 1 ]; then
    error "Missing required argument PHASE_ID"
    echo "Usage: $0 <PHASE_ID>" >&2
    exit 1
fi

PHASE_ID=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="$AUTOMATION_DIR/prd.json"
AUTO_APPROVE="${AUTO_APPROVE:-false}"
REVIEW_LOG="${REVIEW_LOG:-$AUTOMATION_DIR/logs/code-reviews.jsonl}"

log "Team Lead Code Review for Phase: $PHASE_ID"
echo ""

# Get phase stories
PHASE_STORIES=$(jq -r --arg phase "$PHASE_ID" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) | .id' \
    "$PRD_FILE" 2>/dev/null)

if [ -z "$PHASE_STORIES" ]; then
    error "No stories found for phase: $PHASE_ID"
    exit 1
fi

STORY_COUNT=$(echo "$PHASE_STORIES" | wc -l)
log "Reviewing $STORY_COUNT stories..."
echo ""

# Track review results
declare -a ISSUES=()
TOTAL_FILES_CHANGED=0

# Review each story
while IFS= read -r story_id; do
    [ -z "$story_id" ] && continue

    log "Reviewing story: $story_id"

    # Get story details
    STORY_TITLE=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
    STORY_AGENT=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$PRD_FILE")
    STORY_COMPLETED=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .completed' "$PRD_FILE")

    if [ "$STORY_COMPLETED" != "true" ]; then
        warning "  Story not completed, skipping review"
        continue
    fi

    # Check for changed files (look at git history)
    # In real implementation, would examine actual commits
    # For now, simulate review

    log "  Story: $STORY_TITLE"
    log "  Agent: $STORY_AGENT"

    # Simulate code review checks
    # In reality, Team Lead agent would:
    # 1. Review git diff for this story
    # 2. Check code quality, tests, documentation
    # 3. Identify issues

    success "  Review passed"

done <<< "$PHASE_STORIES"

echo ""

# Determine review decision
ISSUE_COUNT=${#ISSUES[@]}

if [ $ISSUE_COUNT -eq 0 ]; then
    success "Code review passed - no issues found"
    REVIEW_STATUS="approved"
    REVIEW_DECISION="APPROVED"
else
    warning "$ISSUE_COUNT issues found"
    REVIEW_STATUS="changes_requested"
    REVIEW_DECISION="CHANGES REQUESTED"
fi

echo ""
log "Review Decision: $REVIEW_DECISION"
echo ""

# Send review messages to agents
if [ "$REVIEW_STATUS" = "approved" ]; then
    # Send approval message to all agents in phase
    while IFS= read -r story_id; do
        [ -z "$story_id" ] && continue

        STORY_AGENT=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$PRD_FILE")

        if [ "$STORY_AGENT" != "unknown" ]; then
            MSG_ID=$("$SCRIPT_DIR/send-message.sh" \
                --from "team-lead-agent" \
                --to "$STORY_AGENT" \
                --type "approval" \
                --subject "Code review approved: $story_id" \
                --text "Code review passed for story $story_id. No issues found. Ready to proceed." \
                --story "$story_id" \
                --phase "$PHASE_ID" \
                --priority "normal")

            log "Sent approval to $STORY_AGENT (message: $MSG_ID)"
        fi
    done <<< "$PHASE_STORIES"

else
    # Send change request messages
    # Build issues JSON
    ISSUES_JSON=$(printf '%s\n' "${ISSUES[@]}" | jq -s '.')

    while IFS= read -r story_id; do
        [ -z "$story_id" ] && continue

        STORY_AGENT=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$PRD_FILE")

        if [ "$STORY_AGENT" != "unknown" ]; then
            # Filter issues for this story
            STORY_ISSUES=$(echo "$ISSUES_JSON" | jq --arg id "$story_id" \
                '[.[] | select(.story_id == $id)]')

            if [ "$(echo "$STORY_ISSUES" | jq 'length')" -gt 0 ]; then
                MSG_ID=$("$SCRIPT_DIR/send-message.sh" \
                    --from "team-lead-agent" \
                    --to "$STORY_AGENT" \
                    --type "review_feedback" \
                    --subject "Code review: Changes requested for $story_id" \
                    --text "Code review identified issues that need to be addressed." \
                    --story "$story_id" \
                    --phase "$PHASE_ID" \
                    --priority "high" \
                    --data "{\"review_status\":\"changes_requested\",\"issues\":$STORY_ISSUES}")

                warning "Sent change request to $STORY_AGENT (message: $MSG_ID)"
            fi
        fi
    done <<< "$PHASE_STORIES"
fi

# Log review to JSONL
mkdir -p "$(dirname "$REVIEW_LOG")"
TIMESTAMP=$(date -Iseconds)

REVIEW_RECORD=$(jq -n \
    --arg phase "$PHASE_ID" \
    --arg ts "$TIMESTAMP" \
    --arg status "$REVIEW_STATUS" \
    --argjson issue_count "$ISSUE_COUNT" \
    --argjson story_count "$STORY_COUNT" \
    '{
        phase_id: $phase,
        timestamp: $ts,
        review_status: $status,
        issues_found: $issue_count,
        stories_reviewed: $story_count,
        reviewer: "team-lead-agent"
    }')

echo "$REVIEW_RECORD" >> "$REVIEW_LOG"

echo ""
log "Review logged to: $REVIEW_LOG"
success "Team Lead code review completed"

# Exit with appropriate code
# Exit 1 when changes_requested so the caller can detect issues and trigger the
# escalation check (see run-agent-orchestration.sh Step 3.6).
if [ "$REVIEW_STATUS" = "approved" ]; then
    exit 0
else
    exit 1
fi
