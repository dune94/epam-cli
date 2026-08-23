#!/usr/bin/env bats
#
# A DETERMINISTIC CHECK WHOSE EXIT STATUS IS DISCARDED IS NOT A GATE.
#
# run_lockfile_sync_check returns 1 on drift and sets VERIFICATION_FAILURE, DETERMINISTIC_CHECK_
# FAILURE and STORY_REJECTION_KEY — everything the retry needs. It was called BARE inside
# run_external_verification, so that verdict was thrown away and verification carried on to the
# test suite and could return 0.
#
# Live metrolinx AMSD-2041: lockfile-sync blocked FOUR times and the story completed anyway, with
# a manifest package-lock.json does not resolve. `npm ci` on that branch fails outright. Its
# sibling run_dependency_check was guarded in the same repair; this one was left behind.
#
# The block is extracted from claude.sh and EXECUTED with stubbed checks, so what is asserted is
# what the real caller does with a verdict — not that the source contains an `if`.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  SCRIPT="${REPO_ROOT}/orchestrations/scripts/claude.sh"

  BLOCK="${BATS_TEST_TMPDIR}/block.sh"
  # From the dependency guard down to the END of the lockfile call — whether that call is bare or
  # guarded. A range that stopped ON the lockfile line cut a guarded form in half, leaving an
  # unterminated `if` and failing every test for a reason that had nothing to do with the code.
  awk '
    /if ! run_dependency_check "\$PROJECT_ROOT"; then/ { inblock = 1 }
    inblock { print; if (/run_lockfile_sync_check "\$PROJECT_ROOT"/) seen = 1 }
    seen && /^[[:space:]]*fi[[:space:]]*$/ { exit }
    seen && /^[[:space:]]*run_lockfile_sync_check/ { exit }
  ' "$SCRIPT" > "$BLOCK"
  # The extraction must have found the real block, or every assertion below is vacuous.
  [ -s "$BLOCK" ]
  grep -q 'run_lockfile_sync_check' "$BLOCK"
  grep -q 'run_dependency_check' "$BLOCK"
}

# Runs the extracted block as the BODY OF A FUNCTION, with both checks stubbed to the given exit
# codes. "REACHED_END" prints only if the block let execution continue.
#
# The block is INLINED into the function rather than sourced from inside one: `return` in a sourced
# file returns from the `source` builtin, not from the enclosing function, so a sourced harness
# reports every guarded check as unguarded. In claude.sh this code is inline, and the harness has
# to match or it tests itself.
run_with() {
  local harness="${BATS_TEST_TMPDIR}/harness.sh"
  {
    echo "set -uo pipefail"
    echo "PROJECT_ROOT='${BATS_TEST_TMPDIR}'"
    echo "run_dependency_check()    { return ${1}; }"
    echo "run_lockfile_sync_check() { return ${2}; }"
    echo "verify() {"
    cat "$BLOCK"
    echo "  echo REACHED_END"
    echo "  return 0"
    echo "}"
    echo 'verify; echo "rc=$?"'
  } > "$harness"
  run bash "$harness"
}

@test "a FAILING lockfile check stops verification" {
  run_with 0 1
  # The whole point: verification must not continue to the test suite and report success.
  [[ "$output" != *REACHED_END* ]]
  [[ "$output" == *"rc=1"* ]]
}

@test "a PASSING lockfile check lets verification continue" {
  # Guards the opposite failure: a 'fix' that returns non-zero unconditionally would make the
  # test above pass while blocking every story in the pipeline.
  run_with 0 0
  [[ "$output" == *REACHED_END* ]]
  [[ "$output" == *"rc=0"* ]]
}

@test "a FAILING dependency check still stops verification" {
  # Its sibling, already guarded — asserted here so a future edit cannot silently unguard it.
  run_with 1 0
  [[ "$output" != *REACHED_END* ]]
  [[ "$output" == *"rc=1"* ]]
}
