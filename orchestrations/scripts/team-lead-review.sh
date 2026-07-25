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
# Respect the caller's PROJECT_ROOT/PRD_FILE (exported by run-agent-orchestration.sh)
# so an external-project run (test-app/codeline) reviews ITS OWN code and PRD,
# not epam-cli's own repo/prd.json — falls back to epam-cli's own paths only
# when invoked standalone with neither set.
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$AUTOMATION_DIR")}"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
AUTO_APPROVE="${AUTO_APPROVE:-false}"
REVIEW_LOG="${REVIEW_LOG:-$AUTOMATION_DIR/logs/code-reviews.jsonl}"
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
ORCH_GATE_MODEL="${ORCH_GATE_MODEL:-claude-haiku-4-5-20251001}"

# Look up a model's HIGH-ladder successor (EPAM_MODEL_LADDER_HIGH is "from=to|...",
# e.g. "z-ai/glm-5.1=moonshotai/kimi-k3"). Same laddering the detective + spec
# agents use — so a thrashing/stalling reviewer escalates to a stronger model
# instead of dead-ending (found live 2026-07-23: the review-agent thrashed to its
# 20-iteration cap producing NO verdict, which the pipeline silently defaulted to
# APPROVED — a fix was rubber-stamped without ever being reviewed).
_ladder_next_model() {
    local _m="$1" _map="${EPAM_MODEL_LADDER_HIGH:-${EPAM_MODEL_LADDER:-}}" _pair
    [ -z "$_map" ] && return 0
    IFS='|' read -ra _pairs <<< "$_map"
    for _pair in "${_pairs[@]}"; do
        case "$_pair" in "${_m}="*) echo "${_pair#*=}"; return 0 ;; esac
    done
}
# Resolve a model's provider via EPAM_MODEL_PROVIDER_MAP (glob patterns like moonshotai/*=qwen).
_provider_for_model() {
    local _m="$1" _map="${EPAM_MODEL_PROVIDER_MAP:-}" _pair _pat _prov
    [ -z "$_map" ] && { echo "${EPAM_ORCHESTRATION_PROVIDER:-claude}"; return; }
    IFS='|' read -ra _pairs <<< "$_map"
    for _pair in "${_pairs[@]}"; do
        _pat="${_pair%%=*}"; _prov="${_pair#*=}"
        case "$_m" in $_pat) echo "$_prov"; return ;; esac
    done
    echo "${EPAM_ORCHESTRATION_PROVIDER:-claude}"
}

# Invoke the review-agent LLM for a single story, with ladder escalation + a
# tight iteration cap so it produces a real verdict instead of thrashing.
# Outputs raw LLM text; caller extracts verdict JSON. On total failure it emits
# an explicit changes_requested (NOT approved) so a broken review can never
# silently pass the change.
run_review_prompt() {
    local prompt_text="$1"
    if [ ! -x "$AI_RUNNER_CMD" ]; then
        warning "ai-run.sh not executable — cannot review (NOT auto-approving)"
        echo '{"verdict":"changes_requested","issues":[{"severity":"blocker","description":"review-agent unavailable (ai-run.sh not executable) — the change was NOT reviewed; blocking rather than auto-approving"}],"summary":"reviewer unavailable"}'
        return 0
    fi
    local _base_model="$ORCH_GATE_MODEL"
    local _next_model; _next_model="$(_ladder_next_model "$_base_model")"
    local _max_attempts="${REVIEW_MAX_ATTEMPTS:-2}"
    local _attempt=1 _model _provider _review_out=""
    while [ "$_attempt" -le "$_max_attempts" ]; do
        if [ "$_attempt" -ge 2 ] && [ -n "$_next_model" ]; then
            _model="$_next_model"; _provider="$(_provider_for_model "$_model")"
            warning "  review-agent ladder escalation (attempt $_attempt/$_max_attempts) — model $_base_model → $_model"
        else
            _model="$_base_model"; _provider="${EPAM_ORCHESTRATION_PROVIDER:-claude}"
        fi
    local _review_json_result
    _review_json_result=$(mktemp /tmp/review-result-XXXXXX.json)
    # AI_GATE_ALLOW_TOOLS=1: lets the reviewer run the read-only CodeGraph tool
    # (via Bash) to confirm whether an existing helper already provides logic the
    # diff hand-rolled — without this, ai-run.sh's epam-umbrella branch defaults
    # to --no-tools and the reviewer can only guess. Read-only: the reviewer
    # queries the index, it does not write. PROJECT_ROOT is forwarded so the tool
    # targets the repo under review. EPAM_MAX_ITERATIONS is capped tight so the
    # reviewer commits to a verdict rather than exploring to its iteration limit.
    _review_out=$(echo "$prompt_text" | \
        AI_MODEL="$_model" \
        CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        ORCH_JSON_RESULT="$_review_json_result" \
        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="bash,read_file,list_files,search" \
        EPAM_MAX_ITERATIONS="${REVIEW_MAX_ITERATIONS:-25}" \
        EPAM_REASONING_EFFORT="${REVIEW_REASONING_EFFORT:-high}" \
        EPAM_MAX_OUTPUT_TOKENS="${REVIEW_MAX_OUTPUT_TOKENS:-24576}" \
        PROJECT_ROOT="$PROJECT_ROOT" \
        "$AI_RUNNER_CMD" --provider "$_provider" \
            --model "$_model" 2>&1)
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
    # Did the reviewer actually produce a verdict, or did it thrash / stall / go
    # empty? A "reached maximum iterations" / timed-out / empty result is NOT a
    # review — retry (escalating up the ladder) rather than let the caller default
    # it to APPROVED. This is the exact silent-pass that rubber-stamped an
    # unreviewed change live (2026-07-23).
    local _stripped; _stripped="$(printf '%s' "$_review_out" | tr -d '[:space:]')"
    if [ -z "$_stripped" ] || printf '%s' "$_review_out" | grep -qiE "reached maximum iterations|prompt runner timed out|agent reached maximum"; then
        warning "  review-agent produced NO verdict (thrash/empty) on attempt $_attempt/$_max_attempts"
        _attempt=$((_attempt + 1))
        continue
    fi
    echo "$_review_out"
    return 0
    done
    # Every attempt (base + ladder-escalated) failed to produce a verdict. Do NOT
    # fall through to the caller's approved-default — emit an explicit
    # changes_requested so a change that was never actually reviewed is BLOCKED,
    # not silently merged.
    warning "  review-agent failed to produce a verdict after $_max_attempts attempt(s) (incl. ladder escalation) — emitting review-incomplete (NOT approved)"
    # B24: mark this verdict as REVIEW_INCOMPLETE. It is emitted when the AGENT
    # failed, not when the code is wrong — the caller must retry the REVIEWER, not
    # re-implement the story. Live 2026-07-24: the loop could not tell the two
    # apart, ran two re-implementation cycles that touched nothing (no per-story
    # feedback file exists for a phase-level synthetic verdict), then escalated
    # with tagged-stories=0 — on a story whose fix AND reproducing test had already
    # passed every gate.
    echo "REVIEW_INCOMPLETE" > "${AUTOMATION_DIR}/logs/review-incomplete-${PHASE_ID:-phase}.flag" 2>/dev/null || true
    echo '{"verdict":"changes_requested","reviewIncomplete":true,"issues":[{"severity":"blocker","description":"review-agent did not complete — it thrashed/stalled and produced no verdict even after ladder escalation. The change was NOT reviewed; blocking rather than auto-approving.","suggestedFix":"Re-run the reviewer, or review manually before merge."}],"summary":"review incomplete — not reviewed"}'
    return 0
}

_reviewed_count=0
BASELINE_SHA="${BASELINE_SHA:-$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${JIRA_BASELINE_BRANCH:-develop}" 2>/dev/null || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${JIRA_BASELINE_BRANCH:-develop}" 2>/dev/null || echo HEAD~1)}"

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

    # B26 — review keys on CHANGES, not on `completed`.
    #
    # `completed` is set by a HUMAN marking the story done. It is not a pipeline
    # readiness signal and must not gate code review. Reading it as one meant the
    # repro-gate (which resets story status before Step 3.6) could silently disable
    # review: live 2026-07-24 the story arrived as status=pending while the branch
    # held the 3-line fix AND a 125-line reproducing test the gate had already
    # verified — the reviewer skipped it, reviewed ZERO stories, and returned
    # "approved". A change nobody looked at reported as reviewed.
    #
    # The reviewer's job is the CODE and the TEST. If the story changed anything vs
    # baseline, there is something to review.
    # NOTE: no `| head -1` here. Under `set -o pipefail`, head closes the pipe after
    # the first line, git takes SIGPIPE, the assignment returns non-zero and `set -e`
    # kills the script SILENTLY — which is exactly the class of failure this whole
    # investigation was chasing. `|| true` keeps a diff failure non-fatal.
    _story_changed=$(git -C "$PROJECT_ROOT" diff --name-only "$BASELINE_SHA" HEAD 2>/dev/null || true)
    if [ -z "$_story_changed" ]; then
        warning "  Story $story_id changed nothing vs baseline — nothing to review"
        continue
    fi
    _reviewed_count=$((_reviewed_count + 1))

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

    # Root-cause analysis + prescribed minimal fix, from the code-graph-detective
    # (persisted on story.fixSiteAnalysis by the spec pass). The reviewer needs
    # the SAME ground truth the implementer was handed, so it can judge whether
    # the change actually addresses the prescribed root cause — and whether a
    # more concise change (fewer lines / reuse of an existing helper) would have
    # met the requirement. Without this the reviewer only checks "does the diff
    # satisfy the AC wording," which greenlit an over-engineered wrong fix live
    # (2026-07-23, AMSD-1820).
    # Verification Criteria (VC) — the observable checks the change must satisfy.
    STORY_VC=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.verificationCriteria // []) | map("- " + .) | join("\n")' \
        "$PRD_FILE" 2>/dev/null || echo "")

    STORY_FIX_ANALYSIS=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // []) | map(
          "- **\(.file)**" + (if (.function // "") != "" then " (`\(.function)`)" else "" end) + ": \(.reason)"
          + (if (.fix // "") != "" then "\n  - Prescribed minimal fix: \(.fix)" else "" end)
        ) | join("\n")' "$PRD_FILE" 2>/dev/null || echo "")

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
        # Diff against the STORY'S BASE, not HEAD~N. HEAD~5/HEAD~3 walk into the baseline
        # branch's OWN recent commits, so an unrelated upstream commit (live 2026-07-24:
        # AMSD-2285 get-sb-client.ts, nothing to do with the bug) appeared in the reviewer's
        # diff and its "change addressing code the bug never reaches = blocker" rule rejected
        # a correct fix. The story branch is built on origin/<baseline>; phase-baseline-sha.txt
        # holds that SHA — the SAME base the repro-gate uses. So the diff contains ONLY the
        # story's changes. Fallbacks: origin/<baseline>, then HEAD~5 (last resort).
        _rev_base=""
        [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/phase-baseline-sha.txt" ] && \
            _rev_base=$(tr -d '[:space:]' < "${LOG_DIR}/phase-baseline-sha.txt" 2>/dev/null)
        [ -z "$_rev_base" ] && _rev_base=$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${JIRA_BASELINE_BRANCH:-develop}" 2>/dev/null || echo "")
        [ -z "$_rev_base" ] && _rev_base="HEAD~5"
        # Also review the story's TEST files (the test-writer's output). They live at
        # co-located paths NOT in technicalNotes.files, so scoping to STORY_FILES alone never
        # showed them to the reviewer — the test got only the repro-gate's reproduction check,
        # never the reviewer's QUALITY judgment. The test-writer is an agent; its test must be
        # reviewed like the fix (2026-07-24). Add test files changed vs the story's baseline.
        _test_files=$(git -C "$PROJECT_ROOT" diff --name-only "$_rev_base" HEAD 2>/dev/null | grep -iE '\.(spec|test)\.|/__tests__/|_test\.' | tr '\n' ' ' || true)
        _diff_full=$(git -C "$PROJECT_ROOT" diff "$_rev_base" HEAD -- \
            $(echo "$STORY_FILES $_test_files") 2>/dev/null || true)
        if [ -z "$_diff_full" ]; then
            _diff_full=$(git -C "$PROJECT_ROOT" diff "$_rev_base" HEAD 2>/dev/null || true)
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

    # Agent-level KB (self-heal for the reviewer): reusable review lessons that
    # ALL past review-agent runs learned (e.g. "reject a fix that adds new code
    # paths the bug never reaches"). Injected into the review prompt so the
    # reviewer improves across runs, the same way the impl agent's role-KB does.
    _review_kb=""
    _review_kb_file="${LOG_DIR:-$AUTOMATION_DIR/logs}/kb-scratchpad/KB-review-agent.md"
    [ -f "$_review_kb_file" ] && _review_kb="$(tail -n 20 "$_review_kb_file" 2>/dev/null)"

    # CodeGraph tool for the reviewer — only advertised when the binary exists,
    # so the prompt never tells the model to call a tool that isn't there.
    _review_codegraph_tool=""
    if command -v codegraph >/dev/null 2>&1 && [ -x "$SCRIPT_DIR/codegraph-agent-query.sh" ]; then
        _review_codegraph_tool="$SCRIPT_DIR/codegraph-agent-query.sh"
    fi

    # Build review prompt
    REVIEW_PROMPT="${REVIEW_PROFILE}

---
REVIEW TASK: Story $story_id — $STORY_TITLE

DESCRIPTION:
$STORY_DESC

ACCEPTANCE CRITERIA:
$STORY_ACS
$([ -n "$STORY_VC" ] && printf '\nVERIFICATION CRITERIA (the observable checks this change MUST satisfy — judge the diff against every one):\n%s\n' "$STORY_VC" || true)
$([ -n "$STORY_FIX_ANALYSIS" ] && printf '\nROOT CAUSE ANALYSIS & PRESCRIBED MINIMAL FIX (from prior code investigation — the plan of record the implementer was given):\n%s\n\nThe acceptance criteria describe the desired BEHAVIOR to verify; they are NOT a blueprint. The correct implementation is the minimal fix above. Judge the diff against BOTH.\n' "$STORY_FIX_ANALYSIS" || true)

RELEVANT FILES (fix files + the reproducing test the pipeline shipped — review BOTH): $STORY_FILES ${_test_files:-}

GIT DIFF (recent changes):
\`\`\`diff
$STORY_DIFF
\`\`\`

PROJECT ROOT: $PROJECT_ROOT
$([ -n "$_review_codegraph_tool" ] && printf '\nEXISTING-CODE TOOL (use the Bash tool to check whether a helper already exists before accepting hand-rolled logic):\n  PROJECT_ROOT="%s" bash "%s" helpers <domain nouns>   # existing util/parser/formatter (symbol + import path)\n  PROJECT_ROOT="%s" bash "%s" query <SymbolName>        # exact definition site\n' "$PROJECT_ROOT" "$_review_codegraph_tool" "$PROJECT_ROOT" "$_review_codegraph_tool" || true)

Review the implementation against each acceptance criterion above.
Check: TypeScript strict compliance, test coverage, error handling, security (OWASP).

CONCISION & REUSE (blocker-level checks):
- If the change addresses the symptom but NOT the prescribed root cause above (e.g. adds new code paths the bug never reaches), that is a 'blocker' — request changes.
- If a MORE CONCISE change (fewer lines) would achieve the same acceptance criteria, request changes and name the smaller change. Fewer lines of code is always better.
- If the diff hand-rolls logic that an EXISTING function/helper already provides (verify with the tool above), that is a 'blocker' — request changes and name the helper to reuse instead.
- Do NOT approve an over-engineered fix just because it satisfies the AC wording.
Do NOT read from external URLs.
$([ -n "$_review_kb" ] && printf '\nLEARNED REVIEW RULES (from prior runs — apply these):\n%s\n' "$_review_kb" || true)

Respond with ONLY a JSON object (no markdown fences):
{\"verdict\":\"approved\",\"issues\":[],\"summary\":\"...\"}
  OR
{\"verdict\":\"changes_requested\",\"issues\":[{\"severity\":\"blocker|major|minor\",\"file\":\"...\",\"line\":0,\"description\":\"...\",\"suggestedFix\":\"...\"}],\"summary\":\"...\"}

A 'blocker' issue MUST be fixed before merge. 'major' should be fixed. 'minor' is optional."

    log "  Invoking review-agent for $story_id... (model=${ORCH_GATE_MODEL:-?} provider=${EPAM_ORCHESTRATION_PROVIDER:-?})"
    REVIEW_OUTPUT_FILE="$AUTOMATION_DIR/logs/review-agent-${story_id}.log"
    # B25 — the reviewer used to fail leaving NO evidence: `$(... | tee FILE)` never
    # creates FILE when the pipeline dies before producing stdout, so a filesystem
    # search after a failed run found no log at all and the failure could only be
    # guessed at. Create the file up front, record the exit status, and always write
    # SOMETHING — a step that cannot explain its own failure gets re-diagnosed by
    # guesswork every time (three wrong mechanism guesses on 2026-07-24 alone).
    : > "$REVIEW_OUTPUT_FILE" 2>/dev/null || true
    REVIEW_OUTPUT=$(run_review_prompt "$REVIEW_PROMPT" 2>&1 | tee -a "$REVIEW_OUTPUT_FILE")
    _review_rc=${PIPESTATUS[0]}
    if [ -z "$(printf '%s' "$REVIEW_OUTPUT" | tr -d '[:space:]')" ]; then
        warning "  review-agent produced NO OUTPUT AT ALL (rc=${_review_rc}, model=${ORCH_GATE_MODEL:-?}, provider=${EPAM_ORCHESTRATION_PROVIDER:-?})"
        printf '[team-lead-review] EMPTY RESULT rc=%s model=%s provider=%s story=%s at %s\n' \
            "${_review_rc}" "${ORCH_GATE_MODEL:-?}" "${EPAM_ORCHESTRATION_PROVIDER:-?}" "$story_id" "$(date -Is)" \
            >> "$REVIEW_OUTPUT_FILE" 2>/dev/null || true
    fi

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
    # No parseable verdict = the review did NOT happen. Never silently approve —
    # that rubber-stamped an unreviewed change live (2026-07-23). Block instead.
    result = {'verdict': 'changes_requested', 'issues': [{'severity': 'blocker', 'description': 'review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.'}], 'summary': 'review output unparseable'}
print(json.dumps(result))
" 2>/dev/null || echo '{"verdict":"changes_requested","issues":[{"severity":"blocker","description":"review verdict could not be parsed — not auto-approving"}],"summary":"review parse failure"}')

    STORY_VERDICT=$(echo "$REVIEW_JSON" | jq -r '.verdict // "changes_requested"' 2>/dev/null || echo "changes_requested")
    STORY_ISSUE_COUNT=$(echo "$REVIEW_JSON" | jq '.issues | length' 2>/dev/null || echo "0")
    STORY_SUMMARY=$(echo "$REVIEW_JSON" | jq -r '.summary // ""' 2>/dev/null || true)

    if [ "$STORY_VERDICT" = "changes_requested" ] && [ "${STORY_ISSUE_COUNT:-0}" -gt 0 ]; then
        warning "  Review: changes_requested ($STORY_ISSUE_COUNT issue(s)) — $STORY_SUMMARY"
        # Collect issues into the global ISSUES array with story context
        while IFS= read -r issue; do
            ISSUES+=("$(echo "$issue" | jq --arg sid "$story_id" '. + {story_id: $sid}' 2>/dev/null || echo "$issue")")
        done < <(echo "$REVIEW_JSON" | jq -c '.issues[]?' 2>/dev/null)
        # Write per-story review feedback so the pipeline's review→re-implement
        # loop can hand it to the impl agent (build_implementation_prompt reads
        # this) and to the failure-analyst (self-heal → agent-KB). Consumed +
        # deleted by claude.sh once applied.
        echo "$REVIEW_JSON" | jq -c '{verdict, summary, issues}' \
            > "${LOG_DIR:-$AUTOMATION_DIR/logs}/review-feedback-${story_id}.json" 2>/dev/null || true
    else
        success "  Review: approved — ${STORY_SUMMARY:-no issues found}"
        # Clear any stale feedback from a prior cycle now that this story passed.
        rm -f "${LOG_DIR:-$AUTOMATION_DIR/logs}/review-feedback-${story_id}.json" 2>/dev/null || true
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

# B26 — reviewing NOTHING must never read as approved.
# Live 2026-07-24: every story was skipped by the old `completed` guard, so zero
# stories were reviewed and this returned "approved" — a change nobody looked at
# reported as reviewed. Only the escalation flag caught it, and it caught it as the
# WRONG diagnosis ("review requested changes"), costing two empty re-implementation
# cycles. Same fail-open class as the gates fixed earlier that day.
if [ "${_reviewed_count:-0}" -eq 0 ]; then
    warning "Team Lead review reviewed NO stories — refusing to report approved (nothing was reviewed)"
    echo "REVIEW_INCOMPLETE" > "${AUTOMATION_DIR}/logs/review-incomplete-${PHASE_ID:-phase}.flag" 2>/dev/null || true
    exit 1
fi

# Exit with appropriate code
# Exit 1 when changes_requested so the caller can detect issues and trigger the
# escalation check (see run-agent-orchestration.sh Step 3.6).
if [ "$REVIEW_STATUS" = "approved" ]; then
    exit 0
else
    exit 1
fi
