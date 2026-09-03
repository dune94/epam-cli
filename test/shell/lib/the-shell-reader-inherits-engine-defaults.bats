#!/usr/bin/env bats
#
# THE SHELL READER INHERITS THE ENGINE BASE TOO.
#
# resolveLlmSettings answers "what settings does this project run with", but the ladders reach a run
# through TWO readers: lib/seam-invocation.js for the seam layer, and lib/model-ladders.sh for
# everything shell. A resolver only one of them consults gives the pipeline two different answers to
# the same question — which is the defect class this repo has been fighting all week.
#
# So the shell reader is tested here as the RECEIVER: does a project that declares only its
# differences actually get the engine's chains exported into its environment?
#
# The first case is the regression guard: with no defaults declared, exports must be exactly what
# they are today.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  ML="${REPO_ROOT}/orchestrations/scripts/lib/model-ladders.sh"
  [ -f "$ML" ]
  WORK="${BATS_TEST_TMPDIR}/w"
  mkdir -p "$WORK/proj"
  export NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
}

# Runs the real exporter against a project file, with an engine defaults file.
run_export() {
  local defaults="$1" project="$2" var="$3"
  printf '%s' "$defaults" > "$WORK/llm-defaults.json"
  printf '%s' "$project"  > "$WORK/proj/llm-settings.json"
  run bash -c "
    set -uo pipefail
    export EPAM_LLM_DEFAULTS_FILE='$WORK/llm-defaults.json'
    export NODE_BIN='$NODE_BIN'
    . '$ML'
    export_model_ladders '$WORK/proj/llm-settings.json' >/dev/null 2>&1
    printf '%s' \"\${$var:-<unset>}\"
  "
}

@test "with NO engine defaults the project's own chain is exported, exactly as today" {
  run_export '{}' \
    '{"ladderTierOrder":["high"],"ladders":{"high":{"startModel":"p-1","modelLadder":[{"from":"p-1","to":"p-2"}]}}}' \
    EPAM_MODEL_LADDER_HIGH
  [ "$status" -eq 0 ]
  [ "$output" = "p-1=p-2" ]
}

@test "a project that declares NO ladders inherits the engine's" {
  run_export \
    '{"ladderTierOrder":["high"],"ladders":{"high":{"startModel":"e-1","modelLadder":[{"from":"e-1","to":"e-2"}]}}}' \
    '{}' \
    EPAM_MODEL_LADDER_HIGH
  [ "$status" -eq 0 ]
  [ "$output" = "e-1=e-2" ]
}

@test "a project's own chain WINS over the engine's" {
  run_export \
    '{"ladders":{"high":{"startModel":"e-1","modelLadder":[{"from":"e-1","to":"e-2"}]}}}' \
    '{"ladders":{"high":{"startModel":"p-1","modelLadder":[{"from":"p-1","to":"p-2"}]}}}' \
    EPAM_MODEL_LADDER_HIGH
  [ "$status" -eq 0 ]
  [ "$output" = "p-1=p-2" ]
}

@test "a project overriding ONE tier still inherits the others" {
  run_export \
    '{"ladders":{"high":{"startModel":"e-h","modelLadder":[{"from":"e-h","to":"e-top"}]},"medium":{"startModel":"e-m","modelLadder":[{"from":"e-m","to":"e-h"}]}}}' \
    '{"ladders":{"high":{"startModel":"p-h","modelLadder":[{"from":"p-h","to":"p-top"}]}}}' \
    EPAM_MODEL_LADDER_MEDIUM
  [ "$status" -eq 0 ]
  [ "$output" = "e-m=e-h" ]
}

@test "the START model is inherited too, not just the chain" {
  run_export \
    '{"ladders":{"high":{"startModel":"e-start","modelLadder":[{"from":"e-start","to":"e-2"}]}}}' \
    '{}' \
    EPAM_MODEL_LADDER_HIGH_START
  [ "$status" -eq 0 ]
  [ "$output" = "e-start" ]
}

@test "an operator's exported chain still outranks both" {
  # The precedence this file already documents: a launch-time override beats any declaration.
  printf '%s' '{"ladders":{"high":{"startModel":"e-1","modelLadder":[{"from":"e-1","to":"e-2"}]}}}' > "$WORK/llm-defaults.json"
  printf '%s' '{"ladders":{"high":{"startModel":"p-1","modelLadder":[{"from":"p-1","to":"p-2"}]}}}' > "$WORK/proj/llm-settings.json"
  run bash -c "
    set -uo pipefail
    export EPAM_LLM_DEFAULTS_FILE='$WORK/llm-defaults.json'
    export NODE_BIN='$NODE_BIN'
    export EPAM_MODEL_LADDER_HIGH='operator=wins'
    . '$ML'
    export_model_ladders '$WORK/proj/llm-settings.json' >/dev/null 2>&1
    printf '%s' \"\$EPAM_MODEL_LADDER_HIGH\"
  "
  [ "$output" = "operator=wins" ]
}

@test "the REAL shipped config exports exactly the chains it declares" {
  # Fixture-free regression guard against the shipped config — but against the file that OWNS the
  # ladders, which is no longer the project's. The 2026-08-25 migration moved them into the active
  # provider set, so reading metrolinx/llm-settings.json exported nothing and this failed on an
  # architecture working as intended, unnoticed until .bats files first executed on 2026-08-28.
  #
  # And it asserted two literal model names. Those are exactly what a stack is allowed to change:
  # the pair it pinned belonged to a stack this repo no longer runs by default. What must hold is
  # that what the reader EXPORTS is what the set DECLARES — a property that survives every
  # legitimate model change, and still catches a reader that drops or invents a chain.
  local set_file
  set_file="$REPO_ROOT/orchestrations/config/llm-defaults.$(jq -r .defaultSet \
      "$REPO_ROOT/orchestrations/config/provider-sets.json").json"
  [ -f "$set_file" ]

  local declared_highest declared_medium
  declared_highest=$(jq -r '.ladders.highest.startModel // empty' "$set_file")
  declared_medium=$(jq -r '.ladders.medium.startModel // empty' "$set_file")
  [ -n "$declared_highest" ] && [ -n "$declared_medium" ]

  run bash -c "
    set -uo pipefail
    export NODE_BIN='$NODE_BIN'
    . '$ML'
    export_model_ladders '$set_file' >/dev/null 2>&1
    printf '%s|%s' \"\${EPAM_MODEL_LADDER_HIGHEST_START:-}\" \"\${EPAM_MODEL_LADDER_MEDIUM_START:-}\"
  "
  [ "$status" -eq 0 ]
  [ "$output" = "${declared_highest}|${declared_medium}" ] || {
      echo "exported [$output] but the set declares [${declared_highest}|${declared_medium}]"; false; }
}
