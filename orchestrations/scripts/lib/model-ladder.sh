#!/usr/bin/env bash
# model-ladder.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (29 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# Load EPAM_PROJECT_CONFIG_DIR/llm-settings.json (schema:
# orchestrations/config/llm-settings.schema.json) as FALLBACK DEFAULTS for the
# ladder/retry/self-heal/cost-control settings below — every value here only
# fires when the corresponding EPAM_* var isn't already set (tier-script env,
# a project .env file, or the launch shell all still win). This must run
# before MAX_RETRIES is read a few lines down, so it's called immediately.
load_llm_settings_json() {
    local _settings_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}"
    # NOTE: no early return when the project has no settings file. The engine-wide budget
    # defaults below must still be applied — returning here left every budget unset and the
    # literals in the case statement were the only thing filling them in.
    [ -f "$_settings_file" ] || _settings_file="/dev/null"

    # `|| true` is load-bearing (found live, 2026-08-02): this function runs
    # under `set -e` (claude.sh:18) — a malformed llm-settings.json makes jq
    # exit non-zero on the PARSE error itself (the `// empty` fallback only
    # covers a valid-but-absent VALUE, not a parse failure), and every call
    # site here is `_v=$(_get ...)`, a bare simple command whose failing exit
    # status would otherwise kill the whole script under set -e — silently
    # contradicting this loader's own "malformed config never blocks" intent.
    _get() { jq -r "$1 // empty" "$_settings_file" 2>/dev/null || true; }
    local _v

    # Per-story BUDGETS: engine-wide defaults, project overrides. Two tiers so a project
    # states only what it changes. These were literals in the effort-tier case statement
    # below — the exact knobs an operator tunes, invisible and uneditable without a code
    # change. `|| true` for the same set -e reason documented above.
    local _defaults_file="${EPAM_LLM_DEFAULTS_FILE:-$AUTOMATION_DIR/config/llm-defaults.json}"
    _getd() { jq -r "$1 // empty" "$_defaults_file" 2>/dev/null || true; }
    _budget() {  # <jq-path> <env-var>: project value wins, else engine default
        local _path="$1" _var="$2" _val
        _val=$(_get "$_path"); [ -n "$_val" ] || _val=$(_getd "$_path")
        [ -n "$_val" ] && [ -z "${!_var:-}" ] && export "$_var=$_val"
        # ALWAYS succeed. A trailing false test makes this function return 1, and under
        # `set -e` that propagates out of load_llm_settings_json and kills the caller — the
        # same trap this file documents for the git-add and scan-secrets blocks. "No value
        # to apply" is the normal case, not an error.
        return 0
    }
    local _tier
    for _tier in low medium high; do
        _budget ".effortTiers.${_tier}.maxIterations"   "EPAM_EFFORT_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]')_MAX_ITERATIONS"
        _budget ".effortTiers.${_tier}.maxOutputTokens" "EPAM_EFFORT_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]')_MAX_OUTPUT_TOKENS"
    done
    _budget '.roleOverrides.generator.maxIterations'   'EPAM_ROLE_GENERATOR_MAX_ITERATIONS'
    _budget '.roleOverrides.generator.maxOutputTokens' 'EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS'
    _budget '.outputTokenFloors.planning' 'EPAM_OUTPUT_FLOOR_PLANNING'
    _budget '.outputTokenFloors.review'   'EPAM_OUTPUT_FLOOR_REVIEW'
    _budget '.outputTokenFloors.mutation' 'EPAM_OUTPUT_FLOOR_MUTATION'

    _v=$(_get '[.planning.autoPlannerTiers[]?] | join("|")'); [ -z "${EPAM_AUTO_PLANNER_TIERS:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_PLANNER_TIERS="$_v"
    _v=$(_get '.planning.temperature'); [ -z "${EPAM_PLANNING_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_TEMPERATURE="$_v"
    _v=$(_get '.planning.topP'); [ -z "${EPAM_PLANNING_TOP_P:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_TOP_P="$_v"
    _v=$(_get '.planning.reasoningEffort'); [ -z "${EPAM_PLANNING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_EFFORT="$_v"
    _v=$(_get '[.ladders | keys[]] | join("|")')
    [ -z "${EPAM_LADDER_TIERS:-}" ] && [ -n "$_v" ] && export EPAM_LADDER_TIERS="$_v"
    _v=$(_get '[.effortLadder[]?] | join("|")')
    [ -z "${EPAM_EFFORT_LADDER:-}" ] && [ -n "$_v" ] && export EPAM_EFFORT_LADDER="$_v"
    _v=$(_get '.temperatureFloor'); [ -z "${EPAM_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_TEMPERATURE="$_v"

    _v=$(_get '.retries.maxRetries'); [ -z "${EPAM_MAX_RETRIES:-}" ] && [ -n "$_v" ] && export EPAM_MAX_RETRIES="$_v"
    _v=$(_get 'if .retries.selfHeal.enabled == true then "1" elif .retries.selfHeal.enabled == false then "0" else empty end')
    [ -z "${EPAM_RETRY_EXTENSION_ENABLED:-}" ] && [ -n "$_v" ] && export EPAM_RETRY_EXTENSION_ENABLED="$_v"
    _v=$(_get '.retries.selfHeal.extensionMax'); [ -z "${EPAM_RETRY_EXTENSION_MAX:-}" ] && [ -n "$_v" ] && export EPAM_RETRY_EXTENSION_MAX="$_v"

    _v=$(_get '.timeouts.secondsPerIteration'); [ -z "${EPAM_SECONDS_PER_ITERATION:-}" ] && [ -n "$_v" ] && export EPAM_SECONDS_PER_ITERATION="$_v"
    _v=$(_get '.timeouts.storyTimeoutMaxSecs'); [ -z "${EPAM_STORY_TIMEOUT_MAX_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_MAX_SECS="$_v"
    _v=$(_get '.timeouts.storyTimeoutSecs'); [ -z "${EPAM_STORY_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_SECS="$_v"
    _v=$(_get '.timeouts.gateTimeoutSecs'); [ -z "${EPAM_GATE_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_GATE_TIMEOUT_SECS="$_v"
    # The test timeout belongs with the other timeouts, not in config.env. It was the only one a
    # project could not declare: six call sites read a bare ${EPAM_TEST_TIMEOUT_SECS:-300} with no
    # declared source, so raising it meant reintroducing the duplication that consolidating
    # timeouts into this file removed (EPAM_STORY_TIMEOUT_SECS had already drifted 690 vs 600).
    # 300s is a real constraint on a large suite, and when `timeout` kills it the run reports
    # FAILING TESTS rather than a timeout.
    _v=$(_get '.timeouts.testTimeoutSecs'); [ -z "${EPAM_TEST_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_TEST_TIMEOUT_SECS="$_v"

    _v=$(_get '.brownfield.minOutputTokens'); [ -z "${EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS:-}" ] && [ -n "$_v" ] && export EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS="$_v"
    _v=$(_get '.brownfield.maxScaledIterations'); [ -z "${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-}" ] && [ -n "$_v" ] && export EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS="$_v"

    _v=$(_get '.compaction.defaultAutoCompressAt'); [ -z "${EPAM_AUTO_COMPRESS_AT:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_COMPRESS_AT="$_v"
    _v=$(_get '.compaction.defaultAutoCompressEveryNIterations'); [ -z "${EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS="$_v"

    # Per-rung temperature/effort overrides — rungs[] is shared by BOTH
    # ladders (only the model each rung resolves to differs), so these env
    # vars are read once, not per-ladder. iterationBump/outputTokenBump are
    # NOT wired here — those are still hardcoded in the rung case statement
    # (driven by CPA's iterationEstimate scaling and the brownfield output
    # floor respectively), so the rungs[] entries for those two fields are
    # documentation of current behavior only, not yet a configurable input.
    _v=$(_get '.rungs[] | select(.rung==0) | .reasoningEffort'); [ -z "${EPAM_RUNG0_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG0_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==1) | .reasoningEffort'); [ -z "${EPAM_RUNG1_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG1_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==2) | .reasoningEffort'); [ -z "${EPAM_RUNG2_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG2_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==3) | .reasoningEffort'); [ -z "${EPAM_RUNG3_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG3_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==1) | .temperature'); [ -z "${EPAM_RUNG1_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG1_TEMPERATURE="$_v"
    _v=$(_get '.rungs[] | select(.rung==2) | .temperature'); [ -z "${EPAM_RUNG2_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG2_TEMPERATURE="$_v"
    _v=$(_get '.rungs[] | select(.rung==3) | .temperature'); [ -z "${EPAM_RUNG3_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG3_TEMPERATURE="$_v"

    # Model ladder chains: modelLadder[] -> "from=to|from2=to2" string, matching
    # EPAM_MODEL_LADDER_HIGH/MEDIUM's existing format exactly (the format the
    # ladder-step lookup function further below already parses) — this is a
    # direct serialization, not a new format.
    # ONE READER FOR THE LADDERS — lib/model-ladders.sh, shared with every other entry point.
    # This used to be three hand-written lines here and NOWHERE ELSE, so a process that did not
    # start from this script (detective-rerun.sh) had no ladders at all.
    # ${SCRIPT_DIR:-} and a guarded source: this function runs under `set -e` AND is exercised
    # under `set -u`, where a bare $SCRIPT_DIR aborts the WHOLE loader and every budget below it
    # silently goes unset — which is exactly what happened when this was first written.
    # seam-ladder.sh alongside it: the ladders give the CHAINS, the seams say which position an
    # agent occupies. Reading one without the other is how a model literal stayed necessary here.
    local _sl_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/seam-ladder.sh"
    # shellcheck source=lib/seam-ladder.sh
    [ -f "$_sl_lib" ] && . "$_sl_lib"
    local _ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
    if [ -f "$_ml_lib" ]; then
        # shellcheck source=lib/model-ladders.sh
        . "$_ml_lib" || true
        command -v export_model_ladders >/dev/null 2>&1 && export_model_ladders "$_settings_file" || true
    fi

    # Model-specific overrides (modelOverrides.*) are NOT flattened into env
    # vars here — there can be any number of entries (e.g. separate MiniMax-M2.5
    # vs MiniMax-M3 tuning), so a fixed set of env var names can't represent
    # them. They're read directly from $_settings_file at invocation time,
    # per-attempt, against the FINAL resolved STORY_PROVIDER/STORY_MODEL — see
    # the "Model-specific overrides" block in the provider-invocation code,
    # ~line 7700.

    # Cost controls
    _v=$(_get '.costControls.maxToolCallsPerStory'); [ -z "${EPAM_STORY_MAX_TOOL_CALLS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_MAX_TOOL_CALLS="$_v"
    _v=$(_get '.costControls.storyBudgetWarningUsd'); [ -z "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] && [ -n "$_v" ] && export EPAM_STORY_BUDGET_WARNING_USD="$_v"
    _v=$(_get '.costControls.storyBudgetHardLimitUsd'); [ -z "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ] && [ -n "$_v" ] && export EPAM_STORY_BUDGET_HARD_LIMIT_USD="$_v"

    unset -f _get
    echo "  LLMSettings: loaded fallback defaults from $_settings_file" >&2
}

# Effort -> model + max-turns mapping
# Stories carry an optional "effort" field: low | medium (default) | high
# These map to a model and a max-turns cap for the Claude CLI invocation.
# Env-overridable, not hardcoded to one provider's model: a project whose
# story's aiProvider is never "codex" (e.g. Metrolinx, which routes brownfield
# work through minimax/openrouter) still got "gpt-5-codex" here as the CONFIG
# DEFAULT resolve_model_from_story() falls back to before overriding from the
# story's own .model field — harmless when the story sets .model, but a real
# footgun for any invocation path that reaches this default without one
# (found live, 2026-08-01: the writer sandbox test's first run invoked codex
# via this exact default, 4 straight zero-token failures, no OPENAI_API_KEY
# in the environment — this project never uses codex at all).
# THE LADDERS DICTATE EVERY MODEL CALL — NO EXCEPTIONS.
#
# These three defaulted to the literal `gpt-5-codex`: one model for all three effort tiers, and one
# with no entry in ANY ladder. So the effort axis collapsed to a constant — measured across 211
# archived story records, 205 carry the same assigned model — and an unresolved effort silently
# called a vendor this pipeline does not use.
#
# The tier START models are already exported by lib/model-ladders.sh from the project's own
# llm-settings.json (EPAM_MODEL_LADDER_<TIER>_START). Effort maps onto the project's DECLARED tier
# order, lowest to highest, so a project that names its tiers differently — or declares four of
# them — still resolves without this file knowing any of their names.
#
# Unresolved stays EMPTY on purpose. A wrong model is more expensive than a stopped run and far
# harder to notice; the caller checks and fails rather than substituting something plausible.
_effort_model_for_position() {
    local _pos="$1" _order _tier _var
    # Declared lowest-to-highest. Env first (operator override), then whatever the project declared.
    _order="${EPAM_MODEL_LADDER_TIER_ORDER:-}"
    [ -n "$_order" ] || return 0
    # shellcheck disable=SC2086
    set -- $_order
    case "$_pos" in
        low)    _tier="${1:-}" ;;
        medium) _tier="${2:-${1:-}}" ;;
        high)   _tier="${3:-${2:-${1:-}}}" ;;
        *)      return 0 ;;
    esac
    [ -n "$_tier" ] || return 0
    _var="EPAM_MODEL_LADDER_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9\n' '_')_START"
    printf '%s' "${!_var:-}"
}

# resolve_effort_settings <story_id>
# Sets STORY_MODEL and STORY_MAX_TURNS globals based on story's effort field.
resolve_effort_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local effort
    effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .effort // "medium"' \
        "$prd_target" 2>/dev/null || echo "medium")

    # A self-heal `effort_tier` constraint compiles to EPAM_EFFORT_TIER. Apply it
    # UPGRADE-ONLY: this is the one place that holds BOTH the story's tier and the
    # proposed one, so the comparison needs no baseline plumbing — which is exactly
    # what defeated four successive numeric guards.
    #
    # A downgrade after a failure would repeat the mistake the raw integers made
    # (EPAM_MAX_ITERATIONS=1 "to prevent iterative retries"): taking room away from
    # an agent that ran out of it. Refused, and said out loud.
    if [ -n "${EPAM_EFFORT_TIER:-}" ]; then
        # RANKED BY THE PROJECT'S DECLARED effortLadder, not by tier names written here. The four
        # case statements this replaces knew three of the four declared tiers, so "max" ranked
        # below "high" and the highest effort a project can ask for was silently treated as mid.
        local _rank_new
        _rank_new=$(effort_rank "$EPAM_EFFORT_TIER")
        if effort_is_higher "$EPAM_EFFORT_TIER" "$effort"; then
            log "  EffortTier[KB] -> upgrading ${effort} → ${EPAM_EFFORT_TIER} (self-heal constraint)"
            effort="$EPAM_EFFORT_TIER"
        elif [ "$_rank_new" -gt 0 ]; then
            log "  EffortTier[KB] -> IGNORING ${EPAM_EFFORT_TIER} (not an upgrade on ${effort}); budgets are increase-only"
        fi
    fi

    # CPA's own complexity judgment (gate=review|block, complexityAdjustment)
    # and the detective's coverage check (checkFixSiteCoverage, spec-mode-
    # runner.js) each persist an upgrade-only effort signal onto the story —
    # cpaEffortTier (contextualize-stories.sh) and
    # fixSiteAnalysisCoverage.complete. Neither ever touched the REAL
    # iteration/token budget before this fix: cpaEffortTier only fed
    # ladderTier (which MODEL handles escalation retries, not how many turns
    # the implementer gets), and coverage was not read here at all. Live
    # AMSD-2041, 2026-08-01: CPA flagged gate="review"/1.3x and the
    # detective's 2-site prescription left 4 verification criteria uncovered,
    # but STORY_MAX_ITERATIONS stayed keyed to the story's untouched "low"
    # input classification — the implementer got the smallest budget for a
    # change every downstream signal had already flagged as underscoped.
    # Same upgrade-only discipline as the EPAM_EFFORT_TIER block above: never
    # take room away, only ever add it when a later signal says more is needed.
    local _cpa_tier _cov_complete
    _cpa_tier=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .cpaEffortTier // ""' "$prd_target" 2>/dev/null || echo "")
    # NOTE: deliberately NOT `.fixSiteAnalysisCoverage.complete // true` — jq's
    # `//` treats a literal `false` as falsy too, so that would silently turn
    # every real "incomplete" (false) result into "true". Explicit null check.
    _cov_complete=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | (if .fixSiteAnalysisCoverage.complete == null then true else .fixSiteAnalysisCoverage.complete end)' "$prd_target" 2>/dev/null || echo "true")
    local _proposed_tier="$_cpa_tier"
    if [ "$_cov_complete" = "false" ]; then
        # An incomplete prescription always needs at least "medium" — a gap in
        # the detective's own coverage must never silently leave a story at "low".
        case "$_proposed_tier" in high) : ;; *) _proposed_tier="medium" ;; esac
    fi
    # A DECLARED AGENT IS AUTHORITATIVE. CPA MAY PROPOSE, NOT OVERRIDE.
    #
    # CPA estimates a story's shape and proposes an effort tier. That is the right input where an
    # agent has no settled opinion. Where the ARCHETYPE declares its own effort, the operator has
    # already decided how much room that role gets, and a per-story estimate must not move it —
    # the estimate knows the story, not the role.
    #
    # THE PROTECTED SET IS DERIVED, NEVER LISTED. An archetype that declares `effort` in
    # invocation-profiles.json is protected; one that declares nothing keeps the previous
    # behaviour exactly. No agent name appears here, so protecting a new role is a declaration
    # and never an engine change.
    local _declared_effort=""
    if [ -n "${story_role:-}" ]; then
        _declared_effort=$("${NODE_BIN:-node}" -e '
          const { resolveSeam } = require(process.argv[1]);
          try {
            const reg = process.argv[2];
            const seam = resolveSeam(process.argv[3], reg);
            const p = JSON.parse(require("fs").readFileSync(reg, "utf8")).profiles[seam] || {};
            process.stdout.write(p.effort == null ? "" : String(p.effort));
          } catch (_) { process.stdout.write(""); }
        ' "$SCRIPT_DIR/lib/seam-invocation.js" \
          "${AGENT_PROFILES_REGISTRY:-$(dirname "$SCRIPT_DIR")/agents/invocation-profiles.json}" \
          "$story_role" 2>/dev/null || printf '')
    fi

    if [ -n "$_declared_effort" ]; then
        effort="$_declared_effort"
        if [ -n "$_proposed_tier" ] && [ "$_proposed_tier" != "$_declared_effort" ]; then
            log "  EffortTier[CPA] -> NOT overriding '${story_role}': its archetype declares effort=${_declared_effort} (CPA proposed ${_proposed_tier})"
        fi
    elif [ -n "$_proposed_tier" ]; then
        # Same declared ranking as the KB block above — one source, one order.
        if effort_is_higher "$_proposed_tier" "$effort"; then
            log "  EffortTier[CPA] -> upgrading ${effort} → ${_proposed_tier} (cpaEffortTier=${_cpa_tier:-none} coverageComplete=${_cov_complete})"
            effort="$_proposed_tier"
        fi
    fi

    case "$effort" in
        low)
            STORY_MODEL="$EFFORT_MODEL_LOW"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_LOW_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_LOW_MAX_OUTPUT_TOKENS}"
            ;;
        high)
            STORY_MODEL="$EFFORT_MODEL_HIGH"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_HIGH_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            ;;
        *)  # medium (default)
            STORY_MODEL="$EFFORT_MODEL_MEDIUM"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_MEDIUM_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
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
    log "  Effort[$effort] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"
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
        STORY_MAX_ITERATIONS="${EPAM_ROLE_GENERATOR_MAX_ITERATIONS}"
        STORY_MAX_OUTPUT_TOKENS="${EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS}"
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
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_MEDIUM_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            log "  TestEngineerEffortFloor: low -> medium (maxIter=10 maxOutTok=6144) -- test-writing needs more research/verification turns than impl at the same tier"
            ;;
        medium)
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_HIGH_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
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
    #
    # But "a prescription exists" != "the prescription is minimal": the shortcut above
    # was applied to ANY story with at least one helper-bearing finding, including
    # multi-site fixes and fixes checkFixSiteCoverage (spec-mode-runner.js) flags as
    # not addressing some of the story's own verification criteria. Live AMSD-2041,
    # 2026-08-01: 2 fixSiteAnalysis entries + 4 uncovered VCs still got floor=6-12 —
    # the same budget as a true one-file fix — for a change review confirmed needed
    # 7-8 files touched (SDK install, service layer, interfaces, API route, tests).
    # Only take the fast, low-iteration path for a GENUINE single-site, fully-covered
    # fix; otherwise scale the floor with how much the detective actually left unsaid.
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    # Ceiling, computed once regardless of which branch below fires: more
    # iterations means more accumulated ReAct-conversation re-sent on every
    # turn — the same mechanism that made 11 "wasted" iterations balloon
    # input to ~169K tokens on a SIMPLE story (see the 2026-07-24 note
    # above). Left unbounded, a large-enough story could trade
    # "under-budgeted" for "runs into a real context-window limit mid-run"
    # instead of a clean "reached maximum iterations". Capped, not silently
    # — a story that hits the cap is still logged so this isn't invisible.
    local _scaled_cap="${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-30}"
    local _num_sites _has_helper _num_uncovered
    _num_sites=$(jq -r --arg id "$story_id" '[.stories[] | select(.id==$id) | .fixSiteAnalysis[]?] | length' "$_prd_target" 2>/dev/null || echo 0)
    _has_helper=$(jq -r --arg id "$story_id" '[.stories[] | select(.id==$id) | .fixSiteAnalysis[]?.helper] | map(select(. != null and . != "")) | length' "$_prd_target" 2>/dev/null || echo 0)
    _num_uncovered=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.fixSiteAnalysisCoverage.uncoveredVerificationCriteria // []) | length' "$_prd_target" 2>/dev/null || echo 0)
    if [ "${_num_sites:-0}" -eq 1 ] && [ "${_has_helper:-0}" -gt 0 ] && [ "${_num_uncovered:-0}" -eq 0 ]; then
        _bf_min_iter="${EPAM_BROWNFIELD_PRESCRIBED_MIN_ITERATIONS:-6}"
    elif [ "${_num_sites:-0}" -gt 0 ] || [ "${_num_uncovered:-0}" -gt 0 ]; then
        local _scaled=$(( 8 + 4 * ${_num_sites:-0} + 3 * ${_num_uncovered:-0} ))
        if [ "$_scaled" -gt "$_scaled_cap" ]; then
            log "  BrownfieldEffortFloor: scaled iteration need (${_scaled}) exceeds cap (${_scaled_cap}) — capping. Story ${story_id} may be underscoped for a single implementation pass; consider a split."
            _scaled="$_scaled_cap"
        fi
        [ "$_scaled" -gt "$_bf_min_iter" ] && _bf_min_iter="$_scaled"
    fi

    # CPA's brownfield-only iterationEstimate — an ABSOLUTE turn-count
    # estimate (1-500, clamped in cpa-inference.js; persisted as
    # cpaIterationEstimate by contextualize-stories.sh — see cpa-system.md
    # "Iteration Estimate"), not a multiplier on top of whichever floor was
    # picked above. Redesigned 2026-08-01: a 1.0-3.0x multiplier on an
    # already-scaled base cannot span "5 for a bug fix" to "200 for a large
    # multi-layer change" — a real ~40x range. CPA sees the SAME
    # fixSiteAnalysis + coverage verdict fed into its prompt, plus KB
    # coverage, manifest facts, and the full verification criteria the
    # heuristic above cannot weigh holistically — it can correct a case the
    # naive single-site/helper/coverage-complete check misclassifies as
    # trivial (found live, 2026-08-01, AMSD-2041/upexpress: 1 site, has a
    # helper, coverage heuristic reported "complete" via a bag-of-words false
    # positive). Only ever raises the floor — a default of 1 (CPA never ran,
    # or genuinely found nothing extra) changes nothing.
    local _cpa_iter_estimate
    _cpa_iter_estimate=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.cpaIterationEstimate // 1)' "$_prd_target" 2>/dev/null || echo 1)
    if [ "${_cpa_iter_estimate:-0}" -gt "$_bf_min_iter" ] 2>/dev/null; then
        local _capped_estimate="$_cpa_iter_estimate"
        if [ "$_capped_estimate" -gt "$_scaled_cap" ]; then
            log "  BrownfieldEffortFloor: CPA iterationEstimate (${_cpa_iter_estimate}) exceeds cap (${_scaled_cap}) — capping."
            _capped_estimate="$_scaled_cap"
        fi
        log "  BrownfieldEffortFloor: CPA iterationEstimate raises floor ${_bf_min_iter} -> ${_capped_estimate}"
        _bf_min_iter="$_capped_estimate"
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

# _cap_brownfield_iterations_ceiling <context-label>
# The rung-based inference ladder adds +5 iterations on EVERY rung transition
# (see the ladder case statement below), independent of and AFTER whatever
# floor resolve_brownfield_effort_floor already established. A story whose
# floor is already at the EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS cap (e.g. 30)
# could still reach 45 by rung 3 (30 + 5 + 5 + 5) — the exact context-window
# risk that cap exists to prevent (found live, 2026-08-01, while reviewing
# the ceiling added to resolve_brownfield_effort_floor: that cap only bounds
# the STARTING budget, never the cumulative total after ladder escalation).
# Brownfield-only, same env var, same discipline: log when the cap actually
# trims something so this stays visible, never silent.
_cap_brownfield_iterations_ceiling() {
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _ceiling="${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-30}"
    if [ "${STORY_MAX_ITERATIONS:-0}" -gt "$_ceiling" ]; then
        log "  BrownfieldEffortFloor[$1]: ladder escalation pushed iterations to ${STORY_MAX_ITERATIONS}, exceeding cap (${_ceiling}) — capping."
        STORY_MAX_ITERATIONS="$_ceiling"
    fi
}

# _brownfield_rung_bump <story_id>
# The ladder's rung-transition bump used to be a flat +5 regardless of the
# story's actual complexity — a trivial retry and a genuinely complex one
# got the same increment. CPA's brownfield-only iterationEstimate
# (1-500, an ABSOLUTE turn count — cpa-system.md "Iteration Estimate")
# already estimates exactly this per story. Scale the bump as 10% of that
# estimate, floored at 5 (the unchanged default when CPA never ran, or
# estimated something small): estimate 1 -> +5, estimate 200 -> +20. A story
# CPA judges as needing 200 turns overall should not still get the SAME +5
# nudge per rung as a 1-turn story — that was the multiplier design's own
# blind spot, carried over. Greenfield (EPAM_BROWNFIELD unset) keeps the
# flat +5 — this signal doesn't exist for greenfield stories.
# _iteration_exhaustion_bump <story_id>
# CPA's cpaIterationEstimate is the ladder's only iteration-scaling signal
# (_brownfield_rung_bump above) — when CPA never populates it
# (cpaIterationEstimate: null, confirmed live 2026-08-01 on AMSD-2041: a real
# CMS live-preview integration story sat at the effort-tier default of 10-15
# iterations and hit "capability failure (max iterations)" 11 times in one
# run), that scaling produces almost nothing and the story is starved
# regardless of its real complexity. This bump responds to the OBSERVED
# symptom instead of trusting a single static estimate: every time
# classify_failure_class() logs a capability failure (max iterations) for
# THIS story, it appends an event to iteration-exhaustion.jsonl. Each prior
# occurrence adds EPAM_ITERATION_EXHAUSTION_BUMP (default 30) on top of
# whatever _brownfield_rung_bump already computed, capped at
# EPAM_ITERATION_EXHAUSTION_MAX_BUMP (default 200) so a story failing for
# OTHER reasons doesn't get an unbounded iteration budget.
_iteration_exhaustion_bump() {
    local story_id="$1"
    local _log_file="${LOG_DIR}/iteration-exhaustion.jsonl"
    [ -f "$_log_file" ] || { echo 0; return 0; }
    local _count
    _count=$(jq -s --arg id "$story_id" '[.[] | select(.story_id == $id)] | length' "$_log_file" 2>/dev/null || echo 0)
    local _per_bump="${EPAM_ITERATION_EXHAUSTION_BUMP:-30}"
    local _max_bump="${EPAM_ITERATION_EXHAUSTION_MAX_BUMP:-200}"
    awk -v c="${_count:-0}" -v per="$_per_bump" -v maxb="$_max_bump" \
        'BEGIN { bump = c * per; if (bump > maxb) bump = maxb; printf "%d", bump }'
}

_brownfield_rung_bump() {
    local story_id="$1"
    if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
        echo 5
        return 0
    fi
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _estimate
    _estimate=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.cpaIterationEstimate // 1)' "$_prd_target" 2>/dev/null || echo 1)
    awk -v est="$_estimate" 'BEGIN { if (est !~ /^[0-9.]+$/) est = 1; if (est < 1) est = 1; if (est > 500) est = 500; bump = int(est * 0.1 + 0.5); if (bump < 5) bump = 5; printf "%d", bump }'
}

resolve_model_from_story() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    # A ladder position restored for THIS story outranks the PRD's base model: the PRD says where
    # the story STARTS, the persisted rung says where it got to. Matched by VALUE, so a stale
    # marker from a previous story cannot suppress this story's own PRD model.
    if [ -n "${STORY_MODEL_LADDER_RESUMED:-}" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_LADDER_RESUMED}" ]; then
        log "  Model[prd.json] -> keeping resumed ladder position $STORY_MODEL (PRD declares ${story_model:-none})"
        return 0
    fi
    if [ -n "$story_model" ]; then
        STORY_MODEL="$story_model"
        log "  Model[prd.json] -> $STORY_MODEL (overrides effort default)"
        # ── Novel brownfield code starts at the top of the ladder ─────────────
        # LAD-2 forces ladderTier=high for a novel brownfield story, but the
        # MODEL is a separate field the coordinator has already written from
        # CPA's effort estimate — so live AMSD-2041 2026-07-29 still logged
        # "Effort[low] ... Model[prd.json] -> MiniMax-M3" and produced nothing
        # four times. Setting the tier without setting the model fixed half the
        # problem: the story could climb, but it still started at the bottom.
        #
        # The reason CPA's estimate cannot be trusted here is the same one
        # recorded for LAD-2: an underspecified story looks CHEAP, and
        # underspecification is exactly what makes novel work expensive.
        # Configured, not constant: the model comes from the project's own
        # high-tier setting.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            local _rmfs_kind _rmfs_high
            _rmfs_kind=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .storyKind // ""' \
                "$prd_target" 2>/dev/null || echo "")
            _rmfs_high="${ESCALATION_MODEL_HIGH:-${EPAM_MODEL:-}}"
            if [ "$_rmfs_kind" = "novel" ] && [ -n "$_rmfs_high" ] && [ "$_rmfs_high" != "$STORY_MODEL" ]; then
                log "  Model[novel-brownfield] -> $_rmfs_high (was $STORY_MODEL; novel code does not start on the cheapest rung)"
                STORY_MODEL="$_rmfs_high"
                # The provider must move with the model. STORY_PROVIDER was
                # resolved from the story's aiProvider, which the coordinator
                # paired with the CHEAP model CPA sized — so swapping in the
                # high-tier model leaves it pointing at the vendor that hosted
                # the model we just discarded. Live AMSD-2041 2026-07-30: all
                # three lanes sent z-ai/glm-5.1 (OpenRouter) to MiniMax and got
                # 400 "unknown model" in under a second, zero tokens, $0, eight
                # times each. Every ladder site already does this; this one did
                # not. Empty means the map has no entry — keep the existing
                # provider, which is resolve_model_provider's documented contract.
                local _rmfs_provider
                _rmfs_provider=$(resolve_model_provider "$_rmfs_high")
                if [ -n "$_rmfs_provider" ] && [ "$_rmfs_provider" != "${STORY_PROVIDER:-}" ]; then
                    log "  Provider[novel-brownfield] -> $_rmfs_provider (was ${STORY_PROVIDER:-unset}; follows the model)"
                    STORY_PROVIDER="$_rmfs_provider"
                fi
            fi
        fi
    else
        # Always log the model that will actually be used, even when it's
        # just the effort-tier default falling through unchanged -- without
        # this, no line ever named the real model for a story with no
        # prd.json override, since resolve_effort_settings() no longer logs
        # it either (see that function's own comment for why).
        log "  Model[effort-default] -> $STORY_MODEL"
        # Same pairing rule as the override above. resolve_effort_settings picks
        # this model from the effort tier BEFORE resolve_provider_settings reads
        # the story's aiProvider, so its choice cannot re-route the provider —
        # anything it set would be clobbered moments later. Here, after both have
        # run, is the first point where the pair can be made consistent. A story
        # whose configured effort model belongs to a different vendor than its
        # aiProvider would otherwise reach the API as the same impossible pairing
        # that killed AMSD-2041 (2026-07-30), just via a different route in.
        local _rmfs_eff_provider
        _rmfs_eff_provider=$(resolve_model_provider "${STORY_MODEL:-}")
        if [ -n "$_rmfs_eff_provider" ] && [ "$_rmfs_eff_provider" != "${STORY_PROVIDER:-}" ]; then
            log "  Provider[effort-default] -> $_rmfs_eff_provider (was ${STORY_PROVIDER:-unset}; follows the model)"
            STORY_PROVIDER="$_rmfs_eff_provider"
        fi
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

resolve_codex_model_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model runtime_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    runtime_model=$(jq -r '.configuration.aiRuntime.defaultModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    STORY_MODEL="${story_model:-${runtime_model:-}}"
    # OPERATOR RULE: only ladder models. The old fallback ended at a hardcoded gpt-5-codex,
    # which is in no ladder and therefore cannot escalate. Refuse rather than substitute.
    if ! assert_ladder_model "${STORY_MODEL:-}" "Model[codex]"; then
        error "  Story ${story_id}: refusing to run on a non-ladder model."
        return 1
    fi
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

    is_truthy "${SKIP_PLAN_THEN_EXECUTE:-}" && return

    local _tier
    _tier=$(classify_ladder_tier "$story_id")
    # Which tiers get an automatic planner is CONFIG. Hardcoding "high" meant adding the
    # highest tier silently removed its planning turn — the strongest chain, planning the least.
    local _auto_ok=0 _pt
    local IFS='|'
    for _pt in ${EPAM_AUTO_PLANNER_TIERS:-high}; do
        [ "$_pt" = "$_tier" ] && _auto_ok=1
    done
    unset IFS
    if [ "$_auto_ok" = "1" ]; then
        local _auto_planner="${EPAM_PLANNER_MODEL_HIGH_TIER:-${EPAM_MODEL:-}}"
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
# Values: opencode | codex | epam | provider aliases (default: whatever the active set can route)
#
# THE ROSTER'S CHOICE IS VALIDATED, NOT JUST DEFAULTED. This is the exact incident
# ladder-providers.js's own comment records: "the prd-model-coordinator writes an aiProvider into
# every story, and until 2026-08-28 its persona named {minimax, openrouter} in prose. On the
# claude stack that is a provider nothing can route." resolve_primary_provider() is what catches
# that — an assigned-but-unroutable value is replaced by one the active set CAN route, announced,
# never silently. An unassigned story used to default to "codex" unconditionally: a vendor no
# provider set can select, and whose binary does not exist on a claude-only machine.
resolve_provider_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PROVIDER=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .aiProvider // empty' \
        "$prd_target" 2>/dev/null | head -1)
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    log "  Provider[$STORY_PROVIDER] -> CLI=$(provider_to_cli "$STORY_PROVIDER")"
}

# classify_failure_class <raw_file> <result_json> <exit_code>
# Layer 1: rule-based triage. Sets COORDINATOR_FAILURE_CLASS and COORDINATOR_ESCALATE.
# resolve_model_override <model> <provider> <settings-file>...
#
# THE FIRST FILE THAT DECLARES THIS MODEL WINS -- per MODEL, not per FILE.
#
# Overrides live in the active stack, and a project may override for its own reasons, so the caller
# passes project first and stack second. The precedence used to be applied to the FILE: if the
# project declared any modelOverrides at all, the stack's were never read. mock3 declares overrides
# for the models of the stack it was written against; run on claude, none matched, and the stack's
# own claude entries were skipped, so the value fell through to defaultAutoCompressAt: 80000 and the
# CLI rejected the argument outright -- twelve attempts, no tokens, a whole writer leg (2026-08-28).
#
# A project's silence about THIS model is not an instruction to ignore the stack's answer for it.
#
# Emits the matching override object as compact JSON, or nothing.
resolve_model_override() {
    local _model="${1:-}" _provider="${2:-}"
    shift 2 || true
    local _f _json
    for _f in "$@"; do
        [ -n "$_f" ] && [ -f "$_f" ] || continue
        # A "$"-prefixed key is a documentation note, not an override. Indexing .value.matchOn on a
        # string aborts the whole query, and a swallowed error reads as "no overrides on this file".
        _json=$(jq -c --arg provider "$_provider" --arg model "$_model" '
            (.modelOverrides // {}) | to_entries
            | map(select(.value | type == "object"))
            | map(select(
                (.value.matchOn == "provider" and .value.matchValue == $provider)
                or (.value.matchOn == "model" and (.value.matchSubstring // null) != null
                    and (.value.matchSubstring as $sub | $model | contains($sub)))
              ))
            | (.[0].value // empty)
        ' "$_f" 2>/dev/null)
        if [ -n "$_json" ] && [ "$_json" != "null" ]; then
            printf '%s' "$_json"
            return 0
        fi
    done
    return 0
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
# effort_rank <low|medium|high> -> 0..2 ; unknown ranks lowest so it can never win a max().
effort_rank() {
    local want="${1:-}" i=0 lvl
    local IFS='|'
    for lvl in ${EPAM_EFFORT_LADDER:-low|medium|high|max}; do
        [ "$lvl" = "$want" ] && { echo "$i"; return; }
        i=$((i+1))
    done
    echo -1
}

# max_effort <a> <b> — the HIGHER of two effort levels.
#
# A model override used to be applied as a final overwrite:
#     [ -n "$_ov_effort" ] && export EPAM_REASONING_EFFORT="$_ov_effort"
# which ran AFTER the rung had set its own value, so every rung's escalation was discarded for
# any model carrying an override — and every model in every live chain carries one. Measured
# 2026-08-10: effort was 'high' on attempt 1 and on attempt 8 alike; the rungs[] escalation
# ladder was dead configuration.
#
# Treating the override as a FLOOR keeps its purpose (a model that needs more effort than the
# rung asks for still gets it) while letting a retry raise effort, which is the operator rule:
# a retry must always escalate effort when the model is not escalating.
max_effort() {
    local a="${1:-}" b="${2:-}" ra rb
    ra=$(effort_rank "$a"); rb=$(effort_rank "$b")
    if [ "$rb" -gt "$ra" ]; then echo "$b"; else echo "$a"; fi
}

# effort_is_higher <candidate> <current> — true when the PROJECT declares candidate above current.
#
# Ranked by effort_rank, which reads the declared effortLadder, so the four hand-written case
# statements this replaces are gone and a project that declares a fourth level gets it honoured
# instead of silently ranked mid.
#
# UNDECLARED NEVER WINS. effort_rank returns -1 for a level the project does not declare, so a
# typo, a renamed level or a stale PRD value cannot raise or lower a story's budget by accident.
# Note -1, not 0: the FIRST declared level ranks 0, and treating 0 as "unknown" would make every
# upgrade off the lowest level impossible.
effort_is_higher() {
    local _new _cur
    _new=$(effort_rank "${1:-}")
    _cur=$(effort_rank "${2:-}")
    [ "$_new" -ge 0 ] 2>/dev/null || return 1
    [ "$_cur" -ge 0 ] 2>/dev/null || return 1
    [ "$_new" -gt "$_cur" ]
}

# next_effort <current> — one notch up, saturating at high.
next_effort() {
    # One notch up the CONFIGURED ladder, saturating at its top. The level names live in
    # config (effortLadder), so a vendor adding a level is a config change, not a code change.
    # Set for the child process invoked below, or read by a script that sources this file.
    # ShellCheck cannot see the consumer, so it reports these unused; removing them takes the value away.
    # shellcheck disable=SC2034
    local cur="${1:-}" prev="" lvl found=0 first=""
    local IFS='|'
    for lvl in ${EPAM_EFFORT_LADDER:-low|medium|high|max}; do
        [ -z "$first" ] && first="$lvl"
        if [ "$found" = 1 ]; then echo "$lvl"; return; fi
        [ "$lvl" = "$cur" ] && found=1
    done
    # at the top, or unrecognised: saturate at the top / start at the second level
    if [ "$found" = 1 ]; then echo "$cur"; else echo "$first"; fi
}

# next_ladder_step <rung> <current_model> <current_effort> <tier>
# -> "<model>|<effort>|<temperature>"
#
# THE LADDER'S DECISION, AS A FUNCTION.
#
# This logic used to live inlined across four `case` arms, tangled with logging, rung snapshots,
# monitor updates and budget checks, reading ~20 variables from the enclosing scope. It could
# only be exercised by reconstructing the whole retry loop — so every ladder defect this week
# (effort de-escalating, rung 1 holding the model fixed, the bump and model not surviving
# re-invocation) was found by paying for a live run instead of by a test.
#
# Pure: no logging, no side effects, no globals beyond the ladder/effort config it reads. Given
# the same inputs it returns the same tuple, which is what makes it assertable.
#
# Invariants it enforces, all of which were violated in production:
#   - EVERY rung steps the model while the chain has a next link (a ladder that does not step
#     is not a ladder)
#   - effort NEVER decreases; a rung's configured effort is a FLOOR, not an assignment
#   - at the top of the chain the model stays put and effort becomes the remaining lever
next_ladder_step() {
    local _rung="${1:-0}" _model="${2:-}" _effort="${3:-}" _tier="${4:-high}"
    local _next_model="$_model" _next_effort="$_effort" _temp

    # Model: step while the configured chain offers a next link.
    local _step
    _step=$(get_model_ladder_step "$_model" "$_tier")
    if [ -n "$_step" ] && [ "$_step" != "$_model" ]; then
        _next_model="$_step"
    fi

    # Effort: the rung's configured level is a floor, never a downgrade.
    local _rung_effort
    case "$_rung" in
        0) _rung_effort="${EPAM_RUNG0_REASONING_EFFORT:-medium}" ;;
        1) _rung_effort="${EPAM_RUNG1_REASONING_EFFORT:-medium}" ;;
        2) _rung_effort="${EPAM_RUNG2_REASONING_EFFORT:-high}" ;;
        *) _rung_effort="${EPAM_RUNG3_REASONING_EFFORT:-high}" ;;
    esac
    # THE RUNG DECIDES. This was max_effort("$_effort", "$_rung_effort") — the rung's level was a
    # FLOOR, so whatever effort arrived could only ever be raised. What arrived was the SEAM's flat
    # declaration, and 33 of 41 seams declare "high", so the ladder's rung-0 "medium" never applied
    # anywhere. The cheap entry rung was never cheap.
    #
    # Measured 2026-09-01 on metrolinx: prompt-builder enters on claude-haiku-4-5 and each call took
    # ~68s to emit ~2000 tokens of what its own registry entry calls "largely RESTATEMENT". Not
    # haiku being slow — haiku reasoning hard, because the seam had overridden the rung. Across 39
    # generated prompts at 2-3 calls each, that is the stage's ~1.5 hours.
    #
    # Operator decision 2026-09-01: a seam is ASSIGNED to a ladder and does not renegotiate what
    # that ladder costs — the rule already settled for iterations, now applied to effort.
    _next_effort="$_rung_effort"

    # When the model cannot move, effort is the only lever left — so it must rise.
    if [ "$_next_model" = "$_model" ] && [ "$_rung" -gt 0 ]; then
        _next_effort=$(max_effort "$_next_effort" "$(next_effort "$_effort")")
    fi

    case "$_rung" in
        0) _temp="${EPAM_RUNG0_TEMPERATURE:-0}" ;;
        1) _temp="${EPAM_RUNG1_TEMPERATURE:-0.2}" ;;
        2) _temp="${EPAM_RUNG2_TEMPERATURE:-0.5}" ;;
        *) _temp="${EPAM_RUNG3_TEMPERATURE:-0.7}" ;;
    esac

    printf '%s|%s|%s' "$_next_model" "$_next_effort" "$_temp"
}

# ladder_models [tier...]
# Every model named anywhere in the configured ladders — the ONLY models permitted to run.
ladder_models() {
    local _t _pair _out="" _var _chain
    # IFS at FUNCTION scope, covering BOTH loops. Set only on the inner loop, the outer one
    # word-split "high|medium|highest" on whitespace — i.e. not at all — producing the single
    # token "high|medium|highest", hence the variable name EPAM_MODEL_LADDER_HIGH|MEDIUM|HIGHEST,
    # hence an empty chain and an empty permitted set. Every pipe-delimited env var in this file
    # needs this at every consumption site; forgetting it does not error, it silently yields one
    # wrong word.
    local IFS='|'
    for _t in ${EPAM_LADDER_TIERS:-high|medium}; do
        _var="EPAM_MODEL_LADDER_$(printf '%s' "$_t" | tr '[:lower:]' '[:upper:]')"
        _chain="${!_var:-}"
        for _pair in $_chain; do
            [ -n "$_pair" ] || continue
            _out="${_out}${_pair%%=*}"$'\n'"${_pair#*=}"$'\n'
        done
    done
    unset IFS
    printf '%s' "$_out" | sed '/^$/d' | sort -u
}

# assert_ladder_model <model> <context>
# OPERATOR RULE: only ladder models are permitted. No exceptions.
#
# The fallback chain used to end at a hardcoded default (gpt-5-codex) that appears in NO ladder,
# so a story whose model failed to resolve ran on a model nobody configured — and the escalation
# chain could not step from it, because it is not a link in any chain. Observed live 2026-08-10:
# "PRD model is 'gpt-5-codex'" while the PRD plainly declared MiniMax-M3. It was masked only
# because the persisted-model resume happened to restore the right one.
#
# Refuses loudly rather than substituting: a silent substitution is how the wrong model ran for
# an entire run without anyone seeing it.
assert_ladder_model() {
    local _model="${1:-}" _ctx="${2:-model resolution}"
    local _permitted; _permitted=$(ladder_models)
    # FAIL CLOSED on a parse failure. "No ladder configured" and "I could not parse the ladder"
    # must never share a branch: the first is a project without a ladder, the second is a bug —
    # and collapsing them turned an IFS slip into blanket permission, with the guard reporting
    # success while enforcing nothing. If tiers ARE configured, an empty permitted set is a bug.
    if [ -z "$_permitted" ]; then
        if [ -n "${EPAM_LADDER_TIERS:-}" ]; then
            error "[$_ctx] ladder tiers are configured (${EPAM_LADDER_TIERS}) but no models could be"
            error "  read from them — the ladder failed to parse. Refusing rather than permitting all."
            return 1
        fi
        return 0                            # genuinely no ladder configured: nothing to enforce
    fi
    if [ -z "$_model" ] || ! printf '%s\n' "$_permitted" | grep -qxF "$_model"; then
        error "[$_ctx] model '${_model:-<empty>}' is not in any configured ladder."
        error "  Permitted: $(printf '%s' "$_permitted" | tr '\n' ' ')"
        error "  Only ladder models are permitted — a model outside the chain cannot escalate,"
        error "  because it is not a link in any chain. Fix the PRD's .model or the ladder config."
        return 1
    fi
    return 0
}

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
    # Accept ANY tier the project configures a ladder for. This was `medium|high`, a hardcoded
    # pair, so `ladderTier: "highest"` in a PRD fell through to the historical classifier and the
    # operator's explicit choice was silently discarded — the story then escalated along a ladder
    # it never asked for. Tier names are config (ladders.*), so adding one is a config change.
    if [ -n "$_prd_tier" ]; then
        local _t
        local IFS='|'
        for _t in ${EPAM_LADDER_TIERS:-medium|high}; do
            if [ "$_t" = "$_prd_tier" ]; then echo "$_prd_tier"; return; fi
        done
        unset IFS
        warning "  [InferenceLadder] PRD tier '$_prd_tier' has no configured ladder (available: ${EPAM_LADDER_TIERS:-medium|high}) — falling back to the historical classifier"
    fi

    # ── Novel brownfield code is always the high ladder ───────────────────────
    # User rule, 2026-07-29. Deterministic, not a judgement: the spec pass
    # already sets storyKind (spec-mode-runner.js:2162).
    #
    # CPA cannot decide this, because an underspecified story looks CHEAP and
    # underspecification is exactly what makes a novel feature expensive. Live
    # AMSD-2041 — an empty ticket, no acceptance criteria — was rated
    # effort:"low", estimatedAiMinutes:5.4214, for a novel capability across
    # three repositories attaching to a hook with 236 callers. Every plan in
    # every lane called it novel; CPA still priced it at five minutes, so it
    # started on the cheapest rung and reached a capable model only by burning
    # two timeouts.
    #
    # A defect is different in kind — the fix site is known and bounded, so
    # medium is reasonable and CPA keeps that call. An explicit ladderTier above
    # still wins: a deliberately pinned tier is not overridden.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _story_kind
        _story_kind=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .storyKind // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ "$_story_kind" = "novel" ]; then
            echo "high"
            return
        fi
    fi

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
            # A tier with no ladder of its own must NOT quietly inherit medium's. Until
            # 2026-08-10 'highest' fell through the catch-all and a story asking for the
            # strongest chain silently escalated along the WEAKEST one — the failure is
            # invisible because a ladder was found and the run looks normal.
            highest) ladder="${EPAM_MODEL_LADDER_HIGHEST:-}"
                     if [ -z "$ladder" ]; then
                         warning "  [InferenceLadder] tier 'highest' has no ladder configured — falling back to high"
                         ladder="${EPAM_MODEL_LADDER_HIGH:-}"
                     fi ;;
            high)    ladder="${EPAM_MODEL_LADDER_HIGH:-}" ;;
            medium)  ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
            *)       warning "  [InferenceLadder] unknown effort tier '$tier' — using medium"
                     ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
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
# "zhipuai/*=openrouter|moonshotai/*=openrouter|z-ai/*=openrouter|glm-*=openrouter|kimi-*=openrouter|deepseek/*=openrouter|MiniMax-*=minimax"
# because this project routes all OpenRouter-hosted vendors through the
# "openrouter" provider umbrella and MiniMax direct-API models through "minimax").
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

# sync_provider_to_model
#
# MODEL AND PROVIDER ARE ONE DECISION. Several escalation arms re-resolve the provider after
# changing the model; the invocation trusted that every arm did. On 2026-08-18 one did not, and
# ten of twelve writer attempts asked the minimax provider for z-ai/glm-5.2:
#
#   minimax + MiniMax-M3    exit=0  413 bytes
#   openrouter    + z-ai/glm-5.2  exit=0  410 bytes
#   minimax + z-ai/glm-5.2  exit=1  0 bytes   "All providers exhausted"
#
# Zero bytes and a non-zero exit read as an environment crash, so the coordinator spent the rest
# of the story diagnosing a healthy binary and a healthy key. Both writer stories were already
# correct on disk when the loop gave up.
#
# Resolving at the point of USE means no arm can forget, including one written later. It never
# guesses: a model the map does not know leaves the provider exactly as it was.
sync_provider_to_model() {
    [ -n "${STORY_MODEL:-}" ] || return 0
    local _p
    _p=$(resolve_model_provider "${STORY_MODEL}")
    [ -n "$_p" ] || return 0
    if [ "$_p" != "${STORY_PROVIDER:-}" ]; then
        log "  Provider[follows-model] -> $_p (was ${STORY_PROVIDER:-unset}; model is ${STORY_MODEL})"
        STORY_PROVIDER="$_p"
    fi
    return 0
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
    local gate_model="${EPAM_MODEL:-}"
    # A capability that silently does not run is indistinguishable from one that ran and found
    # nothing. Say which happened.
    if [ -z "$gate_provider" ]; then
        log "  [ModelEscalation] no gate provider configured — SKIPPING escalation assessment; this run performs none"
        return
    fi

    # Read failure evidence (cap at 3000 chars to stay within gate model budget)
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    local log_tail=""
    [ -f "$log_file" ] && log_tail=$(tail -30 "$log_file" 2>/dev/null || echo "")
    # Include specific test failure output when available (Quality class failures)
    local test_failure_snippet="$VERIFICATION_FAILURE"
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
    # The four evidence blocks, through files: an agent result and a log tail are unbounded and
    # argv is capped at ARG_MAX. Each carries the fallback the prompt used to hold inline.
    local _ilc_result_file _ilc_log_file _ilc_tf_file _ilc_prior_file
    _ilc_result_file=$(mktemp "${TMPDIR:-/tmp}/ilc-result-XXXXXX.txt")
    _ilc_log_file=$(mktemp "${TMPDIR:-/tmp}/ilc-log-XXXXXX.txt")
    _ilc_tf_file=$(mktemp "${TMPDIR:-/tmp}/ilc-tf-XXXXXX.txt")
    _ilc_prior_file=$(mktemp "${TMPDIR:-/tmp}/ilc-prior-XXXXXX.txt")
    printf '%s' "${result_text:-"(empty — agent produced no result)"}" > "$_ilc_result_file"
    printf '%s' "${log_tail:-"(no log available)"}" > "$_ilc_log_file"
    printf '%s' "${test_failure_snippet:-"(no test failure output)"}" > "$_ilc_tf_file"
    printf '%s' "${prior_failure_summary:-"(no prior failures recorded for this story)"}" > "$_ilc_prior_file"
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/inference-ladder-coordinator-vals-XXXXXX.json")
    jq_vals \
          --rawfile result_text "$_ilc_result_file" \
          --rawfile log_tail "$_ilc_log_file" \
          --rawfile test_failure_snippet "$_ilc_tf_file" \
          --rawfile prior_failure_summary "$_ilc_prior_file" \
      --arg story_id "$story_id" \
      --arg story_title "$story_title" \
      --arg current_model "$current_model" \
      --arg target_model "$target_model" \
      --arg coordinator_failure_class "$COORDINATOR_FAILURE_CLASS" \
          '{"__RESULT_TEXT__":$result_text,"__LOG_TAIL__":$log_tail,"__TEST_FAILURE_SNIPPET__":$test_failure_snippet,"__PRIOR_FAILURE_SUMMARY__":$prior_failure_summary,"__STORY_ID__":$story_id,"__STORY_TITLE__":$story_title,"__CURRENT_MODEL__":$current_model,"__TARGET_MODEL__":$target_model,"__COORDINATOR_FAILURE_CLASS__":$coordinator_failure_class}' > "$_cp_vals"
    coordinator_prompt="$(render_engine_prompt inference-ladder-coordinator "$_cp_vals")"
    rm -f "$_cp_vals"
    rm -f "$_ilc_result_file" "$_ilc_log_file" "$_ilc_tf_file" "$_ilc_prior_file"

    local coord_result_file
    coord_result_file=$(mktemp /tmp/coord-${story_id}-XXXXXX.json)

    local coord_raw=""
    if coord_raw=$(echo "$coordinator_prompt" | \
            EPAM_AGENT_NAME="inference-ladder-coordinator" EPAM_STORY_ID="${story_id}" \
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
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
    jq_vals \
          --arg escalating_story_id "${escalating_story_id}" \
          --arg required_fix "${required_fix}" \
          --arg target_file "${target_file}" \
          --arg diagnosis "${diagnosis}" \
          '{"__ESCALATING_STORY_ID__":$escalating_story_id,"__REQUIRED_FIX__":$required_fix,"__TARGET_FILE__":$target_file,"__DIAGNOSIS__":$diagnosis}' > "$_cp_vals"
    _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" sibling_escalation)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
    rm -f "$_cp_vals"
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
