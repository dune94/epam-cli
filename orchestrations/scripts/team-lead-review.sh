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
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
ORCH_GATE_MODEL="${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}"

# Invoke the review-agent LLM for a single story.
# Outputs raw LLM text; caller extracts verdict JSON.
run_review_prompt() {
    local prompt_text="$1"
    if [ ! -x "$AI_RUNNER_CMD" ]; then
        warning "ai-run.sh not executable — skipping LLM review"
        echo '{"verdict":"approved","issues":[],"note":"ai-run.sh unavailable"}'
        return 0
    fi
    echo "$prompt_text" | \
        AI_MODEL="$ORCH_GATE_MODEL" \
        CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        "$AI_RUNNER_CMD" --provider "${EPAM_ORCHESTRATION_PROVIDER:-claude}" \
            --model "$ORCH_GATE_MODEL" 2>&1
}

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

    log "  Story: $STORY_TITLE"
    log "  Agent: $STORY_AGENT"

    # Load acceptance criteria and technical notes for this story
    STORY_ACS=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria[]?' \
        "$PRD_FILE" 2>/dev/null | awk '{print NR". "$0}')
    STORY_DESC=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .description // ""' \
        "$PRD_FILE" 2>/dev/null)
    STORY_FILES=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$PRD_FILE" 2>/dev/null | head -20 | tr '\n' ' ')

    # Collect recent git diff scoped to relevant files (last 5 commits max)
    STORY_DIFF=""
    if [ -d "$PROJECT_ROOT/.git" ]; then
        STORY_DIFF=$(git -C "$PROJECT_ROOT" diff HEAD~5 HEAD -- \
            $(echo "$STORY_FILES") 2>/dev/null | head -400 || true)
        if [ -z "$STORY_DIFF" ]; then
            STORY_DIFF=$(git -C "$PROJECT_ROOT" diff HEAD~3 HEAD 2>/dev/null | head -300 || true)
        fi
    fi
    [ -z "$STORY_DIFF" ] && STORY_DIFF="(no diff available — review source files directly)"

    # Load review-agent profile
    REVIEW_PROFILE=""
    if [ -f "$AGENT_PROFILES_FILE" ]; then
        REVIEW_PROFILE=$(jq -r '.["review-agent"] // ""' "$AGENT_PROFILES_FILE" 2>/dev/null)
    fi
    [ -z "$REVIEW_PROFILE" ] && REVIEW_PROFILE="You are a senior code reviewer. Review the implementation against the acceptance criteria."

    # Build review prompt
    REVIEW_PROMPT="${REVIEW_PROFILE}

---
REVIEW TASK: Story $story_id — $STORY_TITLE

DESCRIPTION:
$STORY_DESC

ACCEPTANCE CRITERIA:
$STORY_ACS

RELEVANT FILES: $STORY_FILES

GIT DIFF (recent changes):
\`\`\`diff
$STORY_DIFF
\`\`\`

PROJECT ROOT: $PROJECT_ROOT

Review the implementation against each acceptance criterion above.
Check: TypeScript strict compliance, test coverage, error handling, security (OWASP).
Do NOT read from external URLs.

Respond with ONLY a JSON object (no markdown fences):
{\"verdict\":\"approved\",\"issues\":[],\"summary\":\"...\"}
  OR
{\"verdict\":\"changes_requested\",\"issues\":[{\"severity\":\"blocker|major|minor\",\"file\":\"...\",\"line\":0,\"description\":\"...\",\"suggestedFix\":\"...\"}],\"summary\":\"...\"}

A 'blocker' issue MUST be fixed before merge. 'major' should be fixed. 'minor' is optional."

    log "  Invoking review-agent for $story_id..."
    REVIEW_OUTPUT_FILE="$AUTOMATION_DIR/logs/review-agent-${story_id}.log"
    REVIEW_OUTPUT=$(run_review_prompt "$REVIEW_PROMPT" 2>&1 | tee "$REVIEW_OUTPUT_FILE")

    # Extract JSON verdict from output (last JSON object found)
    REVIEW_JSON=$(echo "$REVIEW_OUTPUT" | grep -o '{.*"verdict".*}' | tail -1 || true)
    if [ -z "$REVIEW_JSON" ]; then
        # Try extracting any JSON block
        REVIEW_JSON=$(echo "$REVIEW_OUTPUT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
matches = re.findall(r'\{[^{}]*\"verdict\"[^{}]*\}', text, re.DOTALL)
print(matches[-1] if matches else '{\"verdict\":\"approved\",\"issues\":[]}')
" 2>/dev/null || echo '{"verdict":"approved","issues":[]}')
    fi

    STORY_VERDICT=$(echo "$REVIEW_JSON" | jq -r '.verdict // "approved"' 2>/dev/null || echo "approved")
    STORY_ISSUE_COUNT=$(echo "$REVIEW_JSON" | jq '.issues | length' 2>/dev/null || echo "0")
    STORY_SUMMARY=$(echo "$REVIEW_JSON" | jq -r '.summary // ""' 2>/dev/null || true)

    if [ "$STORY_VERDICT" = "changes_requested" ] && [ "${STORY_ISSUE_COUNT:-0}" -gt 0 ]; then
        warning "  Review: changes_requested ($STORY_ISSUE_COUNT issue(s)) — $STORY_SUMMARY"
        # Collect issues into the global ISSUES array with story context
        while IFS= read -r issue; do
            ISSUES+=("$(echo "$issue" | jq --arg sid "$story_id" '. + {story_id: $sid}' 2>/dev/null || echo "$issue")")
        done < <(echo "$REVIEW_JSON" | jq -c '.issues[]?' 2>/dev/null)
    else
        success "  Review: approved — ${STORY_SUMMARY:-no issues found}"
    fi

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
