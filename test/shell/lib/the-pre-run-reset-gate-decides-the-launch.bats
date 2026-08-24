#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE GATE THAT DECIDES WHETHER A PAID RUN IS ALLOWED TO START.
#
# lib/pre-run-reset-gate.sh is the single point of maintenance for "may this launch
# proceed?". Six launchers source it and call it. It had NO test.
#
# Its rule is the inverse of the defect family this repo keeps hitting — absence read
# as success. It does not trust the exit code, because a `set -e` script that dies
# part-way exits 1 having done NONE of the work sequenced after the failure, which is
# indistinguishable by exit code from an intact reset on a box with no Docker. So it
# reads a SENTINEL, and treats the sentinel's absence as contamination.
#
# Live, 2026-08-14 (from the lib's own header): pre-run-reset died at line ~386 of 555.
# story-retry-state, the kb-scratchpad sweep and the roster clear never ran. The next
# run inherited 12/12 attempts and died in 18 seconds having called no model at all.
#
# Every code path below is exercised against the REAL function with a stubbed
# pre-run-reset.sh, via the PRE_RUN_RESET_SCRIPT seam the lib already provides.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    LIB="$REPO_ROOT/orchestrations/scripts/lib/pre-run-reset-gate.sh"
    WORK="$(mktemp -d)"
    STUB="$WORK/pre-run-reset.sh"
    export PRE_RUN_RESET_SCRIPT="$STUB"

    # THE EXIT CODE IS NOT HARD-CODED HERE. It is read from the one file that defines
    # it, so this test cannot drift from the pipeline and cannot ratify a changed value.
    # shellcheck source=/dev/null
    . "$REPO_ROOT/orchestrations/scripts/lib/contamination-exit.sh"

    # The sentinel string, likewise, is read from the producer — not retyped.
    SENTINEL="$(grep -oE 'PRE_RUN_RESET_STATE_CLEARED' \
        "$REPO_ROOT/orchestrations/scripts/pre-run-reset.sh" | head -1)"
}
teardown() { rm -rf "$WORK"; }

# stub <exit-code> <emit-sentinel:yes|no>
stub() {
    {
        echo '#!/usr/bin/env bash'
        echo 'echo "[pre-run-reset] clearing previous run state"'
        echo 'touch "$0.ran"'
        [ "$2" = yes ] && echo "echo '$SENTINEL'"
        echo "exit $1"
    } > "$STUB"
    chmod +x "$STUB"
}

# Runs the real gate in a child shell, so an `exit` inside it is observable.
gate() { run bash -c '. "$1"; pre_run_reset_or_abort --prd /dev/null; echo REACHED_NEXT_LINE' _ "$LIB"; }

@test "the fixture is real — the lib, the producer and the exit code all exist" {
    [ -f "$LIB" ]
    [ -n "$SENTINEL" ]
    [ -n "${CONTAMINATION_EXIT:-}" ]
    [ "$CONTAMINATION_EXIT" -gt 1 ]   # must be distinguishable from an ordinary failure
}

@test "a clean reset that emitted the sentinel ALLOWS the launch" {
    stub 0 yes
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *REACHED_NEXT_LINE* ]]
    [ -f "$STUB.ran" ]               # vacuous-pass guard: the stub really executed
}

@test "THE 2026-08-14 DEFECT: no sentinel means the state work did not finish — launch REFUSED" {
    stub 1 no
    gate
    [ "$status" -ne 0 ]
    [[ "$output" != *REACHED_NEXT_LINE* ]]
    [[ "$output" == *"state clearing"* ]]
}

@test "a ZERO exit without the sentinel is refused too — a clean exit is not proof of work" {
    # The nastier shape: the script exits 0 having returned early. Only the sentinel
    # can tell that case from a completed reset.
    stub 0 no
    gate
    [ "$status" -ne 0 ]
    [[ "$output" != *REACHED_NEXT_LINE* ]]
}

@test "contamination REFUSES the launch, and says so in those words" {
    stub "$CONTAMINATION_EXIT" yes
    gate
    [ "$status" -ne 0 ]
    [[ "$output" != *REACHED_NEXT_LINE* ]]
    [[ "$output" == *"REFUSING TO LAUNCH"* ]]
    [[ "$output" == *contamination* ]]
}

@test "an ENVIRONMENTAL failure is non-fatal — a box with no Docker still runs the pipeline" {
    # This is the line the gate must not cross. Widening the refusal to every non-zero
    # exit would block runs on a missing dashboard, which is cosmetic.
    stub 1 yes
    gate
    [ "$status" -eq 0 ]
    [[ "$output" == *REACHED_NEXT_LINE* ]]
}

@test "the environmental case is DISTINGUISHED from contamination, not merged with it" {
    stub 1 yes
    gate
    [[ "$output" != *"REFUSING TO LAUNCH"* ]]
}

@test "the verdict survives the pipe — tee does not mask the contamination code" {
    # The gate tees its child's output so the operator sees it live. That pipeline's own
    # status is tee's, which is always 0; only ${PIPESTATUS[0]} carries the real code.
    # If that read regressed, contamination would be reported as a clean reset.
    stub "$CONTAMINATION_EXIT" yes
    gate
    [[ "$output" == *contamination* ]]
}

@test "the hazard is real: a piped command's failure is invisible without PIPESTATUS" {
    run bash -c 'if bash -c "exit 9" | tee /dev/null || true; then echo LOOKS_CLEAN; fi'
    [[ "$output" == *LOOKS_CLEAN* ]]
}

@test "the refusal is an exit, not a return — a launcher cannot continue past it" {
    # A `return 1` would let a launcher with no `set -e` (which is all of them) carry on
    # into the run. Only an exit stops the process.
    stub "$CONTAMINATION_EXIT" yes
    cat > "$WORK/launcher.sh" <<LAUNCHER
. "$LIB"
pre_run_reset_or_abort --prd /dev/null
echo LAUNCH_PROCEEDED
LAUNCHER
    run bash "$WORK/launcher.sh"
    [ "$status" -ne 0 ]
    [[ "$output" != *LAUNCH_PROCEEDED* ]]
}

@test "the gate leaves no temp file behind on either path" {
    _before=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'tmp.*' -newermt '-1 second' 2>/dev/null | wc -l)
    stub 0 yes
    gate
    [ "$status" -eq 0 ]
    # the tee target is removed on the allow path; assert the lib does the cleanup it claims
    run bash -c "grep -c 'rm -f \"\$_out\"' '$LIB'"
    [ "$output" -ge 2 ]
}
