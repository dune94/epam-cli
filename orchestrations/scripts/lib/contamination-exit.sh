#!/usr/bin/env bash
# ONE EXIT CODE MEANING "THIS RUN WOULD START ON A PREVIOUS RUN'S STATE".
#
# pre-run-reset.sh can fail for two entirely unrelated reasons:
#
#   - the dashboard's Docker mount is unavailable        -> cosmetic, a run is fine
#   - a previous run's state could not be cleared        -> FATAL, the run must not start
#
# Both exited 1, so every launcher treated both as cosmetic:
#
#     bash orchestrations/scripts/pre-run-reset.sh --prd "$PRD_FILE" || \
#       info "  pre-run-reset.sh failed or Docker unavailable — ... (non-fatal, continuing)"
#
# That `|| info` is why the review-feedback, ladder-state and agent-KB sweeps were detection
# without enforcement: each could find contamination, print, and be ignored.
#
# Operator, 2026-08-12: "We cannot have writer or reviewer contamination - period."
#
# Writer and reviewer contamination is not a class of bug to be handled at the point of use —
# it is the ONE condition under which a launch must never proceed. Hence a distinct code no
# launcher is permitted to swallow.
CONTAMINATION_EXIT=9
export CONTAMINATION_EXIT

# fail_contamination <message>
# For state that MUST NOT survive a run and could not be removed. Never for anything else:
# widening this to ordinary failures would put runs back to being blocked by a missing Docker.
fail_contamination() {
    if command -v error >/dev/null 2>&1; then
        error "CONTAMINATION: $*"
    else
        echo "[pre-run-reset] ✗ CONTAMINATION: $*" >&2
    fi
    echo "[pre-run-reset] A run started now would inherit a previous run's state. Refusing to launch." >&2
    exit "$CONTAMINATION_EXIT"
}
