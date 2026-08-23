#!/usr/bin/env bats
#
# A REHEARSAL CANNOT ESCAPE ITS SANDBOX.
#
# Replay executes the recorded tool calls for real — that fidelity is why the gates downstream
# judge real artefacts, and it is also why one recorded session carries 216 bash calls, 131 of
# them writes, at absolute paths inside working trees. The overlay is what makes that safe, so
# the property under test is the containment itself, proved by writing and then looking outside.
#
# Everything here runs the real rehearse.sh. A test that asserted the script MENTIONS overlayfs
# would pass on a comment.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  REHEARSE="${REPO_ROOT}/orchestrations/scripts/rehearse.sh"
  NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
  export NODE_BIN

  # A TREE TO ISOLATE, and a cassette that declares it. Built here rather than pointed at a real
  # cassette so the test says exactly what it isolates and cannot damage anything if containment
  # is broken — which is the failure this very test exists to detect.
  TREE="${BATS_TEST_TMPDIR}/tree"
  mkdir -p "$TREE/.git"
  echo "original" > "$TREE/file.txt"

  CASSETTE="${BATS_TEST_TMPDIR}/cassette"
  mkdir -p "$CASSETTE"
  cat > "$CASSETTE/manifest.json" <<JSON
{"session":"TEST","roots":["$TREE"],"seams":[]}
JSON
  export EPAM_REHEARSAL_SANDBOX="${BATS_TEST_TMPDIR}/sandbox"
}

@test "a file CREATED by the rehearsal does not exist outside it" {
  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c "echo made-by-rehearsal > '$TREE/created.txt'; cat '$TREE/created.txt'"
  [ "$status" -eq 0 ]
  # It really ran and really wrote — otherwise the containment assertion below is vacuous.
  [[ "$output" == *"made-by-rehearsal"* ]]
  [ ! -f "$TREE/created.txt" ]
}

@test "a file OVERWRITTEN by the rehearsal is unchanged outside it" {
  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c "echo clobbered > '$TREE/file.txt'; cat '$TREE/file.txt'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"clobbered"* ]]
  [ "$(cat "$TREE/file.txt")" = "original" ]
}

@test "a file DELETED by the rehearsal still exists outside it" {
  # The most dangerous shape: git restores a tracked file, but nothing restores an untracked one
  # the rehearsal removed. Containment is what makes that irrelevant.
  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c "rm -f '$TREE/file.txt'; test ! -e '$TREE/file.txt' && echo gone-inside"
  [ "$status" -eq 0 ]
  [[ "$output" == *"gone-inside"* ]]
  [ -f "$TREE/file.txt" ]
  [ "$(cat "$TREE/file.txt")" = "original" ]
}

@test "the rehearsal REPORTS what it wrote, rather than discarding it unseen" {
  # A rehearsal whose effects vanish unseen tells the operator only whether it crashed.
  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c "echo a > '$TREE/one.txt'; echo b > '$TREE/two.txt'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"wrote 2 file(s)"* ]]
}

@test "a cassette that declares no roots REFUSES to run anything" {
  # Running unisolated is the one outcome that must never happen by omission: the operator asked
  # for a rehearsal and would get a real run against real trees.
  EMPTY="${BATS_TEST_TMPDIR}/norotors"
  mkdir -p "$EMPTY"
  echo '{"session":"TEST","roots":[],"seams":[]}' > "$EMPTY/manifest.json"

  run bash "$REHEARSE" --cassette "$EMPTY" -- bash -c "echo SHOULD_NOT_RUN > '$TREE/nope.txt'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"cannot be isolated"* ]]
  [ ! -f "$TREE/nope.txt" ]
}

@test "no cassette at all is refused — a rehearsal without a recording would call a paid provider" {
  run bash "$REHEARSE" -- bash -c "echo SHOULD_NOT_RUN > '$TREE/nope.txt'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"--cassette is required"* ]]
  [ ! -f "$TREE/nope.txt" ]
}

@test "the cassette is exported to the run, so the pipeline replays instead of calling out" {
  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c 'echo "CASSETTE=[$EPAM_REPLAY_CASSETTE_DIR]"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"CASSETTE=[$CASSETTE]"* ]]
}

@test "a DIRECTORY removed by the rehearsal really goes, and comes back outside" {
  # The pipeline removes directories routinely — pre-run-reset clears the generated prompt layer
  # on every run. Unprivileged overlayfs cannot write the whiteout that records a deletion unless
  # it is mounted with userxattr, and without it every such removal failed with a bare
  # "Input/output error": the rehearsal diverged from the run it was rehearsing, and said so in a
  # way that looked like a disk fault.
  mkdir -p "$TREE/subdir"
  echo "inside the dir" > "$TREE/subdir/thing.txt"

  run bash "$REHEARSE" --cassette "$CASSETTE" -- \
      bash -c "rm -rf '$TREE/subdir' && test ! -e '$TREE/subdir' && echo removed-inside"
  [ "$status" -eq 0 ]
  [[ "$output" == *"removed-inside"* ]]

  # ...and outside, it is exactly as it was.
  [ -d "$TREE/subdir" ]
  [ "$(cat "$TREE/subdir/thing.txt")" = "inside the dir" ]
}
