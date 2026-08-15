#!/usr/bin/env bash
# SCOPE IS ARITHMETIC AGAINST THE PLAN, NOT AN OPINION.
#
# The reviewer is asked whether a change is larger than it needed to be. That is a
# judgment call, and on 2026-08-14 (run 20260814T213253Z, metrolinx AMSD-2041) it went
# wrong in the one direction nothing could recover from. The plan of record named FIVE
# sites. The implementer changed exactly those five and nothing else. The reviewer
# rejected it:
#
#     "the change is over-engineered: it modifies 6 files when the prescribed minimal
#      fix requires only 2 (contentstack.ts and _app.tsx)"
#
# That "2" appears nowhere in the plan the reviewer was handed. Obeying the plan was
# the thing being rejected, so no attempt could pass; four review cycles later the
# ladder was exhausted, the retry hard-reset the branch, and work that had passed
# `npm run test` and `tsc` was destroyed.
#
# This answers the scope question deterministically, BEFORE a reviewer sees the diff
# and while the ladder still has rungs. Two things are failures, and only two:
#
#   OUT OF PLAN   a changed file the prescription never names.
#   EXEMPT SITE   a changed file the prescription names and marks changeRequired:false
#                 ("part of the fix, correctly left untouched").
#
# A prescribed, non-exempt file is COMPLIANCE and is never reported, however many there
# are. The count is whatever the plan says it is.
#
# NOTHING HERE IS HARDCODED. Every path comes from the story's own fixSiteAnalysis.
# This file names no file, no extension, no directory and no count — a project
# prescribing an entirely different stack is checked identically. An absent
# prescription is UNCHECKED, never a pass: a story nobody planned must not look like a
# story that complied.

# A PRESCRIPTION IS NOT THE WHOLE OF LEGITIMATE SCOPE.
#
# Installing a package the fix needs necessarily touches files no site analysis would
# ever name — the manifest, its lockfile, a test-runner config. In the live run those
# were package.json, package-lock.json and jest.config.js, and a gate that knew only
# the five prescribed sites would have failed a compliant change for them.
#
# The engine does not get to know those names. The PROJECT already declares them, in
# the same manifest the dependency plugins read: `manifestFile`, every member of
# `coupledFilePairs`, and `dependencySensitiveConfigFiles`. They are read from there, so
# a project on a different stack contributes its own set and this file still names
# nothing. A project that declares none contributes none.
#
# _project_dependency_managed_files <dependency_check_manifest>
# Emits one repo-relative path per line; silent when nothing is declared.
_project_dependency_managed_files() {
    local _manifest="$1"
    [ -f "$_manifest" ] || return 0
    jq -r '
        [ (.manifestFile // empty) ]
        + ((.coupledFilePairs // []) | flatten)
        + (.dependencySensitiveConfigFiles // [])
        | map(select(type == "string" and . != "")) | unique | .[]
    ' "$_manifest" 2>/dev/null || true
}

# plan_fidelity_check <prd_file> <story_id> <changed_files_file> [dependency_check_manifest]
#
# changed_files_file: one repo-relative path per line (what the story actually changed).
# Returns 0 when every changed file is inside the plan and not exempt, 1 otherwise.
plan_fidelity_check() {
    local _prd="$1" _story="$2" _changed_file="$3" _dep_manifest="${4:-}"

    if [ ! -f "$_prd" ] || [ ! -f "$_changed_file" ]; then
        echo "plan-fidelity: no PRD or no changed-file list — UNCHECKED, no prescription compared" >&2
        return 0
    fi

    # The prescription may sit at either level depending on which producer wrote it;
    # ask for both rather than assuming one shape.
    local _sites
    _sites=$(jq -c --arg id "$_story" '
        [ .stories[]? | select(.id == $id)
          | (.fixSiteAnalysis // .technicalNotes.fixSiteAnalysis // [])[]? ]
    ' "$_prd" 2>/dev/null)
    if [ -z "$_sites" ] || [ "$_sites" = "[]" ] || [ "$_sites" = "null" ]; then
        echo "plan-fidelity: story '$_story' carries no prescription — UNCHECKED, nothing to compare against" >&2
        return 0
    fi

    # ABSENT IS UNKNOWN, NOT "NO EDIT NEEDED". A prescription where no site states
    # changeRequired cannot distinguish a mandated edit from a verify-only one, so every
    # site reads as mandatory and the implementer is pushed to touch all of them — the
    # live shape. It is not this gate's place to fail the story for that, but it must be
    # visible: silence here is what let the gap persist unnoticed.
    local _with_flag _total
    _total=$(printf '%s' "$_sites" | jq 'length' 2>/dev/null || echo 0)
    _with_flag=$(printf '%s' "$_sites" | jq '[ .[] | select(.changeRequired | type == "boolean") ] | length' 2>/dev/null || echo 0)
    if [ "${_with_flag:-0}" -eq 0 ]; then
        echo "plan-fidelity: NOTE — none of the ${_total} prescribed site(s) carry changeRequired," >&2
        echo "plan-fidelity:   so no site can be told apart as verify-only and every one reads as mandatory." >&2
    fi

    # Whatever the project itself declares as dependency-managed. Empty when it declares
    # nothing, or when no manifest was passed — never assumed.
    local _dep_files
    _dep_files=$(_project_dependency_managed_files "$_dep_manifest")

    local _violations=""
    local _line
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        if [ -n "$_dep_files" ] && printf '%s\n' "$_dep_files" | grep -Fxq -- "$_line"; then
            continue
        fi
        local _verdict
        _verdict=$(printf '%s' "$_sites" | jq -r --arg f "$_line" '
            map(select(.file == $f)) as $hit
            | if ($hit | length) == 0 then "out-of-plan"
              elif ($hit | map(select(.changeRequired == false)) | length) == ($hit | length) then "exempt"
              else "ok" end
        ' 2>/dev/null)
        case "$_verdict" in
            out-of-plan)
                _violations="${_violations}    ${_line} — the plan does not name this file"$'\n' ;;
            exempt)
                _violations="${_violations}    ${_line} — the plan marks this site changeRequired:false (no edit required)"$'\n' ;;
        esac
    done < "$_changed_file"

    if [ -n "$_violations" ]; then
        echo "plan-fidelity: FAIL — the change went outside the plan of record:" >&2
        printf '%s' "$_violations" >&2
        echo "  Every OTHER changed file is prescribed and is not a finding." >&2
        return 1
    fi

    echo "plan-fidelity: OK — every changed file is prescribed by the plan (${_total} site(s) planned)"
    return 0
}
