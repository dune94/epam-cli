#!/usr/bin/env bash
# WHAT A PHASE'S EXIT CODE MEANS — DEFINED ONCE.
#
# run-agent-orchestration.sh exits non-zero for two completely different reasons, and
# until 2026-08-14 both were exit 2:
#
#   REMEDIATED  a gate applied a fix; re-running the phase is expected to now pass.
#   HALT        a change the reviewer never approved, at an EXHAUSTED ladder.
#               Re-running cannot help — there is no higher rung to try.
#
# SEVEN separate call sites each wrote `if [ "$phase_exit" -eq 2 ]; then ...retry...`
# — run-agent-orchestration.sh (twice), orchestrate.sh, and four tier3 launchers
# (metrolinx, mock, skyscanner, travel-app) — so a HALT was retried by all of them.
# The first sweep for this found only three; the class was wider than the sites that
# happened to be open at the time, which is exactly why the comparison lives here now
# and not at any call site.
#
# WHAT THAT COST, live run 20260814T213253Z (metrolinx, AMSD-2041): Step 3.6 correctly
# printed "A change the reviewer never approved must NOT proceed — human review
# required" and exited. The caller read 2, called it remediation, and retried. The
# retry re-entered ensure_story_branch, which hard-reset the branch and orphaned the
# already-committed, already-green work; it then burned 12 further attempts against a
# ladder that had nothing left to escalate to, and failed. The pipeline spent ~15
# minutes and real money to arrive where Step 3.6 already was.
#
# The distinction is the whole point, so it lives in ONE place. A caller asks
# `phase_exit_is_retryable`; no caller compares a bare integer.

# Exit code vocabulary. Values are the contract with run-agent-orchestration.sh.
PHASE_EXIT_OK=0
PHASE_EXIT_REMEDIATED=2
PHASE_EXIT_HALT_REVIEW=3
PHASE_EXIT_TESTS_STRENGTHENED=4

# THE CODE WAS RIGHT; ITS TESTS WERE NOT (AMSD-2974 live L2, 2026-10-14). A gate finding that only tests can
# resolve — a surviving mutant in correct code — went to the AC remediator and back to the CODE writer, who is
# forbidden to touch tests, and looped. Such a finding now goes to the test-writer, which commits the
# strengthened test; the phase is re-run on that commit WITHOUT --reset, so the stories keep their approved
# work, Step 1 passes them as completed, and the review and the gates judge the new commit.

# phase_exit_is_retryable <code>
# True (0) ONLY for the code that means "a fix was applied, try again". Everything else
# — success, halt, and any unrecognised code — is not retryable. An unknown code is
# deliberately NOT retried: re-running an outcome nobody has classified is how a HALT
# came to be retried in the first place.
phase_exit_is_retryable() {
    [ "${1:-}" = "$PHASE_EXIT_REMEDIATED" ] || [ "${1:-}" = "$PHASE_EXIT_TESTS_STRENGTHENED" ]
}

# phase_exit_retry_args <code> — the arguments a retry of this outcome re-runs the phase with, one per line.
# REMEDIATED changed what the stories must do, so they are reset and re-written; TESTS_STRENGTHENED changed only
# the tests, so the stories keep their work and the phase re-judges it.
phase_exit_retry_args() {
    case "${1:-}" in
        "$PHASE_EXIT_REMEDIATED") printf '%s\n' '--reset' ;;
        *) ;;
    esac
}

# phase_exit_describe <code>
# One line naming the outcome, so a failure reads as a decision rather than a number.
phase_exit_describe() {
    case "${1:-}" in
        "$PHASE_EXIT_OK")          echo "completed" ;;
        "$PHASE_EXIT_REMEDIATED")  echo "gate remediation applied — a retry is expected to help" ;;
        "$PHASE_EXIT_TESTS_STRENGTHENED") echo "the test-writer strengthened the tests a gate found insufficient — the gates re-run on that commit" ;;
        "$PHASE_EXIT_HALT_REVIEW") echo "HALT: the reviewer never approved the change and the ladder is exhausted — human review required, a retry cannot help" ;;
        *)                         echo "failed (exit ${1:-?})" ;;
    esac
}

# phase_retry_mark <codeline-root> — what the codeline holds before a self-heal retry (its commit), for
# phase_retry_progressed. Empty when the root is not a repository.
phase_retry_mark() {
    git -C "${1:-.}" rev-parse -q --verify HEAD 2>/dev/null || true
}

# phase_retry_progressed <codeline-root> <mark> — true when the retry changed what the codeline holds.
#
# THE PIPELINE NEVER LOOPS (operator, 2026-10-14: "pipeline should NEVER get into a loop!!!"). A retry is repeated
# while its gates remediate; AMSD-2974 live run L2 retried the 7.x line five times — each time the remediator added
# criteria, the writer committed nothing, the same code failed the same gate (~$2.50 a round). A retry that changed
# nothing cannot make the next one different: it is not repeated. With no mark (no repository), progress cannot be
# told, and the retry is not repeated either.
phase_retry_progressed() {
    local _now
    [ -n "${2:-}" ] || return 1
    _now=$(phase_retry_mark "${1:-.}")
    [ -n "$_now" ] && [ "$_now" != "$2" ]
}
