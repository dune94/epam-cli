#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A LAUNCHER'S PRE-FLIGHT IS EXECUTED UNDER `set -u`, NOT PARSED.
#
# The metrolinx launcher died 39 seconds into a run — before ingest — on
# `tier3-metrolinx-run.sh: line 274: NODE_BIN: unbound variable`. I had written a pre-flight block
# using "$NODE_BIN" in a script that never sets it and runs under set -u.
#
# NOTHING COULD SEE IT. `bash -n` checks syntax and an unbound variable is not a syntax error.
# `shellcheck -S error` does not report it either — verified. So preflight-static.sh reported
# "shell runtime errors: 0" over a line guaranteed to abort the run.
#
# A static scan for this class over-reports badly: a variable the environment genuinely supplies
# (EPAM_EFFORT_TIER, PROJECT_ROOT) looks identical to one nobody sets. So this executes the block
# instead — the receiver pattern used throughout this suite — with a fixture environment and
# nothing else defined. If it references a name the launcher does not have, it aborts here.
# ─────────────────────────────────────────────────────────────────────────────

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing and failed for a reason that had nothing to do with the pipeline.
load "../helpers/env-run"

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LAUNCHER="$SCRIPTS/tier3-metrolinx-run.sh"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"; mkdir -p "$WORK/proj"
    printf '%s' '{"stories":[{"id":"T-1","agentRole":"acme-engineer"}]}' > "$WORK/prd.json"
    "$NODE" -e '
      const fs = require("fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({ agents: {
        "acme-engineer": { persona: "p", kind: "implementer", ancestor: "typescript-engineer",
                           derivedFromSha256: "x".repeat(64) } } }));' "$WORK/proj/roster.json"
}
teardown() { rm -rf "$WORK"; }

# The real block, lifted from the launcher by the marker that opens it.
perimeter_block() {
    # To the block's CLOSING `fi`, not to a phrase inside it. Stopping at "nothing to verify" cut
    # the else-branch mid-statement and bash reported "unexpected end of file" — a truncated
    # extraction that the assertions would then have blamed on the launcher.
    awk '/THE SAME SOURCE THE PERIMETER READS/{f=1}
         f{print; if (seen && /^[[:space:]]*fi[[:space:]]*$/) exit; if (/nothing to verify/) seen=1}' \
        "$LAUNCHER"
}

@test "the fixture is real — the pre-flight block is still in the launcher" {
    run perimeter_block
    [ -n "$output" ] || { echo "the block is gone or its marker changed — this test is stale"; false; }
    [[ "$output" == *"roster_agents_of_kind"* ]]
}

@test "IT RUNS UNDER set -u with a roster present" {
    blk="$(perimeter_block)"
    run env_run -u NODE_BIN EPAM_PROJECT_CONFIG_DIR="$WORK/proj" PRD_FILE="$WORK/prd.json" \
        bash -c "set -euo pipefail
                 error(){ echo \"ERR: \$*\"; }; info(){ echo \"INFO: \$*\"; }
                 . '$SCRIPTS/lib/roster-read.sh'
                 $blk"
    [[ "$output" != *"unbound variable"* ]] || {
        echo "the pre-flight references a name the launcher does not set:"
        echo "$output"
        false
    }
    [ "$status" -eq 0 ] || { echo "the block failed under set -u:"; echo "$output"; false; }
    [[ "$output" == *"implementer in this project's roster"* ]] || {
        echo "the block did not reach its verdict — this proves nothing: $output"; false; }
}

@test "and under set -u with NO roster — the first-run path" {
    # The other branch. A first run has no roster, and the block must report that rather than
    # abort: refusing here would block the very run that produces one.
    blk="$(perimeter_block)"
    run env_run -u NODE_BIN EPAM_PROJECT_CONFIG_DIR="$WORK/absent" PRD_FILE="$WORK/prd.json" \
        bash -c "set -euo pipefail
                 error(){ echo \"ERR: \$*\"; }; info(){ echo \"INFO: \$*\"; }
                 . '$SCRIPTS/lib/roster-read.sh'
                 $blk"
    [[ "$output" != *"unbound variable"* ]] || { echo "$output"; false; }
    [ "$status" -eq 0 ]
    [[ "$output" == *"no roster yet"* ]]
}

@test "an agentRole the roster does not hold is REFUSED, not warned" {
    printf '%s' '{"stories":[{"id":"T-1","agentRole":"nobody-agent"}]}' > "$WORK/prd.json"
    blk="$(perimeter_block)"
    run env_run -u NODE_BIN EPAM_PROJECT_CONFIG_DIR="$WORK/proj" PRD_FILE="$WORK/prd.json" \
        bash -c "set -euo pipefail
                 error(){ echo \"ERR: \$*\"; }; info(){ echo \"INFO: \$*\"; }
                 . '$SCRIPTS/lib/roster-read.sh'
                 $blk"
    [ "$status" -ne 0 ] || { echo "an unregistered role passed the gate: $output"; false; }
    [[ "$output" == *"nobody-agent"* ]]
}
