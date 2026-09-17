#!/usr/bin/env bash
# story-watchdog.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (10 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# hot_swap_story_model_if_unstable <story_id>
# Called after a story's FIRST watchdog timeout, before the automatic retry.
# A timeout means the invocation produced NO signal at all within the full
# effort-scaled window — that's categorically different from a normal retry
# (which at least has failure content to learn from). Retrying with the exact
# same model+provider pairing risks repeating an unstable/misrouted
# combination for the full timeout window again.
#
# Root cause this addresses (found live, 2026-07-07): a story ended up with
# aiProvider="openrouter" (OpenRouter) paired with model="MiniMax-M3" (a MiniMax-
# native model) after spec-mode's LLM model-review step changed .model without
# syncing .aiProvider — see resolveModelProvider()'s docstring in
# spec-mode-runner.js for the full story. That specific mismatch is now fixed
# at the source, but ANY model/provider pairing can still be transiently
# unstable (rate limits, upstream outage) — this is a general resilience
# measure, not just a patch for that one bug.
#
# Escalates exactly ONE ladder step (reusing the same EPAM_MODEL_LADDER_MEDIUM/
# HIGH / EPAM_MODEL_PROVIDER_MAP config already used by claude.sh's inference
# ladder — duplicated here in minimal form because run-agent-orchestration.sh
# invokes claude.sh as a SEPARATE PROCESS via `timeout`, not sourced, so
# claude.sh's bash functions aren't available in this process). No vendor/
# model names hardcoded — every decision reads from env-configured maps.
# No-op (silent) when no ladder step is configured for the current model.
# _story_archetype_ladder <story-id> — the ladder the story's AGENT ARCHETYPE declares.
#
# Read through the seam, so a minted agent inherits its archetype's declaration rather than needing
# one of its own. Empty when the story names no role, or the registry declares no ladder for it.
_story_archetype_ladder() {
    local _sid="${1:-}" _role
    [ -n "$_sid" ] || { printf ''; return 0; }
    _role=$(jq -r --arg id "$_sid" '.stories[] | select(.id == $id) | .agentRole // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    [ -n "$_role" ] || { printf ''; return 0; }
    "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/seam-ladder-position.js" "$SCRIPT_DIR/lib/seam-invocation.js" \
      "${AGENT_PROFILES_REGISTRY:-$EPAM_AGENTS_DIR/invocation-profiles.json}" "$_role" 2>/dev/null || printf ''
}

# _resolve_ladder_tier <story-tier> — the tier this story actually runs on.
#
# THE ARCHETYPE'S LADDER IS A FLOOR. The operator asked for the writer on the highest ladder and
# story-writer declares `ladder: HIGHEST`; nothing read it. The tier came from the story record,
# which the CPA pre-pass writes, so a deliberate declaration was silently overridden by an
# automated one on every run — the writer ran `high` on 2026-08-14.
#
# The CPA may still RAISE a hard story above its archetype. It may not lower one below.
_resolve_ladder_tier() {
    local _story_tier _floor _rank_story _rank_floor
    _story_tier=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
    _floor=$(printf '%s' "$(_story_archetype_ladder "${story_id:-}")" | tr '[:upper:]' '[:lower:]')

    # ORDER COMES FROM THE DECLARATION, never from a list here. EPAM_MODEL_LADDER_TIER_ORDER is
    # exported by lib/model-ladders.sh from the settings file's own ordering. Ranking tiers in the
    # engine would embed a project's vocabulary in shared code — the exact thing the exporter
    # already refuses to do — and would silently rank an unknown tier lowest.
    #
    # NO DECLARED ORDER MEANS NO FLOOR. The story's tier is used unchanged, which is exactly the
    # behaviour before this function existed: a project that has not declared an order gets no
    # silent change, and the floor activates only when the operator says what the order is.
    local _order="${EPAM_MODEL_LADDER_TIER_ORDER:-}"
    if [ -z "$_order" ] || [ -z "$_floor" ]; then
        [ -n "$_story_tier" ] && { printf '%s' "$_story_tier"; return 0; }
        # NOTHING KNOWN: the LOWEST DECLARED tier, which is the first the order names. Defaulting
        # to a tier named here would be the same vocabulary the ranking refuses to hold, and it
        # only ever worked because one project happened to declare a tier by that name.
        printf '%s' "$(printf '%s' "$_order" | awk '{print $1}')"
        return 0
    fi

    _rank() {
        local _t="${1:-}" _i=0 _c
        [ -n "$_t" ] || { printf '0'; return 0; }
        for _c in $_order; do
            _i=$((_i + 1))
            [ "$_c" = "$_t" ] && { printf '%s' "$_i"; return 0; }
        done
        printf '0'
    }
    _rank_story=$(_rank "$_story_tier")
    _rank_floor=$(_rank "$_floor")

    if [ "$_rank_floor" -gt "$_rank_story" ]; then printf '%s' "$_floor"; return 0; fi
    [ -n "$_story_tier" ] && { printf '%s' "$_story_tier"; return 0; }
    printf '%s' "$_floor"
}

hot_swap_story_model_if_unstable() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local current_model
    current_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null || echo "")
    # 1 = did not advance. The caller climbs while this succeeds, so a
    # "nothing to swap" path reporting 0 would re-run the SAME model.
    [ -z "$current_model" ] && return 1

    local tier
    tier=$(_resolve_ladder_tier "$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .ladderTier // ""' "$prd_target" 2>/dev/null || echo "")")
    local ladder="${EPAM_MODEL_LADDER:-}"
    if [ -z "$ladder" ]; then
        # DERIVED, NOT BRANCHED. lib/model-ladders.sh exports EPAM_MODEL_LADDER_<TIER> for every
        # tier the settings file declares, and names the variable this way; reading it the same
        # way means a project adding a tier never edits the engine. The branch this replaced knew
        # only `high` and a medium default, so a story on any other tier — `highest` included —
        # silently received the MEDIUM ladder while still appearing to have one.
        local _lvar
        _lvar="EPAM_MODEL_LADDER_$(printf '%s' "$tier" | tr '[:lower:]-' '[:upper:]_')"
        ladder="${!_lvar:-}"
    fi
    [ -z "$ladder" ] && return 1

    local new_model="" pair from to IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$ladder"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"
        to="${pair#*=}"
        if [ "$from" = "$current_model" ]; then
            new_model="$to"
            break
        fi
    done

    # Top-of-ladder fallback (found live, 2026-07-12): a model that has NO
    # configured step FROM it (because it's already the ladder's own top rung
    # -- e.g. ESCALATION_MODEL_HIGH itself) used to leave this function a
    # silent no-op, so the retry re-invoked the IDENTICAL model+provider,
    # hit the same class of hang again, and the story was skipped entirely
    # after the second timeout. A watchdog timeout means genuinely zero
    # response within the full window (see this function's own docstring) --
    # that's real evidence the CURRENT pairing is unhealthy, not just slow,
    # so retrying it unchanged a second time is not a meaningful self-heal
    # attempt. Fall back to EPAM_FINAL_FALLBACK_MODEL/PROVIDER -- a
    # genuinely different pairing already configured for exactly this
    # "nowhere left to escalate" case (see claude.sh's own InferenceLadder
    # Rung3 fallback) -- rather than repeating a pairing already known to
    # have failed once.
    if [ -z "$new_model" ] && [ -n "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && [ "${EPAM_FINAL_FALLBACK_MODEL}" != "$current_model" ]; then
        new_model="${EPAM_FINAL_FALLBACK_MODEL}"
    fi
    [ -z "$new_model" ] && return 1   # ladder exhausted

    local new_provider="" map_pair map_from map_to
    if [ "$new_model" = "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && [ -n "${EPAM_FINAL_FALLBACK_PROVIDER:-}" ]; then
        new_provider="${EPAM_FINAL_FALLBACK_PROVIDER}"
    fi
    if [ -n "${EPAM_MODEL_PROVIDER_MAP:-}" ]; then
        IFS='|'
        read -ra map_pairs <<< "$EPAM_MODEL_PROVIDER_MAP"
        IFS="$IFS_SAVE"
        for map_pair in "${map_pairs[@]}"; do
            map_from="${map_pair%%=*}"
            map_to="${map_pair#*=}"
            # The pattern is a GLOB from the provider map and must stay unquoted: quoting it would match the
            # literal characters, and no mapping would ever fire.
            # shellcheck disable=SC2254
            case "$new_model" in
                $map_from) new_provider="$map_to"; break ;;
            esac
        done
    fi

    local jq_args=(--arg id "$story_id" --arg m "$new_model")
    local jq_filter='(.stories[] | select(.id == $id) | .model) = $m'
    if [ -n "$new_provider" ]; then
        jq_args+=(--arg p "$new_provider")
        jq_filter='(.stories[] | select(.id == $id) | .model) = $m | (.stories[] | select(.id == $id) | .aiProvider) = $p'
    fi
    local tmp_prd
    tmp_prd=$(mktemp)
    # mktemp defaults to mode 0600; mv preserves that onto the final PRD file,
    # which then becomes unreadable to anything not running as the same user
    # (e.g. the monitor dashboard's nginx worker, which runs as an
    # unprivileged 'nginx' user) -- found live 2026-07-14 as "Cannot load
    # prd.json" (HTTP 403) mid-run. chmod back to the standard 644 before the
    # rename so every atomic PRD write stays group/world-readable.
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq "${jq_args[@]}" "$jq_filter" "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        local _swap_reason="ladder step"
        [ "$new_model" = "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && _swap_reason="top-of-ladder fallback"
        warning "Watchdog: hot-swapping $story_id model after timeout ($_swap_reason): '$current_model' -> '$new_model'${new_provider:+ (provider -> $new_provider)}"
        # 0 = advanced to a new rung. The caller climbs while this succeeds, so
        # the return value is the ladder's "is there more?" signal.
        return 0
    else
        rm -f "$tmp_prd"
    fi
}

# maybe_upgrade_model_for_tc_density <story_id> <tc_facts_count>
# Re-assess a story's model tier once its real TC-fact density is known.
#
# Root cause this fixes (found live, 2026-07-13, SKY-002-test): spec-mode-
# runner.js's modelComplexitySignals() decides low/standard tier from
# acceptanceCriteria.length ALONE, during Step 0 — before the inline TC
# writer (post-impl-tc-writer.sh) has ever run for this story. A story with a
# modest AC count (e.g. 8, classified "low" effort) can still carry a much
# higher TC-fact density (22 granular, exact-match behavioral facts: exact
# error strings, env-var precedence, multi-key field-extraction fallbacks, a
# large bannedPatterns list) once TCs are actually written — data the Step 0
# classifier could not have had yet. Confirmed live: SKY-002-test (8 ACs, 22
# TC facts, MiniMax-M3) burned its full 8-attempt escalation ladder on small
# precision slips (wrong import name, one broken string literal) against all
# 22 checks, then failed on a watchdog timeout at the highest rung.
#
# Called right after the inline TC writer succeeds, before that story's own
# implementation attempt begins — reuses EPAM_MODEL_PROVIDER_MAP the same way
# hot_swap_story_model_if_unstable does, so provider stays in sync with model.
maybe_upgrade_model_for_tc_density() {
    local story_id="$1"
    local tc_facts_count="${2:-0}"
    local prd_target="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
    local threshold="${EPAM_TC_FACTS_UPGRADE_THRESHOLD:-15}"

    [ -z "${ORCH_UPGRADE_MODEL:-}" ] && return 0
    [ "$tc_facts_count" -le "$threshold" ] && return 0

    local current_model
    current_model=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null)
    [ -z "$current_model" ] && return 0
    [ "$current_model" = "$ORCH_UPGRADE_MODEL" ] && return 0

    local new_provider="" pair from to ifs_save="$IFS"
    if [ -n "${EPAM_MODEL_PROVIDER_MAP:-}" ]; then
        IFS='|'
        read -ra pairs <<< "$EPAM_MODEL_PROVIDER_MAP"
        IFS="$ifs_save"
        for pair in "${pairs[@]}"; do
            from="${pair%%=*}"
            to="${pair#*=}"
            # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
            case "$ORCH_UPGRADE_MODEL" in
                $from) new_provider="$to"; break ;;
            esac
        done
    fi

    local tmp_prd
    tmp_prd=$(mktemp)
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq --arg id "$story_id" --arg m "$ORCH_UPGRADE_MODEL" --arg p "$new_provider" \
          --arg reason "tc-facts=${tc_facts_count} exceeds threshold=${threshold}" \
          --arg ts "$(date -Iseconds)" --arg from_model "$current_model" \
          '(.stories[] | select(.id == $id)) |= (
               .model = $m
               | .aiProvider = (if $p == "" then .aiProvider else $p end)
               | .specification.tcDensityUpgrade = {from: $from_model, to: $m, reason: $reason, upgradedAt: $ts}
           )' \
          "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        warning "  [tc-density-upgrade] $story_id: ${tc_facts_count} TC facts exceeds threshold ($threshold) — upgrading model $current_model -> $ORCH_UPGRADE_MODEL${new_provider:+ (provider -> $new_provider)}"
    else
        rm -f "$tmp_prd"
        warning "  [tc-density-upgrade] jq update failed for $story_id — leaving model unchanged"
    fi
}

# Run a single story with effort-based timeout + one automatic retry.
# On double timeout:
#   EPAM_PAUSE_ON_TIMEOUT=true  → pause and wait for operator (max EPAM_MAX_PAUSE_SECS)
#   EPAM_PAUSE_ON_TIMEOUT=false → skip the story, log failure, continue (default)
# run_story_recovery_analyst <story_id> <log_file>
# Diagnose-then-restructure recovery for a story that hit a genuine watchdog
# double-timeout (marked status="failed", technicalNotes.failureReason
# starting "watchdog_timeout" -- see run_story_with_watchdog below).
#
# User request (2026-07-10, after SKY-002b and SKY-003-test both timed out
# twice in the same run): "we need to determine a self heal approach a full
# blown prd recovery perhaps" -- rejected a plain retry-with-escalated-model
# as "not really a healing approach". This treats a double-timeout as
# evidence the PLAN (the story's own scope/ACs) may be wrong, not just that
# the model got unlucky: it hands the story's full PRD entry and its own
# execution log tail to an analyst, asks whether the story's scope is
# genuinely too large/ambiguous, and if so has it propose a narrower,
# trimmed acceptanceCriteria list -- applied through the SAME reviewer-gated
# mechanism already used for ac_patch changes elsewhere in this file, not a
# new bespoke path. Deliberately scoped to watchdog-timeout failures ONLY (not
# HealingBroken-at-max-rung or other failure shapes) -- those are a different
# failure mode this pass doesn't attempt to cover.
#
# Bounded: at most ONE restructure + ONE retry per story. If the analyst finds
# no structural issue, the reviewer rejects the proposed ACs, or the retry
# still fails, this returns 1 and the caller counts it as a phase failure
# exactly like today.
run_story_recovery_analyst() {
    local story_id="$1"
    local log_file="$2"

    local _failure_reason
    _failure_reason=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.failureReason // ""' \
        "$PRD_FILE" 2>/dev/null || echo "")
    case "$_failure_reason" in
        watchdog_timeout*) ;;
        *) return 1 ;;
    esac

    local _story_json
    _story_json=$(jq -c --arg id "$story_id" '.stories[] | select(.id == $id)' "$PRD_FILE" 2>/dev/null)
    [ -z "$_story_json" ] && return 1

    local _log_tail
    _log_tail=$(cat "$log_file" 2>/dev/null || echo "")

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/story-recovery-analyst-vals-XXXXXX.json")
    jq_vals \
          --arg story_json "${_story_json}" \
          --arg log_tail "${_log_tail}" \
          --arg story_id "${story_id}" \
          '{"__STORY_JSON__":$story_json,"__LOG_TAIL__":$log_tail,"__STORY_ID__":$story_id}' > "$_cp_vals"
    local _prompt
    _prompt="$(render_engine_prompt story-recovery-analyst "$_cp_vals")"
    rm -f "$_cp_vals"

    local _analyst_response="" _sra_attempt=0
    while [ "$_sra_attempt" -lt 2 ]; do
        local _sra_prompt="$_prompt"
        if [ "$_sra_attempt" -ge 1 ]; then
          _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
          jq_vals \
                --arg prompt "$_prompt" \
                '{"__PROMPT__":$prompt}' > "$_rp_vals"
          _sra_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" story_recovery_analyst)"
          rm -f "$_rp_vals"
        fi
        local _sra_raw
        _sra_raw=$(run_orch_prompt_with_tools "$_sra_prompt" "story_recovery" "$story_id" 2>/dev/null)
        if [ -n "$_sra_raw" ] && echo "$_sra_raw" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
            _analyst_response="$_sra_raw"
            break
        fi
        warning "  [StoryRecovery] story-recovery-analyst attempt $(( _sra_attempt + 1 )) returned no parseable JSON$([ "$_sra_attempt" -lt 1 ] && echo " — retrying" || echo "")"
        _sra_attempt=$(( _sra_attempt + 1 ))
    done
    if [ -z "$_analyst_response" ]; then
        warning "  [StoryRecovery] story-recovery-analyst returned no parseable response after 2 attempt(s) — leaving as failed"
        return 1
    fi
    local _restructure
    _restructure=$(echo "$_analyst_response" | jq -r '.restructure // false' 2>/dev/null || echo false)

    if [ "$_restructure" != "true" ]; then
        log "  [StoryRecovery] Analyst found no structural issue for $story_id — leaving as failed"
        return 1
    fi

    local _new_acs
    _new_acs=$(echo "$_analyst_response" | jq -c '.new_acs // []' 2>/dev/null || echo "[]")
    if [ "$(echo "$_new_acs" | jq 'length' 2>/dev/null || echo 0)" -eq 0 ]; then
        warning "  [StoryRecovery] Analyst said restructure=true but gave no new_acs — leaving as failed"
        return 1
    fi

    local _before_acs
    _before_acs=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | join("; ")' \
        "$PRD_FILE" 2>/dev/null || echo "")
    local _candidate
    _candidate=$(echo "$_new_acs" | jq -r 'join("; ")')

    # Reviewer gate — inline call (NOT a call to run_change_with_reviewer_retry,
    # which only exists in claude.sh's scope; this script never sources it).
    # Root cause this fixes (found live, 2026-07-12, tier3-travel-app run):
    # the previous call to that undefined function failed with bash's own
    # "command not found", and since that failure's stdout is empty (the
    # error goes to stderr), $_verdict became "" — which is NOT equal to
    # "fail", so the `if [ "$_verdict" = "fail" ]` check below always passed
    # and the restructured ACs were applied to the PRD with ZERO actual
    # review, every single time this path ran. The gate failed OPEN, not
    # closed. Fixed by inlining the same direct-LLM-call pattern already used
    # by every other in-file reviewer gate (e.g. the pre-phase-assessment
    # profile-change gate above) instead of referencing a function that was
    # never available in this script.
    local _verdict="pass"  # fail-safe only when reviewer is not configured
    if [ -n "${ORCH_GATE_PROVIDER:-}" ]; then
        # FROM THE ROSTER, and its absence is not a pass.
        #
        # This jq-ed the shared profiles file and, on an empty result, fell through with
        # _verdict still "pass" — so a PRD change was certified by a reviewer that never ran,
        # and the only trace was a profile that happened to be missing. Every canonical agent is
        # specialised into the roster, so an absence here is a defect in the roster.
        local _src_reviewer_profile
        if ! _src_reviewer_profile=$(roster_persona prd-change-reviewer 2>&1); then
            error "  [prd-change-review] cannot resolve the reviewer's persona: ${_src_reviewer_profile}"
            error "  [prd-change-review] Refusing to certify a PRD change with no reviewer."
            return 1
        fi
        if [ -n "$_src_reviewer_profile" ]; then
            local _rev_raw="" _rev_attempt=0
            while [ "$_rev_attempt" -lt 2 ] && [ -z "$_rev_raw" ]; do
                local _corrective_rev=""
                [ "$_rev_attempt" -gt 0 ] && _corrective_rev="CORRECTION: Your previous response did not contain parseable JSON with a verdict field. Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}

"
                # Its seam's model, then one rung up ITS OWN chain on retry. This read a run-wide
                # pin behind a vendor literal, and escalated to a single run-wide "high" model that
                # every agent shared regardless of where it started. That is a pin, not a ladder.
                local _rev_model
                _rev_model=$(seam_model_or_fail "prd-change-reviewer") || _rev_model=""
                [ "$_rev_attempt" -ge 1 ] && _rev_model=$(seam_next_model "prd-change-reviewer" "$_rev_model")
                _rev_raw=$(echo "${_corrective_rev}${_src_reviewer_profile}

                $(_render_change_reviewer "$story_id" "ac_patch" "BEFORE:\n${_before_acs}\n\nAFTER:\n${_candidate}")" | \
                    AI_PROVIDER="${ORCH_GATE_PROVIDER}" \
                    AI_MODEL="${_rev_model}" \
                    EPAM_CLI="${EPAM_CLI:-epam}" \
                    "$AI_RUNNER_CMD" \
                        --provider "${ORCH_GATE_PROVIDER}" \
                        --model    "${_rev_model}" \
                    2>/dev/null | \
                    python3 "$SCRIPT_DIR/lib/handlers/run-story-recovery-analyst.py" 2>/dev/null || true)
                _rev_attempt=$(( _rev_attempt + 1 ))
            done
            if [ "$_rev_raw" = "pass" ] || [ "$_rev_raw" = "fail" ]; then
                _verdict="$_rev_raw"
            else
                warning "  [StoryRecovery] Reviewer failed to produce a valid verdict after 2 attempt(s) — defaulting to fail (fail-safe)"
                _verdict="fail"
            fi
        fi
    fi
    if [ "$_verdict" = "fail" ]; then
        warning "  [StoryRecovery] Reviewer rejected the restructured ACs for $story_id — leaving as failed"
        return 1
    fi

    jq --arg id "$story_id" --argjson acs "$_new_acs" \
        '(.stories[] | select(.id == $id) | .acceptanceCriteria) = $acs |
         (.stories[] | select(.id == $id) | .status) = "pending" |
         (.stories[] | select(.id == $id) | .completed) = false |
         (.stories[] | select(.id == $id) | .technicalNotes.failureReason) = null |
         (.stories[] | select(.id == $id) | .technicalNotes.recoveredFrom) = "watchdog_timeout"' \
        "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"

    jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg id "$story_id" --argjson acs "$_new_acs" \
        '{timestamp:$ts, story_id:$id, event:"story_restructured", new_acs:$acs}' \
        >> "$LOG_DIR/story-recovery-audit.jsonl" 2>/dev/null || true

    success "  [StoryRecovery] Restructured ACs for $story_id — retrying once with narrowed scope"
    run_story_with_watchdog "$story_id" "$log_file"
}

#
# Effort-based defaults (overridden by STORY_TIMEOUT_SECS or
# EPAM_STORY_TIMEOUT_SECS — the latter is what a project's llm-settings.json
# storyTimeoutSecs actually loads via _load_timeout_config(), see
# lib/story-guards.sh):
#   low    → 600s  (10 min) — EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS
#   medium → 1200s (20 min) — EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS
#   high   → 2400s (40 min) — EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS
#   *      → 900s  (15 min) — EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS
# Each tier is config-driven (llm-settings.json's timeouts.storyEffortTimeoutSecs)
# with the values above as the fallback when a project sets none — no
# project-specific fact should be baked into pipeline code as a bare literal.
# The effort-derived value is then scaled by a per-agentRole multiplier
# (EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP, default "test-engineer=1.5", also
# config-driven via timeouts.roleTimeoutMultipliers) — role names come from
# whatever the pipeline itself assigned to the story in prd.json (Step
# 0.5/0.9), never hardcoded to a specific project's stack; an unmatched role
# gets multiplier 1.0 (today's exact behavior).
resolve_role_timeout_multiplier() {
    local story_id="$1"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    [ -z "$role" ] && { echo "1.0"; return 0; }
    local map pair from to ifs_save="$IFS"
    map="${EPAM_ROLE_TIMEOUT_MULTIPLIER_MAP:-test-engineer=1.5}"
    IFS='|'; read -ra pairs <<< "$map"; IFS="$ifs_save"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"; to="${pair#*=}"
        if [ "$role" = "$from" ]; then
            echo "$to"
            return 0
        fi
    done
    echo "1.0"
}

run_story_with_watchdog() {
    local story_id="$1"
    local log_file="$2"
    local _rc=0

    # Determine timeout: explicit override wins (STORY_TIMEOUT_SECS, a manual
    # per-invocation env var, takes priority over EPAM_STORY_TIMEOUT_SECS, the
    # project-config-loaded fallback — same "manual env var beats project
    # config" precedence load_llm_settings_json() already uses elsewhere),
    # else scale by effort.
    local timeout_secs
    if [ -n "${STORY_TIMEOUT_SECS:-}" ]; then
        timeout_secs="$STORY_TIMEOUT_SECS"
    elif [ -n "${EPAM_STORY_TIMEOUT_SECS:-}" ]; then
        timeout_secs="$EPAM_STORY_TIMEOUT_SECS"
    else
        local story_effort
        story_effort=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .effort // "medium"' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "medium")
        case "$story_effort" in
            low)    timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_LOW_SECS:-600}"     ;;
            medium) timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_MEDIUM_SECS:-1200}" ;;
            high)   timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_HIGH_SECS:-2400}"   ;;
            *)      timeout_secs="${EPAM_STORY_EFFORT_TIMEOUT_DEFAULT_SECS:-900}" ;;
        esac
        local role_multiplier
        role_multiplier=$(resolve_role_timeout_multiplier "$story_id")
        timeout_secs=$(python3 "$SCRIPT_DIR/lib/handlers/scaled-timeout-secs.py" "${role_multiplier}" "${timeout_secs}" 2>/dev/null || echo "$timeout_secs")
    fi

    # THE WALL MUST HONOUR THE ITERATION BUDGET IT IS POLICING.
    #
    # timeout_secs above is a FLOOR. The attempt's real work is bounded by its iteration budget,
    # and the two were set independently: measured 2026-08-10, kimi-k3 allows 150 iterations plus
    # a +30 rung bump = 180, against a flat 1800s wall — 10 seconds per turn including tool
    # execution. 10 of 23 invocations were SIGKILLed mid-flight having produced nothing, and they
    # were the most expensive attempts of the run. A budget the clock cannot honour is not a
    # budget; it is a guaranteed kill that still bills.
    #
    # Derived, capped, and never LOWER than the configured floor. Both knobs are config
    # (timeouts.secondsPerIteration / timeouts.storyTimeoutMaxSecs) — no numbers here.
    # THE ITERATION COUNT COMES FROM THE CHILD, WHICH IS THE ONLY THING THAT KNOWS IT.
    #
    # This used to read EPAM_MAX_ITERATIONS, which is UNSET here: claude.sh computes
    # _effective_max_iterations per model, per attempt, minutes AFTER this function fixes the
    # wall. So the branch NEVER EXECUTED, its log line has never appeared in any run, and the
    # wall silently stayed at the FLOOR — measured live 2026-08-11, 185 iterations x 12s =
    # 2,220s of authorised work under an 1,800s wall, with a 5,400s cap never approached. The
    # kill was scheduled at authorisation time, twice in one day.
    #
    # claude.sh now persists what it granted; this reads it. A first attempt has nothing
    # persisted yet and correctly uses the floor — the point is that every attempt AFTER an
    # escalation is policed by the budget that escalation actually handed out.
    local _spi="${EPAM_SECONDS_PER_ITERATION:-}"
    local _tmax="${EPAM_STORY_TIMEOUT_MAX_SECS:-}"
    # ONE ATTEMPT. iterations x secondsPerIteration is a good estimator of the WRITER —
    # measured 2026-08-12, 120 x 12 = 1440s against 1460s of real writer time — but an attempt
    # is not only its iterations. It also pays planning, gates, verification and the failure
    # analyst, none of which the iteration budget can express. That overhead is declared.
    _derive_attempt_wall() {
        local _base="$1" _iters="$2"
        [ -n "$_spi" ] || { echo "$_base"; return 0; }
        case "$_iters" in ''|*[!0-9]*|0) echo "$_base"; return 0 ;; esac
        awk -v it="$_iters" -v spi="$_spi" -v cur="$_base" -v cap="${_tmax:-0}" \
            -v oh="${EPAM_PER_ATTEMPT_OVERHEAD_SECS:-0}" 'BEGIN {
            d = it * spi + oh;
            if (cap > 0 && d > cap) d = cap;
            if (d < cur) d = cur;
            printf "%d", d
        }'
    }

    # THE WHOLE STORY, WHICH IS NOT ONE ATTEMPT.
    #
    # THE DEFECT THIS EXISTS FOR: EPAM_STORY_TIMEOUT_SECS bounded BOTH scopes. claude.sh
    # wraps each single LLM invocation in `timeout $EPAM_STORY_TIMEOUT_SECS` (claude.sh:9265)
    # and this watchdog wrapped ALL of claude.sh — up to MAX_RETRIES+1 = 8 attempts — in the
    # same number. One attempt was permitted exactly as much wall clock as eight together, so
    # the outer wall could not accommodate what the inner loop was authorised to do at ANY
    # value of secondsPerIteration. Live 2026-08-12: two attempts consumed 1780s of an 1800s
    # wall and the story was SIGKILLed with six attempts still nominally available.
    #
    # The story wall is therefore a HANG DETECTOR, not a work ration: it is what the inner
    # loop may need, bounded by an operator ceiling that is declared separately from the
    # per-attempt cap.
    _derive_story_wall_total() {
        local _attempt; _attempt=$(_derive_attempt_wall "$1" "$2")
        local _attempts=$(( ${EPAM_MAX_RETRIES:-0} + 1 ))
        [ "$_attempts" -gt 0 ] 2>/dev/null || _attempts=1
        awk -v a="$_attempt" -v n="$_attempts" -v cap="${EPAM_STORY_WALL_MAX_SECS:-0}" 'BEGIN {
            d = a * n;
            if (cap > 0 && d > cap) d = cap;
            printf "%d", d
        }'
    }
    local _persisted_iters
    _persisted_iters=$(read_story_effective_iterations "$LOG_DIR" "$story_id" 2>/dev/null || echo 0)
    if [ -n "$_spi" ]; then
        local _derived
        _derived=$(_derive_story_wall_total "$timeout_secs" "$_persisted_iters")
        if [ -n "$_derived" ] && [ "$_derived" != "$timeout_secs" ]; then
            log "[orch] story timeout ${timeout_secs}s -> ${_derived}s (derived from ${_persisted_iters} iterations x ${_spi}s/iteration, cap ${_tmax:-none})"
            timeout_secs="$_derived"
        elif [ "${_persisted_iters:-0}" -eq 0 ]; then
            # First attempt for this story: nothing granted yet, so the floor is correct — and
            # saying so is what makes the silent skip impossible to mistake for a decision.
            log "[orch] story timeout ${timeout_secs}s (floor — no iteration budget granted yet for $story_id)"
        fi
    else
        # A configured secondsPerIteration is what makes derivation possible. Its absence is a
        # config gap, not a licence to police an unknown budget with a fixed number.
        warning "[orch] timeouts.secondsPerIteration is not configured — the story wall cannot be derived and stays at ${timeout_secs}s"
    fi

    set +e
    timeout "$timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee "$log_file"
    _rc=${PIPESTATUS[0]}
    set -e

    if [ $_rc -eq 124 ]; then
        # Scale the retry's timeout up (found live, 2026-07-07): a story that
        # timed out once has, by construction, already burned several internal
        # self-heal attempts within that window — each one appends more KB/
        # coordinator-guidance context, so by the time the SAME flat timeout
        # budget is handed to the retry, the cumulative prompt is already larger
        # than attempt 1's. A live process inspection during a real timeout
        # confirmed a genuinely in-flight, still-connected API call (not a
        # stuck/crashed one) — the retry deserves more room, not the same
        # budget that already proved insufficient once. Multiplier is
        # configurable (EPAM_WATCHDOG_RETRY_MULTIPLIER, default 1.5x); set to 1
        # to restore the old flat-timeout behavior.
        local retry_timeout_secs
        retry_timeout_secs=$(python3 "$SCRIPT_DIR/lib/handlers/scaled-timeout-secs.py" "${EPAM_WATCHDOG_RETRY_MULTIPLIER:-1.5}" "${timeout_secs}" 2>/dev/null || echo "$timeout_secs")
        # ── Climb the ladder, do not merely swap once ─────────────────────
        # This was a single retry, so at most ONE escalation could ever happen.
        # The HIGH ladder is four rungs (MiniMax-M2.5 -> MiniMax-M3 ->
        # z-ai/glm-5.1 -> moonshotai/kimi-k3), which made everything above the
        # second rung unreachable BY CONSTRUCTION —
        # EPAM_FINAL_FALLBACK_MODEL=kimi-k3 could never be used, and hot_swap
        # even logs a "top-of-ladder fallback" case it could not reach. Live
        # AMSD-2041 2026-07-29: three lanes, one hot-swap each, kimi-k3 absent
        # from every log.
        #
        # An escalation is not a replacement: moving to a NEW rung must not
        # consume the story's last attempt, or "escalate" means "swap the model
        # and give up". So attempts continue while the ladder still offers a new
        # model, bounded by EPAM_MAX_LADDER_ATTEMPTS so a mis-configured ladder
        # cannot loop. When the swap yields nothing new the ladder is exhausted
        # and stopping is correct — retrying the same model is the same gamble.
        local _lad_attempt=1
        local _lad_max="${EPAM_MAX_LADDER_ATTEMPTS:-6}"
        while [ "$_rc" -eq 124 ] && [ "$_lad_attempt" -lt "$_lad_max" ]; do
            local _lad_swapped=0
            hot_swap_story_model_if_unstable "$story_id" || _lad_swapped=1
            # The FIRST retry happens regardless — that is the pre-existing
            # "retry once with an extended budget" behaviour, and a story whose
            # project configures no ladder must not lose it. Only the SECOND and
            # later retries require an actual escalation, because repeating a
            # model that did not finish twice is the gamble the ladder exists to
            # avoid.
            if [ "$_lad_attempt" -gt 1 ] && [ "$_lad_swapped" -ne 0 ]; then
                warning "Watchdog: $story_id — ladder exhausted, no further model to escalate to"
                break
            fi
            _lad_attempt=$(( _lad_attempt + 1 ))
            # RE-DERIVE AFTER THE ESCALATION, NOT BEFORE IT.
            #
            # hot_swap_story_model_if_unstable just moved this story to a new rung, and rungs
            # change the iteration budget — live 2026-08-11 a rung bump took maxIter from 28 to
            # 185, and again to 345 on kimi-k3. Scaling the OLD wall by a fixed multiplier
            # polices the new budget with the previous rung's arithmetic, which is how
            # escalation kept WIDENING the gap between work authorised and time permitted. The
            # child persisted what it granted on the attempt that just timed out; use it.
            local _retry_iters _retry_derived
            _retry_iters=$(read_story_effective_iterations "$LOG_DIR" "$story_id" 2>/dev/null || echo 0)
            _retry_derived=$(_derive_story_wall_total "$retry_timeout_secs" "$_retry_iters")
            if [ -n "$_retry_derived" ] && [ "$_retry_derived" != "$retry_timeout_secs" ]; then
                log "[orch] retry wall ${retry_timeout_secs}s -> ${_retry_derived}s (re-derived from ${_retry_iters} iterations granted on the attempt that timed out)"
                retry_timeout_secs="$_retry_derived"
            fi
            warning "Watchdog: $story_id timed out after ${timeout_secs}s — attempt ${_lad_attempt}/${_lad_max} on the next ladder rung with a ${retry_timeout_secs}s budget..."
            set +e
            timeout "$retry_timeout_secs" "$CLAUDE_SH" "$story_id" 2>&1 | tee -a "$log_file"
            _rc=${PIPESTATUS[0]}
            set -e
        done
    fi

    if [ $_rc -eq 124 ]; then
        if [ "${EPAM_PAUSE_ON_TIMEOUT:-false}" = "true" ]; then
            error "Watchdog: $story_id timed out twice — pausing (max ${EPAM_MAX_PAUSE_SECS}s)"
            printf '%s' "$(jq -n \
                --arg reason  "story_timeout" \
                --arg story   "$story_id" \
                --arg phase   "$PHASE" \
                --argjson tsecs "$timeout_secs" \
                --argjson retryTsecs "${retry_timeout_secs:-$timeout_secs}" \
                '{reason:$reason,storyId:$story,phase:$phase,timeoutSecs:$tsecs,retryTimeoutSecs:$retryTsecs,pausedAt:(now|todate)}'
            )" > "$LOG_DIR/PAUSED"
            wait_if_paused
            # Operator resumed — continue past the timed-out story
            return 0
        else
            error "Watchdog: $story_id timed out twice (${timeout_secs}s then ${retry_timeout_secs:-$timeout_secs}s) — skipping story and continuing"
            warning "  Set EPAM_PAUSE_ON_TIMEOUT=true to pause for operator intervention instead"
            # Log the timeout as a failed cost record so dashboards reflect it
            # A killed attempt spent real money. Recording only {status:"timeout"} made the
            # most expensive invocations of the run contribute $0 to the story's running total,
            # so the budget guard that sums task_cost_usd could never see them. AgentRunner
            # persists usage-so-far after every turn to EPAM_USAGE_PROGRESS_FILE precisely so
            # this record can be truthful about an attempt that never got to report for itself.
            _to_progress="${EPAM_USAGE_PROGRESS_FILE:-$LOG_DIR/usage-progress-${story_id}.json}"
            _to_in=0; _to_out=0; _to_cached=0; _to_cost=0
            if [ -f "$_to_progress" ]; then
                _to_in=$(jq -r '.inputTokens // 0' "$_to_progress" 2>/dev/null || echo 0)
                _to_out=$(jq -r '.outputTokens // 0' "$_to_progress" 2>/dev/null || echo 0)
                _to_cached=$(jq -r '.cachedInputTokens // 0' "$_to_progress" 2>/dev/null || echo 0)
                _to_cost=$(jq -r '.costUsd // 0' "$_to_progress" 2>/dev/null || echo 0)
            fi
            jq -cn \
                --arg pid "${CURRENT_PHASE:-unknown}" \
                --arg sid "$story_id" \
                --arg s   "timeout" \
                --arg rid "${ORCH_RUN_ID:-}" \
                --argjson ti "${_to_in:-0}" --argjson to "${_to_out:-0}" \
                --argjson cr "${_to_cached:-0}" --argjson cu "${_to_cost:-0}" \
                '{phase_id:$pid, story_id:$sid, run_id:$rid, status:$s, task_tokens_in:$ti,
                  task_tokens_out:$to, cache_read_tokens:$cr, task_cost_usd:$cu,
                  timestamp:(now|todate)}' \
                >> "${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}" 2>/dev/null || true

            # Root cause fix (found live, 2026-07-10, tier3-travel-app run): this
            # branch used to `return 0` (success) after a double-timeout, so the
            # PRD kept the story at "pending" forever and the phase reported
            # success anyway — a silent deliverable loss, the same failure class
            # as the original vanishing-stories bug this pipeline guards
            # against elsewhere. Mark the story failed in the PRD and propagate
            # a real failure exit code so the caller's _phase_story_failures
            # counter (and the phase-abort gate) actually sees it.
            jq --arg id "$story_id" \
               '(.stories[] | select(.id == $id) | .status) = "failed" |
                (.stories[] | select(.id == $id) | .technicalNotes.failureReason) =
                    "watchdog_timeout: story exceeded timeout twice and was skipped"' \
               "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
            return 1
        fi
    fi

    return $_rc
}

# _log_guarded_step_retry <json_line> — takes an ALREADY-BUILT JSON record
# (each call site's own jq -n -c ... call, which knows its own step-specific
# fields) and appends it, augmented with runId + promptVersion, to BOTH:
#   - $LOG_DIR/guarded-step-retries.jsonl (per-run, project-local, unchanged
#     from tonight's original retry-guard feature — useful for single-run
#     debugging)
#   - orchestrations/logs/guarded-step-retries-history.jsonl (persistent,
#     ENGINE-side — survives this pipeline's own "teardown" convention,
#     rm -rf OUTPUT_DIR, which wipes the per-run copy above before every
#     fresh launch). Mirrors phase-cost.jsonl's identical DASHBOARD_ROOT-
#     relative convention (see dashboards/build/snapshot.js's PATHS).
#
# Root cause this fixes (found live, 2026-07-13): without this, there was no
# way to see whether a prompt's violation rate is improving or regressing
# over time — every relaunch destroyed the only record of the previous run.
_log_guarded_step_retry() {
    local json_line="$1"
    local augmented
    augmented=$(echo "$json_line" | jq -c --arg runId "${ORCH_RUN_ID:-unknown}" --arg pv "$(_epam_prompt_version)" \
        '. + {runId: $runId, promptVersion: $pv}' 2>/dev/null)
    [ -z "$augmented" ] && augmented="$json_line"
    echo "$augmented" >> "$LOG_DIR/guarded-step-retries.jsonl" 2>/dev/null || true
    mkdir -p "$SCRIPT_DIR/../logs" 2>/dev/null || true
    echo "$augmented" >> "$SCRIPT_DIR/../logs/guarded-step-retries-history.jsonl" 2>/dev/null || true
}

# _mc_no_assignment_verdict <call_exit_status>
#
# A GATE MUST HAVE A VERDICT SOMEONE CAN READ.
#
# When the coordinator assigned nothing, this reported "No assignments made (agent found nothing to
# do or failed)" and recorded outcome "noop" — one line and one audit value covering two OPPOSITE
# outcomes. Live 2026-09-10 (openrouter run 20260910T222155Z) AMSD-1919 entered the writer queue
# with aiProvider and model unset and nothing could say whether that was intended.
#
# The information was already in hand: _mc_rc holds the call's exit status, captured ~60 lines
# above and already warned about separately. This just uses it. Nothing about control flow changes
# — only what the run says, and what the audit record carries.
_mc_no_assignment_verdict() {
    local _rc="${1:-0}"
    if [ "$_rc" != "0" ]; then
        warning "  [prd-model-coordinator] assigned nothing because the call FAILED (exit ${_rc}) — stories keep their existing assignment"
        _mc_final_outcome="failed"
    else
        info "  [prd-model-coordinator] the call succeeded and had nothing to assign — every story already carries a model"
        _mc_final_outcome="noop"
    fi
}

# _mc_enforce_ladder <prd-file> [when]
#
# EVERY STORY'S MODEL IS ON THIS SET'S DECLARED LADDER, OR IT IS PUT THERE.
#
# Extracted 2026-09-06 so it can run on BOTH sides of the coordinator. It used to run only BEFORE,
# and the guard selects `(.model // "") != ""` — so a story with NO model yet matched nothing, and
# the coordinator then assigned one with nothing left to check it. Validate-then-write, in that
# order, is not validation: it inspects the state the writer is about to replace.
#
# Live 2026-09-05, run 20260905T172837Z on the claude-only set: the PRD held model=undefined at the
# pause-1 checkpoint and before CPA, and model="MiniMax-M3"/aiProvider="minimax" after step 7 — a
# model that appears zero times in llm-defaults.claude.json. Pre-flight refused to start the
# writer, correctly, but only after the run had reached that point.
#
# The permitted set is the project's own resolved ladder, READ and never listed, so a project
# declaring other models needs no change here. Idempotent by construction: a second call over an
# already-corrected PRD selects nothing and rewrites nothing.
_mc_enforce_ladder() {
    local _prd="${1:-}" _when="${2:-}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    # THE PROVIDER FIRST, BEFORE ANY EARLY RETURN BELOW. Called at the end, it was never reached
    # when every model was already on the ladder — the exact state of regintel 20260916T200108Z
    # (models corrected by an earlier pass, providers still minimax), so the correction it exists
    # for did not run.
    _mc_enforce_providers "$_prd" "$_when"
    local _allowed _fixed _start _tmp
    _allowed="$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/ladder-models.js" 2>/dev/null || echo "")"
    # AN EMPTY LADDER CORRECTS NOTHING. Rewriting every model to "" because the ladder could not be
    # resolved would break a PRD that was fine; the resolution failure is reported by the refusal
    # further down, which is where it belongs.
    [ -n "$_allowed" ] && [ "$_allowed" != "[]" ] || return 0
    _fixed=$(jq -r --argjson allowed "$_allowed" '
        [ .stories[]? | select((.model // "") != "" and ((.model) as $m | $allowed | index($m) | not)) | .id ]
        | join(", ")' "$_prd" 2>/dev/null || echo "")
    [ -n "$_fixed" ] || return 0
    _start=$(printf '%s' "$_allowed" | jq -r '.[0] // empty')
    [ -n "$_start" ] || return 0
    warning "  [prd-model-coordinator] assigned a model on no declared ladder${_when:+ ($_when)} for: ${_fixed}"
    warning "    corrected to '${_start}' — a model off the ladder has no successor and cannot escalate"
    _tmp=$(mktemp)
    jq --argjson allowed "$_allowed" --arg start "$_start" '
        .stories |= map(if ((.model // "") != "" and ((.model) as $m | $allowed | index($m) | not))
                        then .model = $start else . end)' "$_prd" > "$_tmp" 2>/dev/null \
        && mv "$_tmp" "$_prd" || rm -f "$_tmp"
}

# _mc_enforce_providers <prd-file> [when]
#
# THE PROVIDER IS CORRECTED WITH THE MODEL, NOT LEFT BEHIND. _mc_enforce_ladder put every story's
# model on this set's ladder and left aiProvider as it found it. regintel 20260916T200108Z
# (2026-09-17, claude set): nine stories carried aiProvider=minimax with model=claude-haiku — a
# pair no set declares — and pre-flight refused the resume on "test-authoring stories on a
# provider the registry rules out". Same rule, same source: the set's own declared providers
# (ladder-providers.js), READ and never listed; a provider this set cannot route becomes the
# set's first. Idempotent: a corrected PRD selects nothing.
_mc_enforce_providers() {
    local _prd="${1:-}" _when="${2:-}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    local _providers _bad _first _tmp
    _providers="$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/ladder-providers.js" 2>/dev/null || echo "")"
    [ -n "$_providers" ] && [ "$_providers" != "[]" ] || return 0
    _bad=$(jq -r --argjson p "$_providers" '
        [ .stories[]? | select((.aiProvider // "") != "" and ((.aiProvider) as $x | $p | index($x) | not)) | .id ]
        | join(", ")' "$_prd" 2>/dev/null || echo "")
    [ -n "$_bad" ] || return 0
    _first=$(printf '%s' "$_providers" | jq -r '.[0] // empty')
    [ -n "$_first" ] || return 0
    warning "  [prd-model-coordinator] assigned a provider this set cannot route${_when:+ ($_when)} for: ${_bad}"
    warning "    corrected to '${_first}' — the set's own declared provider"
    _tmp=$(mktemp)
    jq --argjson p "$_providers" --arg first "$_first" '
        .stories |= map(if ((.aiProvider // "") != "" and ((.aiProvider) as $x | $p | index($x) | not))
                        then .aiProvider = $first else . end)' "$_prd" > "$_tmp" 2>/dev/null \
        && mv "$_tmp" "$_prd" || rm -f "$_tmp"
}
