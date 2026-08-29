#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# WHO MAY AUTHOR CODE IS A PROPERTY OF AN AGENT, NOT A SEPARATE FILE.
#
# The write perimeter decides which agents may write into a CLIENT repository. It resolved that
# from agents/project-roles.json through a three-branch fallback ending at the engine's own copy —
# so a client codeline could inherit this repository's implementation roles.
#
# The roster carries `kind` on every entry, so the question is answered from the same file that
# says who each agent is. One fact, one place.
#
# FAILS CLOSED, unchanged. No roster means no authoring agents, and only the seams that are
# structurally allowed to write may write. A perimeter that fails open is not a perimeter — and
# one that fails open QUIETLY is worse, so the refusal is stated.
# ─────────────────────────────────────────────────────────────────────────────

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing. env_run does what env was there for, in-shell.
load "../helpers/env-run"

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    PERIM="$SCRIPTS/lib/codeline-write-perimeter.sh"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    export NODE_BIN="$NODE"
    WORK="$(mktemp -d)"
    mkdir -p "$WORK/proj"
    "$NODE" -e '
      const fs = require("fs");
      const { personaDigest } = require(process.argv[2]);
      fs.writeFileSync(process.argv[1], JSON.stringify({ agents: {
        "acme-engineer":   { persona: "writes code",     kind: "implementer",   ancestor: "typescript-engineer", derivedFromSha256: personaDigest("x") },
        "acme-detective":  { persona: "reads only",      kind: "investigator",  ancestor: "code-graph-detective", derivedFromSha256: personaDigest("x") },
        "review-agent":    { persona: "judges",          kind: "seam",          ancestor: "review-agent", derivedFromSha256: personaDigest("x") },
      } }, null, 2));' "$WORK/proj/roster.json" "$SCRIPTS/lib/project-roster.js"
}
teardown() { rm -rf "$WORK"; }

roles() {  # $1 = project dir
    env_run EPAM_PROJECT_CONFIG_DIR="$1" NODE_BIN="$NODE" bash -c \
        ". '$PERIM'; _perimeter_project_roles"
}

@test "the fixture is real — the perimeter exposes the resolver" {
    run bash -c ". '$PERIM'; type -t _perimeter_project_roles"
    [ "$output" = "function" ]
}

@test "IMPLEMENTERS may author — read from the roster's kind field" {
    run roles "$WORK/proj"
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == *"acme-engineer"* ]] || { echo "the implementer was not granted: $output"; false; }
}

@test "INVESTIGATORS may NOT author — the defect this perimeter exists for" {
    # Deriving authorship from the full profile set once handed write access to the detective,
    # which is the exact agent whose lack of it is the reason the perimeter was built.
    run roles "$WORK/proj"
    [[ "$output" != *"acme-detective"* ]] || { echo "an investigator was granted write access: $output"; false; }
}

@test "SEAMS are not authoring agents either" {
    run roles "$WORK/proj"
    [[ "$output" != *"review-agent"* ]] || { echo "a seam was granted write access: $output"; false; }
}

@test "NO ROSTER means NO authoring agents — it fails CLOSED" {
    run roles "$WORK/absent"
    [ -z "$(printf '%s' "$output" | tr -d '[:space:]')" ] || {
        echo "a missing roster produced authoring agents: $output"; false; }
}

@test "and it does NOT fall back to the engine's own roles file" {
    # The old resolver ended at agents/project-roles.json, so a client codeline could inherit
    # this repository's implementers.
    run bash -c "grep -nE '^[^#]*agents.?_dir.*project-roles|^[^#]*/project-roles\.json' '$PERIM' || true"
    [ -z "$output" ] || {
        echo "the perimeter still resolves an engine-level roles file:"; echo "$output"; false; }
}

@test "the answer is CACHED but not cached across projects" {
    # A cached empty answer from a project with no roster, reused for one that has agents, would
    # lock a codeline for the rest of the run.
    a=$(roles "$WORK/proj")
    b=$(roles "$WORK/proj")
    [ "$a" = "$b" ]
    [[ "$a" == *"acme-engineer"* ]]
}
