#!/usr/bin/env bash
# story-acs-block.sh — the acceptance-criteria BLOCK a seam prompt receives, or nothing.
#
# Brownfield judges on verification criteria: a brownfield story has no acceptance criteria, and an
# empty "ACCEPTANCE CRITERIA:" heading over nothing is worse than no heading (operator, 2026-09-01,
# ea920ee7). Greenfield is authored WITH acceptance criteria and they are in scope (operator,
# 2026-09-11). Both hold when the heading travels with the criteria: present, the block is the
# heading and the numbered list; absent, the block is empty and the template's __STORY_ACS__
# (declared mayBeEmpty) renders as nothing. Four seams read it — failure-analyst, team-lead-review,
# code-review-cycle, code-graph-detective (spec-mode-runner.js builds the same shape in JS) — so
# the shape is defined here once.
#
# story_acs_block <prd_file> <story_id> [heading]
#   stdout: "<heading>\nAC1: ...\nAC2: ...\n\n" when the story declares acceptance criteria,
#           "" otherwise. Default heading "ACCEPTANCE CRITERIA:".
# A CRITERION THE REMEDIATOR ADDED SAYS SO (operator, 2026-10-14: a reviewer may retire one that cannot be met — never
# one of the plan's). The remediators (ac-apply.py, lint-ac.py) write {text, status, origin: "remediation"}; before the
# origin field they wrote exactly {text, status}, which nothing else writes. The plan's criteria are strings.
# THE MARKER IS TEMPLATE PROSE (prompts/templates/criterion-origin.json) — never a literal here. The criteria block renders
# it, the reviewer's contract names it (story_criterion_mark_values), and retire-criteria.py accepts a name copied with it.
# shellcheck source=render-engine-prompt.sh
declare -F render_engine_prompt >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/render-engine-prompt.sh"
story_criterion_mark() {
    local _v _m; _v=$(mktemp "${TMPDIR:-/tmp}/criterion-origin-XXXXXX.json"); echo '{}' > "$_v"
    _m=$(render_engine_prompt criterion-origin "$_v" remediation); rm -f "$_v"; printf '%s' "$_m"
}
# story_criterion_mark_values — the mark as a values object for a template that names it (__REMEDIATION_MARK__).
story_criterion_mark_values() {
    jq -cn --arg m "$(story_criterion_mark)" '{"__REMEDIATION_MARK__": $m}'
}
story_acs_block() {
    local _prd="${1:-}" _id="${2:-}" _heading="${3:-ACCEPTANCE CRITERIA:}"
    [ -n "$_prd" ] && [ -f "$_prd" ] && [ -n "$_id" ] || return 0
    local _list
    _list=$(jq -r --arg id "$_id" --arg mark "$(story_criterion_mark)" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | map(select(. != null and . != "")) | to_entries
         | map("AC\(.key+1): " + (if (.value | type) == "object" then
                   (.value.text // (.value | tostring))
                   + (if ((.value.origin // "") == "remediation") or ((.value | keys) == ["status", "text"])
                      then "  " + $mark else "" end)
                 else (.value | tostring) end))
         | join("\n")' \
        "$_prd" 2>/dev/null || true)
    [ -n "$_list" ] || return 0
    printf '%s\n%s\n\n' "$_heading" "$_list"
}
