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
    local _root="$1" _log_dir="$2" _gate_log="$3" _out _rc=0 _suite_root="$1" _wt=""
    # A CODELINE THAT RECEIVES ANOTHER CODELINE'S CHANGE IS TESTED AGAINST IT. AMSD-2974 run 9 (2026-10-13): the sites
    # built cx-shared's fix into their lane worktrees, and Step 19 then ran on the codeline root — which keeps its
    # installed release — or not at all; no site was ever tested against the fix. The suite of a receiving codeline
    # runs in a worktree provisioned as a lane's is (provision_lane_worktree: the provider's build linked in), and is
    # judged against the phase baseline, which ran on the installed release: what the change breaks is new.
    if _pre_review_receives "$_root"; then
        # EPAM_WHOLE_SUITE_CHECK=0 is the operator's choice for a codeline with its own change (judged by its own tests);
        # one the plan gives no change has no tests of its own, and its suite is the only test of what it receives.
        if [ "${EPAM_WHOLE_SUITE_CHECK:-1}" = "0" ] && ! _pre_review_plan_gives_no_change; then
            warning "  Step 19: the whole-suite check is off (EPAM_WHOLE_SUITE_CHECK=0) — the stories were judged by their own tests"
            return 0
        fi
        _wt=$(_pre_review_receiving_worktree "$_root") || { error "  Step 19: could not provision a worktree with the provider's change for ${_root} — its suite cannot be run against it"; return 1; }
        _suite_root="$_wt"
        log "  Step 19: $(basename "$_root") receives another codeline's change — its declared suite runs against it ($(basename "$_wt"))"
    elif [ "${EPAM_WHOLE_SUITE_CHECK:-1}" = "0" ]; then
        # EPAM_WHOLE_SUITE_CHECK=0 — the operator's choice: the story is judged by its own tests, not by the
        # codeline's whole suite against a baseline (next.gotransit.com carries a test that fails 2 runs in 4
        # on its untouched baseline, so a single baseline run charged it to whichever story ran; 2026-10-05).
        warning "  Step 19: the whole-suite check is off (EPAM_WHOLE_SUITE_CHECK=0) — the stories were judged by their own tests"
        return 0
    fi
    _out=$(mktemp "${TMPDIR:-/tmp}/pre-review-suite-XXXXXX")
    local _run=(bash -c '. "$1" && _run_project_verification "$2" test' _ "$_PRG_LIB_DIR/tsc-baseline-gate.sh" "$_suite_root")
    if command -v run_test_bounded >/dev/null 2>&1; then
        ( cd "$_suite_root" && run_test_bounded "$(resolve_test_workers)" "${_run[@]}" ) > "$_out" 2>&1 || _rc=$?
    else
        ( cd "$_suite_root" && "${_run[@]}" ) > "$_out" 2>&1 || _rc=$?
    fi
    [ -n "$_wt" ] && git -C "$_root" worktree remove --force "$_wt" >/dev/null 2>&1
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

# _pre_review_receives <root> — true when this run's PRD has the codeline at <root> consume a package another codeline
# of the same story provides (lib/handlers/sibling-providers.js — the pairs the lanes link, from the story's plan).
_pre_review_receives() {
    [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE:-}" ] || return 1
    [ -n "$("${NODE_BIN:-node}" "$_PRG_LIB_DIR/handlers/sibling-providers.js" "$PRD_FILE" "$1" 2>/dev/null)" ]
}

# _pre_review_plan_gives_no_change — true when the story's plan gives this codeline (EPAM_CODELINE) no change, for
# every story this process works (lib/handlers/plan-gives-no-change.js).
_pre_review_plan_gives_no_change() {
    local _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}" _id _n=0
    [ -n "${EPAM_CODELINE:-}" ] && [ -f "$_prd" ] || return 1
    while IFS= read -r _id; do
        [ -n "$_id" ] || continue
        _n=$((_n + 1))
        "${NODE_BIN:-node}" "$_PRG_LIB_DIR/handlers/plan-gives-no-change.js" "$_prd" "$_id" "$EPAM_CODELINE" >/dev/null 2>&1 || return 1
    done < <(jq -r '.stories[]?.id // empty' "${PRD_FILE:-$_prd}" 2>/dev/null)
    [ "$_n" -gt 0 ]
}

# _pre_review_receiving_worktree <root> — a detached worktree of <root> at HEAD, provisioned as a lane's worktree is
# (provision_lane_worktree, lib/codeline-lanes.sh: the provider's build linked into its own vendor directory). Prints
# its path; the caller removes it.
_pre_review_receiving_worktree() {
    local _root="$1" _wt
    command -v provision_lane_worktree >/dev/null 2>&1 || return 1
    _wt="$(mktemp -d "${TMPDIR:-/tmp}/receiving-XXXXXX")/$(basename "$_root")"
    git -C "$_root" worktree add -q --detach "$_wt" HEAD >/dev/null 2>&1 || return 1
    provision_lane_worktree "$_root" "$_wt" >&2
    printf '%s\n' "$_wt"
}

# pre_review_typecheck <project_root> <log_dir> <gate_log> — Steps 19 and 20's type check, judged as the
# writer's is: errors already present at the phase baseline are subtracted (baseline_new_failures
# typecheck). It ran the whole-project check raw: next.gotransit.com's develop fails it untouched with 6
# errors (its team's node_modules is older than the branch expects — an `npm install` the pipeline may not
# run), so both steps would fail every story on errors none of them made (AMSD-2974, 2026-10-05). A
# type error the phase introduced still fails.
#   0 — passed, or every error was already present at the baseline
#   1 — an error this phase introduced (or a failing check that could not be judged)
pre_review_typecheck() {
    local _root="$1" _log_dir="$2" _gate_log="$3" _out _rc=0 _new _wt=""
    _out=$(mktemp "${TMPDIR:-/tmp}/pre-review-tsc-XXXXXX")
    # A codeline that receives another codeline's change is type-checked against it, as its suite is run (above).
    if _pre_review_receives "$_root"; then
        _wt=$(_pre_review_receiving_worktree "$_root") || { error "  could not provision a worktree with the provider's change for ${_root} — its type check cannot be run against it"; rm -f "$_out"; return 1; }
        _run_project_verification "$_wt" > "$_out" 2>&1 || _rc=$?
        git -C "$_root" worktree remove --force "$_wt" >/dev/null 2>&1
    else
        _run_project_verification "$_root" > "$_out" 2>&1 || _rc=$?
    fi
    cat "$_out" >> "$_gate_log"
    if [ "$_rc" -eq 0 ]; then rm -f "$_out"; return 0; fi
    if _new=$(baseline_new_failures "$_root" "${NODE_CMD:-${NODE_BIN:-node}}" "$_log_dir" typecheck "$_out" 2>&1); then
        success "  the type check fails only on errors already present at the baseline — none introduced by this phase"
        rm -f "$_out"; return 0
    fi
    error "  the type check has errors this phase introduced:"
    printf '%s\n' "$_new" | head -40 | sed 's/^/    /'
    rm -f "$_out"
    return 1
}
