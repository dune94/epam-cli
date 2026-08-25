#!/usr/bin/env bats
#
# THE EFFORT MAP RESOLVES FROM THE LADDER, AND FROM NOTHING ELSE.
#
# EFFORT_MODEL_LOW/MEDIUM/HIGH defaulted to the literal `gpt-5-codex` — all three tiers to the SAME
# model, and one with no entry in any ladder. The effort axis collapsed to a constant: across 211
# archived story records, 205 carry an identical assigned model.
#
# The replacement reads the tier START models the ladder library already exports
# (EPAM_MODEL_LADDER_<TIER>_START), indexed by the project's DECLARED tier order, so a project that
# names its tiers differently — or declares four — still resolves without claude.sh knowing any of
# their names.
#
# WHY THIS FILE EXISTS: I verified that function ONCE, by hand, in a throwaway bash probe, and
# shipped it. A manual probe proves it worked the moment I ran it and nothing afterwards. Every run
# that has died this week died on something verified exactly that way.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  CLAUDE_SH="${REPO_ROOT}/orchestrations/scripts/claude.sh"
  FN="${BATS_TEST_TMPDIR}/fn.sh"
  awk '/^_effort_model_for_position\(\)/,/^}/' "$CLAUDE_SH" > "$FN"
  [ -s "$FN" ]
  grep -q '_START' "$FN"
}

# Runs the real function with a given tier order and set of START models.
resolve() {
  local position="$1"; shift
  run bash -c "
    set -uo pipefail
    $*
    source '$FN'
    _effort_model_for_position '$position'
  "
}

@test "each effort position takes the START model of its tier, lowest to highest" {
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
             export EPAM_MODEL_LADDER_MEDIUM_START="model-A"
             export EPAM_MODEL_LADDER_HIGH_START="model-B"
             export EPAM_MODEL_LADDER_HIGHEST_START="model-C"'
  resolve low "$env";    [ "$output" = "model-A" ]
  resolve medium "$env"; [ "$output" = "model-B" ]
  resolve high "$env";   [ "$output" = "model-C" ]
}

@test "a project may name its tiers ANYTHING — no tier name is known to this file" {
  # The whole point of reading the declared order: 'medium/high/highest' is this project's
  # vocabulary, not the engine's.
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="cheap standard premium"
             export EPAM_MODEL_LADDER_CHEAP_START="c"
             export EPAM_MODEL_LADDER_STANDARD_START="s"
             export EPAM_MODEL_LADDER_PREMIUM_START="p"'
  resolve low "$env";    [ "$output" = "c" ]
  resolve medium "$env"; [ "$output" = "s" ]
  resolve high "$env";   [ "$output" = "p" ]
}

@test "a project declaring MORE tiers than three still resolves the first three" {
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="t1 t2 t3 t4"
             export EPAM_MODEL_LADDER_T1_START="one"
             export EPAM_MODEL_LADDER_T2_START="two"
             export EPAM_MODEL_LADDER_T3_START="three"
             export EPAM_MODEL_LADDER_T4_START="four"'
  resolve low "$env";  [ "$output" = "one" ]
  resolve high "$env"; [ "$output" = "three" ]
}

@test "a project declaring FEWER tiers falls back to the highest it has, never to nothing" {
  # Two tiers must still answer for 'high' — otherwise the caller fails on a project that is
  # simply configured more simply.
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="a b"
             export EPAM_MODEL_LADDER_A_START="first"
             export EPAM_MODEL_LADDER_B_START="second"'
  resolve high "$env";   [ "$output" = "second" ]
  resolve medium "$env"; [ "$output" = "second" ]
  resolve low "$env";    [ "$output" = "first" ]
}

@test "NO ladder declared resolves to EMPTY — never to a model literal" {
  # The defect this replaces. Empty is the point: the caller fails loudly rather than calling a
  # model nobody chose.
  resolve low 'unset EPAM_MODEL_LADDER_TIER_ORDER || true'
  [ "$output" = "" ]
}

@test "a tier with no START model resolves to EMPTY, not to another tier's model" {
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
             export EPAM_MODEL_LADDER_MEDIUM_START="only-this-one"'
  resolve high "$env"
  [ "$output" = "" ]
}

@test "an unknown position is refused rather than guessed" {
  local env='export EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
             export EPAM_MODEL_LADDER_MEDIUM_START="m"'
  resolve nonsense "$env"
  [ "$output" = "" ]
}

@test "the REAL project config resolves all three to real, distinct models" {
  # Fixture-free: the actual metrolinx ladders, through the actual ladder library.
  run bash -c "
    set -uo pipefail
    SCRIPT_DIR='${REPO_ROOT}/orchestrations/scripts'
    . \"\$SCRIPT_DIR/lib/model-ladders.sh\" 2>/dev/null
    export_model_ladders '${REPO_ROOT}/orchestrations/projects/metrolinx/llm-settings.json' >/dev/null 2>&1
    source '$FN'
    printf '%s|%s|%s' \"\$(_effort_model_for_position low)\" \"\$(_effort_model_for_position medium)\" \"\$(_effort_model_for_position high)\"
  "
  [ "$status" -eq 0 ]
  # Three non-empty, and not all the same — the collapse this replaces.
  IFS='|' read -r LOW MED HIGH <<< "$output"
  [ -n "$LOW" ] && [ -n "$MED" ] && [ -n "$HIGH" ]
  [ "$LOW" != "$MED" ]
  [ "$MED" != "$HIGH" ]
}
