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
story_acs_block() {
    local _prd="${1:-}" _id="${2:-}" _heading="${3:-ACCEPTANCE CRITERIA:}"
    [ -n "$_prd" ] && [ -f "$_prd" ] && [ -n "$_id" ] || return 0
    local _list
    _list=$(jq -r --arg id "$_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | map(select(. != null and . != "")) | to_entries | map("AC\(.key+1): \(.value)") | join("\n")' \
        "$_prd" 2>/dev/null || true)
    [ -n "$_list" ] || return 0
    printf '%s\n%s\n\n' "$_heading" "$_list"
}
