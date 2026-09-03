#!/usr/bin/env bash
# WHAT THE OPERATOR IS TOLD WHEN A STORY HALTS — AND WHETHER IT IS TRUE.
#
# This ran inside run-agent-orchestration.sh, which cannot be sourced without running the whole
# pipeline, so the message an operator acts on had never been executed by a test.
#
# It matters because the message is a DIAGNOSIS. On a live run the writer burned 12 attempts and
# this printed "recovery was NOT exhausted: 0 of 12 attempt(s) used — the story failed on a gate
# verdict, not on running out of attempts", sending the reader to look for a gate verdict that was
# not the cause. A confident wrong answer costs more than no answer.
#
# Expects its caller to provide: error, read_story_retry_count, story_ladder_exhausted, MAX_RETRIES.

# _halt_recovery_state <story_id> — report the recovery state ACTUALLY observed for this story.
#
# The halt used to assert "failed after its retries and self-heal completed" and "recovery is
# exhausted" unconditionally. Live metrolinx AMSD-2041, 2026-08-19: a gate failed one story at
# attempt 2 of 12, the ladder had not left its first rung, and the writer was mid-way through
# addressing the reviewer's findings — and the run reported exhaustion. That message is the
# evidence an operator reads when deciding whether to retry, and it said the opposite of the truth.
#
# HALTING IS STILL THE MANDATE: let recovery run, then stop. What must not happen is CLAIMING
# exhaustion without checking. story_ladder_exhausted() already existed and was already used
# elsewhere in this file; the halt simply never asked it.
_halt_recovery_state() {
    local _story="${1:-}"
    local _used _max="${MAX_RETRIES:-11}"
    _used="$(read_story_retry_count "${LOG_DIR:-}" "$_story" 2>/dev/null || echo 0)"
    case "$_used" in (''|*[!0-9]*) _used=0 ;; esac

    # A COUNT NOBODY COULD READ IS NOT A COUNT OF ZERO.
    #
    # read_story_retry_count answers 0 both for "no attempts" and for "I cannot see the state" —
    # an empty LOG_DIR, or a lane whose own LOG_DIR this scope never received. On a live run the
    # writer burned 12 attempts and this reported "0 of 12 attempt(s) used, the story failed on a
    # gate verdict", sending the reader after a verdict that was not the cause. A confident wrong
    # diagnosis costs more than none, so an unreadable state says so — the same rule the gate
    # verdicts follow, where an unreadable log is a warn and never a pass.
    local _state_file=""
    if [ -n "${LOG_DIR:-}" ]; then
        _state_file="$(_story_retry_state_file "$LOG_DIR" "$_story" 2>/dev/null || echo '')"
    fi
    if [ -z "${LOG_DIR:-}" ] || [ ! -f "$_state_file" ]; then
        error "[orch]   recovery state for '${_story}' could not be read${LOG_DIR:+ at ${LOG_DIR}}"
        error "[orch]   How many attempts were used is UNKNOWN — do not read this as none. Check the"
        error "[orch]   lane's own log directory before concluding a gate verdict stopped the story."
        return 0
    fi
    if story_ladder_exhausted "${LOG_DIR:-}" "$_story" "$_max" 2>/dev/null; then
        error "[orch]   recovery is exhausted for '${_story}' — ${_used} of $((_max + 1)) attempt(s) used and the model ladder reached its top rung."
        error "[orch]   Another lane would reproduce the same failure at full ladder price."
    else
        error "[orch]   recovery was NOT exhausted for '${_story}': ${_used} of $((_max + 1)) attempt(s) used, ladder still below its top rung."
        error "[orch]   The story failed on a gate verdict, not on running out of attempts — read the last gate message before assuming the work cannot converge."
    fi
}
