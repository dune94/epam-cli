#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE LADDERS RESOLVE CORRECTLY AND NEVER ARRIVE.
#
# ladder-position-resolution.bats fixed the lookup: a seam declaring `top` now gets the top chain.
# That fix moves nothing if no chain is ever exported, and on the orchestrate.sh path none is.
#
# run-agent-orchestration.sh:279:
#
#     export_model_ladders "${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json" || true
#
# orchestrate.sh takes `--project <name>` and never exports EPAM_PROJECT_CONFIG_DIR. The three
# tier3 launchers each export it — with three separate resolutions — so the defect is invisible
# whenever a tier3 launcher is used, and total whenever orchestrate.sh is.
#
# The path becomes "/llm-settings.json". export_model_ladders jq's a file that does not exist,
# gets nothing, exports nothing, and RETURNS 0. Measured:
#
#     $ export_model_ladders "/llm-settings.json"; echo $?
#     0
#     TIER_ORDER=[UNSET]
#
# So the engine's own guard — which prints a loud warning when the loader is missing — never fires,
# because the loader is present and cheerfully reports success on an absent project. Every seam
# then declines or falls back, and the run dies at the first agent it needs. Live: the ingest run
# died at discovery-vocabulary-agent, and the log said only "failed".
#
# Absence read as success, for the third time in this pipeline.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LADDERS="$SCRIPTS/lib/model-ladders.sh"
    PROJECT_CONFIG="$SCRIPTS/lib/project-config.sh"
}

# A settings file declaring two tiers and their order.
fixture_settings() {
    cat > "$1" <<'JSON'
{
  "ladderTierOrder": ["low", "hot"],
  "ladders": {
    "low": { "modelLadder": [ { "from": "a", "to": "b" } ] },
    "hot": { "modelLadder": [ { "from": "c", "to": "d" } ] }
  }
}
JSON
}

# ── The contract: absent must not read as success ────────────────────────────

@test "export_model_ladders REFUSES a settings file that is not there" {
    run bash -c 'source "'"$LADDERS"'"; export_model_ladders "/nope/llm-settings.json"'
    [ "$status" -ne 0 ]
}

@test "and says WHICH file it could not read — a bare failure is not diagnosable" {
    run bash -c 'source "'"$LADDERS"'"; export_model_ladders "/nope/llm-settings.json" 2>&1'
    [[ "$output" == *"/nope/llm-settings.json"* ]]
}

@test "an UNPARSEABLE settings file is a failure too, not an empty ladder set" {
    printf 'not json at all' > "$BATS_TEST_TMPDIR/bad.json"
    run bash -c 'source "'"$LADDERS"'"; export_model_ladders "'"$BATS_TEST_TMPDIR"'/bad.json"'
    [ "$status" -ne 0 ]
}

@test "a real settings file still succeeds and exports the chains" {
    fixture_settings "$BATS_TEST_TMPDIR/s.json"
    run bash -c 'source "'"$LADDERS"'"
        export_model_ladders "'"$BATS_TEST_TMPDIR"'/s.json" || exit 9
        echo "ORDER=[${EPAM_MODEL_LADDER_TIER_ORDER:-}] HOT=[${EPAM_MODEL_LADDER_HOT:-}]"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"ORDER=[low hot]"* ]]
    [[ "$output" == *"HOT=[c=d]"* ]]
}

@test "a settings file declaring NO ladders is a failure — nothing downstream can run" {
    echo '{"ladderTierOrder":[]}' > "$BATS_TEST_TMPDIR/empty.json"
    run bash -c 'source "'"$LADDERS"'"; export_model_ladders "'"$BATS_TEST_TMPDIR"'/empty.json"'
    [ "$status" -ne 0 ]
}

# ── The resolution: one definition, not a fourth copy ────────────────────────

@test "resolving a project's config dir is a library, not a per-launcher copy" {
    [ -f "$PROJECT_CONFIG" ]
}

@test "a named project resolves to its directory" {
    run bash -c 'source "'"$PROJECT_CONFIG"'"; project_config_dir metrolinx "'"$REPO_ROOT"'"'
    [ "$status" -eq 0 ]
    [ "$output" = "$REPO_ROOT/orchestrations/projects/metrolinx" ]
}

@test "a project that does not exist FAILS — never a path that happens to be empty" {
    run bash -c 'source "'"$PROJECT_CONFIG"'"; project_config_dir no-such-project "'"$REPO_ROOT"'"'
    [ "$status" -ne 0 ]
    [[ "$output" == *"no-such-project"* ]]
}

@test "an explicit EPAM_PROJECT_CONFIG_DIR outranks the name — the operator's override stands" {
    mkdir -p "$BATS_TEST_TMPDIR/custom"
    run bash -c 'source "'"$PROJECT_CONFIG"'"
        EPAM_PROJECT_CONFIG_DIR="'"$BATS_TEST_TMPDIR"'/custom" project_config_dir "" "'"$REPO_ROOT"'"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"/custom"* ]]
}

@test "naming NOTHING fails rather than defaulting to some project" {
    # A default here launches a run against a codeline nobody asked for.
    #
    # Asserted so it cannot pass vacuously: with the library deleted the `source` fails and the
    # command substitution is non-zero for a reason that has nothing to do with the requirement.
    # The function must be PRESENT and must refuse.
    run bash -c 'source "'"$PROJECT_CONFIG"'"
        command -v project_config_dir >/dev/null || { echo NOFUNC; exit 77; }
        project_config_dir "" "'"$REPO_ROOT"'" && echo RESOLVED'
    [ "$status" -ne 0 ]
    [ "$status" -ne 77 ]
    [[ "$output" != *"RESOLVED"* ]]
    [[ "$output" != *"NOFUNC"* ]]
}

# ── The receiver: does the engine actually get the chains? ───────────────────

@test "orchestrate.sh hands the engine a config dir it can load ladders from" {
    # The whole chain, without launching anything: resolve as orchestrate.sh now does, then run
    # the engine's own export line against the result and read what a seam would inherit.
    run bash -c '
        source "'"$PROJECT_CONFIG"'"
        source "'"$LADDERS"'"
        dir=$(project_config_dir metrolinx "'"$REPO_ROOT"'") || exit 8
        export EPAM_PROJECT_CONFIG_DIR="$dir"
        export_model_ladders "${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json" || exit 9
        echo "ORDER=[${EPAM_MODEL_LADDER_TIER_ORDER:-UNSET}]"'
    [ "$status" -eq 0 ]
    [[ "$output" != *"UNSET"* ]]
}

@test "and orchestrate.sh does NOT resolve it with a copy of its own" {
    body=$(cat "$SCRIPTS/orchestrate.sh")
    echo "$body" | grep -q 'project-config.sh'
    # A second literal projects/<name> assembly in the launcher is the copy this replaces.
    ! echo "$body" | grep -E 'EPAM_PROJECT_CONFIG_DIR=.*orchestrations/projects' | grep -qv 'project_config_dir'
}

# ─────────────────────────────────────────────────────────────────────────────
# AND THE LINES THEMSELVES RUN.
#
# The test above greps orchestrate.sh, and a grep for EPAM_PROJECT_CONFIG_DIR passes on the COMMENT
# explaining why the export exists. Deleting the export outright left it green — measured, by
# mutation. A test that cannot tell an export from a comment about an export is not a test.
#
# So the real block is cut out of the real file and executed. orchestrate.sh itself is never run:
# it setsid re-execs and tears down a run directory, and running it under test has already started
# two live jobs by accident. Extracting the region and executing it is the pattern the existing
# orchestration tests use, and it fails when the export is removed.
# ─────────────────────────────────────────────────────────────────────────────

# The config-dir resolution region of orchestrate.sh, verbatim.
resolution_block() {
    awk '/^# THE PROJECT.S CONFIG DIRECTORY/,/^CONFIG=/' "$SCRIPTS/orchestrate.sh"
}

@test "the extracted block is really the launcher's own — not an empty match" {
    block=$(resolution_block)
    [ -n "$block" ]
    # Guard against the region markers drifting and this whole section going vacuous.
    echo "$block" | grep -q 'project_config_dir'
    [ "$(echo "$block" | wc -l)" -gt 5 ]
}

@test "RUNNING orchestrate.sh's own lines exports the config dir" {
    cat > "$BATS_TEST_TMPDIR/blk.sh" <<EOS
set -uo pipefail
SCRIPT_DIR="$SCRIPTS"
REPO_ROOT="$REPO_ROOT"
PROJECT="metrolinx"
$(resolution_block)
echo "EXPORTED=[\${EPAM_PROJECT_CONFIG_DIR:-UNSET}]"
EOS
    run bash "$BATS_TEST_TMPDIR/blk.sh"
    [ "$status" -eq 0 ]
    [ "${lines[${#lines[@]}-1]}" = "EXPORTED=[$REPO_ROOT/orchestrations/projects/metrolinx]" ]
}

@test "and a child process INHERITS it — an unexported assignment reaches no engine" {
    cat > "$BATS_TEST_TMPDIR/child.sh" <<'EOS'
echo "CHILD_SEES=[${EPAM_PROJECT_CONFIG_DIR:-UNSET}]"
EOS
    cat > "$BATS_TEST_TMPDIR/blk2.sh" <<EOS
set -uo pipefail
SCRIPT_DIR="$SCRIPTS"
REPO_ROOT="$REPO_ROOT"
PROJECT="metrolinx"
$(resolution_block)
bash "$BATS_TEST_TMPDIR/child.sh"
EOS
    run bash "$BATS_TEST_TMPDIR/blk2.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"CHILD_SEES=[$REPO_ROOT/orchestrations/projects/metrolinx]"* ]]
    [[ "$output" != *"UNSET"* ]]
}

@test "an unknown project makes the launcher REFUSE, not launch something else" {
    cat > "$BATS_TEST_TMPDIR/blk3.sh" <<EOS
set -uo pipefail
SCRIPT_DIR="$SCRIPTS"
REPO_ROOT="$REPO_ROOT"
PROJECT="definitely-not-a-project"
$(resolution_block)
echo "REACHED_LAUNCH"
EOS
    run bash "$BATS_TEST_TMPDIR/blk3.sh"
    [ "$status" -ne 0 ]
    [[ "$output" != *"REACHED_LAUNCH"* ]]
}
