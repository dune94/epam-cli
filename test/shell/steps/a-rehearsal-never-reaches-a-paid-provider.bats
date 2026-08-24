#!/usr/bin/env bats
#
# A REHEARSAL NEVER REACHES A PAID PROVIDER.
#
# Every model call in this pipeline — from bash and from JS alike — execs ai-run.sh, so that is
# where a recorded run is substituted for a live one. The property under test is the expensive
# one to get wrong: with a cassette present, NO configured provider is called, and the fallback
# chain that exists to retry on a paid provider is not consulted either.
#
# These execute the real block extracted from the real script. A test that greps ai-run.sh for
# the word "replay" would pass on a comment.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  SCRIPT="${REPO_ROOT}/orchestrations/scripts/ai-run.sh"
  WORK="${BATS_TEST_TMPDIR}/w"
  mkdir -p "$WORK"

  # The provider-selection block, exactly as the script has it.
  BLOCK="${BATS_TEST_TMPDIR}/block.sh"
  awk '/^# A REHEARSAL REPLACES EVERY PROVIDER/,/^fi$/' "$SCRIPT" > "$BLOCK"
  # The extraction must have found something, or every assertion below is vacuous.
  [ -s "$BLOCK" ]
  grep -q 'providers=("replay")' "$BLOCK"
}

# STDERR IS KEPT SEPARATE. The block announces the rehearsal on stderr, and bats folds stderr
# into $output — so every assertion about "which providers" would really be an assertion about
# the banner. The message is asserted from its own file where a test is about the message.
run_block() {
  run bash -c "
    set -euo pipefail
    PRIMARY_PROVIDER='${1:-}'
    FALLBACKS_RAW='${2:-}'
    source '$BLOCK' 2>'$WORK/err'
    printf '%s\n' \"\${providers[@]}\"
  "
}

@test "with a cassette, the ONLY provider is replay" {
  mkdir -p "$WORK/cassette"
  EPAM_REPLAY_CASSETTE_DIR="$WORK/cassette"
  export EPAM_REPLAY_CASSETTE_DIR
  run_block "qwen" "anthropic,openai"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "replay" ]
  # THE NEGATIVE THAT MATTERS: the configured provider and its paid fallbacks are gone, not
  # merely ordered after replay. A fallback would be reached the moment a replay diverged.
  [ "${#lines[@]}" -eq 1 ]
  [[ "$output" != *qwen* ]]
  [[ "$output" != *anthropic* ]]
  [[ "$output" != *openai* ]]
}

@test "with NO cassette, the configured providers are untouched" {
  unset EPAM_REPLAY_CASSETTE_DIR
  run_block "qwen" "anthropic,openai"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "qwen" ]
  [ "${lines[1]}" = "anthropic" ]
  [ "${lines[2]}" = "openai" ]
}

@test "a cassette path that does not exist REFUSES the run" {
  # Falling through to a paid provider here is the one outcome that must never happen: the
  # operator asked for a rehearsal, and a typo'd path would silently bill them for a real one.
  EPAM_REPLAY_CASSETTE_DIR="$WORK/no-such-cassette"
  export EPAM_REPLAY_CASSETTE_DIR
  run_block "qwen" "anthropic"
  [ "$status" -ne 0 ]
  grep -q "not a directory" "$WORK/err"
  [[ "$output" != *qwen* ]]
}

@test "a run with no provider configured at all still rehearses" {
  # The 'no provider configured' refusal fires far earlier in the script than the substitution,
  # so a rehearsal launched without any provider env would have been rejected before reaching it.
  CHECK="${BATS_TEST_TMPDIR}/check.sh"
  awk '/^# A REHEARSAL BRINGS ITS OWN PROVIDER/,/^fi$/' "$SCRIPT" > "$CHECK"
  [ -s "$CHECK" ]

  mkdir -p "$WORK/cassette"
  run bash -c "
    set -euo pipefail
    PRIMARY_PROVIDER=''
    EPAM_REPLAY_CASSETTE_DIR='$WORK/cassette'
    source '$CHECK'
    printf '%s\n' \"\$PRIMARY_PROVIDER\"
  "
  [ "$status" -eq 0 ]
  [ "$output" = "replay" ]
}
