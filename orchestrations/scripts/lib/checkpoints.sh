#!/usr/bin/env bash
# checkpoints.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (6 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# ── GAP-P13 checkpoint helpers ──────────────────────────────────────────────
# Write a completed checkpoint entry for a story.
checkpoint_complete() {
    local story_id="$1"
    local idem_key="${ORCH_RUN_ID}:${PHASE:-main}:${story_id}"
    jq -cn \
        --arg key   "$idem_key" \
        --arg sid   "$story_id" \
        --arg phase "${PHASE:-main}" \
        --arg runId "$ORCH_RUN_ID" \
        '{idempotencyKey:$key, storyId:$sid, phase:$phase, runId:$runId,
          status:"completed", completedAt:(now|todate)}' \
        >> "$CHECKPOINT_FILE" 2>/dev/null || true
}

# Returns 0 (true) if the story already has a completed checkpoint in this run.
# Used to skip stories that finished before a crash/restart.
checkpoint_already_done() {
    local story_id="$1"
    [ ! -f "$CHECKPOINT_FILE" ] && return 1
    local idem_key="${ORCH_RUN_ID}:${PHASE:-main}:${story_id}"
    grep -q "\"idempotencyKey\":\"${idem_key}\"" "$CHECKPOINT_FILE" 2>/dev/null
}

# Clear checkpoints for this phase+run (called when RESET_STORIES=true).
checkpoint_clear() {
    rm -f "$CHECKPOINT_FILE" 2>/dev/null || true
}

# RESUME IS DECIDED BEFORE ANY WORK, NOT AFTER IT.
#
# EPAM_RESUME_RUN restores what a previous run persisted and skips exactly what that
# checkpoint already paid for — derived from the stage it was taken at, never assumed.
#
# This block used to sit past the entry-point dispatch below, and a Jira run calls
# _run_jira_pipeline and EXITS there, so on that shape it was never reached. The checkpoint was
# never restored and the skip env was computed for a branch that never ran. Every "resume" was
# therefore a fresh run: it re-ingested, re-minted, and discarded the roster the operator had
# just reviewed at the pause — which made the roster pause ceremonial, since you reviewed one
# roster and ran a different one.
#
# A resume that cannot be honoured HALTS. Continuing would silently run against whatever stale
# state happened to be on disk, which is the failure this exists to prevent.
#
# Top level only: lanes re-invoke this script and would each restore the checkpoint over their
# own state. The parent decides what to resume; the lanes inherit the result.
# resume_spec_output_present <prd_file>
# Did the spec pass leave anything behind in this PRD?
#
# A resume exports EPAM_SPEC_MODE=0 to mean "the spec pass already ran, skip it". That is a
# statement about HISTORY, and history stops being a safe proxy the moment something overwrites
# the PRD in between. Live 2026-08-10: a fresh (non-resume) launch re-ingested Jira over the
# same file, emptying fixSiteAnalysis (13->0), verificationCriteria (14->0) and the declared
# file list (13->0). The next resume skipped the spec pass exactly as instructed and handed the
# writer a story with nothing to aim at — 23 invocations, 10 watchdog kills, $11.76, no code.
#
# PRESENCE, not content: any one of the spec pass's own output fields being non-empty proves it
# ran and survived. Nothing here names a story, a file, a codeline or a project, so a PRD from
# any project passes the moment its spec pass has left something behind.
#
# Fails CLOSED — unreadable, absent or malformed all count as "not present". A guard against
# missing state must not treat "I could not tell" as "fine".
resume_spec_output_present() {
    local _prd="${1:-}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 1
    "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/resume-spec-output-present.js" "$_prd" 2>/dev/null
}

# _clear_suite_state_for_phase <prd_file> <phase>
# WHATEVER SETS THE FLAG CAN UNSET IT.
#
# Step 3.545 stamps suiteState=red when it cannot reconcile a failing test, and Step 3.55
# blocks on that flag. Nothing ever cleared it, so it was a latch: a run that recovered was
# still failed by its own history.
#
# Live, run 20260815T142007Z (metrolinx, AMSD-2041): pass 1's generated spec mocked a module
# the SDK does not use, the suite went red, and 3.545 stamped it. The retry fixed the code —
# tsc passed, external verification passed, the story completed and committed. At 16:03
# update-invalidated-tests re-checked and reported "suite already green — nothing to do",
# and seconds later Step 3.55 failed the phase on the stale flag, asserting "Step 3.545
# could not reconcile it" about a step that had just reported the opposite. The suite was
# green: 1203/1203 under the project's declared TZ.
#
# This ONLY clears. Step 3.55 is untouched, so a suite that never recovered still blocks —
# that is the behaviour the flag exists to provide.
_clear_suite_state_for_phase() {
    local _prd="${1:-}" _phase="${2:-}"
    [ -f "$_prd" ] || return 0
    local _ids
    _ids=$(jq -r --arg phase "$_phase" '(.implementationOrder[$phase] // [])[]?' "$_prd" 2>/dev/null)
    [ -n "$_ids" ] || return 0
    local _sid
    while IFS= read -r _sid; do
        [ -n "$_sid" ] || continue
        jq -e --arg id "$_sid" '.stories[] | select(.id == $id) | has("suiteState")' "$_prd" >/dev/null 2>&1 || continue
        local _tmp
        _tmp="$(mktemp)"
        # Staged through a temp file and moved: a truncated PRD is worse than a stale flag.
        if jq --arg id "$_sid" \
            '(.stories[] | select(.id == $id)) |= (del(.suiteState) | del(.suiteStateStep))' \
            "$_prd" > "$_tmp" 2>/dev/null; then
            mv "$_tmp" "$_prd"
            info "Step 3.545: suite recovered — cleared suiteState on $_sid"
        else
            rm -f "$_tmp"
        fi
    done <<< "$_ids"
    return 0
}

# ──────────────────────────────────────────────
# run_interstitial_e2e_phase <phase_id>
# Step 5.5: After phase gate passes, check for a <phase_id>_e2e phase
# in implementationOrder and run it. Blocks next phase if E2E fails.
# ──────────────────────────────────────────────
run_interstitial_e2e_phase() {
    local phase_id="$1"
    local e2e_phase="${phase_id}_e2e"

    local has_e2e_phase
    has_e2e_phase=$(jq -r --arg p "$e2e_phase" \
        'if .implementationOrder[$p] then "yes" else "no" end' \
        "$PRD_FILE" 2>/dev/null || echo "no")

    if [ "$has_e2e_phase" = "no" ]; then
        info "Step 5.5: No interstitial E2E phase for '$phase_id' — skipping"
        return 0
    fi

    log "Step 5.5: Running interstitial E2E phase '$e2e_phase'..."
    "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_start" \
        "Starting E2E phase $e2e_phase" "" "main" "qa-engineer" 2>/dev/null || true

    local e2e_log="$LOG_DIR/e2e-phase-${e2e_phase}.log"
    # PIPESTATUS[0], NOT THE `if`. Without pipefail -- and this script sets none -- `if cmd | tee`
    # tests TEE's status, which is always 0. So this phase reported PASSED unconditionally and the
    # else branch below, which fails the run, was unreachable. Same defect as the phase gate.
    bash "$0" --phase "$e2e_phase" 2>&1 | tee "$e2e_log"
    local _e2e_rc=${PIPESTATUS[0]}
    if [ "$_e2e_rc" -eq 0 ]; then
        success "Interstitial E2E phase '$e2e_phase' PASSED"
        "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_pass" \
            "E2E phase $e2e_phase passed" "" "main" "qa-engineer" 2>/dev/null || true
    else
        local e2e_exit=$_e2e_rc
        error "Interstitial E2E phase '$e2e_phase' FAILED (exit $e2e_exit)"
        error "Fix E2E failures then re-run: $0 --phase $e2e_phase"
        error "Log: $e2e_log"
        "$SCRIPT_DIR/update-monitor.sh" event "e2e_gate_fail" \
            "E2E phase $e2e_phase FAILED" "" "main" "qa-engineer" 2>/dev/null || true
        return 1
    fi
}
