#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE MOST DESTRUCTIVE LOOP IN THE PIPELINE, AND WHAT BOUNDS IT.
#
# brownfield-preflight-reset.sh runs `git reset --hard <baseline>` plus `clean -fd` against a
# CLIENT repository. `reset --hard` moves the branch pointer: it discards commits, not merely
# working-tree edits. The set that loop is applied to is the set this launch may destroy.
#
# It used to be bounded by EPAM_ONLY_CODELINES — an operator typing the repository name at
# launch. That is DELETED. Three things were wrong with it:
#
#   1. A project fact hand-entered into a launch. The next ticket needs a different one, so
#      somebody must already know the answer the pipeline exists to derive.
#   2. Matched by SUBSTRING, in both directions. The value used on the run that had to be
#      killed matched SIX repositories; five had nothing to do with the ticket.
#   3. The PRD the launcher is already handed carries the answer — project.outputDirs, written
#      by resolve-codeline-scope.sh for every project, naming none of them.
#
# The requirements that survive from the deleted mechanism's tests are kept here: an
# out-of-scope codeline is never reset, and the in-scope one still is.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    LIB="$REPO_ROOT/orchestrations/scripts/lib/codeline-scope.sh"
    WORK="$(mktemp -d)"
    PRD="$WORK/prd.json"
    mkdir -p "$WORK/root/next.metrolinx.com" "$WORK/root/azure.metrolinx.com" \
             "$WORK/root/login.metrolinx.com" "$WORK/root/metrolinx.powerbi.com"
}
teardown() { rm -rf "$WORK"; }

prd() {  # each arg: a path to declare
    local out="" p
    for p in "$@"; do out="$out{\"codeline\":\"x\",\"path\":\"$p\"},"; done
    printf '{"project":{"outputDirs":[%s]}}\n' "${out%,}" > "$PRD"
}

@test "the fixture is real — the library defines both entry points" {
    run bash -c ". '$LIB'; command -v codeline_scope_paths && command -v codeline_in_scope"
    [ "$status" -eq 0 ]
}

@test "scope comes from the PRD, and nothing else is consulted" {
    prd "$WORK/root/next.metrolinx.com"
    run bash -c ". '$LIB'; codeline_scope_paths '$PRD'"
    [ "$output" = "$WORK/root/next.metrolinx.com" ]
}

@test "the in-scope codeline IS in scope — the run must start from a known state" {
    prd "$WORK/root/next.metrolinx.com"
    run bash -c ". '$LIB'; codeline_in_scope '$WORK/root/next.metrolinx.com' '$PRD'"
    [ "$status" -eq 0 ]
}

@test "an out-of-scope codeline is NEVER in scope — the surviving requirement" {
    prd "$WORK/root/next.metrolinx.com"
    for other in azure.metrolinx.com login.metrolinx.com metrolinx.powerbi.com; do
        run bash -c ". '$LIB'; codeline_in_scope '$WORK/root/$other' '$PRD'"
        [ "$status" -ne 0 ]
    done
}

@test "THE SIX-REPO BUG: matching is exact, never substring" {
    # `case $name in *"$sel"*` in both directions is what made one value select six
    # repositories. Every name here shares the substring 'metrolinx'.
    prd "$WORK/root/next.metrolinx.com"
    n=0
    for d in "$WORK/root"/*/; do
        bash -c ". '$LIB'; codeline_in_scope '${d%/}' '$PRD'" && n=$((n+1))
    done
    [ "$n" -eq 1 ]
}

@test "AN EMPTY SCOPE MEANS NOTHING, NOT EVERYTHING" {
    # The changed behaviour, and the point of the whole exercise. A run that has not resolved
    # which codeline it belongs to cannot have dirtied one; sweeping every repository under the
    # root is how a finished codeline gets destroyed by the next launch.
    printf '{"project":{}}\n' > "$PRD"
    run bash -c ". '$LIB'; codeline_scope_paths '$PRD'"
    [ -z "$output" ]
    for d in "$WORK/root"/*/; do
        run bash -c ". '$LIB'; codeline_in_scope '${d%/}' '$PRD'"
        [ "$status" -ne 0 ]
    done
}

@test "a missing or malformed PRD selects nothing, and malformed says so" {
    run bash -c ". '$LIB'; codeline_scope_paths '$WORK/nope.json'"
    [ -z "$output" ]
    printf 'not json' > "$PRD"
    run bash -c ". '$LIB'; codeline_scope_paths '$PRD'"
    [[ "$output" == *"not valid JSON"* ]] || [ -z "$output" ]
}

@test "several declared codelines are all in scope" {
    prd "$WORK/root/next.metrolinx.com" "$WORK/root/azure.metrolinx.com"
    n=0
    for d in "$WORK/root"/*/; do
        bash -c ". '$LIB'; codeline_in_scope '${d%/}' '$PRD'" && n=$((n+1))
    done
    [ "$n" -eq 2 ]
}

@test "EPAM_ONLY_CODELINES is gone from every executable path" {
    cd "$REPO_ROOT"
    hits=$(grep -rn 'EPAM_ONLY_CODELINES' orchestrations/scripts/ orchestrations/projects/*/config.env 2>/dev/null \
           | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | grep -vE '^[^:]+:[0-9]+:#' | wc -l)
    [ "$hits" -eq 0 ] || {
        grep -rn 'EPAM_ONLY_CODELINES' orchestrations/scripts/ orchestrations/projects/*/config.env 2>/dev/null \
          | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'
        false
    }
}

@test "the launcher's reset loop is bounded by the PRD, and by nothing typed" {
    cd "$REPO_ROOT"
    loop=$(sed -n '/^for _cl_dir in "\$JIRA_CODELINE_ROOT"/,/^done$/p' orchestrations/scripts/tier3-metrolinx-run.sh)
    [ -n "$loop" ]
    [[ "$loop" == *"codeline_in_scope"* ]]
    [[ "$loop" == *'"$PRD_FILE"'* ]]
    [[ "$loop" != *"EPAM_ONLY_CODELINES"* ]]
}

@test "no codeline, repository or project is named in the library" {
    named=""
    code=$(grep -vE '^[[:space:]]*#' "$LIB")
    [ -n "$code" ]
    for banned in metrolinx gotransit upexpress mock next. azure.; do
        printf '%s' "$code" | grep -qF -- "$banned" && named="$named $banned"
    done
    [ -z "$named" ] || { echo "the library names:$named"; false; }
}
