#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# writer-retest.sh — the operator tool for replaying the writer step alone.
#
# It has no callers BY DESIGN: an operator runs it by hand to iterate on a fix without paying for a
# whole pipeline. That makes its refusals the whole contract. Its own header states it:
#
#   "'Given' means given: this script does NOT run spec-pass/CPA/TC-writer to derive the manifest,
#    agent profile, or VCs — those must already be present in the PRD_FILE you pass in."
#
# A tool that quietly retests against SOME OTHER project's config, or against a PRD that never went
# through the spec pass, produces a result the operator will believe. These tests hold it to
# refusing instead — and separate a usage error (2) from a bad input (1), so a script driving it can
# tell the difference.
#
# WHAT IS NOT TESTED HERE, AND WHY. Two tests covering project-name resolution were written and
# removed: past that check the script sources project config and RESTORES
# orchestrations/agents/profiles.json, so running them mutated the repo under test. It left
# profiles.json modified and wrote into orchestrations/logs. A suite that writes into the tree it is
# testing is a hazard of its own, and reverting afterwards does not help when a test crashes.
#
# The contract that matters -- refusing to guess a project -- is held by the test below. Covering
# the rest needs the script to take its repo root from the environment, which it does not.
#
# 145 lines, never executed by a test until now.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    RETEST="$REPO_ROOT/orchestrations/scripts/writer-retest.sh"
    WORK="$(mktemp -d)"
    PRD="$WORK/prd.json"
    # Nothing inherited: the point is what the tool does with what it is GIVEN.
    unset EPAM_PROJECT_NAME EPAM_PROJECT_CONFIG_DIR || true
}
teardown() { rm -rf "$WORK"; }

@test "no PRD argument at all is a usage error" {
    run bash "$RETEST"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage"* ]]
}

@test "a PRD path that does not exist is refused" {
    run bash "$RETEST" "$WORK/nope.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not found"* ]]
}

@test "an unknown option is refused rather than ignored" {
    printf '{"project":{"name":"p"},"stories":[]}' > "$PRD"
    run bash "$RETEST" "$PRD" --not-a-real-flag
    [ "$status" -eq 2 ]
}

@test "a PRD that names no project is REFUSED, not guessed" {
    # Retesting against another project's config silently produces a result the operator believes.
    printf '{"stories":[{"id":"S-1"}]}' > "$PRD"
    run bash "$RETEST" "$PRD"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Refusing to guess"* ]]
}

@test "a PRD that is not valid JSON is refused" {
    printf '{ not json' > "$PRD"
    run bash "$RETEST" "$PRD" --project p
    [ "$status" -eq 1 ]
    [[ "$output" == *"not valid JSON"* ]]
}

@test "usage errors and bad inputs are DIFFERENT exit codes" {
    printf '{ not json' > "$PRD"
    run bash "$RETEST" "$PRD" --project p
    bad_input=$status
    run bash "$RETEST" "$PRD" --bogus
    usage=$status
    [ "$bad_input" -ne "$usage" ]
}
