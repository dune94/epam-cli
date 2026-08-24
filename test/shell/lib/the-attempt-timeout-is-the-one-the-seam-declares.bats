#!/usr/bin/env bats
#
# THE ATTEMPT TIMEOUT IS THE ONE THE SEAM DECLARES.
#
# invocation-profiles.json gives each seam a timeoutSecs, and seam-invocation.js exports it as
# EPAM_TIMEOUT_SECS. ai-run.sh's per-attempt watchdog reads EPAM_CALL_ATTEMPT_TIMEOUT_SECS,
# defaulting to 240. Nothing ever mapped one name to the other, so the declared value was exported
# and read by nobody: 36 of 39 seams declare more than 240s and not one of them received it.
#
# The failure mode is the worst kind. The watchdog SIGTERMs the process group, which produces no
# stderr, so ai-run reports "failed with no error output", burns all three ladder attempts on the
# same silent kill, and the agent looks broken. On 2026-08-23 roster-specialiser and
# project-roster-review (1800s declared, 240s given) failed exactly this way three runs in a row.
#
# This asserts the watchdog honours the declared value, using a real kill against a real sleep.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  AI_RUN="${REPO_ROOT}/orchestrations/scripts/ai-run.sh"
  FN="${BATS_TEST_TMPDIR}/fn.sh"
  # Extract the watchdog through its closing brace.
  awk '/^_ai_attempt_timeout\(\)/,/^}/' "$AI_RUN" > "$FN"
  [ -s "$FN" ]
  grep -q '_secs=' "$FN"
}

# Runs the watchdog around a sleep longer than the budget, and reports how long it actually took.
elapsed_for() {
  local budget_env="$1" sleep_for="$2"
  run bash -c "
    set -uo pipefail
    $budget_env
    source '$FN'
    _start=\$SECONDS
    _ai_attempt_timeout sleep $sleep_for >/dev/null 2>&1 || true
    echo \$(( SECONDS - _start ))
  "
}

@test "a seam's declared EPAM_TIMEOUT_SECS is what the watchdog waits" {
  # THE DEFECT: with only EPAM_TIMEOUT_SECS set, the watchdog fell back to 240 and this sleep
  # would run to completion well inside it, so the budget was never applied at all.
  elapsed_for "export EPAM_TIMEOUT_SECS=2" 12
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  [ "$output" -le 6 ]
}

@test "an explicit EPAM_CALL_ATTEMPT_TIMEOUT_SECS still wins over the seam's value" {
  # The operator override must stay an override; the seam value is a default for it.
  elapsed_for "export EPAM_TIMEOUT_SECS=60 EPAM_CALL_ATTEMPT_TIMEOUT_SECS=2" 12
  [ "$status" -eq 0 ]
  [ "$output" -le 6 ]
}

@test "with neither declared, the 240s default is unchanged" {
  # Proves the fix adds a source for the value rather than altering the fallback.
  run bash -c "
    set -uo pipefail
    unset EPAM_TIMEOUT_SECS EPAM_CALL_ATTEMPT_TIMEOUT_SECS
    source '$FN'
    declare -f _ai_attempt_timeout | grep -o ':-240'
  "
  [ "$status" -eq 0 ]
  [ "$output" = ":-240" ]
}

@test "the watchdog still returns the command's own output and status on success" {
  # A timeout fix that swallowed stdout would break every agent that succeeds.
  run bash -c "
    set -uo pipefail
    export EPAM_TIMEOUT_SECS=30
    source '$FN'
    _ai_attempt_timeout echo hello
  "
  [ "$status" -eq 0 ]
  [ "$output" = "hello" ]
}
