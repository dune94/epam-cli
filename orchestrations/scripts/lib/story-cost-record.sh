#!/usr/bin/env bash
# story-cost-record.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (3 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

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
    python3 "$SCRIPT_DIR/lib/handlers/token-cost.py" "$pricing_file" "$model" "$tin" "$tout"
}

# Append a cost/time record to phase-cost.jsonl
# Called after each story completes (success or failure) for phase-aware
# tracking, AND after every individual retry attempt (status="attempt",
# attempt_num set) so real per-attempt token/cost usage is never invisible —
# see the call site right after the provider-invocation case block above.
# result_is_from_this_attempt <json_result_file> <started_at>
#
# WHOSE RESULT IS THIS? append_cost_record reads usage out of $json_result_file, and an attempt
# that fails before writing one leaves the PREVIOUS attempt's file in place. The ledger then
# records those numbers again for a call that never happened.
#
# Live 2026-08-18, MOCK3-1: attempts 3-12 asked a provider for a model it does not serve, came
# back in about a second with nothing, and each recorded in=15812 out=1860 cost=$0.007 — attempt
# 2's numbers, ten more times, on the measurement the story budget guard sums to enforce a limit.
#
# The attempt's start time is already a parameter. A result file older than the attempt did not
# come from it. Absent file, absent path or absent start time all answer "not mine" rather than
# guessing — an over-report here is invented spend, and an under-report is merely a gap.
result_is_from_this_attempt() {
    local _f="${1:-}" _started="${2:-}"
    [ -n "$_f" ] && [ -f "$_f" ] || return 1
    [ -n "$_started" ] || return 1
    local _fm _sm
    _fm=$(stat -c %Y "$_f" 2>/dev/null) || return 1
    _sm=$(date -d "$_started" +%s 2>/dev/null) || return 1
    [ -n "$_fm" ] && [ -n "$_sm" ] || return 1
    [ "$_fm" -ge "$_sm" ]
}

append_cost_record() {
    local story_id=$1 status=$2 started_at=$3 ended_at=$4 output_file=$5 json_result_file=${6:-} attempt_num=${7:-}
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"

    # Read story metadata from prd.json
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // "unknown"' "$prd_target")
    local agent_id
    agent_id=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target")
    local forecast_hours
    forecast_hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target")
    local forecast_cost
    forecast_cost=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedCost // 0' "$prd_target" 2>/dev/null || echo 0)
    local story_effort
    story_effort=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .effort // "medium"' "$prd_target")
    local story_type
    story_type=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .storyType // "implementation"' "$prd_target")
    # A result file that predates this attempt belongs to the previous one; reading it would
    # bill this attempt for a call it never made. See result_is_from_this_attempt.
    if [ -n "$json_result_file" ] && ! result_is_from_this_attempt "$json_result_file" "$started_at"; then
        log "  Cost[$story_id] no result from this attempt — recording zero usage rather than repeating the previous attempt's"
        json_result_file=""
    fi
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
    local start_epoch
    start_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo 0)
    local end_epoch
    end_epoch=$(date -d "$ended_at" +%s 2>/dev/null || echo 0)
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
        local cache_create
        cache_create=$(jq -r '.usage.cache_creation_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        local cache_read
        cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_in=$(( ${tokens_in:-0} + ${cache_create:-0} + ${cache_read:-0} ))
        # epam's own providers are OpenAI-shaped: prompt_tokens ALREADY INCLUDES the cached
        # portion, so this one is recorded and never added — adding it would double-count every
        # cached token into both the spend record and the budget guard that reads it. Emitted
        # under a distinct key for exactly that reason (see buildRunResultJson in run.ts).
        # Measured 2026-08-10: MiniMax-M3 serves 99.2% of an identical prefix from cache, so
        # this is the difference between a real utilisation number and a permanent zero.
        local cached_subset
        cached_subset=$(jq -r '.usage.cached_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        if [ "${cached_subset:-0}" -gt 0 ]; then
            cache_read="$cached_subset"
        fi
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
            --arg rid "${ORCH_RUN_ID:-}" \
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
            '{run_id:$rid, phase_id:$pid, phase_name:$pn, story_id:$sid, story_title:$st,
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
    #
    # CACHED TOKENS ARE SHOWN BECAUSE THE COST FIGURE CANNOT SEE THEM.
    #
    # src/billing/pricing.ts charges every input token at inputPerMillion; ModelPricing has only
    # inputPerMillion and outputPerMillion, so there is nowhere to express a cache-read rate for
    # any model. Measured 2026-08-10: an attempt reporting in=7,502,302 cost=$2.2861 reconciles
    # EXACTLY to 7,502,302 x $0.30/M + 29,508 x $1.20/M — full rate on 96.2%-cached traffic.
    # The real bill is lower by whatever the vendor discounts cache reads, which is not yet
    # verified against MiniMax billing and is deliberately NOT guessed at here.
    #
    # Until the rate is known and wired, the honest thing is to show the utilisation next to the
    # figure it is missing from, so nobody optimises against a number that is blind to the single
    # largest efficiency win in the pipeline. A percentage is not a price and is not presented as
    # one; the cost stays flagged by costIsEstimate in the ledger.
    local _cache_pct="n/a"
    if [ "${tokens_in:-0}" -gt 0 ]; then
        _cache_pct="$(awk -v c="${cache_read:-0}" -v t="${tokens_in:-0}" 'BEGIN{printf "%.1f", (100*c)/t}')%"
    fi
    log "  Cost[$story_id] model=${resolved_model:-unknown} in=${tokens_in} (cached ${cache_read:-0} = ${_cache_pct}) out=${tokens_out} cost=\$${cost_usd}[full-rate est] elapsed=${elapsed_minutes}min status=${status}"

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
