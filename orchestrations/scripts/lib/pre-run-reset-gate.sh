#!/usr/bin/env bash
# THE ONE PLACE A LAUNCHER RUNS THE PRE-RUN RESET.
#
# Was five copies of this, one per launcher:
#
#     bash orchestrations/scripts/pre-run-reset.sh --prd "$PRD_FILE" || \
#       info "  pre-run-reset.sh failed or Docker unavailable — ... (non-fatal, continuing)"
#
# Five copies of a rule is five chances for one to drift — and all five had the same defect:
# they could not tell "the dashboard is down" from "this run would start on the last run's
# review feedback", because both exited 1. See lib/contamination-exit.sh.
#
# Operator's standing rule: single point of maintenance, never more than 1.

# shellcheck source=contamination-exit.sh
. "${BASH_SOURCE%/*}/contamination-exit.sh"

# pre_run_reset_or_abort [args...]
# Runs pre-run-reset.sh with the given args. Aborts the launch ONLY on contamination.
pre_run_reset_or_abort() {
    local _script="${PRE_RUN_RESET_SCRIPT:-${BASH_SOURCE%/lib/*}/pre-run-reset.sh}"
    local _rc=0

    # The output is tee'd so the operator still sees it live, AND so this gate can look for
    # the completion sentinel. An exit code alone cannot say WHERE the script stopped.
    local _out
    _out=$(mktemp)
    bash "$_script" "$@" 2>&1 | tee "$_out" || true
    _rc=${PIPESTATUS[0]}

    # DID THE STATE WORK ACTUALLY RUN?
    #
    # This gate could previously tell only CONTAMINATION_EXIT from "something else", and
    # treated everything else as environmental. But a script under `set -e` that dies
    # part-way exits 1 having done NONE of the work sequenced after the failure — which is
    # not the same as an intact reset on a box with no Docker, and is indistinguishable
    # from it by exit code.
    #
    # Live, 2026-08-14: pre-run-reset died at line ~386 of 555 (a count of a directory its
    # own rm had just removed, turned fatal by pipefail). story-retry-state, the
    # kb-scratchpad sweep and the roster clear never ran. This gate said
    # "(dashboard/environment, not state) — non-fatal, continuing". The next run inherited
    # 12/12 attempts and died in 18 seconds having called no model at all.
    #
    # The sentinel is emitted after every state-clearing step. Its ABSENCE means the state
    # work did not complete, whatever the exit code claims — and that is contamination.
    if ! grep -q 'PRE_RUN_RESET_STATE_CLEARED' "$_out" 2>/dev/null; then
        rm -f "$_out"
        if command -v error >/dev/null 2>&1; then
            error "REFUSING TO LAUNCH: pre-run-reset did not finish its state clearing (exit ${_rc})."
        else
            echo "REFUSING TO LAUNCH: pre-run-reset did not finish its state clearing (exit ${_rc})." >&2
        fi
        echo "  It stopped part-way, so an unknown amount of the PREVIOUS run's state is still in place —" >&2
        echo "  retry counts, ladder position, published agent inputs. A run started now would inherit it." >&2
        echo "  Fix the error above and relaunch." >&2
        exit 1
    fi
    rm -f "$_out"

    if [ "$_rc" -eq "$CONTAMINATION_EXIT" ]; then
        # NOT a warning, NOT an info line. The launch stops here. A contaminated run is worse
        # than no run: it spends a full budget producing conclusions drawn from another run's
        # state, and reports them as this run's result.
        if command -v error >/dev/null 2>&1; then
            error "REFUSING TO LAUNCH: previous-run state could not be cleared (contamination)."
        else
            echo "REFUSING TO LAUNCH: previous-run state could not be cleared (contamination)." >&2
        fi
        echo "  Clear it by hand and relaunch. Nothing from a previous run may reach the writer or the reviewer." >&2
        exit 1
    fi

    if [ "$_rc" -ne 0 ]; then
        # Everything else stays exactly as non-fatal as it has always been — a box with no
        # Docker must still be able to run the pipeline.
        if command -v info >/dev/null 2>&1; then
            info "  pre-run-reset.sh exited $_rc (dashboard/environment, not state) — non-fatal, continuing"
        fi
    fi
    return 0
}
