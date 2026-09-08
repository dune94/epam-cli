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
    # CACHE TOKENS ARE PART OF THE BILL, AND THE ONLY EXPLANATION FOR IT. This writer captured
    # input/output only, so a heavily cached call — every real call in this pipeline reads 30k-200k
    # from cache — recorded as though it paid full price, and the largest record of a live run
    # ($6.76, 81k in) showed cacheRead 0 and could not be explained. lib/cost-emitter.js has always
    # captured them; two writers with two shapes is how the same call reads differently depending
    # on which one logged it.
    local cread cwrite
    cread=$(jq -r  '.usage.cache_read_input_tokens     // .usage.cacheReadInputTokens     // 0' "$reply" 2>/dev/null || echo 0)
    cwrite=$(jq -r '.usage.cache_creation_input_tokens // .usage.cacheCreationInputTokens // 0' "$reply" 2>/dev/null || echo 0)

    local cost_file="${PHASE_COST_FILE:-${LOG_DIR:-.}/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"
    local phase_id="${CURRENT_PHASE:-${PHASE:-unknown}}"
    local ended; ended=$(date -Iseconds)

    # agent_name IS WRITTEN TOO, not instead of agent_type. Every per-agent cost view reads
    # agent_name, so records from this writer were anonymous to all of them: in a live run 62% of
    # the spend — including its single largest call — could not be attributed to any seam.
    # agent_type stays, because existing consumers (sync-monitor-stories.sh) already read it.
    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg pid "$phase_id" --arg sid "$story" --arg at "$agent" --arg rm "$model" \
            --arg sa "$started" --arg ea "$ended" \
            --argjson cu "${cost:-0}" --argjson ti "${tin:-0}" \
            --argjson to "${tout:-0}" --argjson tt "${turns:-0}" \
            --argjson cr "${cread:-0}" --argjson cw "${cwrite:-0}" \
            '{phase_id:$pid, story_id:$sid, agent_type:$at, agent_name:$at, resolvedModel:$rm,
              started_at:$sa, ended_at:$ea, task_cost_usd:$cu,
              task_tokens_in:$ti, task_tokens_out:$to, task_turns:$tt,
              cache_read_tokens:$cr, cache_create_tokens:$cw,
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
    # THE CONTENT, NOT JUST THE COST. This payload carried agent, model, tokens and cost and no
    # content at all, so every seam recorded through the SHELL exported as
    # {"text": "", "toolCalls": []} — the writer, the failure analyst, repro-test-writer,
    # team-lead-review and all seven qa-gate sentinels: fourteen unreplayable seams against
    # seventeen rich ones, measured on the Sept-05 cassettes and again on 2026-09-07.
    #
    # Both files are already in hand: $reply IS $ORCH_JSON_RESULT, and llm-handler.sh exports
    # EPAM_TRACE_PROMPT_FILE for the prompt it just sent. lib/langfuse-emit.js extracts the text
    # and the tool calls through the same functions the JS path uses, so the two cannot drift.
    # An empty promptFile records no input, exactly as today — never an error.
    if [ -f "$_COST_RECORD_DIR/langfuse-emit.js" ] && { [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; }; then
        jq -cn \
            --arg agent "$agent" --arg storyId "$story" --arg phase "$phase_id" \
            --arg model "$model" --arg startedAt "$started" --arg endedAt "$ended" \
            --arg rung "${EPAM_LADDER_RUNG:-}" \
            --arg resultFile "$reply" --arg promptFile "${EPAM_TRACE_PROMPT_FILE:-}" \
            --argjson costUsd "${cost:-0}" --argjson tokensIn "${tin:-0}" \
            --argjson tokensOut "${tout:-0}" --argjson turns "${turns:-0}" \
            '{agent:$agent, storyId:$storyId, phase:$phase, model:$model, rung:$rung,
              startedAt:$startedAt, endedAt:$endedAt, costUsd:$costUsd,
              tokensIn:$tokensIn, tokensOut:$tokensOut, turns:$turns,
              resultFile:$resultFile, promptFile:$promptFile}' \
          | "${NODE_BIN:-node}" "$_COST_RECORD_DIR/langfuse-emit.js" >/dev/null 2>&1 &
    fi
}
