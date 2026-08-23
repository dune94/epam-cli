#!/usr/bin/env bats
#
# COPY THE RUN BEFORE DELETING IT.
#
# pre-run-reset archived the LOGS and deleted everything else: the roster it minted, the briefs it
# wrote, the assignments it made, and all 37 project prompts — `rm -rf` on the prompts directory.
#
# Those artefacts are what a run's behaviour is actually decided by. Deleting them means a killed
# run leaves nothing to diagnose from, and no real artefact to build a test fixture out of. On
# 2026-08-23 that cost twice: a defect in the reviewer's brief block could only be found by reading
# what a live run had left behind, and killing the next run destroyed the prompts a test needed, so
# they had to be restored from git.
#
# The archive directory already existed for logs. This is the same idea applied to the files that
# matter more.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  RESET="${REPO_ROOT}/orchestrations/scripts/pre-run-reset.sh"

  # The three clearing blocks, extracted from the real script and run against a fixture estate.
  BLOCK="${BATS_TEST_TMPDIR}/clear.sh"
  # THROUGH THE CLOSING `fi`, not to the message. A range that stops on the last interesting line
  # cuts an `if` in half and the block fails to parse — which reads as the code being broken
  # rather than the extraction. Same mistake made twice today; this ends on the terminator.
  awk '
    /^_ASSIGN_DIR=/ { inb = 1 }
    inb { print; if (/Cleared \$\{_PROMPTS_N\} project prompt/) seen = 1 }
    seen && /^fi$/ { exit }
  ' "$RESET" > "$BLOCK"
  [ -s "$BLOCK" ]
  grep -q 'cp -p' "$BLOCK"

  WORK="${BATS_TEST_TMPDIR}/w"
  mkdir -p "$WORK/cfg/prompts" "$WORK/logs"
  export ARCHIVE_DIR="$WORK/logs/archive/pre-run-TEST"
  export _PROJECT_CFG_DIR="$WORK/cfg"
  export LOG_DIR="$WORK/logs"

  printf '{"roles":["a-engineer"]}\n'          > "$WORK/cfg/project-roles.json"
  printf '{"investigators":["b-detective"]}\n' > "$WORK/cfg/project-investigators.json"
  printf '{"profiles":{"a-engineer":"BRIEF"}}\n' > "$WORK/cfg/agent-profiles.json"
  printf '{"a-engineer":"story-1"}\n'          > "$WORK/logs/role-assignments.json"
  printf '{"id":"team-lead-review"}\n'         > "$WORK/cfg/prompts/team-lead-review.json"
  printf '{"id":"failure-analyst"}\n'          > "$WORK/cfg/prompts/failure-analyst.json"
}

run_clear() {
  run bash -c "
    set -uo pipefail
    ARCHIVE_DIR='$ARCHIVE_DIR'; _PROJECT_CFG_DIR='$_PROJECT_CFG_DIR'; LOG_DIR='$LOG_DIR'
    _ROSTER_CLEARED=0; _GEN_CLEARED=0
    info() { echo \"\$*\"; }
    source '$BLOCK'
  "
}

@test "the minted roster and briefs are COPIED before they are deleted" {
  run_clear
  [ "$status" -eq 0 ]
  # Gone from the live location...
  [ ! -f "${WORK}/cfg/agent-profiles.json" ]
  [ ! -f "${WORK}/cfg/project-roles.json" ]
  # ...and preserved, with their content, in the archive.
  [ -f "${ARCHIVE_DIR}/generated/agent-profiles.json" ]
  grep -q "BRIEF" "${ARCHIVE_DIR}/generated/agent-profiles.json"
  [ -f "${ARCHIVE_DIR}/generated/project-roles.json" ]
}

@test "the project prompts are COPIED before the directory is wiped" {
  # This was `rm -rf` on the directory: 37 prompts, the only record of what each agent was told,
  # destroyed at the start of every run.
  run_clear
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "${WORK}/cfg/prompts" 2>/dev/null)" ]
  [ -f "${ARCHIVE_DIR}/prompts/team-lead-review.json" ]
  [ -f "${ARCHIVE_DIR}/prompts/failure-analyst.json" ]
  grep -q "failure-analyst" "${ARCHIVE_DIR}/prompts/failure-analyst.json"
}

@test "the live locations really are cleared — the copy is not instead of the reset" {
  # The reset exists to stop a run inheriting the last one's state. An archive that left the
  # originals in place would be worse than no archive at all.
  run_clear
  [ "$status" -eq 0 ]
  [ ! -f "${WORK}/cfg/project-investigators.json" ]
  [ ! -f "${WORK}/logs/role-assignments.json" ]
  [ ! -f "${WORK}/cfg/prompts/team-lead-review.json" ]
}

@test "nothing to archive leaves no wreckage and no stray archive" {
  # ASSERTS BEHAVIOUR, NOT THE BLOCK'S EXIT CODE. The clearing section ends in
  # `[ "$_PROMPTS_N" -gt 0 ] && info ...`, so with nothing to clear its last statement is false and
  # the extracted block exits 1. In the real script that status is discarded — it sits mid-file
  # under `set -uo pipefail`, not `set -e`. Asserting 0 here would test my extraction rather than
  # the reset, and would fail for a reason that cannot happen in production.
  #
  # (Worth knowing: if that section were ever wrapped in `set -e`, a project with no prompts would
  # abort the reset silently at that line. Noted, not changed on my own initiative.)
  rm -rf "${WORK}/cfg/prompts"/*.json "${WORK}/cfg"/*.json "${WORK}/logs/role-assignments.json"
  run_clear
  # Nothing was archived, because there was nothing to archive...
  [ ! -e "${ARCHIVE_DIR}/prompts" ] || [ -z "$(ls -A "${ARCHIVE_DIR}/prompts" 2>/dev/null)" ]
  # ...and the prompts directory still exists, recreated empty, ready for this run's mint.
  [ -d "${WORK}/cfg/prompts" ]
  [[ "$output" != *"No such file"* ]]
}
