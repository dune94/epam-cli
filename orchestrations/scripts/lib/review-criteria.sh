#!/usr/bin/env bash
# review-criteria.sh — THE CRITERIA A REVIEWER JUDGES A DIFF AGAINST, BUILT ONCE.
#
# Brownfield judges on VERIFICATION CRITERIA. The ticket carries no acceptance criteria, the spec
# pass discards any a spec agent invents, and every reviewer therefore anchors on the VCs the story
# declares in the PRD.
#
# THIS EXISTS BECAUSE TWO REVIEWERS NEEDED THE SAME BLOCK. team-lead-review.sh built it inline;
# code-review-cycle.sh judged against __STORY_ACS__ instead and, when acceptance criteria were
# removed from the brownfield templates on 2026-09-01, was left with no criteria at all — a
# reviewer holding a diff, a description and nothing to measure them against.
#
# Copying the block into the second caller would put the same sentence in two files. The moment
# they drift, the two reviewers judge against differently-worded criteria and both look correct.
# One builder, both callers, and the wording is a fact stated once.

# review_vc_block <story_id> <prd_file>
#
# The verification-criteria section, or EMPTY when the story declares none.
#
# ABSENT IS ABSENT. A story with no VCs contributes no heading — an empty "VERIFICATION CRITERIA:"
# followed by nothing tells the reviewer to measure against silence, which is the failure this
# whole file was extracted to stop.
review_vc_block() {
    local _story_id="${1:-}" _prd="${2:-}"
    [ -n "$_story_id" ] && [ -f "$_prd" ] || { printf ''; return 0; }

    local _vc
    _vc=$(jq -r --arg id "$_story_id" \
        '.stories[] | select(.id == $id) | (.verificationCriteria // []) | map("- " + .) | join("\n")' \
        "$_prd" 2>/dev/null || printf '')

    [ -n "$_vc" ] || { printf ''; return 0; }
    printf '\nVERIFICATION CRITERIA (the observable checks this change MUST satisfy — judge the diff against every one):\n%s\n' "$_vc"
}
