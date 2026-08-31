#!/usr/bin/env bash
# THE PIPELINE DOES NOT RUN CODE NOBODY HAS TESTED.
#
# Called by every stage, with the stage's name, BEFORE the stage does anything. It asks how much of
# the code that stage executes has a test behind it, compares that against the threshold THIS
# PROJECT declares, and halts when the project's blocker is on.
#
# It exists because untested code is the most expensive thing this pipeline runs. The 2026-08-31
# metrolinx run paid for Jira ingest, codeline discovery, an estate survey and an agent mint before
# dying at the roster step on a branch that had shipped at v1.5 and that no test had ever executed.
# The money was spent before the defect was reachable. A gate in front of the stage spends nothing.
#
# ONE FUNCTION, CALLED WITH A STAGE NAME. A per-stage implementation would drift, and the stage
# that drifts is the one nobody is watching.
#
#   require_stage_coverage <stage-name>
#     0  the stage may run — it meets the threshold, or the blocker is off and the shortfall is
#        reported so the operator can see what was waived
#     1  the stage must not run

require_stage_coverage() {
    local _stage="${1:-}"
    if [ -z "$_stage" ]; then
        echo "[coverage-gate] called with no stage name — the gate cannot judge what it was not told" >&2
        return 1
    fi

    # NO PROJECT SELECTED MEANS THERE IS NO POLICY TO APPLY — and nothing to protect.
    #
    # The threshold and the blocker are per project, by design. A script executed with no project
    # selected is not a run: it cannot reach a model and it cannot spend. Refusing there does not
    # protect anything, it just makes the script unrunnable — which is exactly what happened when
    # this gate was wired in and twelve test files that execute these scripts directly began exiting
    # 1 before doing anything.
    #
    # This is not a hole. Every launcher selects a project before spending, and pre-flight — which
    # runs with the project selected — gates the whole map before the pipeline starts. A run that
    # could spend always has a project; one that has none could never spend.
    if [ -z "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -z "${STAGE_COVERAGE_POLICY:-}" ]; then
        echo "[coverage-gate] $_stage: no project selected, so no coverage policy applies — not a run, nothing to gate" >&2
        return 0
    fi

    local _dir _handler
    _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _handler="$_dir/handlers/stage-coverage.js"
    if [ ! -f "$_handler" ]; then
        echo "[coverage-gate] the coverage handler is missing at $_handler — this is not a pass; the gate itself could not run" >&2
        return 1
    fi

    # THE PROJECT'S POLICY, not the engine's. A project that declares none is refused: how much
    # cover it demands before spending is the operator's decision, and a default here would make
    # that decision for them silently.
    local _policy _threshold _blocker
    if ! _policy="$("${NODE_BIN:-node}" "$_handler" --policy 2>&1)"; then
        echo "[coverage-gate] $_stage: $_policy" >&2
        echo "[coverage-gate] refusing to run a stage under a coverage policy nobody declared" >&2
        return 1
    fi
    _threshold="$(printf '%s' "$_policy" | "${NODE_BIN:-node}" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).thresholdPercent))}catch{process.stdout.write("")}})')"
    _blocker="$(printf '%s' "$_policy" | "${NODE_BIN:-node}" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).blocker))}catch{process.stdout.write("")}})')"

    # THE MEASUREMENT IS PERSISTED BY THE HANDLER, NOT HERE.
    #
    # There was a second cache at this level, keyed by stage name under $TMPDIR. It was wrong twice
    # over: two runs sharing a temp directory read each other's numbers, and nothing tied the stored
    # value to the tree it measured — so a percentage could outlive the code it described. That is
    # the exact silence this gate exists to end, reintroduced by the thing meant to make it fast.
    #
    # The handler's report is the one cache, and it carries a fingerprint of every file the answer
    # depends on, so a stale one is never served. What is left here is a process start.
    local _pct _err
    if ! _pct="$("${NODE_BIN:-node}" "$_handler" "$_stage" 2>/tmp/.stage-cov-err.$$)"; then
        _err="$(cat "/tmp/.stage-cov-err.$$" 2>/dev/null)"; rm -f "/tmp/.stage-cov-err.$$"
        # NO MEASUREMENT IS NOT FULL COVERAGE. It is the state before anyone ran the suite, and it
        # is exactly the state in which a stage must not be allowed to spend.
        echo "[coverage-gate] $_stage: coverage could not be determined — $_err" >&2
        if [ "$_blocker" = "true" ]; then
            echo "[coverage-gate] HALTING: the blocker is on and nothing was measured. Unmeasured is not covered." >&2
            return 1
        fi
        echo "[coverage-gate] the blocker is off — continuing WITHOUT knowing this stage's coverage" >&2
        return 0
    fi
    rm -f "/tmp/.stage-cov-err.$$"

    local _meets
    _meets="$("${NODE_BIN:-node}" -e "process.stdout.write(String(Number(process.argv[1]) >= Number(process.argv[2])))" "$_pct" "$_threshold" 2>/dev/null)"
    if [ "$_meets" = "true" ]; then
        echo "[coverage-gate] $_stage: ${_pct}% covered (threshold ${_threshold}%) — proceeding" >&2
        return 0
    fi

    if [ "$_blocker" = "true" ]; then
        echo "[coverage-gate] $_stage: ${_pct}% covered, below the ${_threshold}% this project declares." >&2
        echo "[coverage-gate] HALTING before the stage runs. Untested code is the most expensive thing this pipeline executes: the cost is paid before the defect is reachable." >&2
        return 1
    fi

    echo "[coverage-gate] $_stage: ${_pct}% covered, below the ${_threshold}% threshold — the blocker is OFF, so this is a WARNING and the stage will run untested code." >&2
    return 0
}

# EVERY DECLARED STAGE, BEFORE THE PIPELINE STARTS.
#
# The per-stage gates above are the second line of defence: each one fires as its stage is entered,
# after money has already been spent on the stages before it. Pre-flight is the first, and it is the
# only one that costs nothing to fail.
#
# It has to cover EVERY stage in the map, not just its own. Stages such as cli, shared and reset are
# real code the pipeline depends on but are never "entered" — nothing would ever gate them, and code
# no gate can reach is exactly where untested code accumulates. Unassigned files are attributed to
# preflight by the handler for the same reason: a file belonging to no step still runs.
require_all_stage_coverage() {
    local _dir _handler _stages _stage _failed=0
    _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _handler="$_dir/handlers/stage-coverage.js"
    if [ ! -f "$_handler" ]; then
        echo "[coverage-gate] the coverage handler is missing at $_handler — the gate could not run" >&2
        return 1
    fi
    # ONE MEASUREMENT, EVERY STAGE. Asking one process fourteen questions costs one startup; asking
    # fourteen processes one question each costs fourteen, and the measurement itself is now the
    # cheap part. The handler persists the report, so the per-stage gates later in the run read it.
    _stages="$("${NODE_BIN:-node}" "$_handler" --all 2>/dev/null)"
    if [ -z "$_stages" ]; then
        echo "[coverage-gate] no stage coverage could be measured — refusing to start a pipeline whose coverage is unknown. Unmeasured is not covered." >&2
        return 1
    fi
    for _stage in $(printf '%s\n' "$_stages" | awk '{print $1}'); do
        require_stage_coverage "$_stage" || _failed=1
    done
    if [ "$_failed" != "0" ]; then
        echo "[coverage-gate] PRE-FLIGHT HALT: the pipeline does not start. Failing a stage here costs nothing; failing it mid-run costs the whole run up to that point." >&2
        return 1
    fi
    return 0
}
