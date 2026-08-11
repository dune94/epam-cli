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
# project_parallel_lanes_shared_state), one file per story.
#
# CORRECTED 2026-08-07: this used to claim the state was "wiped for free by the
# existing teardown/clean-slate reset at the start of every run. No separate
# reset logic is needed or wanted here." That was never true. pre-run-reset.sh's
# sweep matches *.log, story-outputs-*.txt and eslint-baseline-*.json, and never
# matched *.count. AMSD-2041.count held 6 across every run of 2026-08-06/07, so a
# fresh writer attempt started at rung 3 of 4: one review rejection exhausted the
# ladder, Step 3.6 escalated without a single re-implementation cycle, and the
# phase halted. Left alone, a story that exhausts its ladder once is escalated
# after one rejection on EVERY later run, forever.
#
# pre-run-reset.sh now clears these counters explicitly. Within a run they must
# still persist across claude.sh subprocesses — that is the requirement above.
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

_story_retry_model_file() {
    local log_dir="$1" story_id="$2"
    echo "$(_story_retry_state_dir "$log_dir")/${story_id}.model"
}

# read_story_retry_model <log_dir> <story_id>
# The model the ladder had escalated to when the last process exited, or "" if none.
#
# retry_count alone was persisted until 2026-08-10, and the counter is only a PROXY for the
# thing the ladder exists to control. STORY_MODEL is re-derived from the PRD on every
# invocation (claude.sh:1028), so a story re-entering after a Step 3.6 review rejection or a
# watchdog retry reset to the PRD model and took ONE step from there — it never resumed the
# climb. Live 2026-08-10: `InferenceLadder[Rung3/R8]: model 'MiniMax-M3' -> 'z-ai/glm-5.2'`,
# the rung-1 model at rung 3, burning rung 3's retry budget and its largest iteration budget.
#
# Empty is returned for a missing/blank file so the caller keeps the PRD model — a first
# attempt has nothing to resume, and that must stay distinguishable from a persisted value.
read_story_retry_model() {
    local log_dir="$1" story_id="$2"
    local f
    f="$(_story_retry_model_file "$log_dir" "$story_id")"
    if [ -f "$f" ]; then
        local v
        v="$(tr -d '\n\r' < "$f" 2>/dev/null)"
        printf '%s' "$v"
    else
        printf ''
    fi
}

write_story_retry_model() {
    local log_dir="$1" story_id="$2" model="$3"
    # Never persist an empty model: it would read as "no state" on resume and silently restart
    # the climb, which is the defect this exists to fix.
    [ -n "$model" ] || return 0
    local dir f
    dir="$(_story_retry_state_dir "$log_dir")"
    mkdir -p "$dir" 2>/dev/null || true
    f="$(_story_retry_model_file "$log_dir" "$story_id")"
    printf '%s' "$model" > "$f" 2>/dev/null || true
}

_story_retry_bump_file() {
    local log_dir="$1" story_id="$2"
    echo "$(_story_retry_state_dir "$log_dir")/${story_id}.iterbump"
}

# The accumulated rung iteration bump. Same reason as the model: it is computed per rung and
# lives in the process, so a re-invocation restarted the story at the base budget. Observed
# live 2026-08-10 — maxIter went 185 at attempt 3, then back to 120 on the next invocation,
# discarding every rung's escalation exactly as the model did.
read_story_iteration_bump() {
    local f; f="$(_story_retry_bump_file "$1" "$2")"
    if [ -f "$f" ]; then
        local v; v="$(tr -dc '0-9' < "$f" 2>/dev/null)"
        echo "${v:-0}"
    else
        echo 0
    fi
}

write_story_iteration_bump() {
    local log_dir="$1" story_id="$2" bump="$3"
    case "$bump" in ''|*[!0-9]*) return 0 ;; esac
    mkdir -p "$(_story_retry_state_dir "$log_dir")" 2>/dev/null || true
    printf '%s' "$bump" > "$(_story_retry_bump_file "$log_dir" "$story_id")" 2>/dev/null || true
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
