#!/usr/bin/env bash
# cost-record.sh — WHAT A CALL COST, RECORDED WHERE EVERY CALL PASSES.
#
# Claude Code returns total_cost_usd, usage.input_tokens/output_tokens and num_turns in its JSON
# reply, and the handler already captures that JSON to $ORCH_JSON_RESULT. Exactly one seam —
# team-lead-review — ever parsed it into a ledger record. The other 39 produced the numbers and
# nothing read them.
#
# That is why a 34-minute paid run on 2026-08-26 logged ZERO entries and the spend for that
# incident still cannot be stated. Recording per seam is 40 places to forget; the handler is one.
#
# A MISSING COST IS NOT A ZERO COST. An unreadable or cost-free reply records NOTHING, because a
# zero in the ledger says "this call was free" — and a run full of those looks cheaper than it
# was, which is the failure this exists to prevent.

# record_call_cost <reply-json-file> <agent> <story-id> <model> <started-at>
_COST_RECORD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

record_call_cost() {
    local reply="${1:-}" agent="${2:-pipeline}" story="${3:-pipeline}" model="${4:-}" started="${5:-}"
    [ -n "$reply" ] && [ -f "$reply" ] && [ -s "$reply" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local cost tin tout turns
    # Vendors spell these differently; accept the spellings actually seen rather than one.
    cost=$(jq -r  '.total_cost_usd // .cost_usd // empty'                  "$reply" 2>/dev/null || true)
    [ -n "$cost" ] || return 0                      # no cost stated: record nothing, never a zero

    tin=$(jq -r   '.usage.input_tokens  // .usage.inputTokens  // 0'       "$reply" 2>/dev/null || echo 0)
    tout=$(jq -r  '.usage.output_tokens // .usage.outputTokens // 0'       "$reply" 2>/dev/null || echo 0)
    turns=$(jq -r '.num_turns // .turns // .iterations // 0'               "$reply" 2>/dev/null || echo 0)

    local cost_file="${PHASE_COST_FILE:-${LOG_DIR:-.}/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"
    local phase_id="${CURRENT_PHASE:-${PHASE:-unknown}}"
    local ended; ended=$(date -Iseconds)

    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg pid "$phase_id" --arg sid "$story" --arg at "$agent" --arg rm "$model" \
            --arg sa "$started" --arg ea "$ended" \
            --argjson cu "${cost:-0}" --argjson ti "${tin:-0}" \
            --argjson to "${tout:-0}" --argjson tt "${turns:-0}" \
            '{phase_id:$pid, story_id:$sid, agent_type:$at, resolvedModel:$rm,
              started_at:$sa, ended_at:$ea, task_cost_usd:$cu,
              task_tokens_in:$ti, task_tokens_out:$to, task_turns:$tt,
              status:"completed", invokeMode:"cli"}' >> "$cost_file"
    ) 200>"$lock_file"

    # THE SAME CALL, TRACED. This is the hub's cost edge — the path every vendor BINARY takes —
    # and wiring only the JS edge would have left most of a run untraced while the ledger looked
    # complete. The emitter is shared with lib/cost-emitter.js (one implementation, two edges) and
    # names no vendor.
    #
    # Backgrounded and silenced: observability must never add latency to, or fail, the call it
    # observes. lib/langfuse-emit.js already returns quietly when Langfuse is absent, so a project
    # without it behaves exactly as before.
    if [ -f "$_COST_RECORD_DIR/langfuse-emit.js" ] && { [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; }; then
        jq -cn \
            --arg agent "$agent" --arg storyId "$story" --arg phase "$phase_id" \
            --arg model "$model" --arg startedAt "$started" --arg endedAt "$ended" \
            --arg rung "${EPAM_LADDER_RUNG:-}" \
            --argjson costUsd "${cost:-0}" --argjson tokensIn "${tin:-0}" \
            --argjson tokensOut "${tout:-0}" --argjson turns "${turns:-0}" \
            '{agent:$agent, storyId:$storyId, phase:$phase, model:$model, rung:$rung,
              startedAt:$startedAt, endedAt:$endedAt, costUsd:$costUsd,
              tokensIn:$tokensIn, tokensOut:$tokensOut, turns:$turns}' \
          | "${NODE_BIN:-node}" "$_COST_RECORD_DIR/langfuse-emit.js" >/dev/null 2>&1 &
    fi
}
