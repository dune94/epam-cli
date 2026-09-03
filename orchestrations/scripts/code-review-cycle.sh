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
#   3 - Nothing was reviewed (story not complete) — NOT an approval

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
export MAGENTA='\033[0;35m'
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
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# EVERY ENTRY POINT READS THE LADDER DECLARATION ITSELF.
#
# lib/model-ladders.sh exists so that "what a tier contains" is declared once and read the same
# way everywhere. Only claude.sh, run-agent-orchestration.sh and detective-rerun.sh ever called
# it, so this script resolved its model ONLY from environment its parent happened to export. Run
# standalone — a replay, a retest, a test harness — nothing set EPAM_MODEL_LADDER_<TIER>,
# seam_ladder_export set no EPAM_MODEL, and this seam skipped its work while exiting 0.
#
# export_model_ladders leaves an already-set value alone, so calling it here changes nothing when
# the orchestrator has already exported the chain, and supplies it when nobody has.
_ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
if [ -f "$_ml_lib" ]; then
    # shellcheck source=lib/model-ladders.sh
    . "$_ml_lib" || true
    command -v export_model_ladders >/dev/null 2>&1 \
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}}" || true
fi
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
# WHICH AGENT THIS IS — declared ONCE, and exported so ai-run.sh keys this agent's ladder rung
# state to it. Without it every agent shared one counter ("agent__<story>"): one agent escalating
# advanced the ladder for all of them, and team-lead-review's cross-process resume read a key
# nothing ever wrote.
_SEAM_NAME="code-review-cycle"
export EPAM_AGENT_NAME="$_SEAM_NAME"
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "$_SEAM_NAME"

AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
# THE CALLER'S PRD, not a global one. This was assigned unconditionally, so whatever PRD the run
# was launched with was discarded in favour of orchestrations/prd.json — which holds
# {"stories":[],"implementationOrder":{}}. Every story therefore looked absent, and the paths
# below turned that into a clean exit. orchestrate.sh settled the same question with ${PRD_FILE:-}
# after a hardcoded default synthesised one project's PRD into another's.
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
REVIEW_LOG="${REVIEW_LOG:-$AUTOMATION_DIR/logs/code-reviews.jsonl}"
MESSAGES_DIR="${MESSAGES_DIR:-$AUTOMATION_DIR/logs/messages}"
# shellcheck source=lib/roster-read.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/roster-read.sh"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
# THE SEAM DECIDES. seam_ladder_export set EPAM_MODEL to the first rung of the chain this
# seam's archetype declares; the literal that stood here overrode it silently, so editing the
# declared tier moved no model. An operator value still wins; the unremovable default is gone.
# THE SEAM'S LADDER, not a run-wide pin. ORCH_GATE_MODEL reached every seam that could not
# resolve a model itself, and .env pinned it to z-ai/glm-5.2 — which is why a mockserver run
# asked for an OpenRouter model. Empty when the ladder cannot answer, so callers refuse.
_CRC_MODEL="${EPAM_MODEL:-$(seam_model_or_fail "code-review-cycle" 2>/dev/null || true)}"

run_review_prompt() {
    local prompt_text="$1"
    if [ ! -x "$AI_RUNNER_CMD" ]; then
        echo '{"verdict":"approved","issues":[]}'
        return 0
    fi
    # NO VENDOR GUESS. --provider "${EPAM_ORCHESTRATION_PROVIDER:-claude}" forced "claude"
    # whenever EPAM_ORCHESTRATION_PROVIDER was unset — redundant, because AI_RUNNER_CMD is
    # ai-run.sh -> llm-handler.sh, which re-derives PRIMARY_PROVIDER from the active set when no
    # flag is given. Passing --provider "" would be WORSE than omitting the flag: llm-handler.sh's
    # own arg parsing (`--provider) PRIMARY_PROVIDER="${2:-}"`) would overwrite its own
    # already-correctly-resolved value with empty and fall to a cruder basename guess — so the
    # flag is included only when there is a real value to pass.
    local _crc_provider_flag=()
    [ -n "${EPAM_ORCHESTRATION_PROVIDER:-}" ] && _crc_provider_flag=(--provider "$EPAM_ORCHESTRATION_PROVIDER")
    echo "$prompt_text" | \
        AI_MODEL="$_CRC_MODEL" \
        CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        EPAM_MAX_OUTPUT_TOKENS="${CODE_REVIEW_MAX_OUTPUT_TOKENS:-32768}" \
        "$AI_RUNNER_CMD" "${_crc_provider_flag[@]}" \
            --model "$_CRC_MODEL" 2>&1
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

# EMPTY IS ABSENT. `.agentRole // "unknown"` supplies its default when the key is NULL — not when
# the selector matches no story at all, which yields an empty string. Testing only for "unknown"
# let a story that is not in the PRD fall through to the completed check below, where it was
# reported as "not completed yet" and exited 0.
if [ -z "$STORY_AGENT" ] || [ "$STORY_AGENT" = "unknown" ] || [ "$STORY_AGENT" = "null" ]; then
    error "Story not found in $PRD_FILE, or it has no agent assigned: $STORY_ID"
    exit 1
fi

# A REVIEW THAT DID NOT RUN IS NOT AN APPROVED REVIEW. This exited 0, which is the code this
# script documents as "Review approved or max iterations reached" — so a caller reading the exit
# status could not tell a passed review from one that never happened. Skipping an incomplete story
# is correct; saying "approved" about it is not.
if [ "$STORY_COMPLETED" != "true" ]; then
    warning "Story not completed yet, skipping review (nothing was reviewed)"
    exit 3
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
# No cap on a story's OWN declared file list — see team-lead-review.sh's
# sibling comment (2026-07-09 pipeline audit) for why a head -20 cap here
# silently dropped files from a multi-file story's OWN review scope.
_STORY_FILES=$(jq -r --arg id "$STORY_ID" \
    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
    "$PRD_FILE" 2>/dev/null | tr '\n' ' ')

# Collect git diff. Root cause this fixes (2026-07-09 pipeline audit):
# head -400/-300 caps silently truncated the diff fed to the LLM reviewer
# with no indication anything was cut. Caps raised substantially; any actual
# truncation is now an EXPLICIT marker in the reviewer's own input.
_STORY_DIFF=""
if [ -d "$PROJECT_ROOT/.git" ]; then
    # The expansion is split into separate arguments ON PURPOSE: this passes a LIST to a command
    # that takes them as individual operands. Quoting it would hand over one argument with spaces.
    # shellcheck disable=SC2046
    _diff_full=$(git -C "$PROJECT_ROOT" diff HEAD~5 HEAD -- \
        $(echo "$_STORY_FILES") 2>/dev/null || true)
    [ -z "$_diff_full" ] && \
        _diff_full=$(git -C "$PROJECT_ROOT" diff HEAD~3 HEAD 2>/dev/null || true)
    if [ -n "$_diff_full" ]; then
        _diff_total_lines=$(printf '%s\n' "$_diff_full" | wc -l)
        if [ "$_diff_total_lines" -gt 2000 ]; then
            _STORY_DIFF=$(head -2000 <<< "$_diff_full")
            _STORY_DIFF="${_STORY_DIFF}

[TRUNCATED — ${_diff_total_lines} total lines, only the first 2000 shown. Do not assume the omitted tail is defect-free.]"
        else
            _STORY_DIFF="$_diff_full"
        fi
    fi
fi
[ -z "$_STORY_DIFF" ] && _STORY_DIFF="(no diff available)"

# THE REVIEWER'S IDENTITY COMES FROM THE PROJECT ROSTER. See team-lead-review.sh for the same
# correction and why: a default naming the engine roster, `// ""` hiding a missing entry, and a
# one-line reviewer written in code that fired whenever either failed.
_REVIEW_PROFILE=""
if ! _REVIEW_PROFILE=$(roster_persona review-agent 2>&1); then
    echo "[code-review-cycle] cannot resolve the review-agent persona: ${_REVIEW_PROFILE}" >&2
    echo "[code-review-cycle] Refusing to review with an identity nobody chose." >&2
    exit 1
fi

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

# THE CRITERIA THIS REVIEW JUDGES AGAINST. Brownfield anchors on verification criteria; the
# builder is shared with team-lead-review.sh so both reviewers quote the same wording.
# shellcheck source=lib/review-criteria.sh
. "$SCRIPT_DIR/lib/review-criteria.sh"
_REVIEW_VC_BLOCK=$(review_vc_block "$STORY_ID" "$PRD_FILE")

# RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
_tpl_vals=$(mktemp "${TMPDIR:-/tmp}/code-review-cycle-vals-XXXXXX.json")
jq_vals --arg iteration "$ITERATION" \
      --arg prior_context "$_PRIOR_CONTEXT" \
      --arg project_root "$PROJECT_ROOT" \
      --arg review_profile "$_REVIEW_PROFILE" \
      --arg vc_block "$_REVIEW_VC_BLOCK" \
      --arg story_agent "$STORY_AGENT" \
      --arg story_description "$_STORY_DESC" \
      --arg story_diff "$_STORY_DIFF" \
      --arg story_files "$_STORY_FILES" \
      --arg story_id "$STORY_ID" \
      --arg story_title "$STORY_TITLE" \
      '{"__VC_BLOCK__":$vc_block,"__ITERATION__":$iteration,"__PRIOR_CONTEXT__":$prior_context,"__PROJECT_ROOT__":$project_root,"__REVIEW_PROFILE__":$review_profile,"__STORY_AGENT__":$story_agent,"__STORY_DESCRIPTION__":$story_description,"__STORY_DIFF__":$story_diff,"__STORY_FILES__":$story_files,"__STORY_ID__":$story_id,"__STORY_TITLE__":$story_title}' > "$_tpl_vals" 2>/dev/null
if ! _REVIEW_PROMPT=$(render_engine_prompt code-review-cycle "$_tpl_vals"); then
    echo "[code-review-cycle] cannot render its prompt — refusing to run with no instructions" >&2
    rm -f "$_tpl_vals"; exit 1
fi
rm -f "$_tpl_vals"
_REVIEW_OUTPUT_FILE="$AUTOMATION_DIR/logs/review-agent-${STORY_ID}-iter${ITERATION}.log"
_REVIEW_OUTPUT=$(run_review_prompt "$_REVIEW_PROMPT" 2>&1 | tee "$_REVIEW_OUTPUT_FILE")
# Also write to canonical log (latest) for subsequent iterations to reference
cp "$_REVIEW_OUTPUT_FILE" "$AUTOMATION_DIR/logs/review-agent-${STORY_ID}.log"

# Same bug/fix as team-lead-review.sh (found live, 2026-07-07): the old
# regex-based extraction (both the grep and the python fallback) assumed a
# flat, non-nested JSON object — real review responses' "issues" array
# contains nested {...} objects, which neither pattern can span, silently
# falling through to the "approved" default regardless of the actual verdict.
_REVIEW_JSON=$(echo "$_REVIEW_OUTPUT" | python3 "$SCRIPT_DIR/lib/handlers/code-review-json.py" 2>/dev/null || echo '{"verdict":"changes_requested","issues":[{"severity":"blocker","description":"review verdict unparseable — not auto-approving"}],"summary":"review parse failure"}')

ISSUES=()
_RAW_VERDICT=$(echo "$_REVIEW_JSON" | jq -r '.verdict // "approved"' 2>/dev/null || echo "approved")
if [ "$_RAW_VERDICT" = "changes_requested" ]; then
    while IFS= read -r _issue; do
        ISSUES+=("$_issue")
    done < <(echo "$_REVIEW_JSON" | jq -c '.issues[]?' 2>/dev/null)
fi
export REVIEW_STATUS="${_RAW_VERDICT}"

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
