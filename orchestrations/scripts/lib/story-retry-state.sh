#!/usr/bin/env bash
# Per-story inference-ladder rung state — survives across SEPARATE claude.sh
# subprocess invocations for the same story within one run.
#
# Root cause this fixes (found live, run 20260806T021820Z): retry_count (the
# ladder's rung counter) was a `local` inside implement_story() in claude.sh.
# Step 3.6's review->re-implement loop re-invokes claude.sh as a brand-new
# subprocess on every review-rejection cycle, so retry_count silently reset
# to 0 every cycle — the ladder never climbed past rung 0 before Step 3.6's
# fixed REVIEW_MAX_CYCLES cap hard-escalated. Explicit standing requirement:
# "Retries MUST proceed up the rungs — nothing is allowed to intercede."
#
# State lives under LOG_DIR (already lane-scoped — see
# project_parallel_lanes_shared_state), one file per story, so it is wiped
# for free by the existing teardown/clean-slate reset at the start of every
# run. No separate reset logic is needed or wanted here.
#
# Sourced by both claude.sh (reads/writes retry_count) and
# run-agent-orchestration.sh (Step 3.6 advances the rung + checks exhaustion).

_story_retry_state_dir() {
    local log_dir="$1"
    echo "${log_dir}/story-retry-state"
}

_story_retry_state_file() {
    local log_dir="$1" story_id="$2"
    echo "$(_story_retry_state_dir "$log_dir")/${story_id}.count"
}

# Echoes the persisted retry_count for a story, or 0 if none exists yet.
read_story_retry_count() {
    local log_dir="$1" story_id="$2"
    local f
    f="$(_story_retry_state_file "$log_dir" "$story_id")"
    if [ -f "$f" ]; then
        local v
        v="$(cat "$f" 2>/dev/null)"
        case "$v" in
            ''|*[!0-9]*) echo 0 ;;
            *) echo "$v" ;;
        esac
    else
        echo 0
    fi
}

write_story_retry_count() {
    local log_dir="$1" story_id="$2" count="$3"
    local dir f
    dir="$(_story_retry_state_dir "$log_dir")"
    mkdir -p "$dir" 2>/dev/null || true
    f="$(_story_retry_state_file "$log_dir" "$story_id")"
    echo "$count" > "$f" 2>/dev/null || true
}

# rung = retry_count / 2 (matches claude.sh's own `_rung=$(( retry_count / 2 ))`)
story_ladder_rung() {
    local retry_count="$1"
    echo $(( retry_count / 2 ))
}

story_max_rung() {
    local max_retries="$1"
    echo $(( max_retries / 2 ))
}

# True (exit 0) once the story's persisted rung has reached the top rung —
# i.e. there is no further model/effort escalation the ladder can offer.
story_ladder_exhausted() {
    local log_dir="$1" story_id="$2" max_retries="$3"
    local cur rung max_rung
    cur="$(read_story_retry_count "$log_dir" "$story_id")"
    rung="$(story_ladder_rung "$cur")"
    max_rung="$(story_max_rung "$max_retries")"
    [ "$rung" -ge "$max_rung" ]
}

# Advances a story's persisted retry_count to the START of the NEXT rung
# (e.g. rung0 -> retry_count 2, rung1 -> retry_count 4), clamped to
# max_retries so an already-top-rung story stays at the top rung rather than
# being pushed past MAX_RETRIES (which would skip its final attempt
# entirely). A review rejection is itself evidence this attempt did not
# succeed, even when the code built/tested fine internally — so review-
# driven re-implementation must count as ladder progression too, not just
# internal build/test failures.
# The shared key convention for ai-run.sh's ladder state — ANY caller that
# needs to advance an agent's ladder position from OUTSIDE ai-run.sh (e.g. a
# reviewer rejecting a technically-successful call) must derive the same key
# this way, or its write lands on a different file than ai-run.sh reads.
# Sanitized because EPAM_AGENT_NAME routinely contains ':' (e.g.
# "code-graph-detective:plan"), which is not a safe filename component.
ai_ladder_state_key() {
    local agent_name="${1:-agent}" story_id="${2:-global}"
    local key="${agent_name}__${story_id}"
    # printf (not echo) — echo's trailing newline would itself get mangled by
    # tr into a trailing '_', corrupting every key it touches.
    printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_'
}

advance_story_retry_rung() {
    local log_dir="$1" story_id="$2" max_retries="$3"
    local cur cur_rung next
    cur="$(read_story_retry_count "$log_dir" "$story_id")"
    cur_rung="$(story_ladder_rung "$cur")"
    next=$(( (cur_rung + 1) * 2 ))
    [ "$next" -gt "$max_retries" ] && next="$max_retries"
    write_story_retry_count "$log_dir" "$story_id" "$next"
}

# ai-run.sh's ladder is flat (one escalation per attempt, no 2-attempts-per-
# rung grouping — that grouping is specific to claude.sh's writer loop). ANY
# caller that re-invokes an ai-run.sh-based agent after an explicit
# REJECTION (not a transport failure ai-run.sh already retries on its own)
# must call this — using the SAME key ai_ladder_state_key() derives — before
# re-invoking, or the next ai-run.sh process resumes at rung 0 regardless of
# how far a prior invocation actually climbed.
advance_ladder_escalation() {
    local log_dir="$1" key="$2"
    local cur
    cur="$(read_story_retry_count "$log_dir" "$key")"
    cur=$((cur + 1))
    write_story_retry_count "$log_dir" "$key" "$cur"
    echo "$cur"
}
