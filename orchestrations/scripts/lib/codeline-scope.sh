#!/usr/bin/env bash
# WHICH CODELINES THIS RUN TOUCHES — READ FROM THE RUN, NEVER TYPED BY A HUMAN.
#
# This replaces EPAM_ONLY_CODELINES, which is deleted. That variable required an operator to
# name the repository a ticket belonged to, at launch, before anything ran. Three things were
# wrong with it and none are fixable by choosing a better value:
#
#   1. It is a project fact hand-entered into a launch. The next ticket needs a different one,
#      so somebody must already know the answer the pipeline exists to derive.
#   2. It was matched by SUBSTRING, in both directions. The value used on the run that had to
#      be killed matched six repositories; five were nothing to do with the ticket, and the
#      reset it scopes runs `git reset --hard` plus `clean -fd` — it discards COMMITS.
#   3. The answer was already in the PRD the launcher is handed. resolve-codeline-scope.sh
#      writes project.outputDirs — "the rule is the same for every project and names none of
#      them" — so the launcher was demanding a fact it was already holding.
#
# The PRD is the run. Every project has one, however it arrived. This names no project, no
# directory and no ticket.

# codeline_scope_paths <prd-file> — one absolute codeline path per line, or nothing.
#
# NOTHING IS NOT EVERYTHING. An empty result means the run has not resolved its scope yet, and
# a run that has not chosen a codeline cannot have dirtied one — so the caller must reset
# nothing. The behaviour being removed did the opposite: it swept every repository under the
# codeline root, which is how a finished codeline gets destroyed by the next launch.
codeline_scope_paths() {
    local _prd="${1:-}"
    [ -n "$_prd" ] && [ -f "$_prd" ] || return 0
    command -v jq >/dev/null 2>&1 || {
        echo "[codeline-scope] jq unavailable — cannot read scope from $_prd" >&2
        return 1
    }
    jq -r '
        [ (.project.outputDirs // [])[]?.path,
          (.project.outputDir // empty) ]
        | map(select(type == "string" and . != ""))
        | unique | .[]
    ' "$_prd" 2>/dev/null || {
        echo "[codeline-scope] $_prd is not valid JSON — cannot read scope" >&2
        return 1
    }
}

# codeline_in_scope <candidate-dir> <prd-file>
#
# EXACT, after resolving both sides to real paths. The deleted mechanism compared with `case
# $a in *"$b"*` in BOTH directions, so "metrolinx" selected azure.metrolinx.com,
# azure.metrolinx.psme.com, login.metrolinx.com, metrolinx.estimations.com,
# metrolinx.powerbi.com and next.metrolinx.com alike. A destructive operation must never be
# scoped by substring.
codeline_in_scope() {
    local _dir="${1:-}" _prd="${2:-}" _p _want _have
    [ -n "$_dir" ] || return 1
    _have="$(cd "$_dir" 2>/dev/null && pwd -P)" || return 1
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        _want="$(cd "$_p" 2>/dev/null && pwd -P)" || continue
        [ "$_want" = "$_have" ] && return 0
    done < <(codeline_scope_paths "$_prd")
    return 1
}

# require_codeline_root — REFUSE rather than glob the filesystem root.
#
# Every caller that iterates codelines writes `for d in "$JIRA_CODELINE_ROOT"/*/`. With the
# variable empty that glob is `/*/` — every top-level directory on the machine — and each one is
# then handed to brownfield-preflight-reset.sh, which runs `git reset --hard` and `clean -fd`.
# Measured 2026-09-04: an empty value made that loop iterate over 24 directories on this host.
#
# This is what makes it safe for a project to ship NO codeline root. Baking one in was worse: the
# shipped default pointed metrolinx at the operator's REAL client checkouts, so every fresh
# install began aimed at the real repositories until somebody remembered to correct it by hand.
# A default that is dangerous when forgotten is not a default — so the value is supplied per
# machine, and its absence stops the run here instead of being discovered afterwards in a diff.
require_codeline_root() {
    local _root="${JIRA_CODELINE_ROOT:-}" _who="${1:-this run}"
    if [ -z "$_root" ]; then
        echo "[codeline-scope] JIRA_CODELINE_ROOT is not set — refusing to continue." >&2
        echo "  ${_who} iterates \"\$JIRA_CODELINE_ROOT\"/*/, which with an empty value expands to" >&2
        echo "  '/*/' — every top-level directory on this machine, each one hard-reset." >&2
        echo "  Set it in the project's config.env or the environment, pointing at the directory" >&2
        echo "  that holds this project's repositories." >&2
        return 1
    fi
    if [ ! -d "$_root" ]; then
        echo "[codeline-scope] JIRA_CODELINE_ROOT='$_root' is not a directory — refusing to continue." >&2
        echo "  A path that does not exist yields an EMPTY codeline list, which reads as 'nothing" >&2
        echo "  to do' rather than as the misconfiguration it is." >&2
        return 1
    fi
    return 0
}
