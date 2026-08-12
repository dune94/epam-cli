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

    bash "$_script" "$@" || _rc=$?

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
