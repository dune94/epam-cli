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
# Note: By default, runs with --dangerously-bypass-approvals-and-sandbox for autonomous operation.
#       Use --interactive flag if you want to approve each file operation.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
# Respect PROJECT_ROOT from environment (set by run-agent-orchestration.sh when PRD_FILE is external)
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$AUTOMATION_DIR")}"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
LOG_DIR="$AUTOMATION_DIR/logs"

# shellcheck source=lib/tc-writer-gate.sh
source "$SCRIPT_DIR/lib/tc-writer-gate.sh"
# shellcheck source=lib/story-guards.sh
source "$SCRIPT_DIR/lib/story-guards.sh"
PROGRESS_LOG="$LOG_DIR/progress.txt"
AGENTS_FILE="$AUTOMATION_DIR/agents/AGENTS.md"
CLAUDE_OUTPUT_DIR="$LOG_DIR/claude_outputs"
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
MONITOR_STATUS_FILE="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"
# Single source of truth for the skill_note/kb_entry imperative-opener rule
# (the reviewer's own stated format rule -- see prd-change-reviewer's profile
# text). Both _skill_note_format_ok (the check) and _ensure_imperative_opener
# (the normalizer) read this SAME variable, so the two can never silently
# drift out of sync if the accepted word list is ever tuned. Configurable via
# env var rather than hardcoded in either function.
SKILL_NOTE_IMPERATIVE_OPENERS="${SKILL_NOTE_IMPERATIVE_OPENERS:-do not|never|always|avoid|use|prefer}"
# The word _ensure_imperative_opener prepends when a note doesn't already
# open with one of the words above. Must itself be a member of that list
# (enforced at the top of _ensure_imperative_opener, not assumed) -- "always"
# is chosen specifically because it's semantically safe to prepend to an
# ARBITRARY clause without inverting its meaning; "never"/"avoid"/"do not"
# would negate whatever follows, so picking the first list entry
# programmatically would be unsafe if the list order ever changed.
SKILL_NOTE_NORMALIZATION_OPENER="${SKILL_NOTE_NORMALIZATION_OPENER:-Always}"
export MONITOR_FILE="$MONITOR_STATUS_FILE"
export ACTIVITY_FILE="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}"

load_env_file() {
    local env_file="$1"
    [ -f "$env_file" ] || return 0
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
}

# Save caller-set gate overrides BEFORE loading .env so tier-script values survive.
# .env contains stale defaults; the tier script intentionally overrides them at runtime.
_claude_pre_gate_provider="${ORCH_GATE_PROVIDER:-}"
_claude_pre_gate_model="${ORCH_GATE_MODEL:-}"
_claude_pre_orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
# Launcher-provided temperature floor (e.g. tier3-travel-app-run.sh's project-wide
# GLM pin) — captured once here so the per-story reset below can restore it
# instead of unsetting to nothing. Read-only for the rest of this process; the
# mid-story FailureDiversity override still applies on top per-story as before.
_claude_temperature_floor="${EPAM_TEMPERATURE:-}"

load_env_file "$(dirname "$AUTOMATION_DIR")/.env"
load_env_file "$PROJECT_ROOT/.env"

# Restore: tier-script values win over .env defaults
[ -n "$_claude_pre_gate_provider" ] && ORCH_GATE_PROVIDER="$_claude_pre_gate_provider"
[ -n "$_claude_pre_gate_model"    ] && ORCH_GATE_MODEL="$_claude_pre_gate_model"
[ -n "$_claude_pre_orch_provider" ] && EPAM_ORCHESTRATION_PROVIDER="$_claude_pre_orch_provider"
unset _claude_pre_gate_provider _claude_pre_gate_model _claude_pre_orch_provider
export ORCH_GATE_PROVIDER ORCH_GATE_MODEL EPAM_ORCHESTRATION_PROVIDER

# Git work root — the directory containing .git (defaults to PROJECT_ROOT)
# Override when the git repo lives in a subdirectory (e.g., PROJECT_ROOT/application)
GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}"

# AI_RUNNER_CMD / CONTROL_PLANE_PORT — same defaults as
# run-agent-orchestration.sh. Neither is exported there, so a worktree
# subprocess launched via --worktree doesn't inherit them from the parent's
# environment; needed here by validate_mid_execution_splits and
# wait_if_paused (lib/story-guards.sh) for worktree lanes.
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"

# Worktree configuration (set by --worktree flag)
WORKTREE_MODE=""        # "primary", "independent", or "" for main
MAIN_PRD_FILE=""        # Points to main repo's prd.json when in worktree mode
REVIEW_PHASE=""         # Phase name for --review-phase mode
CURRENT_PHASE=""        # Current phase being executed (for cost tracking)

# Configuration
CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # Allow override via environment
EPAM_CLI="${EPAM_CLI:-epam}"        # epam-cli binary; override with mock for testing
MAX_RETRIES="${EPAM_MAX_RETRIES:-7}"
RETRY_DELAY=5
# Orchestration mode — inherited from run-agent-orchestration.sh or set directly
ORCH_MODE="${ORCH_MODE:-bash}"
# SDK invocation mode — when 1, routes Claude provider calls through invoke.py
# using the Anthropic Python SDK instead of the claude CLI.
# All other providers (opencode, codex, copilot, openai, qwen, cursor) are unaffected.
# Requires: pip install -r orchestrations/scripts/requirements.txt
# and ANTHROPIC_API_KEY to be set in the environment.
EPAM_SDK_INVOKE="${EPAM_SDK_INVOKE:-0}"
INVOKE_PY="$SCRIPT_DIR/invoke.py"
INVOKE_PYTHON="${INVOKE_PYTHON:-$SCRIPT_DIR/.venv/bin/python3}"
# Fall back to system python3 if venv not present
[ -x "$INVOKE_PYTHON" ] || INVOKE_PYTHON="python3"

# Effort -> model + max-turns mapping
# Stories carry an optional "effort" field: low | medium (default) | high
# These map to a model and a max-turns cap for the Claude CLI invocation.
EFFORT_MODEL_LOW="gpt-5-codex"
EFFORT_MODEL_MEDIUM="gpt-5-codex"
EFFORT_MODEL_HIGH="gpt-5-codex"
# Set by resolve_planner_settings; empty means single-invocation mode (no split)
STORY_PLANNER_MODEL=""
# Set by resolve_effort_settings; controls EPAM_MAX_ITERATIONS for epam-run stories.
# Low=6 (write 2 files + tsc + vitest + one fix), medium=10, high=15
STORY_MAX_ITERATIONS=6
# Set by resolve_effort_settings; controls EPAM_MAX_OUTPUT_TOKENS for epam-run stories.
STORY_MAX_OUTPUT_TOKENS=3072
# Set by resolve_generator_settings; true when agentRole=generator (pure file creation, no context reads).
STORY_GENERATOR_MODE=""

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
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=6
            STORY_MAX_OUTPUT_TOKENS=3072
            ;;
        high)
            STORY_MODEL="$EFFORT_MODEL_HIGH"
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=15
            STORY_MAX_OUTPUT_TOKENS=6144
            ;;
        *)  # medium (default)
            STORY_MODEL="$EFFORT_MODEL_MEDIUM"
            STORY_MAX_TURNS=""
            STORY_MAX_ITERATIONS=10
            STORY_MAX_OUTPUT_TOKENS=6144
            ;;
    esac
    # NOTE: deliberately does NOT log the model here (found live, 2026-07-10):
    # STORY_MODEL at this point is only the effort-tier CONFIG DEFAULT
    # (currently gpt-5-codex for every tier) -- resolve_model_from_story()
    # runs immediately after this and overrides it from prd.json in every
    # observed live case. Logging "model=gpt-5-codex" here was misleading:
    # that model was never actually dispatched, and no Cost[...] line ever
    # named it, but read at a glance mid-run it looked like a third model
    # was in rotation and costing money. resolve_model_from_story() now
    # always logs whichever model actually ends up used.
    log "  Effort[$effort] -> turns=${STORY_MAX_TURNS:-unlimited} maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"
}

# resolve_generator_settings <story_id>
# When agentRole=generator, overrides iteration/token settings for pure file-creation stories.
# Generator stories write one new file from spec — they need no context reads, few iterations,
# and a large output token budget for the generated content.
resolve_generator_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_GENERATOR_MODE=""
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ "$role" = "generator" ]; then
        STORY_GENERATOR_MODE="true"
        STORY_MAX_ITERATIONS=3
        STORY_MAX_OUTPUT_TOKENS=16384
        log "  GeneratorMode: enabled (agentRole=generator) — maxIter=3 maxOutTok=16384"
    fi
}

# resolve_test_engineer_effort_floor <story_id>
# Test-writing structurally requires MORE research/verification turns than
# implementation at the same nominal effort tier: a test story must read its
# contract file AND the paired impl story's full source, extract exact
# signatures/error strings verbatim, THEN write mocks, THEN iterate until the
# real test suite actually passes -- work an impl story of the same "effort"
# label never has to do (it defines its own interface as it goes). Root cause
# found live (2026-07-11, tier3-travel-app run): impl stories at effort=low
# (maxIter=6) routinely completed in 1 attempt; test-engineer stories at the
# SAME effort=low budget needed repeated retries and even a watchdog timeout
# before ever reaching npm test, purely from running out of iterations partway
# through the read-then-write workflow above -- not from any deficiency in the
# test-engineer profile's own guidance. Bump the effort tier ONE step for any
# agentRole == "test-engineer" story (low->medium, medium->high); high stays
# high. Only ever raises the budget, never lowers it.
resolve_test_engineer_effort_floor() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    [ "$role" = "test-engineer" ] || return 0
    local effort
    effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .effort // "medium"' \
        "$prd_target" 2>/dev/null || echo "medium")
    case "$effort" in
        low)
            STORY_MAX_ITERATIONS=10
            STORY_MAX_OUTPUT_TOKENS=6144
            log "  TestEngineerEffortFloor: low -> medium (maxIter=10 maxOutTok=6144) -- test-writing needs more research/verification turns than impl at the same tier"
            ;;
        medium)
            STORY_MAX_ITERATIONS=15
            STORY_MAX_OUTPUT_TOKENS=6144
            log "  TestEngineerEffortFloor: medium -> high (maxIter=15 maxOutTok=6144)"
            ;;
        *) : ;;  # high already has the largest budget -- nothing to bump
    esac
}

# resolve_brownfield_effort_floor <story_id>
# Brownfield-specific output-budget floor. The default effort tiers give tiny
# output budgets (low=3072, medium=6144) tuned for greenfield NON-reasoning
# writes. But brownfield runs on REASONING models (MiniMax-M3, GLM) that emit a
# large <think> block BEFORE any tool call — and that reasoning counts against
# the output-token budget. Found live 2026-07-23 (AMSD-1820): every attempt at
# the default budget was TRUNCATED mid-<think> at ~18k tokens and never reached
# a WriteFile/Edit — reported as "deliverables UNCHANGED" for 3 straight
# attempts. The one attempt that completed only did so once its output reached
# ~22k. So a reasoning model needs room to think AND write in the same
# response. Floor the output budget high for brownfield (never lower it), so
# the model can finish reasoning and still emit the edit. Iterations get a
# floor too, since a multi-file brownfield fix legitimately spans several
# read/edit turns. Only ever RAISES the budget.
#
# Note on effort: the detective already did the deep reasoning (the root cause
# is injected into the prompt), so brownfield implementation does NOT need the
# model to re-reason from scratch — but rather than fight the InferenceLadder's
# effort ramp here, we simply guarantee enough output budget that the think
# block, however large, still leaves room to write. Override the floor with
# EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS if a project needs more/less.
resolve_brownfield_effort_floor() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _bf_min_out="${EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS:-24576}"
    local _bf_min_iter="${EPAM_BROWNFIELD_MIN_ITERATIONS:-12}"
    # When the detective already prescribed the fix (fixSiteAnalysis + helper), the
    # "reasoning headroom" rationale is inverted — the thinking is done; the agent just
    # applies the handed fix. Bumping to 12 then wastes ~11 ReAct turns, each re-sending
    # the accumulating conversation → input ballooned to ~169K (live 2026-07-24). Keep the
    # effort-tier default (do not inflate iterations) for a prescribed fix; the output-token
    # floor still applies (writing needs room). Env-overridable.
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _has_helper
    _has_helper=$(jq -r --arg id "$story_id" '[.stories[] | select(.id==$id) | .fixSiteAnalysis[]?.helper] | map(select(. != null and . != "")) | length' "$_prd_target" 2>/dev/null || echo 0)
    if [ "${_has_helper:-0}" -gt 0 ]; then
        _bf_min_iter="${EPAM_BROWNFIELD_PRESCRIBED_MIN_ITERATIONS:-6}"
    fi
    local _raised=0
    if [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "$_bf_min_out" ]; then
        STORY_MAX_OUTPUT_TOKENS="$_bf_min_out"; _raised=1
    fi
    if [ "${STORY_MAX_ITERATIONS:-0}" -lt "$_bf_min_iter" ]; then
        STORY_MAX_ITERATIONS="$_bf_min_iter"; _raised=1
    fi
    [ "$_raised" = "1" ] && log "  BrownfieldEffortFloor: reasoning-model headroom -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS} (think + write must fit one response)"
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
    else
        # Always log the model that will actually be used, even when it's
        # just the effort-tier default falling through unchanged -- without
        # this, no line ever named the real model for a story with no
        # prd.json override, since resolve_effort_settings() no longer logs
        # it either (see that function's own comment for why).
        log "  Model[effort-default] -> $STORY_MODEL"
    fi
}

# resolve_reasoning_effort_from_story <story_id>
# The prd-model-coordinator agent writes a .reasoningEffort field onto every
# story before execution begins. If present, it overrides the hardcoded
# "low" reset at story start. Absent field leaves the "low" default in place.
resolve_reasoning_effort_from_story() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_effort
    story_effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .reasoningEffort // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_effort" ]; then
        # Brownfield correctness floor: a defect's reasoning effort is derived from Jira
        # story points (pointsToEffort), so a ticket with no/low points runs at LOW —
        # even though a brownfield fix's correctness has nothing to do with story points.
        # LOW effort gave inconsistent/wrong results (live 2026-07-24, AMSD-1820). Floor
        # brownfield at MEDIUM (env-overridable); an explicit higher effort is preserved.
        # Less guessing on the brownfield ladder. Greenfield is unchanged.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$story_effort" = "low" ]; then
            story_effort="${EPAM_BROWNFIELD_MIN_REASONING_EFFORT:-medium}"
            log "  BrownfieldEffortFloor(reasoning): low -> ${story_effort} (story-point-derived LOW is not enough for a brownfield fix)"
        fi
        export EPAM_REASONING_EFFORT="$story_effort"
        log "  ReasoningEffort[prd.json] -> $EPAM_REASONING_EFFORT"
    fi
}

# compute_token_cost <model> <tokens_in> <tokens_out>
# Returns USD cost using model-pricing.json. Outputs "0" if model unknown or tokens are zero.
# Handles "standard-tier" / "mini-tier" labels by falling back to STORY_MODEL.
compute_token_cost() {
    local model="$1"
    local tin="${2:-0}"
    local tout="${3:-0}"
    local pricing_file
    pricing_file="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/model-pricing.json"
    [ -f "$pricing_file" ] || { echo "0"; return; }
    # Resolve tier labels to the actual model
    case "$model" in
        standard-tier|mini-tier|"") model="${STORY_MODEL:-}" ;;
    esac
    [ -z "$model" ] && { echo "0"; return; }
    python3 - "$pricing_file" "$model" "$tin" "$tout" <<'PYEOF'
import sys, json
pricing_file, model, tin, tout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(pricing_file) as f:
        table = json.load(f)
    prices = table.get(model)
    if not prices:
        # Try prefix match (e.g. model has date suffix)
        for k, v in table.items():
            if model.startswith(k) or k.startswith(model):
                prices = v
                break
    if prices:
        cost = (tin * prices["input"] + tout * prices["output"]) / 1_000_000
        print("{:.6f}".format(cost))
    else:
        print("0")
except Exception:
    print("0")
PYEOF
}

resolve_codex_model_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model runtime_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    runtime_model=$(jq -r '.configuration.aiRuntime.defaultModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    STORY_MODEL="${story_model:-${runtime_model:-gpt-5-codex}}"
    log "  Model[codex] -> $STORY_MODEL"
}

# resolve_planner_settings <story_id>
# Reads optional plannerModel from story spec and sets STORY_PLANNER_MODEL global.
# When set, the first invocation uses STORY_PLANNER_MODEL to produce a structured
# execution plan; subsequent (execution) invocations use STORY_MODEL.
# When absent, falls back to a COMPLEXITY-ADAPTIVE auto-trigger: the classify_ladder_tier
# function (the same signal CPA's cpaGate/effort fields already feed into the model-
# escalation ladder — see its own docstring) is reused here to decide EXECUTION
# SHAPE, not just escalation tier. A story classified "high" gets a plan-turn before its
# very first execution attempt (not just after failures) — the whole point is avoiding
# retries for genuinely complex stories, not reacting to them after the fact. "medium"
# (the default) keeps today's single-shot behavior unchanged, so simple stories pay no
# planning-turn overhead.
# Opt-out: SKIP_PLAN_THEN_EXECUTE=true disables the auto-trigger entirely (explicit
# per-story .plannerModel still works either way — it's a manual override, not part of
# the auto-trigger this flag controls).
# Model used for the auto-triggered plan turn: EPAM_PLANNER_MODEL_HIGH_TIER if set,
# else falls back to ORCH_GATE_MODEL (the same gate model already used for reviews/
# assessments) — no vendor/model name hardcoded here, consistent with the
# config-driven pattern used by the model-provider and model-ladder-step helpers.
resolve_planner_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PLANNER_MODEL=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .plannerModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$STORY_PLANNER_MODEL" ]; then
        log "  PlannerModel[$STORY_PLANNER_MODEL] -> planning turn, then execution on $STORY_MODEL"
        return
    fi

    [ "${SKIP_PLAN_THEN_EXECUTE:-false}" = "true" ] && return

    local _tier
    _tier=$(classify_ladder_tier "$story_id")
    if [ "$_tier" = "high" ]; then
        local _auto_planner="${EPAM_PLANNER_MODEL_HIGH_TIER:-${ORCH_GATE_MODEL:-}}"
        if [ -n "$_auto_planner" ]; then
            STORY_PLANNER_MODEL="$_auto_planner"
            log "  PlannerModel[auto/high-tier: $STORY_PLANNER_MODEL] -> planning turn, then execution on $STORY_MODEL"
        fi
    fi
}

# resolve_dynamic_constitution <story_id>
# Reads .epam/constitution-rules.json in PROJECT_ROOT and appends any rules
# whose match criteria overlap the story's requiredSkills or agentRole to the
# DYNAMIC_CONSTITUTION global. Resets the global on every call so rules from a
# previous story never bleed into the next one.
# When the rules file is absent, DYNAMIC_CONSTITUTION is empty (P8 behaviour).
resolve_dynamic_constitution() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    DYNAMIC_CONSTITUTION=""

    local rules_file="${PROJECT_ROOT}/.epam/constitution-rules.json"
    [ -f "$rules_file" ] || return 0

    # Extract story metadata used for matching
    local story_skills story_role
    story_skills=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.requiredSkills // [] | .[]' \
        "$prd_target" 2>/dev/null | tr '\n' ' ' | xargs)
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # Match each rule entry against skills and role; collect matched rules
    local rule_count matched_rules
    rule_count=$(jq 'length' "$rules_file" 2>/dev/null || echo "0")
    matched_rules=""

    local i=0
    while [ "$i" -lt "$rule_count" ]; do
        local match_skills match_role
        match_skills=$(jq -r --argjson idx "$i" '.[$idx].match.skills // [] | .[]' \
            "$rules_file" 2>/dev/null | tr '\n' ' ' | xargs)
        match_role=$(jq -r --argjson idx "$i" '.[$idx].match.agentRole // ""' \
            "$rules_file" 2>/dev/null || echo "")

        local hit=false
        # Skill overlap: any match skill present in story skills
        for ms in $match_skills; do
            if echo " $story_skills " | grep -qi " $ms "; then
                hit=true; break
            fi
        done
        # Role match: agentRole in rule matches story role
        if [ -n "$match_role" ] && [ "$match_role" = "$story_role" ]; then
            hit=true
        fi

        if [ "$hit" = true ]; then
            local rules_text
            rules_text=$(jq -r --argjson idx "$i" '.[$idx].rules | .[]' \
                "$rules_file" 2>/dev/null | while IFS= read -r rule; do
                    echo "- $rule"
                done)
            matched_rules="${matched_rules}${rules_text}"$'\n'
        fi
        i=$((i + 1))
    done

    if [ -n "$matched_rules" ]; then
        DYNAMIC_CONSTITUTION=$'\n'"ADDITIONAL BEHAVIORAL RULES FOR THIS STORY:"$'\n'"$matched_rules"
        log "  DynamicConstitution: matched rules injected for story $story_id"
    fi
}

# resolve_provider_settings <story_id>
# Reads aiProvider from the story and sets STORY_PROVIDER global.
# Values: opencode | codex | epam | provider aliases (default: codex)
resolve_provider_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PROVIDER=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .aiProvider // "codex"' \
        "$prd_target" 2>/dev/null | head -1)
    STORY_PROVIDER="${STORY_PROVIDER:-codex}"
    log "  Provider[$STORY_PROVIDER] -> CLI=$(provider_to_cli "$STORY_PROVIDER")"
}

# provider_to_cli <provider>
# Returns the CLI binary name for a given aiProvider value.
# Exits with an error for unknown providers — no silent Claude fallback.
provider_to_cli() {
    case "$1" in
        opencode)                    echo "opencode" ;;
        codex)                       echo "codex" ;;
        codemie-claude)              echo "codemie-claude" ;;
        copilot|openai|qwen|cursor|minimax)  echo "$EPAM_CLI" ;;
        epam)                        echo "$EPAM_CLI" ;;
        *)
            error "Unknown aiProvider '$1' — set aiProvider in prd.json to one of: opencode|codex|copilot|openai|qwen|cursor|minimax|codemie-claude"
            return 1
            ;;
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
            # Pick the last JSON object that has a "result" field (guards against pino log lines,
            # which never carry a "result" key). Do NOT filter on result != "" — agents that only
            # write files produce result:"" legitimately, and excluding them drops real cost data.
            jq -s '[.[] | select(has("result"))] | last // {result:"",cost_usd:0,usage:{inputTokens:0,outputTokens:0}} | {
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

# Agent behavioral contract — injected into every claude invocation as a system
# prompt prefix. Rules are non-negotiable; they cannot be overridden by story
# prompts or KB content. Kept minimal: only invariants that prevent data loss or
# security incidents if violated.
AGENT_CONSTITUTION="AGENT BEHAVIORAL CONTRACT — NON-NEGOTIABLE:
1. Filesystem boundary: Never write, edit, or delete files outside PROJECT_ROOT (${PROJECT_ROOT}). All output must land inside the project directory.
2. Write code only: Write all files required by the story spec. Do NOT run compilers (tsc), test suites (vitest/jest/npm test), or linters. The orchestrator verifies correctness externally after your turn completes.
3. No pre-flight reads: Do NOT read any files before writing your first implementation file. Start writing immediately. Do NOT read KB.md, AGENTS.md, or any existing source files for context — all necessary context is in this prompt. Only read a file if you must modify it (and only after writing all new files first).
4. Protected paths: Never modify, rename, or delete files under .epam/, orchestrations/, or any path listed in .epam/protected-files. Never modify .env or any file matching *.env, .env.*, or *credentials* — these contain secrets and are immutable to agents.
5. Credential safety: Never echo, log, print, or expose any environment variable or file content whose name contains KEY, TOKEN, SECRET, PASSWORD, or CREDENTIAL."

# Claude CLI permission flags
# These allow Claude to read/write files and execute commands without prompting
CLAUDE_PERMISSIONS=(
    "--dangerously-skip-permissions"
    "--append-system-prompt"
    "$AGENT_CONSTITUTION"
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

    # Check for Claude CLI only when actually needed (provider=claude or codemie-claude)
    # For qwen/openai/copilot/cursor/codex all traffic goes through epam CLI or ai-run.sh
    if command -v "$CLAUDE_CMD" &> /dev/null; then
        : # claude is available — all paths work
    else
        # Only fatal if stories are configured to use the claude provider
        if grep -q '"aiProvider"' "${PRD_FILE:-/dev/null}" 2>/dev/null && \
           jq -e '.stories[].aiProvider // "codex" | select(. == "claude" or . == "codemie-claude")' \
               "${PRD_FILE:-/dev/null}" >/dev/null 2>&1; then
            error "Claude CLI not found. Expected command: $CLAUDE_CMD"
            error "Install Claude Code CLI or set CLAUDE_CMD environment variable"
            exit 1
        fi
        log "Claude CLI not found — OK since no stories use the claude provider"
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

# Check if story is completed — looks in $PRD_FILE first, then $CROSS_CODELINE_PRD
# (a separate PRD from another codeline, e.g. the BE PRD when running the FE codeline).
# This allows FE stories to declare dependencies on BE stories without blocking.
is_story_completed() {
    local story_id=$1
    local completed
    completed=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .completed' "$PRD_FILE" 2>/dev/null)
    if [ "$completed" = "true" ]; then
        return 0
    fi
    # Not found or not completed in primary PRD — check cross-codeline PRD if set
    if [ -n "${CROSS_CODELINE_PRD:-}" ] && [ -f "${CROSS_CODELINE_PRD}" ]; then
        completed=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .completed' "$CROSS_CODELINE_PRD" 2>/dev/null)
        [ "$completed" = "true" ] && return 0
    fi
    return 1
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
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"

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
Append a single-line JSON record to ${messages_jsonl}:
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
Write it atomically: (flock -w 10 9 >> ${messages_jsonl}; printf '%s\n' '<json>' >&9) 9>>${messages_jsonl}

## Story to Plan
Read orchestrations/prd.json for story ${story_id} full details, then produce the plan above.
PLAN_PROMPT_EOF
    )

    log "Plan mode: generating execution plan for $story_id..."
    touch "$messages_jsonl"
    cd "$PROJECT_ROOT"

    local plan_ok=false
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        # SDK path: extended thinking enabled for plan mode (high-complexity reasoning)
        if echo "$plan_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                --model "${STORY_MODEL:-gpt-5-codex}" \
                --thinking-budget 8000 \
                --output "$plan_json" 2>/dev/null; then
            plan_ok=true
        fi
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${ORCH_GATE_MODEL:-}"
        if [ -z "$_orch_provider" ]; then
            warning "Plan mode: EPAM_ORCHESTRATION_PROVIDER not set — skipping plan"
        # AI_GATE_ALLOW_TOOLS=1: the plan_prompt below explicitly instructs the
        # agent to "Read orchestrations/prd.json for story ${story_id}" — without
        # this, ai-run.sh's epam-umbrella branch defaults to --no-tools and the
        # agent has no way to actually read anything, so the plan gets
        # fabricated from whatever it happens to guess (found live 2026-07-08).
        elif echo "$plan_prompt" | \
                AI_GATE_ALLOW_TOOLS=1 \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                > "$plan_json" 2>>"$plan_log"; then
            # Wrap plain text output into the expected {result:...} shape
            plan_text_raw=$(cat "$plan_json")
            printf '{"result":%s}' "$(echo "$plan_text_raw" | jq -Rs .)" > "$plan_json"
            plan_ok=true
        fi
    fi

    if [ "$plan_ok" = true ]; then
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
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"
    local lock_file="${messages_jsonl}.lock"

    # Always write — file is created by orchestration init for both bash and hybrid modes
    touch "$messages_jsonl"

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
    local monitor_file="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"

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
    local dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # In worktree mode, rewrite ALL occurrences of the main repo absolute path in the
    # prompt text. The canonical PRD embeds absolute paths in acceptanceCriteria,
    # technicalNotes, and files — agents read these and write to those exact paths,
    # bypassing any write-first directive. Replace every reference so the agent only
    # ever sees the worktree path and writes files to the correct directory.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    # Root-cause analysis from the code-graph-detective (brownfield). The
    # detective already traced the CAUSAL fix site and WHY it's wrong (often a
    # cross-file bug — e.g. an ID transformed in one function that a match in
    # another function doesn't account for). Injecting its reason strings here
    # means the coding agent starts WITH the answer instead of re-reading files
    # to re-discover it — which is exactly what bloats a "bad" retry's token
    # count (found live 2026-07-23: attempt read 143k tokens tracing the bug,
    # wrote nothing). Each entry: the file, the function, and the root cause.
    local fix_site_analysis
    fix_site_analysis=$(echo "$story_json" | jq -r '
      (.fixSiteAnalysis // []) | map(
        "- **\(.file)**" + (if .function != "" then " (`\(.function)`)" else "" end) + ": \(.reason)"
        + (if (.fix // "") != "" then "\n  - **Minimal fix:** \(.fix)"
             + (if .fixVerified == false then " ⚠️ UNVERIFIED: the helper named here (`\(.helper // "?")`) was NOT found in the repo — treat it as a HYPOTHESIS, not fact. Confirm it exists with the CodeGraph tool before importing it; if it does not exist, do not invent it — solve the fix another minimal way." else "" end)
           else "" end)
      ) | join("\n")
    ' 2>/dev/null || echo "")

    # Verification Criteria (VC) — the observable checks openspec-brownfield
    # produced (mechanism-free, from AC ∪ description). The impl agent must make
    # the change satisfy these; the ACs above are the intent, the VCs are what a
    # tester will actually confirm. Persisted on the story → PRD.
    local verification_criteria
    verification_criteria=$(echo "$story_json" | jq -r '(.verificationCriteria // []) | map("- " + .) | join("\n")' 2>/dev/null || echo "")

    # REQUIRED bug-reproducing test (brownfield defect). The repro-gate (Step 3.55)
    # HARD-BLOCKS any brownfield change that ships no test which FAILS on the pre-fix
    # baseline and PASSES with the fix. For a single-agent defect story NOTHING else
    # writes that test — the TC-writer only serves separate test-engineer stories —
    # so the impl agent MUST write it here. Found live 2026-07-24 (AMSD-1820): with
    # only a weak "your accompanying test should assert them", the agent shipped a
    # garbage file literally named `test` (a copy of the SOURCE) and no real test.
    # Make the requirement explicit, concrete (a real co-located path the repro-gate
    # recognises: *.test.*), and unambiguous. Fires for brownfield defects (fix site
    # known); novel brownfield still gets the VC "your test asserts these" guidance.
    # B1 (2026-07-24) — impl writes ONLY the fix. The reproducing test belongs to
    # brownfield-repro-test-writer.sh, which gets its own agent turn AFTER the fix
    # commits, and (since 2026-07-24) VALIDATES the test parses and runs before
    # committing it, with retry + ladder + self-heal on failure.
    #
    # This block used to MANDATE that impl ship a co-located *.test.* file. That was
    # a hedge taken when the test-writer produced nothing at all. Measured cost of
    # keeping it: the 15:36 run was killed at 7 impl attempts / $1.11, having
    # committed apply-report-discounts.service.test.ts, with the failure-analyst's
    # own diagnosis pointing AT that file ("Test file accesses possibly-undefined
    # variables without null narrowing under strict mode"). Six consecutive quality
    # failures were spent fighting a test impl should never have written.
    #
    # Enforcement is unchanged — the repro-gate still BLOCKS a fix that ships
    # without a reproducing test. Only authorship moved.
    local test_ownership_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -n "$fix_site_analysis" ]; then
        test_ownership_block=$(printf '\n## Tests are NOT your job this turn\nA dedicated test-writer agent runs immediately after your fix commits and owns the bug-reproducing test. Do NOT write, edit, or create any test file (*.test.*, *.spec.*, __tests__/). Write ONLY the fix. Adding a test here wastes your turn budget and has caused repeated failures.\n')
    fi

    # Reviewer feedback (review→re-implement loop): if a prior team-lead review
    # requested changes, its issues are written to review-feedback-<id>.json.
    # Inject them so THIS re-implementation directly addresses what the reviewer
    # flagged (e.g. "over-engineered — a more concise change would do; reuse the
    # existing helper"). This is the reviewer telling the impl agent what to fix.
    local review_feedback="" _review_feedback_file="${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}/review-feedback-${story_id}.json"
    if [ -f "$_review_feedback_file" ]; then
        review_feedback=$(jq -r '
          (.issues // []) | map(
            "- [" + (.severity // "issue") + "] " + (.description // "")
            + (if (.file // "") != "" then " (" + .file + (if (.line // 0) > 0 then ":" + (.line|tostring) else "" end) + ")" else "" end)
            + (if (.suggestedFix // "") != "" then "\n  - Suggested fix: " + .suggestedFix else "" end)
          ) | join("\n")' "$_review_feedback_file" 2>/dev/null || echo "")
    fi

    # testCriteria — written by TC writer from actual source; ground truth for test stories.
    # Extracted after worktree path rewriting (TC fields don't contain absolute paths).
    local tc_facts tc_mock_strategy tc_banned
    tc_facts=$(echo "$story_json" | jq -r '.testCriteria.facts // [] | map("- " + .) | join("\n")' 2>/dev/null || echo "")
    tc_mock_strategy=$(echo "$story_json" | jq -r '.testCriteria.mockStrategy // ""' 2>/dev/null || echo "")
    tc_banned=$(echo "$story_json" | jq -r '.testCriteria.bannedPatterns // [] | join(", ")' 2>/dev/null || echo "")

    # Exact String Invariant guardrail (found live, 2026-07-06): SKY-002-impl
    # failed 8 times with 8 DIFFERENT bugs, several of them a slightly-wrong
    # paraphrase of an AC's literal error-message string (e.g. "via the
    # constructor" instead of "via the constructor options.apiKey"). A quoted
    # substring in an AC is a literal test assertion, not a summary the model
    # is free to reword — extract every quoted string and tell it explicitly
    # not to paraphrase them. Deterministic (no LLM judgment about which
    # strings matter); fully generic (works for any story's ACs, not just
    # SKY-002's).
    local string_invariants string_invariants_block=""
    string_invariants=$(printf '%s' "$acceptance_criteria" | grep -oE '"[^"]{3,}"' | sort -u)
    if [ -n "$string_invariants" ]; then
        string_invariants_block="
## CRITICAL COMPLIANCE: STRING INVARIANTS
The Acceptance Criteria above contain exact string matches required by the test suite.
You are FORBIDDEN from paraphrasing, summarizing, or optimizing these strings — reproduce them character-for-character, including case and spacing, wherever the AC requires them.

LITERAL STRINGS TO USE VERBATIM:
$(printf '%s\n' "$string_invariants" | sed 's/^/- /')
"
    fi

    # Build a write-first directive listing each file with its exact absolute path
    local write_first_lines=""
    # Brownfield: inject each existing file's REAL content directly into the
    # prompt (deterministic, one bash `cat`/`head` per file) instead of just
    # instructing "ReadFile these first". Same established pattern as
    # dependency_contracts below ("Inject it directly so it's guaranteed, not
    # requested") — applied here because telling the agent to read via tool
    # calls, while it fixed hallucination, traded it for a NEW problem: each
    # ReadFile result accumulates in conversation history, and every
    # subsequent turn in the same ReAct loop resends that whole growing
    # transcript. Found live 2026-07-23 (AMSD-1820, post-fix): the static
    # prompt itself measured ~3,000 tokens, but attempts were reporting
    # ~240,000 input tokens and then failing with 0 output bytes — a real
    # multi-file service investigation ballooned the accumulated transcript
    # far past what a single static injection would ever cost. Injecting
    # content ONCE, deterministically, in bash gives the same real grounding
    # at a small, fixed, one-time cost instead of a cost that multiplies with
    # every tool-call turn the agent takes.
    local existing_file_contents=""
    local _EXISTING_FILE_MAX_LINES=400
    # Inject FULL content ONLY for the detective's fix-site file(s). Injecting every
    # declared file (5 for AMSD-1820) ballooned the impl prompt to 137-189K input tokens,
    # and the agent burned its whole output budget exploring before ever calling WriteFile
    # (live 2026-07-24: in=137K out=1707, zero writes → deliverable gate failed → 8 retries).
    # Non-fix-site declared files are listed as paths (agent ReadFiles on demand). When there
    # is no fixSiteAnalysis (novel work / no detective result), inject all files (fallback).
    local _fixsite_rel
    _fixsite_rel=$(echo "$story_json" | jq -r '[.fixSiteAnalysis[]?.file] | map(select(. != null and . != "")) | .[]' 2>/dev/null)
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        # Resolve to absolute path; in worktree mode, rewrite main-repo absolute paths
        # to the worktree so the agent writes files in the correct directory.
        local abs_f
        if [[ "$f" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$f" = "${MAIN_PROJECT_ROOT}"* ]]; then
                abs_f="${PROJECT_ROOT}${f#${MAIN_PROJECT_ROOT}}"
            else
                abs_f="$f"
            fi
        else
            abs_f="$PROJECT_ROOT/$f"
        fi
        # Inject CONTENT only for a fix-site file (or all, when no fixSiteAnalysis exists).
        local _rel_f _inject_content
        _rel_f="${abs_f#"$PROJECT_ROOT"/}"
        if [ -z "$_fixsite_rel" ] || printf '%s\n' "$_fixsite_rel" | grep -qxF "$_rel_f"; then _inject_content=1; else _inject_content=0; fi
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            if [ "$_inject_content" = "1" ] && [ -f "$abs_f" ]; then
                write_first_lines="${write_first_lines}   - ${abs_f} (content already injected below — do not ReadFile it unless you need lines beyond what's shown)\n"
                local _total_lines
                _total_lines=$(wc -l < "$abs_f" 2>/dev/null || echo 0)
                local _body
                _body=$(head -n "$_EXISTING_FILE_MAX_LINES" "$abs_f" 2>/dev/null)
                existing_file_contents="${existing_file_contents}
### ${abs_f}
\`\`\`
${_body}
\`\`\`
"
                if [ "${_total_lines:-0}" -gt "$_EXISTING_FILE_MAX_LINES" ]; then
                    existing_file_contents="${existing_file_contents}(truncated at ${_EXISTING_FILE_MAX_LINES} of ${_total_lines} lines — ReadFile this path yourself if you need the rest)
"
                fi
            else
                write_first_lines="${write_first_lines}   - ${abs_f} (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)\n"
            fi
        else
            write_first_lines="${write_first_lines}   - WRITE ${abs_f} first, before any other action\n"
        fi
    done < <(echo "$story_json" | jq -r '.technicalNotes.files[]? // empty')

    # Brownfield testing policy — the "no wild tests" gate. Greenfield writes
    # new code + its own new tests. Brownfield MODIFIES existing code: the
    # existing suite already runs (Step 5 regression guard + Step 4.5 unit
    # gate), so a modified file that already has covering tests needs NO new
    # test. Only a modified file with ZERO covering tests warrants ONE targeted
    # test. We compute exactly that set deterministically here (CodeGraph's
    # `affected`) and tell the agent — so it never generates speculative tests
    # for already-covered code just because an AC says "add tests".
    local brownfield_test_policy=""
    # For a DEFECT (fix site known), the repro-gate REQUIRES a new bug-reproducing
    # test EVEN IF the file already has coverage — the bug escaped that coverage by
    # definition. The dedicated repro-test-writer now authors it (impl is told the
    # test is NOT its job — see test_ownership_block above). Skip the
    # coverage-based "don't write unnecessary tests / already covered → out of scope"
    # policy for defects: it DIRECTLY CONTRADICTED the repro-gate and was the live
    # cause of the missing test (AMSD-1820, 2026-07-24 — the agent was told the file
    # "ALREADY has covering tests. Do NOT write any new test file", so it shipped
    # none). The coverage policy still applies to non-defect brownfield changes.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "$fix_site_analysis" ]; then
        local _story_rel_files=()
        while IFS= read -r _sf; do
            [ -z "$_sf" ] && continue
            # Gate wants repo-relative paths; strip any absolute PROJECT_ROOT prefix.
            _story_rel_files+=("${_sf#"$PROJECT_ROOT"/}")
        done < <(echo "$story_json" | jq -r '.technicalNotes.files[]? // empty')
        if [ "${#_story_rel_files[@]}" -gt 0 ]; then
            local _uncovered _gate_rc=0
            _uncovered=$(PROJECT_ROOT="$PROJECT_ROOT" NODE_BIN="${NODE_BIN:-node}" \
                bash "$SCRIPT_DIR/brownfield-coverage-gate.sh" "${_story_rel_files[@]}" 2>/dev/null) || _gate_rc=$?
            if [ "$_gate_rc" -eq 3 ]; then
                # Gate couldn't determine coverage (no index) — do not claim
                # anything; fall back to the default AC-driven behavior.
                brownfield_test_policy=""
            elif [ -n "$_uncovered" ]; then
                brownfield_test_policy="## Brownfield Testing Policy (READ — do not write unnecessary tests)
This is a change to EXISTING code. The existing test suite already runs after your change (regression gate) — you do NOT need to re-prove already-tested behavior. Add a test ONLY for the file(s) below, which currently have NO covering tests, and add just ONE focused test covering the specific behavior you changed. Do NOT add tests for any other file, and do NOT expand scope:
$(printf '%s\n' "$_uncovered" | sed 's/^/  - /')"
            else
                brownfield_test_policy="## Brownfield Testing Policy (READ — do not write unnecessary tests)
This is a change to EXISTING code, and every file you are modifying ALREADY has covering tests. Do NOT write any new test file. Make your code change; the existing test suite runs automatically and will verify it. Writing new tests here is out of scope."
            fi
        fi
    fi

    # "Do NOT investigate" is right for greenfield (nothing exists yet to
    # read — the failure mode this directive originally fixed was agents
    # describing a plan in prose and never calling WriteFile at all). It is
    # actively wrong for brownfield: forbidding the agent from reading an
    # EXISTING file before modifying it guarantees it can't see the file's
    # real exports/utilities, and it will hallucinate plausible-sounding ones
    # instead. Found live 2026-07-23 (AMSD-1820): agent invented a
    # non-existent `@eps/utils` import and wrong export names across 8
    # attempts, at every model tier including the ladder's highest, because
    # it was told "do NOT read files, do NOT investigate" on every attempt.
    local write_first_directive
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        write_first_directive="CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below."
    else
        write_first_directive="CRITICAL — WRITE FILES FIRST. Your FIRST tool call MUST be WriteFile.
Do NOT output any text before calling WriteFile. Do NOT plan or say \"I will...\".
Call WriteFile NOW for the EXACT ABSOLUTE PATHS listed below:"
    fi

    # CodeGraph tool (brownfield only): the agent can query the existing codebase
    # to CONFIRM an existing helper before writing new logic. The prescribed fix
    # (Root Cause Analysis, above) may name a helper to reuse; this lets the agent
    # verify its exact symbol + import path rather than hallucinate one. Reusing
    # an existing function instead of hand-rolling a new one is the whole point —
    # fewer lines, no duplicated logic (found live 2026-07-23, AMSD-1820: the
    # agent invented split-discount logic and a phantom field instead of reusing
    # the existing key parser the one-line fix needed).
    local codegraph_tool_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && command -v codegraph >/dev/null 2>&1; then
        # When the detective already prescribed the exact helper to reuse
        # (fixSiteAnalysis[].helper), do NOT push CodeGraph exploration — it drives the
        # agent to burn ReAct turns re-finding a helper it was already handed, and the
        # re-sent conversation balloons input to 137-189K tokens so it never reaches
        # WriteFile (live 2026-07-24, AMSD-1820). Give a minimal "apply directly" note.
        # Full exploration block only when NO helper is prescribed (genuine novel work).
        local _prescribed_helper
        _prescribed_helper=$(echo "$story_json" | jq -r '[.fixSiteAnalysis[]?.helper] | map(select(. != null and . != "")) | .[0] // ""' 2>/dev/null)
        if [ -n "$_prescribed_helper" ]; then
            codegraph_tool_block="## The helper to reuse is ALREADY identified — do NOT search
The Root Cause Analysis above names the exact existing helper to reuse (\`${_prescribed_helper}\`). Do NOT run CodeGraph or explore the codebase to re-find it — that wastes your turn budget. Import it, apply the prescribed minimal fix, write your file(s), and stop. Only search if you hit something the prescribed fix genuinely does not cover."
        else
            codegraph_tool_block="## CodeGraph Tool — find EXISTING functions to reuse (do this BEFORE writing any new helper)
An existing-code search tool is available. Run it with the Bash tool to discover reusable functions instead of inventing new ones:
  PROJECT_ROOT=\"$PROJECT_ROOT\" bash \"$SCRIPT_DIR/codegraph-agent-query.sh\" helpers <domain nouns>   # existing util/parser/formatter to REUSE (symbol + import path)
  PROJECT_ROOT=\"$PROJECT_ROOT\" bash \"$SCRIPT_DIR/codegraph-agent-query.sh\" query <SymbolName>        # exact definition site of a symbol
  PROJECT_ROOT=\"$PROJECT_ROOT\" bash \"$SCRIPT_DIR/codegraph-agent-query.sh\" callees <SymbolName>      # what a function already calls
RULE: Before you add ANY new function, run \`helpers\` for what it would do. If a suitable function already exists, import and call it — do NOT duplicate it. Fewer lines of code is always better."
        fi
    fi

    # Deterministic contract injection — root cause of a recurring live-run
    # failure (validated live: baseline model call guessed the wrong import
    # path './skyscanner-client'; with the dependency's contract injected,
    # it used the correct './skyscanner/client' every time). The typescript-
    # engineer profile already instructs agents to WRITE a contract file
    # after finishing (.contracts/<storyId>.md — exact exports, constructor
    # signature, ready-to-paste import/mock pattern) — but nothing ever READ
    # it back for a dependent story. Reading was 100% dependent on the
    # dependent story's agent choosing to open the file itself, which it
    # unreliably did. Inject it directly so it's guaranteed, not requested.
    local dependency_contracts=""
    local _dep_ids_json="[]"
    if [ -n "$dependencies" ]; then
        _dep_ids_json=$(echo "$story_json" | jq -c '[(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]')
        local _dep_id
        while IFS= read -r _dep_id; do
            [ -z "$_dep_id" ] && continue
            local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
            if [ -f "$_contract_file" ]; then
                dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
            fi
        done < <(echo "$_dep_ids_json" | jq -r '.[]?')
    fi

    # Spec-reality cross-check (added 2026-07-06 — see project_backlog memory
    # "Spec-reality cross-check"). Root cause this catches: the PRD itself is
    # an LLM-authored/elaborated artifact, just as hallucination-prone as
    # agent-generated code — a live defect had SKY-003's own description
    # assert "Instantiate SkyscannerClient from `src/skyscanner-client.ts`"
    # when the real file SKY-002 built was at `src/skyscanner/client.ts`. The
    # model faithfully followed a WRONG instruction baked into its own task
    # description — hooks (session-time, per-WriteFile) would NOT catch this,
    # since the bug is in what the agent was TOLD, not in what it produced.
    # Deterministically extracts backtick-quoted path-like strings from this
    # story's own description/ACs and checks each against a dependency's REAL
    # technicalNotes.files (ground truth, not model-transcribed) — flagging a
    # mismatch instead of silently injecting the correct contract ALONGSIDE
    # an uncorrected wrong claim (which is what happened live: the agent saw
    # both the correct contract and the wrong prose path and still guessed
    # wrong on early attempts).
    local spec_reality_warning=""
    if [ "$_dep_ids_json" != "[]" ]; then
        local _dep_files_json
        _dep_files_json=$(jq -c --argjson ids "$_dep_ids_json" \
            '[.stories[] | select(.id as $sid | $ids | index($sid)) | .technicalNotes.files[]? // empty]' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        spec_reality_warning=$(python3 - "$description" "$acceptance_criteria" "$_dep_files_json" << 'PYEOF'
import json, os, re, sys

description, acs, dep_files_json = sys.argv[1], sys.argv[2], sys.argv[3]
dep_files = json.loads(dep_files_json)

# Same token-overlap heuristic already proven in the relative-import-check's
# suggestion logic — a basename EQUALITY check is too strict for the actual
# live bug shape (`skyscanner-client.ts` vs the real `client.ts` under
# `skyscanner/` — different basenames, same underlying identifier).
def tokenize(name):
    return set(re.split(r'[^a-zA-Z0-9]+', name.lower())) - {''}

def is_test_file(path):
    return bool(re.search(r'\.(test|spec)\.[a-zA-Z0-9]+$', path))

dep_impl_files = [f for f in dep_files if not is_test_file(f)]

# Backtick-quoted, path-like strings only (contains a slash, ends in a
# common source extension) — plain identifiers/method names in backticks
# are not file-path claims and shouldn't be checked here.
PATH_RE = re.compile(r'`([\w./-]+/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`')

mismatches = []
seen = set()
for text in (description, acs):
    for m in PATH_RE.finditer(text):
        claimed = m.group(1)
        if claimed in seen:
            continue
        seen.add(claimed)
        if any(claimed == f or f.endswith('/' + claimed) for f in dep_files):
            continue  # exact match against a real dependency file — no mismatch
        claimed_tokens = tokenize(os.path.splitext(os.path.basename(claimed))[0])
        if not claimed_tokens:
            continue
        best_real, best_overlap = None, 0
        for real in dep_impl_files:
            real_tokens = tokenize(os.path.splitext(os.path.basename(real))[0])
            if not real_tokens:
                continue
            overlap = claimed_tokens & real_tokens
            ratio = len(overlap) / min(len(claimed_tokens), len(real_tokens))
            if ratio >= 0.5 and len(overlap) > best_overlap:
                best_real, best_overlap = real, len(overlap)
        if best_real:
            mismatches.append((claimed, best_real))

if mismatches:
    lines = [
        "## SPEC-REALITY MISMATCH (auto-detected — the description/ACs above contain a WRONG file path)",
        "The following path(s) in this story's own description/ACs do NOT match the real file a dependency actually built. TRUST THE CONTRACT SECTION BELOW, NOT THE WRONG PATH ABOVE:",
    ]
    for claimed, real in mismatches:
        lines.append(f"- Description/ACs say `{claimed}` — the REAL file is at `{real}`. Use the real path.")
    print('\n'.join(lines))
PYEOF
)
    fi

    cat << EOF
$([ -n "$spec_reality_warning" ] && printf '%s\n\n' "$spec_reality_warning" || true)$write_first_directive

$(printf '%b' "$write_first_lines")
---

Implement user story $story_id: $title

## Story Description
$description

## Acceptance Criteria
- $acceptance_criteria
$([ -n "$string_invariants_block" ] && printf '%s\n' "$string_invariants_block" || true)
$([ -n "$fix_site_analysis" ] && printf '\n## Root Cause Analysis & Prescribed Fix (AUTHORITATIVE — start here, do not re-trace)\nA code investigation already traced this bug to its cause and prescribed the minimal fix below. This is the plan of record. Apply it; do NOT re-read the whole codebase to re-derive it.\n\nThe Acceptance Criteria above describe the desired END BEHAVIOR to VERIFY — they are NOT an implementation blueprint. Do not re-architect, split values, or add new fields/abstractions to satisfy an AC literally when the prescribed minimal fix already makes that AC pass. Implement the fix below; the ACs are how you check you got it right.\n\nHARD RULES:\n- Make the SMALLEST change that fixes the root cause. Fewer lines of code is always better.\n- REUSE existing functions. Before writing any new helper, search the repo for an existing util/parser/formatter that already does what you need (use the CodeGraph tool documented below) and call it. Writing novel code when a helper already exists is a defect to be rejected in review.\n%s\n' "$fix_site_analysis" || true)
$([ -n "$review_feedback" ] && printf '\n## Reviewer Feedback — ADDRESS THESE (a prior code review requested changes)\nThe team-lead reviewer examined your previous attempt and requested the changes below. This is the highest priority: make the SMALLEST edits that resolve each point. If a point says the change is over-engineered or a more concise change/existing helper would do, REMOVE the excess and use the minimal approach — do not add more code.\n%s\n' "$review_feedback" || true)
$([ -n "$verification_criteria" ] && printf '\n## Verification Criteria (what a tester will CONFIRM — your change must satisfy every one)\nThese are observable checks, derived from the acceptance criteria and description. They describe WHAT is observed, not how to build it. Make the minimal change that makes all of these true; your accompanying test should assert them:\n%s\n' "$verification_criteria" || true)
$([ -n "$test_ownership_block" ] && printf '%s\n' "$test_ownership_block" || true)
$([ -n "$codegraph_tool_block" ] && printf '\n%s\n' "$codegraph_tool_block" || true)
$([ -n "$brownfield_test_policy" ] && printf '\n%s\n' "$brownfield_test_policy" || true)
$([ -n "$tc_facts" ] && printf '\n## Test Criteria (ground truth — written from actual source; overrides any conflicting AC)\n%s\n' "$tc_facts" || true)
$([ -n "$tc_mock_strategy" ] && printf '\n## Mock Strategy\n%s\n' "$tc_mock_strategy" || true)
$([ -n "$tc_banned" ] && printf '\n## Banned Patterns (must NOT appear in your file)\n%s\n' "$tc_banned" || true)

## Technical Notes
$([ -n "$technical_notes" ] && echo "$technical_notes" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")' 2>/dev/null || echo "None specified")
$([ -n "$existing_file_contents" ] && printf '\n## Existing File Contents (injected once, deterministically — do NOT ReadFile these unless you need more than shown)\n%s\n' "$existing_file_contents" || true)

## Files to Create/Modify (EXACT ABSOLUTE PATHS — write to these paths exactly)
$files

## Dependencies
${dependencies:-None}
$([ -n "$dependency_contracts" ] && printf '\n## Dependency Contracts (EXACT import paths and signatures — use these verbatim, do NOT guess a different path)\n%s\n' "$dependency_contracts" || true)
$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)

## Instructions
$write_first_directive
$(printf '%b' "$write_first_lines")
$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "**The content of every file listed above is already shown in ## Existing File Contents — use that, do not spend a tool call re-reading them. Use Edit for targeted changes to existing files — do NOT overwrite an existing file wholesale with WriteFile.**"
else
  echo "**You MUST write every file listed above to its EXACT absolute path. Do NOT write to a different path, do NOT write to the current directory unless it matches the path above. Use your WriteFile or Edit tools with the full absolute path shown.**"
fi)

$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "1. Use the injected ## Existing File Contents above to verify what actually exists (exports, types, existing utilities) before writing any code — do not guess, and do not re-read a file already shown in full"
else
  echo "1. Write each required file to its exact absolute path listed above — do this FIRST before anything else"
fi)
2. Implement all acceptance criteria for this story
$([ -n "$tc_facts" ] && echo "3. Test Criteria facts above are ground truth — your test assertions MUST match them exactly" || echo "3. Follow the project's existing code patterns and conventions")
4. Do NOT create tests unless explicitly required in acceptance criteria

After implementation, provide a brief summary of what was created/modified.
EOF
}

build_generator_prompt() {
    local story_id=$1
    local story_json=$(get_story_details "$story_id")

    local title=$(echo "$story_json" | jq -r '.title')
    local description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    local files=$(echo "$story_json" | jq -r '.technicalNotes.files // [] | join(", ")')
    local dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # Rewrite main-repo absolute paths to worktree path in all prompt fields
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    cat << EOF
Generate file for story $story_id: $title

## Story Description
$description

## Acceptance Criteria
- $acceptance_criteria

## Technical Notes
$([ -n "$technical_notes" ] && echo "$technical_notes" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")' 2>/dev/null || echo "None specified")

## Files to Create
$files

## Dependencies (already implemented — do NOT read them)
${dependencies:-None}

## GENERATOR CONTRACT — READ THIS FIRST
You are a FILE GENERATOR. Your ONLY job is to write the file listed under "Files to Create".

**MANDATORY FIRST ACTION: Call WriteFile immediately. Do NOT call any other tool first.**

Rules:
1. Your FIRST tool call MUST be WriteFile to the target path above.
2. Do NOT call ReadFile, ListFiles, Bash, Search, or any other tool before WriteFile.
3. Write the COMPLETE file content in a single WriteFile call.
4. After WriteFile succeeds, you are done. No verification reads, no follow-up patches.
5. All information you need is in this prompt. The spec is authoritative — do NOT read existing files for context.

Generation approach: read every acceptance criterion once, hold them all in mind, then write a file that satisfies all of them in one shot.
EOF
}

# Verify every file declared by the story exists in the execution root.
# This prevents a successful provider response from completing a story that
# produced no deliverables.
verify_story_deliverables() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local missing=()
    local declared=0
    local file

    # Vendor/build-output directories (node_modules for npm, vendor for Go,
    # venv/site-packages for Python, etc.) are provisioned by dependency
    # install (run_dependency_check), never authored by the agent -- but a
    # spec-pass elaboration can still declare one in technicalNotes.files
    # (found live, 2026-07-12: SKY-001B declared node_modules/ before it
    # existed yet, costing one wasted retry). Reuse the SAME generic,
    # project-supplied vendorDirs config _get_vendor_dirs() reads for
    # run_dependency_check/_vendor_lock -- no new hardcoded directory list
    # in this engine. NOTE: cannot reuse _get_vendor_dirs() itself here --
    # it deliberately filters to dirs that ALREADY exist (right, for its own
    # lock/integrity-check callers), but this check specifically needs to
    # match a vendor dir that does NOT exist yet (that's the exact bug being
    # fixed), so read the same config key directly without that filter.
    local _vendor_dirs=""
    local _vendor_config="${PROJECT_ROOT}/.epam/dependency-check.json"
    if [ -f "$_vendor_config" ]; then
        _vendor_dirs=$(jq -r '.vendorDirs[]? // empty' "$_vendor_config" 2>/dev/null | \
            while IFS= read -r _d; do
                [ -n "$_d" ] && echo "${PROJECT_ROOT}/${_d}"
            done)
    fi

    local unchanged=()
    while IFS= read -r file; do
        [ -n "$file" ] || continue
        declared=$((declared + 1))
        # Support both absolute paths and paths relative to PROJECT_ROOT.
        # In worktree mode, absolute paths in technicalNotes.files point to the main
        # repo (e.g. /skyscanner-app/src/foo.ts). Rewrite them to the worktree path
        # so the deliverable check and agent prompt target the correct directory.
        local check_path
        if [[ "$file" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$file" = "${MAIN_PROJECT_ROOT}"* ]]; then
                check_path="${PROJECT_ROOT}${file#${MAIN_PROJECT_ROOT}}"
            else
                check_path="$file"
            fi
        else
            check_path="$PROJECT_ROOT/$file"
        fi
        local _is_vendor_path=false
        if [ -n "$_vendor_dirs" ]; then
            while IFS= read -r _vendor_dir; do
                [ -z "$_vendor_dir" ] && continue
                case "$check_path" in
                    "$_vendor_dir"|"$_vendor_dir"/*) _is_vendor_path=true; break ;;
                esac
            done <<< "$_vendor_dirs"
        fi
        [ "$_is_vendor_path" = true ] && continue
        if [ ! -s "$check_path" ]; then
            missing+=("$file")
            continue
        fi
        # Brownfield: "exists and is non-empty" is a real signal for a file
        # the agent was supposed to CREATE, but it is trivially true — and
        # proves nothing — for a file that already existed before this story
        # started, which is the normal case for a bugfix in an existing
        # codebase. Live bug (2026-07-22): three separate story attempts ran
        # out of turn budget mid-exploration, called WriteFile/Edit on
        # nothing, and this check still passed every time because the
        # declared files (pre-existing application code) were obviously
        # already there — the pipeline then marked the story "completed" and
        # committed whatever incidental pipeline noise (CodeGraph index,
        # .epam manifests) happened to be dirty instead. For a file that
        # already existed at the story's own baseline (the commit its branch
        # was created from — see ensure_story_branch), require a REAL
        # content diff, not just presence. A genuinely NEW file (didn't
        # exist at baseline) is already fully proven by the exists+non-empty
        # check above — no diff is possible or required for it.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -d "$PROJECT_ROOT/.git" ]; then
            local _baseline_ref="origin/${JIRA_BASELINE_BRANCH:-develop}"
            if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
                local _rel_path="$check_path"
                case "$_rel_path" in
                    "$PROJECT_ROOT"/*) _rel_path="${_rel_path#"$PROJECT_ROOT"/}" ;;
                esac
                if git -C "$PROJECT_ROOT" cat-file -e "${_baseline_ref}:${_rel_path}" 2>/dev/null; then
                    if git -C "$PROJECT_ROOT" diff --quiet "$_baseline_ref" -- "$_rel_path" 2>/dev/null; then
                        # Soft signal, NOT added to missing[] — declared files
                        # that pre-existed at baseline (the normal case for a
                        # bugfix) can legitimately include several CANDIDATE
                        # fix sites (e.g. locationHint's 2-3 file guesses from
                        # spec-mode-runner.js), only some of which the agent
                        # may genuinely need to touch. Requiring EVERY
                        # candidate to change is over-strict and produces a
                        # false failure the moment a real fix only needs a
                        # subset — found live (2026-07-23, AMSD-1820): openspec
                        # correctly identified 3 candidate files, the agent
                        # correctly edited 2 of them, and this check failed
                        # the whole story over the 1 unedited candidate.
                        # A file the story explicitly says to CREATE (didn't
                        # exist at baseline) has no such ambiguity — that one
                        # stays a hard requirement via missing[] above.
                        unchanged+=("$file")
                    fi
                fi
            fi
        fi
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    if [ ${#missing[@]} -gt 0 ]; then
        error "Story $story_id is missing ${#missing[@]} declared deliverable(s) in $PROJECT_ROOT:"
        for file in "${missing[@]}"; do
            error "  $file"
        done
        return 1
    fi

    # Fail only when EVERY declared, pre-existing file is unchanged — that's
    # the "nothing real happened" signal this whole function exists to catch.
    # If at least one declared file shows a real diff, the story did genuine
    # work; the rest were legitimate candidates that turned out unnecessary.
    if [ "$declared" -gt 0 ] && [ ${#unchanged[@]} -eq "$declared" ]; then
        error "Story $story_id: all $declared declared deliverable(s) exist but are UNCHANGED since baseline — no real work done anywhere in the declared set:"
        for file in "${unchanged[@]}"; do
            error "  $file"
        done
        return 1
    elif [ ${#unchanged[@]} -gt 0 ]; then
        warning "Story $story_id: ${#unchanged[@]}/$declared declared candidate file(s) were unchanged (real work landed in the others) — informational, not a failure:"
        for file in "${unchanged[@]}"; do
            warning "  $file"
        done
    fi

    # Brownfield, zero declared files: the per-file loop above has nothing to
    # check, so it trivially passes — but that proves nothing about whether
    # the agent actually did any real work. Live bug (2026-07-22, run14):
    # locationHint propagation into technicalNotes.files (see spec-mode-
    # runner.js) is itself non-deterministic — the same spec-pass prompt can
    # return it populated on one attempt and empty on the next. When it's
    # empty, this function had NOTHING to verify and silently passed a story
    # whose agent turn produced no real change at all (confirmed: the only
    # file that had changed was CodeGraph's own incidental index write).
    # Fallback: if brownfield declared zero files, require the WHOLE tree to
    # show some real change relative to baseline, excluding known-incidental
    # pipeline paths (.codegraph/, .epam/) that are never genuine story
    # output. This is a coarser check than the per-file diff above (it can't
    # say WHICH file should have changed, since none were declared), but it
    # still catches "nothing real happened" — the actual failure pattern
    # behind three separate false-completion incidents today.
    if [ "$declared" -eq 0 ] && [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -d "$PROJECT_ROOT/.git" ]; then
        local _baseline_ref="origin/${JIRA_BASELINE_BRANCH:-develop}"
        if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
            local _real_changes
            _real_changes=$(git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" 2>/dev/null | \
                grep -v -E '^(\.codegraph/|\.epam/)' || true)
            if [ -z "$_real_changes" ]; then
                error "Story $story_id declared NO technicalNotes.files, and no real change exists anywhere in $PROJECT_ROOT relative to ${_baseline_ref} (only incidental pipeline paths, if anything, changed) — treating as incomplete rather than trusting an empty deliverable list."
                return 1
            fi
        fi
    fi

    if [ "$declared" -gt 0 ]; then
        success "Verified $declared declared deliverable(s) for $story_id"
    fi
    return 0
}

# _scope_lock <story_id>
# Makes every .ts file in PROJECT_ROOT/src that is NOT in the story's declared
# technicalNotes.files read-only (chmod 444) before the agent runs, PLUS every
# file (any extension, any location under PROJECT_ROOT) declared by a DIFFERENT
# story — i.e. a file that already belongs to a prior (or sibling) story's own
# scope. This is an OS-level pre-emptive guard: Bash, WriteFile, or any other
# mechanism that tries to write an out-of-scope file will get EACCES — no
# tool-layer workaround exists.
#
# Root cause the second part fixes (found live, 2026-07-06): the original
# version only ever locked .ts files under src/ — tsconfig.json, package.json,
# vitest.config.ts (root-level, non-.ts scaffold artifacts) were completely
# unprotected. SKY-002 rewrote tsconfig.json — a file it never declared and
# had no business touching — changing a VALID moduleResolution SKY-001 had
# correctly scaffolded into an INVALID one, then regenerated the same wrong
# value on every retry attempt, exhausting the entire retry/escalation ladder
# on a self-inflicted regression in a file outside its own scope. Generic: not
# hardcoded to config-file names — protects whatever any OTHER story declared,
# whatever its extension or location.
_scope_lock() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local -A _decl
    while IFS= read -r _f; do
        [ -n "$_f" ] && _decl["$_f"]=1
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    local _locked=0

    if [ ${#_decl[@]} -gt 0 ]; then
        while IFS= read -r _f; do
            [ -n "${_decl[$_f]+x}" ] && continue
            chmod 444 "$_f" 2>/dev/null && ((_locked++))
        done < <(find "$PROJECT_ROOT/src" -name "*.ts" -type f 2>/dev/null)
    fi

    local _other_locked=0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        [ -n "${_decl[$_f]+x}" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] || continue
        chmod 444 "$_abs_f" 2>/dev/null && ((_other_locked++))
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)

    [ "$_locked" -gt 0 ] && log "  [scope-guard] Locked $_locked out-of-scope .ts file(s) (read-only) for $story_id"
    [ "$_other_locked" -gt 0 ] && log "  [scope-guard] Locked $_other_locked file(s) owned by other stories (read-only) for $story_id"
}

# _scope_unlock <story_id>
# Restores write permissions on all .ts files in PROJECT_ROOT/src, plus every
# file owned by a different story that _scope_lock locked above.
_scope_unlock() {
    local story_id="${1:-}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    find "$PROJECT_ROOT/src" -name "*.ts" -type f -exec chmod 644 {} + 2>/dev/null || true

    [ -z "$story_id" ] && return 0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] && chmod 644 "$_abs_f" 2>/dev/null || true
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)
}

# _get_vendor_dirs <project_root>
# Reads the generic, project-supplied list of vendored-dependency directories
# from .epam/dependency-check.json's "vendorDirs" key (e.g. ["node_modules"]
# for an npm project, ["venv", "site-packages"] for Python, ["vendor"] for Go
# — never hardcoded in this engine, since a future project may not use npm at
# all). Opt-in: no config file or no "vendorDirs" key = no output, callers
# no-op. Echoes one absolute path per line for directories that actually exist.
_get_vendor_dirs() {
    local project_root="$1"
    local config_file="${project_root}/.epam/dependency-check.json"
    [ -f "$config_file" ] || return 0
    jq -r '.vendorDirs[]? // empty' "$config_file" 2>/dev/null | while IFS= read -r _d; do
        [ -z "$_d" ] && continue
        local _abs="$project_root/$_d"
        [ -d "$_abs" ] && echo "$_abs"
    done
}

# _vendor_lock <project_root>
# Root cause this addresses (found live, 2026-07-07): a story's agent,
# repeatedly failing to get its real test tool working, OVERWROTE the actual
# installed package's own entry point file (node_modules/vitest/vitest.mjs)
# with a fake stub that unconditionally echoed "passed" — the agent faking
# verification success rather than fixing the underlying problem. HealingBroken
# eventually caught the recurring failure and the story was correctly marked
# failed, not falsely passed, but the tampering itself should never have been
# possible in the first place.
#
# chmod -R a-w on every configured vendor dir, same OS-level pre-emptive
# guard already proven for _scope_lock's per-story file protection — applied
# once per story attempt (before invoking the agent), not per-file, since
# vendor dirs are NEVER a legitimate write target for any story, unlike
# src/ files which rotate ownership between stories.
# Note (same limitation _scope_lock already documents): this deters, it does
# not cryptographically prevent — the file owner can still `chmod +w` via
# Bash and bypass it. See run_vendor_integrity_check() below for the backstop
# that catches tampering even when the lock itself is bypassed.
_vendor_lock() {
    local project_root="$1"
    local _locked=0
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R a-w "$_vendor_dir" 2>/dev/null && ((_locked++))
    done < <(_get_vendor_dirs "$project_root")
    if [ "$_locked" -gt 0 ]; then
        mkdir -p "$project_root/.epam" 2>/dev/null || true
        touch "$project_root/.epam/.vendor-lock-marker" 2>/dev/null || true
        log "  [vendor-guard] Locked $_locked vendor director(y/ies) read-only"
    fi
}

# _vendor_unlock <project_root>
# Restores write permissions on configured vendor dirs — called after the
# agent's own turn ends, before run_dependency_check's own LEGITIMATE
# installs (which do need to write there) and the deterministic checks/test
# run. The integrity check itself (run_vendor_integrity_check) runs BEFORE
# this unlock and before run_dependency_check, so it only ever sees changes
# from the agent's own turn, never dependency-check's sanctioned writes.
_vendor_unlock() {
    local project_root="$1"
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R u+w "$_vendor_dir" 2>/dev/null || true
    done < <(_get_vendor_dirs "$project_root")
}

# run_dynamic_tools_in_unlocked_window <project_root> <output_file>
# Deterministically executes every dynamic tool the self-healing loop has
# written for this project, in the SANCTIONED unlocked window (right after
# _vendor_unlock, before the test command runs) — not left to the agent to
# invoke via Bash sometime during its own turn.
#
# Root cause this fixes (found live, 2026-07-09, tier3-travel-app run):
# _vendor_lock() chmods vendor dirs (e.g. node_modules) read-only for the
# WHOLE story turn, before the agent runs. When the failure-analyst diagnoses
# a missing dependency and writes a dynamic tool that runs `npm install X`,
# the agent's own invocation of that tool happens DURING the same locked
# turn — the install either fails outright (permission denied, surfacing as
# the exact same "X not found" diagnosis on every retry) or partially writes
# just enough to trip run_vendor_integrity_check's tamper detector, hard-
# failing the story before the fix ever had a chance to land. A dependency-
# installing dynamic tool could NEVER succeed under the old lock ordering —
# confirmed live: SKY-002-test/SKY-002-test-1 each burned all 8 retries on
# "vitest not found" without the repeatedly-rewritten install-vitest.sh tool
# ever actually installing vitest.
#
# Tools are already required to be idempotent (enforced by the tool_creation
# reviewer's own rules), so running them here — unconditionally, every retry,
# in a genuinely unlocked window — is safe even if the agent ALSO tries to
# invoke the same tool itself during its turn.
#
# Safety floor: each tool is syntax-checked (bash -n) before being trusted to
# execute. The orchestrator (not just the agent) now runs these
# unconditionally every retry, so a tool that's merely syntactically broken
# must not be blindly executed — skip and log rather than let a malformed
# script corrupt state or hang the pipeline.
run_dynamic_tools_in_unlocked_window() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local tools_dir="$project_root/.epam/dynamic-tools"
    [ -d "$tools_dir" ] || return 0
    [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ] || return 0

    local _tool_file _tool_base
    for _tool_file in "$tools_dir"/*.sh; do
        [ -f "$_tool_file" ] || continue
        _tool_base="${_tool_file##*/}"
        # Only reviewed tools are ever used by downstream agents or the
        # orchestrator itself — an explicit, checkable marker, not an
        # assumption that the directory only ever contains reviewed scripts.
        if [ ! -f "${_tool_file}.reviewed" ]; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — no .reviewed marker (not approved by the reviewer gate)"
            continue
        fi
        if ! bash -n "$_tool_file" 2>>"$output_file"; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — fails bash syntax check"
            continue
        fi
        log "  [dynamic-tools] Running ${_tool_base} in sanctioned unlocked window..."
        if ! (cd "$project_root" && bash "$_tool_file") >> "$output_file" 2>&1; then
            warning "  [dynamic-tools] ${_tool_base} exited non-zero (continuing)"
        fi
    done
}

# run_vendor_integrity_check <project_root> <output_file>
# Deterministic backstop (found live, 2026-07-07 — see _vendor_lock's
# docstring for the exact live defect this catches): detects any file under a
# configured vendor dir modified since the lock marker was touched at story-
# attempt start, regardless of whether the chmod lock itself was bypassed.
# A legitimate story NEVER needs to modify an already-installed vendored
# package's own files — only add NEW dependencies via the manifest, which
# run_dependency_check's sanctioned install step handles AFTER this check
# runs. Any hit here is treated as a hard, deterministic failure — no LLM
# diagnosis needed, the fact itself is certain.
#
# Excludes tool-generated cache/output paths, config-supplied via
# .epam/dependency-check.json's "vendorCacheExcludePatterns" (bash glob
# patterns matched against each file's path relative to the vendor dir — e.g.
# ".vite/*" for Vitest's own results cache). No test-runner/tool name is
# hardcoded in this engine, same "manifest supplies stack knowledge" pattern
# as vendorDirs/requiredDevDependencies above. Root cause this fixes (found
# live, 2026-07-13, SKY-004 and SKY-003-b): a story's agent legitimately runs
# its own tests to self-verify — completely normal, encouraged behavior — and
# vitest rewrites its OWN result cache (node_modules/.vite/vitest/results.json)
# as a side effect. That's the tool's own transient output, not a rewrite of
# its actual entry-point/source code (the exploit this check exists to catch,
# e.g. node_modules/vitest/vitest.mjs) — but the check couldn't tell them
# apart, hard-failing 4 separate legitimate test runs across two stories in a
# single run.
# Returns 0 if clean (or no vendor dirs configured / no marker yet). Returns 1
# and sets VERIFICATION_FAILURE otherwise.
run_vendor_integrity_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local marker="$project_root/.epam/.vendor-lock-marker"
    [ -f "$marker" ] || return 0

    local -a exclude_patterns=()
    local _config_file="$project_root/.epam/dependency-check.json"
    if [ -f "$_config_file" ]; then
        while IFS= read -r _pat; do
            [ -n "$_pat" ] && exclude_patterns+=("$_pat")
        done < <(jq -r '.vendorCacheExcludePatterns[]? // empty' "$_config_file" 2>/dev/null)
    fi

    local tampered=()
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        while IFS= read -r _f; do
            [ -z "$_f" ] && continue
            local _rel="${_f#"$_vendor_dir"/}"
            local _excluded=false
            local _pat
            for _pat in "${exclude_patterns[@]}"; do
                # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
                case "$_rel" in
                    $_pat) _excluded=true; break ;;
                esac
            done
            [ "$_excluded" = true ] || tampered+=("$_f")
        done < <(find "$_vendor_dir" -type f -newer "$marker" 2>/dev/null)
    done < <(_get_vendor_dirs "$project_root")

    [ "${#tampered[@]}" -eq 0 ] && return 0

    local details
    details=$(printf '%s\n' "${tampered[@]}" | head -20)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nFile(s) inside a vendored/third-party dependency directory were modified — this is never legitimate (only NEW dependencies should be added via the manifest, never an existing installed package edited directly). Revert this change and fix the ACTUAL problem (e.g. wrong package.json config, missing devDependency) instead:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Vendor directory integrity check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_dependency_check <project_root>
# Deterministic (non-LLM) replacement for "hope the agent remembers to
# install what it imports" — the exact recurring failure class this session
# kept hitting (supertest imported but never added to devDependencies,
# burning full retry cycles on the same mechanical mistake every time).
#
# Fully generic: reads a dependency-check.json for the manifest file, its
# dependency keys, the import-statement regex, and the install command
# template — all data, no npm/pip/cargo/language assumption anywhere in this
# function. Different orchestrations (Python, Rust, etc.) supply their own
# manifest; this function is identical for all of them.
#
# Config location: for a brownfield codeline, this config is NEVER stored
# inside the client's own repo (a client codeline is not epam-cli's to write
# into, even for our own tooling — see feedback_no_client_repo_writes_or_
# hardcoding memory). EPAM_PROJECT_CONFIG_DIR (set by the project's own
# tier3-*-run.sh, e.g. orchestrations/projects/metrolinx) is checked first;
# only a project WITHOUT that var set (greenfield, scaffolding its own new
# repo from scratch — a repo the pipeline itself owns) falls back to
# <project_root>/.epam/dependency-check.json, which is legitimate there
# since the pipeline authored that repo in the first place.
# No manifest present = no-op (opt-in feature, old projects unaffected).
run_dependency_check() {
    local project_root="$1"
    local config_file="${EPAM_PROJECT_CONFIG_DIR:-}/dependency-check.json"
    if [ -z "${EPAM_PROJECT_CONFIG_DIR:-}" ] || [ ! -f "$config_file" ]; then
        config_file="${project_root}/.epam/dependency-check.json"
    fi
    [ -f "$config_file" ] || return 0

    python3 - "$project_root" "$config_file" << 'PYEOF'
import json, re, subprocess, sys, os, signal

project_root, config_file = sys.argv[1], sys.argv[2]

with open(config_file) as f:
    cfg = json.load(f)

# preInstallHook (optional): a one-time shell command run ONCE before any
# per-package scanning or installation. Intended for brownfield repos that
# need a full package-manager reconciliation before the agent touches any
# code — e.g. stripping a private-registry dep from package.json, running
# a full package install with --prefer-offline --ignore-scripts, restoring.
# This runs in project_root as cwd.  The hook failing is non-fatal: dep-
# check logs the error and continues so the agent can still attempt work.
# Live bug (2026-07-21): Metrolinx azure.commerce.cdts had cx-shared (GitHub
# Packages, requires auth) causing every per-package install to 401,
# and cp -rn workarounds left truncated files (tsc.js 435KB, ~5MB expected).
# A single full install with cx-shared stripped fixes everything.
hook_cmd = cfg.get('preInstallHook', '')
if hook_cmd:
    print('  [dependency-check] Running preInstallHook...')
    hook_timeout = int(os.environ.get('EPAM_DEP_HOOK_TIMEOUT_SECS', '300'))
    hook_proc = subprocess.Popen(hook_cmd, shell=True, cwd=project_root, start_new_session=True)
    try:
        hook_rc = hook_proc.wait(timeout=hook_timeout)
        if hook_rc != 0:
            print(f'  [dependency-check] preInstallHook exited {hook_rc} (non-fatal — continuing)')
        else:
            print('  [dependency-check] preInstallHook complete')
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(hook_proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        hook_proc.wait()
        print(f'  [dependency-check] preInstallHook TIMED OUT after {hook_timeout}s (non-fatal — continuing)')

manifest_path = os.path.join(project_root, cfg['manifestFile'])
if not os.path.exists(manifest_path):
    sys.exit(0)
with open(manifest_path) as f:
    manifest = json.load(f)

declared = set()
for key in cfg.get('manifestKeys', []):
    declared.update(manifest.get(key, {}).keys())

pattern = re.compile(cfg['importPattern'])
# Live bug (2026-07-06): scanning EVERY file under project_root (no extension
# filter) meant the import regex also ran against orchestration artifacts like
# spec-summary.json, whose free-text LLM coordinator notes can contain prose
# that coincidentally matches an import pattern (e.g. a sentence describing
# "mapping from 'from/to' to 'origin/destination'" was parsed as `from '...'`
# and treated as a missing third-party package named "from/to", which then
# hung retrying against the npm registry indefinitely). Restrict scanning to
# actual source file extensions, config-supplied so this stays generic across
# languages/stacks rather than hardcoding '.ts'/'.js'.
scan_extensions = tuple(cfg.get('scanFileExtensions', []))
imported = set()
# Monorepos can nest an independent sub-project (its own package.json/requirements.txt/
# etc.) inside project_root — e.g. a standalone React tool under scripts/. Its imports
# are declared in ITS OWN manifest, not the root's, so scanning into it here would find
# "missing" packages that are actually just undeclared at the wrong scope and try to
# install them at project_root. Stop descending once a directory (other than
# project_root itself) contains the same manifestFile — that subtree manages its own
# dependencies independently.
manifest_file = cfg['manifestFile']
for root, dirs, files in os.walk(project_root):
    dirs[:] = [
        d for d in dirs
        if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv')
        and not os.path.isfile(os.path.join(root, d, manifest_file))
    ]
    for fname in files:
        if scan_extensions and not fname.endswith(scan_extensions):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue
        for m in pattern.finditer(content):
            pkg = next((g for g in m.groups() if g), None)
            if pkg:
                imported.add(pkg)

# A declared entry satisfies an import if it matches exactly or is a prefix
# component (handles npm scoped packages / subpath imports generically,
# without hardcoding npm's specific scoping syntax).
# ignorePackages is config-supplied (e.g. Node builtins like 'url', 'fs') —
# this function has no language-specific knowledge of what counts as a
# builtin; the orchestration's manifest declares that list.
ignore_packages = set(cfg.get('ignorePackages', []))

# Collect tsconfig path alias prefixes from ALL tsconfig*.json files under
# project_root. Path aliases (e.g. @background/*, @commerce/*) are local
# module mappings, not npm packages — trying to install them fails with 404.
# Generic: reads any tsconfig.json found; no alias names are hardcoded here.
# Live bug (2026-07-21): Metrolinx azure.commerce.cdts has 15+ workspace path
# aliases that aren't npm packages, causing 20+ min dep-check stalls per turn.
import glob as _glob
_tsconfig_aliases = set()
for _tc_path in _glob.glob(os.path.join(project_root, '**/tsconfig*.json'), recursive=True):
    if 'node_modules' in _tc_path:
        continue
    try:
        with open(_tc_path) as _f:
            _tc = json.load(_f)
        for _alias in _tc.get('compilerOptions', {}).get('paths', {}):
            # Strip trailing /* glob: "@background/*" -> "@background"
            _clean = _alias.rstrip('/*').rstrip('/')
            if _clean:
                _tsconfig_aliases.add(_clean)
    except Exception:
        pass

missing = []
for pkg in sorted(imported):
    if pkg in ignore_packages:
        continue
    # Path alias prefixes (~, #) are never real package names.
    # ~ is a TypeScript/webpack path alias (e.g. ~/controllers/foo).
    # # is a Node.js subpath import alias (e.g. #internal/utils).
    # Passing them to the package manager always fails (live bug: Metrolinx codebase).
    if pkg.startswith('~') or pkg.startswith('#'):
        continue
    # Template literal strings in import paths are not package names
    # (e.g. `import x from '${currentPayment.state.value}'`). The import
    # scanner picks up the raw string before interpolation, so `${` in a
    # matched group means it's dynamic code, not an installable package.
    if '${' in pkg:
        continue
    # Tsconfig path aliases are project-local module mappings, not npm packages.
    # Collected above from all tsconfig*.json files under project_root.
    if any(pkg == a or pkg.startswith(a + '/') for a in _tsconfig_aliases):
        continue
    # Live bug (2026-07-06): a Node builtin SUBPATH import (e.g. 'fs/promises',
    # 'node:fs/promises') was only recognized if the exact subpath string was
    # itself enumerated in ignorePackages — 'fs' being listed didn't cover
    # 'fs/promises', so it was treated as a missing THIRD-PARTY package and
    # the configured package manager was invoked on 'fs/promises' as if it
    # were a third-party package, which tries to git-clone a nonexistent
    # GitHub repo and fails outright. Prefix-match against
    # ignorePackages the same way declared deps are already prefix-matched
    # below — generic (any builtin's subpath is covered, not just fs's),
    # not a hardcoded 'fs/promises' special case.
    if any(pkg == d or pkg.startswith(d + '/') for d in ignore_packages):
        continue
    if pkg in declared:
        continue
    if any(pkg == d or pkg.startswith(d + '/') or d.startswith(pkg + '/') for d in declared):
        continue
    # Brownfield repos often have packages installed in node_modules but not
    # declared in package.json (undeclared transitive deps, pre-existing installs).
    # If the top-level package directory already exists in node_modules, it is
    # satisfiable at runtime — skip the install to avoid modifying a brownfield
    # repo's package.json unnecessarily.
    top_pkg = pkg.split('/')[0] if not pkg.startswith('@') else '/'.join(pkg.split('/')[:2])
    if os.path.isdir(os.path.join(project_root, 'node_modules', top_pkg)):
        continue
    missing.append(pkg)

# requiredDevDependencies (added 2026-07-07): tooling packages invoked as a
# CLI binary (e.g. `tsc`, from the 'typescript' package) are never `import`ed
# in source code, so the import-scanning logic above structurally cannot
# detect them as missing — found live when a scaffold story's package.json
# genuinely omitted 'typescript' entirely; nothing ever caught it until the
# phase-level pre-review gate's `tsc --noEmit` call failed with
# "Cannot find module '.../node_modules/.bin/tsc'". Config-supplied (not
# engine-hardcoded) list of package names that must always be present in
# devDependencies regardless of whether anything imports them.
for pkg in cfg.get('requiredDevDependencies', []):
    if pkg not in declared and pkg not in missing:
        missing.append(pkg)

for pkg in missing:
    # Install the top-level package, not a scoped/subpath import string
    # (found live, 2026-07-06): a package.json missing its devDependencies
    # entirely made a real dependency ('vitest', imported as 'vitest/config'
    # in vitest.config.ts) look undeclared. The install command was then
    # built from the FULL matched string — 'vitest/config' — which isn't a
    # real package name, so npm hung retrying against the registry
    # indefinitely (no timeout on this call at all, on top of that). Scoped
    # packages (@scope/name) keep their first TWO segments; anything else
    # keeps only the first segment before a subpath.
    parts = pkg.split('/')
    install_pkg = '/'.join(parts[:2]) if pkg.startswith('@') else parts[0]
    cmd = cfg['installCommand'].format(package=install_pkg)
    print(f"  [dependency-check] Installing missing import: {install_pkg} (from '{pkg}')" if install_pkg != pkg else f"  [dependency-check] Installing missing import: {pkg}")
    install_timeout = int(os.environ.get('EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS', '120'))
    # start_new_session=True + killing the whole process GROUP on timeout
    # (not just subprocess.run(timeout=...)'s default, which only kills the
    # immediate shell): with shell=True, the immediate child is `/bin/sh -c
    # "..."` — if that shell has already forked a real grandchild (npm and
    # ITS children) before the timeout fires, killing just the shell leaves
    # the grandchild orphaned, still running and still holding the shared
    # stdout file descriptor open. Any caller doing a proper read-until-EOF
    # on that output (a test harness capturing output, or a future caller
    # piping this function's output) would then hang waiting for that
    # orphaned process to exit — potentially for as long as the ORIGINAL
    # unbounded hang this fix exists to prevent.
    proc = subprocess.Popen(cmd, shell=True, cwd=project_root, start_new_session=True)
    try:
        proc.wait(timeout=install_timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        print(f"  [dependency-check] Install of '{install_pkg}' TIMED OUT after {install_timeout}s — skipping")
PYEOF
}

# run_mock_completeness_check <project_root> <output_file>
# Deterministic pre-test gate for the recurring "incomplete vi.mock() factory"
# failure class (live-diagnosed repeatedly for SKY-004: "vi.mock factory for
# SkyscannerClient omits `search` method", "vi.mock factory is incomplete;
# unmocked methods are undefined, handlers throw"). The corresponding
# [Self-Heal] skill note ("mock ALL exported methods or spread real ones via
# vi.importActual") was already present in the system prompt from attempt 1
# and was still violated — prompt-based compliance for this rule is
# effectively zero. This check makes the fact deterministic instead: for
# every `vi.mock('<path>', () => ({ ClassName: vi.fn().mockImplementation(()
# => ({ ...methods... })) }))` factory found in a test file, resolve <path>
# to its real source file, parse the REAL class's public method names (same
# regex as generate_story_contract), and fail fast — before the slow test
# run — if any real method is missing from the mock's method list.
# Returns 0 if every mock factory found is complete (or none found). Returns
# 1 and sets VERIFICATION_FAILURE naming the missing method(s) otherwise.
run_mock_completeness_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local config_file="${project_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local result
    result=$(python3 - "$project_root" "$config_file" << 'PYEOF'
import json, os, re, sys

project_root, config_file = sys.argv[1], sys.argv[2]
with open(config_file) as f:
    cfg = json.load(f)
TEST_FILE_EXTS = tuple(cfg['testFileExtensions'])

def is_test_file(path):
    return bool(re.search(cfg['testFilePattern'], path))

def resolve_import(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return candidate
    for ext in TEST_FILE_EXTS:
        if os.path.isfile(candidate + ext):
            return candidate + ext
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return os.path.join(candidate, 'index' + ext)
    return None

def find_matching_brace(text, open_idx):
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return i
    return -1

def top_level_matches(text, pattern):
    # Live bug (2026-07-06, found via SKY-003's repeated false rejections):
    # a plain regex scan over the WHOLE class body has no notion of brace
    # depth, so control-flow statements nested inside a real method's body
    # (e.g. `if (!key) {`) also match `\w+\s*\(...\)\s*{` and get
    # misidentified as class methods (a phantom method literally named
    # "if"). This falsely rejected a CORRECT, COMPLETE mock for "missing"
    # a method that doesn't exist — burning the entire retry/escalation
    # ladder on a check bug, not a real defect. Same fix already applied
    # to generate_story_contract()'s identical parsing: only count a match
    # as a real method when it's a DIRECT child of the class body (depth 1
    # relative to the body's own opening brace), not nested inside another
    # block.
    depth_at = [0] * (len(text) + 1)
    depth = 0
    for i, c in enumerate(text):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        depth_at[i + 1] = depth
    return [m for m in pattern.finditer(text) if depth_at[m.start()] == 1]

def real_class_methods(source_text, class_name):
    # Config-driven (2026-07-06): find ALL classes via cfg['classPattern'] and
    # match by captured name, instead of substituting class_name into a
    # hand-rolled pattern — this way the class-matching regex itself is
    # entirely config-supplied, same as generate_story_contract() already
    # does, with zero stack-specific syntax hardcoded in this function.
    class_re = re.compile(cfg['classPattern'])
    m = None
    for candidate in class_re.finditer(source_text):
        if candidate.group(1) == class_name:
            m = candidate
            break
    if not m:
        return None
    body_start = m.end() - 1
    body_end = find_matching_brace(source_text, body_start)
    if body_end == -1:
        return None
    body = source_text[body_start:body_end + 1]
    method_re = re.compile(cfg['methodPattern'], re.M)
    methods = set()
    for mm in top_level_matches(body, method_re):
        # cfg['methodPattern']'s group shape is fixed by contract-generation.json:
        # (asyncKeyword, methodName, params, returnType) — same groups()
        # ordering generate_story_contract() already relies on.
        name = mm.group(2)
        if name != 'constructor':
            methods.add(name)
    return methods

MOCK_START_RE = re.compile(cfg['mockFactoryStartPattern'])
CLASS_MOCK_RE = re.compile(cfg['mockClassPattern'])
MOCKED_METHOD_RE = re.compile(cfg['mockedMethodPattern'], re.M)

problems = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if not fname.endswith(TEST_FILE_EXTS) or not is_test_file(fname):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue

        for mock_m in MOCK_START_RE.finditer(content):
            import_path = mock_m.group(1)
            outer_start = mock_m.end() - 1
            outer_end = find_matching_brace(content, outer_start)
            if outer_end == -1:
                continue
            outer_body = content[outer_start:outer_end + 1]

            for class_m in CLASS_MOCK_RE.finditer(outer_body):
                class_name = class_m.group(1)
                inner_start = class_m.end() - 1
                inner_end = find_matching_brace(outer_body, inner_start)
                if inner_end == -1:
                    continue
                inner_body = outer_body[inner_start:inner_end + 1]
                mocked_methods = set(MOCKED_METHOD_RE.findall(inner_body))

                real_path = resolve_import(root, import_path)
                if not real_path:
                    continue  # relative-import-check already flags unresolvable paths
                try:
                    with open(real_path, encoding='utf-8', errors='ignore') as f:
                        source_text = f.read()
                except OSError:
                    continue
                real_methods = real_class_methods(source_text, class_name)
                if real_methods is None:
                    continue  # class not found at that path — not this check's concern
                missing = sorted(real_methods - mocked_methods)
                if missing:
                    rel_test = os.path.relpath(fpath, project_root)
                    rel_real = os.path.relpath(real_path, project_root)
                    problems.append(
                        f"{rel_test}: vi.mock() factory for '{class_name}' (from '{import_path}' -> {rel_real}) "
                        f"is missing method(s): {', '.join(missing)}"
                    )

if problems:
    print("INCOMPLETE")
    for line in problems:
        print(line)
else:
    print("OK")
PYEOF
)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA vi.mock() factory is missing method(s) that the real class exports — any test calling a missing method will throw "X is not a function". Add the missing method(s) to the mock before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Mock completeness check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_relative_import_check <project_root> <output_file> [story_id]
# Option D — deterministic detection of a relative import that does not
# resolve to a real file. Root cause this targets: an agent guessing the
# wrong path for a sibling module it can't directly see (recurring live
# failure: './skyscanner-client' guessed, real file at
# './skyscanner/client') — previously only discoverable after a full,
# often multi-minute test run, then re-diagnosed from scratch by the
# failure analyst every single retry. This runs in milliseconds, for free,
# right after the agent's files are written, and suggests the likely
# correct path via filename-token overlap — fully generic, no project- or
# language-specific knowledge (works for .ts/.js relative imports; the
# token-matching heuristic makes no npm/TypeScript-specific assumption).
#
# Auto-apply (added 2026-07-07, opt-in via EPAM_AUTO_FIX_RELATIVE_IMPORTS=true,
# default OFF — preserves the original "detection, not silent rewrite" design
# below unless explicitly enabled): originally this check only ever suggested
# a fix in the retry prompt, on the stated reasoning that auto-rewriting
# "risks breaking a valid but unusual import." That reasoning holds for LOW-
# confidence matches, but a live run showed the SAME violation surviving
# THREE full ladder escalations (base model through the strongest configured
# model) because it's a mechanical habit (appending a redundant .js extension
# in a CommonJS project), not a reasoning-capability gap — no amount of model
# escalation fixes a training-data habit. When enabled, auto-apply is scoped
# conservatively to address the original safety concern: (1) only fires on
# HIGH-confidence matches (token-overlap score >= 2, stricter than the >0
# threshold used for merely suggesting), (2) only rewrites files the CURRENT
# story actually owns (technicalNotes.files, the same boundary scope-guard
# already enforces) — never a file outside this attempt's own scope, (3) only
# replaces the exact broken specifier text, preserving original quote style.
# Returns 0 if all relative imports resolve (or all were auto-fixed). Returns
# 1 and sets VERIFICATION_FAILURE with a suggestion for any that remain broken.
run_relative_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_RELATIVE_IMPORTS:-false}"

    local owned_files_json="[]"
    if [ -n "$story_id" ] && [ "$auto_fix" = "true" ]; then
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
    fi

    local result
    result=$(python3 - "$project_root" "$auto_fix" "$owned_files_json" << 'PYEOF'
import os, re, sys, json

project_root = sys.argv[1]
auto_fix = sys.argv[2] == 'true'
owned_files = set(os.path.normpath(os.path.join(project_root, f) if not os.path.isabs(f) else f)
                   for f in json.loads(sys.argv[3]))
SOURCE_EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')
IMPORT_RE = re.compile(r"from\s+['\"](\.[^'\"]*)['\"]|require\(\s*['\"](\.[^'\"]*)['\"]\s*\)")

def resolves(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return True
    for ext in SOURCE_EXTS:
        if os.path.isfile(candidate + ext):
            return True
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return True
    # TypeScript ESM: `import './foo.js'` is valid TS and resolves to `foo.ts`
    if spec.endswith('.js'):
        ts_base = os.path.normpath(os.path.join(base_dir, spec[:-3]))
        for ts_ext in ('.ts', '.tsx'):
            if os.path.isfile(ts_base + ts_ext):
                return True
    return False

def tokenize(path):
    return set(re.split(r'[^a-zA-Z0-9]+', path.lower())) - {''}

def is_test_file(path):
    return bool(re.search(r'\.(test|spec)\.[a-zA-Z0-9]+$', path))

# Candidate pool for suggestions EXCLUDES test files. Root cause of a live-run
# defect: an implementation file and its test sibling (client.ts / client.test.ts)
# always tie on token overlap ({"skyscanner","client"} matches both equally) —
# without this exclusion, the suggestion algorithm can non-deterministically
# recommend the TEST file as "the module to import", which is never correct
# for application code and actively misleads the retry.
all_source_files = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if fname.endswith(SOURCE_EXTS) and not is_test_file(fname):
            all_source_files.append(os.path.relpath(os.path.join(root, fname), project_root))

broken = []
auto_fixed = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if not fname.endswith(SOURCE_EXTS):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue
        fixed_content = content
        file_changed = False
        for m in IMPORT_RE.finditer(content):
            spec = next((g for g in m.groups() if g), None)
            if not spec:
                continue
            if resolves(root, spec):
                continue
            spec_tokens = tokenize(spec)
            best = None
            best_score = 0
            for cand in all_source_files:
                cand_tokens = tokenize(cand)
                score = len(spec_tokens & cand_tokens)
                if score > best_score:
                    best_score = score
                    best = cand
            rel_fpath = os.path.relpath(fpath, project_root)
            if best and best_score > 0:
                best_abs = os.path.join(project_root, best)
                rel_from_importer = os.path.relpath(best_abs, root)
                if not rel_from_importer.startswith('.'):
                    rel_from_importer = './' + rel_from_importer
                # Strip the source extension — TS/JS import specifiers omit it
                for ext in SOURCE_EXTS:
                    if rel_from_importer.endswith(ext):
                        rel_from_importer = rel_from_importer[: -len(ext)]
                        break
                suggestion = f" Did you mean '{rel_from_importer}'? (found at {best})"
            else:
                suggestion = ""
                rel_from_importer = None

            can_auto_fix = (
                auto_fix
                and rel_from_importer
                and best_score >= 2
                and os.path.normpath(fpath) in owned_files
            )
            if can_auto_fix:
                for quote in ("'", '"'):
                    old_spec_quoted = f"{quote}{spec}{quote}"
                    if old_spec_quoted in fixed_content:
                        fixed_content = fixed_content.replace(
                            old_spec_quoted, f"{quote}{rel_from_importer}{quote}"
                        )
                        file_changed = True
                        auto_fixed.append(f"{rel_fpath}: '{spec}' -> '{rel_from_importer}'")
                        break
            else:
                broken.append(f"{rel_fpath}: imports '{spec}' which does not exist.{suggestion}")

        if file_changed:
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(fixed_content)

if broken:
    print("BROKEN")
    for line in broken:
        print(line)
else:
    print("OK")
for line in auto_fixed:
    print("AUTOFIXED:" + line)
PYEOF
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [relative-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)

    # Root cause fix (found live, 2026-07-11, tier3-travel-app run): the
    # broken import's IMPORTER file (not just the corrected-path suggestion)
    # can belong to a DIFFERENT, already-completed sibling story —
    # scope-guard correctly locks it read-only for the current story, so
    # "fix the import path" is structurally impossible for this story to do.
    # Deterministic checks skip the failure-analyst (a cost-efficiency
    # optimization), so they never got a chance to register a sibling
    # escalation the way an LLM-diagnosed cross-story defect would — this
    # burned all 8 attempts on SKY-003-test, which was told every retry to
    # fix a broken import in cli.ts, a file owned by the already-completed
    # SKY-003-impl. Detect this and register the SAME escalation file
    # resolve_escalation() already knows how to consume (it already runs at
    # the top of every retry, see its call site's own docstring), instead of
    # retrying the current story against a fix it structurally cannot apply.
    if [ -n "$story_id" ]; then
        local _first_broken_file
        _first_broken_file=$(echo "$details" | head -1 | sed -E 's/^([^:]+):.*/\1/')
        if [ -n "$_first_broken_file" ]; then
            local _owns_file
            _owns_file=$(jq -r --arg id "$story_id" --arg f "$_first_broken_file" \
                '.stories[] | select(.id == $id) | (.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "false")
            if [ "$_owns_file" != "true" ]; then
                # BUG B FIX (found live, 2026-07-12, tier3-travel-app run): this
                # lookup used to scan ALL stories with no deprecated-status
                # filter and take the FIRST array match — a split PARENT marked
                # deprecated (but still carrying its ORIGINAL pre-split combined
                # technicalNotes.files, e.g. SKY-003 listing both cli.ts AND
                # cli.test.ts) commonly appears BEFORE its active child
                # (SKY-003-impl) in the stories array, so the escalation got
                # misattributed to the dead parent instead of the real,
                # already-completed active owner. Exclude deprecated stories,
                # and prefer a same-split sibling (same specification.createdFrom
                # as the current story) over any other match — mirroring the
                # SAME two-tier preference resolve_escalation() already uses
                # when it later consumes this escalation.
                local _self_parent
                _self_parent=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .specification.createdFrom // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                local _owner_id
                _owner_id=$(jq -r --arg self "$story_id" --arg f "$_first_broken_file" --arg parent "$_self_parent" \
                    '[.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any) | select(($parent != "") and .specification.createdFrom == $parent)][0].id
                     // [.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any)][0].id
                     // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                if [ -n "$_owner_id" ]; then
                    local _first_broken_detail
                    _first_broken_detail=$(echo "$details" | head -1)
                    mkdir -p "${PROJECT_ROOT}/.epam/escalations"
                    jq -n --arg tf "$_first_broken_file" \
                        --arg diag "Relative import in ${_first_broken_file} does not resolve to a real file (detected by deterministic check while implementing ${story_id})." \
                        --arg fix "$_first_broken_detail" \
                        '{targetFile: $tf, diagnosis: $diag, requiredFix: $fix}' \
                        > "${PROJECT_ROOT}/.epam/escalations/${story_id}.json"
                    log "  [relative-import-check] Broken import lives in ${_first_broken_file}, owned by ${_owner_id} (not ${story_id}) — registered sibling escalation instead of retrying an impossible fix"
                fi
            fi
        fi
    fi

    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA relative import does not resolve to a real file — this will fail immediately when the test suite runs. Fix the import path before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Relative import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_named_import_check <project_root> <output_file> [story_id]
# Deterministic detection (same shape as run_relative_import_check above) of a
# named import whose identifier doesn't actually exist among the target
# file's exports — even though the FILE PATH itself resolves correctly.
#
# Root cause this targets: a live run burned a story's ENTIRE ladder
# escalation (8 attempts, ending on the strongest configured model, $0.25)
# on `import { SkyScannerClient } from './client'` when the real export is
# `SkyscannerClient` (one-character casing difference) — and never converged
# because the failure-analyst MISDIAGNOSED it as a default-vs-named export
# mismatch (it wasn't; the class is correctly a named export, just spelled
# differently). Every retry, including the strongest model, "fixed" the
# wrong thing because the diagnosis guiding it was wrong. A deterministic
# check that names the exact real export (case-insensitive match) removes
# the misdiagnosis risk entirely — no model judgment involved.
#
# Fully generic — no hardcoded class/identifier names, no project-specific
# knowledge. Parses exports via regex (export class/function/const/let/var/
# interface/type/enum Name, and export { A, B as C } lists) and named imports
# via the same import-statement regex as run_relative_import_check, then
# checks each imported identifier is actually in the target's export set.
# Suggests the closest case-insensitive match when one exists (the exact bug
# shape found live), consistent with relative-import-check's "Did you mean
# X?" pattern.
#
# Auto-apply (opt-in via EPAM_AUTO_FIX_NAMED_IMPORTS=true, default OFF, same
# conservative design as relative-import-check's auto-fix): only fires when
# there is EXACTLY ONE case-insensitive match among the target's real
# exports (unambiguous), and only rewrites files the current story owns.
#
# Returns 0 if all named imports resolve to a real export (or none found).
# Returns 1 and sets VERIFICATION_FAILURE with a suggestion otherwise.
run_named_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_NAMED_IMPORTS:-false}"

    # owned_files is now always resolved when a story_id is given (previously
    # gated behind auto_fix=true, so it was only ever computed for auto-fix
    # ELIGIBILITY, never for scoping which findings BLOCK the current story).
    # Root cause this fixes (found live, 2026-07-09/10, tier3-travel-app run):
    # this check walks the ENTIRE project tree, so a pre-existing broken
    # import in a file the CURRENT story doesn't own (e.g. SKY-003-impl's
    # cli.ts importing a type SKY-002-impl's client.ts never exported)
    # permanently blocked an unrelated story (SKY-002-test, which owns only
    # client.test.ts and is scope-guarded from ever touching cli.ts) —
    # exhausting all 8 retries on a bug it was structurally incapable of
    # fixing. has_story_context distinguishes "we know what this story owns,
    # scope blocking to that" from "no story_id given, preserve old global
    # behavior" (e.g. a caller with no per-story context at all).
    local owned_files_json="[]"
    local has_story_context="false"
    if [ -n "$story_id" ]; then
        has_story_context="true"
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
    fi

    local result
    result=$(python3 - "$project_root" "$auto_fix" "$owned_files_json" "$has_story_context" << 'PYEOF'
import os, re, sys, json

project_root = sys.argv[1]
auto_fix = sys.argv[2] == 'true'
owned_files = set(os.path.normpath(os.path.join(project_root, f) if not os.path.isabs(f) else f)
                   for f in json.loads(sys.argv[3]))
has_story_context = sys.argv[4] == 'true'
SOURCE_EXTS = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')

IMPORT_RE = re.compile(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['\"](\.[^'\"]*)['\"]")
EXPORT_DECL_RE = re.compile(
    r"export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)"
)
EXPORT_LIST_RE = re.compile(r"export\s*\{([^}]*)\}(?!\s*from)")

def resolves(base_dir, spec):
    candidate = os.path.normpath(os.path.join(base_dir, spec))
    if os.path.isfile(candidate):
        return candidate
    for ext in SOURCE_EXTS:
        if os.path.isfile(candidate + ext):
            return candidate + ext
        if os.path.isfile(os.path.join(candidate, 'index' + ext)):
            return os.path.join(candidate, 'index' + ext)
    return None

_export_cache = {}
def get_exports(fpath):
    if fpath in _export_cache:
        return _export_cache[fpath]
    try:
        with open(fpath, encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except OSError:
        _export_cache[fpath] = set()
        return set()
    names = set(EXPORT_DECL_RE.findall(content))
    for group in EXPORT_LIST_RE.findall(content):
        for item in group.split(','):
            item = item.strip()
            if not item:
                continue
            # `export { A as B }` — B is the externally-visible name
            parts = re.split(r'\s+as\s+', item)
            names.add(parts[-1].strip())
    _export_cache[fpath] = names
    return names

broken = []
out_of_scope = []
auto_fixed = []
for root, dirs, files in os.walk(project_root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', '.git', '__pycache__', '.venv', '.contracts')]
    for fname in files:
        if not fname.endswith(SOURCE_EXTS):
            continue
        fpath = os.path.join(root, fname)
        try:
            with open(fpath, encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except OSError:
            continue
        fixed_content = content
        file_changed = False
        for m in IMPORT_RE.finditer(content):
            names_raw, spec = m.group(1), m.group(2)
            target = resolves(root, spec)
            if not target:
                continue  # a broken PATH is run_relative_import_check's job, not this one
            exports = get_exports(target)
            rel_fpath = os.path.relpath(fpath, project_root)
            for raw_name in names_raw.split(','):
                raw_name = raw_name.strip()
                if not raw_name:
                    continue
                # `import { A as B }` — A is the identifier that must exist in the target
                imported_name = re.split(r'\s+as\s+', raw_name)[0].strip()
                if imported_name in exports:
                    continue
                case_matches = [e for e in exports if e.lower() == imported_name.lower() and e != imported_name]
                if len(case_matches) == 1:
                    suggestion = f" Did you mean '{case_matches[0]}'? (exported from {os.path.relpath(target, project_root)})"
                else:
                    suggestion = ""

                can_auto_fix = auto_fix and len(case_matches) == 1 and os.path.normpath(fpath) in owned_files
                if can_auto_fix:
                    # Whole-file word-boundary replace — the wrong identifier is
                    # typically used both in the import AND at call sites (the
                    # exact live bug: `import { SkyScannerClient }` AND
                    # `new SkyScannerClient()` both had the typo). Patching only
                    # the import line would leave usage sites referencing a now-
                    # undefined name — a different but equally broken result.
                    correct_name = case_matches[0]
                    pattern = re.compile(r'\b' + re.escape(imported_name) + r'\b')
                    new_content = pattern.sub(correct_name, fixed_content)
                    if new_content != fixed_content:
                        fixed_content = new_content
                        file_changed = True
                        auto_fixed.append(f"{rel_fpath}: '{imported_name}' -> '{correct_name}'")
                if not can_auto_fix:
                    line = f"{rel_fpath}: imports '{imported_name}' from '{spec}' which is not exported there.{suggestion}"
                    # Root cause this scopes (found live, 2026-07-09/10): a
                    # pre-existing broken import in a file the CURRENT story
                    # doesn't own (has_story_context=true and fpath not in
                    # owned_files) permanently blocked an UNRELATED story that
                    # is structurally incapable of fixing it (scope-guard
                    # prevents it from ever touching that file) — exhausting
                    # all retries on a bug that was never this story's to fix.
                    # Only block the CURRENT story on findings in files it
                    # actually owns; report everything else as non-blocking
                    # visibility so the information isn't silently lost.
                    if has_story_context and os.path.normpath(fpath) not in owned_files:
                        out_of_scope.append(line)
                    else:
                        broken.append(line)

        if file_changed:
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(fixed_content)

for line in out_of_scope:
    print("OUT_OF_SCOPE:" + line)
if broken:
    print("BROKEN")
    for line in broken:
        print(line)
else:
    print("OK")
for line in auto_fixed:
    print("AUTOFIXED:" + line)
PYEOF
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [named-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    # Findings in files this story doesn't own are surfaced (visibility) but
    # never block this story's own turn — see the Python block's own comment
    # for the live defect this fixes (an unrelated story permanently blocked
    # by a bug it was structurally incapable of fixing).
    local out_of_scope_lines
    out_of_scope_lines=$(echo "$result" | grep "^OUT_OF_SCOPE:" || true)
    if [ -n "$out_of_scope_lines" ]; then
        while IFS= read -r _oos_line; do
            [ -z "$_oos_line" ] && continue
            warning "  [named-import-check] Broken import outside this story's scope (not blocking): ${_oos_line#OUT_OF_SCOPE:}"
        done <<< "$out_of_scope_lines"
    fi
    result=$(echo "$result" | grep -v "^OUT_OF_SCOPE:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA named import does not exist as an export in its target file — this will fail immediately when the test suite runs (the model likely misspelled/mis-cased an identifier, not a default-vs-named export issue). Fix the identifier name before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Named import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_external_verification <story_id> <output_file>
# Runs the project test suite externally after the agent writes files.
# This keeps the agent loop short (write-only) while still enforcing AC tests.
# Returns 0 on pass. On failure, appends a ## Verification Failure section
# to output_file so the retry prompt includes the actual test output.
# DETERMINISTIC_CHECK_FAILURE distinguishes "a deterministic pre-test check found a
# known, precisely-described violation" (relative-import-check, mock-completeness-
# check) from "the actual test suite failed" (needs an LLM to diagnose). The former
# never needed an LLM call to know what's wrong — the check's own message already
# names the exact fix — so the retry loop skips run_failure_analyst's gate-model
# call for these and doesn't spend ladder-escalation budget on them either (see
# the retry loop inside implement_story, below).
VERIFICATION_FAILURE=""
DETERMINISTIC_CHECK_FAILURE=0
run_external_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    VERIFICATION_FAILURE=""
    DETERMINISTIC_CHECK_FAILURE=0

    # Vendor-dir integrity check runs FIRST, before anything else in this
    # function (including run_dependency_check's own sanctioned writes to the
    # same directories) — so it only ever attributes a change to THIS story's
    # own agent turn, never to a later legitimate install. Runs regardless of
    # whether a test command is configured (tampering here could poison a
    # LATER story sharing the same vendor dirs even if this story has no
    # tests of its own). No-op when no vendorDirs are configured.
    #
    # BUG (caught before ever shipping live, 2026-07-07 — found by re-reading
    # the code under scrutiny, not by a live run): the original version
    # returned 1 on tampering BEFORE calling _vendor_unlock, meaning the vendor
    # dirs would stay chmod -R a-w'd (read-only) PERMANENTLY the very first
    # time tampering was ever caught — breaking every subsequent retry's own
    # legitimate run_dependency_check installs, and every later story in the
    # whole run, since nothing else ever unlocks it. Fixed: unlock ALWAYS runs
    # regardless of the check's result; only the return code differs.
    local _vendor_check_rc=0
    if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
        run_vendor_integrity_check "$PROJECT_ROOT" "$output_file" || _vendor_check_rc=1
    fi
    _vendor_unlock "$PROJECT_ROOT"
    if [ "$_vendor_check_rc" -ne 0 ]; then
        warning "  [vendor-guard] Vendor directory tampering detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Run any reviewed dynamic tools now, in this genuinely unlocked window —
    # see run_dynamic_tools_in_unlocked_window()'s own docstring for the
    # live defect this fixes (a dependency-installing dynamic tool could
    # never succeed while the agent's own turn held vendor dirs locked).
    run_dynamic_tools_in_unlocked_window "$PROJECT_ROOT" "$output_file"

    # Read optional testCommand from PRD story.technicalNotes
    local test_cmd
    test_cmd=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.testCommand // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # Fall back to npm test if package.json has a test script — but only for
    # stories that actually own a test file. Without this guard, a scaffold
    # story whose only job is writing package.json (with a required
    # scripts.test entry, per its own ACs) would trip external verification
    # the moment it does its job correctly: npm test then fails because no
    # test files exist ANYWHERE yet (true on the very first scaffold story),
    # the failure-analyst misdiagnoses "missing test files" and tries to
    # create one, and the scope-guard correctly blocks that write since the
    # story never declared ownership of any .test.ts/.spec.ts file — a
    # structurally guaranteed infinite retry loop, confirmed live 2026-07-08
    # on SKY-001A (package.json-only story, retries 0-2 all hit the same
    # "no test files found" diagnosis before HEALING_BROKEN fired each time).
    if [ -z "$test_cmd" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
        local has_test
        has_test=$(jq -r '.scripts.test // ""' "$PROJECT_ROOT/package.json" 2>/dev/null || echo "")
        local _owns_test_file
        _owns_test_file=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | (.technicalNotes.files // []) | map(select(test("\\.(test|spec)\\.[jt]sx?$"))) | length' \
            "$prd_target" 2>/dev/null || echo 0)
        if [ -n "$has_test" ] && [ "${_owns_test_file:-0}" -gt 0 ]; then
            # Derive owned test file paths so the command runs ONLY those files,
            # preventing failures in other stories' test files from contaminating
            # this story's verification result (found live: a broken cli.test.ts
            # caused the server test story to fail even though server.test.ts
            # passed 15/15 on its own). Extract paths from technicalNotes.files,
            # filter to test/spec files, and append them to the base test command
            # from scripts.test. Most runners (vitest, jest, mocha, tap) accept
            # file paths as trailing positional arguments — no runner-specific
            # flags needed. Falls back to full "npm test" if no files are found.
            local _owned_test_files
            _owned_test_files=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | (.technicalNotes.files // [])[] | select(test("\\.(test|spec)\\.[jt]sx?$"))' \
                "$prd_target" 2>/dev/null | tr '\n' ' ' | xargs)
            if [ -n "$_owned_test_files" ]; then
                test_cmd="npm test -- $_owned_test_files"
            else
                test_cmd="npm test"
            fi
        fi
    fi

    [ -z "$test_cmd" ] && return 0  # no test command configured — skip

    # Exposed for run_failure_analyst's tool_creation gate (added 2026-07-12):
    # a dynamic tool that independently re-invokes this SAME test command is a
    # duplicate-verification risk, not a mechanical fixup — see that check for
    # the live incident this closes.
    LAST_TEST_CMD="$test_cmd"
    export LAST_TEST_CMD

    # Sanitize the child-process environment for npm install/test (added
    # 2026-07-11, after a live test failure no amount of model escalation
    # could ever fix): claude.sh inherits the orchestrator's OWN .env
    # (Anthropic/OpenRouter/MiniMax keys, etc — sourced by
    # run-agent-orchestration.sh) all the way down to whatever test command
    # runs INSIDE the generated app. Root cause found live: epam-cli's own
    # .env happens to define RAPIDAPI_KEY (a real credential) — the exact
    # env var name a generated SkyscannerClient story checked as a
    # constructor fallback. Every retry of its "should throw when no API key
    # provided" test failed identically because the constructor legitimately
    # found a REAL key in the inherited environment and didn't throw — the
    # generated app's code was correct the entire time; the test's
    # environment was contaminated by a secret that belongs to the
    # ORCHESTRATOR, not the app under test. No model escalation or skill
    # guidance can ever fix a test that's structurally unwinnable this way.
    # Strip every var name defined in the orchestrator's own .env from the
    # install/test subprocess environment so the generated app is tested in
    # real isolation.
    #
    # Deliberately uses bash's own `unset` builtin, NOT `env -u` — this
    # environment's PATH shadows the real GNU coreutils `env` with an
    # unrelated PATH-setup shell shim at ~/.local/bin/env that doesn't
    # implement `-u` (confirmed live: `env -u FOO bash -c '...'` silently
    # produced none of the command's effects). A prefixed `unset` string has
    # no dependency on any external binary and can't be shadowed this way.
    local _orch_env_file="$(dirname "$AUTOMATION_DIR")/.env"
    local _orch_env_unset_prefix=""
    if [ -f "$_orch_env_file" ]; then
        while IFS='=' read -r _envkey _envval; do
            [[ "$_envkey" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
            _orch_env_unset_prefix="${_orch_env_unset_prefix}unset ${_envkey}; "
        done < <(grep -v '^[[:space:]]*#' "$_orch_env_file" | grep -v '^[[:space:]]*$')
    fi

    # Scope guard: restore .ts files outside this story's declared scope from
    # the pre-run snapshot. Agents frequently use Bash (not WriteFile) to write
    # files, bypassing tool-level guards. This restores them before npm test so
    # a story's verification only reflects the files it actually owns.
    local _sg_backup="${SCOPE_GUARD_BACKUP_DIR:-}"
    if [ -n "$_sg_backup" ] && [ -d "$_sg_backup" ]; then
        # Build declared set (absolute paths)
        local -A _sg_decl
        while IFS= read -r _f; do
            [ -n "$_f" ] && _sg_decl["$_f"]=1
        done < <(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
            "$prd_target" 2>/dev/null)

        if [ ${#_sg_decl[@]} -gt 0 ]; then
            local _sg_restored=0
            while IFS= read -r _rel; do
                local _abs="$PROJECT_ROOT/$_rel"
                # Skip if this file is in the story's declared scope
                [ -n "${_sg_decl[$_abs]+x}" ] && continue
                local _bak="$_sg_backup/$_rel"
                if [ -f "$_bak" ]; then
                    cp "$_bak" "$_abs" 2>/dev/null && ((_sg_restored++))
                fi
            done < <(find "$_sg_backup" -type f | sed "s|^$_sg_backup/||")
            if [ "$_sg_restored" -gt 0 ]; then
                warning "  [scope-guard] Restored $_sg_restored out-of-scope .ts file(s) before verification (agent wrote outside ${story_id}'s declared scope)"
            fi
        fi
    fi

    # Ensure node_modules exist in the worktree — git worktrees don't inherit gitignored dirs.
    # Without this, npm test fails with exit 127 (vitest binary not found).
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the entire claude.sh subprocess with the LAST log line
    # being "Installing dependencies..." — the actual agent call had already
    # finished in 11s (confirmed via the per-story result.json timestamp),
    # but this npm install (registry/network dependent, no timeout) silently
    # consumed the rest of the 600s budget with zero further signal. Same
    # class of bug as the npm test / git-operation hangs fixed earlier this
    # session — this was the third unbounded external command, missed then.
    if [ -f "$PROJECT_ROOT/package.json" ] && [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        log "  Installing dependencies (node_modules missing in worktree)..."
        local _install_timeout="${EPAM_INSTALL_TIMEOUT_SECS:-180}"
        # Capture $? directly from the command substitution — NOT via
        # `if ! (cmd); then`, which collapses any non-zero exit code (124
        # included) into a plain boolean 1 through the `!` negation, making
        # exit 124 indistinguishable from a normal failure (this exact bug
        # shipped in the first version of this fix and was caught by its own
        # test suite: the TIMED OUT branch never fired).
        local _install_output
        _install_output=$(cd "$PROJECT_ROOT" && timeout "$_install_timeout" bash -c "${_orch_env_unset_prefix}npm install --silent" 2>&1)
        local _install_rc=$?
        if [ "$_install_rc" -eq 124 ]; then
            warning "  npm install TIMED OUT after ${_install_timeout}s — test may still fail"
        elif [ "$_install_rc" -ne 0 ]; then
            warning "  npm install failed — test may still fail"
        fi
    fi

    run_dependency_check "$PROJECT_ROOT"

    # Fail fast on a broken relative import BEFORE running the (often
    # multi-minute) test command — this recurring failure class was
    # previously only discoverable by waiting for a full test run, then
    # having the failure analyst re-diagnose the same "wrong import path"
    # pattern from scratch every retry (validated live: baseline model call
    # guessed './skyscanner-client' when the real file was
    # './skyscanner/client'). Skip test execution entirely if found.
    if ! run_relative_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [relative-import-check] Broken import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on a named import whose identifier doesn't exist in its
    # target's exports — same rationale as relative-import-check above, but
    # for a different failure shape (file path resolves fine, the imported
    # NAME is wrong/mis-cased). Root cause: a live run burned a story's
    # entire ladder escalation on this exact bug because the failure-analyst
    # misdiagnosed it as a default-vs-named export mismatch.
    if ! run_named_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [named-import-check] Non-existent named import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on an incomplete vi.mock() factory BEFORE running the test
    # command — same rationale as relative-import-check above, targeting the
    # other recurring live failure class (mock factory missing a real method,
    # e.g. SKY-004's SkyscannerClient mock omitting `search`).
    if ! run_mock_completeness_check "$PROJECT_ROOT" "$output_file"; then
        warning "  [mock-completeness-check] Incomplete vi.mock() factory detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    log "  Running external verification: $test_cmd"
    local test_output
    local test_exit=0
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the ENTIRE claude.sh subprocess with zero diagnostic
    # output after this exact command hung — the story's own implementation
    # had already succeeded; `npm test` (vitest) itself never returned. The
    # classic cause for a server story: a test calls app.listen() without a
    # matching server.close() in afterAll, so Node's event loop never drains
    # and the test process hangs forever. Without a bound here, that failure
    # mode silently consumes the entire watchdog budget with no signal at all
    # about which command was actually stuck. EPAM_TEST_TIMEOUT_SECS default
    # (300s) is comfortably under the lowest story-level watchdog ceiling
    # (600s for low-effort stories) so this always fires first and gives a
    # clear, actionable diagnosis instead of a generic outer timeout.
    local _test_timeout="${EPAM_TEST_TIMEOUT_SECS:-300}"
    test_output=$(cd "$PROJECT_ROOT" && timeout "$_test_timeout" bash -c "${_orch_env_unset_prefix}${test_cmd}" 2>&1) || test_exit=$?

    if [ "$test_exit" -eq 124 ]; then
        warning "External verification TIMED OUT for $story_id after ${_test_timeout}s (test command: $test_cmd)"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure — TIMEOUT\n\nThe orchestrator ran `%s` after your files were written and it did NOT complete within %ds — it hung. The most common cause for a server story: a test calls app.listen() (or an equivalent server-start call) without closing it (server.close()) in an afterAll/afterEach hook, so the test process never exits. Check every test that starts a server or opens a long-lived resource (timers, sockets, watchers) and ensure it is torn down.\n\n```\n%s\n```\n' \
            "$test_cmd" "$_test_timeout" "${test_output:0:4000}")
        {
            echo ""
            echo "=== External verification TIMED OUT after ${_test_timeout}s ==="
            echo "$test_output" | head -60
        } >> "$output_file"
        return 1
    fi

    if [ "$test_exit" -ne 0 ]; then
        warning "External verification failed for $story_id (exit $test_exit)"
        # Include both the head AND tail of test output so errors that appear at
        # the end (e.g. "Unhandled Rejection" summaries emitted after per-test
        # results) reach the failure analyst — a head-only truncation causes
        # misdiagnosis when the real root cause is in the final lines
        # (found live: analyst diagnosed "missing env var" from truncated head
        # while the real cause — async main() rejection — was in the tail).
        local _test_head="${test_output:0:2000}"
        local _test_tail=""
        if [ "${#test_output}" -gt 2000 ]; then
            _test_tail=$(printf '%s' "$test_output" | tail -c 2000)
            _test_tail="
[... output truncated ...]
$_test_tail"
        fi
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran `%s` after your files were written and it failed (exit code %d). Fix the code so the tests pass.\n\n```\n%s%s\n```\n' \
            "$test_cmd" "$test_exit" "$_test_head" "$_test_tail")
        {
            echo ""
            echo "=== External verification failed (exit $test_exit) ==="
            echo "$test_output" | head -60
        } >> "$output_file"
        return 1
    fi

    success "External verification passed for $story_id"
    return 0
}

# run_tsc_verification <story_id> <output_file>
# Runs `tsc --noEmit` inside the retry loop (not after it) so a TypeScript
# compile failure re-enters the same failure-analyst/InferenceLadder path as
# any other verification failure, instead of silently exiting the phase with
# zero retries. The one-and-done exit at the outer story_tsc_gate() in
# run-agent-orchestration.sh remains only as a defensive last-resort check —
# this function is what actually gives tsc failures a chance to self-heal.
# Returns 0 (pass or skipped) or 1 (tsc errors found).
run_tsc_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    [ "${SKIP_STORY_TSC_GATE:-0}" = "1" ] && return 0
    [ ! -f "$PROJECT_ROOT/tsconfig.json" ] && return 0

    # Skip when no .ts source files exist yet (scaffold phase creates structure but no source)
    local _ts_count
    _ts_count=$(find "$PROJECT_ROOT/src" -name "*.ts" 2>/dev/null | grep -v node_modules | wc -l)
    [ "$_ts_count" -eq 0 ] && return 0

    # NOTE: this gate used to skip test-engineer-role stories entirely ("they
    # extend existing files, not create TS modules"). That reasoning doesn't
    # hold: a .test.ts file is compiled/type-checked by tsc exactly like any
    # other .ts file, and a syntax error inside one is exactly what `tsc
    # --noEmit` catches. Removed 2026-07-12 after a live run showed EVERY
    # syntax-class error observed (unterminated strings, mismatched parens, a
    # stray-token typo) was in a .test.ts file written by a test-engineer
    # story — precisely the case this skip disabled the check for, forcing
    # each one through a full external `npm test` run + FailureAnalyst LLM
    # call + model-tier escalation to catch what tsc would have caught for
    # free in the same turn.

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"

    local _tsc_output _tsc_exit=0
    _tsc_output=$(cd "$PROJECT_ROOT" && "$_node_cmd" ./node_modules/.bin/tsc --noEmit 2>&1) || _tsc_exit=$?

    if [ "$_tsc_exit" -ne 0 ]; then
        # Brownfield: a large existing repo can have pre-existing tsc errors in
        # files no story ever touches (live, 2026-07-22 — Redis/Stripe/OTel type
        # declarations, a jsonwebtoken signature mismatch, unrelated to AMSD-1820's
        # Mozio/promo-discount work). Whole-project `tsc --noEmit` fails identically
        # for every story regardless of what it changed, and no amount of model
        # escalation can fix errors in files the story never touches — confirmed by
        # HealingBroken firing 4+ times on the exact same unrelated diagnosis before
        # exhausting all 8 retries. Fix: diff against a baseline error set captured
        # from JIRA_BASELINE_BRANCH (the same baseline review-ranger/mutant-hunter
        # already use) — only fail on errors NEW relative to that baseline, i.e.
        # errors this story's own changes actually introduced.
        local _new_errors="$_tsc_output"
        local _baseline_sha_file="$LOG_DIR/phase-baseline-sha.txt"
        if [ -f "$_baseline_sha_file" ]; then
            local _baseline_sha
            _baseline_sha=$(tr -d '[:space:]' < "$_baseline_sha_file")
            if [ -n "$_baseline_sha" ]; then
                local _baseline_cache="$LOG_DIR/tsc-baseline-errors-${_baseline_sha:0:12}.txt"
                if [ ! -f "$_baseline_cache" ]; then
                    local _wt_dir
                    _wt_dir=$(mktemp -d)
                    if git -C "$PROJECT_ROOT" worktree add --detach "$_wt_dir" "$_baseline_sha" >/dev/null 2>&1; then
                        # node_modules is gitignored — `worktree add` only checks out
                        # tracked files, so it's absent in the new worktree. Without
                        # it, tsc silently fails to run (module not found) and the
                        # baseline cache ends up empty, making every current-state
                        # error look "new" — the exact opposite of this fix's intent.
                        ln -s "$PROJECT_ROOT/node_modules" "$_wt_dir/node_modules" 2>/dev/null || true
                        ( cd "$_wt_dir" && "$_node_cmd" ./node_modules/.bin/tsc --noEmit 2>&1 \
                            | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+' ) > "$_baseline_cache" 2>/dev/null || true
                        git -C "$PROJECT_ROOT" worktree remove --force "$_wt_dir" >/dev/null 2>&1 || true
                    fi
                    rm -rf "$_wt_dir" 2>/dev/null || true
                fi
                if [ -f "$_baseline_cache" ]; then
                    # Extract the same "<file>(<line>,<col>): error <CODE>" key from
                    # the current output, then keep only lines whose key is absent
                    # from the baseline set — genuinely new errors this story introduced.
                    _new_errors=$(echo "$_tsc_output" | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+.*$' \
                        | grep -vFf "$_baseline_cache" || true)
                fi
            fi
        fi

        if [ -z "$(echo "$_new_errors" | tr -d '[:space:]')" ]; then
            success "  [tsc-verify] $story_id: tsc --noEmit has only pre-existing baseline errors — none introduced by this story"
            return 0
        fi

        warning "  [tsc-verify] $story_id: TypeScript errors — feeding into retry loop"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran `tsc --noEmit` after your files were written and it failed (exit code %d). Fix the type errors so tsc exits 0.\n\n```\n%s\n```\n' \
            "$_tsc_exit" "${_new_errors:0:4000}")
        {
            echo ""
            echo "=== tsc --noEmit failed (exit $_tsc_exit) — new errors introduced by this story ==="
            echo "$_new_errors" | head -60
        } >> "$output_file"
        return 1
    fi

    success "  [tsc-verify] $story_id: tsc --noEmit passed"
    return 0
}


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
            # Orchestration already emitted story_start with the correct model when it
            # launched this subprocess via run_story_with_watchdog. Skip the duplicate.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_start "$story_id" "$lane" "$role" "$title" \
                    "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
            fi
            ;;
        complete)
            # Orchestration emits story_complete after the TSC gate (the authoritative
            # "story is done and types pass" signal). Skip the duplicate from claude.sh
            # for main-lane stories managed by orchestration.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_complete "$story_id" "$lane" "$title" \
                    "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
            fi
            ;;
        fail)
            "$update_script" story_fail "$story_id" "$lane" "$message" 2>/dev/null || true
            ;;
    esac
}

# run_planning_phase <story_id> <planner_model>
# Invokes the planner model with a focused planning prompt.
# Outputs a structured step-by-step execution plan as plain text on stdout.
# Uses the same SDK/CLI path as execution invocations.
run_planning_phase() {
    local story_id="$1"
    local planner_model="$2"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(get_story_title "$story_id")
    local ac
    ac=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/- /' || echo "")
    # Extract the exact output paths from technicalNotes.files — the planner must
    # use these verbatim. Without them, the planner invents paths based on convention
    # (e.g. tests/ instead of src/skyscanner/), which the executor faithfully follows
    # to the wrong location and exhausts all turns trying to recover (151K token bloat).
    local declared_files
    declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")
    # Inject dependency contracts so the planner also uses the correct READ paths.
    local plan_dep_contracts=""
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '[.stories[] | select(.id == $id) | (.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _cf="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        [ -f "$_cf" ] && plan_dep_contracts="${plan_dep_contracts}
### Contract: ${_dep_id}
$(cat "$_cf")
"
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    local planning_prompt="You are a planning agent. Produce a concise, numbered execution plan for the coding agent that will implement the following story. Output ONLY a numbered step list — no prose, no code.

Story: ${story_id} — ${title}

## Files to Create/Modify (EXACT ABSOLUTE PATHS — your plan MUST reference ONLY these paths for output steps, never invent alternatives)
${declared_files:-  (none declared)}

## Acceptance Criteria
${ac}
$([ -n "$plan_dep_contracts" ] && printf '\n## Dependency Contracts (ground-truth import paths and signatures — use these verbatim in read/import steps)\n%s\n' "$plan_dep_contracts" || true)
$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)
Produce 5-10 numbered implementation steps. Your write/create steps MUST use the exact paths listed under 'Files to Create/Modify' above. Be specific about function signatures and test requirements."

    local plan_result_file
    plan_result_file=$(mktemp /tmp/plan-${story_id}-XXXXXX.json)
    local plan_text=""

    local plan_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}"
    local plan_permissions=("--dangerously-skip-permissions" "--append-system-prompt" "$plan_constitution")
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        echo "$planning_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
            --model "$planner_model" \
            --system-prompt "$plan_constitution" \
            --output "$plan_result_file" 2>/dev/null || true
        plan_text=$(jq -r '.result // empty' "$plan_result_file" 2>/dev/null || cat "$plan_result_file" 2>/dev/null || echo "")
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${planner_model:-${ORCH_GATE_MODEL:-}}"
        if [ -n "$_orch_provider" ]; then
            plan_text=$(echo "$planning_prompt" | \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                2>/dev/null || echo "")
        fi
    fi

    rm -f "$plan_result_file"
    echo "$plan_text"
}

# review_and_correct_plan <story_id> <plan_text>
# Gate between the plan-turn and the execute-turn: catches a hallucinated file
# path/API in the plan BEFORE any code is written, using the same ground-truth
# dependency contracts (.contracts/<dep_id>.md) already proven to fix this class
# of bug for implementation prompts (see the "Spec-reality cross-check" comment
# in build_implementation_prompt()). Without this gate, run_planning_phase()'s
# output was previously injected as fixed context completely unreviewed — a
# wrong plan would be followed just as faithfully as a right one.
# Bounded to exactly ONE corrective re-plan (same "one bounded retry" pattern as
# the split-mandate gate and escalation-resolution elsewhere in this file) —
# never an unbounded loop.
# Echoes the final plan text (corrected if a fix was applied, original otherwise).
review_and_correct_plan() {
    local story_id="$1"
    local plan_text="$2"
    [ -z "$plan_text" ] && { echo "$plan_text"; return; }

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")

    # Extract declared output files — needed to catch output-path hallucinations
    # even when there are no dependency contracts to check against.
    local _review_declared_files
    _review_declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")

    local dependency_contracts=""
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        if [ -f "$_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
        fi
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    # Skip the LLM review if there are no dependency contracts AND no declared
    # output files — nothing ground-truth to check the plan against.
    if [ -z "$dependency_contracts" ] && [ -z "$_review_declared_files" ]; then
        echo "$plan_text"
        return
    fi

    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    [ -z "$_orch_provider" ] && { echo "$plan_text"; return; }

    local review_prompt="You are reviewing an implementation PLAN (not code) for story ${story_id} before any code is written.

Check: (1) does the plan reference any file path, import path, exported class/function/type name that CONTRADICTS the dependency contracts? (2) do the plan's write/create steps use the EXACT declared output paths — not invented alternatives?

Respond with ONLY a JSON object, no markdown fences:
{\"verdict\":\"ok\"} if the plan is consistent with both the contracts and the declared output paths, OR
{\"verdict\":\"mismatch\",\"corrections\":\"<one paragraph telling the planning agent exactly what to fix, citing the real path from the contract or declared files list>\"}
$([ -n "$_review_declared_files" ] && printf '\n## Declared Output Files (EXACT paths the plan MUST write to)\n%s\n' "$_review_declared_files" || true)

## Plan
${plan_text}

## Dependency Contracts (ground truth)
${dependency_contracts}"

    local review_output
    review_output=$(echo "$review_prompt" | \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${ORCH_GATE_MODEL:-}" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${ORCH_GATE_MODEL:+--model "$ORCH_GATE_MODEL"} \
        2>/dev/null || echo "")

    # Robust JSON extraction (not a flat-object regex — see the identical bug
    # fixed live in team-lead-review.sh/code-review-cycle.sh, 2026-07-07: a
    # pretty-printed or otherwise non-single-line response silently fails a
    # naive '{.*"verdict".*}' grep). raw_decode correctly parses regardless of
    # formatting/whitespace.
    local review_json
    review_json=$(echo "$review_output" | python3 -c "
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
print(json.dumps(result) if isinstance(result, dict) and 'verdict' in result else '')
" 2>/dev/null || echo "")
    [ -z "$review_json" ] && { echo "$plan_text"; return; }

    local verdict corrections
    verdict=$(echo "$review_json" | jq -r '.verdict // "ok"' 2>/dev/null || echo "ok")
    if [ "$verdict" != "mismatch" ]; then
        echo "$plan_text"
        return
    fi

    corrections=$(echo "$review_json" | jq -r '.corrections // ""' 2>/dev/null || echo "")
    warning "  PlanReview: mismatch detected for $story_id against dependency contracts — one corrective re-plan"

    local corrective_prompt="You previously produced this plan for story ${story_id}:

${plan_text}

A review found it inconsistent with the real dependency contracts. Specific correction needed:
${corrections}

Produce the CORRECTED numbered execution plan only — no prose, no code, same format as before."

    local corrected_plan
    corrected_plan=$(echo "$corrective_prompt" | \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${STORY_PLANNER_MODEL:-${ORCH_GATE_MODEL:-}}" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${STORY_PLANNER_MODEL:+--model "$STORY_PLANNER_MODEL"} \
        2>/dev/null || echo "")

    if [ -n "$corrected_plan" ]; then
        echo "$corrected_plan"
    else
        echo "$plan_text"
    fi
}

# ── Inference Ladder Coordinator ─────────────────────────────────────────────
#
# Two-layer gate that runs BEFORE each model-up event:
#
#   Layer 1 (rule-based triage, always on, zero cost):
#     Inspects raw result file and result text to classify the failure into:
#       env        — CLI crashed before any API call (raw = 0 bytes, non-zero exit)
#       capability — model ran but hit max iterations or produced no deliverables
#       quality    — deliverables exist but external tests failed
#     Class "env" immediately suppresses escalation (a stronger model won't fix it).
#
#   Layer 2 (LLM gate, opt-in via EPAM_MODEL_COORDINATOR_ENABLED=1):
#     For Class B/C failures, calls ORCH_GATE_MODEL with a structured prompt that
#     includes the failure log snippet. The gate returns:
#       escalate: yes|no        — whether to upgrade the model
#       failure_class: <class>  — refined classification
#       prompt_amendment: <txt> — optional targeted addition to the retry prompt
#     This layer distinguishes "context limit hit" (upgrade helps) from
#     "hallucination loop" (prompt amendment more effective than model upgrade).
#
# Sets globals:
#   COORDINATOR_ESCALATE        — "yes" | "no"
#   COORDINATOR_FAILURE_CLASS   — "env" | "capability" | "quality" | "unknown"
#   COORDINATOR_PROMPT_AMENDMENT — additional text to append to retry prompt, or ""

COORDINATOR_ESCALATE="yes"
COORDINATOR_FAILURE_CLASS="unknown"
COORDINATOR_PROMPT_AMENDMENT=""

# classify_failure_class <raw_file> <result_json> <exit_code>
# Layer 1: rule-based triage. Sets COORDINATOR_FAILURE_CLASS and COORDINATOR_ESCALATE.
classify_failure_class() {
    local raw_file="${1:-}"
    local result_json="${2:-}"
    local exit_code="${3:-1}"

    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"

    # Class A: environment crash — raw output is empty and exit code != 0
    local raw_size=0
    [ -f "$raw_file" ] && raw_size=$(wc -c < "$raw_file" 2>/dev/null || echo 0)
    if [ "$raw_size" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
        COORDINATOR_FAILURE_CLASS="env"
        COORDINATOR_ESCALATE="no"
        warning "  Coordinator[L1]: environment failure detected (raw=0 bytes, exit=$exit_code) — diagnosing before escalation decision"
        # Active crash diagnosis: check API key and binary health
        local _diag_ok=true
        # 1. Check epam binary is executable
        if ! command -v "${EPAM_CLI:-epam}" >/dev/null 2>&1; then
            warning "  Coordinator[Diag]: epam binary not found on PATH — check EPAM_CLI or PATH"
            _diag_ok=false
        fi
        # 2. Check OpenRouter key validity (fast: uses cached auth endpoint)
        local _or_key="${OPENROUTER_API_KEY:-${EPAM_API_KEY_OPENROUTER:-}}"
        if [ -n "$_or_key" ]; then
            local _key_status
            _key_status=$(curl -s --max-time 5 \
                "https://openrouter.ai/api/v1/auth/key" \
                -H "Authorization: Bearer $_or_key" 2>/dev/null \
                | jq -r '.data.label // "invalid"' 2>/dev/null || echo "unreachable")
            if [ "$_key_status" = "invalid" ] || [ "$_key_status" = "unreachable" ]; then
                warning "  Coordinator[Diag]: OPENROUTER_API_KEY check returned '$_key_status' — key may be expired or network is down"
                _diag_ok=false
            else
                log "  Coordinator[Diag]: OpenRouter key OK (label=$_key_status)"
            fi
        else
            warning "  Coordinator[Diag]: OPENROUTER_API_KEY is empty — provider will fail on any API call"
            _diag_ok=false
        fi
        if [ "$_diag_ok" = true ]; then
            log "  Coordinator[Diag]: binary and key are healthy — model/timeout issue; allowing escalation to retryModel"
            COORDINATOR_ESCALATE="yes"
        fi
        return
    fi

    # Class B: capability failure — "reached maximum iterations" in result
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    if echo "$result_text" | grep -qi "maximum iterations\|max.*iter"; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        # Inject a directive so the escalated model doesn't repeat the same
        # exhaustion pattern. This is a SEPARATE occurrence of the same
        # write-first-vs-read-first distinction fixed in
        # build_implementation_prompt() (found live 2026-07-23, AMSD-1820) —
        # missed here because it's a different code path (the max-iterations
        # failure classifier, not the initial prompt builder). Without this
        # brownfield branch, a story that hits this classifier gets the OLD
        # "do NOT investigate" text re-injected via ## Coordinator Guidance,
        # silently contradicting and undoing the "READ BEFORE YOU WRITE"
        # directive already shown earlier in the SAME prompt.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            COORDINATOR_PROMPT_AMENDMENT="CRITICAL: The previous attempt exhausted all available turns without creating the required deliverable. These files already exist — their real content is injected in ## Existing File Contents; do not spend turns re-reading them. Use Edit for a targeted, minimal change and act on it immediately — do not re-explore the codebase beyond what's already injected."
        else
            COORDINATOR_PROMPT_AMENDMENT="CRITICAL: The previous attempt exhausted all available turns without creating the required deliverable. Your FIRST action MUST be to call WriteFile to the exact absolute path listed under 'Files to Create/Modify' — do NOT read files, do NOT plan, do NOT investigate. Write the required file IMMEDIATELY as your very first action."
        fi
        log "  Coordinator[L1]: capability failure (max iterations) — escalation approved, write-first amendment injected"
        return
    fi

    # Class B variant: ran with tokens but no deliverables
    local tokens_out=0
    [ -f "$result_json" ] && tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$result_json" 2>/dev/null || echo 0)
    if [ "${tokens_out:-0}" -gt 100 ] && [ -z "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: capability failure (tokens consumed, no result) — escalation approved"
        return
    fi

    # Class C: quality failure — result exists, deliverables may exist, but tests failed
    # This is identified by the caller (verify_story_deliverables or run_external_verification failing)
    # If we reach here with non-empty result, it's likely quality
    if [ -n "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="quality"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: quality failure (agent ran, result produced) — escalation tentatively approved"
        return
    fi

    # Unknown: default to escalate (safe fallback)
    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"
    log "  Coordinator[L1]: unknown failure class — escalation approved (safe default)"

    # Cross-run memory check: read story-failures.jsonl for repeated patterns.
    # After 2+ consecutive env failures on the same story, suppress escalation and
    # flag it as a persistent environment problem requiring operator intervention.
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _prior_env_count
        _prior_env_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "env") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_env_count:-0}" -ge 2 ]; then
            COORDINATOR_FAILURE_CLASS="env"
            COORDINATOR_ESCALATE="no"
            warning "  Coordinator[L1]: story $story_id has ${_prior_env_count} prior env failures across runs — suppressing escalation, flagging for operator review"
        fi
        local _prior_cap_count
        _prior_cap_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "capability") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_cap_count:-0}" -ge 3 ]; then
            log "  Coordinator[L1]: story $story_id has ${_prior_cap_count} prior capability failures — story may need decomposition (too many ACs for any single invocation)"
            # Cross-run KB synthesis: emit a pattern entry after 3+ capability failures
            # so future runs benefit from the accumulated failure pattern.
            local _kb_file="$AUTOMATION_DIR/agents/KB.md"
            local _today; _today=$(date +'%Y-%m-%d')
            local _kb_entry_marker="KB-PERSIST-${story_id}"
            if [ -f "$_kb_file" ] && ! grep -q "$_kb_entry_marker" "$_kb_file" 2>/dev/null; then
                local _ac_count
                _ac_count=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | length' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "unknown")
                {
                    printf '\n## %s -- %s\n\n' "$_kb_entry_marker" "$_today"
                    printf '**Category:** orchestration\n'
                    printf '**AgentRole:** any\n'
                    printf '**Tags:** inference-ladder, story-decomposition, capability-failure\n'
                    printf '**Trigger:** cross-run-synthesis\n'
                    printf '**StoryRef:** %s\n\n' "$story_id"
                    printf 'Story %s has failed %s times with capability class (max iterations / empty output). ' "$story_id" "$_prior_cap_count"
                    printf 'It has %s ACs. Model escalation alone has not resolved this — the story likely needs to be ' "$_ac_count"
                    printf 'decomposed into smaller children (≤8 ACs each) before the next run. '
                    printf 'OpenSpec/SpecKit should split this story at Step 0 in the next pipeline run.\n'
                } >> "$_kb_file" 2>/dev/null || true
                log "  Coordinator[L1]: cross-run KB entry written for $story_id (${_prior_cap_count} capability failures)"
            fi
        fi
    fi
}

# classify_ladder_tier <story_id>
# Dynamically decides whether a story's Rung 2/3 escalation should use the
# "medium" or "high" ladder — NOT hardcoded per story ID. Reads the story's
# own recorded failure history (story-failures.jsonl, cross-run, written by
# every retry attempt) and classifies "high" only when the evidence shows
# this story has already exhausted a full retry cycle before (a real,
# measured signal — not a guess): either a prior attempt reached MAX_RETRIES,
# or the story has failed across 2+ separate watchdog/run cycles.
# Echoes "medium" or "high". No model names appear in this function.
classify_ladder_tier() {
    local story_id="$1"

    # PRD-level explicit override — a story can pin its own tier ("medium" or
    # "high") when the author already knows it's hard, bypassing the
    # historical-signal classifier below. Same override pattern as
    # .retryModel / .model / .aiProvider elsewhere in this file.
    local _prd_tier
    _prd_tier=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .ladderTier // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    case "$_prd_tier" in
        medium|high) echo "$_prd_tier"; return ;;
    esac

    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _max_attempt _cycle_count
        _max_attempt=$(jq -s -r --arg sid "$story_id" \
            '[.[] | select(.storyId == $sid) | .attempt] | max // -1' \
            "$_failures_file" 2>/dev/null || echo -1)
        # A prior cycle reaching MAX_RETRIES means it was fully exhausted once
        # already — the next cycle should not repeat the same cheap-first ramp.
        if [ "${_max_attempt:-0}" -ge "${MAX_RETRIES:-7}" ]; then
            echo "high"
            return
        fi

        # Distinct failure timestamps far apart (different watchdog/run
        # cycles) also indicate a genuinely hard story, even if no single
        # cycle hit MAX_RETRIES (e.g. it kept timing out before exhausting
        # attempts).
        _cycle_count=$(jq -r --arg sid "$story_id" \
            'select(.storyId == $sid) | .attempt' \
            "$_failures_file" 2>/dev/null | sort -u | wc -l | tr -d ' ')
        if [ "${_cycle_count:-0}" -ge 6 ]; then
            echo "high"
            return
        fi
    fi

    # Low average diagnosis groundedness is a third, purely measured signal:
    # it means the FailureAnalyst itself keeps having to guess rather than
    # cite verifiable evidence for this story's failures -- a language- and
    # bug-content-agnostic proxy for "this is a genuinely hard story",
    # computed identically for any stack from the DiagnosisGroundedness step
    # every project already runs. Threshold and minimum sample size are both
    # configurable so a low-sample-count story isn't misclassified on noise.
    local _groundedness_file="${LOG_DIR}/failure-diagnosis-groundedness.jsonl"
    if [ -f "$_groundedness_file" ]; then
        local _min_samples="${EPAM_LADDER_GROUNDEDNESS_MIN_SAMPLES:-2}"
        local _threshold="${EPAM_LADDER_GROUNDEDNESS_ESCALATION_THRESHOLD:-0.6}"
        local _avg_and_count
        _avg_and_count=$(jq -s -r --arg sid "$story_id" '
            [.[] | select(.storyId == $sid) | select(.score != null) | .score] as $scores
            | if ($scores | length) > 0
              then "\(($scores | add) / ($scores | length)) \($scores | length)"
              else "1 0"
              end
        ' "$_groundedness_file" 2>/dev/null || echo "1 0")
        local _avg_score _sample_count
        _avg_score=$(echo "$_avg_and_count" | awk '{print $1}')
        _sample_count=$(echo "$_avg_and_count" | awk '{print $2}')
        if [ "${_sample_count:-0}" -ge "$_min_samples" ] 2>/dev/null; then
            if python3 -c "exit(0 if float('${_avg_score:-1}') < float('${_threshold}') else 1)" 2>/dev/null; then
                echo "high"
                return
            fi
        fi
    fi
    echo "medium"
}

# get_model_ladder_step <current_model> [tier]
# Reads EPAM_MODEL_LADDER_<TIER> (pipe-separated "from=to" pairs) and returns
# the next model. Fully configurable — no hardcoded model names in this
# function. tier defaults to "medium"; pass "high" for the stronger ladder.
# EPAM_MODEL_LADDER (no suffix), if explicitly set, overrides BOTH tiers to
# the same ladder — an explicit opt-out of the medium/high split.
# Example:
#   export EPAM_MODEL_LADDER_MEDIUM="MiniMax-M3=zhipuai/glm-z1-32b"
#   export EPAM_MODEL_LADDER_HIGH="MiniMax-M3=deepseek/deepseek-r1"
# Returns empty string when current model is not in the ladder or no ladder is configured.
get_model_ladder_step() {
    local current_model="$1"
    local tier="${2:-medium}"
    local ladder="${EPAM_MODEL_LADDER:-}"
    if [ -z "$ladder" ]; then
        case "$tier" in
            high) ladder="${EPAM_MODEL_LADDER_HIGH:-}" ;;
            *)    ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
        esac
    fi
    [ -z "$ladder" ] && { echo ""; return; }
    local pair from to IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$ladder"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"
        to="${pair#*=}"
        if [ "$from" = "$current_model" ]; then
            echo "$to"
            return
        fi
    done
    echo ""
}

# resolve_model_provider <model>
# Reads EPAM_MODEL_PROVIDER_MAP (pipe-separated "glob-pattern=provider" pairs)
# and returns the provider for a model name, matched via bash glob patterns —
# no hardcoded vendor/model names in this function. Per-project tier scripts
# supply their own map (e.g. tier3-travel-app-run.sh sets
# "zhipuai/*=qwen|moonshotai/*=qwen|z-ai/*=qwen|glm-*=qwen|kimi-*=qwen|deepseek/*=qwen|MiniMax-*=minimax"
# because this project routes all OpenRouter-hosted vendors through the
# "qwen" provider umbrella and MiniMax direct-API models through "minimax").
# Root cause this replaces: the escalation-ladder code used to hardcode this
# exact vendor-name case statement twice inline (found live, 2026-07-06) —
# a project using different model vendors/providers would get silently wrong
# (or no) provider routing after a model-ladder step. Returns empty string
# when no map is configured or no pattern matches (caller keeps STORY_PROVIDER
# unchanged in that case, same as before).
resolve_model_provider() {
    local model="$1"
    local map="${EPAM_MODEL_PROVIDER_MAP:-}"
    [ -z "$map" ] && { echo ""; return; }
    local pair pattern provider IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$map"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        pattern="${pair%%=*}"
        provider="${pair#*=}"
        # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
        case "$model" in
            $pattern) echo "$provider"; return ;;
        esac
    done
    echo ""
}

# assess_model_escalation <story_id> <raw_file> <result_json> <log_file>
# Layer 2 (opt-in): LLM coordinator gate for Class B/C failures.
# Sets COORDINATOR_ESCALATE and COORDINATOR_PROMPT_AMENDMENT.
# Only called when EPAM_MODEL_COORDINATOR_ENABLED=1.
assess_model_escalation() {
    local story_id="$1"
    local raw_file="${2:-}"
    local result_json="${3:-}"
    local log_file="${4:-}"
    local target_model="${5:-}"  # the model we're about to escalate to

    [ "${EPAM_MODEL_COORDINATOR_ENABLED:-0}" != "1" ] && return

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${ORCH_GATE_MODEL:-}"
    [ -z "$gate_provider" ] && return

    # Read failure evidence (cap at 3000 chars to stay within gate model budget)
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null | head -c 1500 || echo "")
    local log_tail=""
    [ -f "$log_file" ] && log_tail=$(tail -30 "$log_file" 2>/dev/null | head -c 1500 || echo "")
    # Include specific test failure output when available (Quality class failures)
    local test_failure_snippet="${VERIFICATION_FAILURE:0:1000}"
    # Cross-run memory: include prior failure pattern count for context
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    local prior_failure_summary=""
    if [ -f "$_failures_file" ]; then
        local _pf_count
        _pf_count=$(jq -r --arg sid "$story_id" 'select(.storyId == $sid) | .failureClass' \
            "$_failures_file" 2>/dev/null | sort | uniq -c | sort -rn | head -5 || echo "")
        [ -n "$_pf_count" ] && prior_failure_summary="Prior failure pattern (this story across runs): ${_pf_count}"
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_title
    story_title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // ""' "$prd_target" 2>/dev/null || echo "")
    local current_model="${STORY_MODEL:-unknown}"

    local coordinator_prompt
    coordinator_prompt=$(cat << COORD_PROMPT
You are the inference ladder coordinator. A story implementation just failed. You must decide whether to escalate to a stronger model for the retry, and whether a targeted prompt amendment would help.

## Story
- ID: ${story_id}
- Title: ${story_title}
- Current model: ${current_model}
- Proposed escalation model: ${target_model}
- Failure class (preliminary): ${COORDINATOR_FAILURE_CLASS}

## Failure Evidence (last attempt result)
${result_text:-"(empty — agent produced no result)"}

## Log Tail
${log_tail:-"(no log available)"}

## Test Failure Output (if tests ran)
${test_failure_snippet:-"(no test failure output)"}

## Cross-Run History
${prior_failure_summary:-"(no prior failures recorded for this story)"}

## Your Assessment
Answer ONLY with a single-line JSON object (no markdown, no prose):
{"escalate":"yes|no","failure_class":"env|capability|quality|unknown","prompt_amendment":"<targeted instruction to add to retry prompt, or empty string>","rationale":"<one sentence>"}

Rules:
- escalate "yes" ONLY when the failure is due to model capability limits (max iterations, context window, weak reasoning, missing knowledge)
- escalate "no" when the failure is environmental (missing API key, binary crash, file permission) — a stronger model won't fix it
- escalate "no" when the failure is a prompt misunderstanding — suggest a prompt_amendment instead
- prompt_amendment should be a concrete instruction (e.g., "Do not import from node-fetch — use native global fetch only") not a vague suggestion
- Keep rationale under 15 words
COORD_PROMPT
    )

    local coord_result_file
    coord_result_file=$(mktemp /tmp/coord-${story_id}-XXXXXX.json)

    local coord_raw=""
    if coord_raw=$(echo "$coordinator_prompt" | \
            AI_PROVIDER="$gate_provider" \
            AI_MODEL="$gate_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
            ${gate_model:+--model "$gate_model"} \
            2>/dev/null); then
        # Parse coordinator response
        local coord_json=""
        # Extract JSON object from response (strip any preamble)
        coord_json=$(echo "$coord_raw" | grep -o '{[^}]*}' | head -1 || echo "")
        if [ -n "$coord_json" ] && echo "$coord_json" | jq empty 2>/dev/null; then
            local coord_escalate
            coord_escalate=$(echo "$coord_json" | jq -r '.escalate // "yes"' 2>/dev/null || echo "yes")
            local coord_class
            coord_class=$(echo "$coord_json" | jq -r '.failure_class // "unknown"' 2>/dev/null || echo "unknown")
            local coord_amendment
            coord_amendment=$(echo "$coord_json" | jq -r '.prompt_amendment // ""' 2>/dev/null || echo "")
            local coord_rationale
            coord_rationale=$(echo "$coord_json" | jq -r '.rationale // ""' 2>/dev/null || echo "")

            COORDINATOR_ESCALATE="$coord_escalate"
            COORDINATOR_FAILURE_CLASS="$coord_class"
            COORDINATOR_PROMPT_AMENDMENT="$coord_amendment"
            log "  Coordinator[L2]: escalate=$coord_escalate class=$coord_class rationale='$coord_rationale'"
            [ -n "$coord_amendment" ] && log "  Coordinator[L2]: prompt_amendment injected (${#coord_amendment} chars)"
        else
            warning "  Coordinator[L2]: could not parse coordinator response — keeping L1 decision"
        fi
    else
        warning "  Coordinator[L2]: coordinator call failed — keeping L1 decision"
    fi

    rm -f "$coord_result_file"
}

# run_prd_change_reviewer <story_id> <change_type> <before_json> <after_json>
# Validates a proposed PRD AC/TC or profiles.json change using the gate model.
# change_type: ac_patch | tc_patch | skill_note | profile_addendum
# Echoes "pass" or "fail"; caller decides whether to revert on fail.
# Silently returns "pass" if gate model is not configured (non-blocking).
run_prd_change_reviewer() {
    local story_id="$1"
    local change_type="$2"
    local before_json="$3"
    local after_json="$4"

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    if [ -z "$gate_provider" ]; then
        echo "pass"
        return 0
    fi
    # KB/PRD/profile writes are persistent and must be reviewed by the highest-quality
    # model available, not the cheap gate model. Use ESCALATION_MODEL_HIGH with high
    # reasoning so every persisted write is agentic-quality-reviewed.
    local gate_model="${ESCALATION_MODEL_HIGH:-${ORCH_GATE_MODEL:-MiniMax-M3}}"

    # Select profile based on change type — KB entries use the stricter kb-change-reviewer
    local _profile_key="prd-change-reviewer"
    [ "$change_type" = "kb_entry" ] && _profile_key="kb-change-reviewer"
    local reviewer_profile=""
    if [ -f "$profiles_file" ]; then
        reviewer_profile=$(jq -r --arg k "$_profile_key" '.[$k] // ""' "$profiles_file" 2>/dev/null || echo "")
    fi
    [ -z "$reviewer_profile" ] && reviewer_profile="You are a change reviewer. Validate the proposed change and emit {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}."

    local review_prompt
    review_prompt="${reviewer_profile}

STORY: ${story_id}
CHANGE TYPE: ${change_type}

BEFORE:
${before_json:0:1000}

AFTER:
${after_json:0:1000}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[\"<issue1>\"],\"reason\":\"<15 words max>\"}"

    local review_raw=""
    review_raw=$(echo "$review_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"verdict":"pass","issues":[],"reason":"reviewer unavailable"}')

    local verdict=""
    verdict=$(echo "$review_raw" | python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(obj.get('verdict','pass'))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'\"verdict\"\s*:\s*\"(pass|fail)\"', text)
print(m.group(1) if m else 'pass')
" 2>/dev/null || echo "pass")

    local issues=""
    issues=$(echo "$review_raw" | python3 -c "
import sys, json
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    issues = obj.get('issues', [])
    if issues: print('; '.join(str(i) for i in issues))
except Exception:
    pass
" 2>/dev/null || echo "")

    # CRITICAL: this function's return value is captured via command substitution
    # ($(run_prd_change_reviewer ...)). warning()/log() write to stdout as well as
    # the progress log, so any call to them here would pollute the captured verdict
    # with extra lines — making `[ "$verdict" = "fail" ]` at every call site always
    # false (the string would be "warning text\nfail", not "fail"), silently treating
    # every rejection as an approval. Redirect to stderr so only the final echo
    # reaches the caller.
    # Exposes the rejection reason to callers (e.g. run_change_with_reviewer_retry).
    # Every caller invokes this function via $(...) command substitution, which
    # forks a subshell — a plain variable assignment here (PRD_REVIEW_ISSUES=...)
    # would never be visible to the caller's shell. A file survives the subshell
    # exit, so use that instead. $$ scopes the file to this process (worktree
    # primary/independent run as separate PIDs, so no cross-process collision).
    printf '%s' "$issues" > "${TMPDIR:-/tmp}/.prd-review-issues-$$" 2>/dev/null || true

    if [ "$verdict" = "fail" ]; then
        warning "  [PRD-Reviewer] REJECTED ${change_type} for ${story_id}: ${issues:-no details}" >&2
        echo "fail"
    else
        log "  [PRD-Reviewer] APPROVED ${change_type} for ${story_id}" >&2
        echo "pass"
    fi
}

# run_prd_change_summarizer <story_id> <change_type> <issues> <rejected_text>
# Rewrites rejected self-heal text to address the reviewer's stated issues instead
# of discarding it outright. Most kb_entry/skill_note rejections are FORMAT problems
# (over 200 chars, wrong verb tense, references a specific story ID, truncated
# mid-sentence) — the underlying lesson is usually sound, only its shape is wrong.
# Prints the reformatted text to stdout (falls back to the original text if the
# gate model is unavailable or returns nothing usable).
run_prd_change_summarizer() {
    local story_id="$1"
    local change_type="$2"
    local issues="$3"
    local rejected_text="$4"

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    if [ -z "$gate_provider" ]; then
        printf '%s' "$rejected_text"
        return 0
    fi
    # Summarizer rewrites rejected KB/PRD/profile writes — must use the same
    # high-quality model as the reviewer so the rewrite is meaningfully better.
    local gate_model="${ESCALATION_MODEL_HIGH:-${ORCH_GATE_MODEL:-MiniMax-M3}}"

    # tool_creation rewrites a bash script, not a short prose rule — the
    # kb_entry/skill_note constraints (single line, under 200 chars, imperative
    # verb) would corrupt working code. Branch the prompt AND the post-processing
    # (no `tr -d '\n'` — a script needs its newlines) by change type.
    local summarize_prompt output_cap
    if [ "$change_type" = "tool_creation" ]; then
        summarize_prompt="You are a bash script reviewer-summarizer. A dynamic tool script for story ${story_id} was REJECTED by the change reviewer for these reasons:
${issues:-no details}

ORIGINAL SCRIPT:
${rejected_text:0:2000}

Rewrite the script to fix ONLY the issues listed above — a real bash bug (syntax error, subshell variable scoping, unquoted expansion, etc). Preserve the shebang line, the overall purpose, and every argument (\$1, \$2, ...) exactly as used. The script must remain idempotent (safe to run more than once).

Emit ONLY the corrected script — no markdown fences, no commentary, no explanation."
        output_cap=4000
    else
        summarize_prompt="You are a PRD change summarizer. A ${change_type} for story ${story_id} was REJECTED by the change reviewer for these reasons:
${issues:-no details}

ORIGINAL TEXT:
${rejected_text:0:1000}

Rewrite the text to fix ONLY the issues listed above, preserving the original actionable rule. Requirements: no reference to any specific story ID; start with an imperative verb (Use, Always, Never, Prefer, Avoid); under 200 characters; end on a complete sentence; no markdown, no headers, no commentary.

Emit ONLY the corrected text — nothing else."
        output_cap=400
    fi

    local summarized=""
    summarized=$(echo "$summarize_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null | head -c "$output_cap" || echo "")
    if [ "$change_type" = "tool_creation" ]; then
        summarized="$(echo "$summarized" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    else
        summarized="$(echo "$summarized" | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    fi

    if [ -n "$summarized" ]; then
        printf '%s' "$summarized"
    else
        printf '%s' "$rejected_text"
    fi
}

# _skill_note_format_ok <note> <story_id> <existing_profile_text>
# Deterministic pre-check for the OBJECTIVELY verifiable skill_note/kb_entry
# format rules already stated in profiles.json's prd-change-reviewer /
# kb-change-reviewer profiles: length cap, imperative opener, no story-ID
# reference, not a verbatim duplicate of an existing line in the same
# profile. These are checkable facts, not subjective judgment calls -- yet a
# live run (2026-07-07) observed the LLM reviewer reject notes that already
# satisfied every one of these rules (e.g. "Always end TypeScript statements
# with semicolons...", well under 200 chars, no story ID), 3/3 times, purely
# on flaky format judgment. That burns a gate round-trip per rejection for
# zero benefit. When a candidate passes this check, skip the LLM review
# entirely for format -- genuinely subjective calls (does this CONTRADICT an
# existing rule, is the underlying lesson actually sound) are out of scope
# here and still need a real reviewer, so this only short-circuits the
# specific failure mode that was observed wasting cost.
_skill_note_format_ok() {
    local note="$1"
    local story_id="$2"
    local existing_profile_text="${3:-}"
    [ -z "$note" ] && return 1
    [ "${#note}" -le 200 ] || return 1
    echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b" || return 1
    if [ -n "$story_id" ] && echo "$note" | grep -qi "$story_id"; then
        return 1
    fi
    if [ -n "$existing_profile_text" ] && echo "$existing_profile_text" | grep -qF "$note"; then
        return 1
    fi
    return 0
}

# _ensure_imperative_opener <note>
# Deterministically normalizes a skill_note/kb_entry candidate to satisfy
# _skill_note_format_ok's imperative-opener check, WITHOUT ever needing an
# LLM rewrite round-trip. Closes a live gap (2026-07-12, tier3-travel-app
# run): SKY-002-impl's FailureAnalyst produced a genuinely correct, specific
# note -- "When converting an interface to Record<string, unknown>, ensure
# the interface has an index signature or use 'unknown' first to avoid
# TS2352 error." -- but it opens with a subordinate "When X, ..." clause,
# not an imperative, so it correctly failed the deterministic format check
# and went through the full LLM reviewer 3 times on this SAME fixable
# wording issue, then was persisted UNREVIEWED as a fallback. The lesson
# itself was fine; only the opening word was wrong -- a mechanically
# fixable defect, not a judgment call. Prepending
# SKILL_NOTE_NORMALIZATION_OPENER (a configurable var, checked against the
# SAME SKILL_NOTE_IMPERATIVE_OPENERS list _skill_note_format_ok uses -- no
# word list duplicated or hardcoded independently in either function) is a
# generic, content-preserving transform (not a rewrite) that reliably
# satisfies the imperative check for ANY note shape, so apply it BEFORE the
# note is ever handed to run_change_with_reviewer_retry, letting an
# otherwise-sound note skip the LLM reviewer entirely on the very first
# attempt.
_ensure_imperative_opener() {
    local note="$1"
    [ -z "$note" ] && { printf ''; return 0; }
    if echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    # Sanity-check the configured normalization opener is itself an accepted
    # word (not assumed) -- if misconfigured, fall through without
    # normalizing rather than prepend something that wouldn't pass the check
    # anyway.
    if ! echo "$SKILL_NOTE_NORMALIZATION_OPENER" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    printf '%s' "${SKILL_NOTE_NORMALIZATION_OPENER}: ${note}" | cut -c1-200
}

# _tool_recipe_reinvokes_test_cmd <recipe> <test_cmd>
# Deterministic pre-check for a dynamic-tool recipe re-running the project's
# OWN configured test command (e.g. "npm test") as part of its own recipe.
#
# Root cause this closes (found live, 2026-07-11/12, tier3-travel-app run,
# SKY-004-test): a dynamic tool (build-before-test.sh) whose stated purpose
# was "ensure the build runs before tests" wrote a recipe of
# `npm run build && npx vitest run` — independently re-invoking the FULL test
# suite a second time, outside the orchestrator's own dedicated, captured
# `run_external_verification()` test run. That duplicate, uncaptured
# invocation is a real risk: any stray output it produces (or any process it
# leaves running) is NOT isolated from the orchestrator's own subsequent
# capture of $test_output, which is fed directly into the failure-analyst's
# next diagnosis as trusted ground truth. A tool's job is the ONE mechanical
# step it was written for (installing a dependency, running a build) — never
# a second, uncoordinated run of the test suite itself.
#
# Generic/config-driven, not hardcoded to any test runner: compares the
# recipe against THIS project's own resolved test command (passed in from
# run_external_verification's LAST_TEST_CMD), not a fixed "vitest"/"jest"
# pattern list.
_tool_recipe_reinvokes_test_cmd() {
    local recipe="$1"
    local test_cmd="${2:-}"
    [ -z "$test_cmd" ] && return 1
    echo "$recipe" | grep -qF -- "$test_cmd" && return 0
    return 1
}

# run_change_with_reviewer_retry <story_id> <change_type> <before> <candidate> [max_retries=3]
# Wraps run_prd_change_reviewer with a summarize-and-resubmit loop instead of discarding
# a rejected self-heal change immediately. On rejection, run_prd_change_summarizer
# rewrites the candidate to address the reviewer's stated issues, then resubmits — up
# to <max_retries> total review attempts. This exists because kb_entry/skill_note
# writes were being rejected (and discarded) near-100% of the time on fixable FORMAT
# issues, silently defeating the entire self-heal-persistence mechanism.
# Prints "pass" or "fail" to stdout (same contract as run_prd_change_reviewer).
# Sets REVIEWER_RETRY_TEXT to the final (possibly reformatted) candidate either way.

run_change_with_reviewer_retry() {
    local story_id="$1"
    local change_type="$2"
    local before="$3"
    local candidate="$4"
    local max_retries="${5:-3}"

    # Same subshell-scope issue as PRD_REVIEW_ISSUES: this whole function is also
    # invoked via $(...) by its callers, so a plain REVIEWER_RETRY_TEXT=... here
    # would never reach them. File-based side channel again; callers read it
    # right after the command substitution (see kb)/skill) cases in
    # run_failure_analyst).
    local _issues_file="${TMPDIR:-/tmp}/.prd-review-issues-$$"
    local _retry_text_file="${TMPDIR:-/tmp}/.reviewer-retry-text-$$"

    if { [ "$change_type" = "skill_note" ] || [ "$change_type" = "kb_entry" ]; } \
        && _skill_note_format_ok "$candidate" "$story_id" "$before"; then
        printf '%s' "$candidate" > "$_retry_text_file" 2>/dev/null || true
        log "  [PRD-Reviewer] Skipped LLM review for ${change_type} (${story_id}) -- deterministic format check passed" >&2
        echo "pass"
        return 0
    fi

    local attempt=1
    local current="$candidate"
    local verdict="" review_issues=""
    while [ "$attempt" -le "$max_retries" ]; do
        verdict=$(run_prd_change_reviewer "$story_id" "$change_type" "$before" "$current")
        if [ "$verdict" != "fail" ]; then
            printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
            echo "pass"
            return 0
        fi
        review_issues=$(cat "$_issues_file" 2>/dev/null || echo "")
        if [ "$attempt" -lt "$max_retries" ]; then
            log "  [PRD-Summarizer] Rewriting rejected ${change_type} for ${story_id} (attempt ${attempt}/${max_retries}): ${review_issues:-no details}" >&2
            current=$(run_prd_change_summarizer "$story_id" "$change_type" "$review_issues" "$current")
        fi
        attempt=$((attempt + 1))
    done
    printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
    echo "fail"
    return 1
}

# run_diagnosis_groundedness_check <story_id> <diagnosis>
# Advisory-only (2026-07-12): scores the FailureAnalyst's own diagnosis
# against the real failure log (VERIFICATION_FAILURE) using DeepEval's
# GEval metric as an LLM judge over OpenRouter -- see
# orchestrations/scripts/tools/diagnosis-groundedness-check.py for the full
# rationale (a live incident already on record for this pipeline: the
# analyst confidently asserted a root cause that was flatly wrong, and every
# retry then "fixed" the wrong thing because the diagnosis guiding it was
# false). Logs to orchestrations/logs/failure-diagnosis-groundedness.jsonl
# so a future decision to make this blocking is backed by measurement, not
# guesswork -- it NEVER alters target/patch handling, and the call site
# deliberately does not capture this function's return value.
# Silently no-ops (no warning spam) if the venv/script/API key isn't
# available, so this optional tooling can never break the retry loop.
run_diagnosis_groundedness_check() {
    local story_id="$1"
    local diagnosis="$2"
    [ "${SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK:-0}" = "1" ] && return 0

    local _dgc_script="${SCRIPT_DIR}/tools/diagnosis-groundedness-check.py"
    local _dgc_venv_python="${SCRIPT_DIR}/tools/.venv-deepeval/bin/python"
    [ -x "$_dgc_venv_python" ] || return 0
    [ -f "$_dgc_script" ] || return 0

    local _dgc_input
    _dgc_input=$(jq -n --arg diag "$diagnosis" --arg log "${VERIFICATION_FAILURE:0:6000}" \
        '{diagnosis: $diag, log_excerpt: $log}' 2>/dev/null)
    [ -z "$_dgc_input" ] && return 0

    local _dgc_result
    _dgc_result=$(echo "$_dgc_input" | timeout 30 "$_dgc_venv_python" "$_dgc_script" 2>/dev/null)
    [ -z "$_dgc_result" ] && return 0
    echo "$_dgc_result" | jq empty 2>/dev/null || return 0

    # NOTE: `.skipped // true` would be wrong here -- jq's `//` alternative
    # operator treats a literal `false` value as falsy too (not just null/
    # absent), so it would silently collapse a genuine {"skipped": false}
    # result into "true" and this check would NEVER accept a real
    # evaluation. `has("skipped")` distinguishes "field present and false"
    # from "field absent" correctly.
    local _dgc_skipped
    _dgc_skipped=$(echo "$_dgc_result" | jq -r 'if has("skipped") then .skipped else true end' 2>/dev/null)
    [ "$_dgc_skipped" = "true" ] && return 0

    local _dgc_verdict _dgc_score
    _dgc_verdict=$(echo "$_dgc_result" | jq -r '.verdict // "unknown"' 2>/dev/null)
    _dgc_score=$(echo "$_dgc_result" | jq -r '.score // 0' 2>/dev/null)
    if [ "$_dgc_verdict" = "ungrounded" ]; then
        warning "  [DiagnosisGroundedness] $story_id: diagnosis may be ungrounded (score=$_dgc_score) — advisory only, not blocking"
    else
        log "  [DiagnosisGroundedness] $story_id: diagnosis grounded (score=$_dgc_score)"
    fi

    mkdir -p "${LOG_DIR}" 2>/dev/null
    # -c (compact) is required here, not cosmetic: without it jq pretty-
    # prints each object across multiple lines, breaking the "one JSON
    # object per line" contract every JSONL consumer (line-based tailing,
    # wc -l counting, streaming parsers) depends on -- found live 2026-07-12
    # while building a report script against this exact file.
    jq -nc --arg story "$story_id" --arg diag "$diagnosis" --argjson result "$_dgc_result" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, diagnosis: $diag, timestamp: $ts} + $result' \
        >> "${LOG_DIR}/failure-diagnosis-groundedness.jsonl" 2>/dev/null || true
    return 0
}

# run_failure_analyst <story_id> <output_file> <retry_num>
# Layer 3 (self-heal): AI reads the test failure, diagnoses root cause, then patches
# PRD ACs (for ambiguous specs) or injects skill guidance into the coordinator
# amendment (for bad coding patterns) — before the next retry.
# Only meaningful when VERIFICATION_FAILURE is set (external test suite failed).
# Uses ORCH_GATE_PROVIDER/ORCH_GATE_MODEL (same gate as assess_model_escalation).
run_failure_analyst() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local retry_num="${3:-0}"

    # Only analyze test-suite failures; missing-deliverable failures lack useful output
    [ -z "${VERIFICATION_FAILURE:-}" ] && return 0

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    # Failure analyst uses ESCALATION_MODEL (z-ai/glm-5.2) when set — never qwen chat models;
    # falls back to ORCH_GATE_MODEL only when no escalation model is configured.
    local gate_model="${ESCALATION_MODEL:-${ORCH_GATE_MODEL:-}}"
    if [ -z "$gate_provider" ]; then
        log "  [FailureAnalyst] No gate provider configured — skipping self-heal analysis"
        return 0
    fi

    log "  [FailureAnalyst] Analyzing test failure for $story_id (gate=$gate_model)..."
    "$SCRIPT_DIR/update-monitor.sh" story_start "failure-analyst" "main" "failure-analyst" "Failure Analyst: $story_id" \
        "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
    "$SCRIPT_DIR/update-monitor.sh" event "self_heal_start" \
        "Self-heal started for $story_id (attempt $retry_num, gate=$gate_model)" \
        "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Build spec context: prefer testCriteria.facts (ground truth from TC writer) over ACs
    local story_acs story_role skill_addendum profiles_file
    local tc_facts_raw
    tc_facts_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .testCriteria.facts // [] | to_entries | map("TC\(.key+1): \(.value)") | join("\n")' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$tc_facts_raw" ]; then
        story_acs="$tc_facts_raw"
    else
        story_acs=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | to_entries | map("AC\(.key+1): \(.value)") | join("\n")' \
            "$prd_target" 2>/dev/null || echo "(no ACs found)")
    fi
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "typescript-engineer"' \
        "$prd_target" 2>/dev/null || echo "typescript-engineer")
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    skill_addendum=""
    if [ -f "$profiles_file" ]; then
        # profiles.json is flat {role: "prompt string"} — extract [Self-Heal] lines only
        skill_addendum=$(jq -r --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null | \
            grep '\[Self-Heal\]' | head -c 1500 || echo "")
    fi

    # Load failure-analyst profile from profiles.json (role-level instructions)
    local analyst_profile=""
    if [ -f "$profiles_file" ]; then
        analyst_profile=$(jq -r '."failure-analyst" // ""' "$profiles_file" 2>/dev/null || echo "")
    fi
    [ -z "$analyst_profile" ] && analyst_profile="You are a self-healing pipeline analyst. Diagnose the exact root cause of the test failure and prescribe the minimum fix so the NEXT retry succeeds."

    # Dependency contract injection (added 2026-07-07): same ground-truth
    # mechanism already proven for build_implementation_prompt() — the
    # failure-analyst was previously diagnosing failures with NO visibility
    # into a dependency's REAL exports/signatures, and got it wrong on a live
    # run: it called a casing-typo'd import ("SkyScannerClient" vs the real
    # "SkyscannerClient") a "default vs named export mismatch," which is
    # simply false — the class IS correctly a named export, just mis-cased.
    # Every retry (including the strongest configured model) then "fixed" the
    # wrong thing because the diagnosis GUIDING it was wrong. A stronger model
    # can't out-reason a false premise it's been handed as ground truth.
    local dependency_contracts=""
    local _fa_dep_ids_json
    _fa_dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _fa_dep_id
    while IFS= read -r _fa_dep_id; do
        [ -z "$_fa_dep_id" ] && continue
        local _fa_contract_file="$PROJECT_ROOT/.contracts/${_fa_dep_id}.md"
        if [ -f "$_fa_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_fa_dep_id}
$(cat "$_fa_contract_file")
"
        fi
    done < <(echo "$_fa_dep_ids_json" | jq -r '.[]?' 2>/dev/null)
    [ -z "$dependency_contracts" ] && dependency_contracts="(no dependency contracts available)"

    local analyst_prompt
    analyst_prompt=$(cat << 'ANALYST_PROMPT_END'
__ANALYST_PROFILE__

STORY: __STORY_ID__
AGENT ROLE: __STORY_ROLE__

CURRENT TEST CRITERIA (TC facts when available, ACs as fallback):
__STORY_ACS__

AGENT SKILL ADDENDUM (instructions in the agent's system prompt):
__SKILL_ADDENDUM__

DEPENDENCY CONTRACTS (ground truth — auto-generated from actual source, not
model-transcribed; trust this over any assumption you'd otherwise make about
what a dependency exports, including its exact class/function names and
casing):
__DEPENDENCY_CONTRACTS__

TEST FAILURE OUTPUT:
__VERIFICATION_FAILURE__

Output ONLY a single JSON object. No markdown fences, no prose outside the JSON:
{"diagnosis":"<one sentence: what specifically went wrong in the code>","target":"prd|tc|skill|kb|tool|none","ac_patches":[{"index":<0-based AC index>,"new_text":"<exact replacement text for that AC>"}],"tc_patches":[{"index":<0-based TC fact index>,"new_text":"<exact replacement text for that TC fact>"}],"skill_note":"<if target=skill or target=kb: concrete coding instruction>","tool_spec":{"name":"<kebab-case tool name, e.g. add-dependency>","purpose":"<one sentence: what repeated mechanical step this automates>","recipe":"<the exact shell commands the tool script should run, using $1 $2 ... for its arguments>"},"reason":"<why this change prevents the same failure on retry>"}

Decision rules:
- target=prd: the AC wording was ambiguous or contradictory, causing the agent to write wrong code. Fix the AC.
- target=tc: the testCriteria facts are wrong or incomplete — the test agent followed them but they described incorrect behavior. Fix the TC facts.
- target=skill: the agent used a bad coding pattern that should be injected into this retry's prompt only.
- target=kb: the failure reveals a reusable coding rule that ALL future agents with this agent role should know — append to the role-specific KB.
- target=tool: the failure is a repeated MECHANICAL step (not a knowledge gap) that a small shell script can perform reliably every time — e.g. "add a package to package.json and install it before importing it". Only use target=tool when a KB rule alone has already failed to prevent the same class of failure, or the fix is a multi-step shell recipe error-prone to repeat by hand. Provide tool_spec.
- target=none: spec and skill are both correct; the agent made a transient code mistake. Retry with stronger model should fix it.
- Only include ac_patches when target=prd, tc_patches when target=tc; use [] for other targets. Only include tool_spec when target=tool; omit otherwise.
- skill_note must be a concrete "do/don't" instruction (e.g. "Never use backtick template literals in test files — use single-quoted strings only").
- tool_spec.recipe must be idempotent shell — safe to run more than once (e.g. check before installing).
- Keep diagnosis under 20 words, reason under 15 words.
ANALYST_PROMPT_END
    )
    # Substitute placeholders (safe substitution avoids heredoc quoting issues)
    analyst_prompt="${analyst_prompt//__ANALYST_PROFILE__/$analyst_profile}"
    analyst_prompt="${analyst_prompt//__STORY_ID__/$story_id}"
    analyst_prompt="${analyst_prompt//__STORY_ROLE__/$story_role}"
    analyst_prompt="${analyst_prompt//__STORY_ACS__/$story_acs}"
    analyst_prompt="${analyst_prompt//__SKILL_ADDENDUM__/$skill_addendum}"
    analyst_prompt="${analyst_prompt//__DEPENDENCY_CONTRACTS__/$dependency_contracts}"
    analyst_prompt="${analyst_prompt//__VERIFICATION_FAILURE__/$VERIFICATION_FAILURE}"

    local analyst_raw="" analyst_json="" _analyst_call_ok="false"
    local _analyst_max_attempts=3 _analyst_attempt=1
    local _analyst_json_result
    _analyst_json_result=$(mktemp /tmp/analyst-result-XXXXXX.json)
    while [ "$_analyst_attempt" -le "$_analyst_max_attempts" ]; do
        if analyst_raw=$(echo "$analyst_prompt" | \
                AI_PROVIDER="$gate_provider" \
                AI_MODEL="$gate_model" \
                EPAM_CLI="$EPAM_CLI" \
                ORCH_JSON_RESULT="$_analyst_json_result" \
                EPAM_REASONING_EFFORT="high" \
                EPAM_TEMPERATURE="0.7" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
                ${gate_model:+--model "$gate_model"} \
                2>>"$output_file"); then
            _analyst_call_ok="true"

            # Extract first valid JSON object (handles nested structures via Python)
            analyst_json=$(echo "$analyst_raw" | python3 -c "
import sys, json
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(json.dumps(obj))
    sys.exit(0)
except Exception:
    pass
depth = 0; start = -1
for i, c in enumerate(text):
    if c == '{':
        if depth == 0: start = i
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0 and start >= 0:
            try:
                obj = json.loads(text[start:i+1])
                print(json.dumps(obj))
                sys.exit(0)
            except Exception:
                pass
" 2>/dev/null || echo "")

            if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
                break
            fi
            analyst_json=""
            if [ "$_analyst_attempt" -lt "$_analyst_max_attempts" ]; then
                warning "  [FailureAnalyst] Could not parse JSON from analyst response — retrying gate call (attempt $((_analyst_attempt + 1))/${_analyst_max_attempts})"
            fi
        else
            _analyst_call_ok="false"
        fi
        _analyst_attempt=$((_analyst_attempt + 1))
    done

    if [ "$_analyst_call_ok" = "true" ]; then
        if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
            local diagnosis target skill_note reason patch_count _profile_updated
            diagnosis=$(echo "$analyst_json" | jq -r '.diagnosis // "unknown"' 2>/dev/null || echo "unknown")
            target=$(echo "$analyst_json" | jq -r '.target // "none"' 2>/dev/null || echo "none")
            skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""' 2>/dev/null || echo "")
            [ -n "$skill_note" ] && skill_note=$(_ensure_imperative_opener "$skill_note")
            reason=$(echo "$analyst_json" | jq -r '.reason // ""' 2>/dev/null || echo "")
            local tool_name tool_purpose tool_recipe
            tool_name=$(echo "$analyst_json" | jq -r '.tool_spec.name // ""' 2>/dev/null || echo "")
            tool_purpose=$(echo "$analyst_json" | jq -r '.tool_spec.purpose // ""' 2>/dev/null || echo "")
            tool_recipe=$(echo "$analyst_json" | jq -r '.tool_spec.recipe // ""' 2>/dev/null || echo "")
            patch_count=0
            _profile_updated="false"

            log "  [FailureAnalyst] Diagnosis: $diagnosis"
            log "  [FailureAnalyst] Target=$target — $reason"

            run_diagnosis_groundedness_check "$story_id" "$diagnosis"

            case "$target" in
                prd)
                    local patches_json
                    patches_json=$(echo "$analyst_json" | jq -c '.ac_patches // []' 2>/dev/null || echo "[]")
                    if [ "$patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching PRD ACs for $story_id..."
                        # Snapshot ACs before patching so reviewer can compare and we can revert
                        local _ac_before _ac_after
                        _ac_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local idx new_text
                            idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$idx" ] && [ -n "$new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            old = acs[idx]
            acs[idx] = new_text
            print(f'AC{idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'AC index {idx} out of range (story has {len(acs)} ACs)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$patches_json" | jq -c '.[]' 2>/dev/null)
                        _ac_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent corrupt ACs reaching agent
                        local _review_verdict
                        _review_verdict=$(run_prd_change_reviewer "$story_id" "ac_patch" "$_ac_before" "$_ac_after")
                        if [ "$_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] AC patch rejected by reviewer — reverting to original ACs"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_ac_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
acs = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s['acceptanceCriteria'] = acs
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count AC patch(es) — retry will use updated spec"
                        fi
                    else
                        log "  [FailureAnalyst] target=prd but no ac_patches provided — no change made"
                    fi
                    ;;
                tc)
                    local tc_patches_json
                    tc_patches_json=$(echo "$analyst_json" | jq -c '.tc_patches // []' 2>/dev/null || echo "[]")
                    if [ "$tc_patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching testCriteria facts for $story_id..."
                        # Snapshot TC facts before patching for reviewer and revert
                        local _tc_before _tc_after
                        _tc_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local tc_idx tc_new_text
                            tc_idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            tc_new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$tc_idx" ] && [ -n "$tc_new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$tc_new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $tc_idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        tc = s.setdefault('testCriteria', {})
        facts = tc.setdefault('facts', [])
        if 0 <= idx < len(facts):
            old = facts[idx]
            facts[idx] = new_text
            print(f'TC fact {idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'TC index {idx} out of range (story has {len(facts)} facts)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$tc_patches_json" | jq -c '.[]' 2>/dev/null)
                        _tc_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent bad TCs reaching test agent
                        local _tc_review_verdict
                        _tc_review_verdict=$(run_prd_change_reviewer "$story_id" "tc_patch" "$_tc_before" "$_tc_after")
                        if [ "$_tc_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] TC patch rejected by reviewer — reverting to original facts"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_tc_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
facts = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s.setdefault('testCriteria', {})['facts'] = facts
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count TC patch(es) — retry will use updated testCriteria"
                        fi
                    else
                        log "  [FailureAnalyst] target=tc but no tc_patches provided — TC writer will regenerate on next deliverable pass"
                    fi
                    ;;
                skill)
                    if [ -n "$skill_note" ]; then
                        log "  [FailureAnalyst] Injected skill guidance into retry prompt (${#skill_note} chars)"
                        # Persist skill note to profiles.json so future runs inherit this learning
                        if [ -f "$profiles_file" ]; then
                            local _current_role_profile
                            _current_role_profile=$(jq -c --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null)
                            # Duplicate guard (fixed 2026-07-11, after a live run persisted an
                            # exact duplicate note): the reviewer call below already correctly
                            # rejects an exact-duplicate skill note as a "fail" verdict (same
                            # dedup mechanism the 2026-07-10 fix restored) -- but the
                            # unreviewed-fallback path just below was designed to rescue a
                            # genuinely NEW lesson that failed 3 review rounds on WORDING
                            # alone, and didn't distinguish that from "rejected because it's a
                            # verbatim duplicate." It persisted the duplicate anyway,
                            # defeating the entire dedup mechanism it sits next to. Check for
                            # an exact duplicate FIRST and skip the whole reviewer+persist
                            # flow when found -- there is nothing to review or fall back to.
                            if echo "$_current_role_profile" | grep -qF -- "$skill_note"; then
                                log "  [FailureAnalyst] Skill note is an exact duplicate of an existing note in [${story_role}] — discarding, not persisting again"
                            else
                            # Reviewer validates skill note before persisting. Rejections
                            # get up to 3 summarize-and-resubmit rounds (same mechanism as
                            # kb_entry) before being discarded.
                            local _skill_review_verdict
                            # Root cause fix (found live, 2026-07-10, tier3-travel-app run):
                            # this used to `head -c 500` the existing profile text before
                            # handing it to the duplicate check inside
                            # run_change_with_reviewer_retry/_skill_note_format_ok. New notes
                            # are appended to the END of the profile string, so once a
                            # profile grows past 500 chars (typescript-engineer reached
                            # 12K+), the dedup check was structurally blind to every note
                            # already there — guaranteeing duplicates for any profile past
                            # that length. Observed: the same self-contradictory "don't use
                            # 'as'... use 'value as Type'" note persisted twice verbatim in
                            # one story's retry loop. Pass the FULL profile text so the
                            # exact-duplicate check (grep -qF) can actually see prior notes.
                            _skill_review_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                                "$_current_role_profile" \
                                "$skill_note" 3)
                            # run_change_with_reviewer_retry ran inside the $(...) above, so its
                            # REVIEWER_RETRY_TEXT assignment was scoped to that subshell — read
                            # the file-based side channel it left behind instead.
                            REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$skill_note")
                            local _skill_note_to_persist="$REVIEWER_RETRY_TEXT"
                            if [ "$_skill_review_verdict" = "fail" ]; then
                                # Same fallback as kb_entry above (2026-07-06): don't discard a
                                # genuinely useful lesson just because its WORDING failed review
                                # 3 times — persist a length-safe, tagged-unreviewed fallback
                                # instead of losing the knowledge outright.
                                warning "  [FailureAnalyst] Skill note rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) instead of discarding"
                                _skill_note_to_persist="[unreviewed-fallback] ${skill_note:0:200}"
                            fi
                            REVIEWER_RETRY_TEXT="$_skill_note_to_persist"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $profiles_file"; return 1; }
                            python3 - "$REVIEWER_RETRY_TEXT" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
profiles_path = '$profiles_file'
role = '$story_role'
note = '[Self-Heal] ' + sys.argv[1]
with open(profiles_path) as f:
    profiles = json.load(f)
# profiles.json is flat {role: "prompt string"} — append note to the string value
if role in profiles:
    existing = profiles[role]
    sep = '\n\n' if existing else ''
    profiles[role] = existing + sep + note
    _tmp_profiles_path = profiles_path + '.tmp'
    with open(_tmp_profiles_path, 'w') as f:
        json.dump(profiles, f, indent=2)
    os.replace(_tmp_profiles_path, profiles_path)
    print(f'Skill note appended to [{role}] profile — persisted for future runs')
else:
    print(f'Profile role [{role}] not found in profiles.json — skill note NOT persisted', file=sys.stderr)
PYEOF
                            ) 200>"${profiles_file}.lock"
                            _profile_updated="true"
                            fi
                        fi
                    else
                        log "  [FailureAnalyst] target=skill but skill_note empty — falling back to diagnosis only"
                    fi
                    ;;
                kb)
                    if [ -n "$skill_note" ]; then
                        # Agent-specific KB: KB-{agentRole}.md — keeps context injection small.
                        # Shared rules go to KB-shared.md; agent-specific rules go to role file.
                        local kb_dir
                        kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                        local kb_file="${kb_dir}/KB-${story_role}.md"
                        local kb_ts
                        kb_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
                        # Truncate to 200 chars — entries are single actionable rules, not essays
                        local short_note="${skill_note:0:200}"
                        # Exact-duplicate check against the FULL kb_file BEFORE ever calling
                        # the reviewer (found live, 2026-07-12): unlike the skill_note case
                        # above (which does exactly this grep against the full profile text),
                        # this path only ever fed the reviewer the LAST 6 LINES of the KB file
                        # as dedup context, relying entirely on the LLM's subjective judgment
                        # for everything older than that. Live evidence:
                        # KB-typescript-engineer.md accumulated 4 reworded variants of the
                        # exact same "verify test-file imports are in package.json
                        # devDependencies before writing tests" rule, all appended within one
                        # 5-minute window — the LLM reviewer approved each as "not a duplicate"
                        # since the wording differed each time. This catches the EXACT-repeat
                        # case deterministically; genuine near-duplicate rewording is still the
                        # reviewer's call, same scope boundary the skill_note fix drew.
                        if [ -f "$kb_file" ] && grep -qF -- "$short_note" "$kb_file"; then
                            log "  [FailureAnalyst] KB note is an exact duplicate of an existing entry in KB-${story_role}.md — discarding, not persisting again"
                        else
                        # Read last 3 existing KB entries to give reviewer dedup context
                        local _kb_last3=""
                        _kb_last3=$(tail -6 "$kb_file" 2>/dev/null || echo "")
                        # KB reviewer gate — permanent entries must pass strict validation.
                        # Rejections get up to 3 summarize-and-resubmit rounds before being
                        # discarded (see run_change_with_reviewer_retry).
                        local _kb_review_verdict
                        _kb_review_verdict=$(run_change_with_reviewer_retry \
                            "$story_id" "kb_entry" \
                            "$_kb_last3" \
                            "$short_note" 3)
                        # See the skill_note call site above for why this file read is needed.
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$short_note")
                        if [ "$_kb_review_verdict" = "fail" ]; then
                            # Root cause this replaces (found live, 2026-07-06):
                            # a genuinely correct, useful rule ("must export
                            # main(argv)") got REJECTED 3 times purely for
                            # WORDING issues (over the char limit, wrong verb,
                            # "not generalizable") and then silently dropped —
                            # the actual lesson was lost forever, not just its
                            # phrasing. $short_note is already a mechanically
                            # safe, length-compliant truncation of the raw
                            # content computed BEFORE the reviewer ever ran, so
                            # persist THAT as a last-resort fallback (tagged as
                            # unreviewed) instead of discarding the knowledge
                            # outright. A future reviewer/human pass can still
                            # clean up the wording; nothing is lost meanwhile.
                            warning "  [FailureAnalyst] KB entry rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) instead of discarding"
                            printf '\n- [%s] [unreviewed-fallback] %s\n' "$kb_ts" "$short_note" >> "$kb_file" 2>/dev/null || true
                            _profile_updated="true"
                        else
                            # Compact 2-line format: timestamp + rule only (no verbose headers)
                            printf '\n- [%s] %s\n' "$kb_ts" "$REVIEWER_RETRY_TEXT" >> "$kb_file" 2>/dev/null || true
                            log "  [FailureAnalyst] KB entry appended to KB-${story_role}.md (${#REVIEWER_RETRY_TEXT} chars)"
                            _profile_updated="true"
                        fi
                        fi
                    else
                        log "  [FailureAnalyst] target=kb but skill_note empty — no KB entry written"
                    fi
                    ;;
                tool)
                    if [ -n "$tool_name" ] && [ -n "$tool_recipe" ] && \
                       _tool_recipe_reinvokes_test_cmd "$tool_recipe" "${LAST_TEST_CMD:-}"; then
                        warning "  [FailureAnalyst] Dynamic tool '${tool_name}' recipe re-invokes this project's own test command ('${LAST_TEST_CMD}') — a tool's job is the ONE mechanical step it automates, never a second independent test run; NOT written"
                    elif [ -n "$tool_name" ] && [ -n "$tool_recipe" ]; then
                        local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
                        mkdir -p "$tools_dir" 2>/dev/null
                        local tool_path="${tools_dir}/${tool_name}.sh"
                        local _tool_before=""
                        [ -f "$tool_path" ] && _tool_before=$(cat "$tool_path")

                        # Build the candidate script: header comment (purpose, used for
                        # prompt injection) + the recipe as the executable body.
                        local _tool_candidate
                        _tool_candidate=$(printf '#!/usr/bin/env bash\n# %s\nset -e\n%s\n' "$tool_purpose" "$tool_recipe")

                        # Reviewer gate — validates the script before it's trusted for
                        # future runs. Same snapshot/revert pattern as every other
                        # self-heal write. Rejections get up to 3 summarize-and-resubmit
                        # rounds (same mechanism as kb_entry/skill_note) before being
                        # discarded — a rejected tool used to be a dead end even when the
                        # rejection was a fixable bash bug (e.g. subshell variable scoping).
                        local _tool_review_verdict
                        _tool_review_verdict=$(run_change_with_reviewer_retry "$story_id" "tool_creation" \
                            "$_tool_before" "$_tool_candidate" 3)
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_tool_candidate")
                        if [ "$_tool_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] Dynamic tool '${tool_name}' rejected by reviewer after 3 attempts — NOT written"
                        else
                            printf '%s' "$REVIEWER_RETRY_TEXT" > "$tool_path"
                            chmod +x "$tool_path" 2>/dev/null
                            # Explicit, auditable "this exact tool was reviewed and
                            # approved" marker — a sidecar file, not a marker embedded
                            # in the script itself, so it never collides with the
                            # `sed -n '2p'` purpose-line extraction used elsewhere.
                            # Both run_dynamic_tools_in_unlocked_window() (the
                            # orchestrator's own deterministic execution) and the
                            # agent-prompt tool listing check for this marker before
                            # trusting/surfacing a tool — today's only write path
                            # already requires review, but this makes "only reviewed
                            # tools are ever used" an explicit, checkable invariant
                            # rather than an implicit assumption about there being no
                            # other writer.
                            printf 'reviewed_at=%s\nstory_id=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$story_id" > "${tool_path}.reviewed"
                            log "  [FailureAnalyst] Dynamic tool written: .epam/dynamic-tools/${tool_name}.sh — ${tool_purpose}"
                            _profile_updated="true"
                        fi
                    else
                        log "  [FailureAnalyst] target=tool but tool_spec incomplete — falling back to diagnosis only"
                    fi
                    ;;
                none)
                    log "  [FailureAnalyst] No structural fix needed — model escalation ladder handles retry"
                    ;;
                *)
                    log "  [FailureAnalyst] Unknown target '$target' — injecting diagnosis only"
                    ;;
            esac
            # Record the healing event for observability and post-run audit
            run_healing_recorder "$story_id" "$retry_num" "$target" "$diagnosis" "$patch_count" "$_profile_updated"
            # Emit self_heal_result so agent-activity dashboard shows target, diagnosis, and outcome
            "$SCRIPT_DIR/update-monitor.sh" event "self_heal_result" \
                "Self-heal result for $story_id: target=$target patches=$patch_count profile=$_profile_updated — $diagnosis" \
                "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true
            # A pure syntax error escalates immediately (see check_syntax_class_error's
            # docstring) — check this BEFORE the repeat-based check below, which would
            # otherwise wait for the same syntax error to recur once more first.
            check_syntax_class_error "$story_id" "$diagnosis"
            # Detect repeat failures — same diagnosis 2+ times means healing is broken
            check_healing_effectiveness "$story_id" "$diagnosis" "$retry_num"
            # Detect diverse failures — a DIFFERENT diagnosis each attempt while still
            # on the base model means the model can't converge on this story at all
            check_failure_diversity "$story_id" "$retry_num" "$diagnosis"
            # Always inject the failure summary into the coordinator amendment so the
            # downstream retry agent knows EXACTLY what went wrong and how to avoid it.
            local _analyst_guidance="Root cause: ${diagnosis}"
            [ -n "$skill_note" ] && _analyst_guidance="${_analyst_guidance}
Fix: ${skill_note}"
            [ "$target" = "prd" ] && _analyst_guidance="${_analyst_guidance}
The acceptance criteria for this story have been updated — re-read them carefully before writing code."
            [ "$target" = "tc" ] && _analyst_guidance="${_analyst_guidance}
The testCriteria facts for this story have been updated — re-read the Test Criteria section carefully before writing tests."
            [ "$target" = "none" ] && _analyst_guidance="${_analyst_guidance}
The spec is correct — the model made a code-level mistake. Write correct code this time."
            local _existing="${COORDINATOR_PROMPT_AMENDMENT:-}"
            COORDINATOR_PROMPT_AMENDMENT="${_existing}
## Self-Heal: Failure Analyst Summary
${_analyst_guidance}"
        else
            warning "  [FailureAnalyst] Could not parse JSON from analyst response after ${_analyst_max_attempts} attempts — proceeding with retry as-is"
        fi
    else
        warning "  [FailureAnalyst] Gate model call failed — proceeding with retry as-is"
    fi
    # Emit cost_snapshot for failure-analyst (accumulated across its retry loop)
    if [ -f "$_analyst_json_result" ] && [ -s "$_analyst_json_result" ]; then
        local _fa_cost _fa_tin _fa_tout _fa_turns _fa_phase
        _fa_cost=$(jq -r '.total_cost_usd // .cost_usd // 0'                       "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tin=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0'            "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tout=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0'         "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_turns=$(jq -r '.num_turns // .turns // .iterations // 1'                "$_analyst_json_result" 2>/dev/null || echo 1)
        _fa_phase="${CURRENT_PHASE:-}"
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg story "$story_id" \
            --arg phase "${_fa_phase:-}" \
            --arg model "${gate_model:-}" \
            --arg provider "${gate_provider:-}" \
            --argjson cost "${_fa_cost:-0}" \
            --argjson tin "${_fa_tin:-0}" \
            --argjson tout "${_fa_tout:-0}" \
            --argjson turns "${_fa_turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
              timestamp: $ts,
              agent: "failure-analyst",
              story_id: (if $story == "" then null else $story end),
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: (if $model == "" then null else $model end),
              provider: (if $provider == "" then null else $provider end),
              detail: {costUsd: $cost, tokensIn: $tin, tokensOut: $tout, turns: $turns, source: "run_failure_analyst"}
            }' >> "${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$_analyst_json_result"
    fi
    "$SCRIPT_DIR/update-monitor.sh" story_complete "failure-analyst" "main" "Analysis complete: $story_id" 2>/dev/null || true
}

# run_healing_recorder <story_id> <retry_num> <target> <diagnosis> <patches_applied> <profile_updated>
# Appends a JSONL record to $OUTPUT_DIR/healing-events.jsonl after each analyst cycle.
# Each record is independently parseable so the log survives partial runs.
run_healing_recorder() {
    local story_id="$1"
    local retry_num="${2:-0}"
    local target="${3:-none}"
    local diagnosis="${4:-unknown}"
    local patches_applied="${5:-0}"
    local profile_updated="${6:-false}"
    local rung
    rung=$(( retry_num / 2 ))
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
    # Always write to LOG_DIR (orchestrations/logs) — healing-events is pipeline
    # monitoring data, not project output. Writing to OUTPUT_DIR breaks the dashboard
    # which reads from logs/healing-events.jsonl via nginx /logs-dir mount.
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    mkdir -p "$(dirname "$heal_log")"
    # Safe JSON serialisation — escape quotes and backslashes in diagnosis
    local safe_diagnosis
    safe_diagnosis=$(printf '%s' "$diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"%s","diagnosis":"%s","patches_applied":%s,"profile_updated":%s}\n' \
        "$ts" "$story_id" "$retry_num" "$rung" "$target" "$safe_diagnosis" \
        "$patches_applied" "$profile_updated" \
        >> "$heal_log"
    log "  [HealingRecorder] Event written (story=$story_id retry=$retry_num rung=$rung target=$target)"

    # ── Self-heal KB (pillar 1: episodic tier) ───────────────────────────────
    # Additive and flag-guarded. The legacy line above still feeds the dashboard;
    # this second write is keyed by a signature derived from the TOOL OUTPUT
    # ($VERIFICATION_FAILURE), never from the diagnosis prose above — a replay of
    # 118 real episodes found only 4 diagnoses carried a compiler code, so prose
    # cannot serve as a stable lookup key. Never fails the run: losing an episode
    # must not lose a story.
    if true; then   # self-heal always on (switch removed 2026-07-25)
        local _kb_apply_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_apply_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_apply_lib"
            printf '%s' "${VERIFICATION_FAILURE:-}" | \
                kb_record_episode "$story_id" "${STORY_ROLE:-}" "$diagnosis" || true
            # Close the loop: episodes alone build nothing. Synthesis turns a
            # REPEATED signature into one arbitrated, schema-valid constraint that
            # the next attempt gets as enforcement — never as prompt prose.
            kb_maybe_synthesize "${STORY_ROLE:-}" || true
        fi
    fi
}

# apply_known_fix <project_root> <diagnosis>
# Deterministic second-line safety net for recurring self-heal failures.
#
# Root cause this fixes (found live, 2026-07-06): the FailureAnalyst's fix-routing
# has exactly 5 targets (prd, tc, tool, skill, kb), and NONE of them means "directly
# patch the content of a file the agent already wrote." For a known, mechanical,
# single-line config gap (e.g. vitest.config.ts missing `passWithNoTests: true`,
# so `vitest run` exits 1 with zero test files even though the AC explicitly
# allows that), the analyst correctly diagnosed the exact fix needed at TWO
# different model tiers, but both times picked the nearest-available-but-wrong
# target (`tool` = writes an unrelated helper script; `tc` = patches documentation
# text) — neither can touch the actual file content, so the diagnosis recurred
# and the story exhausted its entire retry ladder on a fix that was correctly
# identified but could never be mechanically applied.
#
# Deliberately NOT a 6th LLM-facing target: growing the analyst's enum gives it
# one more way to be wrong, not a better chance of being right — the gap isn't
# "not enough categories," it's "no category exists that means what's needed."
# Instead, this is a separate, deterministic, non-LLM layer that only engages
# AFTER check_healing_effectiveness has already detected 2+ repeats of the same
# diagnosis — the LLM stays the fast first responder for everything else, and
# this is a safety net for the narrow class of "correctly diagnosed, wrongly
# routed" mechanical fixes. All stack-specific knowledge (which file, which
# snippet, which symptom pattern) lives in the project's own
# .epam/known-fixes.json — same "config supplies stack knowledge, engine has
# none" convention as .epam/dependency-check.json and .epam/contract-generation.json.
#
# Returns 0 (and logs) if a fix was found and applied; returns 1 otherwise —
# callers must treat 1 as "no known fix, fall through to existing behavior."
apply_known_fix() {
    local project_root="$1"
    local diagnosis="$2"
    local config_file="${project_root}/.epam/known-fixes.json"
    [ -f "$config_file" ] || return 1

    local applied_id
    applied_id=$(python3 - "$project_root" "$config_file" "$diagnosis" << 'PYEOF' 2>/dev/null
import json, re, sys, os

project_root, config_file, diagnosis = sys.argv[1], sys.argv[2], sys.argv[3]

with open(config_file) as f:
    fixes = json.load(f)

for fix in fixes:
    try:
        if not re.search(fix['symptomPattern'], diagnosis, re.IGNORECASE):
            continue
        target_path = os.path.join(project_root, fix['targetFile'])
        if not os.path.exists(target_path):
            continue
        with open(target_path) as tf:
            content = tf.read()
        # Already present — this symptom must have a different cause; don't
        # falsely claim success, let the caller fall through to normal handling.
        if fix['checkPattern'] in content:
            continue
        m = re.search(fix['insertAfterPattern'], content)
        if not m:
            continue
        new_content = content[:m.end()] + fix['insertText'] + content[m.end():]
        with open(target_path, 'w') as tf:
            tf.write(new_content)
        print(fix['id'])
        sys.exit(0)
    except (KeyError, re.error):
        continue

sys.exit(1)
PYEOF
)
    local rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$applied_id" ]; then
        log "  [KnownFix] Applied deterministic fix '${applied_id}' for recurring diagnosis (see .epam/known-fixes.json)"
        return 0
    fi
    return 1
}

# resolve_escalation <escalating_story_id>
# Checks for a pending .epam/escalations/<story_id>.json filed by the
# escalate_defect_to_sibling_story tool (src/tools/builtin/EscalateDefect.ts).
#
# Root cause this fixes (found live, 2026-07-06): a split story pair (e.g.
# SKY-002-impl / SKY-002-test) can end up with the test child's tests failing
# because the impl child's code is missing something (e.g. constructor
# validation) — the test child's own FailureAnalyst correctly diagnoses this
# every retry, but is structurally unable to fix it (the fix lives in a file
# outside its own declared scope, correctly locked by the scope guard), so it
# just burns its entire retry ladder re-diagnosing a true root cause it can
# never act on.
#
# Resolution: find the sibling story that actually owns the target file
# (same split parent via specification.createdFrom, or — for non-split
# cross-story dependencies — any other story that declares the file), and
# reuse the implement_story function itself (all provider branches, JSON
# handling, tsc verification already correct and tested) to apply ONE narrow,
# targeted fix
# there, via the existing COORDINATOR_PROMPT_AMENDMENT injection mechanism.
# Bounded to a small retry budget (ESCALATION_FIX_MAX_RETRIES, default 1) —
# this is meant to be a single scoped patch, not a full re-implementation.
#
# Returns 0 if a fix was resolved (caller should grant a free retry); returns
# 1 if there was no escalation, or if it could not be resolved (caller falls
# through to normal retry handling — the diagnosis will surface again and be
# caught by check_healing_effectiveness like any other repeat).
resolve_escalation() {
    local escalating_story_id="$1"
    local escalation_file="${PROJECT_ROOT}/.epam/escalations/${escalating_story_id}.json"
    [ -f "$escalation_file" ] || return 1

    local target_file diagnosis required_fix
    target_file=$(jq -r '.targetFile // empty' "$escalation_file" 2>/dev/null)
    diagnosis=$(jq -r '.diagnosis // empty' "$escalation_file" 2>/dev/null)
    required_fix=$(jq -r '.requiredFix // empty' "$escalation_file" 2>/dev/null)
    if [ -z "$target_file" ] || [ -z "$required_fix" ]; then
        warning "  [Escalation] Malformed escalation file for $escalating_story_id — ignoring"
        rm -f "$escalation_file"
        return 1
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local parent_id
    parent_id=$(jq -r --arg id "$escalating_story_id" \
        '.stories[] | select(.id == $id) | .specification.createdFrom // empty' \
        "$prd_target" 2>/dev/null)

    # Prefer a split-sibling match (same parent) so a genuinely unrelated story
    # that happens to also touch the file isn't picked by mistake; fall back to
    # a project-wide owner search for non-split cross-story dependencies.
    #
    # BUG A FIX (found live, 2026-07-11/12, tier3-travel-app runs): targetFile
    # comes from run_relative_import_check()'s escalation write, which stores
    # a RELATIVE path (Python's os.path.relpath, e.g. "src/cli.ts") — but the
    # PRD's technicalNotes.files ALWAYS stores ABSOLUTE paths (e.g.
    # "/home/.../skyscanner-app/src/cli.ts"). An exact `== $file` match can
    # NEVER succeed for any escalation this codebase actually writes, so this
    # resolution step failed 100% of the time since the mechanism was built —
    # confirmed live: SKY-003-test burned its full 8-attempt retry ladder
    # twice (2026-07-11 and again 2026-07-12) on the exact defect this
    # mechanism exists to solve, because the escalation it wrote for itself
    # was silently unresolvable on the very next retry. Match the SAME
    # flexible pattern the write side (run_relative_import_check) already
    # uses for its OWN "do I own this file" check: exact match OR the
    # candidate path ending in "/" + the (possibly relative) target file.
    local sibling_id
    sibling_id=$(jq -r --arg parent "$parent_id" --arg file "$target_file" --arg self "$escalating_story_id" \
        '.stories[] | select(($parent != "") and .specification.createdFrom == $parent and .id != $self) | select((.technicalNotes.files // []) | map(. == $file or endswith("/" + $file)) | any) | .id' \
        "$prd_target" 2>/dev/null | head -1)
    if [ -z "$sibling_id" ]; then
        sibling_id=$(jq -r --arg file "$target_file" --arg self "$escalating_story_id" \
            '.stories[] | select(.id != $self) | select((.technicalNotes.files // []) | map(. == $file or endswith("/" + $file)) | any) | .id' \
            "$prd_target" 2>/dev/null | head -1)
    fi

    if [ -z "$sibling_id" ]; then
        warning "  [Escalation] Could not resolve an owning story for $target_file — no story declares it in technicalNotes.files"
        rm -f "$escalation_file"
        return 1
    fi

    log "  [Escalation] $escalating_story_id escalated a defect in $target_file (owned by $sibling_id): $diagnosis"

    local _saved_amendment="${COORDINATOR_PROMPT_AMENDMENT:-}"
    local _saved_max_retries="$MAX_RETRIES"
    COORDINATOR_PROMPT_AMENDMENT="
## URGENT: Escalated defect from sibling story ${escalating_story_id}
${diagnosis}
Required fix: ${required_fix}
Apply ONLY this fix to ${target_file}. Do not make any other changes to this file or any other file — this is a narrow, targeted patch, not a full re-implementation."
    export COORDINATOR_PROMPT_AMENDMENT
    MAX_RETRIES="${ESCALATION_FIX_MAX_RETRIES:-1}"

    implement_story "$sibling_id"
    local fix_result=$?

    COORDINATOR_PROMPT_AMENDMENT="$_saved_amendment"
    export COORDINATOR_PROMPT_AMENDMENT
    MAX_RETRIES="$_saved_max_retries"

    rm -f "$escalation_file"

    if [ "$fix_result" -eq 0 ]; then
        success "  [Escalation] Scoped fix resolved for $sibling_id — resuming $escalating_story_id"
        return 0
    else
        warning "  [Escalation] Scoped fix for $sibling_id did not converge within ${ESCALATION_FIX_MAX_RETRIES:-1} retr(y/ies) — $escalating_story_id will re-diagnose on its next attempt"
        return 1
    fi
}

# check_syntax_class_error <story_id> <current_diagnosis>
# A pure syntax error (unbalanced brace, missing semicolon, unterminated string,
# invalid type assertion, TS10xx/TS11xx parser diagnostics) is never a subtle
# logic mistake that benefits from a same-tier retry with a text hint — the
# model either can/can't produce syntactically valid TypeScript, and repeating
# the SAME model tier just burns attempts waiting for check_healing_effectiveness's
# 2-repeat threshold to fire. Escalate to the next rung on the FIRST occurrence
# instead of waiting for a repeat.
#
# Root cause this fixes (observed live, 2026-07-10, tier3-travel-app run):
# SKY-003-impl hit "Missing closing brace in cli.ts at line 375" and retried at
# the SAME model tier twice before HealingBroken's repeat-of-2 threshold finally
# forced an escalation to z-ai/glm-5.2, which then converged immediately. The
# same class of syntax error (unterminated strings, invalid 'as' syntax, missing
# semicolons) recurred across multiple DIFFERENT stories this session, always
# eventually fixed only after burning 2+ same-tier attempts first.
#
# Second root cause fixed 2026-07-14 (SKY-003-b, tier3-travel-app run): the
# pattern list above never matched "malformed template literal"/"malformed
# array or bracket"/"invalid computed property" -- diagnosis phrasings that
# ARE syntax errors but don't use this list's exact vocabulary -- so this
# function silently never fired for 6 straight retries on the same corrupted
# line, leaving check_healing_effectiveness's slower repeat-of-2 path to do
# all the work instead of the immediate escalation this function exists for.
# Added "malformed" as a fourth generic keyword rather than enumerating every
# specific phrasing (unbounded and language-agnostic, same idiom as the
# existing alternation).
#
# Also root-caused WHY 6 retries never converged even after escalating:
# reading the actual corrupted file (cli.test.ts:260) showed a dropped
# array-closing token merging the tail of one test into the `it(...)` header
# of the next -- a full-file-regeneration boundary glitch. Every retry
# rewrote the ENTIRE file from scratch, so the model kept re-hitting the same
# failure MODE (a long-file generation boundary slip) even as the exact
# corrupted bytes shifted attempt to attempt, which is also why
# failure-analyst's own diagnosis text kept changing without ever
# converging. Persist a generic, role-scoped, permanent skill note the first
# time this fires for a story so this run (or the very next test-writing
# story) tries a different strategy: patch the broken region, don't
# regenerate the whole file. Reuses the same reviewer-gated persist pattern
# already used for failure-analyst's target=skill/kb notes -- deterministic
# exact-duplicate guard, format validated by _skill_note_format_ok, so this
# is written exactly once per role, not once per retry.
check_syntax_class_error() {
    local story_id="$1"
    local diagnosis="$2"
    [ "${HEALING_BROKEN:-0}" = "1" ] && return 0
    if echo "$diagnosis" | grep -qiE \
        'missing (closing|opening) (brace|paren(thesis)?|bracket)|unterminated (string|template)|missing semicolon|invalid type assertion|unexpected token|malformed|\bTS1[01][0-9]{2}\b|syntax error'; then
        log "  [SyntaxClassEscalation] '$diagnosis' matches a syntax-error pattern — escalating immediately instead of waiting for a repeat"
        HEALING_BROKEN=1
        export HEALING_BROKEN

        local _syntax_story_role
        _syntax_story_role=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .agentRole // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ -n "$_syntax_story_role" ] && [ -f "$AGENT_PROFILES_FILE" ]; then
            # Kept under 200 chars deliberately: _skill_note_format_ok's
            # length check (mirrors prd-change-reviewer's own skill_note
            # rule) then short-circuits run_change_with_reviewer_retry
            # straight to "pass" via its deterministic fast path -- no live
            # LLM gate-model call needed for a note this mechanical, and no
            # dependency on ORCH_GATE_PROVIDER being configured at all.
            local _syntax_note="Always patch only the broken line range on a repeated syntax-error retry -- never regenerate the whole file, since a full rewrite tends to reproduce the same corruption elsewhere."
            local _syntax_role_profile
            _syntax_role_profile=$(jq -c --arg role "$_syntax_story_role" '.[$role] // ""' "$AGENT_PROFILES_FILE" 2>/dev/null)
            if ! echo "$_syntax_role_profile" | grep -qF -- "$_syntax_note"; then
                local _syntax_verdict
                _syntax_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                    "$_syntax_role_profile" "$_syntax_note" 3)
                # Fail-closed: only persist on an actual "pass" verdict --
                # a rejected note must never be written, matching every
                # other reviewer-gated write site in this file.
                if [ "$_syntax_verdict" = "pass" ]; then
                    local _syntax_note_final
                    _syntax_note_final=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_syntax_note")
                    local _syntax_tmp_profiles
                    _syntax_tmp_profiles=$(mktemp)
                    chmod 644 "$_syntax_tmp_profiles" 2>/dev/null
                    if jq --arg role "$_syntax_story_role" --arg note "

[Self-Heal] ${_syntax_note_final}" \
                        '(.[$role] // "") |= . + $note' \
                        "$AGENT_PROFILES_FILE" > "$_syntax_tmp_profiles" 2>/dev/null; then
                        mv "$_syntax_tmp_profiles" "$AGENT_PROFILES_FILE"
                        log "  [SyntaxClassEscalation] Persisted targeted-fix-not-full-rewrite skill note to [${_syntax_story_role}] profile"
                    else
                        rm -f "$_syntax_tmp_profiles"
                    fi
                else
                    log "  [SyntaxClassEscalation] Skill note rejected by reviewer — not persisting"
                fi
            fi
        fi
    fi
}

# check_healing_effectiveness <story_id> <current_diagnosis> [retry_num]
# Reads healing-events.jsonl and checks if the same diagnosis has appeared 2+ times
# for this story without a different diagnosis in between. If so, self-healing is
# not working — log a CRITICAL alert and set HEALING_BROKEN=1 to abort retries.
check_healing_effectiveness() {
    local story_id="$1"
    local current_diagnosis="$2"
    local retry_num="${3:-0}"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0
    # Count consecutive same-root-cause events for this story (most recent N events).
    # A naive 20-char exact-prefix match was live-confirmed to miss real repeats: the
    # gate model rarely phrases the same root cause identically twice (e.g. "Code uses
    # '../public/index.html'..." vs "Agent referenced src/public/index.html but didn't
    # create the file..." — same bug, zero shared 20-char prefix). Token-overlap
    # matching catches paraphrased repeats: extract significant words (len>=4, minus
    # stopwords) from each diagnosis and compare against the current one; treat as the
    # same root cause when at least 3 significant words overlap AND that overlap is a
    # sizeable share (>=40%) of the smaller diagnosis's vocabulary. Both thresholds are
    # needed together — overlap-count alone lets short diagnoses false-positive on one
    # shared word; ratio alone lets two long, mostly-unrelated diagnoses match on a
    # handful of incidental shared words (e.g. both mentioning "file" and "server").
    local repeat_count
    repeat_count=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo 0
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    # min(3, ...) scales the absolute-overlap floor down for short diagnoses — a
    # diagnosis with only 2 significant words (e.g. "exact repeats") could never
    # reach a flat floor of 3 even when identical to itself.
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

count = 0
for d in reversed(events):
    if same_root_cause(d, current):
        count += 1
    else:
        break
print(count)
PYEOF
)
    if [ "${repeat_count:-0}" -ge 2 ]; then
        # Deterministic safety net before giving up: a known, mechanical fix may
        # exist for this exact recurring symptom even though the LLM analyst
        # couldn't apply it through its 5-target routing. If found and applied,
        # skip the HEALING_BROKEN escalation entirely and let the next retry use
        # the now-patched file.
        if apply_known_fix "${PROJECT_ROOT:-}" "$current_diagnosis"; then
            log "  [HealingBroken] Deterministic known-fix applied — not counting this as a broken-healing cycle"
            return 0
        fi
        error "  [HealingBroken] CRITICAL: '${current_diagnosis}' has recurred ${repeat_count}+ times for $story_id without a different fix — self-healing is NOT working."
        error "  [HealingBroken] Check: (1) gate model is reachable (2) failure analyst is diagnosing correctly (3) patches are being applied"
        # Write a HEALING_BROKEN sentinel record so the run summary captures this.
        # Include all standard healing-events fields so the dashboard renders it
        # correctly (retry, rung, target, diagnosis must be non-null).
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
        local safe_diag
        safe_diag=$(printf '%s' "$current_diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
        local _broken_rung
        _broken_rung=$(( retry_num / 2 ))
        printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"none","diagnosis":"%s","patches_applied":0,"profile_updated":false,"event":"HEALING_BROKEN","repeated_diagnosis":"%s","count":%s}\n' \
            "$ts" "$story_id" "$retry_num" "$_broken_rung" "$safe_diag" "$safe_diag" "$repeat_count" >> "$heal_log"
        HEALING_BROKEN=1
        export HEALING_BROKEN
    fi
}

# check_failure_diversity <story_id> <retry_num> <current_diagnosis>
# Mirror of check_healing_effectiveness, inverted: that function detects the SAME
# diagnosis repeating (healing is broken, skip ahead). This detects consecutive
# DIFFERENT diagnoses while still on the un-escalated base model (Rung 0-1,
# retries 0-3) — evidence of a genuine capability gap, not a transient mistake
# "one more attempt" will fix. Root cause addressed: SKY-004 spent 4 of 8
# attempts (half its budget) on MiniMax-M3 despite 4 DIFFERENT failures
# surfacing in that window (wrong import path -> incomplete mock factory ->
# missing test import/mock export -> ...), only reaching model escalation at
# attempt 5. Sets EARLY_ESCALATION_NEEDED=1 so the retry loop can jump straight
# to Rung 2 instead of exhausting the rest of the base-model budget on a model
# that's visibly not converging. No-op once the model has already escalated
# (rung >= 2) — this signal only matters before that point.
check_failure_diversity() {
    local story_id="$1"
    local retry_num="$2"
    local current_diagnosis="$3"

    local _rung=$(( retry_num / 2 ))
    [ "$_rung" -ge 2 ] && return 0

    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0

    local is_different
    is_different=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo "false"
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

# events[-1] is the diagnosis just written for THIS attempt (run_healing_recorder
# runs before this check, same ordering as check_healing_effectiveness). Compare
# it against the immediately preceding attempt's diagnosis.
if len(events) < 2:
    print("false")
else:
    prev, cur = events[-2], events[-1]
    print("false" if same_root_cause(prev, cur) else "true")
PYEOF
)

    if [ "$is_different" = "true" ]; then
        warning "  [FailureDiversity] Different failure class than the previous attempt while still on the base model — likely a capability gap, not a transient mistake"
        EARLY_ESCALATION_NEEDED=1
        export EARLY_ESCALATION_NEEDED
    fi
}

# same_root_cause_diagnoses <diagnosis_a> <diagnosis_b>
# Standalone version of the token-overlap comparison embedded in
# check_healing_effectiveness/check_failure_diversity — extracted here because a
# THIRD caller needs it (deterministic-check repeat detection, added live during
# run #15) that already has both text strings in hand and has no reason to read
# or write healing-events.jsonl for this comparison. Echoes "true" or "false".
same_root_cause_diagnoses() {
    local a="$1"
    local b="$2"
    python3 - "$a" "$b" 2>/dev/null << 'PYEOF' || echo "false"
import re, sys

a, b = sys.argv[1], sys.argv[2]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

ta, tb = tokens(a), tokens(b)
if not ta or not tb:
    print("true" if a[:20] == b[:20] else "false")
else:
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    print("true" if len(overlap) >= min_overlap and ratio >= 0.4 else "false")
PYEOF
}

# compute_retry_extension_evidence <story_id>
# Deterministic (no LLM cost) evidence gathering for the retry-extension
# coordinator, computed purely from two JSONL logs that already exist:
#   healing-events.jsonl              (run_healing_recorder, self-heal events
#                                       + the HEALING_BROKEN sentinel record)
#   failure-diagnosis-groundedness.jsonl (run_diagnosis_groundedness_check)
# Prints a single JSON object to stdout:
#   {"total_heal_events":N,"distinct_diagnoses":N,"healing_broken_ever":bool,
#    "avg_groundedness":N,"groundedness_sample_count":N}
compute_retry_extension_evidence() {
    local story_id="$1"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    local grounded_log="${LOG_DIR}/failure-diagnosis-groundedness.jsonl"

    local total_heal_events=0 distinct_diagnoses=0 healing_broken_ever="false"
    if [ -f "$heal_log" ]; then
        total_heal_events=$(jq -r --arg s "$story_id" 'select(.story_id == $s and .event != "HEALING_BROKEN")' "$heal_log" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
        # NOTE: `grep -c .` exits 1 (even though it correctly PRINTS "0")
        # when zero lines match -- under this script's `set -e`, a bare
        # `local var=$(pipeline-ending-in-grep-c)` with no matches SILENTLY
        # ABORTS THE WHOLE FUNCTION (and, being under set -e, potentially
        # the whole claude.sh process) the moment any story has zero heal
        # events -- the common/healthy case. Confirmed via direct
        # `set -e` reproduction while building this. `wc -l` exits 0
        # unconditionally and prints "0" for empty input just as correctly
        # -- use that instead, never grep -c, for any count-of-lines-that-
        # might-be-zero computation under this file's set -e.
        distinct_diagnoses=$(jq -r --arg s "$story_id" 'select(.story_id == $s and .event != "HEALING_BROKEN") | .diagnosis' "$heal_log" 2>/dev/null | sort -u | wc -l | tr -d ' ')
        if jq -e --arg s "$story_id" 'select(.story_id == $s and .event == "HEALING_BROKEN")' "$heal_log" >/dev/null 2>&1; then
            healing_broken_ever="true"
        fi
    fi

    local avg_groundedness=0 groundedness_sample_count=0
    if [ -f "$grounded_log" ]; then
        groundedness_sample_count=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false)' "$grounded_log" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
        if [ "${groundedness_sample_count:-0}" -gt 0 ] 2>/dev/null; then
            avg_groundedness=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false) | .score' "$grounded_log" 2>/dev/null | \
                python3 -c "
import sys
scores = [float(l) for l in sys.stdin if l.strip()]
print(sum(scores)/len(scores) if scores else 0)
" 2>/dev/null || echo 0)
        fi
    fi

    jq -nc --argjson total "${total_heal_events:-0}" --argjson distinct "${distinct_diagnoses:-0}" \
        --argjson broken "$healing_broken_ever" --argjson avg "${avg_groundedness:-0}" \
        --argjson samples "${groundedness_sample_count:-0}" \
        '{total_heal_events:$total, distinct_diagnoses:$distinct, healing_broken_ever:$broken, avg_groundedness:$avg, groundedness_sample_count:$samples}'
}

# resolve_role_retry_extension_max <story_id>
# Reads EPAM_ROLE_RETRY_EXTENSION_MAP (pipe-separated "agentRole=max" pairs,
# same convention as EPAM_MODEL_LADDER_*/EPAM_MODEL_PROVIDER_MAP) and returns
# the extension cap for the story's agentRole, falling back to
# EPAM_RETRY_EXTENSION_MAX (default 2) when the role has no entry. agentRole
# is whatever the pipeline itself assigned in prd.json (Step 0.5/0.9) --
# never a hardcoded project-specific value here.
resolve_role_retry_extension_max() {
    local story_id="$1"
    local default_max="${EPAM_RETRY_EXTENSION_MAX:-2}"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    [ -z "$role" ] && { echo "$default_max"; return 0; }
    local map pair from to ifs_save="$IFS"
    map="${EPAM_ROLE_RETRY_EXTENSION_MAP:-test-engineer=4}"
    IFS='|'; read -ra pairs <<< "$map"; IFS="$ifs_save"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"; to="${pair#*=}"
        if [ "$role" = "$from" ]; then
            echo "$to"
            return 0
        fi
    done
    echo "$default_max"
}

# run_retry_extension_coordinator <story_id>
# Dynamic self-heal augmentation (2026-07-12, user request): a story that
# exhausted MAX_RETRIES with genuine, converging progress (each failure a
# DIFFERENT diagnosed bug, not a repeat) shouldn't necessarily be abandoned
# at a fixed, one-size-fits-all ceiling. This is a bounded, evidence-gated
# extension of that ceiling — NOT free-form LLM re-judgment of the hardcoded
# limit: deterministic evidence is computed first, and the LLM is only
# consulted when that evidence is genuinely ambiguous (see the pre-gate
# below), mirroring the "trust the deterministic oracle over an LLM opinion"
# principle already used elsewhere in this pipeline (e.g. SAST/spec-
# validator's blockerCount-over-self-reported-verdict trust).
#
# Prints the number of EXTRA retries granted (0 if not extending) to stdout.
# Fails closed (prints 0) on any error, disabled state, or malformed gate
# response -- this must never be able to grant an extension it can't justify
# with real evidence.
run_retry_extension_coordinator() {
    local story_id="$1"
    if [ "${EPAM_RETRY_EXTENSION_ENABLED:-0}" != "1" ]; then
        echo 0
        return 0
    fi

    local evidence
    evidence=$(compute_retry_extension_evidence "$story_id")
    if [ -z "$evidence" ] || ! echo "$evidence" | jq empty 2>/dev/null; then
        echo 0
        return 0
    fi

    local total_heal_events distinct_diagnoses healing_broken_ever
    total_heal_events=$(echo "$evidence" | jq -r '.total_heal_events')
    distinct_diagnoses=$(echo "$evidence" | jq -r '.distinct_diagnoses')
    healing_broken_ever=$(echo "$evidence" | jq -r '.healing_broken_ever')

    # Deterministic pre-gate: skip the LLM call entirely when the evidence
    # already answers the question. A repeated (non-distinct) diagnosis, or
    # a HEALING_BROKEN sentinel, is direct proof of non-convergence -- no
    # amount of LLM judgment changes that, so don't spend a gate-model call
    # asking.
    if [ "$healing_broken_ever" = "true" ] || [ "${distinct_diagnoses:-0}" -lt "${total_heal_events:-0}" ] 2>/dev/null; then
        # >&2: this function's return value is captured by the caller via
        # $(...) -- log() writes to STDOUT (see its own definition), so
        # without this redirect the log line gets mixed INTO the captured
        # "0" below, corrupting it into a multi-line non-numeric string.
        # Found live (2026-07-13, SKY-003): the caller's numeric
        # `[ "$_granted_extra_retries" -gt 0 ]` check silently failed on the
        # corrupted capture, so a genuinely GRANTED extension (proven by
        # retry-extension-decisions.jsonl showing extraRetriesGranted:2) was
        # never actually applied -- the story was still marked failed.
        log "  [RetryExtension] $story_id: evidence shows non-convergence (healing_broken=$healing_broken_ever distinct=$distinct_diagnoses/$total_heal_events) — not extending, no gate call made" >&2
        echo 0
        return 0
    fi

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${ORCH_GATE_MODEL:-}"
    if [ -z "$gate_provider" ]; then
        echo 0
        return 0
    fi

    local profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    local coordinator_profile=""
    if [ -f "$profiles_file" ]; then
        coordinator_profile=$(jq -r '."retry-extension-coordinator" // ""' "$profiles_file" 2>/dev/null || echo "")
    fi
    [ -z "$coordinator_profile" ] && coordinator_profile="You are the retry-extension coordinator. Given hard evidence about a story's self-heal history, decide whether one more bounded batch of retries is pragmatic."

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local ac_count
    ac_count=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | ((.acceptanceCriteria // []) | length)' "$prd_target" 2>/dev/null || echo 0)

    local coord_prompt
    coord_prompt="${coordinator_profile}

STORY: ${story_id}
Current retry_count: ${retry_count:-unknown} / MAX_RETRIES: ${MAX_RETRIES:-unknown}
Acceptance criteria count (scope proxy): ${ac_count}

EVIDENCE (pre-computed, treat as ground truth -- do not re-derive):
${evidence}

Every self-heal attempt so far produced a DISTINCT diagnosis (no repeats), and no HEALING_BROKEN sentinel has fired -- this story is showing real, converging progress, not a stuck loop. Decide if extending its retry budget is pragmatic.

Output ONLY: {\"extend\":true|false,\"extraRetries\":<1-3>,\"reason\":\"<one sentence>\"}"

    local coord_raw=""
    coord_raw=$(echo "$coord_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"coordinator unavailable"}')

    local extend="false" extra_retries=0 reason=""
    local parsed
    parsed=$(echo "$coord_raw" | python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(json.dumps(obj))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'\{[^{}]*\"extend\"[^{}]*\}', text, re.DOTALL)
if m:
    try:
        print(json.dumps(json.loads(m.group(0))))
        sys.exit(0)
    except Exception:
        pass
print(json.dumps({\"extend\": False, \"extraRetries\": 0, \"reason\": \"unparseable\"}))
" 2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"unparseable"}')

    extend=$(echo "$parsed" | jq -r '.extend // false' 2>/dev/null || echo "false")
    extra_retries=$(echo "$parsed" | jq -r '.extraRetries // 0' 2>/dev/null || echo 0)
    reason=$(echo "$parsed" | jq -r '.reason // ""' 2>/dev/null || echo "")

    local granted=0
    if [ "$extend" = "true" ]; then
        local _max
        _max=$(resolve_role_retry_extension_max "$story_id")
        granted="$extra_retries"
        [ "$granted" -gt "$_max" ] 2>/dev/null && granted="$_max"
        [ "$granted" -lt 0 ] 2>/dev/null && granted=0
        # Re-validate is an int; a malformed extraRetries (non-numeric) fails closed.
        case "$granted" in
            ''|*[!0-9]*) granted=0 ;;
        esac
    fi

    mkdir -p "${OUTPUT_DIR:-$LOG_DIR}" 2>/dev/null
    jq -nc --arg story "$story_id" --argjson evidence "$evidence" --arg extend "$extend" \
        --argjson granted "${granted:-0}" --arg reason "$reason" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, evidence: $evidence, extend: ($extend == "true"), extraRetriesGranted: $granted, reason: $reason, timestamp: $ts}' \
        >> "${OUTPUT_DIR:-$LOG_DIR}/retry-extension-decisions.jsonl" 2>/dev/null || true

    if [ "${granted:-0}" -gt 0 ] 2>/dev/null; then
        # >&2 -- see the identical rationale at this function's other log
        # call above (the pre-gate decline path). This was the exact site
        # where a genuinely granted extension got silently dropped live.
        log "  [RetryExtension] $story_id: extending by $granted retr(y/ies) — $reason" >&2
    fi
    echo "${granted:-0}"
    return 0
}

# Invoke Claude CLI to implement a story
implement_story() {
    local story_id=$1
    local retry_count=0
    # Shadows the script-global MAX_RETRIES for the duration of THIS story
    # only. run_retry_extension_coordinator() (below) can bump this local
    # copy when it grants a bounded extension -- shadowing it here (rather
    # than mutating and manually restoring the global) means bash itself
    # guarantees the original value comes back on EVERY exit path from this
    # function (success mid-loop return, or the failure path at the bottom),
    # with no risk of a granted extension leaking into the NEXT story's
    # budget in the same claude.sh process.
    local MAX_RETRIES="$MAX_RETRIES"
    local _retry_extension_used=0
    # Caps free retries granted for deterministic-check failures (see
    # DETERMINISTIC_CHECK_FAILURE) — these don't count against retry_count/the
    # ladder, but an unbounded free-retry loop is still a real risk if a check
    # keeps finding a violation the agent can't seem to fix. After this many
    # free retries, fall through to a normal counted retry instead.
    local _free_retry_count=0
    # Counts every actual invocation (unlike retry_count, which free retries
    # deliberately do NOT advance) — used to gate COORDINATOR_PROMPT_AMENDMENT
    # injection below ("is this the first attempt of THIS story or not").
    local _total_attempts=0
    # Tracks the last deterministic-check violation message for this story, so a
    # repeat can be detected WITHOUT going through run_failure_analyst (which
    # deterministic-check failures deliberately skip). Confirmed live (run #15,
    # 2026-07-05): without this, the SAME relative-import-check violation
    # repeated 5 times across free AND counted retries with no escalation at
    # all, because check_healing_effectiveness's repeat detector only runs
    # inside run_failure_analyst.
    local _prev_deterministic_violation=""
    # run_implementation() processes multiple stories in one claude.sh
    # invocation; COORDINATOR_PROMPT_AMENDMENT is a script-global set by the
    # previous story's failure-analyst/deterministic-check path and was never
    # reset between stories, so a stale amendment from story A could otherwise
    # leak into story B's first attempt.
    COORDINATOR_PROMPT_AMENDMENT=""
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
    # Resolve generator mode — overrides effort settings when agentRole=generator
    resolve_generator_settings "$story_id"
    # Bump the iteration/token budget one tier for test-engineer stories —
    # see resolve_test_engineer_effort_floor's own docstring for why.
    resolve_test_engineer_effort_floor "$story_id"
    # Floor the output/iteration budget for brownfield reasoning-model runs so
    # the <think> block + the actual edit both fit in one response — see
    # resolve_brownfield_effort_floor's docstring (found live: reasoning
    # truncated mid-think before writing → "deliverables UNCHANGED").
    resolve_brownfield_effort_floor "$story_id"
    log "  Effort[final] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"

    # ── Self-heal KB (pillar 3: enforcement) ─────────────────────────────────
    # Applied AFTER effort resolution and BEFORE the invocation, so a learned
    # constraint overrides the computed default rather than being overwritten by
    # it. Arrives as parameters, never as prompt text. Flag-guarded and inert by
    # Always on — self-heal is not optional (switch removed 2026-07-25).
    if true; then
        local _kb_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_lib"
            kb_apply_constraints "${STORY_ROLE:-}" "story:${story_id:-}" || true
            # Pillar 2: rules that fired stay alive, rules that did not age toward
            # their TTL and are archived for re-validation instead of trusted forever.
            kb_tick "${KB_LAST_FIRED:-}" || true
            [ -n "${KB_LAST_FIRED:-}" ] && \
                log "  Effort[KB] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS} (${KB_LAST_FIRED})"
        fi
    fi
    # Resolve aiProvider -> which CLI binary to use
    resolve_provider_settings "$story_id"
    # Capture original model so phase R3 can detect whether R2 escalated it
    STORY_MODEL_ORIGINAL="${STORY_MODEL:-}"
    # Reset reasoning effort to default at story start (previous story's setting must not leak)
    export EPAM_REASONING_EFFORT="low"
    # Reset temperature override at story start (previous story's FailureDiversity
    # or escalation-triggered override must not leak into an unrelated story) —
    # but restore the launcher-provided floor (_claude_temperature_floor, captured
    # once at process start) rather than unsetting to nothing. Without this, a
    # project-wide pin (e.g. tier3-travel-app-run.sh's EPAM_TEMPERATURE=0 for GLM
    # models) would be wiped before the very first model call of every story.
    if [ -n "$_claude_temperature_floor" ]; then
        export EPAM_TEMPERATURE="$_claude_temperature_floor"
    else
        unset EPAM_TEMPERATURE
    fi
    # For epam-run providers, prd.json .model field overrides effort-based model
    case "${STORY_PROVIDER:-codex}" in
        codex) resolve_codex_model_settings "$story_id" ;;
        copilot|openai|qwen|cursor|minimax) resolve_model_from_story "$story_id" ;;
    esac
    # prd-model-coordinator's .reasoningEffort field overrides the "low" reset above
    resolve_reasoning_effort_from_story "$story_id"
    # Resolve optional plannerModel — runs a planning pass before execution
    resolve_planner_settings "$story_id"
    # Resolve dynamic constitution rules for this story (appends to AGENT_CONSTITUTION)
    resolve_dynamic_constitution "$story_id"
    # Brownfield surgeon preamble — injected when EPAM_BROWNFIELD=1; never active in greenfield.
    # Rules numbered from 6 to extend the five already in AGENT_CONSTITUTION without overlap.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        DYNAMIC_CONSTITUTION="${DYNAMIC_CONSTITUTION}

BROWNFIELD SURGEON MODE — non-negotiable (applies to every story in this run):
6. FIND FIRST: Before writing a single line of code, locate the existing code path that handles the behavior described in this story. Use Search, Glob, or Read. Do not skip this step.
7. FIX MINIMALLY: Make the smallest change that corrects the behavior. Do not restructure, refactor, or extend surrounding code.
8. NO NEW FILES BY DEFAULT: Do not create new files, services, or abstractions unless the story description explicitly uses the words 'create', 'add new', or 'build new'. A bug report or a change request means modifying existing code.
9. USE EXISTING HELPERS: Before writing any new function or utility, search the codebase for an existing one that already serves the same purpose."
    fi
    # GAP-P17: inject outputSchema instruction when story defines one
    local schema_block=""
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_output_schema
    story_output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_output_schema" ]; then
        schema_block=$'\n\nOUTPUT SCHEMA REQUIREMENT:\nYou MUST conclude your response with a JSON object that conforms to the following JSON Schema. Wrap it in a ```json code block.\n```json\n'"$story_output_schema"$'\n```'
        log "  OutputSchema: structured output required for $story_id"
    fi
    # Build effective constitution = static base + dynamic rules + optional schema block.
    # Mirrors CLAUDE_PERMISSIONS: empty in interactive mode (no skip-permissions).
    local effective_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}${schema_block}"
    local effective_permissions=()
    if [ ${#CLAUDE_PERMISSIONS[@]} -gt 0 ]; then
        effective_permissions=(
            "--dangerously-skip-permissions"
            "--append-system-prompt"
            "$effective_constitution"
        )
    fi
    local model_flag=()
    local turns_flag=()
    [ -n "${STORY_MODEL:-}" ]     && model_flag=(--model "$STORY_MODEL")
    [ -n "${STORY_MAX_TURNS:-}" ] && turns_flag=(--max-turns "$STORY_MAX_TURNS")
    local story_cli
    story_cli=$(provider_to_cli "${STORY_PROVIDER:-codex}")

    # Planning phase: when plannerModel is set, run one planning invocation first.
    # The returned plan is injected into every execution attempt as fixed context.
    local story_plan=""
    if [ -n "${STORY_PLANNER_MODEL:-}" ]; then
        log "  Running planning phase with $STORY_PLANNER_MODEL..."
        story_plan=$(run_planning_phase "$story_id" "$STORY_PLANNER_MODEL")
        story_plan=$(review_and_correct_plan "$story_id" "$story_plan")
        local plan_words
        plan_words=$(echo "$story_plan" | wc -w)
        log "  Planning phase complete ($plan_words words, reviewed)"
    fi

    while true; do
    while [ $retry_count -le $MAX_RETRIES ]; do
        _total_attempts=$((_total_attempts + 1))
        # Inference ladder: on retry, escalate to a stronger model + increase reasoning effort.
        # Priority: PRD retryModel > EPAM_RETRY_MODEL env var > built-in get_model_ladder_step().
        # Principle: NEVER retry with the same model — every failure steps up. Logged visibly.
        if [ "$retry_count" -gt 0 ]; then
            # ── Rung-based inference ladder ────────────────────────────────────────
            # 2 attempts per rung: attempt 1 (cold), self-healing fires, attempt 2
            # (informed). Escalate only when entering a new rung.
            #
            # Rung 0 (retries 0-1): base model, base effort
            # Rung 1 (retries 2-3): same model, reasoning effort → medium
            # Rung 2 (retries 4-5): escalated model, reasoning effort → medium
            # Rung 3 (retries 6-7): escalated model, reasoning effort → high
            # ──────────────────────────────────────────────────────────────────────
            local _rung=$(( retry_count / 2 ))
            local _entering_rung=$(( retry_count % 2 == 0 ))   # 1 = first attempt of rung

            # skipLadder: set by spec-mode-runner.js (veryHighComplexity AC-count)
            # or lib/tc-writer-gate.sh (TC-fact-density). Both pre-assign the
            # ceiling model before the first attempt. skipLadder=true means
            # DOWNGRADE PREVENTION ONLY — if a higher ladder step exists above the
            # current model, escalation proceeds normally. Only when the ladder has
            # no higher step (get_model_ladder_step returns same or empty) does the
            # story stay at its current ceiling. Effort/iteration-budget escalation
            # always applies regardless of skipLadder.
            local _skip_ladder
            _skip_ladder=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .skipLadder // false' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo false)

            local _prev_model="${STORY_MODEL:-}"
            if [ "$_entering_rung" -eq 1 ]; then
                case "$_rung" in
                    1)
                        # Rung 1: same model, effort → medium, temperature stays 0
                        export EPAM_REASONING_EFFORT="medium"
                        export EPAM_TEMPERATURE="0"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        log "  InferenceLadder[Rung1/R${retry_count}]: model='${STORY_MODEL:-default}' unchanged — effort → medium"
                        ;;
                    2)
                        # Rung 2: model escalation, effort → medium
                        # skipLadder=true means the story was pre-assigned a ceiling model by
                        # tc-writer-gate or spec-mode (very-high-complexity). We still compute the
                        # next ladder step — if one exists ABOVE the current model we apply it
                        # (upward escalation is always allowed). We only stay put when the ladder
                        # has nowhere higher to go (same model returned or no step found).
                        local retry_model_prd ladder_step_r2
                        retry_model_prd=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        local escalated_model_r2="${retry_model_prd:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$escalated_model_r2" ]; then
                            local _ladder_tier
                            _ladder_tier=$(classify_ladder_tier "$story_id")
                            ladder_step_r2=$(get_model_ladder_step "${STORY_MODEL:-}" "$_ladder_tier")
                            [ -n "$ladder_step_r2" ] && escalated_model_r2="$ladder_step_r2"
                            log "  InferenceLadder[Rung2/R${retry_count}]: tier=${_ladder_tier}"
                        fi
                        if [ -n "$escalated_model_r2" ] && [ "$escalated_model_r2" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung2/R${retry_count}]: model '${STORY_MODEL:-default}' → '$escalated_model_r2' — effort → medium"
                            STORY_MODEL="$escalated_model_r2"
                            local _resolved_provider_r2
                            _resolved_provider_r2=$(resolve_model_provider "$escalated_model_r2")
                            [ -n "$_resolved_provider_r2" ] && STORY_PROVIDER="$_resolved_provider_r2"
                        else
                            # Stuck at ceiling — check if HealingBroken is confirmed in
                            # healing-events.jsonl. When skipLadder=true pre-assigns the ceiling
                            # model and self-healing hasn't converged, model diversity is the only
                            # remaining lever. Force HIGH-tier escalation so a different model
                            # gets a chance — skipLadder is downgrade-prevention, not a lock
                            # against upward escalation under confirmed healing failure.
                            local _healed_count=0
                            if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                _healed_count=$(python3 -c "
import json
count = 0
try:
    for line in open('${LOG_DIR}/healing-events.jsonl'):
        try:
            e = json.loads(line)
            if e.get('story_id') == '$story_id':
                count += 1
        except Exception:
            pass
except Exception:
    pass
print(count)
" 2>/dev/null || echo 0)
                            fi
                            local _high_step=""
                            if [ "${_healed_count:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ]; then
                                _high_step=$(get_model_ladder_step "${STORY_MODEL:-}" "high")
                                if [ -n "$_high_step" ] && [ "$_high_step" != "${STORY_MODEL:-}" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step' for model diversity"
                                    STORY_MODEL="$_high_step"
                                    local _resolved_provider_r2h
                                    _resolved_provider_r2h=$(resolve_model_provider "$_high_step")
                                    [ -n "$_resolved_provider_r2h" ] && STORY_PROVIDER="$_resolved_provider_r2h"
                                fi
                            fi
                            if [ -z "$_high_step" ] || [ "$_high_step" = "${STORY_MODEL:-}" ]; then
                                if [ "$_skip_ladder" = "true" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → medium"
                                else
                                    log "  InferenceLadder[Rung2/R${retry_count}]: no ladder step — keeping model, effort → medium"
                                fi
                            fi
                        fi
                        export EPAM_REASONING_EFFORT="medium"
                        export EPAM_TEMPERATURE="0.3"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        # Rung 2: bump output tokens to 8192 — a story that needed
                        # escalation is likely generating larger outputs than the
                        # baseline budget assumed; truncation at the original ceiling
                        # causes the same syntax error on every retry regardless of
                        # model capability (confirmed live: SKY-003-test-tc2 2026-07-18).
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt 8192 ] && STORY_MAX_OUTPUT_TOKENS=8192
                        ;;
                    *)
                        # Rung 3+: escalate to the strongest configured model, effort → high (maximum).
                        #
                        # BUG (found live, 2026-07-04): this branch only ever escalated the model
                        # when the story had had ZERO prior escalation (STORY_MODEL == the
                        # original). But every story that reaches Rung 3 already escalated once at
                        # Rung 2 by construction — so that condition was always false here, and
                        # Rung 3 silently kept Rung 2's model, only bumping the reasoning-effort
                        # flag. Confirmed on SKY-004: attempts 5-8 all ran on z-ai/glm-5.2 (the
                        # MEDIUM-tier target); z-ai/glm-5.1 (the HIGH-tier target, configured
                        # specifically for hard stories) was never invoked in the entire 8-attempt
                        # cycle. Fix: if the story already escalated once, step it again — from
                        # whatever model Rung 2 landed on.
                        #
                        # BUG 2 (found live, 2026-07-05): this branch originally passed a hardcoded
                        # literal "high" to get_model_ladder_step, instead of the story's ACTUAL
                        # classified tier — silently pushing a "medium"-complexity story onto the
                        # HIGH ladder anyway, overriding what classify_ladder_tier() (now populated
                        # from real CPA complexity signals: cpaGate/effort, see
                        # contextualize-stories.sh) says this story needs. Fixed: call
                        # classify_ladder_tier() here too, same as Rung 2 — the PRD's classified
                        # tier is the ceiling all the way through the ladder, not just at Rung 2.
                        # skipLadder=true: same as Rung 2 — only prevents downgrade,
                        # upward escalation still applies if a higher step exists.
                        local _ffm="${EPAM_FINAL_FALLBACK_MODEL:-}" _ffp="${EPAM_FINAL_FALLBACK_PROVIDER:-}"
                        if [ -n "$_ffm" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_ORIGINAL:-}" ]; then
                            log "  InferenceLadder[Rung3/R${retry_count}]: no prior escalation — routing to fallback '$_ffm'"
                            STORY_MODEL="$_ffm"
                            [ -n "$_ffp" ] && STORY_PROVIDER="$_ffp"
                        else
                            local _ladder_tier_r3
                            _ladder_tier_r3=$(classify_ladder_tier "$story_id")
                            log "  InferenceLadder[Rung3/R${retry_count}]: tier=${_ladder_tier_r3}"
                            local ladder_step_r3
                            ladder_step_r3=$(get_model_ladder_step "${STORY_MODEL:-}" "$_ladder_tier_r3")
                            if [ -n "$ladder_step_r3" ] && [ "$ladder_step_r3" != "${STORY_MODEL:-}" ]; then
                                log "  InferenceLadder[Rung3/R${retry_count}]: model '${STORY_MODEL:-default}' → '$ladder_step_r3' (${_ladder_tier_r3} tier)"
                                STORY_MODEL="$ladder_step_r3"
                                local _resolved_provider_r3
                                _resolved_provider_r3=$(resolve_model_provider "$ladder_step_r3")
                                [ -n "$_resolved_provider_r3" ] && STORY_PROVIDER="$_resolved_provider_r3"
                            else
                                # Same HealingBroken+skipLadder override as Rung 2: when stuck
                                # at ceiling and self-healing is confirmed broken, force HIGH tier.
                                local _healed_count_r3=0
                                if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                    _healed_count_r3=$(python3 -c "
import json
count = 0
try:
    for line in open('${LOG_DIR}/healing-events.jsonl'):
        try:
            e = json.loads(line)
            if e.get('story_id') == '$story_id':
                count += 1
        except Exception:
            pass
except Exception:
    pass
print(count)
" 2>/dev/null || echo 0)
                                fi
                                local _high_step_r3=""
                                if [ "${_healed_count_r3:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ] && [ "$_ladder_tier_r3" != "high" ]; then
                                    _high_step_r3=$(get_model_ladder_step "${STORY_MODEL:-}" "high")
                                    if [ -n "$_high_step_r3" ] && [ "$_high_step_r3" != "${STORY_MODEL:-}" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step_r3'"
                                        STORY_MODEL="$_high_step_r3"
                                        local _resolved_provider_r3h
                                        _resolved_provider_r3h=$(resolve_model_provider "$_high_step_r3")
                                        [ -n "$_resolved_provider_r3h" ] && STORY_PROVIDER="$_resolved_provider_r3h"
                                    fi
                                fi
                                if [ -z "$_high_step_r3" ] || [ "$_high_step_r3" = "${STORY_MODEL:-}" ]; then
                                    if [ "$_skip_ladder" = "true" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → high (maximum)"
                                    fi
                                fi
                            fi
                        fi
                        export EPAM_REASONING_EFFORT="high"
                        export EPAM_TEMPERATURE="0.7"
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + 5 ))
                        # Rung 3: bump output tokens to 12288 — at the strongest
                        # configured model, full file rewrites are expected; any
                        # prior token ceiling that caused truncation must be lifted.
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt 12288 ] && STORY_MAX_OUTPUT_TOKENS=12288
                        log "  InferenceLadder[Rung3/R${retry_count}]: model='${STORY_MODEL:-default}' — effort → high"
                        ;;
                esac
                # Emit ladder_rung event so agent-activity dashboard shows every escalation,
                # including prev→new model transition for observability.
                local _ladder_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_ladder_event_script" ]; then
                    local _ladder_role
                    _ladder_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_ladder_event_script" event "ladder_rung" \
                        "InferenceLadder Rung${_rung}/R${retry_count}: ${_prev_model:-default}→${STORY_MODEL:-default} effort=${EPAM_REASONING_EFFORT:-low}" \
                        "$story_id" "main" "${_ladder_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" "${_prev_model:-}" 2>/dev/null || true
                fi
            else
                log "  InferenceLadder[Rung${_rung}/R${retry_count}]: same rung — no escalation, self-heal guidance active"
                local _retry_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_retry_event_script" ]; then
                    local _retry_role
                    _retry_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_retry_event_script" event "retry" \
                        "Retry R${retry_count} Rung${_rung}: model=${STORY_MODEL:-default} (self-heal active)" \
                        "$story_id" "main" "${_retry_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
                fi
            fi
        fi
        # Rebuild prompt each attempt: retry_count and KB ID must reflect current state
        local next_kb_id
        next_kb_id=$(get_next_kb_id)
        local prompt
        if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
            prompt="$(build_generator_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
        else
            prompt="$(build_implementation_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
        fi
        # Inject execution plan when planner/executor split is active
        if [ -n "${story_plan:-}" ]; then
            prompt="$prompt

## Execution Plan
Follow this plan step by step:
$story_plan"
        fi

        # Inject coordinator prompt amendment when available (retry attempts only).
        # Uses _total_attempts, not retry_count — a free retry (deterministic-check
        # failure) doesn't advance retry_count, but it IS a real subsequent attempt
        # and must still see the guidance from what just failed.
        if [ "$_total_attempts" -gt 1 ] && [ -n "${COORDINATOR_PROMPT_AMENDMENT:-}" ]; then
            prompt="$prompt

## Coordinator Guidance (retry ${retry_count})
The following targeted instruction was identified from the previous failure:
${COORDINATOR_PROMPT_AMENDMENT}"
        fi

        # Prompt-size scratchpad summarization (found live, 2026-07-07): each retry
        # PREPENDS a new "## Self-Heal: Failure Analyst Summary"/coordinator-guidance
        # block onto COORDINATOR_PROMPT_AMENDMENT without ever dropping older ones —
        # by attempt 4-5 within a single claude.sh invocation the cumulative prompt
        # is measurably larger than attempt 1's, and a model reasoning over a bigger
        # prompt can legitimately take long enough to blow the watchdog's timeout
        # budget for that story. Root cause was misread at first as model/API
        # instability (see the hot-swap mechanism above) — a live process
        # inspection confirmed a genuine, still-connected, in-flight API call, not a
        # stuck/crashed one; the real issue is unbounded prompt growth.
        # Fix: once the prompt exceeds a configurable size, persist the FULL prompt
        # (with complete retry history) to a scratchpad file for audit/debugging,
        # then trim the in-prompt coordinator guidance down to only the MOST
        # RECENT "## "-headed section — the model still gets the latest, most
        # relevant guidance; it just isn't re-reading every prior attempt's guidance
        # every single retry. Opt-out: EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=0
        # disables trimming entirely.
        local _scratchpad_threshold="${EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS:-16000}"
        if [ "$_scratchpad_threshold" -gt 0 ] && [ "${#prompt}" -gt "$_scratchpad_threshold" ]; then
            local _scratchpad_dir="${LOG_DIR}/kb-scratchpad"
            mkdir -p "$_scratchpad_dir" 2>/dev/null || true
            local _scratchpad_file="${_scratchpad_dir}/${story_id}-attempt-$((retry_count + 1)).md"
            printf '%s' "$prompt" > "$_scratchpad_file" 2>/dev/null || true

            local _trimmed_amendment
            # Keep the last 3 headings, not just 1 (fixed 2026-07-11, after a live
            # run repeated an identical mistake 5 retries after already being told
            # not to): retry-0's diagnosed fix ("don't reuse validation logic
            # across flags") became invisible to retry 5's prompt the moment a
            # NEWER heading (e.g. a missing-export fix) pushed the trim window past
            # it -- the guidance was still archived in COORDINATOR_PROMPT_AMENDMENT
            # and the scratchpad file, but never shown to the model again, so it
            # repeated the exact mistake it had already been corrected on. Keeping
            # the last 3 distinct headings instead of 1 still bounds prompt growth
            # (the original purpose of this trim) while giving recent-but-not-
            # newest guidance a real chance to stay visible for a few more retries.
            _trimmed_amendment=$(printf '%s' "$COORDINATOR_PROMPT_AMENDMENT" | python3 -c "
import sys
text = sys.stdin.read()
lines = text.split(chr(10))
heading_idxs = [i for i, l in enumerate(lines) if l.startswith('## ')]
keep_from = heading_idxs[-3] if len(heading_idxs) >= 3 else (heading_idxs[0] if heading_idxs else 0)
print(chr(10).join(lines[keep_from:]) if heading_idxs else text)
" 2>/dev/null || echo "$COORDINATOR_PROMPT_AMENDMENT")

            if [ -n "$_trimmed_amendment" ] && [ "${#_trimmed_amendment}" -lt "${#COORDINATOR_PROMPT_AMENDMENT}" ]; then
                warning "  [PromptScratchpad] Prompt exceeded ${_scratchpad_threshold} chars ($(( ${#prompt} )) actual) — full history written to $_scratchpad_file, trimming to most recent guidance (up to 3)"
                if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
                    prompt="$(build_generator_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
                else
                    prompt="$(build_implementation_prompt "$story_id")
$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")"
                fi
                if [ -n "${story_plan:-}" ]; then
                    prompt="$prompt

## Execution Plan
Follow this plan step by step:
$story_plan"
                fi
                prompt="$prompt

## Coordinator Guidance (retry ${retry_count}, showing most recent up to 3 — full retry history: ${_scratchpad_file})
${_trimmed_amendment}"
            fi
        fi

        # Log the prompt
        echo "=== Prompt for $story_id (attempt $((retry_count + 1))) ===" >> "$output_file"
        echo "$prompt" >> "$output_file"
        echo "=== End Prompt ===" >> "$output_file"
        echo "" >> "$output_file"

        log "Invoking $story_cli (attempt $((retry_count + 1))/$((MAX_RETRIES + 1)))..."

        # Proactive dependency install, BEFORE the vendor lock is applied for
        # this attempt (found live, 2026-07-13, SKY-004-test): a source/test
        # file written by an EARLIER attempt can already import a package
        # missing from package.json. Without this, the agent discovers the
        # gap itself mid-turn and — despite the skill addendum warning it not
        # to — tries to `chmod` node_modules writable and `npm install` the
        # package directly, which touches many UNRELATED transitive
        # dependency files (npm's own hoisting/dedup side effects) and trips
        # run_vendor_integrity_check's tamper detector post-turn. That check
        # then hard-fails BEFORE the existing post-turn run_dependency_check
        # call (further below in run_external_verification) ever runs — so
        # the one mechanism that would have installed the dependency safely
        # never got the chance. Running it here, before the lock, means the
        # dependency is already satisfied by the time the agent's turn
        # starts, so there's nothing left for the agent to (mis)fix itself.
        run_dependency_check "$PROJECT_ROOT"

        # Vendor-dir guard: lock configured vendored-dependency directories
        # (e.g. node_modules) read-only — no story ever legitimately writes
        # inside an already-installed third-party package. No-op if
        # .epam/dependency-check.json has no vendorDirs configured.
        # EPAM_VENDOR_GUARD_ENABLED defaults to 0 (off): on a local machine the
        # risk of fake-test injection is low and the lock blocks legitimate
        # dependency installs (e.g. cors) causing unnecessary story failures.
        # Set EPAM_VENDOR_GUARD_ENABLED=1 in CI/multi-tenant environments.
        if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
            _vendor_lock "$PROJECT_ROOT"
        fi

        # Change to project root for the CLI to have correct context
        cd "$PROJECT_ROOT"

        echo "=== $story_cli Output (attempt $((retry_count + 1))) ===" >> "$output_file"

        local json_result_file="${output_file%.log}_result.json"
        local invoke_success=false
        # Track the raw output file across all provider branches for coordinator triage
        local attempt_raw_file="${json_result_file%.json}_raw.json"
        local attempt_started_at=$(date -Iseconds)

        # Optional per-story wall-clock timeout — set EPAM_STORY_TIMEOUT_SECS in the tier script.
        # No default: if unset, no timeout is applied (behaviour is unchanged).
        local _timeout_prefix=()
        [ -n "${EPAM_STORY_TIMEOUT_SECS:-}" ] && _timeout_prefix=(timeout "$EPAM_STORY_TIMEOUT_SECS")

        case "${STORY_PROVIDER:-codex}" in
            opencode)
                # OpenCode: pass prompt via temp file (prompts can exceed arg limits)
                # --format json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local prompt_file="${json_result_file%.json}_prompt.txt"
                echo "$prompt" > "$prompt_file"
                if "${_timeout_prefix[@]}" opencode run --format json "$(cat "$prompt_file")" \
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
                local codex_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && codex_model_flag=(--model "$STORY_MODEL")
                if echo "$prompt" | "${_timeout_prefix[@]}" codex exec \
                        --ephemeral \
                        --skip-git-repo-check \
                        --dangerously-bypass-approvals-and-sandbox \
                        "${codex_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>>"$output_file"; then
                    normalize_provider_json "codex" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                        | jq -r '.item.text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            codemie-claude)
                # codemie-claude: same invocation pattern as claude — --print --output-format json
                if echo "$prompt" | "${_timeout_prefix[@]}" codemie-claude --print --output-format json \
                        "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                        2>>"$output_file" > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            copilot|openai|qwen|cursor|minimax)
                # epam-run providers: invoke via `epam run --provider X --model M --json`
                # EPAM_CLI can be overridden with a mock for zero-token testing.
                # Explicitly forward API keys so subshells that didn't inherit them still work.
                local raw_file="${json_result_file%.json}_raw.json"
                local epam_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && epam_model_flag=(--model "$STORY_MODEL")
                # When EPAM_SANDBOX is active (EPAM_SANDBOX_IMAGE is set by
                # run-agent-orchestration.sh's sandbox bootstrap), route
                # through $CLAUDE_CMD (the sandbox wrapper) instead of
                # calling $EPAM_CLI directly — this is what makes vendor-dir
                # tampering structurally impossible for THIS provider branch
                # too (previously only the claude/epam default branches
                # respected --sandbox at all). EPAM_SANDBOX_TARGET_CMD tells
                # sandbox-invoke.sh to run epam-cli's own bind-mounted CLI
                # (see that script's docstring) instead of its `claude`
                # default; left empty (harmless) when not sandboxed.
                local _epam_run_binary="$EPAM_CLI"
                local _epam_sandbox_target=""
                if [ -n "${EPAM_SANDBOX_IMAGE:-}" ]; then
                    _epam_run_binary="$CLAUDE_CMD"
                    _epam_sandbox_target="node /opt/epam-cli/dist/epam.js"
                fi
                # Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story's declared files.
                # WriteFile.ts uses this to block TS writes outside the story's scope.
                local _allowed_write_paths
                _allowed_write_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                # Rewrite allowed paths to worktree when in worktree mode.
                # Without this, WriteFile.ts blocks writes to the worktree path and reports
                # "Permitted paths: /main-repo/src/foo.ts" — the model reads that error and
                # writes to the main repo instead of the worktree.
                if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
                    _allowed_write_paths="${_allowed_write_paths//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
                fi
                # Also permit the detective's CAUSAL fix-site file(s). The spec-pass
                # detective traces the real fix location, which often differs from the
                # ticket's declared technicalNotes.files; the locationHint→technicalNotes.files
                # propagation is non-deterministic (run14, 2026-07-22), so the scope-guard
                # could otherwise BLOCK the agent from writing the very file it was told to
                # fix. These are repo-relative and resolve against the agent's cwd
                # (=PROJECT_ROOT/worktree) exactly as WriteFile.ts's path.resolve() expects,
                # so no worktree rewrite is needed.
                local _fixsite_paths
                _fixsite_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .fixSiteAnalysis[]?.file // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                if [ -n "$_fixsite_paths" ]; then
                    _allowed_write_paths="${_allowed_write_paths:+${_allowed_write_paths}:}${_fixsite_paths}"
                fi
                if echo "$prompt" | \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_ALLOWED_WRITE_PATHS="${_allowed_write_paths}" \
                        EPAM_MAX_ITERATIONS="${STORY_MAX_ITERATIONS:-6}" \
                        EPAM_MAX_OUTPUT_TOKENS="${STORY_MAX_OUTPUT_TOKENS:-3072}" \
                        OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-}" \
                        EPAM_QWEN_MODEL_OVERRIDE="${EPAM_QWEN_MODEL_OVERRIDE:-}" \
                        DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
                        EPAM_API_KEY_QWEN="${EPAM_API_KEY_QWEN:-}" \
                        MINIMAX_API_KEY="${MINIMAX_API_KEY:-}" \
                        EPAM_API_KEY_MINIMAX="${EPAM_API_KEY_MINIMAX:-}" \
                        MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-}" \
                        EPAM_MINIMAX_MODEL_OVERRIDE="${EPAM_MINIMAX_MODEL_OVERRIDE:-}" \
                        EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-}" \
                        EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-}" \
                        OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
                        EPAM_API_KEY_OPENAI="${EPAM_API_KEY_OPENAI:-}" \
                        EPAM_RALPH_WIGGUM_ENABLED="${EPAM_RALPH_WIGGUM_ENABLED:-}" \
                        EPAM_RALPH_WIGGUM_AGENTS="${EPAM_RALPH_WIGGUM_AGENTS:-}" \
                        EPAM_RALPH_WIGGUM_TIMEOUT_MS="${EPAM_RALPH_WIGGUM_TIMEOUT_MS:-}" \
                        EPAM_SANDBOX_TARGET_CMD="${_epam_sandbox_target}" \
                        "${_timeout_prefix[@]}" "$_epam_run_binary" run \
                        --provider "$STORY_PROVIDER" \
                        "${epam_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>> "$output_file"; then
                    normalize_provider_json "epam-run" "$raw_file" "$json_result_file"
                    jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            epam)
                # epam: treat same as claude — same CLI, same output format
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    local sdk_think_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" "${sdk_think_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
            *)
                # Claude-compatible providers use the Claude CLI JSON output shape.
                # SDK path: invoke.py via Anthropic Python SDK (EPAM_SDK_INVOKE=1)
                # CLI path: claude --print --output-format json (default)
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${turns_flag[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
        esac

        # Log THIS attempt's real token/cost usage unconditionally (success or
        # failure) — previously only the FINAL attempt's json_result_file
        # ever reached phase-cost.jsonl (append_cost_record was only called
        # once, at the story's terminal completed/failed state), so every
        # earlier retry's real, billed tokens were silently invisible to any
        # dashboard or report. Found live 2026-07-23 (AMSD-1820): an 8-attempt
        # failure with ~200-240k input tokens on EACH attempt would have shown
        # only the last one — hiding roughly 7/8 of the real cost. Distinct
        # status ("attempt", not "completed"/"failed") so existing consumers
        # that filter on terminal status are unaffected; the attempt number
        # lets a per-story total be summed independently of that filter.
        append_cost_record "$story_id" "attempt" "$attempt_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file" "$((retry_count + 1))"

        # Vendor-dir guard: NOT unlocked here — run_vendor_integrity_check()
        # (called at the very start of run_external_verification, before
        # run_dependency_check's own sanctioned writes) needs the lock marker
        # and current permissions intact to correctly attribute any tamper to
        # this attempt. _vendor_unlock() is called from inside
        # run_external_verification itself, right after that check passes.

        if [ "$invoke_success" = true ] && ! verify_story_deliverables "$story_id"; then
            warning "$story_cli returned success but story deliverables are incomplete"
            invoke_success=false
        fi

        # Inline TC writer — fires after impl deliverables are verified, before
        # external test. Generates testCriteria in the PRD for sibling test
        # stories so the test agent has precise facts, not just abstract ACs.
        # Skipped for test stories themselves (they don't generate TCs).
        if [ "$invoke_success" = true ] && [ "${SKIP_TC_WRITER:-0}" != "1" ]; then
            local _story_files_are_tests
            # grep -c ALREADY prints "0" on zero matches (its own count) while
            # also exiting 1 — combining that with `|| echo 0` double-prints
            # ("0\n0"), which then fails the `-eq` numeric test below with
            # "integer expression expected" (found live, 2026-07-06, blocking
            # external verification for every non-test story with exit 127).
            # `|| true` only suppresses the exit code (needed since this
            # script runs under `set -e`), without adding extra output.
            _story_files_are_tests=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | { grep -c '\.test\.ts$' || true; })
            if [ "${_story_files_are_tests:-0}" -eq 0 ]; then
                log "  [tc-writer] Generating TCs for phase '${CURRENT_PHASE:-unknown}' (post-impl, pre-test)..."
                if bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
                    --prd "${MAIN_PRD_FILE:-$PRD_FILE}" \
                    --phase "${CURRENT_PHASE:-unknown}" \
                    --output-dir "$PROJECT_ROOT" \
                    2>&1 | tee -a "$output_file"; then
                    log "  [tc-writer] TC generation complete — test stories have testCriteria"
                else
                    warning "  [tc-writer] TC generation failed — test stories will run without TCs (non-fatal)"
                fi
            fi
        fi

        # TypeScript compile check — runs BEFORE external verification
        # (reordered 2026-07-12; see run_tsc_verification()'s own comment for
        # the live incident this fixes). A syntax/type error is a cheap,
        # near-instant deterministic check; the (often multi-minute) external
        # test command below should never run against code that can't even
        # compile. Still inside the retry loop so a tsc failure gets the same
        # self-healing treatment (failure analyst, InferenceLadder escalation)
        # as any other verification failure, rather than exiting the phase
        # with zero retries.
        if [ "$invoke_success" = true ] && ! run_tsc_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but tsc --noEmit failed"
            invoke_success=false
        fi

        # External test verification — runs tests outside the agent loop so the
        # agent only needs to write files (keeping iterations low).
        if [ "$invoke_success" = true ] && ! run_external_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but external tests failed"
            invoke_success=false
        fi

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

            # ── Coordinator pre-assessment before next retry ──────────────────
            # Resolve the actual raw file path (may differ by provider).
            local _raw_for_coord="$attempt_raw_file"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord="${json_result_file%.json}_raw.jsonl"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord=""

            # Layer 1: rule-based triage (always runs)
            classify_failure_class "$_raw_for_coord" "$json_result_file" "$exit_code"

            # Layer 2: LLM gate (only for capability/quality failures, only when enabled)
            local _next_model
            _next_model=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .retryModel // ""' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
            _next_model="${_next_model:-${EPAM_RETRY_MODEL:-}}"
            if [ "$COORDINATOR_ESCALATE" = "yes" ] && \
               [ "$COORDINATOR_FAILURE_CLASS" != "env" ] && \
               [ -n "$_next_model" ]; then
                assess_model_escalation "$story_id" "$_raw_for_coord" "$json_result_file" "$output_file" "$_next_model"
            fi

            # Cross-run memory: persist failure evidence so future runs and the
            # coordinator can detect repeated failure patterns across multiple runs.
            local _failures_file="${LOG_DIR}/story-failures.jsonl"
            local _raw_sz=0
            [ -f "$_raw_for_coord" ] && _raw_sz=$(wc -c < "$_raw_for_coord" 2>/dev/null || echo 0)
            local _tokens_out_mem=0
            [ -f "$json_result_file" ] && _tokens_out_mem=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo 0)
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn \
                    --arg sid "$story_id" \
                    --arg fc "$COORDINATOR_FAILURE_CLASS" \
                    --arg model "${STORY_MODEL:-unknown}" \
                    --argjson attempt "$retry_count" \
                    --argjson exit_c "$exit_code" \
                    --argjson raw_sz "${_raw_sz:-0}" \
                    --argjson toks "${_tokens_out_mem:-0}" \
                    --argjson iters "${STORY_MAX_ITERATIONS:-0}" \
                    '{storyId:$sid, failureClass:$fc, model:$model,
                      attempt:$attempt, exitCode:$exit_c, rawBytes:$raw_sz,
                      outputTokens:$toks, maxIterations:$iters,
                      timestamp:(now|todate)}' >> "$_failures_file"
            ) 300>>"${_failures_file}.lock"

            # Layer 3: failure analyst — diagnose test failure and patch PRD or inject
            # skill guidance before the next retry. Only runs when more retries remain.
            # Skipped for deterministic-check failures (relative-import-check,
            # mock-completeness-check): the check's own message already names the
            # exact violation precisely — spending a gate-model call to "diagnose"
            # something already known is pure waste. Inject the check's message
            # directly as retry guidance instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]; then
                log "  [DeterministicCheck] Skipping failure-analyst — violation already precisely known"
                local _existing_amendment="${COORDINATOR_PROMPT_AMENDMENT:-}"
                # Re-inject the last failure-analyst diagnosis for this story from
                # healing-events.jsonl. DeterministicCheck skips the analyst (saving
                # a gate-model call) but that means the agent loses the actionable
                # "use this pattern instead" guidance the analyst wrote on earlier
                # retries. Without re-injection, subsequent retries only see the
                # pre-check's terse error message — not the richer fix guidance.
                local _last_fa_diagnosis=""
                local _heal_log="${LOG_DIR}/healing-events.jsonl"
                if [ -f "$_heal_log" ]; then
                    _last_fa_diagnosis=$(python3 -c "
import json, sys
story = '$story_id'
last = ''
try:
    for line in open('$_heal_log'):
        try:
            e = json.loads(line)
            if e.get('story_id') == story and e.get('diagnosis') and e.get('target') not in ('none', ''):
                last = e['diagnosis']
        except Exception:
            pass
except Exception:
    pass
print(last)
" 2>/dev/null || echo "")
                fi
                COORDINATOR_PROMPT_AMENDMENT="${_existing_amendment}
## Deterministic Check Failure
${VERIFICATION_FAILURE}
This was caught by an automated check before the test suite even ran — fix the exact issue named above.${_last_fa_diagnosis:+

## Prior failure-analyst diagnosis (re-injected for context)
$_last_fa_diagnosis
Apply the above diagnosis AND fix the deterministic check violation — both must be resolved.}"

                # A deterministic-check violation repeating IDENTICALLY across attempts
                # is just as strong an escalation signal as an LLM-diagnosed repeat, but
                # check_healing_effectiveness never sees it (it only runs inside
                # run_failure_analyst, deliberately skipped above). Confirmed live
                # (run #15, 2026-07-05): SKY-003 repeated the SAME relative-import-check
                # violation 5 times across free AND counted retries with zero
                # escalation, because the only repeat-detector was being bypassed.
                # Reuse the existing HEALING_BROKEN flag/skip-to-next-rung consumer
                # logic below instead of building a separate signal.
                #
                # BUG (found live, 2026-07-05): comparing the RAW VERIFICATION_FAILURE
                # text false-triggered a repeat between two GENUINELY DIFFERENT
                # violations (a relative-import-check failure, then a totally
                # unrelated mock-completeness-check failure on the retry) — every
                # deterministic check's message shares the same templated preamble
                # ("## Verification Failure\n\n<intro sentence>... anything else:\n\n")
                # plus the same recurring file/class names for this story, so generic
                # boilerplate words alone crossed the token-overlap threshold (11
                # shared tokens, ratio 0.52) even though the actual problem was
                # unrelated. Fix: strip the templated intro (everything through the
                # first ":\n\n") before comparing — only the check-specific detail
                # lines that follow are meaningful signal.
                local _prev_violation_detail _cur_violation_detail
                _prev_violation_detail="${_prev_deterministic_violation#*:$'\n'$'\n'}"
                _cur_violation_detail="${VERIFICATION_FAILURE#*:$'\n'$'\n'}"
                if [ -n "$_prev_deterministic_violation" ]; then
                    local _same_violation
                    _same_violation=$(same_root_cause_diagnoses "$_prev_violation_detail" "$_cur_violation_detail")
                    if [ "$_same_violation" = "true" ]; then
                        error "  [DeterministicCheck] CRITICAL: same violation repeated for $story_id without resolution — treating as HealingBroken"
                        HEALING_BROKEN=1
                        export HEALING_BROKEN
                    fi
                fi
                _prev_deterministic_violation="$VERIFICATION_FAILURE"
            elif [ $retry_count -lt $MAX_RETRIES ]; then
                run_failure_analyst "$story_id" "$output_file" "$retry_count"
            fi

            # An escalated defect (see escalate_defect_to_sibling_story) takes
            # priority over normal retry handling — if the escalating story's
            # agent correctly diagnosed a defect in a sibling's file it cannot
            # touch, resolve it now rather than letting the story burn its own
            # retry ladder re-diagnosing something it structurally cannot fix.
            if resolve_escalation "$story_id"; then
                success "  [Escalation] Resolved — free retry for $story_id (not counted against the ladder)"
                continue
            fi

            # Deterministic-check failures get up to 3 FREE retries — they don't
            # advance retry_count (so they don't consume ladder/model-escalation
            # budget), since a mechanical "you missed a spot" violation is not
            # evidence of a capability gap the way a real test failure is. After 3
            # free retries without resolution, fall through to a normal counted
            # retry to bound the loop. Skipped entirely when the violation just
            # repeated identically (HEALING_BROKEN set above) — granting another
            # free retry on a KNOWN-non-converging violation just wastes an attempt;
            # fall straight through to the counted/rung-skip path instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ] && [ "${HEALING_BROKEN:-0}" -ne 1 ] && [ "$_free_retry_count" -lt 3 ]; then
                _free_retry_count=$((_free_retry_count + 1))
                DETERMINISTIC_CHECK_FAILURE=0
                export DETERMINISTIC_CHECK_FAILURE
                warning "  [DeterministicCheck] Free retry ${_free_retry_count}/3 for $story_id — not counted against the model-escalation ladder"
                continue
            fi
            DETERMINISTIC_CHECK_FAILURE=0
            export DETERMINISTIC_CHECK_FAILURE

            retry_count=$((retry_count + 1))
            # If self-healing is confirmed broken, skip to the start of the next rung
            # rather than burning the second attempt. At the last rung (3), abort instead.
            if [ "${HEALING_BROKEN:-0}" -eq 1 ]; then
                local _cur_rung=$(( (retry_count - 1) / 2 ))
                local _next_rung_start=$(( (_cur_rung + 1) * 2 ))
                HEALING_BROKEN=0
                export HEALING_BROKEN
                if [ "$_cur_rung" -ge 3 ] || [ "$_next_rung_start" -gt "$MAX_RETRIES" ]; then
                    error "  [HealingBroken] At max rung — aborting $story_id"
                    break
                else
                    warning "  [HealingBroken] Skipping to rung $((_cur_rung + 1)) (retry $_next_rung_start) for $story_id"
                    retry_count=$_next_rung_start
                fi
            fi
            # Early escalation: the model made a DIFFERENT mistake on back-to-back
            # attempts while still un-escalated (Rung 0-1) — jump straight to Rung 2
            # (model escalation) instead of exhausting the rest of the base-model
            # budget. Mutually exclusive with HEALING_BROKEN by construction (a pair
            # of diagnoses can't be both the same root cause and different root
            # causes), so no ordering conflict between the two blocks.
            if [ "${EARLY_ESCALATION_NEEDED:-0}" -eq 1 ]; then
                EARLY_ESCALATION_NEEDED=0
                export EARLY_ESCALATION_NEEDED
                if [ "$retry_count" -lt 4 ] && [ 4 -le "$MAX_RETRIES" ]; then
                    warning "  [FailureDiversity] Jumping to Rung 2 (retry 4) for $story_id — base model isn't converging"
                    retry_count=4
                fi
                # Different failure classes across attempts (not the same bug
                # recurring) is the signature of token-selection variance, not a
                # capability gap — the model is making a DIFFERENT plausible
                # mistake each time rather than converging on the fix. Pin
                # temperature to near-zero for the remainder of this story so it
                # stops exploring alternative (and equally wrong) approaches and
                # sticks to its single most likely path, making exact-string ACs
                # (e.g. a literal error-message substring) reachable.
                warning "  [FailureDiversity] Pinning temperature to 0 for the remainder of $story_id — non-repeating failures indicate token-variance, not a capability gap"
                export EPAM_TEMPERATURE="0"
            fi
            if [ $retry_count -le $MAX_RETRIES ]; then
                warning "$story_cli failed, retrying in ${RETRY_DELAY}s..."
                sleep $RETRY_DELAY
            fi
        fi
    done

    # Retry-extension coordinator (2026-07-12): the inner loop just exhausted
    # MAX_RETRIES. Before giving up, ask (at most once per story) whether the
    # evidence justifies a bounded extension -- see
    # run_retry_extension_coordinator()'s own docstring for the full design.
    if [ "$_retry_extension_used" -eq 0 ]; then
        _retry_extension_used=1
        local _granted_extra_retries
        _granted_extra_retries=$(run_retry_extension_coordinator "$story_id")
        if [ -n "$_granted_extra_retries" ] && [ "$_granted_extra_retries" -gt 0 ] 2>/dev/null; then
            MAX_RETRIES=$((MAX_RETRIES + _granted_extra_retries))
            # Retry extension (kimi-k3 territory): open the output token ceiling
            # to generator-level (16384) — at this point the story has exhausted
            # the standard ladder and is receiving the strongest available model;
            # any remaining token budget constraint must not be the failure mode.
            [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt 16384 ] && STORY_MAX_OUTPUT_TOKENS=16384
            continue
        fi
    fi
    break
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
        # Sync live PRD to dashboard prd.json so viewers update in real-time
        if [ -n "${OUTPUT_DIR:-}" ] && [ -f "$prd_target" ]; then
            cp "$prd_target" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
        fi
    ) 200>"$lock_file"
}

# Append a cost/time record to phase-cost.jsonl
# Called after each story completes (success or failure) for phase-aware
# tracking, AND after every individual retry attempt (status="attempt",
# attempt_num set) so real per-attempt token/cost usage is never invisible —
# see the call site right after the provider-invocation case block above.
append_cost_record() {
    local story_id=$1 status=$2 started_at=$3 ended_at=$4 output_file=$5 json_result_file=${6:-} attempt_num=${7:-}
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"

    # Read story metadata from prd.json
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // "unknown"' "$prd_target")
    local agent_id=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target")
    local forecast_hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target")
    local forecast_cost=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedCost // 0' "$prd_target" 2>/dev/null || echo 0)
    local story_effort=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .effort // "medium"' "$prd_target")
    local story_type=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .storyType // "implementation"' "$prd_target")
    local resolved_model="${STORY_MODEL:-}"
    local planner_model="${STORY_PLANNER_MODEL:-}"
    local prompt_tokens_measured="${STORY_PRECOUNT_TOKENS:-0}"
    local invoke_mode="cli"
    [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && invoke_mode="sdk"
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

    # Parse cost/token/turn usage from JSON result file.
    # Handles two output shapes:
    #   Claude CLI (--output-format json): total_cost_usd, usage.input_tokens, usage.output_tokens
    #   epam run --json (AgentRunner):     cost_usd,        usage.inputTokens,  usage.outputTokens,
    #                                      cost_is_estimate (explicit real-vs-estimate flag)
    local tokens_in=0 tokens_out=0 cost_usd=0 task_turns=0 cost_is_estimate=""
    if [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        cost_usd=$(jq -r '.total_cost_usd // .cost_usd // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Claude CLI's total_cost_usd has no equivalent flag (it's always
        # real, Anthropic bills it directly) — cost_is_estimate only exists
        # on epam run --json output. Empty here means "not applicable" for
        # Claude CLI, resolved to a concrete true/false below.
        cost_is_estimate=$(jq -r 'if has("cost_is_estimate") then (.cost_is_estimate | tostring) else "" end' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo "")
        tokens_in=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_out=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Turn count: Claude CLI reports num_turns/turns; AgentRunner reports iterations
        task_turns=$(jq -r '.num_turns // .turns // .usage.turns // .iterations // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Cache tokens (Claude CLI only; no-op for epam output)
        local cache_create=$(jq -r '.usage.cache_creation_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        local cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_in=$(( ${tokens_in:-0} + ${cache_create:-0} + ${cache_read:-0} ))
    fi
    [ -z "$tokens_in" ] && tokens_in=0
    [ -z "$tokens_out" ] && tokens_out=0
    [ -z "$cost_usd" ] && cost_usd=0
    [ -z "$task_turns" ] && task_turns=0

    # If the JSON result explicitly said this cost is real (cost_is_estimate
    # = "false"), trust it even if it happens to be a genuine $0 call — don't
    # run it through the local pricing-table fallback below. Otherwise
    # (cost_is_estimate missing/true, or cost_usd is 0/empty), compute from
    # the pricing table as a last-resort ESTIMATE, and record that fact.
    if [ "$cost_is_estimate" != "false" ] && { [ "${cost_usd}" = "0" ] || [ "${cost_usd}" = "0.0" ] || [ -z "${cost_usd}" ]; }; then
        if [ "${tokens_in:-0}" -gt 0 ] || [ "${tokens_out:-0}" -gt 0 ]; then
            local computed_cost
            computed_cost=$(compute_token_cost "${resolved_model:-}" "$tokens_in" "$tokens_out")
            if [ -n "$computed_cost" ] && [ "$computed_cost" != "0" ]; then
                cost_usd="$computed_cost"
                cost_is_estimate="true"
            fi
        fi
    fi
    [ -z "$cost_is_estimate" ] && cost_is_estimate="false"

    # Atomic JSONL append with flock
    (
        flock -w 10 200 || { error "Could not acquire lock on $cost_file"; return 1; }
        jq -cn \
            --arg pid "$phase_id" --arg pn "$phase_id" \
            --arg sid "$story_id" --arg st "$title" \
            --arg aid "$agent_id" --arg an "$agent_id" \
            --argjson fh "${forecast_hours:-0}" --argjson fc "${forecast_cost:-0}" \
            --arg sa "$started_at" --arg ea "$ended_at" \
            --argjson em "${elapsed_minutes:-0}" --argjson cu "$cost_usd" \
            --argjson ti "${tokens_in:-0}" --argjson to "${tokens_out:-0}" \
            --argjson tt "${task_turns:-0}" \
            --argjson cr "${cache_read:-0}" --argjson cc "${cache_create:-0}" \
            --arg s "$status" --arg n "" \
            --arg ef "${story_effort:-medium}" --arg stype "${story_type:-implementation}" \
            --arg rm "${resolved_model:-}" \
            --arg pm "${planner_model:-}" \
            --argjson ptm "${prompt_tokens_measured:-0}" \
            --arg im "${invoke_mode}" \
            --argjson cie "$cost_is_estimate" \
            --argjson an2 "${attempt_num:-null}" \
            '{phase_id:$pid, phase_name:$pn, story_id:$sid, story_title:$st,
              agent_id:$aid, agent_name:$an, forecast_hours:$fh, forecast_cost_usd:$fc,
              started_at:$sa, ended_at:$ea, elapsed_minutes:$em,
              task_cost_usd:$cu, task_tokens_in:$ti, task_tokens_out:$to,
              task_turns:$tt, cache_read_tokens:$cr, cache_create_tokens:$cc,
              status:$s, notes:$n,
              effort:$ef, storyType:$stype, resolvedModel:$rm,
              plannerModel:$pm,
              prompt_tokens_measured:$ptm, invokeMode:$im,
              costIsEstimate:$cie, attempt:$an2}' >> "$cost_file"
    ) 200>"$lock_file"

    # Emit human-readable cost summary to the run log so it appears in pipeline output.
    log "  Cost[$story_id] model=${resolved_model:-unknown} in=${tokens_in} out=${tokens_out} cost=\$${cost_usd} elapsed=${elapsed_minutes}min status=${status}"

    # Emit cost_snapshot event so agent-activity dashboard shows tokens/cost/model per story
    jq -cn \
        --arg ts "$(date -Iseconds)" \
        --arg agent "${agent_id:-orchestrator}" \
        --arg story "$story_id" \
        --arg phase "$phase_id" \
        --arg model "${resolved_model:-}" \
        --arg provider "${STORY_PROVIDER:-}" \
        --argjson cost "${cost_usd:-0}" \
        --argjson tin "${tokens_in:-0}" \
        --argjson tout "${tokens_out:-0}" \
        --argjson turns "${task_turns:-1}" \
        '{
          event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
          timestamp: $ts,
          agent: $agent,
          story_id: (if $story == "" then null else $story end),
          phase: (if $phase == "" then null else $phase end),
          type: "cost_snapshot",
          model: (if $model == "" then null else $model end),
          provider: (if $provider == "" then null else $provider end),
          detail: {
            costUsd: $cost,
            tokensIn: $tin,
            tokensOut: $tout,
            turns: $turns,
            source: "append_cost_record"
          }
        }' >> "${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" 2>/dev/null || true

    # GAP-P17: emit StoryArtifact record to story-artifacts.jsonl
    emit_story_artifact "$story_id" "$status" "$phase_id" "$elapsed_minutes" "$cost_usd" "$task_turns" "$json_result_file"
}

# GAP-P17 — Emit a StoryArtifact record to logs/story-artifacts.jsonl.
# When the story has an outputSchema field in the PRD, the agent result text
# is validated against it and the parsed object is included in the artifact.
emit_story_artifact() {
    local story_id=$1 status=$2 phase_id=$3 elapsed_minutes=$4 cost_usd=$5 task_turns=$6 json_result_file=${7:-}
    local artifact_file="${LOG_DIR}/story-artifacts.jsonl"
    local lock_file="${artifact_file}.lock"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Read outputSchema if defined for this story
    local output_schema
    output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")

    # Try to parse structured output from the result file when schema is present
    local structured_output="null"
    if [ -n "$output_schema" ] && [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        local result_text
        result_text=$(jq -r '.result // ""' "$json_result_file" 2>/dev/null || echo "")
        # Extract first JSON object/array from result text
        local extracted
        extracted=$(echo "$result_text" | node -e "
const chunks = []; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => {
    const text = chunks.join('');
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) { try { JSON.parse(m[0]); process.stdout.write(m[0]); } catch { process.stdout.write('null'); } }
    else process.stdout.write('null');
});" 2>/dev/null || echo "null")
        [ -n "$extracted" ] && structured_output="$extracted"
    fi

    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg sid "$story_id" \
            --arg phase "$phase_id" \
            --arg status "$status" \
            --argjson elapsed "${elapsed_minutes:-0}" \
            --argjson cost "${cost_usd:-0}" \
            --argjson turns "${task_turns:-0}" \
            --argjson schema "${output_schema:-null}" \
            --argjson structured "$structured_output" \
            '{storyId:$sid, phase:$phase, status:$status,
              elapsedMinutes:$elapsed, costUsd:$cost, turns:$turns,
              outputSchema:$schema, structuredOutput:$structured,
              timestamp:(now|todate)}' >> "$artifact_file"
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
        printf "KB-%03d" $(( 10#${last_num} + 1 ))
    fi
}

# Return KB entries relevant to a story's agent role.
# Reads from KB-{agentProfile}.md (role-specific) and KB-shared.md.
# Returns at most 10 entries total to bound context injection size.
get_relevant_kb_entries() {
    local story_id=$1
    local kb_dir="$AUTOMATION_DIR/agents"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_profile
    agent_profile=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' "$prd_target" 2>/dev/null || echo "")
    [ -z "$agent_profile" ] && return

    # Collect last 10 lines from role-specific KB + shared KB (shared is a fallback)
    local role_kb="${kb_dir}/KB-${agent_profile}.md"
    local shared_kb="${kb_dir}/KB-shared.md"
    local combined=""
    [ -f "$role_kb"   ] && combined="${combined}$(tail -n 20 "$role_kb" 2>/dev/null)"$'\n'
    [ -f "$shared_kb" ] && combined="${combined}$(tail -n 10 "$shared_kb" 2>/dev/null)"$'\n'

    # Strip blank lines and return at most 10 bullet entries
    printf '%s' "$combined" | grep -v '^[[:space:]]*$' | tail -n 10
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

    # Inject external test failure context when available
    if [ -n "${VERIFICATION_FAILURE:-}" ]; then
        printf '%s\n' "$VERIFICATION_FAILURE"
    fi

    printf '\n## Relevant Knowledge Base Entries\n'
    if [ -n "$kb_entries" ]; then
        printf 'The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:\n\n'
        printf '%s\n' "$kb_entries"
    else
        printf 'No prior KB entries match your agent role yet.\n'
    fi

    printf '\n## Knowledge Base Contribution (do this LAST — after writing all implementation files)\n'
    printf 'Your assigned KB entry ID for this run: **%s**\n' "$next_kb_id"
    [ -n "$retry_note" ] && printf '%s\n' "$retry_note"
    printf '\nIMPORTANT: Write ALL implementation files first. Only AFTER writing every required file should you optionally append a KB entry.\n'
    printf 'Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.\n\n'
    printf 'If (and only if) you discover a non-obvious pattern during implementation, append one entry to `orchestrations/agents/KB.md`:\n\n'
    printf '```markdown\n'
    printf '## %s -- %s\n\n' "$next_kb_id" "$today"
    printf '**Category:** <backend|frontend|infrastructure|testing|orchestration>\n'
    printf '**AgentRole:** <your agentRole from the story>\n'
    printf '**Tags:** <comma-separated tech keywords, e.g. typescript, node, cli>\n'
    printf '**Trigger:** <retry|first-success>\n'
    printf '**StoryRef:** %s\n\n' "$story_id"
    printf '<One concise paragraph: the specific pattern, gotcha, or anti-pattern.>\n'
    printf '```\n\n'
    printf 'Only write an entry if the knowledge is genuinely non-obvious. Skip trivial observations.\n'

    # Surface any dynamic tools the self-heal loop has written for this project.
    # These are small shell scripts synthesized by the failure analyst (target=tool)
    # to automate a mechanical step that kept getting skipped by hand (e.g. adding a
    # package to package.json before importing it). Invoke them via the bash tool.
    local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
    if [ -d "$tools_dir" ] && [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ]; then
        printf '\n## Available Dynamic Tools\n'
        printf 'This project has the following helper scripts, written by prior self-healing runs. Use them via the bash tool instead of repeating the equivalent steps by hand:\n\n'
        local _tool_file _tool_purpose_line
        for _tool_file in "$tools_dir"/*.sh; do
            [ -f "$_tool_file" ] || continue
            # Only reviewed tools are ever surfaced to an agent — same
            # explicit .reviewed marker check as
            # run_dynamic_tools_in_unlocked_window(), so an unreviewed or
            # stale script (however it got there) is never offered as if
            # trusted.
            [ -f "${_tool_file}.reviewed" ] || continue
            _tool_purpose_line=$(sed -n '2p' "$_tool_file" | sed 's/^# //')
            printf -- '- `bash %s <args>` — %s\n' "$_tool_file" "$_tool_purpose_line"
        done
    fi
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
# commit_completed_story <story_id>
# Stages and commits whatever a completed story wrote, scoped to the current
# GIT_WORK_ROOT (the worktree checkout when running --worktree, the main repo
# otherwise). Best-effort: a commit failure here must not fail the story itself,
# since the retry/health-check machinery downstream still has its own commit gates.
# generate_story_contract <story_id>
# Deterministically writes .contracts/<story_id>.md by extracting exported
# interfaces/classes/methods directly from the story's own source files —
# NOT by asking the model to transcribe them. The typescript-engineer profile
# has a "CONTRACT SCRATCHPAD — MANDATORY LAST STEP" instruction telling the
# agent to hand-write this file, but that step was observed live to have near-
# 0% compliance: SKY-002 never produced .contracts/SKY-002.md across multiple
# runs, so build_implementation_prompt()'s contract injection (which only
# activates `if [ -f "$_contract_file" ]`) had nothing to inject — dependent
# stories (SKY-003/SKY-004) guessed import paths and mock shapes from scratch,
# reproducing exactly the bug class contract injection was built to prevent.
# A regex-based extractor is not as complete as a real TS parser, but it is
# ALWAYS produced (no model compliance required) and always matches the
# actual source, so it can never be wrong the way an LLM transcription could.
#
# Fully generic (2026-07-05): all regex patterns and mock-rendering templates
# are read from <project_root>/.epam/contract-generation.json — this function
# has no TypeScript/Vitest-specific knowledge. Each project's tier script
# supplies its own manifest (see tier3-travel-app-run.sh for the current
# skyscanner-app one); a Python/pytest or Go project would supply a manifest
# with different regexes and mock templates, and this function would not
# change. No manifest present = no-op (opt-in feature, same pattern as
# run_dependency_check()'s .epam/dependency-check.json).
generate_story_contract() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _commit_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    local config_file="${_commit_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local files_json
    files_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
        "$prd_target" 2>/dev/null || echo "[]")
    [ "$files_json" = "[]" ] && return 0

    # technicalNotes.files stores ABSOLUTE paths rooted at MAIN_PROJECT_ROOT (the
    # non-worktree checkout) — same rewrite already applied to ACs/technicalNotes/
    # description elsewhere in this file (see the WORKTREE_MODE substitution near
    # line 960). Without this, resolving files against $_commit_root (the worktree)
    # silently misses every file (they don't exist under the main root yet — the
    # story hasn't merged), so no interfaces/classes are ever found and no contract
    # is written, with no visible error. Confirmed live: run #15's .contracts/
    # directory existed but was empty after SKY-002 completed.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        files_json="${files_json//${MAIN_PROJECT_ROOT}/${_commit_root}}"
    fi

    local contracts_dir="${_commit_root}/.contracts"
    mkdir -p "$contracts_dir" 2>/dev/null
    local contract_file="${contracts_dir}/${story_id}.md"

    python3 - "$_commit_root" "$contract_file" "$files_json" "$story_id" "$config_file" << 'PYEOF'
import json, re, sys, os

project_root, contract_file, files_json, story_id, config_file = sys.argv[1:6]
files = json.loads(files_json)

with open(config_file) as f:
    cfg = json.load(f)

exts = tuple(cfg['sourceExtensions'])
exclude_re = re.compile(cfg['excludePattern'])
src_files = [f for f in files if f.endswith(exts) and not exclude_re.search(f)]
if not src_files:
    sys.exit(0)

interface_re = re.compile(cfg['interfacePattern'], re.S)
class_re = re.compile(cfg['classPattern'])
ctor_re = re.compile(cfg['ctorPattern'])
method_re = re.compile(cfg['methodPattern'], re.M)

# Live bug (2026-07-05, found backfilling SKY-002's contract): methodPattern
# is a plain regex scan over the WHOLE class body — it has no notion of brace
# depth, so control-flow statements nested inside a real method's body (e.g.
# `if (!key) {`, `for (const x of y) {`) also match `\w+\s*\(...\)\s*{` and get
# misidentified as methods, producing duplicate/garbage entries (a mock
# skeleton with duplicate "if" mock-method entries — an invalid object
# literal in the generated skeleton). This is a brace-
# nesting concern, not a stack-specific one — applies to any C-like language a
# future config might target — so it's engine logic, not per-project config.
def top_level_matches(text, pattern):
    depth_at = [0] * (len(text) + 1)
    depth = 0
    for i, c in enumerate(text):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        depth_at[i + 1] = depth
    return [m for m in pattern.finditer(text) if depth_at[m.start()] == 1]

interfaces, classes = [], []
for relpath in src_files:
    full = os.path.join(project_root, relpath)
    if not os.path.isfile(full):
        continue
    with open(full) as f:
        text = f.read()

    for m in interface_re.finditer(text):
        interfaces.append((m.group(1), m.group(2).strip()))

    for m in class_re.finditer(text):
        cname = m.group(1)
        start = m.end() - 1
        depth, end = 0, start
        for i, c in enumerate(text[start:], start):
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        body = text[start:end + 1]
        ctor_m = ctor_re.search(body)
        ctor_params = ctor_m.group(1).strip() if ctor_m else ''
        methods = []
        for mm in top_level_matches(body, method_re):
            is_async, mname, params, ret = mm.groups()
            if mname == 'constructor':
                continue
            methods.append((mname, (params or '').strip(), (ret or '').strip(), bool(is_async)))
        classes.append((cname, ctor_params, methods))

if not interfaces and not classes:
    sys.exit(0)

lines = [
    f"# Contract: {story_id}", "",
    "Auto-generated from actual source (deterministic — not model-transcribed).", "",
]

for name, body in interfaces:
    rendered = cfg['interfaceRenderTemplate'].replace('{{name}}', name).replace('{{body}}', body)
    lines += ["```typescript", rendered, "```", ""]

mock_blocks = []
for cname, ctor, methods in classes:
    sig_lines = []
    for mname, params, ret, is_async in methods:
        async_prefix = cfg['asyncPrefixKeyword'] if is_async else ''
        return_annotation = f"{cfg['returnAnnotationPrefix']}{ret}" if ret else ''
        sig_lines.append(
            cfg['methodSignatureTemplate']
            .replace('{{asyncPrefix}}', async_prefix)
            .replace('{{methodName}}', mname)
            .replace('{{params}}', params)
            .replace('{{returnAnnotation}}', return_annotation)
        )
    class_block = (
        cfg['classDeclarationTemplate']
        .replace('{{className}}', cname)
        .replace('{{ctorParams}}', ctor)
        .replace('{{methodSignatures}}', '\n'.join(sig_lines))
    )
    lines.append("```typescript")
    lines.append(class_block)
    lines.append("```")
    lines.append("")

    mock_methods = []
    for mname, params, ret, is_async in methods:
        template = cfg['mockMethodTemplateAsync'] if (is_async or 'Promise' in ret) else cfg['mockMethodTemplateSync']
        mock_methods.append(template.replace('{{methodName}}', mname))
    factory = (
        cfg['mockFactoryTemplate']
        .replace('{{className}}', cname)
        .replace('{{methodMocks}}', '\n'.join(mock_methods))
    )
    mock_blocks.append(factory.split('\n'))

if mock_blocks:
    lines.append("Mock factory skeleton — every exported method MUST appear here (every method name is real; fill in real return values):")
    lines.append("```typescript")
    for block in mock_blocks:
        lines.extend(block)
    lines.append("```")

with open(contract_file, 'w') as f:
    f.write('\n'.join(lines))
print(f"Contract auto-generated: {len(interfaces)} interface(s), {len(classes)} class(es)")
PYEOF
}

commit_completed_story() {
    local story_id="$1"
    local _commit_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    # Bounded timeout on git operations (added 2026-07-06): a live run's story-
    # level 600s watchdog killed the whole claude.sh subprocess with zero log
    # output after a story succeeded — generate_story_contract()/
    # commit_completed_story() were the only unlogged steps left, and neither
    # had any bound on how long its git/python calls could take (e.g. a stale
    # lock, a slow filesystem). 60s is generous for `git add`/`git commit` on
    # this project's size; a hang here now fails fast and visibly instead of
    # silently consuming the entire story-level watchdog budget.
    local _git_timeout="${EPAM_COMMIT_TIMEOUT_SECS:-60}"

    # set +e/-e around this block (found live, 2026-07-14, tier3-travel-app
    # run — first time a worktree lane ran real multi-story work): under
    # set -e (active for this whole script), `CMD1 || CMD2` as a bare
    # statement DOES still abort the script if CMD2 (the last command in the
    # || list) also fails — the fallback `git add -A` failing for ANY reason
    # (not just the 124-timeout case this code checks for) silently killed
    # the entire claude.sh process here, before `_add_rc=$?` was ever
    # reached, with zero warning logged and every remaining story in this
    # worktree lane (SKY-003-impl/-test, SKY-004 in the observed incident)
    # never even attempted.
    set +e
    timeout "$_git_timeout" git -C "$_commit_root" add -A -- \
        ':!orchestrations/logs/*' \
        ':!*/node_modules/*' \
        ':!*/build/*' \
        ':!*/.next/*' \
        2>/dev/null
    local _add_rc=$?
    if [ "$_add_rc" -ne 0 ]; then
        timeout "$_git_timeout" git -C "$_commit_root" add -A 2>/dev/null
        _add_rc=$?
    fi
    set -e
    if [ "$_add_rc" -ne 0 ]; then
        if [ "$_add_rc" -eq 124 ]; then
            warning "  [commit_completed_story] git add timed out after ${_git_timeout}s for ${story_id} — work remains staged/uncommitted"
        else
            warning "  [commit_completed_story] git add failed (exit ${_add_rc}) for ${story_id} — work remains staged/uncommitted"
        fi
        return 1
    fi

    local _changed_count
    _changed_count=$(timeout "$_git_timeout" git -C "$_commit_root" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    if [ "${_changed_count:-0}" -eq 0 ]; then
        return 0
    fi

    # Generic credential scan (flow-gap analysis finding #2, 2026-07-12): no
    # commit site in this pipeline scanned staged changes for accidentally-
    # committed secrets before this. SAST (Step 4.2) is the first thing that
    # even looks at code content for this, and it runs long after this commit
    # would already be in git history. scan-secrets.sh is generic and stack-
    # agnostic (well-known credential formats only) — see its own header.
    local _scan_sh="${SCRIPT_DIR}/scan-secrets.sh"
    if [ "${SKIP_SECRET_SCAN:-true}" != "true" ] && [ -f "$_scan_sh" ]; then
        local _scan_output _scan_rc
        # set +e/-e (found live, 2026-07-14, same incident as the git-add fix
        # above): `var=$(failing_cmd)` as a bare assignment statement is
        # ALSO a set -e trigger — scan-secrets.sh exiting non-zero (its
        # intentional, designed signal for "found a secret") killed the
        # whole script on THIS line, one statement before `_scan_rc=$?` and
        # the warning/return-1 handling below ever ran, so a real secret hit
        # (or, per this incident, any other non-zero exit from the scan)
        # silently took down every remaining story in the lane instead of
        # gracefully unstaging and skipping just this one commit.
        set +e
        _scan_output=$(bash "$_scan_sh" "$_commit_root" 2>&1)
        _scan_rc=$?
        set -e
        if [ "$_scan_rc" -ne 0 ]; then
            warning "  [commit_completed_story] $_scan_output"
            warning "  [commit_completed_story] Refusing to commit for ${story_id} — unstaging (SECRET_SCAN)"
            timeout "$_git_timeout" git -C "$_commit_root" reset 2>/dev/null || true
            return 1
        fi
    fi

    if timeout "$_git_timeout" git -C "$_commit_root" commit -m "story: complete ${story_id} (${_changed_count} file(s))" >/dev/null 2>&1; then
        log "  Committed ${_changed_count} file(s) for ${story_id}"
    else
        local _commit_rc=$?
        if [ "$_commit_rc" -eq 124 ]; then
            warning "  [commit_completed_story] git commit timed out after ${_git_timeout}s for ${story_id} — work remains staged/uncommitted"
        else
            warning "  Commit failed for ${story_id} — work remains staged/uncommitted"
        fi
    fi
}

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

        # Same live-status re-check the main lane's Step 1 loop already does
        # (run-agent-orchestration.sh) — a worktree-lane story can be
        # deprecated by a mid-execution split rejection, or blocked by the
        # inline TC writer gate below, after this loop's own story list was
        # built. Parity required: "all lanes must have the same flow no
        # deviations."
        local _wt_story_status
        _wt_story_status=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .status // "pending"' \
            "$PRD_FILE" 2>/dev/null || echo "pending")
        if [ "$_wt_story_status" = "deprecated" ]; then
            info "Skipping $story_id — deprecated after being enqueued (mid-execution split rejected this story)"
            skipped=$((skipped + 1))
            continue
        fi
        if [ "$_wt_story_status" = "blocked" ]; then
            info "Skipping $story_id — blocked (no valid testCriteria after 3 attempts, see blocked-stories.jsonl)"
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

        # Inline TC writer gate — same shared check the main lane runs
        # (lib/tc-writer-gate.sh), now also applied to worktree lanes (this
        # was the gap: worktree-lane pure-test stories used to run their
        # entire first execution with testCriteria.facts=[] since the only
        # other TC mechanism, the batch Step 1.6 gate, runs after Step 3.2 —
        # i.e. after this loop has already finished).
        local _wt_tc_phase
        _wt_tc_phase="${phase_filter:-$(get_story_phase "$story_id")}"
        if ! run_inline_tc_writer_gate "$story_id" "$_wt_tc_phase"; then
            skipped=$((skipped + 1))
            continue
        fi

        # Remaining per-story guards the main lane's Step 1 loop already runs
        # (run-agent-orchestration.sh), now shared via lib/story-guards.sh so
        # worktree lanes get the identical cost-budget circuit breaker,
        # pause/resume support, and operator redirects a main-lane story
        # already has. PHASE is set as a plain global (not `local`) because
        # these guards read $PHASE directly — same convention
        # run-agent-orchestration.sh itself already uses.
        PHASE="$_wt_tc_phase"
        check_cost_budget
        wait_if_paused
        apply_redirect_if_any "$story_id"

        # Implement the story
        if implement_story "$story_id"; then
            update_story_status "$story_id" "completed"
            implemented=$((implemented + 1))
            # Deterministically regenerate the dependency contract from the actual
            # source this story just wrote — before committing, so the contract file
            # itself is included in the same commit and visible to dependent stories.
            # Diagnostic timestamps (added 2026-07-06): a live run's watchdog killed
            # a story's claude.sh subprocess after 600s even though the story itself
            # had already succeeded in 15s — neither generate_story_contract() nor
            # commit_completed_story() logged anything before/after, so it was
            # impossible to tell which one (if either) actually hung. These log
            # lines make the next occurrence immediately diagnosable instead of
            # another blind guess.
            log "  [post-story] Generating dependency contract for $story_id..."
            generate_story_contract "$story_id"
            log "  [post-story] Contract generation complete for $story_id"
            # Commit this story's work immediately. Stories in the same worktree run
            # sequentially (chained by dependency), and if a LATER story in this loop
            # exhausts its retries and fails, the whole worktree process returns non-zero
            # — which makes the orchestrator skip Step 3.1/3.2 (auto-commit + merge)
            # entirely and force-remove the worktree, permanently destroying every
            # earlier story's uncommitted work. Committing per-story means that work
            # survives on the wt-* branch (worktree removal deletes the checkout, not
            # the branch/commits) even when a downstream story in the chain fails.
            log "  [post-story] Committing completed work for $story_id..."
            # `|| true` (found live, 2026-07-14, same incident as the two
            # set -e fixes inside commit_completed_story() itself): this
            # whole script runs under `set -e`. commit_completed_story()
            # legitimately returns 1 on a git-add failure or a secret-scan
            # rejection (both already logged via `warning` before it
            # returns) — a bare, unguarded call to a function that returns
            # non-zero is ITSELF a set -e trigger at the call site, so even
            # after fixing the function's own internals to fail gracefully,
            # this call would still have silently killed the whole worktree
            # lane (every remaining story in it) over one story's commit
            # being correctly skipped. The failure is already fully logged
            # inside the function; there is nothing more to do here.
            commit_completed_story "$story_id" || true
            log "  [post-story] Commit step complete for $story_id"

            # Same post-story guards the main lane's Step 1 loop runs after a
            # successful story (run-agent-orchestration.sh) — parity per
            # "all lanes must have the same flow no deviations": TypeScript
            # compile gate, actualCost written back to prd.json (falls back
            # to phase-cost.jsonl since there's no per-story log file to grep
            # in-process — see record_story_actual_cost's docstring), and
            # mid-execution split validation before the NEXT story in this
            # lane runs.
            if ! story_tsc_gate "$story_id"; then
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            fi
            record_story_actual_cost "$story_id"
            validate_mid_execution_splits "$PHASE"
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
# Runs git commands from GIT_WORK_ROOT (the directory containing .git)
# Worktrees are created as siblings of GIT_WORK_ROOT
setup_worktrees() {
    local worktrees=("primary" "independent")
    local git_root
    git_root="$(cd "$GIT_WORK_ROOT" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Setting up git worktrees (git root: $git_root)..."

    # Validate GIT_WORK_ROOT is a git repo
    if ! git -C "$git_root" rev-parse --is-inside-work-tree &>/dev/null; then
        error "GIT_WORK_ROOT ($git_root) is not a git repository"
        return 1
    fi

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"
        local wt_branch="wt-$wt"

        # A directory existing at $wt_path is NOT sufficient proof of a usable
        # worktree — a prior crash (or a raw `rm -rf` instead of `git worktree
        # remove`) can leave a stale, non-git-tracked directory here, or a
        # directory whose worktree registration was lost. Silently "continuing"
        # on directory-existence alone left the CALLER believing a real
        # worktree was set up when it wasn't — verify it's actually a
        # registered, valid worktree of THIS repo before skipping creation.
        if [ -d "$wt_path" ]; then
            # `git worktree list --porcelain` reports canonicalized, resolved
            # paths — $wt_path contains a literal `..` component, so a raw
            # string comparison against the porcelain output NEVER matches
            # even for a genuinely valid worktree. Resolve $wt_path the same
            # way before comparing.
            local wt_path_resolved
            wt_path_resolved="$(cd "$wt_path" 2>/dev/null && pwd)"
            if [ -n "$wt_path_resolved" ] && git -C "$git_root" worktree list --porcelain 2>/dev/null | grep -q "^worktree ${wt_path_resolved}$"; then
                warning "Worktree already exists and is valid: $wt_path"
                continue
            fi
            warning "Stale non-worktree directory found at $wt_path (not registered with git) — removing before recreating"
            rm -rf "$wt_path"
        fi

        # Delete branch if it exists from previous run
        if git -C "$git_root" show-ref --verify --quiet "refs/heads/$wt_branch"; then
            info "Deleting existing branch: $wt_branch"
            git -C "$git_root" branch -D "$wt_branch" 2>/dev/null || true
        fi

        # Create worktree with a new branch based on current HEAD
        info "Creating worktree: $wt ($wt_path) on branch $wt_branch"
        git -C "$git_root" worktree add -b "$wt_branch" "$wt_path" HEAD || {
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
    local git_root
    git_root="$(cd "$GIT_WORK_ROOT" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Cleaning up git worktrees..."

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"
        local wt_branch="wt-$wt"

        # Check if worktree exists
        if [ ! -d "$wt_path" ]; then
            info "Worktree does not exist: $wt_path (already removed)"
        else
            # Remove worktree — fall back to manual rm + prune if `git worktree
            # remove` fails (e.g. the directory was already partially deleted
            # out-of-band), so a failed removal never leaves the checkout
            # behind for the next run to trip over.
            info "Removing worktree: $wt ($wt_path)"
            if ! git -C "$git_root" worktree remove "$wt_path" --force 2>/dev/null; then
                warning "git worktree remove failed for $wt — falling back to manual rm + prune"
                rm -rf "$wt_path"
            fi
        fi

        # Prune BEFORE attempting the branch delete below — if the worktree
        # directory was removed out-of-band (not via `git worktree remove`),
        # git still considers the branch "checked out" by the orphaned admin
        # metadata and silently refuses `git branch -D` until pruned. This bug
        # was found live via this exact scenario in this function's own tests.
        git -C "$git_root" worktree prune 2>/dev/null || true

        # Delete the branch too — a worktree checkout being removed does NOT
        # delete the branch it pointed to, and a leftover branch collides with
        # the NEXT setup_worktrees() call's `git worktree add -b $wt_branch`
        # (the exact "fatal: a branch named 'wt-primary' already exists" live
        # failure this fixes). setup_worktrees() also deletes stale branches
        # defensively, but cleanup should not rely on the next run to do it.
        if git -C "$git_root" show-ref --verify --quiet "refs/heads/$wt_branch"; then
            git -C "$git_root" branch -D "$wt_branch" 2>/dev/null || true
        fi
    done

    # Prune worktree references
    git -C "$git_root" worktree prune

    # Final verification — a pristine cleanup MUST end with zero wt-* worktrees
    # registered. Fail loudly instead of silently leaving a corrupt registry.
    local remaining
    remaining=$(git -C "$git_root" worktree list --porcelain 2>/dev/null | grep -c "^worktree .*-wt-\(primary\|independent\)$" || true)
    if [ "${remaining:-0}" -gt 0 ]; then
        error "Worktree cleanup incomplete — ${remaining} wt-* worktree(s) still registered"
        git -C "$git_root" worktree list
        return 1
    fi

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
  By default, the script runs with --dangerously-bypass-approvals-and-sandbox to allow
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
                # Save main project root BEFORE switching to worktree path.
                # technicalNotes.files in the PRD contain absolute paths referencing
                # the main repo (e.g. /path/to/skyscanner-app/src/foo.ts).
                # We rewrite these to the worktree path in verify_story_deliverables
                # and in the agent prompt so agents write to the worktree, not the main repo.
                MAIN_PROJECT_ROOT="$(cd "$GIT_WORK_ROOT" && pwd)"
                # Update GIT_WORK_ROOT and PROJECT_ROOT to worktree for file operations
                local _git_basename
                _git_basename="$(basename "$MAIN_PROJECT_ROOT")"
                GIT_WORK_ROOT="$(cd "$GIT_WORK_ROOT/.." && pwd)/${_git_basename}-wt-$WORKTREE_MODE"
                PROJECT_ROOT="$GIT_WORK_ROOT"
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
    # Skip when phase_filter is empty — per-story invocations have no phase context
    [ -z "$WORKTREE_MODE" ] && [ "${SKIP_SKILL_ASSESSMENT:-0}" != "1" ] && [ -n "$phase_filter" ] && run_pre_phase_assessment "$phase_filter"

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
    local profiles_file="$AGENT_PROFILES_FILE"
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
You are the skill assessment agent running in PRE-PHASE mode. Your job is to detect skill gaps in agent profiles BEFORE the phase runs, augment profiles with missing knowledge, and ensure test stories have the correct agent role.

## PRD STRUCTURE (read this carefully before issuing any jq commands)
The PRD file uses a FLAT structure — not nested phases. Key paths:
- Story list: .stories[]
- Phase story order: .implementationOrder["${phase_id}"] — returns an array of story IDs
- Story lookup: .stories[] | select(.id == "<id>")
- Agent role: .stories[] | select(.id == "<id>") | .agentRole
- Files: .stories[] | select(.id == "<id>") | .technicalNotes.files[]

DO NOT use .phases[0] — that path does not exist in this PRD.

## Task
1. Run: jq -r '.implementationOrder["${phase_id}"][]' ${prd_rel}
   This gives you the list of story IDs for this phase.

2. For each story ID, run: jq -c '.stories[] | select(.id == "<id>") | {id, agentRole, unitTests, technicalNotes}' ${prd_rel}

3. ROLE VERIFICATION: For any story where all files in technicalNotes.files match *.test.ts or *.spec.ts:
   - If agentRole is not "test-engineer", update it: jq --arg id "<id>" '(.stories[] | select(.id == \$id)).agentRole = "test-engineer"' ${prd_rel} > /tmp/prd_tmp.json && mv /tmp/prd_tmp.json ${prd_rel}
   - Ensure the test-engineer profile exists in orchestrations/agents/profiles.json

4. PROFILE CREATION: If "test-engineer" key is missing from profiles.json, add it based on the project's techStack in the PRD (read .project.techStack).

5. SKILL GAP FILL: For each story, compare agentRole profile text against technicalNotes.requiredSkills. Add missing skills as sentences. Keep profiles.json valid JSON.

6. Append JSONL audit records to orchestrations/logs/profiles-audit.jsonl using flock.

7. Write summary to orchestrations/logs/phase-improvements/pre-${phase_id}.md

Known skill categories: deployment_platform, language, framework, testing, database, infrastructure, api, cloud_service

CRITICAL: Keep profiles.json valid JSON. Only ADD content, never remove. Use the exact jq paths above.

## Phase: ${phase_id}
PROMPT_HEADER
    )

    cd "$PROJECT_ROOT"
    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    local _orch_model="${ORCH_GATE_MODEL:-}"
    if [ -z "$_orch_provider" ]; then
        warning "Pre-phase assessment: EPAM_ORCHESTRATION_PROVIDER not set — skipping (non-critical)"
    # AI_GATE_ALLOW_TOOLS=1: the prompt above instructs the agent to run real
    # jq commands against the PRD and read/write orchestrations/agents/profiles.json
    # directly — without this, ai-run.sh's epam-umbrella branch defaults to
    # --no-tools, so the agent can't actually run jq or touch any file; it can
    # only print a JSON description of what it WOULD do, and no real profile
    # augmentation or role-fix ever happens (found live 2026-07-08 — a run's
    # assessment step logged a fabricated "content" diff for profiles.json that
    # was never actually written to disk).
    elif echo "$assessment_prompt" | \
            AI_GATE_ALLOW_TOOLS=1 \
            AI_PROVIDER="$_orch_provider" \
            AI_MODEL="$_orch_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
            ${_orch_model:+--model "$_orch_model"} \
            2>&1 | tee "$assessment_log"; then
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
