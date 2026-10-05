#!/usr/bin/env bash
# pre-review-gate.sh — the pre-review gate's suite run (run-agent-orchestration.sh Step 19).
#
# AMSD-2974 live, 2026-10-04: the writer, the repro gate and Step 3.545 had passed and the team-lead
# review had APPROVED; then Step 19 ran the ecosystem's detected test command (`npm test`, bare jest,
# a worker per core) instead of the project's declared one, reached 5.2 GB and was OOM-killed. Had
# it finished, it failed on ANY red suite — cx-shared's DatePicker suites, already failing on the
# baseline, would have blocked a correct change.
#
# Nothing new is defined here. The suite is the project's declared one, through the one definition
# every other suite run uses (_run_project_verification <root> test), under the same CPU bound; a red
# suite is judged by baseline_new_failures, as Step 3.545 judges it. A failure the change introduced
# still fails the gate.

_PRG_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tsc-baseline-gate.sh
. "$_PRG_LIB_DIR/tsc-baseline-gate.sh"
# shellcheck source=lib/bounded-exec.sh
[ -f "$_PRG_LIB_DIR/bounded-exec.sh" ] && . "$_PRG_LIB_DIR/bounded-exec.sh"

# pre_review_suite <project_root> <log_dir> <gate_log>
#   0 — the suite passed, or every failing suite was already failing at the phase baseline
#   1 — a failure this phase introduced (or a red suite that could not be judged)
#   2 — the project declares no test suite
pre_review_suite() {
    local _root="$1" _log_dir="$2" _gate_log="$3" _out _rc=0
    # EPAM_WHOLE_SUITE_CHECK=0 — the operator's choice: the story is judged by its own tests, not by the
    # codeline's whole suite against a baseline (next.gotransit.com carries a test that fails 2 runs in 4
    # on its untouched baseline, so a single baseline run charged it to whichever story ran; 2026-10-05).
    if [ "${EPAM_WHOLE_SUITE_CHECK:-1}" = "0" ]; then
        warning "  Step 19: the whole-suite check is off (EPAM_WHOLE_SUITE_CHECK=0) — the stories were judged by their own tests"
        return 0
    fi
    _out=$(mktemp "${TMPDIR:-/tmp}/pre-review-suite-XXXXXX")
    local _run=(bash -c '. "$1" && _run_project_verification "$2" test' _ "$_PRG_LIB_DIR/tsc-baseline-gate.sh" "$_root")
    if command -v run_test_bounded >/dev/null 2>&1; then
        ( cd "$_root" && run_test_bounded "$(resolve_test_workers)" "${_run[@]}" ) > "$_out" 2>&1 || _rc=$?
    else
        ( cd "$_root" && "${_run[@]}" ) > "$_out" 2>&1 || _rc=$?
    fi
    cat "$_out" >> "$_gate_log"
    if [ "$_rc" -eq 0 ]; then rm -f "$_out"; return 0; fi
    if [ "$_rc" -eq 2 ]; then
        warning "  Step 19: ${_root} declares no test suite — pre-review tests NOT run"
        rm -f "$_out"; return 2
    fi
    local _new
    if _new=$(baseline_new_failures "$_root" "${NODE_CMD:-${NODE_BIN:-node}}" "$_log_dir" test "$_out" 2>&1); then
        success "  Step 19: the suite is red, but every failing suite was already failing at the baseline — none introduced by this phase"
        rm -f "$_out"; return 0
    fi
    error "  Step 19: the suite has failures this phase introduced:"
    printf '%s\n' "$_new" | head -40 | sed 's/^/    /'
    rm -f "$_out"
    return 1
}
