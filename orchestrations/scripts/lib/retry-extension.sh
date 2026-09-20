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
                python3 "$SCRIPT_DIR/lib/handlers/compute-retry-extension-evidence.py" 2>/dev/null || echo 0)
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
        # UNREADABLE EVIDENCE IS NOT "NO EXTENSION WARRANTED". Both answer 0, and the caller
        # cannot tell them apart — the same defect fixed two branches below, where a missing
        # provider also returned a believable 0. Say which happened; the value is unchanged so
        # no run behaves differently, but a 0 that nobody decided is now visible.
        log "  [RetryExtension] retry-extension evidence for ${story_id} is missing or not valid JSON — returning 0 because it could not be READ, not because none was warranted"
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
    local gate_model="${EPAM_MODEL:-}"
    if [ -z "$gate_provider" ]; then
        # 0 is a plausible answer — "no extension is warranted" — and was returned without any
        # coordination happening. Same shape as the fabricated "pass" above: a value nobody
        # decided, arriving where a decision is expected.
        log "  [RetryExtension] no gate provider configured — SKIPPING coordination; returning 0 because none was DECIDED, not because none was warranted"
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
    coord_prompt="$(render_engine_prompt retry-extension-coordinator "$_cp_vals")"
    rm -f "$_cp_vals"

    local coord_raw=""
    coord_raw=$(echo "$coord_prompt" | \
        EPAM_AGENT_NAME="retry-extension-coordinator" EPAM_STORY_ID="${story_id}" \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"coordinator unavailable"}')

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

    # A RUN LEDGER, WITH THE RUN'S OTHER LEDGERS. This defaulted to OUTPUT_DIR — the codeline on
    # greenfield — and "REGI-005b: story complete" committed retry-extension-decisions.jsonl into
    # the client repository (2026-09-20). LOG_DIR, cleared by the run's reset like the rest.
    mkdir -p "${LOG_DIR}" 2>/dev/null
    jq -nc --arg story "$story_id" --argjson evidence "$evidence" --arg extend "$extend" \
        --argjson granted "${granted:-0}" --arg reason "$reason" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, evidence: $evidence, extend: ($extend == "true"), extraRetriesGranted: $granted, reason: $reason, timestamp: $ts}' \
        >> "${LOG_DIR}/retry-extension-decisions.jsonl" 2>/dev/null || true

    if [ "${granted:-0}" -gt 0 ] 2>/dev/null; then
        # >&2 -- see the identical rationale at this function's other log
        # call above (the pre-gate decline path). This was the exact site
        # where a genuinely granted extension got silently dropped live.
        log "  [RetryExtension] $story_id: extending by $granted retr(y/ies) — $reason" >&2
    fi
    echo "${granted:-0}"
    return 0
}
