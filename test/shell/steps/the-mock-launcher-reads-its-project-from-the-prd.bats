#!/usr/bin/env bats
#
# THE MOCK LAUNCHER TAKES ITS PROJECT FROM THE PRD IT WAS GIVEN.
#
# tier3-mock-run.sh describes itself as "parameterized for a disposable mock project instead of a
# fixed one" and parameterizes the PRD and the project root — while naming ONE project in code for
# the config dir. So a run launched with mock3's PRD was configured from another project's
# settings: its ladders, its plugin list, its per-model budgets. Silently, and only visible in one
# line of launcher output.
#
# Found by rehearsing the pipeline against a recorded run, at no cost. A real run would have spent
# money to reach the same line.
#
# The PRD already names its project, and the PRD is already a parameter, so there is nothing here
# to configure — only something to stop hardcoding.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  SCRIPT="${REPO_ROOT}/orchestrations/scripts/tier3-mock-run.sh"
  NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"

  BLOCK="${BATS_TEST_TMPDIR}/block.sh"
  awk '/^# THE PROJECT IS THE ONE THE PRD NAMES/,/^export EPAM_PROJECT_CONFIG_DIR=/' "$SCRIPT" > "$BLOCK"
  [ -s "$BLOCK" ]
}

run_block() {
  run bash -c "
    set -euo pipefail
    REPO_ROOT='$REPO_ROOT'
    NODE_BIN='$NODE_BIN'
    PRD_ARG='${1}'
    fail() { echo \"FAIL: \$*\"; exit 1; }
    source '${REPO_ROOT}/orchestrations/scripts/lib/project-config.sh'
    source '$BLOCK'
    printf '%s\n' \"\$EPAM_PROJECT_CONFIG_DIR\"
  "
}

@test "a PRD naming mock3 resolves mock3's config, not some other project's" {
  PRD="${BATS_TEST_TMPDIR}/prd.json"
  cat > "$PRD" <<'JSON'
{"title":"t","project":{"name":"mock3"},"stories":[]}
JSON
  run_block "$PRD"
  [ "$status" -eq 0 ]
  [[ "$output" == *"/orchestrations/projects/mock3"* ]]
  # THE NEGATIVE THAT MATTERS: no other project's directory, whatever the launcher used to name.
  [[ "$output" != *"hello-dolly"* ]]
}

@test "a PRD naming a different project resolves THAT project" {
  # Proves the resolution is real rather than a second constant that happens to match.
  PRD="${BATS_TEST_TMPDIR}/prd2.json"
  cat > "$PRD" <<'JSON'
{"title":"t","project":{"name":"hello-dolly"},"stories":[]}
JSON
  run_block "$PRD"
  [ "$status" -eq 0 ]
  [[ "$output" == *"/orchestrations/projects/hello-dolly"* ]]
  [[ "$output" != *"mock3"* ]]
}

@test "a PRD that names no project is REFUSED, not guessed" {
  # Guessing is how a run ends up configured from a project nobody chose — the defect above.
  PRD="${BATS_TEST_TMPDIR}/prd3.json"
  echo '{"title":"t","stories":[]}' > "$PRD"
  run_block "$PRD"
  [ "$status" -ne 0 ]
  [[ "$output" == *"names no project"* ]]
}
