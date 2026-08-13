#!/usr/bin/env bash
# THE COST LEDGER, AND THE ONE THING THAT MUST NEVER HAPPEN TO IT.
#
# On 2026-08-13 a gotransit run cost $7.47 by OpenRouter's own counter and wrote ZERO records to
# phase-cost.jsonl. Every reader — the dashboard, the run report, the cost-variance gate — saw
# $0.00 and reported it without hesitation. The gate then escalated on a 597% variance computed
# against a stale estimate: a confident number derived from no data at all.
#
# The measurements were never missing. Each attempt's *_result.json carries total_cost_usd and a
# usage block, and usage-progress-<story>.json carries the running total. This is a REPORTING
# failure, and reporting zero is worse than reporting nothing, because zero is a number people act
# on. Cost tracking is the operator's stated priority #1.
#
# WHAT THIS FILE DOES, AND DELIBERATELY DOES NOT DO
#
# It answers one question at the end of a run: did this run make model calls and record nothing?
# If so it says so, loudly, naming the evidence.
#
# It does NOT reconstruct the cost from the result files. A second way of computing money is a
# second source of truth about money, and the first one being broken is exactly when a plausible
# substitute does the most damage. The ledger is the ledger; this makes its silence audible.

# resolve_cost_ledger — the ledger THIS process should write to.
#
# Resolved at call time from LOG_DIR, never captured at export time. PHASE_COST_FILE used to be
# exported once by the parent, so a lane that set its own LOG_DIR still wrote to the parent's path
# — one of three different notions of where the ledger lives, which is how a run ends up with
# records in a directory nobody reads.
resolve_cost_ledger() {
    printf '%s' "${PHASE_COST_FILE:-${LOG_DIR:-/tmp}/phase-cost.jsonl}"
}

# _cost_ledger_records <file> — how many records the ledger holds (0 if absent).
_cost_ledger_records() {
    local _f="${1:-}"
    [ -s "$_f" ] || { printf '0'; return 0; }
    grep -c . "$_f" 2>/dev/null || printf '0'
}

# _cost_ledger_spend_evidence — what proves this run called a model, without pricing anything.
# Counts artefacts only: a result file exists because a call returned, whatever it cost.
_cost_ledger_spend_evidence() {
    local _n=0 _dir="${LOG_DIR:-}"
    [ -n "$_dir" ] || { printf '0'; return 0; }
    # `grep -c` prints 0 AND exits 1 on no match, so `|| echo 0` appends a SECOND zero and the
    # count becomes two lines — which then compares as non-zero and reports a healthy run broken.
    _n=$(find "$_dir" -maxdepth 2 -name '*_result.json' 2>/dev/null | wc -l | tr -d '[:space:]')
    if [ "${_n:-0}" -eq 0 ]; then
        _n=$(find "$_dir" -maxdepth 1 -name 'usage-progress-*.json' -size +2c 2>/dev/null | wc -l | tr -d '[:space:]')
    fi
    printf '%s' "${_n:-0}"
}

# assert_cost_ledger_not_silently_empty — non-zero when a run spent and recorded nothing.
#
# Called at the end of a run. Never blocks work that has already happened; it makes the gap
# impossible to miss, because the alternative is a report that says $0.00 and is believed.
assert_cost_ledger_not_silently_empty() {
    local _ledger _records _evidence
    _ledger="$(resolve_cost_ledger)"
    _records="$(_cost_ledger_records "$_ledger")"
    _evidence="$(_cost_ledger_spend_evidence)"

    if [ "${_records:-0}" -gt 0 ]; then
        return 0
    fi
    if [ "${_evidence:-0}" -eq 0 ]; then
        # No calls, no records. A dry run, or a phase that skipped everything.
        return 0
    fi

    if command -v error >/dev/null 2>&1; then
        error "[cost] THIS RUN RECORDED NO COST. ${_evidence} model-call result artefact(s) are on"
        error "[cost] disk under ${LOG_DIR:-?}, and ${_ledger} holds 0 records."
        error "[cost] Every reader of that ledger — dashboard, run report, cost-variance gate —"
        error "[cost] will report \$0.00 for a run that spent real money, and the gate will judge a"
        error "[cost] variance against it. The per-attempt numbers survive in the *_result.json"
        error "[cost] files and usage-progress-<story>.json; the ledger is what is missing."
    else
        printf '[cost] run recorded no cost: %s result artefact(s), 0 ledger records at %s\n' \
            "${_evidence}" "${_ledger}" >&2
    fi
    return 1
}
