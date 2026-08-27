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
# The roster is the only source of an agent's identity — see lib/roster-read.sh. No
# AGENT_PROFILES_FILE default any more: that default named the engine's own roster.
# shellcheck source=lib/roster-read.sh
. "$SCRIPT_DIR/lib/roster-read.sh"
# shellcheck source=lib/render-engine-prompt.sh
. "$SCRIPT_DIR/lib/render-engine-prompt.sh"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
# shellcheck source=lib/agent-invoke.sh
source "$SCRIPT_DIR/lib/agent-invoke.sh"

# The model settings this seam is configured to run with — ladder, effort, temperature — read
# from the registry by name. This seam decides whether code is accepted, and it fails silently
# in both directions: approving work that does not function, or rejecting correct work and
# burning ladder rungs on a re-implementation nobody needed.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
# engine_paths_pathspec — the owned-path set as git exclusions, one definition.
# shellcheck source=lib/engine-paths.sh
[ -f "$SCRIPT_DIR/lib/engine-paths.sh" ] && . "$SCRIPT_DIR/lib/engine-paths.sh"
# WHICH AGENT THIS IS — declared ONCE, and exported so ai-run.sh keys this agent's ladder rung
# state to it. Without it every agent shared one counter ("agent__<story>"): one agent escalating
# advanced the ladder for all of them, and team-lead-review's cross-process resume read a key
# nothing ever wrote.
_SEAM_NAME="team-lead-review"
export EPAM_AGENT_NAME="$_SEAM_NAME"
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
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json}" || true
fi
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "$_SEAM_NAME"

# THE SAME TEST-OWNERSHIP POLICY THE WRITER IS BOUND BY, from the one place it is declared.
#
# This reviewer had never heard of it and was told to "Check: ... test coverage", so it raised a
# blocker for tests the implementer was FORBIDDEN to write — an unwinnable gate that cost whole
# runs. Rendered here from prompts/test-ownership.json, the same document the writer renders its
# own half from, so the rule cannot change for one agent and not the other.
TEST_OWNERSHIP_BLOCK=""
_to_vals=$(mktemp); printf '{}' > "$_to_vals"
TEST_OWNERSHIP_BLOCK=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
    render test-ownership "${EPAM_PROJECT_CONFIG_DIR:-}" "$_to_vals" reviewer 2>/dev/null || echo "")
rm -f "$_to_vals"

# WHAT MAY BE A BLOCKER. Same discipline as the policy above: declared once, in the prompt
# layer, not invented here. A blocker the writer cannot satisfy is an unwinnable gate — live
# 2026-08-12 this reviewer demanded a file the plan never named, and a package that does not
# exist, and the writer failed on both repeatedly.
BLOCKER_DISCIPLINE_BLOCK=""
_bd_vals=$(mktemp); printf '{}' > "$_bd_vals"
BLOCKER_DISCIPLINE_BLOCK=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
    render blocker-discipline "${EPAM_PROJECT_CONFIG_DIR:-}" "$_bd_vals" reviewer 2>/dev/null || echo "")
rm -f "$_bd_vals"
if [ -z "$(printf '%s' "$BLOCKER_DISCIPLINE_BLOCK" | tr -d '[:space:]')" ]; then
    echo "[team-lead-review] FATAL: blocker-discipline policy failed to render — refusing to review without it" >&2
    exit 1
fi
if [ -z "$(printf '%s' "$TEST_OWNERSHIP_BLOCK" | tr -d '[:space:]')" ]; then
    echo "[team-lead-review] FATAL: test-ownership policy failed to render — refusing to review without it" >&2
    exit 1
fi
source "$SCRIPT_DIR/lib/project-tools.sh"
source "$SCRIPT_DIR/lib/story-retry-state.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"
# THE SEAM DECIDES. seam_ladder_export (above) sets EPAM_MODEL to the first rung of the chain this
# seam's ARCHETYPE declares. The literal that stood here overrode that silently — the reviewer asked
# for its tier and then ignored the answer, so the declaration selected nothing. An operator value
# still wins; what is gone is the default no configuration could remove.
# THE SEAM'S LADDER, not a run-wide pin. ORCH_GATE_MODEL reached every seam that could not
# resolve a model itself, and .env pinned it to z-ai/glm-5.2 — which is why a mockserver run
# asked for an OpenRouter model. Empty when the ladder cannot answer, so callers refuse.
_TLR_MODEL="${EPAM_MODEL:-$(seam_model_or_fail "team-lead-review" 2>/dev/null || true)}"

# Look up a model's HIGH-ladder successor (EPAM_MODEL_LADDER_HIGH is "from=to|...",
# e.g. "z-ai/glm-5.1=moonshotai/kimi-k3"). Same laddering the detective + spec
# agents use — so a thrashing/stalling reviewer escalates to a stronger model
# instead of dead-ending (found live 2026-07-23: the review-agent thrashed to its
# 20-iteration cap producing NO verdict, which the pipeline silently defaulted to
# APPROVED — a fix was rubber-stamped without ever being reviewed).
# B31: a ladder that does not escalate must say WHY. Empty previously collapsed
# three cases into one silent outcome: at the ceiling (fine), model not on the
# ladder (misconfiguration — escalation silently never happens), and ladder unset
# (no escalation at all this run). "The ladder didn't help" and "the ladder never
# ran" are very different diagnoses.
_ladder_skip_reason() {
    local _m="$1" _map="$2"
    if [ -z "$_map" ]; then
        echo "ladder is EMPTY/unset — NO escalation configured for this run"
    elif printf '%s' "$_map" | grep -qF -- "=${_m}"; then
        echo "at ladder ceiling (${_m}) — no further escalation available"
    else
        echo "model '${_m}' is NOT on the ladder — escalation impossible (renamed model or stale map?)"
    fi
}

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
# $2 — THE MODEL THAT PRODUCED THE WORK, passed in. Not read from a global.
#
# This used to arrive by the caller reassigning ORCH_GATE_MODEL, which is read by six other
# things in this file and by every seam this process later spawns: a per-story value written
# into a process-wide one, where the next story inherits the previous story's rung unless the
# caller happens to overwrite it again. A parameter cannot leak that way.
#
# Absent means the writer named no model, and the seam's own declared rung stands. Nothing here
# invents one.
run_review_prompt() {
    local prompt_text="$1"
    local writer_model="$2"
    local writer_provider="$3"
    if [ ! -x "$AI_RUNNER_CMD" ]; then
        warning "ai-run.sh not executable — cannot review (NOT auto-approving)"
        echo '{"verdict":"changes_requested","issues":[{"severity":"blocker","description":"review-agent unavailable (ai-run.sh not executable) — the change was NOT reviewed; blocking rather than auto-approving"}],"summary":"reviewer unavailable"}'
        return 0
    fi
    local _base_model="$writer_model"
    local _base_provider="$writer_provider"
    # Cross-process ladder resume (2026-08-06): team-lead-review.sh is
    # invoked as a BRAND-NEW subprocess every Step 3.6 review cycle, so this
    # function's own 2-attempt ladder used to silently reset to
    # ORCH_GATE_MODEL every cycle regardless of how many cycles had already
    # run — the reviewer never actually climbed past its first escalation no
    # matter how many rejections it issued. Same root cause, same fix
    # pattern as claude.sh's writer ladder and ai-run.sh's shared ladder: a
    # review-scoped key (distinct from the WRITER's own key for the same
    # story) so escalating the reviewer never collides with escalating the
    # writer for the same story_id.
    local _review_ladder_key _review_progress=0
    _review_ladder_key="$(ai_ladder_state_key "review-agent" "${story_id:-global}")"
    if [ -n "${LOG_DIR:-}" ]; then
        _review_progress="$(read_story_retry_count "$LOG_DIR" "$_review_ladder_key")"
        if [ "${_review_progress:-0}" -gt 0 ] 2>/dev/null; then
            warning "  review-agent resuming ladder at escalation ${_review_progress} for ${story_id:-?} (persisted from an earlier review cycle)"
            local _rr _rn
            for ((_rr = 0; _rr < _review_progress; _rr++)); do
                _rn="$(_ladder_next_model "$_base_model")"
                [ -n "$_rn" ] && _base_model="$_rn"
            done
        fi
    fi
    local _next_model; _next_model="$(_ladder_next_model "$_base_model")"
    [ -z "$_next_model" ] && warning "  review-agent has NO ladder escalation available — $(_ladder_skip_reason "$_base_model" "${EPAM_MODEL_LADDER_HIGH:-${EPAM_MODEL_LADDER:-}}")"
    local _max_attempts="${REVIEW_MAX_ATTEMPTS:-2}"
    local _attempt=1 _model _provider _review_out=""
    while [ "$_attempt" -le "$_max_attempts" ]; do
        if [ "$_attempt" -ge 2 ] && [ -n "$_next_model" ]; then
            _model="$_next_model"; _provider="$(_provider_for_model "$_model")"
            warning "  review-agent ladder escalation (attempt $_attempt/$_max_attempts) — model $_base_model → $_model"
            [ -n "${LOG_DIR:-}" ] && advance_ladder_escalation "$LOG_DIR" "$_review_ladder_key" >/dev/null
        else
            # The writer's own provider, not the orchestration default: a rung is a
            # model/provider pair, and routing the same model through a different provider is a
            # different setup (see project_caching_is_routing_not_model — MiniMax direct vs via
            # a gateway differed by 99.8% on cache hits alone).
            _model="$_base_model"; _provider="$_base_provider"
        fi
    local _review_json_result
    _review_json_result=$(mktemp /tmp/review-result-XXXXXX.json)
    # AI_GATE_ALLOW_TOOLS=1: lets the reviewer run the read-only CodeGraph tool
    # (via Bash) to confirm whether an existing helper already provides logic the
    # diff hand-rolled — without this, ai-run.sh's epam-umbrella branch defaults
    # to --no-tools and the reviewer can only guess. Read-only: the reviewer
    # queries the index, it does not write. PROJECT_ROOT is forwarded so the tool
    # targets the repo under review.
    #
    # EPAM_MAX_TOOL_CALLS is what actually makes the reviewer commit to a verdict.
    # Measured on a mock1 run whose only change was one string literal:
    # team-lead-agent took 4 calls of 25/15/11/7 turns and 615K input tokens —
    # 83% of the entire run's cost — to emit a five-line approval. It stopped at
    # 25 because 25 is REVIEW_MAX_ITERATIONS; nothing else was stopping it.
    #
    # Raising that cap is the wrong lever and this codebase already knew it. From
    # AgentRunner's tool-budget comment, about the detective: "fixed three times
    # by raising the cap (10 -> 20 -> 25, and 40 was worst of all: 40 calls, 680K
    # input tokens, no fix). The budget was never the constraint — the absence of
    # a mechanism was." The reviewer's cap was nonetheless raised 12 -> 25 two
    # days later, for the same reason, with the same result.
    #
    # The budget withdraws the tools when spent and demands an answer from the
    # evidence already gathered. The iteration cap stays as the guard against a
    # reviewer that stalls WITHOUT calling tools — the two bound different
    # failures, so both are set.
    # THROUGH THE ONE DOOR.
    #
    # This set the execution budget itself -- output tokens, iterations, tool calls and reasoning
    # effort, each as ${REVIEW_*:-default}. lib/agent-invoke.sh was built to end exactly that, and
    # had no call sites at all: "silently falling back to a default is what let a reviewer run at
    # 4096 tokens for months without anyone noticing." A default written here is a value nobody
    # chose, and it is invisible on the day it is wrong.
    #
    # The budget AND the tool grant now come from the team-lead-review profile in
    # agents/invocation-profiles.json. The profile has declared "toolGrant": "execute" all along and
    # nothing read it, so this wrote its own list -- bash,read_file,list_files,search plus plugin
    # tools discovered separately -- four tool names hardcoded beside a declaration that already
    # said it. lib/agent-tools.js resolves the kind into the read-only floor, the plugin tools THIS
    # codeline provisioned, and whatever the kind adds.
    #
    # Model and provider stay here: routing is per-site and dynamic, which the gateway says is the
    # caller's to own.
    export PROJECT_ROOT
    _review_out=$(echo "$prompt_text" | invoke_agent team-lead-review \
        --model "$_model" --provider "$_provider" \
        --json-result "$_review_json_result" \
        --codeline "$PROJECT_ROOT" \
        2>&1)
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
            --arg model "${_TLR_MODEL:-}" \
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
# shellcheck disable=SC1090
[ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
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
    #
    # Scope comes from the writers' output when the story loop recorded it
    # (record_story_outputs in claude.sh, read via lib/story-outputs.sh), and
    # falls back to this diff otherwise. The diff is commit-to-commit, so it
    # cannot see writer output that has not been committed yet — and the
    # repro-test-writer commits separately from the impl agent, so that is a
    # normal state, not an edge case.
    _story_changed=$(story_outputs_files "$PROJECT_ROOT" "${AUTOMATION_DIR}/logs" 2>/dev/null || true)
    [ -z "$_story_changed" ] && \
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

    # CRITERIA WITH NO TEST BEHIND THEM.
    #
    # vc-coverage-check.sh already compares every verification criterion against the tests the
    # story produced, and wrote its answer to $LOG_DIR/vc-coverage-<story>.json — which nothing
    # read. Live 2026-08-11 (AMSD-2041) it had recorded that the feature's central behaviour was
    # unverified, and that one test re-implemented the very function it was meant to exercise.
    # Both are review findings by definition, and the reviewer was never shown either.
    #
    # It reaches the REVIEWER rather than only the writer because judging whether a criterion is
    # genuinely untestable here — an unreachable third-party service, a browser-only behaviour —
    # is a judgement, not something the engine can decide.
    STORY_UNCOVERED_VC=$("${NODE_BIN:-node}" \
        "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/vc-coverage-findings.js" \
        "${LOG_DIR:-}" "$story_id" \
        "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../config/agent-contract.json" 2>/dev/null || echo "")

    STORY_FIX_ANALYSIS=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // []) | map(
          "- **\(.file)**" + (if (.function // "") != "" then " (`\(.function)`)" else "" end)
          + (if (.changeRequired | type == "boolean" and . == false) then "  [NO EDIT REQUIRED — part of the fix, correctly left unchanged; never raise a finding because this file is untouched]" else "" end)
          + ": \(.reason)"
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
        # THE WHOLE CHANGE, NOT THE DECLARED PART OF IT.
        #
        # This filtered the diff by pathspec to the story's declared files. That hid any file
        # nobody predicted: the reviewer returned a verdict on a partial change with no
        # indication it had seen a partial change. It had already happened once here — the
        # test-writer's output lives at co-located paths outside technicalNotes.files, and was
        # bolted onto the pathspec rather than fixing the rule. The scope guard now permits
        # writes to files no other story owns, so a third category exists and a fourth will.
        #
        # The pathspec is REDUNDANT, not merely incomplete: it existed to keep unrelated
        # upstream commits out when the base was HEAD~5. The base is now the story branch's
        # own SHA, so everything in this diff already belongs to the story — filtering by
        # filename can only remove the story's own work.
        #
        # Engine-owned paths are excluded through the single existing definition
        # (lib/engine-paths.sh), so the reviewer does not spend its budget on pipeline state.
        # NOT `local` — this is top-level script body (the nearest function closes at line 285),
        # and bash rejects `local` outside a function AT RUNTIME. `bash -n` accepts it, so the
        # script parsed clean and died the moment this line executed. Introduced 2026-08-10 in
        # 2bb230e; the reviewer produced no verdict for two days and the caller retried it 701
        # times in a single run. shellcheck (SC2168) caught it the whole time.
        # Re-initialised each pass on purpose: this block runs once per story.
        _diff_excludes=()
        if command -v engine_paths_pathspec >/dev/null 2>&1; then
            mapfile -t _diff_excludes < <(engine_paths_pathspec)
        fi
        # GENERATED FILES ARE NOT THE CHANGE UNDER REVIEW.
        #
        # The excludes were engine artefacts only, so a regenerated lockfile went into the diff --
        # and `git diff` sorts alphabetically, so package-lock.json came FIRST. Live run 5: 8,056
        # lines, and at line 2,000 (where the old cap fell) the content was still lockfile version
        # bumps. The reviewer's whole window was machine output and none of the source it was asked
        # to judge. Lockfiles have their own gate (lockfile-sync); they are not review material.
        _diff_excludes+=(":(exclude)*.lock" ":(exclude)*-lock.json" ":(exclude)go.sum" ":(exclude)*.snap")
        _diff_full=$(git -C "$PROJECT_ROOT" diff "$_rev_base" HEAD -- . \
            "${_diff_excludes[@]+"${_diff_excludes[@]}"}" 2>/dev/null || true)
        if [ -z "$_diff_full" ]; then
            _diff_full=$(git -C "$PROJECT_ROOT" diff "$_rev_base" HEAD 2>/dev/null || true)
        fi
        if [ -n "$_diff_full" ]; then
            _diff_bytes=$(printf '%s' "$_diff_full" | wc -c)
            if [ "$_diff_bytes" -gt "${REVIEW_DIFF_MAX_BYTES:-120000}" ]; then
                # THE REVIEWER HAS TOOLS; IT DOES NOT NEED THE WHOLE CHANGE INLINED.
                #
                # The old cap was `printf ... | head -2000`: head takes its lines and exits, printf
                # gets SIGPIPE and dies 141, and `set -euo pipefail` kills this script -- silently,
                # because SIGPIPE prints nothing. That produced NO VERDICT eight times in a row
                # while never invoking a model once, and killed the run of 2026-08-20.
                #
                # It also cut mid-hunk, severing a change halfway through. What replaces it is a
                # per-file summary -- whole units, nothing severed -- and an instruction to read
                # what it needs. The execute grant includes bash, read_file and search precisely so
                # it can, and asking is better evidence than a window someone else chose.
                _diff_stat=$(git -C "$PROJECT_ROOT" diff --stat "$_rev_base" HEAD -- . \
                    "${_diff_excludes[@]+"${_diff_excludes[@]}"}" 2>/dev/null || true)
                # THE WORDS LIVE IN THE TEMPLATE LAYER. This block used to be written here and
                # substituted into __STORY_DIFF__ — model-facing instruction inside a shell
                # script, unreviewable in the prompt layer and unchangeable per project. Only
                # the FACTS are assembled here; the sentences are prompts/templates/.
                _sdni_vals=$(mktemp)
                "${NODE_BIN:-node}" -e '"'"'
                  const v = { __DIFF_BYTES__: process.argv[1], __PROJECT_ROOT__: process.argv[2],
                              __REV_BASE__: process.argv[3] };
                  process.stdout.write(JSON.stringify(v));
                '"'"' "${_diff_bytes}" "${PROJECT_ROOT}" "${_rev_base}" > "$_sdni_vals"
                STORY_DIFF="${_diff_stat}

$(render_engine_prompt story-diff-not-inlined "$_sdni_vals" excluded)"
                rm -f "$_sdni_vals"
            else
                STORY_DIFF="$_diff_full"
            fi
        fi
    fi
    [ -z "$STORY_DIFF" ] && STORY_DIFF="(no diff available — review source files directly)"

    # THE REVIEWER'S IDENTITY COMES FROM THE PROJECT ROSTER.
    #
    # This read `jq -r '.["review-agent"] // ""' "$AGENT_PROFILES_FILE"` and, when that came back
    # empty, substituted a one-line reviewer written here in code. Three defects in four lines:
    # the file defaulted to the roster SHARED WITH THE ENGINE, `// ""` made a missing entry
    # indistinguishable from a terse one, and the literal below meant neither failure was ever
    # visible. Live 20260821T212250Z the reviewer ran with a persona describing epam-cli.
    #
    # No fallback now. A reviewer with no identity is not a reviewer, and inventing one in code
    # is how a client codeline came to be judged by this repository's reviewer.
    REVIEW_PROFILE=""
    if ! REVIEW_PROFILE=$(roster_persona review-agent 2>&1); then
        error "  cannot resolve the review-agent persona from this project's roster:"
        error "  ${REVIEW_PROFILE}"
        error "  Refusing to review with an identity nobody chose."
        exit 1
    fi

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

    # The plugin tools THIS codeline registered — discovered, never listed inline.
    #
    # Both halves are still required, but only one of them is computed here now. The BLOCK tells the
    # reviewer the tools exist; PERMITTING them is the grant's job, and the grant is declared on the
    # profile ("toolGrant": "execute") and resolved by lib/agent-tools.js, which discovers the same
    # plugin tools itself. project_tool_names() was the second half, and keeping it would be a second
    # answer to a question already answered — the shape that drifts.
    #
    # Advertising without permitting (or permitting without advertising) leaves the tool exactly as
    # dead as it was, so if the grant ever stops including plugin tools, this block is the thing
    # that becomes a lie.
    _review_project_tools_block="$(build_project_tools_block "$PROJECT_ROOT")"

    # Build review prompt
    # THE CONDITIONAL BLOCKS, COMPUTED HERE INSTEAD OF INSIDE THE PROMPT.
    #
    # Each was an inline $( ... ) inside the prompt string: render this heading only when the
    # value is non-empty. The prompt is now a document, so the CALLER decides what a block
    # contains and the template just places it. Same text, same emptiness rule.

    _review_fix_analysis_block=$([ -n "$STORY_FIX_ANALYSIS" ] && printf '\nROOT CAUSE ANALYSIS & PRESCRIBED MINIMAL FIX (from prior code investigation — the plan of record the implementer was given):\n%s\n\nThe acceptance criteria describe the desired BEHAVIOR to verify; they are NOT a blueprint. The correct implementation is the minimal fix above. Judge the diff against BOTH.\n' "$STORY_FIX_ANALYSIS" || true)
    _review_uncovered_block=$([ -n "$STORY_UNCOVERED_VC" ] && printf '\n%s\n' "$STORY_UNCOVERED_VC" || true)
    _review_vc_block=$([ -n "$STORY_VC" ] && printf '\nVERIFICATION CRITERIA (the observable checks this change MUST satisfy — judge the diff against every one):\n%s\n' "$STORY_VC" || true)
    _review_codegraph_block=$([ -n "$_review_codegraph_tool" ] && printf '\nEXISTING-CODE TOOL (call the codegraph_query tool directly, NOT via Bash, to check whether a helper already exists before accepting hand-rolled logic):\n  codegraph_query(mode="helpers", args="<domain nouns>")   # existing util/parser/formatter (symbol + import path)\n  codegraph_query(mode="query", args="<SymbolName>")        # exact definition site\n' || true)
    _review_learned_block=$([ -n "$_review_kb" ] && printf '\nLEARNED REVIEW RULES (from prior runs — apply these):\n%s\n' "$_review_kb" || true)

    # THE PROMPT IS A DOCUMENT, NOT A SHELL STRING.
    #
    # Migrated 2026-08-13 to orchestrations/prompts/templates/team-lead-review.json and the
    # project-authority copy the library renders. Byte-identical to the literal that stood here
    # (3827 bytes, verified against a golden produced by evaluating that literal).
    #
    # It had to move. Prose inside a double-quoted bash string is LIVE CODE: a raw quote in the
    # scan_secrets example closed the string so `<the GIT DIFF above>` parsed as an input
    # redirection, and two backticks in the prose EXECUTED as commands and spliced their empty
    # output into what the model was sent. The reviewer emitted no verdict for two days and the
    # retry loop spun 701 cycles on a story that had already implemented cleanly.
    # Values to a FILE, filter in SINGLE quotes. The first version inlined the jq filter inside
    # a process substitution with nested quoting, and bash expanded $profile before jq ever saw
    # it: "line 571: profile: unbound variable". This is the same shape the analyst render uses.
    # WHAT THIS REVIEWER ALREADY SAID ABOUT THIS STORY.
    #
    # Until 2026-08-19 it received nothing: no prior verdict, no iteration number. So every cycle
    # judged as if for the first time, and on AMSD-2041 run 2 it approved a story whose blocker it
    # had itself raised and which had not changed since. It did not change its mind — it never knew.
    # The record was already append-only in code-reviews.jsonl; it simply was never read back.
    # Absent is absent: no prior review renders no section.
    # NOT `local`: this runs at top level inside the per-story while-loop, not in a function.
    # `local` here is a RUNTIME error bash -n cannot see (SC2168) — it aborted the reviewer on
    # every cycle, produced NO VERDICT eight times, and halted the run of 2026-08-20.
    _review_prior_block=""
    # NOT `2>/dev/null || true`. That made an UNREADABLE log indistinguishable from a first
    # review — which is exactly how this defect survived: the reviewer was handed an empty
    # prior-review block on every cycle and nothing anywhere said so.
    _review_prior_block=""
    if ! _review_prior_block=$(python3 "$SCRIPT_DIR/lib/handlers/prior-reviews.py" "$REVIEW_LOG" "$story_id" 2>&1); then
        warning "  [prior-reviews] could not read $REVIEW_LOG — the reviewer will not see its own earlier findings"
        [ -n "$_review_prior_block" ] && log "  [prior-reviews] $_review_prior_block"
        _review_prior_block=""
    fi

    _review_vals=$(mktemp)
    jq_vals \
        --arg profile "${REVIEW_PROFILE:-}" \
        --arg blocker "${BLOCKER_DISCIPLINE_BLOCK:-}" \
        --arg ownership "${TEST_OWNERSHIP_BLOCK:-}" \
        --arg story_id "$story_id" \
        --arg title "${STORY_TITLE:-}" \
        --arg desc "${STORY_DESC:-}" \
        --arg acs "${STORY_ACS:-}" \
        --arg diff "${STORY_DIFF:-}" \
        --arg files "${STORY_FILES:-}" \
        --arg test_files "${_test_files:-}" \
        --arg project_root "${PROJECT_ROOT:-}" \
        --arg fix_analysis "${_review_fix_analysis_block:-}" \
        --arg uncovered "${_review_uncovered_block:-}" \
        --arg vc "${_review_vc_block:-}" \
        --arg codegraph "${_review_codegraph_block:-}" \
        --arg learned "${_review_learned_block:-}" \
        --arg tools "${_review_project_tools_block:-}" \
        --arg prior_review "${_review_prior_block:-}" \
        '{"__REVIEW_PROFILE__":$profile,"__BLOCKER_DISCIPLINE__":$blocker,
          "__TEST_OWNERSHIP__":$ownership,"__STORY_ID__":$story_id,"__STORY_TITLE__":$title,
          "__STORY_DESC__":$desc,"__STORY_ACS__":$acs,"__STORY_DIFF__":$diff,
          "__STORY_FILES__":$files,"__TEST_FILES__":$test_files,"__PROJECT_ROOT__":$project_root,
          "__FIX_ANALYSIS_BLOCK__":$fix_analysis,"__UNCOVERED_VC_BLOCK__":$uncovered,
          "__VC_BLOCK__":$vc,"__CODEGRAPH_TOOL_BLOCK__":$codegraph,
          "__LEARNED_RULES_BLOCK__":$learned,"__PROJECT_TOOLS_BLOCK__":$tools,
          "__PRIOR_REVIEW__":$prior_review}' > "$_review_vals"
    if ! REVIEW_PROMPT=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
            render team-lead-review "${EPAM_PROJECT_CONFIG_DIR:-}" "$_review_vals"); then
        rm -f "$_review_vals"
        echo "[team-lead-review] FATAL: could not render the review prompt" >&2
        exit 1
    fi
    rm -f "$_review_vals"

    # JUDGE ON THE RUNG THAT PRODUCED THE WORK.
    #
    # Operator rule, 2026-08-22. This ran on the reviewer seam's own model regardless of what
    # the writer climbed to. Live 20260821T212250Z: the writer went
    # MiniMax-M3 -> z-ai/glm-5.2 -> moonshotai/kimi-k3 over five attempts while all three
    # review cycles ran z-ai/glm-5.2 — so the approval came from a weaker model than the one
    # being judged, and it approved a diff that had dropped a cleanup its own earlier cycle
    # had produced. A reviewer below the writer's rung cannot see what that rung can do wrong.
    #
    # The story's model is already persisted by the ladder so a resume does not restart its
    # climb; nothing was reading it for this. Absent — a first attempt, nothing recorded yet —
    # leaves the seam's own model alone rather than inventing one.
    # NOT `local` — this loop runs at TOP LEVEL, not inside a function. `local` here is
    # SC2168, which bash -n cannot see (it is a scope error, not syntax) and which halted
    # run 3 with NO VERDICT eight times. preflight-static.sh checks for exactly this.
    # ── THE REVIEWER RUNS THE WRITER'S RUNG. NOT ITS MODEL — ITS RUNG. ──────────────────
    #
    # Operator, 2026-08-22: "if writer's model moves up ladder, the reviewer must follow along
    # and use the same rung EXACT setup the writer used to converge."
    #
    # The ladder moves model, provider, reasoning effort and temperature TOGETHER (rung 1:
    # effort medium, temp 0; rung 2: model escalates; rung 3: effort high, temp 0.7). Taking
    # only the model would put the reviewer on a configuration the writer never ran.
    #
    # There is no fallback here and no `command -v` guard. The rung is written by claude.sh on
    # every attempt before the writer is invoked, so for any story that has been implemented it
    # EXISTS. Guarding the read would only convert a missing record — a real defect — into a
    # silent review on the seam default, which is the exact failure this replaces.
    _rung_model=$(story_rung_get "$LOG_DIR" "$story_id" model)
    _rung_provider=$(story_rung_get "$LOG_DIR" "$story_id" provider)
    _rung_effort=$(story_rung_get "$LOG_DIR" "$story_id" reasoningEffort)
    _rung_temperature=$(story_rung_get "$LOG_DIR" "$story_id" temperature)

    if [ -z "$_rung_model" ]; then
        # NOT approved, and not quietly reviewed on something else. A review whose setup does
        # not match the work is not a review, and saying so is the only honest outcome.
        error "  no rung on record for $story_id — the writer never persisted one, so there is"
        error "  no setup to review it on. Refusing to judge converged work on a guessed rung."
        echo '{"verdict":"changes_requested","reviewIncomplete":true,"issues":[{"severity":"blocker","description":"no writer rung on record for this story — the reviewer cannot reproduce the setup that produced the work"}]}' \
            > "$AUTOMATION_DIR/logs/review-feedback-${story_id}.json"
        continue
    fi

    # Applied, not merely logged. Effort and temperature are exported because that is how the
    # writer's own ladder sets them and how ai-run.sh reads them.
    export EPAM_REASONING_EFFORT="$_rung_effort"
    export EPAM_TEMPERATURE="$_rung_temperature"
    log "  review-agent takes the writer's rung for $story_id: model=$_rung_model provider=$_rung_provider effort=${_rung_effort:-unset} temp=${_rung_temperature:-unset}"

    log "  Invoking review-agent for $story_id... (model=$_rung_model provider=$_rung_provider)"
    REVIEW_OUTPUT_FILE="$AUTOMATION_DIR/logs/review-agent-${story_id}.log"
    # B25 — the reviewer used to fail leaving NO evidence: `$(... | tee FILE)` never
    # creates FILE when the pipeline dies before producing stdout, so a filesystem
    # search after a failed run found no log at all and the failure could only be
    # guessed at. Create the file up front, record the exit status, and always write
    # SOMETHING — a step that cannot explain its own failure gets re-diagnosed by
    # guesswork every time (three wrong mechanism guesses on 2026-07-24 alone).
    : > "$REVIEW_OUTPUT_FILE" 2>/dev/null || true
    REVIEW_OUTPUT=$(run_review_prompt "$REVIEW_PROMPT" "$_rung_model" "$_rung_provider" 2>&1 | tee -a "$REVIEW_OUTPUT_FILE")
    _review_rc=${PIPESTATUS[0]}
    if [ -z "$(printf '%s' "$REVIEW_OUTPUT" | tr -d '[:space:]')" ]; then
        warning "  review-agent produced NO OUTPUT AT ALL (rc=${_review_rc}, model=${_TLR_MODEL:-?}, provider=${EPAM_ORCHESTRATION_PROVIDER:-?})"
        printf '[team-lead-review] EMPTY RESULT rc=%s model=%s provider=%s story=%s at %s\n' \
            "${_review_rc}" "${_TLR_MODEL:-?}" "${EPAM_ORCHESTRATION_PROVIDER:-?}" "$story_id" "$(date -Is)" \
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
    REVIEW_JSON=$(echo "$REVIEW_OUTPUT" | python3 "$SCRIPT_DIR/lib/handlers/team-lead-review-json.py" 2>/dev/null || echo '{"verdict":"changes_requested","issues":[{"severity":"blocker","description":"review verdict could not be parsed — not auto-approving"}],"summary":"review parse failure"}')

    # ACCOUNT FOR EVERY VERIFICATION CRITERION — BEFORE the verdict is read.
    #
    # Placed here, not after, because everything below acts on STORY_VERDICT: reading it first
    # and gating afterwards is the shape that made three earlier gates log a block and enforce
    # nothing. The gate rejects only a SELF-CONTRADICTION — approved while the reviewer's own
    # assessment marks a criterion unmet — which the model can always satisfy by being
    # consistent, so it can never become unwinnable. Unassessed criteria are recorded on the
    # verdict, not blocked.
    #
    # No `command -v` guard and no `|| true` swallow: a missing gate must be visible. Malformed
    # input passes through the gate unchanged, so the no-verdict handling below still sees it.
    REVIEW_JSON=$(printf '%s' "$REVIEW_JSON" \
        | "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/vc-assessment-gate.js" "${STORY_VC:-}")
    if [ "$(printf '%s' "$REVIEW_JSON" | jq -r '.vcAssessmentContradiction // empty' 2>/dev/null)" = "true" ]; then
        warning "  review-agent APPROVED while marking a verification criterion unmet — rejected as incoherent"
    fi
    _vc_unassessed=$(printf '%s' "$REVIEW_JSON" | jq -r '(.vcAssessmentUnassessed // []) | join("; ")' 2>/dev/null || true)
    [ -n "$_vc_unassessed" ] && \
        warning "  review-agent left verification criteria unassessed: $_vc_unassessed"

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
        # reviewIncomplete IS PART OF THE FEEDBACK, not decoration.
        #
        # This projected {verdict, summary, issues} and dropped it. team-lead-review-json.py sets it
        # when the reviewer returned nothing parseable -- live run 4: 292 output tokens, an empty
        # string -- and run-agent-orchestration.sh's review_feedback_is_incomplete() reads it from
        # THIS file to re-run the REVIEW instead of re-implementing a story nobody looked at.
        #
        # Deleting it between the component that sets it and the one that depends on it made that
        # guard evaluate false on every review that has ever run. The writer was sent to fix
        # feedback that did not exist.
        echo "$REVIEW_JSON" | jq -c '{verdict, summary, issues, reviewIncomplete}' \
            > "${LOG_DIR:-$AUTOMATION_DIR/logs}/review-feedback-${story_id}.json" 2>/dev/null || true
    else
        success "  Review: approved — ${STORY_SUMMARY:-no issues found}"
        # Clear any stale feedback from a prior cycle now that this story passed.
        rm -f "${LOG_DIR:-$AUTOMATION_DIR/logs}/review-feedback-${story_id}.json" 2>/dev/null || true
    fi

    # THE REVIEWER'S MEMORY OF THIS STORY. Written HERE, inside the loop, because this is
    # the only place story_id, the verdict and the issues all exist — the phase summary at
    # the end of this file has none of them, which is why lib/handlers/prior-reviews.py
    # (which filters on `story` and renders `issues`) got nothing back and the reviewer
    # approved code carrying its own prior `major` findings. Live 2026-08-21, AMSD-2041.
    #
    # -c: the file is .jsonl and BOTH readers are line-based — prior-reviews.py parses per
    # line, and run-agent-orchestration.sh greps the compact '"phase_id":"<phase>"'.
    mkdir -p "$(dirname "$REVIEW_LOG")" 2>/dev/null || true
    if ! jq -cn \
            --arg phase "$PHASE_ID" \
            --arg ts "$(date -Iseconds)" \
            --arg story "$story_id" \
            --arg verdict "$STORY_VERDICT" \
            --argjson issues "$(printf '%s' "$REVIEW_JSON" | jq -c '.issues // []' 2>/dev/null || echo '[]')" \
            '{phase_id:$phase, timestamp:$ts, story:$story, verdict:$verdict,
              review_status:$verdict, issues:$issues, issues_found:($issues|length),
              reviewer:"team-lead-agent"}' >> "$REVIEW_LOG"; then
        warning "  could not record this review for $story_id — the NEXT cycle will not see these findings"
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

# ONE LINE, AND IN THE SHAPE ITS READERS ACTUALLY EXPECT.
#
# `jq -n` without -c pretty-printed this into a .jsonl file. Two consumers broke on that
# alone: lib/handlers/prior-reviews.py parses line-by-line and skipped every line as
# malformed (silently — "a malformed line is skipped, never fatal"), and
# run-agent-orchestration.sh:10837 greps the COMPACT form '"phase_id":"<phase>"', which a
# space after the colon never matches.
#
# The record was also a PHASE summary — no `story`, no `verdict`, no `issues` — while
# prior-reviews.py filters on `story` and renders `issues`. So even parsed, it carried
# nothing to feed back. Live 2026-08-21: the reviewer raised a hardcoded endpoint and a
# wrong SDK config key as `major` in cycle 2, then APPROVED the same code in cycle 3 with
# both still present. It could not remember what it had demanded.
#
# This record stays a PHASE summary — it genuinely has no single story or issue list, and
# inventing empty ones here is what made the first version of this fix inert. The per-story
# records prior-reviews.py needs are written inside the story loop above.
REVIEW_RECORD=$(jq -cn \
    --arg phase "$PHASE_ID" \
    --arg ts "$TIMESTAMP" \
    --arg status "$REVIEW_STATUS" \
    --argjson issue_count "$ISSUE_COUNT" \
    --argjson story_count "$STORY_COUNT" \
    '{
        phase_id: $phase,
        timestamp: $ts,
        review_status: $status,
        verdict: $status,
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
