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
_run_release_lines() {
    local _cl="$1" _cl_prd="$2" _wt="$3" _lane_log="$4" _log_file="${5:-/dev/null}" _phase_filter="${6:-}" _runner="$7" _canonical="${8:-}"
    local _lines=()
    mapfile -t _lines < <("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/release-lines.js" "$_cl_prd" "$_cl" "$_canonical")
    [ "${#_lines[@]}" -gt 0 ] || return 0
    local _entry _line _base _slug _line_log _line_prd _phase _pex _ledger
    for _entry in "${_lines[@]}"; do
        [ -n "$_entry" ] || continue
        _line="${_entry%%$'\t'*}"; _base="${_entry#*$'\t'}"
        _slug=$(printf '%s' "$_line" | tr -c 'A-Za-z0-9._-' '-')
        _line_log="${_lane_log}/lines/${_slug}"
        mkdir -p "$_line_log" 2>/dev/null || true
        _line_prd="${_line_log}/prd.json"
        "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/release-line-prd.js" "$_cl_prd" "$_line_prd" "$_cl" "$_line" "$_canonical" || {
            error "[orch] Codeline '${_cl}': could not prepare release line ${_line}"; return 1; }
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
            JIRA_CODELINE_RUN=1 \
            EPAM_CODELINE="$_cl" \
            EPAM_RELEASE_LINE="$_line" \
            EPAM_SPEC_MODE="$_line_spec" \
            EPAM_BRANCH_SUFFIX="-${_slug}" \
            JIRA_BASELINE_BRANCH="$_base" \
            LOG_DIR="$_line_log" \
            AGENT_IO_DIR="$_line_log/agent-io" \
            PRD_FILE="$_line_prd" \
            PROJECT_ROOT="$_wt" \
            OUTPUT_DIR="$_wt" \
            PHASE="$_phase" \
            bash "$_runner" --reset 2>&1 | tee -a "$_log_file"
            _pex=${PIPESTATUS[0]}
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
