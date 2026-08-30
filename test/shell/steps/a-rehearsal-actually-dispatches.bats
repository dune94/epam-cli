#!/usr/bin/env bats
#
# A REHEARSAL MUST ACTUALLY DISPATCH.
#
# Selecting a provider and being able to RUN one are two different things, and the gap between
# them is invisible to a test that only checks selection. `replay` was wired into the provider
# list while `run_provider_once` had no arm for it, so every rehearsal would have fallen to the
# default case and failed — a provider declared and never consumed, the same class of defect as a
# seam whose ladder nothing reads.
#
# This runs the REAL ai-run.sh end to end against a stubbed CLI, so what is asserted is what the
# script did, not what a block of it would do in isolation.

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing and failed for a reason that had nothing to do with the pipeline.
load "../helpers/env-run"

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  # llm-handler.sh, not ai-run.sh: the provider block moved when eight independent paths to a
  # vendor API were consolidated into one hub, leaving ai-run.sh a logic-free shim. The test
  # extracted from the shim, found nothing, and failed on its own vacuity guard — into the
  # void, because no runner executed .bats files at all.
  SCRIPT="${REPO_ROOT}/orchestrations/scripts/llm-handler.sh"
  WORK="${BATS_TEST_TMPDIR}/w"
  mkdir -p "$WORK/cassette"

  # A STUB CLI that records how it was invoked and answers with the shape ai-run.sh requires: a
  # JSON line carrying `result`. Stubbed rather than real, because what is under test is the
  # dispatch — whether the CLI is reached at all, and with which provider.
  STUB="$WORK/epam-stub"
  cat > "$STUB" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_ARGV_LOG"
cat > "$STUB_STDIN_LOG"
printf '{"result":"the recorded answer"}\n'
SH
  chmod +x "$STUB"
  export STUB_ARGV_LOG="$WORK/argv.log"
  export STUB_STDIN_LOG="$WORK/stdin.log"
}

@test "a cassette makes ai-run dispatch through the CLI as provider 'replay'" {
  run env_run EPAM_CLI="$STUB" \
      EPAM_REPLAY_CASSETTE_DIR="$WORK/cassette" \
      AI_PROVIDER="" EPAM_ORCHESTRATION_PROVIDER="" AI_MODEL="" \
      bash "$SCRIPT" <<< "rehearse this"

  # IT REACHED THE CLI AT ALL. Without a dispatch arm the case statement falls through and the
  # provider loop reports failure without ever invoking anything — and the log stays empty.
  [ -f "$STUB_ARGV_LOG" ]
  [ -s "$STUB_ARGV_LOG" ]
  [[ "$(cat "$STUB_ARGV_LOG")" == *"--provider replay"* ]]

  # AND IT SUCCEEDED, carrying the answer back to the caller.
  [ "$status" -eq 0 ]
  [[ "$output" == *"the recorded answer"* ]]

  # The prompt really travelled: an empty stdin would mean the rehearsal ran on nothing.
  [ -s "$STUB_STDIN_LOG" ]
  grep -q "rehearse this" "$STUB_STDIN_LOG"
}

@test "without a cassette the configured provider is dispatched, not replay" {
  # The negative half. A substitution that fired unconditionally would silently replay every run,
  # including the paid ones the operator meant to make.
  run env_run EPAM_CLI="$STUB" \
      AI_PROVIDER="openrouter" AI_MODEL="" \
      bash "$SCRIPT" <<< "run this for real"

  [ "$status" -eq 0 ]
  [ -s "$STUB_ARGV_LOG" ]
  [[ "$(cat "$STUB_ARGV_LOG")" == *"--provider openrouter"* ]]
  [[ "$(cat "$STUB_ARGV_LOG")" != *"replay"* ]]
}
