#!/usr/bin/env bash
# retry-extension.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (3 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# compute_retry_extension_evidence <story_id>
# Deterministic (no LLM cost) evidence gathering for the retry-extension
# coordinator, computed purely from two JSONL logs that already exist:
#   healing-events.jsonl              (run_healing_recorder, self-heal events
#                                       + the HEALING_BROKEN sentinel record)
#   failure-diagnosis-groundedness.jsonl (run_diagnosis_groundedness_check)
# Prints a single JSON object to stdout:
#   {"total_heal_events":N,"distinct_diagnoses":N (distinct ROOT CAUSES),"healing_broken_ever":bool,
#    "avg_groundedness":N,"groundedness_sample_count":N,
#    "repeated_root_causes":[{retry,diagnosis,count}] (each HEALING_BROKEN),"last_diagnoses":[{retry,target,diagnosis}] (last 5)}
compute_retry_extension_evidence() {
    local story_id="$1"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    local grounded_log="${LOG_DIR}/failure-diagnosis-groundedness.jsonl"

    local total_heal_events=0 distinct_diagnoses=0 healing_broken_ever="false" repeated_root_causes='[]' last_diagnoses='[]'
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
        # DISTINCT ROOT CAUSES, by the same definition the healing check repeats on (lib/handlers/healing-root-causes.py).
        # Counting exact strings made three wordings of one bug "3 distinct" while HEALING_BROKEN called it a repeat.
        distinct_diagnoses=$(python3 "$SCRIPT_DIR/lib/handlers/healing-root-causes.py" distinct "$heal_log" "$story_id" 2>/dev/null || echo 0)
        if jq -e --arg s "$story_id" 'select(.story_id == $s and .event == "HEALING_BROKEN")' "$heal_log" >/dev/null 2>&1; then
            healing_broken_ever="true"
        fi
        repeated_root_causes=$(jq -c --arg s "$story_id" 'select(.story_id == $s and .event == "HEALING_BROKEN") | {retry, diagnosis: (.repeated_diagnosis // .diagnosis), count}' "$heal_log" 2>/dev/null | jq -sc '.' 2>/dev/null || echo '[]')
        last_diagnoses=$(jq -r --arg s "$story_id" 'select(.story_id == $s and .event != "HEALING_BROKEN") | {retry, target, diagnosis}' "$heal_log" 2>/dev/null | jq -sc '.[-5:]' 2>/dev/null || echo '[]')
    fi

    local avg_groundedness=0 groundedness_sample_count=0
    if [ -f "$grounded_log" ]; then
        groundedness_sample_count=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false)' "$grounded_log" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
        if [ "${groundedness_sample_count:-0}" -gt 0 ] 2>/dev/null; then
            avg_groundedness=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false) | .score' "$grounded_log" 2>/dev/null | \
                python3 "$SCRIPT_DIR/lib/handlers/compute-retry-extension-evidence.py" 2>/dev/null || echo 0)
        fi
    fi

    jq -nc --argjson total "${total_heal_events:-0}" --argjson distinct "${distinct_diagnoses:-0}" \
        --argjson broken "$healing_broken_ever" --argjson avg "${avg_groundedness:-0}" \
        --argjson samples "${groundedness_sample_count:-0}" \
        --argjson repeated "${repeated_root_causes:-[]}" --argjson last "${last_diagnoses:-[]}" \
        '{total_heal_events:$total, distinct_diagnoses:$distinct, healing_broken_ever:$broken, avg_groundedness:$avg, groundedness_sample_count:$samples, repeated_root_causes:$repeated, last_diagnoses:$last}'
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

# _retry_extension_record <story_id> <evidence_json|null> <decidedBy> <extend> <granted> <reason>
# EVERY OUTCOME IS RECORDED, not only the agent's. The pre-gate declines and the disabled/no-provider paths wrote
# nothing, so AMSD-2974's ledger was empty although the coordinator ran four times. decidedBy says who decided:
# agent | agent-unavailable | prompt-unrendered | no-gate-provider | unreadable-evidence | disabled.
# A RUN LEDGER, WITH THE RUN'S OTHER LEDGERS. This defaulted to OUTPUT_DIR — the codeline on greenfield — and
# "REGI-005b: story complete" committed retry-extension-decisions.jsonl into the client repository (2026-09-20).
# LOG_DIR, cleared by the run's reset like the rest.
_retry_extension_record() {
    local story_id="$1" evidence="${2:-null}" decided_by="$3" extend="$4" granted="${5:-0}" reason="${6:-}"
    echo "$evidence" | jq empty >/dev/null 2>&1 || evidence="null"
    case "$granted" in ''|*[!0-9]*) granted=0 ;; esac
    mkdir -p "${LOG_DIR}" 2>/dev/null
    jq -nc --arg story "$story_id" --argjson evidence "$evidence" --arg by "$decided_by" --arg extend "$extend" \
        --argjson granted "$granted" --arg reason "$reason" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, decidedBy: $by, evidence: $evidence, extend: ($extend == "true"), extraRetriesGranted: $granted, reason: $reason, timestamp: $ts}' \
        >> "${LOG_DIR}/retry-extension-decisions.jsonl" 2>/dev/null || true
}

# run_retry_extension_coordinator <story_id>
# Dynamic self-heal augmentation (2026-07-12, user request): a story that
# exhausted MAX_RETRIES with genuine, converging progress (each failure a
# DIFFERENT diagnosed bug, not a repeat) shouldn't necessarily be abandoned
# at a fixed, one-size-fits-all ceiling. This is a bounded, evidence-gated
# extension of that ceiling. The evidence is computed deterministically (compute_retry_extension_evidence) and the
# coordinator agent judges it — including the repeats (HEALING_BROKEN, repeated root causes), which until 2026-10-08
# were a deterministic veto that meant no agent was ever asked. The caller still enforces the role's hard cap
# (resolve_role_retry_extension_max).
#
# Prints the number of EXTRA retries granted (0 if not extending) to stdout.
# Fails closed (prints 0) on any error, disabled state, or malformed gate
# response -- this must never be able to grant an extension it can't justify
# with real evidence.
run_retry_extension_coordinator() {
    local story_id="$1"
    if [ "${EPAM_RETRY_EXTENSION_ENABLED:-0}" != "1" ]; then
        _retry_extension_record "$story_id" "null" "disabled" "false" 0 "EPAM_RETRY_EXTENSION_ENABLED is not 1"
        echo 0
        return 0
    fi

    local evidence
    evidence=$(compute_retry_extension_evidence "$story_id")
    if [ -z "$evidence" ] || ! echo "$evidence" | jq empty 2>/dev/null; then
        # UNREADABLE EVIDENCE IS NOT "NO EXTENSION WARRANTED". Both answer 0, and the caller
        # cannot tell them apart — the same defect fixed two branches below, where a missing
        # provider also returned a believable 0. Say which happened; the value is unchanged so
        # no run behaves differently, but a 0 that nobody decided is now visible.
        log "  [RetryExtension] retry-extension evidence for ${story_id} is missing or not valid JSON — returning 0 because it could not be READ, not because none was warranted"
        _retry_extension_record "$story_id" "null" "unreadable-evidence" "false" 0 "evidence missing or not valid JSON"
        echo 0
        return 0
    fi

    # NO DETERMINISTIC VETO. A HEALING_BROKEN sentinel or a repeated root cause used to decline here without asking —
    # every real decision on record (AMSD-2974, 4 of 4) was this rule, and no extension was ever granted by an agent.
    # The repeats are EVIDENCE (repeated_root_causes, last_diagnoses): the coordinator judges them. Operator, 2026-10-08.

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${EPAM_MODEL:-}"
    if [ -z "$gate_provider" ]; then
        # 0 is a plausible answer — "no extension is warranted" — and was returned without any
        # coordination happening. Same shape as the fabricated "pass" above: a value nobody
        # decided, arriving where a decision is expected.
        log "  [RetryExtension] no gate provider configured — SKIPPING coordination; returning 0 because none was DECIDED, not because none was warranted"
        _retry_extension_record "$story_id" "$evidence" "no-gate-provider" "false" 0 "no gate provider configured"
        echo 0
        return 0
    fi

    local profiles_file
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    local coordinator_profile=""
    if [ -f "$profiles_file" ]; then
        coordinator_profile=$(require_profile "retry-extension-coordinator" "$profiles_file" || true)
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local ac_count
    ac_count=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | ((.acceptanceCriteria // []) | length)' "$prd_target" 2>/dev/null || echo 0)

    local coord_prompt
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-extension-coordinator-vals-XXXXXX.json")
    jq_vals \
          --arg retry_count "${retry_count:-unknown}" \
          --arg max_retries "${MAX_RETRIES:-unknown}" \
          --arg coordinator_profile "${coordinator_profile}" \
          --arg story_id "${story_id}" \
          --arg ac_count "${ac_count}" \
          --arg evidence "${evidence}" \
          '{"__RETRY_COUNT__":$retry_count,"__MAX_RETRIES__":$max_retries,"__COORDINATOR_PROFILE__":$coordinator_profile,"__STORY_ID__":$story_id,"__AC_COUNT__":$ac_count,"__EVIDENCE__":$evidence}' > "$_cp_vals"
    if ! coord_prompt="$(render_engine_prompt retry-extension-coordinator "$_cp_vals")" || [ -z "$coord_prompt" ]; then
        # An unrendered prompt was sent anyway: the agent was asked about an empty page and its answer was acted on.
        rm -f "$_cp_vals"
        log "  [RetryExtension] $story_id: the coordinator's prompt did not render — NOT asking the agent; returning 0 because none was DECIDED" >&2
        _retry_extension_record "$story_id" "$evidence" "prompt-unrendered" "false" 0 "the coordinator's prompt did not render"
        echo 0
        return 0
    fi
    rm -f "$_cp_vals"

    # THE CALL'S ERRORS ARE KEPT. They went to /dev/null, so the four regintel calls that answered "coordinator
    # unavailable" (2026-09-21..23) left no trace of why.
    local coord_raw="" _decided_by="agent" _rx_errlog="${LOG_DIR}/retry-extension-coordinator.log"
    mkdir -p "${LOG_DIR}" 2>/dev/null
    printf '=== %s %s (provider=%s model=%s)\n' "$(date -Iseconds)" "$story_id" "$gate_provider" "${gate_model:-<default>}" >> "$_rx_errlog" 2>/dev/null
    if ! coord_raw=$(echo "$coord_prompt" | \
        EPAM_AGENT_NAME="retry-extension-coordinator" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>>"$_rx_errlog"); then
        log "  [RetryExtension] $story_id: the coordinator call failed — see ${_rx_errlog}" >&2
        coord_raw='{"extend":false,"extraRetries":0,"reason":"coordinator unavailable"}'
        _decided_by="agent-unavailable"
    fi

    local extend="false" extra_retries=0 reason=""
    local parsed
    parsed=$(echo "$coord_raw" | python3 "$SCRIPT_DIR/lib/handlers/retry-extension-parsed.py" 2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"unparseable"}')

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

    _retry_extension_record "$story_id" "$evidence" "$_decided_by" "$extend" "${granted:-0}" "$reason"

    if [ "${granted:-0}" -gt 0 ] 2>/dev/null; then
        # >&2 -- see the identical rationale at this function's other log
        # call above (the pre-gate decline path). This was the exact site
        # where a genuinely granted extension got silently dropped live.
        log "  [RetryExtension] $story_id: extending by $granted retr(y/ies) — $reason" >&2
    fi
    echo "${granted:-0}"
    return 0
}
