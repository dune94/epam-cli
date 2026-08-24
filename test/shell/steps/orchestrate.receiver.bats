#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# orchestrate.sh — the generic project launcher, and the confirmation that guards spending.
#
# 378 lines. Onboarding a project is supposed to be data: a config.env under
# orchestrations/projects/<name>/ and nothing else. So its refusals ARE the contract — a launcher
# that proceeds on a missing config runs the wrong project's models against the wrong codeline.
#
# AND IT COULD SPEND WITHOUT ASKING. Line 95 was:
#
#     [[ ! -t 0 ]] && AUTO_YES=true
#
# Any invocation without a terminal -- a cron, a CI step, a script, an agent, a mis-pasted command
# -- skipped the "spend credits?" prompt and launched. The plausible reason is background launches,
# but those pass --yes explicitly; what the line actually covered was launching non-interactively
# WITHOUT --yes, which is exactly the case where nobody is watching. Line 94 already handles
# legitimate automation via CI=true and AUTO_YES_TIER3=1.
#
# Every test here stops before any model call: they assert refusals, and the auto-confirm test
# asserts the run ABORTS.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    ORCH="$REPO_ROOT/orchestrations/scripts/orchestrate.sh"
    WORK="$(mktemp -d)"
    unset CI AUTO_YES_TIER3 || true
}
teardown() { rm -rf "$WORK"; }

@test "no --project is a usage error" {
    run bash "$ORCH"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Usage"* ]]
}

@test "an unknown argument is refused, not ignored" {
    run bash "$ORCH" --project metrolinx --not-a-flag
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unknown arg"* ]]
}

@test "a project with no config is refused — never a guessed default" {
    run bash "$ORCH" --project no-such-project-xyz
    [ "$status" -ne 0 ]
    [[ "$output" == *"config not found"* ]]
}

@test "THE SPEND GATE: a non-interactive launch without --yes does not auto-confirm" {
    # WITH A TIMEOUT AND A CLOSED STDIN. The first version of this test launched a real run: the
    # script had `[[ ! -t 0 ]] && AUTO_YES=true`, so running it non-interactively -- which is what a
    # test IS -- skipped the prompt. It locked 33 codelines read-only and reached Jira ingest before
    # being killed. A test asserting that a guard holds must not be able to trip the guard.
    #
    # The line is gone, so this now blocks on `read` and the timeout ends it. Neither outcome
    # launches anything, and "Auto-confirmed" must not appear either way.
    run timeout 20 bash "$ORCH" --project metrolinx < /dev/null
    # A POSITIVE FIRST. This asserted ONLY the absence of "Auto-confirmed", so the launcher failing
    # instantly — a missing binary, an unset variable, a typo in $ORCH — satisfied it completely
    # while proving nothing. Hollow anywhere is bad; hollow here is worst, because this test is
    # what stands between a stray non-interactive invocation and spend.
    [[ "$output" == *"Project:"*"metrolinx"* ]] || {
        echo "the launcher never reached the point where it would confirm — this proves nothing:"
        echo "$output" | tail -5
        false
    }
    [[ "$output" != *"Auto-confirmed"* ]] || { echo "a non-interactive launch auto-confirmed"; false; }
}

@test "no launcher treats a missing terminal as consent" {
    # The class, across all four launchers. Absence of a terminal is not somebody choosing to spend.
    # Matches EXECUTABLE code only: the comments that quote the removed line are not the line.
    cd "$REPO_ROOT"
    run grep -rnE '^[^#]*\[\[ ! -t 0 \]\]' orchestrations/scripts/orchestrate.sh orchestrations/scripts/tier3-metrolinx-run.sh orchestrations/scripts/tier3-skyscanner-app-run.sh orchestrations/scripts/tier3-travel-app-run.sh
    [ "$status" -ne 0 ]
}

@test "and the explicit opt-ins still exist, so real automation keeps working" {
    run grep -E 'CI:-.*==.*true|AUTO_YES_TIER3' "$ORCH"
    [ "$status" -eq 0 ]
}

@test "an explicit --yes still confirms, so background launches keep working" {
    # Asserted on the SOURCE, because running this would launch a paid run. The behavioural half is
    # covered above: without --yes it must not auto-confirm.
    run grep -c 'AUTO_YES=true' "$ORCH"
    [ "$output" -ge 2 ]
    run grep -c '\-\-yes|-y)' "$ORCH"
    [ "$output" -ge 1 ]
}


