#!/usr/bin/env bash
# THE ONE PLACE A SEAM IS INVOKED — AND NOW SOMEWHERE A TEST CAN REACH IT.
#
# Every one of the 40 declared seams enters the model through run_orch_prompt. It lived inside
# run-agent-orchestration.sh: 11,213 lines with 2,625 top-level statements and no main(), so
# sourcing that file to reach this function RAN THE WHOLE PIPELINE. No test could call it, and
# that is the reason 33 of 40 seams had no integration coverage — not difficulty writing the
# tests, but that the seam was unreachable from a test process.
#
# Every defect worth catching in this pipeline has been at a join: a gate resolving to no seam, a
# shell notice printed onto a captured stdout and eating an agent's reply, a prompt that never
# reached the trace. Unit tests were green through all of them.
#
# The function is moved VERBATIM. It expects its caller to have defined:
#
#   log, error, warning        — the orchestrator's logging helpers
#   resolve_prompt_provider    — still defined in run-agent-orchestration.sh
#
# and it sources lib/seam-ladder.sh itself, because the ladder is what decides the model.

_ORCH_PROMPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seam-ladder.sh
[ -f "$_ORCH_PROMPT_LIB_DIR/seam-ladder.sh" ] && . "$_ORCH_PROMPT_LIB_DIR/seam-ladder.sh"

run_orch_prompt() {
    # Bound the LOOP, not only the clock. Without this a gate agent — especially
    # one with tools, as the phase assessment has — can explore indefinitely and is
    # only stopped by its timeout. Live 2026-07-25 that produced a ZERO-BYTE log
    # killed at 120s, then again at 300s after the timeout was raised: a stall, not
    # slowness, and raising the clock merely spent longer failing.
    #
    # An iteration cap fails fast and deterministically. Generous by default so QA
    # gates that legitimately read source files are not strangled; override per
    # site where a gate genuinely needs more.
    local EPAM_MAX_ITERATIONS="${ORCH_GATE_MAX_ITERATIONS:-25}"
    export EPAM_MAX_ITERATIONS
    local prompt_text="$1"
    local agent_type="${2:-pipeline}"
    local story_id="${3:-pipeline}"
    local provider_hint
    provider_hint="$(resolve_prompt_provider)"
    # ORCH_GATE_PROVIDER overrides the story-agent provider for coordinator/gate calls.
    # Set to "openai" to use GPT-4o as coordinator while qwen handles story agents.
    local gate_provider="${ORCH_GATE_PROVIDER:-$provider_hint}"

    if [ ! -x "$AI_RUNNER_CMD" ]; then
        error "ai runner not executable: $AI_RUNNER_CMD"
        return 1
    fi

    # THE SEAM DECIDES, IF THE REGISTRY KNOWS THIS AGENT.
    #
    # Two invocation paths ran side by side and the registry governed only one of them: the
    # spec pass resolved a seam and climbed a ladder, while everything invoked here took a
    # single fixed gate model. So the six QA sentinels declared 'ladder: top' and never used
    # it — the registry was describing a pipeline the runtime did not run, and the ladder
    # tests all passed because they check the DECLARATION is coherent, never that anything
    # reads it.
    #
    # seam_ladder_export is the shell counterpart of seam-invocation.js and reads the SAME
    # registry, so a seam means the same thing whichever language invokes it. An agent the
    # registry does not know is left exactly as it was: this widens what the registry governs,
    # it does not force every caller through it.
    local _seam_err; _seam_err=$(mktemp "${TMPDIR:-/tmp}/seam-err-XXXXXX")
    # NOT SILENCED. This was `2>/dev/null || true`, and what it swallowed was resolveSeam's own
    # error — the registry refusing to guess. skills_audit, tools_audit, story_recovery and
    # lint-fixer all threw it, and all four ran with no ladder, no reasoning effort and no tool
    # grant while every log line looked normal. Three of them hold Bash and WriteFile.
    #
    # It stays non-fatal: a seam is configuration, and refusing to run a gate because the registry
    # is incomplete would take down more than it protects. But it says the agent's name, once, so
    # the next unregistered caller is visible instead of merely unconfigured.
    if ! seam_ladder_export "$agent_type" 2>"$_seam_err"; then
        warning "run_orch_prompt: no seam configured for '$agent_type' — running with no ladder, effort or tool grant from the registry"
        [ -s "$_seam_err" ] && sed 's/^/  [seam] /' "$_seam_err" >&2
    fi
    rm -f "$_seam_err"
    # THE LADDER IS THE ONLY SOURCE. seam_ladder_export just set EPAM_MODEL from this agent's
    # ladder position. What stood here was `${EPAM_MODEL:-${ORCH_GATE_MODEL:-<a vendor model>}}` —
    # a run-wide pin that silently outranked the seam, behind a literal that always answered. So
    # an agent declared at the base of the ladder ran on whatever the run had pinned, and the
    # ladder never had to work: two of its three positions resolved no model for months and
    # nothing noticed, because the literal covered it.
    #
    # No substitution. An unresolvable model is a configuration fault in the registry or in the
    # project's llm-settings.json, and running the wrong model is worse than not running.
    #
    # ONE EXCEPTION, AND IT IS STILL THE LADDER: a caller retrying this agent sets
    # ORCH_AGENT_MODEL_CLIMB to the next rung of THIS agent's own chain (seam_next_model). That is
    # not a second source — it is the same ladder, one step along. It is read after the seam
    # resolves, because seam_ladder_export overwrites EPAM_MODEL and would clobber it.
    local gate_model
    if [ -n "${ORCH_AGENT_MODEL_CLIMB:-}" ]; then
        gate_model="$ORCH_AGENT_MODEL_CLIMB"
    elif ! gate_model=$(seam_model_or_fail "$agent_type"); then
        error "run_orch_prompt: refusing to invoke '${agent_type}' with no model resolved from the ladder"
        return 1
    fi
    local model_args=(--model "$gate_model")

    local started_at
    started_at=$(date -Iseconds)
    local json_result_file
    json_result_file=$(mktemp /tmp/orch-prompt-XXXXXX.json)

    # Run with JSON output so we can capture cost/token data.
    # Hard timeout guards against API hangs that block indefinitely (observed
    # live: spec-validator stalled 55 min with zero output on two consecutive
    # runs). EPAM_GATE_TIMEOUT_SECS defaults to 600 (10 min) — enough for any
    # real gate response; exit 124 from timeout is treated as a failure.
    local _gate_timeout="${EPAM_GATE_TIMEOUT_SECS:-600}"
    local _rc=0
    echo "$prompt_text" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        CLAUDE_CMD="$CLAUDE_CMD" \
        EPAM_CLI="${EPAM_CLI:-epam}" \
        ORCH_JSON_RESULT="$json_result_file" \
        timeout "${_gate_timeout}" \
        "$AI_RUNNER_CMD" --provider "$gate_provider" "${model_args[@]}" || _rc=$?
    if [ "$_rc" -eq 124 ]; then
        warning "run_orch_prompt: gate agent timed out after ${_gate_timeout}s (${agent_type}/${story_id}) — treating as failure"
    fi

    # Extract cost/token data and emit pipeline cost record
    if [ -f "$json_result_file" ] && [ -s "$json_result_file" ]; then
        local cost tokens_in tokens_out turns
        cost=$(jq -r '.cost_usd // .total_cost_usd // 0'                    "$json_result_file" 2>/dev/null || echo "0")
        tokens_in=$(jq -r '.usage.inputTokens // .usage.input_tokens // 0'  "$json_result_file" 2>/dev/null || echo "0")
        tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo "0")
        turns=$(jq -r '.iterations // .num_turns // 1'                       "$json_result_file" 2>/dev/null || echo "1")
        # Compute cost from pricing table if provider returned 0
        if [ "${cost:-0}" = "0" ] && { [ "${tokens_in:-0}" -gt 0 ] || [ "${tokens_out:-0}" -gt 0 ]; }; then
            local _pricing_file="$SCRIPT_DIR/model-pricing.json"
            if [ -f "$_pricing_file" ]; then
                cost=$(python3 "$SCRIPT_DIR/lib/handlers/model-call-cost.py" "$_pricing_file" "${gate_model:-}" "${tokens_in:-0}" "${tokens_out:-0}"
2>/dev/null || echo "0")
            fi
        fi
        append_pipeline_cost_record \
            "$agent_type" "$story_id" "$gate_model" "$started_at" \
            "${cost:-0}" "${tokens_in:-0}" "${tokens_out:-0}" "${turns:-1}"
        # Emit cost_snapshot so agent-activity dashboard shows tokens + cost per gate call
        local _phase_id
        _phase_id=$(jq -r '.phase // empty' "${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}" 2>/dev/null || true)
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg agent "$agent_type" \
            --arg story "${story_id:-}" \
            --arg phase "${_phase_id:-}" \
            --arg model "$gate_model" \
            --arg provider "$gate_provider" \
            --argjson cost "${cost:-0}" \
            --argjson tin "${tokens_in:-0}" \
            --argjson tout "${tokens_out:-0}" \
            --argjson turns "${turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))) ,
              timestamp: $ts,
              agent: $agent,
              story_id: (if $story == "" then null else $story end),
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: $model,
              provider: $provider,
              detail: {
                costUsd: $cost,
                tokensIn: $tin,
                tokensOut: $tout,
                turns: $turns,
                source: "run_orch_prompt"
              }
            }' >> "${ACTIVITY_FILE:-$SCRIPT_DIR/../logs/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$json_result_file"
    fi

    return $_rc
}
