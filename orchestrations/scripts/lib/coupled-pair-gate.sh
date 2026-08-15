#!/usr/bin/env bash
# ONE AUTHOR PER COUPLED FILE PAIR.
#
# Some files are only correct RELATIVE TO EACH OTHER: a manifest and its lockfile, a
# schema and its generated client. The inference ladder has no concept of that. Each
# rung is a fresh author that sees the tree, not the previous rung's intent, so a pair
# can be split across two models — and the halves then disagree.
#
# Live failure, run 20260814T213253Z (metrolinx, AMSD-2041):
#
#     Rung 2 (moonshotai/kimi-k3):  package-lock.json
#     Rung 4 (z-ai/glm-5.2):        package.json
#
# The lockfile gained a root `lodash-es` dependency the manifest never declared —
# a broken `npm ci`, shipped by construction. Tests and tsc both passed, because
# neither of them installs from the lockfile. The reviewer caught it, the ladder was
# already exhausted so escalation had nowhere to go, and the retry hard-reset the
# branch to origin/develop — destroying an implementation that had passed its gates.
#
# THE INVARIANT IS DELIBERATELY NARROW: if two members of a declared pair BOTH appear
# in the final diff, ONE rung must own both. It is NOT required that touching one
# member obliges touching the other — gotransit ran the same ticket on 2026-08-13,
# changed package.json alone, and was accepted. A gate that failed that run would
# contradict known-good history.
#
# THE PAIRS ARE A PROJECT FACT. They are declared in the codeline's own
# dependency-check manifest under `coupledFilePairs`. No filename appears in this
# file — a pair this engine has never heard of is enforced the moment a project
# declares it. An ABSENT declaration is UNKNOWN, never "none": the gate passes and
# says it checked nothing, so a project that never declared its pairs cannot look
# like a project that has none.

# coupled_pair_check <rung_contribution_report.json> <dependency_check_manifest.json>
#
# report:   [ { "rung": "2", "model": "...", "files": ["a","b"] }, ... ]
#           (the artifact _generate_rung_contribution_report already writes)
# manifest: { "coupledFilePairs": [ ["package.json","package-lock.json"], ... ] }
#
# Returns 0 when no declared pair is split, 1 when one is. Every violation names both
# halves with the rung and model that wrote each — "a pair was split" is not
# actionable, "rung 2/kimi-k3 wrote the lockfile, rung 4/glm-5.2 wrote the manifest"
# is.
coupled_pair_check() {
    local _report="$1" _manifest="$2"

    if [ ! -f "$_report" ]; then
        echo "coupled-pair-gate: no rung-contribution report at '$_report' — nothing to check" >&2
        return 0
    fi
    if [ ! -f "$_manifest" ]; then
        echo "coupled-pair-gate: no manifest at '$_manifest' — coupledFilePairs undeclared, checked nothing" >&2
        return 0
    fi

    local _pair_count
    _pair_count=$(jq '((.coupledFilePairs // []) | length)' "$_manifest" 2>/dev/null || echo 0)
    if [ -z "$_pair_count" ] || [ "$_pair_count" = "0" ] || [ "$_pair_count" = "null" ]; then
        echo "coupled-pair-gate: no coupledFilePairs declared in $(basename "$_manifest") — checked nothing" >&2
        return 0
    fi

    # A file is attributed to at most one rung in the report (the report is already
    # grouped that way). Flatten to file -> {rung, model}, then ask each declared pair
    # whether the members PRESENT in the diff agree on their author.
    local _violations
    _violations=$(jq -r --slurpfile m "$_manifest" '
        [ .[] | . as $r | .files[] | {file: ., rung: $r.rung, model: $r.model} ] as $owned
        | ($m[0].coupledFilePairs // []) as $pairs
        | [ $pairs[]
            | . as $pair
            | [ $owned[] | select(.file as $f | $pair | index($f) != null) ] as $present
            | select(($present | map(.rung) | unique | length) > 1)
            | { pair: $pair, authors: $present }
          ]
        | .[]
        | "  pair [\(.pair | join(" + "))] was split across rungs:\n"
          + (.authors | map("    \(.file) <- rung \(.rung) (\(.model))") | join("\n"))
    ' "$_report" 2>/dev/null)

    if [ -n "$_violations" ]; then
        echo "coupled-pair-gate: FAIL — a coupled file pair had more than one author." >&2
        echo "$_violations" >&2
        echo "  These files are only correct relative to each other. One rung must write all members." >&2
        return 1
    fi

    echo "coupled-pair-gate: OK — ${_pair_count} declared pair(s), none split across rungs"
    return 0
}
