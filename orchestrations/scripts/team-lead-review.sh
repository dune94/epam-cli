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
    local _review_json_result
    _review_json_result=$(mktemp /tmp/review-result-XXXXXX.json)
    local _review_out
    _review_out=$(echo "$prompt_text" | \
        AI_MODEL="$ORCH_GATE_MODEL" \
        CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        ORCH_JSON_RESULT="$_review_json_result" \
        "$AI_RUNNER_CMD" --provider "${EPAM_ORCHESTRATION_PROVIDER:-claude}" \
            --model "$ORCH_GATE_MODEL" 2>&1)
    local _review_rc=$?
    # Emit cost_snapshot so agent-activity dashboard shows review-agent cost
    if [ -f "$_review_json_result" ] && [ -s "$_review_json_result" ]; then
        local _rc _tin _tout _cost _turns _phase_id
        _cost=$(jq -r '.total_cost_usd // .cost_usd // 0'                     "$_review_json_result" 2>/dev/null || echo 0)
        _tin=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0'          "$_review_json_result" 2>/dev/null || echo 0)
        _tout=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0'       "$_review_json_result" 2>/dev/null || echo 0)
        _turns=$(jq -r '.num_turns // .turns // .iterations // 1'              "$_review_json_result" 2>/dev/null || echo 1)
        _phase_id=$(jq -r '.phase // empty' "${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}" 2>/dev/null || true)
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg phase "${_phase_id:-}" \
            --arg model "${ORCH_GATE_MODEL:-}" \
            --arg provider "${EPAM_ORCHESTRATION_PROVIDER:-}" \
            --argjson cost "${_cost:-0}" \
            --argjson tin "${_tin:-0}" \
            --argjson tout "${_tout:-0}" \
            --argjson turns "${_turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
              timestamp: $ts,
              agent: "review-agent",
              story_id: null,
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: (if $model == "" then null else $model end),
              provider: (if $provider == "" then null else $provider end),
              detail: {costUsd: $cost, tokensIn: $tin, tokensOut: $tout, turns: $turns, source: "team-lead-review"}
            }' >> "${ACTIVITY_FILE:-$SCRIPT_DIR/../logs/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$_review_json_result"
    fi
    echo "$_review_out"
    return $_review_rc
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
    # No cap on a story's OWN declared file list — this is bounded by design
    # (a single story's technicalNotes.files is a handful of paths, not
    # arbitrary-length input), unlike the diff below. Root cause this avoids
    # (2026-07-09 pipeline audit): a head -20 cap here silently dropped files
    # from a multi-file story's OWN review scope, so the reviewer never even
    # saw them to judge.
    STORY_FILES=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$PRD_FILE" 2>/dev/null | tr '\n' ' ')

    # Collect recent git diff scoped to relevant files (last 5 commits max).
    # Root cause this fixes (2026-07-09 pipeline audit): head -400/-300 caps
    # silently truncated the diff fed to the LLM reviewer with no indication
    # anything was cut — a multi-file story routinely produces diffs longer
    # than that, so real defects in the tail were structurally invisible to
    # the verdict. Caps are raised substantially (still bounded, to protect
    # against a truly pathological diff blowing the prompt budget) AND any
    # actual truncation is now an EXPLICIT marker in the reviewer's own
    # input, so a verdict is never silently based on incomplete data.
    STORY_DIFF=""
    if [ -d "$PROJECT_ROOT/.git" ]; then
        _diff_full=$(git -C "$PROJECT_ROOT" diff HEAD~5 HEAD -- \
            $(echo "$STORY_FILES") 2>/dev/null || true)
        if [ -z "$_diff_full" ]; then
            _diff_full=$(git -C "$PROJECT_ROOT" diff HEAD~3 HEAD 2>/dev/null || true)
        fi
        if [ -n "$_diff_full" ]; then
            _diff_total_lines=$(printf '%s\n' "$_diff_full" | wc -l)
            if [ "$_diff_total_lines" -gt 2000 ]; then
                STORY_DIFF=$(printf '%s\n' "$_diff_full" | head -2000)
                STORY_DIFF="${STORY_DIFF}

[TRUNCATED — ${_diff_total_lines} total lines, only the first 2000 shown. Do not assume the omitted tail is defect-free.]"
            else
                STORY_DIFF="$_diff_full"
            fi
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

    # Extract JSON verdict from output.
    # BUG (found live, 2026-07-07): both the grep pattern and the original python
    # regex fallback assumed a FLAT, single-line JSON object. Real review-agent
    # responses are pretty-printed JSON whose "issues" array itself contains
    # multiple nested {...} objects — grep's line-based matching never sees a
    # single line with both '{' and '}', and the regex `\{[^{}]*"verdict"[^{}]*\}`
    # structurally cannot span nested braces ([^{}]* excludes brace chars
    # entirely). Both silently produced no match on every real
    # changes_requested review, falling through to the hardcoded
    # {"verdict":"approved","issues":[]} default — every review this session was
    # logged as "approved, no issues" regardless of what the model actually said,
    # including real blocker-severity findings (hardcoded API key, missing
    # validation). Fixed by using json.JSONDecoder.raw_decode from the first '{'
    # — correctly parses a nested JSON object regardless of formatting/whitespace,
    # rather than pattern-matching text.
    REVIEW_JSON=$(echo "$REVIEW_OUTPUT" | python3 -c "
import sys, json
text = sys.stdin.read()
start = text.find('{')
result = None
if start != -1:
    decoder = json.JSONDecoder()
    try:
        result, _ = decoder.raw_decode(text, start)
    except (ValueError, json.JSONDecodeError):
        result = None
if not isinstance(result, dict) or 'verdict' not in result:
    result = {'verdict': 'approved', 'issues': []}
print(json.dumps(result))
" 2>/dev/null || echo '{"verdict":"approved","issues":[]}')

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
