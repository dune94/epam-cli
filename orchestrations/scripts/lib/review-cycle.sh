#!/usr/bin/env bash
# review-cycle.sh — Step 3.6: the team-lead review, the fix re-invocation, the re-review.
#
# EXTRACTED VERBATIM from run-agent-orchestration.sh on 2026-09-21 so the loop can be executed
# by a test. Every paid regintel failure that day sat in this loop and nowhere else: approved
# stories re-implemented on an unparsed verdict, stories reviewed on the phase's whole diff,
# a reviewer running from the pipeline's cwd, ladders spent by phantom fixes. The loop had no
# test because it was 230 lines inside a 4,000-line script. Now it is a function: the caller
# exits with what it returns (0 approved; 2 the reviewer never ran; 3 escalated — human review).
#
# Collaborators, all resolvable by a test: $SCRIPT_DIR/team-lead-review.sh (the reviewer),
# run_story_with_watchdog (the writer), the review_feedback_* partition and the story ladder
# state (lib/phase-assessment.sh, lib/story-retry-state.sh), PHASE, LOG_DIR, PRD_FILE.

run_review_cycle() {
log "Step 3.6: Running Team Lead code review for phase..."
_emit_agent start "review-agent" "Team Lead Code Review"

# The ladder-exhaustion default: same default MAX_RETRIES claude.sh itself
# uses (rung = retry_count/2, so MAX_RETRIES=7 -> 4 rungs, top rung 3).
_review_max_retries="${EPAM_MAX_RETRIES:-7}"
# SAFETY VALVE ONLY, not the primary escalation trigger. Standing requirement:
# "Retries MUST proceed up the rungs — nothing is allowed to intercede." A
# story may only be escalated once ITS OWN ladder is exhausted (checked below
# via story_ladder_exhausted), never on a bare cycle count. This cap exists
# purely so a misconfigured or never-settling reviewer cannot loop forever;
# set comfortably above the ladder's own depth so it should not fire in
# normal operation — if it does, that itself is a signal worth investigating,
# logged as such below rather than silently treated as ordinary exhaustion.
# DERIVED from the ladder's real depth, never a magic number. The ladder is
# 2 attempts per rung (rung = retry_count/2), so it has (MAX_RETRIES/2)+1 rungs;
# a review cycle can advance at most one rung, and +2 leaves headroom for the
# cycles that re-run the REVIEWER rather than the writer (review_feedback_is_
# incomplete). Ladder exhaustion is what actually stops the loop — this only
# has to be large enough never to fire first. An explicit REVIEW_MAX_CYCLES
# still wins for an operator who wants a hard ceiling.
_review_max_cycles="${REVIEW_MAX_CYCLES:-$(( _review_max_retries / 2 + 3 ))}"
_review_cycle=1
# Direct escalation flag. The hard-block below USED to rely solely on stories
# being tagged reviewStatus=escalated by iterating review-feedback-*.json files —
# but when the reviewer produced NO such files (found live 2026-07-24, AMSD-1820:
# review escalated after 2 cycles yet 0 feedback files existed), nothing got
# tagged, the jq count was 0, and a change the reviewer NEVER approved fell
# through to PASSED. The loop itself knows it escalated; block on that fact
# directly, independent of any file the reviewer may or may not have written.
_review_escalated=0




while true; do
    _review_fp_now="$(_review_tree_fingerprint)"
    # Guarded so an unloaded library is skipped rather than fatal: an undefined function
    # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
    # harness runs this code with the gate library absent. The orchestrator sources it at the
    # top, and pre-flight is what actually gates a run.
    declare -f require_stage_coverage >/dev/null && { require_stage_coverage gates || return 1; }
    if "$SCRIPT_DIR/team-lead-review.sh" "$PHASE"; then
        if _review_approval_is_giveup "${_review_prev_blocker:-0}" "${_review_prev_fp:-}" "$_review_fp_now"; then
            error "Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED since that rejection."
            error "Step 3.6: the verdict changed and the code did not — the blocker was never resolved. Escalating instead of approving."
            _emit_agent complete "review-agent" "Code review escalated (approval after unresolved blocker)"
            # NO REMEDY IS CLAIMED HERE. This called `_escalate_story_review`, which is defined
            # nowhere in the engine, wrapped in `|| true` so its absence could not even fail the
            # line. Live 2026-08-20: "Escalating instead of approving." followed immediately by
            # "_escalate_story_review: command not found", and the story carried on. The array it
            # iterated is not assigned until further below, so on this path it was empty anyway.
            #
            # The REFUSAL below is what actually took effect and is what matters: the loop exits
            # without recording the approval. Announcing an action the engine cannot take is worse
            # than announcing none — an operator reads the log and believes it was handled.
            #
            # The flip-flop this tried to compensate for is now prevented at its source: the
            # reviewer receives its own prior verdicts and is told an unresolved blocker still
            # stands (1f24c70).
            break
        fi
        success "Team Lead code review APPROVED for phase '$PHASE' (cycle $_review_cycle)"
        # Clear a reviewStatus:"escalated" tag left by an EARLIER cycle of
        # this same phase-retry sequence — found live 2026-08-02 (Writer
        # Retest run): a phase-level retry (after an unrelated later gate
        # failure) re-ran Step 3.6 from scratch; its first pass escalated
        # after 2 cycles (tagging reviewStatus:escalated), a LATER retry's
        # review then genuinely APPROVED the same story, but the hard-block
        # check below still found the stale tag from the earlier escalation
        # and blocked a change the reviewer HAD approved. Nothing ever
        # cleared it on a subsequent real approval — scoped to this phase's
        # own story IDs, same scoping the hard-block check itself uses.
        _tmp_prd_clear="$(mktemp)"; jq --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories |= map(if (.id as $id | $ids | index($id) != null) and .reviewStatus == "escalated"
                              then . + {reviewStatus: null} else . end)' \
            "$PRD_FILE" > "$_tmp_prd_clear" 2>/dev/null && mv "$_tmp_prd_clear" "$PRD_FILE" || rm -f "$_tmp_prd_clear"
        _emit_agent complete "review-agent" "Code review approved"
        break
    fi
    # changes_requested — team-lead-review.sh wrote review-feedback-<id>.json per story.
    # B24 — is this "the code needs changing" or "the REVIEWER failed"?
    # (predicate: review_feedback_is_incomplete, defined near the top)
    # team-lead-review.sh fails SAFE when its agent produces no verdict: it emits a
    # synthetic changes_requested so an unreviewed change can never auto-approve.
    # But that verdict is PHASE-level, so no per-story review-feedback-<id>.json
    # exists — and the loop below then "re-implements" nothing at all. Live
    # 2026-07-24: two entirely empty cycles, then escalation with tagged-stories=0,
    # on a story whose fix AND verified reproducing test had passed every gate.
    # Re-implementing is the wrong response when the story was never the problem.
    if review_feedback_is_incomplete; then
        rm -f "$LOG_DIR/review-incomplete-${PHASE}.flag" 2>/dev/null || true

        # BOUNDED. This branch used to `continue` straight past the safety valve below, so it
        # was the ONE exit from `while true` with no ceiling on it. Live 2026-08-12: the
        # reviewer died on a bash runtime error (`local` at top level, 2bb230e) and this ran
        # 701 CYCLES on a story that had already implemented cleanly — 18 minutes, and it
        # would have continued to the story wall.
        #
        # Retrying a missing verdict is right ONCE OR TWICE (a model can return junk once) and
        # wrong forever after: a reviewer that cannot execute produces no verdict every time,
        # and no number of retries changes that. The loop cannot tell those apart, which is
        # exactly why it must be bounded rather than trusting.
        #
        # Reuses _review_max_cycles — the bound that already exists and already means "how many
        # times may this loop go round". A second counter would be a second thing to maintain.
        _review_noverdict_cycles=$(( ${_review_noverdict_cycles:-0} + 1 ))
        if [ "$_review_noverdict_cycles" -ge "$_review_max_cycles" ]; then
            error "Step 3.6: the REVIEWER produced NO VERDICT ${_review_noverdict_cycles} time(s) in a row (limit ${_review_max_cycles}) — it is not failing to approve, it is failing to RUN."
            error "         Nothing was reviewed. The change is NOT approved and this phase must not proceed."
            error "         Check the reviewer itself before re-running: bash -n does not catch a runtime error; try"
            error "           shellcheck -S error orchestrations/scripts/team-lead-review.sh"
            error "         and read the reviewer's own stderr in $LOG_DIR."
            return 2
        fi
        warning "Step 3.6: the REVIEWER did not produce a verdict (no per-story feedback) — re-running the REVIEW, not re-implementing (cycle $_review_cycle → $((_review_cycle + 1)), no-verdict ${_review_noverdict_cycles}/${_review_max_cycles})"
        _review_cycle=$((_review_cycle + 1))
        continue
    fi
    # A verdict arrived: the reviewer is alive. Reset the streak so an earlier transient miss
    # cannot accumulate across a healthy run and trip the limit later.
    _review_noverdict_cycles=0
    # Partition rejected stories: a story whose ladder is ALREADY exhausted
    # (its persisted rung has reached the top — see lib/story-retry-state.sh)
    # has nothing left to try and escalates now, regardless of cycle count. A
    # story that can still climb is re-implemented. Standing requirement:
    # "Retries MUST proceed up the rungs — nothing is allowed to intercede" —
    # a fixed cycle cap must never cut a climbable story off early.
    _review_climbable_stories=()
    # ONLY A STORY WITH A REAL VERDICT IS RE-IMPLEMENTED OR ESCALATED. A story whose review was never
    # parsed (reviewIncomplete) is left for the next cycle's review to judge — see
    # review_feedback_to_reimplement in lib/phase-assessment.sh (regintel 140717Z, 2026-09-21).
    for _fb_story in $(review_feedback_to_reimplement); do
        _fb="$LOG_DIR/review-feedback-${_fb_story}.json"
        [ -f "$_fb" ] || continue
        if story_ladder_exhausted "$LOG_DIR" "$_fb_story" "$_review_max_retries"; then
            warning "Step 3.6: $_fb_story's ladder is exhausted (already tried its top rung) — escalating"
            _review_escalated=1
            _escalate_review_story "$_fb" "$_fb_story"
        else
            _review_climbable_stories+=("$_fb_story:$_fb")
        fi
    done

    if [ "${#_review_climbable_stories[@]}" -eq 0 ]; then
        # Every rejected story has exhausted its ladder — nothing left to retry.
        _emit_agent complete "review-agent" "Code review escalated (every rejected story's ladder is exhausted)"
        break
    fi

    if [ "$_review_cycle" -ge "$_review_max_cycles" ]; then
        # Safety valve. Should not fire in normal operation — ladder
        # exhaustion above bounds this first at 4 rungs (default
        # MAX_RETRIES=7). If it does fire, that itself means the ladder-
        # exhaustion accounting is out of sync with reality; log loudly
        # rather than silently treating it as ordinary exhaustion.
        warning "Step 3.6: hit the ${_review_max_cycles}-cycle SAFETY VALVE with ${#_review_climbable_stories[@]} stor(y/ies) still not ladder-exhausted — escalating anyway. This should not happen; investigate the ladder-exhaustion accounting."
        _review_escalated=1
        for _entry in "${_review_climbable_stories[@]}"; do
            _fb_story="${_entry%%:*}"; _fb="${_entry#*:}"
            _escalate_review_story "$_fb" "$_fb_story"
        done
        _emit_agent complete "review-agent" "Code review escalated (safety-valve cycle cap)"
        break
    fi

    # Remember whether THIS rejection carried a blocker, and what the tree looked like, so the
    # next cycle's approval can be checked against it.
    _review_prev_blocker=0
    for _fbf in "${LOG_DIR}"/review-feedback-*.json; do
        [ -f "$_fbf" ] || continue
        if jq -e '[.issues // [] | .[] | select((.severity // "") == "blocker")] | length > 0' "$_fbf" >/dev/null 2>&1; then
            _review_prev_blocker=1; break
        fi
    done
    _review_prev_fp="$_review_fp_now"
    warning "Step 3.6: review requested changes — re-implementing (cycle $_review_cycle → $((_review_cycle + 1)))"
    for _entry in "${_review_climbable_stories[@]}"; do
        _fb_story="${_entry%%:*}"
        # A review rejection is itself evidence this attempt did not succeed,
        # even when the code built/tested fine internally — advance the
        # story's persisted rung BEFORE re-invoking, or the next claude.sh
        # subprocess (run_story_with_watchdog spawns a fresh one) silently
        # resumes at the SAME rung, and the ladder never climbs on a
        # review-rejection-only failure. This is the exact live bug fixed
        # this session: two review cycles both logged Rung0/R1.
        advance_story_retry_rung "$LOG_DIR" "$_fb_story" "$_review_max_retries"
        # Without this reset, the retry below is a guaranteed no-op. Step 8 marks a
        # story `completed` the moment the agent's turn ends — regardless of
        # whether the reviewer will accept it — and run_story_with_watchdog
        # invokes claude.sh "$story_id", whose FIRST check is
        # is_story_completed. Live AMSD-2041 2026-07-30: the reviewer rejected
        # with 7 blockers, this loop logged "Re-implementing... (self-heal
        # enabled)", and within the same second: "Story AMSD-2041 is already
        # completed, skipping" / "Implemented: 0, Failed: 0, Skipped: 1" — zero
        # new code, zero new review evidence, one of REVIEW_MAX_CYCLES's two
        # cycles wasted on every rejection. Scoped to exactly this ONE story:
        # a sibling that already passed review must not be re-run.
        _reset_story_for_reimplementation "$_fb_story"
        log "  Re-implementing $_fb_story to address reviewer feedback (self-heal enabled)..."
        # claude.sh reads review-feedback-<id>.json (injects it into the impl
        # prompt) and its existing failure-analyst self-heal + agent-KB run on any
        # test failure during the re-implementation.
        # NOT `|| true`. This is the one attempt to address a rejection the reviewer already
        # made; discarding its exit status meant the re-implementation could fail outright and
        # the loop moved on as though it had run, burning a review cycle on unchanged code with
        # nothing in the log to say why.
        _rr_rc=0
        run_story_with_watchdog "$_fb_story" "$LOG_DIR/main-${_fb_story}-rereview${_review_cycle}.log" || _rr_rc=$?
        if [ "$_rr_rc" -ne 0 ]; then
            warning "  Re-implementation of $_fb_story FAILED (exit ${_rr_rc}) — the reviewer's feedback was not addressed this cycle; see $LOG_DIR/main-${_fb_story}-rereview${_review_cycle}.log"
        fi
    done
    _review_cycle=$((_review_cycle + 1))
done

# Hard-block if any story was escalated (review loop exhausted without approval).
_escalated=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id) != null) |
      select(.reviewStatus == "escalated")] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0")
if [ "${_review_escalated:-0}" -eq 1 ] || [ "${_escalated:-0}" -gt 0 ]; then
    error "Step 3.6: review changes unresolved after $_review_cycle cycle(s), ladder exhausted (escalated: flag=${_review_escalated:-0} tagged-stories=${_escalated:-0})"
    error "         A change the reviewer never approved must NOT proceed — human review required."
    # EXIT 3, NOT 2. This is a HALT, not a remediation. Every caller used to read 2 as
    # "a fix was applied, retry" and re-ran the phase — which hard-reset the branch,
    # orphaned the already-green committed work, and burned 12 attempts against a
    # ladder with nothing left to escalate to (live, 20260814T213253Z). The retryable
    # /not-retryable distinction is defined once in lib/phase-exit.sh.
    return 3
fi
    return 0
}
