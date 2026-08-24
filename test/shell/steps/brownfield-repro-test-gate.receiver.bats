#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE GATE THAT PROVES A BROWNFIELD FIX ACTUALLY FIXES SOMETHING.
#
# 222 lines. It blocks a story from shipping unless the story's test FAILS on the pre-fix
# baseline and PASSES with the fix — the difference between "a test exists" and "the fix
# works". Steps 3.54 and 3.545 both defer their findings to it.
#
# Its own header records two live vacuous passes: a codeline whose ecosystem declared no
# test runner exited 0 (the entire brownfield proof chain evaporated while every step
# reported success), and an exit-3 "could not run" read as "it reproduces the bug". Both
# are the absence-read-as-success family. Neither had a test.
#
# These run the REAL script against a REAL git repository. The reproduction is real too:
# the stub runner greps the fix file for a marker, so it genuinely passes with the fix
# present and fails once the gate has reverted it.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    GATE_SRC="$REPO_ROOT/orchestrations/scripts/brownfield-repro-test-gate.sh"
    WORK="$(mktemp -d)"
    mkdir -p "$WORK/gate/lib/handlers"
    cp "$GATE_SRC" "$WORK/gate/gate.sh"
    export NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE_BIN" >/dev/null 2>&1 || export NODE_BIN=node

    export PROJECT_ROOT="$WORK/repo"
    export JIRA_BASELINE_BRANCH=main
    mk_repo
}
teardown() { rm -rf "$WORK"; }

# The ecosystem handler is stubbed, because what this gate must be tested for is its
# DECISIONS, not the registry's ability to recognise a package.json.
declare_runner() {
    cat > "$WORK/gate/lib/handlers/codeline-ecosystem.js" <<JS
console.log(JSON.stringify({ testFileCommand: ${1} }));
JS
}

mk_repo() {
    git init -q -b main "$PROJECT_ROOT"
    git -C "$PROJECT_ROOT" config user.email t@t; git -C "$PROJECT_ROOT" config user.name t
    mkdir -p "$PROJECT_ROOT/src"
    echo "before" > "$PROJECT_ROOT/src/a.js"
    git -C "$PROJECT_ROOT" add -A; git -C "$PROJECT_ROOT" commit -qm baseline
    # The story lives on its OWN branch. The first version of this fixture committed the
    # story onto main, so main WAS HEAD, the baseline diff was empty, and half these tests
    # passed by describing a gate that had examined nothing.
    git -C "$PROJECT_ROOT" checkout -q -b story/STORY-1
}

# Adds the story's commit on top of the baseline: a fix, a test, or both.
commit_story() { # $1=with-fix(yes|no) $2=with-test(yes|no)
    [ "$1" = yes ] && echo "FIXED" > "$PROJECT_ROOT/src/a.js"
    [ "$2" = yes ] && { mkdir -p "$PROJECT_ROOT/src"; echo "assert" > "$PROJECT_ROOT/src/a.test.js"; }
    git -C "$PROJECT_ROOT" add -A
    git -C "$PROJECT_ROOT" commit -qm story
}

gate() { run bash "$WORK/gate/gate.sh" STORY-1; }

@test "the fixture is real — a git repo, a baseline, and the shipped gate" {
    run bash -c "cmp -s '$GATE_SRC' '$WORK/gate/gate.sh' && echo IDENTICAL"
    [[ "$output" == IDENTICAL ]]
    run git -C "$PROJECT_ROOT" rev-parse --verify main
    [ "$status" -eq 0 ]
}

@test "the story branch really diverges from the baseline — the gate has something to diff" {
    # VACUOUS-FIXTURE GUARD. With an empty diff every branch of this gate is unreachable and
    # its verdicts mean nothing, while the tests still go green.
    commit_story yes yes
    run git -C "$PROJECT_ROOT" diff --name-only main HEAD
    [[ "$output" == *"src/a.js"* ]]
    [[ "$output" == *"src/a.test.js"* ]]
}

@test "THE HAPPY PATH: a test that fails on baseline and passes with the fix is allowed" {
    # The stub runner reads the fix file, so the reproduction genuinely depends on the
    # gate having reverted it. Nothing here is faked by exit code.
    declare_runner '"grep -q FIXED src/a.js"'
    commit_story yes yes
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"reproduces the bug"* ]]
}

@test "a change that ships NO test is blocked" {
    declare_runner '"true"'
    commit_story yes no
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"no test file accompanies the change"* ]]
}

@test "a test that PASSES without the fix is blocked — it does not reproduce anything" {
    declare_runner '"true"'          # passes whether or not the fix is present
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"do NOT reproduce the bug"* ]]
}

@test "THE VACUOUS PASS: a codeline with no declared test runner is BLOCKED, not passed" {
    # Its own header: "on every codeline whose ecosystem was not Node, the HARD gate that
    # blocks a change shipping no working reproducing test passed vacuously, silently."
    declare_runner '""'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"declares no way to run its tests"* ]]
}

@test "a test that fails WITH the fix is blamed on the fix, not on the test" {
    declare_runner '"grep -q NOTHING_LIKE_THIS src/a.js"'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"FAIL with the fix in place"* ]]
}

@test "a test that never RAN is blamed on the test, and says the fix was never exercised" {
    # An assertion failure and a compile failure demand opposite responses. Getting this
    # wrong sent a live investigation the wrong way on 2026-07-24.
    declare_runner '"echo SyntaxError: Unexpected token; exit 1"'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" == *"never ran"* ]]
    [[ "$output" == *"says NOTHING about whether the fix is correct"* ]]
}

@test "an ordinary assertion failure is NOT mistaken for a test that never ran" {
    # The old pattern `ERROR: Expected` matched vitest's `AssertionError: expected ...`
    # case-insensitively, so the NORMAL result for a reproducing test read as "never ran".
    declare_runner '"echo AssertionError: expected 1 to be 2; exit 1"'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" != *"never ran"* ]]
    [[ "$output" == *"FAIL with the fix in place"* ]]
}

@test "a runner emitting JSON that is not a test report is not read as zero tests" {
    # The never-ran check decides on a NUMBER, and its source is the runner's own output.
    # A runner that prints some other JSON object has no numTotalTests; treating that
    # absence as 0 turns any such failure into "the test never ran" and sends the
    # investigation at the test instead of the fix.
    declare_runner '"echo {\\\"ok\\\":false}; exit 1"'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    [[ "$output" != *"never ran"* ]]
    [[ "$output" == *"FAIL with the fix in place"* ]]
}

@test "a test-only change is not applicable, and passes without reverting anything" {
    declare_runner '"true"'
    commit_story no yes
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *"nothing to revert"* ]]
}

@test "THE FIX IS RESTORED after a BLOCK — the gate must not leave the tree reverted" {
    # The gate reverts fix files to run the baseline check. If it blocks and forgets to
    # restore, the run continues against a working tree with the fix deleted.
    declare_runner '"true"'
    commit_story yes yes
    gate
    [ "$status" -eq 1 ]
    run cat "$PROJECT_ROOT/src/a.js"
    [[ "$output" == FIXED ]]
    run git -C "$PROJECT_ROOT" status --porcelain
    [ -z "$output" ]
}

@test "and after a PASS the tree is equally clean" {
    declare_runner '"grep -q FIXED src/a.js"'
    commit_story yes yes
    gate
    [ "$status" -eq 0 ]
    run git -C "$PROJECT_ROOT" status --porcelain
    [ -z "$output" ]
}

@test "no baseline branch, and none resolvable, is a BLOCK — never a pass" {
    # This defaulted to the literal "develop", so on a project whose trunk is named
    # anything else the gate compared the fix against nothing.
    declare_runner '"true"'
    commit_story yes yes
    git -C "$PROJECT_ROOT" checkout -q --detach HEAD
    JIRA_BASELINE_BRANCH="" run bash "$WORK/gate/gate.sh" STORY-1
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot diff the fix against anything"* ]]
}

@test "the escape hatch skips, and says it skipped" {
    declare_runner '""'
    commit_story yes no
    EPAM_SKIP_REPRO_GATE=1 run bash "$WORK/gate/gate.sh" STORY-1
    [ "$status" -eq 0 ]
    [[ "$output" == *"escape hatch"* ]]
}

@test "a story id is required — the gate never runs against an unnamed story" {
    declare_runner '"true"'
    run bash "$WORK/gate/gate.sh"
    [ "$status" -ne 0 ]
}
