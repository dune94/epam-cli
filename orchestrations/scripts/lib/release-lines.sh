#!/usr/bin/env bash
# _run_release_lines <codeline> <lane-prd> <worktree> <lane-log-dir> <log-file> <phase-filter> <phase-runner>
#
# A SHARED CODELINE SHIPS ON EVERY RELEASE LINE ITS STORY'S PLAN NAMES. The lane has worked its stories on the
# codeline's own base; this works them once more per line the plan marks off that base (lib/handlers/release-lines.js)
# — that line's base (a branch or a release tag), its own story branch (EPAM_BRANCH_SUFFIX), its own logs, its own PRD
# copy with the stories pending again (lib/handlers/release-line-prd.js). The plan decides how many: 0, 1 or N.
#
# Operator, 2026-10-06 (AMSD-2974): "Why one? That does not work for brownfield for a shared repo", "You cannot hard
# code 1:1". The library had to ship on 8.x and as a back-port from v7.14.0 for two consumers locked to ^7.
#
# The phase runner is the lane's own (the orchestrator, "$0"), run exactly as the lane runs it. A line that fails
# fails the lane; no later line runs after it. Returns non-zero then.
# shellcheck source=resume-semantics.sh
. "$(dirname "${BASH_SOURCE[0]}")/resume-semantics.sh"
# shellcheck source=phase-exit.sh
declare -F phase_exit_is_retryable >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/phase-exit.sh"

_run_release_lines() {
    # THE CODELINE IS LEFT ON THE BRANCH IT WAS ON. A line pass checks out the line's story branch; left there, the next
    # launch's detective read cx-shared at 7.14.0 and planned its own line as 7.x (AMSD-2974, 2026-10-07).
    # The branch is recorded in the codeline's git dir first: a run killed mid-line runs nothing after the pass, and
    # the next launch returns the codeline from the record (_return_codelines_from_release_lines).
    local _home _rc=0 _gd
    _home=$(git -C "$3" symbolic-ref -q --short HEAD 2>/dev/null || true)
    _gd=$(git -C "$3" rev-parse --absolute-git-dir 2>/dev/null || true)
    [ -n "$_home" ] && [ -n "$_gd" ] && printf '%s\n' "$_home" > "$_gd/epam-release-home"
    _run_release_lines_each "$@" || _rc=$?
    _return_from_release_lines "$3" "$1"
    return "$_rc"
}

# _return_from_release_lines <codeline-root> [name] — back on the branch the record names; the record is removed.
_return_from_release_lines() {
    local _gd _home
    _gd=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 0
    [ -f "$_gd/epam-release-home" ] || return 0
    _home=$(cat "$_gd/epam-release-home")
    if [ -n "$_home" ] && [ "$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null)" != "$_home" ]; then
        if git -C "$1" checkout -q "$_home" 2>/dev/null; then
            log "[orch] Codeline '${2:-$1}': release lines done — back on ${_home}"
        else
            warning "[orch] Codeline '${2:-$1}': could not return to ${_home} after its release lines"
            return 0
        fi
    fi
    rm -f "$_gd/epam-release-home"
}

# _return_codelines_from_release_lines <prd> — every codeline of the PRD a line pass left is put back before the
# launch plans the story (AMSD-2974 run 2, 2026-10-07: the detective read cx-shared on its 7.x line branch).
_return_codelines_from_release_lines() {
    local _p
    while IFS=$'\t' read -r _n _p; do
        [ -n "$_p" ] && [ -d "$_p" ] && _return_from_release_lines "$_p" "$_n"
    done < <(jq -r '.project.outputDirs[]? | [.codeline, .path] | @tsv' "$1" 2>/dev/null)
    return 0
}

_run_release_lines_each() {
    local _cl="$1" _cl_prd="$2" _wt="$3" _lane_log="$4" _log_file="${5:-/dev/null}" _phase_filter="${6:-}" _runner="$7" _canonical="${8:-}"
    local _lines=()
    mapfile -t _lines < <("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/release-lines.js" "$_cl_prd" "$_cl" "$_canonical")
    [ "${#_lines[@]}" -gt 0 ] || return 0
    # THE CHANGE EVERY LINE PORTS: what the codeline's own line committed for this story — from the lane's phase baseline
    # to the branch the codeline was on when the lines began (recorded by _run_release_lines). Given verbatim to each
    # line's writer and diff reviewers (lib/producers/fix-plan.js, template release-line-port): AMSD-2974 run 9 gave
    # them only the plan's summary, and a 7.x back-port carrying a fraction of the 8.x change was approved.
    local _main_branch="" _main_base="" _main_change="${_lane_log}/main-line-change.diff" _gdir
    _gdir=$(git -C "$_wt" rev-parse --absolute-git-dir 2>/dev/null || true)
    [ -n "$_gdir" ] && [ -f "$_gdir/epam-release-home" ] && _main_branch=$(cat "$_gdir/epam-release-home")
    _main_base=$(tr -d '[:space:]' < "${_lane_log}/phase-baseline-sha.txt" 2>/dev/null || true)
    rm -f "$_main_change"
    if [ -n "$_main_branch" ] && [ -n "$_main_base" ]; then
        git -C "$_wt" diff "$_main_base" "$_main_branch" > "$_main_change" 2>/dev/null || rm -f "$_main_change"
    fi
    [ -s "$_main_change" ] || { rm -f "$_main_change"; _main_change=""; }
    if [ -n "$_main_change" ]; then
        log "[orch] Codeline '${_cl}': each release line ports ${_main_branch}'s change ($(grep -c '^diff --git' "$_main_change") file(s), from ${_main_base:0:9})"
    else
        warning "[orch] Codeline '${_cl}': no committed change on its own line to port — release lines are worked from the plan alone"
    fi
    local _entry _line _base _slug _line_log _line_prd _phase _pex _ledger
    for _entry in "${_lines[@]}"; do
        [ -n "$_entry" ] || continue
        _line="${_entry%%$'\t'*}"; _base="${_entry#*$'\t'}"
        _slug=$(printf '%s' "$_line" | tr -c 'A-Za-z0-9._-' '-')
        _line_log="${_lane_log}/lines/${_slug}"
        mkdir -p "$_line_log" 2>/dev/null || true
        _line_prd="${_line_log}/prd.json"
        # A LINE THIS RUN COMPLETED GOES BACK TO ITS REVIEWER ON RESUME — kept, not redone, not passed over by rule
        # (operator, 2026-10-08: the 7.x back-port carried a third of the 8.x fix). Its PRD and story branch are kept;
        # the phase runs without --reset, so Step 1 passes it as completed and the review → rework loop judges it
        # against the story's plan as it stands.
        local _rerun_args=(--reset) _line_branch
        if resume_preserves completed-stories && [ -f "$_line_prd" ] \
            && jq -e '(.stories | length) > 0 and all(.stories[]; .status == "completed")' "$_line_prd" >/dev/null 2>&1 \
            && [ -z "$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/spec-predates-plan.js" "$_line_prd" "${_canonical:-$_cl_prd}" 2>/dev/null)" ]; then
            _rerun_args=()
            _line_branch="${EPAM_BRANCH_PREFIX:-}AI-$(jq -r '.stories[0].id' "$_line_prd")-${_slug}"
            git -C "$_wt" checkout -q "$_line_branch" 2>/dev/null \
                || warning "[orch] Codeline '${_cl}': could not check out ${_line_branch} for its review"
            # The story's plan as it stands — the kept line PRD holds the plan of the pass that completed it.
            "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/carry-plan.js" "$_line_prd" "${_canonical:-$_cl_prd}" || true
            log "[orch] Codeline '${_cl}' — release line ${_line} completed in this run — its reviewer judges it again against the story's plan"
        else
        "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/release-line-prd.js" "$_cl_prd" "$_line_prd" "$_cl" "$_line" "$_canonical" || {
            error "[orch] Codeline '${_cl}': could not prepare release line ${_line}"; return 1; }
        fi
        log "[orch] Codeline '${_cl}' — release line ${_line}, from ${_base} (the story's plan)"
        # A STEP NEVER RUNS TWICE: a story already specified for this codeline is not specified again on another line.
        # The spec pass runs on the line only for a story that still lacks its spec (lib/handlers/stories-lacking-spec.js).
        local _line_spec="${EPAM_SPEC_MODE:-}"
        [ -z "$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/stories-lacking-spec.js" "$_line_prd" 2>/dev/null)" ] && _line_spec=0
        local _phases=()
        mapfile -t _phases < <("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/prd-phases.js" "$_line_prd")
        for _phase in "${_phases[@]}"; do
            [ -n "$_phase" ] || continue
            [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ] && continue
            _line_phase() {
                JIRA_CODELINE_RUN=1 \
                EPAM_CODELINE="$_cl" \
                EPAM_RELEASE_LINE="$_line" \
                EPAM_MAIN_LINE_CHANGE="$_main_change" \
                EPAM_MAIN_LINE_BRANCH="$_main_branch" \
                EPAM_SPEC_MODE="$_line_spec" \
                EPAM_BRANCH_SUFFIX="-${_slug}" \
                JIRA_BASELINE_BRANCH="$_base" \
                LOG_DIR="$_line_log" \
                AGENT_IO_DIR="$_line_log/agent-io" \
                PRD_FILE="$_line_prd" \
                PROJECT_ROOT="$_wt" \
                OUTPUT_DIR="$_wt" \
                PHASE="$_phase" \
                bash "$_runner" "$@" 2>&1 | tee -a "$_log_file"
                return "${PIPESTATUS[0]}"
            }
            _pex=0; _line_phase "${_rerun_args[@]}" || _pex=$?
            # A LINE RETRIES AS A LANE DOES (lib/phase-exit.sh): exit 2 is "the gates remediated the story — retry the
            # phase"; once, with SKIP_GATE_REMEDIATION=1 (AMSD-2974 run 10: the line failed on it, the finding never
            # reached its writer).
            # WHILE THE GATES REMEDIATE, THE LINE'S PHASE IS RETRIED with remediation on (lib/codeline-lanes.sh, the same rule).
            while phase_exit_is_retryable "$_pex"; do
                log "[orch] Gate remediation applied for '${_phase}' ('${_cl}' release line ${_line}) — retrying the phase with what the gates added"
                _pex=0; _line_phase --reset || _pex=$?
            done
            if [ "$_pex" -ne 0 ]; then
                error "[orch] Phase '${_phase}' for '${_cl}' on release line ${_line} failed (exit $_pex)"
                return 1
            fi
            log "[orch] Phase '${_phase}' — '${_cl}' release line ${_line} done."
        done
        # The line's append-only ledgers back into the lane's, as a lane folds its own into the parent.
        for _ledger in phase-cost.jsonl agent-activity.jsonl healing-events.jsonl; do
            [ -s "${_line_log}/${_ledger}" ] && cat "${_line_log}/${_ledger}" >> "${_lane_log}/${_ledger}" 2>/dev/null || true
        done
    done
    return 0
}
