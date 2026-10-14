#!/usr/bin/env bash
# plan-of-record.sh — THE STORY'S PLAN AS APPROVED AT PAUSE 2, WRITTEN ONCE, NEVER OVERWRITTEN.
#
# Operator, 2026-10-14 (option 3): which criteria are the plan's is decided by the plan approved at pause 2 — not by a
# criterion's shape. The old rule ("exactly {text, status} means a remediator added it") was hard coding. The plan of
# record lives beside the lane's pre-writer checkpoint; a release line reads its lane's (the line's plan is the lane's).
# A run paused before this existed derives it once from that checkpoint — never from an earlier stage, which is not
# the approved plan.

# shellcheck source=run-checkpoint.sh
declare -F checkpoint_dir >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/run-checkpoint.sh"

# plan_of_record_file [run-id] — the path (it may not exist yet).
plan_of_record_file() {
    local _d; _d=$(EPAM_RELEASE_LINE='' checkpoint_dir "${1:-}" 2>/dev/null) || return 1
    [ -n "$_d" ] || return 1
    printf '%s/plan-of-record.json' "$_d"
}

# record_plan_of_record <prd> — write the plan of record from <prd>, ONCE: an existing one is never replaced.
record_plan_of_record() {
    local _src="${1:-}" _f
    _f=$(plan_of_record_file) || return 0
    [ -s "$_f" ] && return 0
    [ -n "$_src" ] && [ -f "$_src" ] || return 0
    mkdir -p "$(dirname "$_f")" 2>/dev/null || true
    jq '{stories: [(.stories // [])[] | {id, acceptanceCriteria: (.acceptanceCriteria // [])}]}' "$_src" > "$_f.tmp" 2>/dev/null \
        && mv "$_f.tmp" "$_f" || rm -f "$_f.tmp"
}

# plan_of_record_ensured — the plan of record's path when there is one: written now from the lane's pre-writer checkpoint
# if this run paused before plans of record were kept; nothing when no pause-2 checkpoint exists.
plan_of_record_ensured() {
    local _f _d
    _f=$(plan_of_record_file) || return 0
    if [ ! -s "$_f" ]; then
        _d=$(dirname "$_f")
        [ -f "$_d/checkpoint.json" ] && [ -f "$_d/prd.json" ] || return 0
        [ "$(_stage_rank "$(jq -r '.stage // empty' "$_d/checkpoint.json" 2>/dev/null)")" -ge "$(_stage_rank pre-writer)" ] || return 0
        record_plan_of_record "$_d/prd.json"
    fi
    [ -s "$_f" ] && printf '%s' "$_f"
}
