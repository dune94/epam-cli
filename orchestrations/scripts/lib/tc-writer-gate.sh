#!/usr/bin/env bash
# run_inline_tc_writer_gate <story_id> <phase>
#
# Single source of truth for the inline TC (test criteria) writer gate, run
# right before a pure-test story (ALL its technicalNotes.files end in
# ".test.ts") that still has zero testCriteria.facts begins execution.
#
# Root cause this fixes (found live, 2026-07-14, tier3-travel-app run): this
# gate used to live ONLY in run-agent-orchestration.sh's Step 1 main-branch
# loop. Step 3a/3b worktree lanes ("primary"/"independent") never pass
# through that loop at all — they run inside claude.sh's own
# run_implementation() loop instead, as a background subprocess launched by
# Step 3a/3b. The only other TC mechanism, the batch Step 1.6 gate, runs
# AFTER Step 3.2 (worktree merge) — i.e. after worktree-lane stories have
# ALREADY finished executing. Net effect: any pure-test story assigned to a
# worktree lane ran its entire first execution with testCriteria.facts=[],
# writing tests with zero verified grounding — confirmed live on
# SKY-003-test (lane "primary"). Per explicit instruction ("all lanes must
# have the same flow no deviations"), this function is now the ONE inline
# gate implementation, sourced by both run-agent-orchestration.sh (Step 1,
# main lane) and claude.sh (run_implementation(), primary/independent
# worktree lanes) so every lane runs the identical check/retry/block
# sequence in the same dependency-respecting position: immediately before
# the story itself executes, not before or after the whole batch.
#
# Requires from the caller's environment: PRD_FILE, LOG_DIR, SCRIPT_DIR,
# PROJECT_ROOT (or OUTPUT_DIR), and the log/warning/success/error helpers —
# all already defined identically in both sourcing scripts.
#
# Returns 0 if the story is clear to proceed (either didn't need TCs, or the
# writer succeeded within 3 attempts). Returns 1 if the story was BLOCKED
# (no valid testCriteria after 3 attempts) — the caller must skip running
# this story's implementation when this returns 1.
run_inline_tc_writer_gate() {
    local story_id="$1"
    local phase="$2"

    local _needs_tc
    _needs_tc=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | select(.status != "deprecated") |
         select((.technicalNotes.files // []) as $f |
                ($f | length > 0) and ($f | map(endswith(".test.ts")) | all)) |
         select((.testCriteria.facts // []) | length == 0) | .id' \
        "$PRD_FILE" 2>/dev/null || echo "")
    [ -z "$_needs_tc" ] && return 0

    local _tc_gate_attempt=0
    local _tc_gate_facts_len=0
    local _tc_gate_exit=0
    "$SCRIPT_DIR/update-monitor.sh" story_start "$story_id" "main" "tc-writer-agent" "TC Writer: $story_id" \
        "${ORCH_GATE_PROVIDER:-}" "${ORCH_GATE_MODEL:-MiniMax-M3}" 2>/dev/null || true
    # B23 — self-heal + MEDIUM-ladder escalation.
    # This loop already retried 3x, but every attempt used the SAME model with the
    # SAME prompt: no escalation, no corrective guidance. That is the pattern that
    # wasted attempts on the detective (max_iterations x3) and the repro-test-writer
    # until each got a ladder plus agent-attempt-analyst.sh.
    #
    # MEDIUM, deliberately not HIGH: the TC writer turns ACs/VCs into test-criteria
    # FACTS — structured restatement, not causal reasoning. It is closer to the VC
    # producer (pinned to temp 0 / low effort precisely because high reasoning caused
    # prescriptive drift) than to the detective. The HIGH ladder tops out at kimi-k3;
    # paying the ceiling rung for restatement buys nothing and may buy WORSE output.
    local _tc_base_model="${ORCH_GATE_MODEL:-MiniMax-M3}"
    local _tc_model="$_tc_base_model"
    local _tc_corrective=""
    local _tc_writer_log="$LOG_DIR/tc-writer-${story_id}.log"

    # Next rung on the MEDIUM ladder ("A=B|C=D"). Empty when already at the top.
    _tc_ladder_next_model() {
        local _cur="$1" _pair _from _to
        IFS='|' read -ra _pairs <<< "${EPAM_MODEL_LADDER_MEDIUM:-}"
        for _pair in "${_pairs[@]}"; do
            _from="${_pair%%=*}"; _to="${_pair#*=}"
            [ "$_from" = "$_cur" ] && { echo "$_to"; return 0; }
        done
        echo ""
    }

    for _tc_gate_attempt in 1 2 3; do
        # Rung change on attempts 2 and 3 (the pipeline's ladder convention is 2
        # tries per model, but this gate is bounded at 3 attempts total).
        if [ "$_tc_gate_attempt" -gt 1 ]; then
            local _tc_next; _tc_next="$(_tc_ladder_next_model "$_tc_model")"
            if [ -n "$_tc_next" ]; then
                log "  [tc-writer] ladder escalation (attempt ${_tc_gate_attempt}/3) — ${_tc_model} → ${_tc_next}"
                _tc_model="$_tc_next"
            fi
        fi
        log "  Story $story_id needs testCriteria — running TC writer inline before it starts... (attempt ${_tc_gate_attempt}/3, model ${_tc_model})"
        TC_WRITER_CORRECTIVE="$_tc_corrective" ORCH_GATE_MODEL="$_tc_model" AI_MODEL="$_tc_model" \
        bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
            --prd "$PRD_FILE" \
            --phase "$phase" \
            --output-dir "${OUTPUT_DIR:-$PROJECT_ROOT}" \
            --story "$story_id" \
            2>&1 | tee -a "$LOG_DIR/tc-writer-${phase}.log"
        _tc_gate_exit=${PIPESTATUS[0]}

        _tc_gate_facts_len=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | (.testCriteria.facts // []) | length' \
            "$PRD_FILE" 2>/dev/null || echo 0)

        if [ "$_tc_gate_exit" -eq 0 ] && [ "${_tc_gate_facts_len:-0}" -gt 0 ]; then
            success "  TC writer populated testCriteria for $story_id (attempt ${_tc_gate_attempt}/3)"
            # Priority order (2026-07-15, see each function's own docstring
            # for the live incident each addresses):
            #   1. TC-fact-density split mandate — facts alone so extreme
            #      that ONE test file can't reasonably hold them; split into
            #      multiple test stories instead of trying harder models.
            #   2. VERY HIGH complexity — facts+bannedPatterns combined
            #      density extreme enough to warrant the ceiling model
            #      directly (skip the normal rung-by-rung ladder climb),
            #      without necessarily needing a file split.
            #   3. The existing mild density-based model upgrade (unchanged).
            # Split takes priority since it's the more fundamentally correct
            # fix when facts alone are extreme (a smaller file is easier for
            # ANY model, including the ceiling one); very-high only applies
            # when a split either didn't happen or wasn't warranted.
            if _tc_writer_gate_maybe_split_test_story "$story_id" "$phase" "${_tc_gate_facts_len:-0}"; then
                _tc_writer_gate_log_retry "$(jq -n -c \
                    --arg step "tc-writer-inline" \
                    --arg storyId "$story_id" \
                    --argjson attempts "$_tc_gate_attempt" \
                    --arg outcome "split" \
                    --argjson violationTypes '["tc_fact_density_split"]' \
                    '{timestamp: (now | todate), step: $step, storyId: $storyId, attempts: $attempts, outcome: $outcome, violationTypes: $violationTypes}' \
                    2>/dev/null)"
                return 1
            fi
            _tc_writer_gate_maybe_mark_very_high_complexity "$story_id" "${_tc_gate_facts_len:-0}"
            _tc_writer_gate_maybe_upgrade_model "$story_id" "${_tc_gate_facts_len:-0}"
            break
        fi
        warning "  Inline TC writer attempt ${_tc_gate_attempt}/3 for $story_id produced no valid testCriteria (exit=${_tc_gate_exit}, facts=${_tc_gate_facts_len:-0})"

        # ── self-heal: classify WHY the attempt failed and prepend a tailored
        # corrective to the next one, instead of re-running an identical prompt.
        # Reuses agent-attempt-analyst.sh (the same crown-jewel analyst the
        # test-writer uses); it skips provider/infra failures on its own.
        if [ "$_tc_gate_attempt" -lt 3 ]; then
            _tc_fclass="no_json"
            grep -qiE "reached maximum iterations" "$_tc_writer_log" 2>/dev/null && _tc_fclass="max_iterations"
            grep -qiE "ai-run failed|no error output" "$_tc_writer_log" 2>/dev/null && _tc_fclass="provider"
            [ "${_tc_gate_facts_len:-0}" -eq 0 ] && [ "$_tc_gate_exit" -eq 0 ] && _tc_fclass="no_json"
            log "  [tc-writer] attempt ${_tc_gate_attempt} failed (class=${_tc_fclass}) — invoking self-heal analyst"
            _tc_corrective="$(AGENT_ANALYST_STORY_ID="$story_id" \
                bash "$SCRIPT_DIR/../agent-attempt-analyst.sh" "$_tc_fclass" "$_tc_writer_log" 2>/dev/null || echo "")"
        fi
    done

    local _tc_gate_violation_types="[]"
    if [ "${_tc_gate_facts_len:-0}" -eq 0 ]; then
        if [ "${_tc_gate_exit:-0}" -ne 0 ]; then
            _tc_gate_violation_types='["writer_exit_nonzero","empty_facts"]'
        else
            _tc_gate_violation_types='["empty_facts"]'
        fi
    fi

    _tc_writer_gate_log_retry "$(jq -n -c \
        --arg step "tc-writer-inline" \
        --arg storyId "$story_id" \
        --argjson attempts "$_tc_gate_attempt" \
        --arg outcome "$([ "${_tc_gate_facts_len:-0}" -gt 0 ] && echo pass || echo blocked)" \
        --argjson violationTypes "$_tc_gate_violation_types" \
        '{timestamp: (now | todate), step: $step, storyId: $storyId, attempts: $attempts, outcome: $outcome, violationTypes: $violationTypes}' \
        2>/dev/null)"

    if [ "${_tc_gate_facts_len:-0}" -eq 0 ]; then
        error "  Inline TC writer gate: $story_id still has no testCriteria.facts after 3 attempts — BLOCKING this story (not aborting the phase)"
        error "  Check: $LOG_DIR/tc-writer-${phase}.log ; confirm $story_id is in implementationOrder.$phase"
        "$SCRIPT_DIR/update-monitor.sh" story_fail "tc-writer-agent" "main" "no testCriteria after 3 attempts: $story_id" 2>/dev/null || true
        local _tc_gate_tmp
        _tc_gate_tmp=$(mktemp)
        chmod 644 "$_tc_gate_tmp" 2>/dev/null
        jq --arg id "$story_id" '(.stories[] | select(.id == $id)).status = "blocked"' \
            "$PRD_FILE" > "$_tc_gate_tmp" && mv "$_tc_gate_tmp" "$PRD_FILE"
        jq -n -c --arg storyId "$story_id" --arg reason "no valid testCriteria after 3 attempts" \
            '{timestamp: (now | todate), storyId: $storyId, reason: $reason}' \
            >> "$LOG_DIR/blocked-stories.jsonl" 2>/dev/null || true
        return 1
    fi
    # Emit cost_snapshot with model info (cost not tracked since post-impl-tc-writer
    # uses `epam run` directly without ORCH_JSON_RESULT support)
    local _tc_phase
    _tc_phase=$(jq -r '.phase // empty' "${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}" 2>/dev/null || true)
    jq -cn \
        --arg ts "$(date -Iseconds)" \
        --arg story "$story_id" \
        --arg phase "${_tc_phase:-}" \
        --arg model "${TC_WRITER_MODEL:-moonshotai/kimi-k2}" \
        --arg provider "${TC_WRITER_PROVIDER:-qwen}" \
        '{
          event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
          timestamp: $ts,
          agent: "tc-writer-agent",
          story_id: (if $story == "" then null else $story end),
          phase: (if $phase == "" then null else $phase end),
          type: "cost_snapshot",
          model: $model,
          provider: $provider,
          detail: {costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0, source: "tc-writer-gate"}
        }' >> "${ACTIVITY_FILE:-$SCRIPT_DIR/../logs/agent-activity.jsonl}" 2>/dev/null || true
    "$SCRIPT_DIR/update-monitor.sh" story_complete "$story_id" "main" "TC writer done: $story_id" 2>/dev/null || true
    return 0
}

# _tc_writer_gate_maybe_split_test_story <story_id> <phase> <facts_count>
#
# TC-fact-density split mandate (found live, 2026-07-14, tier3-travel-app
# run — SKY-003-test): a pure test story's REAL generation load comes from
# testCriteria.facts, not acceptanceCriteria — the existing AC-count split
# mandate (spec-mode-runner.js's storyRequiresSplit/checkSplitMandateViolation,
# checked at spec-pass time, before facts exist) structurally cannot see
# this. SKY-003-test had 8 ACs (well under that mandate) but 20 facts + 19
# bannedPatterns in ONE test file — every model at every escalation rung, up
# to the ceiling, produced widespread syntax corruption on it, 8/8 attempts.
# This checks the ONLY point facts density is actually known — right after
# the TC writer just populated them, before the story's own implementation
# begins — and if facts alone exceed EPAM_TC_FACTS_SPLIT_THRESHOLD (default
# 30), delegates the mechanical (no-LLM-judgment-needed, since each fact is
# already an atomic, independent assertion) partition to
# spec-mode-runner.js's splitTestStoryByFacts().
#
# Returns 0 if a split happened (caller must skip this story — it's now
# deprecated; its children are pending for the NEXT phase-level pass, same
# "not injected into the in-flight loop" convention already used for
# Step 0.5-created mid-execution splits elsewhere in this pipeline). Returns
# 1 if no split was needed/eligible (caller proceeds normally).
_tc_writer_gate_maybe_split_test_story() {
    local story_id="$1"
    local phase="$2"
    local tc_facts_count="${3:-0}"
    local threshold="${EPAM_TC_FACTS_SPLIT_THRESHOLD:-30}"

    [ "$tc_facts_count" -le "$threshold" ] && return 1

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"
    local _split_runner="$SCRIPT_DIR/spec-mode-runner.js"
    [ ! -f "$_split_runner" ] && return 1

    warning "  [tc-fact-density-split] $story_id: ${tc_facts_count} TC facts exceeds split threshold ($threshold) on a single test file — splitting into multiple test stories"
    if EPAM_TC_FACTS_SPLIT_THRESHOLD="$threshold" PHASE="$phase" \
        "$_node_cmd" "$_split_runner" --split-test-story "$PRD_FILE" "$story_id" \
        2>&1 | tee -a "$LOG_DIR/tc-writer-${phase}.log"; then
        success "  [tc-fact-density-split] $story_id split successfully — children pending for next pass"
        return 0
    fi
    warning "  [tc-fact-density-split] $story_id split attempt failed — proceeding with the story as-is"
    return 1
}

# _tc_writer_gate_maybe_mark_very_high_complexity <story_id> <facts_count>
#
# VERY HIGH complexity (2026-07-15, user directive): for stories whose
# combined testCriteria density (facts + bannedPatterns) is extreme enough
# to warrant it, assign "the most appropriate high model" DIRECTLY and mark
# skipLadder=true so claude.sh's InferenceLadder does not spend several
# guaranteed-failing attempts climbing rung-by-rung (mini -> mid -> high)
# before ever reaching a model with a real chance — reusing the SAME
# signal + intent as spec-mode-runner.js's modelComplexitySignals()
# veryHighComplexity classification (AC-count based, checked at spec-pass
# time for non-test stories), applied here at the point TC-fact density is
# actually known for test stories specifically. This is deliberately an
# ALTERNATIVE to splitting (see _tc_writer_gate_maybe_split_test_story
# above, which always runs first) — some stories are extreme enough to need
# the ceiling model but don't need or benefit from a file split.
_tc_writer_gate_maybe_mark_very_high_complexity() {
    local story_id="$1"
    local tc_facts_count="${2:-0}"
    local prd_target="${PRD_FILE:-$PROJECT_ROOT/prd.json}"
    local threshold="${EPAM_TC_VERY_HIGH_CONSTRAINTS_THRESHOLD:-30}"

    local banned_count
    banned_count=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.testCriteria.bannedPatterns // []) | length' \
        "$prd_target" 2>/dev/null || echo 0)
    local combined=$(( tc_facts_count + ${banned_count:-0} ))
    [ "$combined" -le "$threshold" ] && return 0

    local ceiling_model="${EPAM_VERY_HIGH_COMPLEXITY_MODEL:-${EPAM_FINAL_FALLBACK_MODEL:-}}"
    [ -z "$ceiling_model" ] && return 0

    local current_model
    current_model=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null || echo "")
    [ -z "$current_model" ] && return 0

    local new_provider="${EPAM_VERY_HIGH_COMPLEXITY_PROVIDER:-${EPAM_FINAL_FALLBACK_PROVIDER:-}}"
    if [ -z "$new_provider" ] && [ -n "${EPAM_MODEL_PROVIDER_MAP:-}" ]; then
        local pair from to ifs_save="$IFS"
        IFS='|'
        read -ra pairs <<< "$EPAM_MODEL_PROVIDER_MAP"
        IFS="$ifs_save"
        for pair in "${pairs[@]}"; do
            from="${pair%%=*}"
            to="${pair#*=}"
            # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
            case "$ceiling_model" in
                $from) new_provider="$to"; break ;;
            esac
        done
    fi

    local tmp_prd
    tmp_prd=$(mktemp)
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq --arg id "$story_id" --arg m "$ceiling_model" --arg p "$new_provider" \
          --arg reason "tc-facts=${tc_facts_count} + bannedPatterns=${banned_count:-0} = ${combined} exceeds very-high threshold=${threshold}" \
          --arg ts "$(date -Iseconds)" --arg from_model "$current_model" \
          '(.stories[] | select(.id == $id)) |= (
               .model = $m
               | .aiProvider = (if $p == "" then .aiProvider else $p end)
               | .skipLadder = true
               | .specification.veryHighComplexity = {from: $from_model, to: $m, reason: $reason, markedAt: $ts}
           )' \
          "$prd_target" > "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$prd_target"
        warning "  [very-high-complexity] $story_id: ${tc_facts_count} facts + ${banned_count:-0} bannedPatterns exceeds threshold ($threshold) — assigning ceiling model $current_model -> $ceiling_model${new_provider:+ (provider -> $new_provider)}, skipLadder=true"
    else
        rm -f "$tmp_prd"
    fi
}

# Standalone model-density upgrade + retry-history logger so this lib has no
# dependency on either sourcing script's own same-named helpers (which only
# exist in run-agent-orchestration.sh) — keeps this file sourceable as-is
# from both run-agent-orchestration.sh (main lane) and claude.sh (worktree
# lanes) with identical behavior in either context.
_tc_writer_gate_maybe_upgrade_model() {
    local story_id="$1"
    local tc_facts_count="${2:-0}"
    local prd_target="${PRD_FILE:-$PROJECT_ROOT/prd.json}"
    local threshold="${EPAM_TC_FACTS_UPGRADE_THRESHOLD:-15}"

    [ -z "${ORCH_UPGRADE_MODEL:-}" ] && return 0
    [ "$tc_facts_count" -le "$threshold" ] && return 0

    # Skip if very-high-complexity already fired (skipLadder=true means we're at
    # the ceiling model — ORCH_UPGRADE_MODEL is a mid-tier step and would downgrade it)
    local _skip_ladder
    _skip_ladder=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .skipLadder // false' "$prd_target" 2>/dev/null || echo "false")
    [ "$_skip_ladder" = "true" ] && return 0

    local current_model
    current_model=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .model // ""' "$prd_target" 2>/dev/null || echo "")
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
    fi
}

_tc_writer_gate_log_retry() {
    local json_line="$1"
    [ -z "$json_line" ] && return 0
    local _promptver
    _promptver=$(git -C "$SCRIPT_DIR/.." rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local augmented
    augmented=$(echo "$json_line" | jq -c --arg runId "${ORCH_RUN_ID:-unknown}" --arg pv "$_promptver" \
        '. + {runId: $runId, promptVersion: $pv}' 2>/dev/null || echo "")
    [ -z "$augmented" ] && augmented="$json_line"
    echo "$augmented" >> "$LOG_DIR/guarded-step-retries.jsonl" 2>/dev/null || true
    mkdir -p "$SCRIPT_DIR/../logs" 2>/dev/null || true
    echo "$augmented" >> "$SCRIPT_DIR/../logs/guarded-step-retries-history.jsonl" 2>/dev/null || true
}
