#!/usr/bin/env bash
# reviewed-acs.sh — a criterion a remediator proposes is judged by the prd-change-reviewer before it reaches the plan.
#
# The failure-analyst's criteria went through run_prd_change_reviewer (lib/failure-healing.sh); the gate, review and lint
# remediators wrote theirs straight into the PRD, judged by no agent. AMSD-2974 rehearsal rv3 (2026-10-14): the review
# remediator added a criterion prescribing the FORM of a test, which the next review then enforced, round after round.
# Operator: "Agentic only ... correct the agentic process around this for root cause." One path for every remediator.

_ra_dir="$(dirname "${BASH_SOURCE[0]}")"
declare -F jq_vals >/dev/null 2>&1 || . "$_ra_dir/jq-vals.sh"
declare -F render_engine_prompt >/dev/null 2>&1 || . "$_ra_dir/render-engine-prompt.sh"
declare -F run_prd_change_reviewer >/dev/null 2>&1 || . "$_ra_dir/prd-change-review.sh"
declare -F require_profile >/dev/null 2>&1 || . "$_ra_dir/failure-healing.sh" 2>/dev/null || true

# apply_reviewed_acs <prd> <story_id> <remediator-output-file> <applier: ac-apply.py|lint-ac.py>
# Prints the number of criteria added (0 when the reviewer did not approve, or could not judge). Logs to stderr.
apply_reviewed_acs() {
    local _prd="$1" _sid="$2" _raw="$3" _applier="${4:-ac-apply.py}"
    local _copy _before _after _verdict _added
    _copy=$(mktemp "${TMPDIR:-/tmp}/reviewed-acs-XXXXXX.json"); cp "$_prd" "$_copy"
    python3 "$SCRIPT_DIR/lib/handlers/${_applier}" "$_copy" "$_sid" "$_raw" >/dev/null 2>&1 || true
    _before=$(jq -c --arg id "$_sid" '.stories[] | select(.id == $id) | .acceptanceCriteria // []' "$_prd" 2>/dev/null || echo '[]')
    _after=$(jq -c --arg id "$_sid" '.stories[] | select(.id == $id) | .acceptanceCriteria // []' "$_copy" 2>/dev/null || echo '[]')
    rm -f "$_copy"
    if [ "$_before" = "$_after" ]; then echo 0; return 0; fi
    # The reviewer reads its profile from `profiles_file` — claude.sh's name for the run's roster; the orchestrator names
    # the same file AGENT_PROFILES_FILE (run-agent-orchestration.sh: $EPAM_AGENTS_DIR/profiles.json).
    _verdict=$(profiles_file="${profiles_file:-${AGENT_PROFILES_FILE:-${EPAM_AGENTS_DIR:+$EPAM_AGENTS_DIR/profiles.json}}}" run_prd_change_reviewer "$_sid" "ac_patch" "$_before" "$_after")
    if [ "$_verdict" != "pass" ]; then
        warning "  [remediation] ${_sid}: the proposed criteria were not approved by the prd-change-reviewer (${_verdict:-no verdict}) — nothing added" >&2
        echo 0; return 0
    fi
    _added=$( ( flock -w 10 200 || exit 0
        python3 "$SCRIPT_DIR/lib/handlers/${_applier}" "$_prd" "$_sid" "$_raw" 2>/dev/null || echo 0
    ) 200>"${_prd}.lock" )
    echo "${_added:-0}"
}
