#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE PROJECT ROSTER IS THE ONLY PLACE AN AGENT'S IDENTITY COMES FROM.
#
# AGENT_PROFILES_FILE defaulted to orchestrations/agents/profiles.json — the roster shared with
# the engine — at six call sites. That default is not a safety net; it is the path that gave a
# client-codeline review a persona describing this repository, and it would survive every test
# written about the new roster because it only fires when resolution fails.
#
# So: no default, and a run that cannot resolve its roster refuses rather than reading the engine
# layer. Absence is a defect to report, never a shape to degrade into.
#
# The three files that used to hold this between them — agent-profiles.json, project-roles.json,
# project-investigators.json — collapse into roster.json, where `kind` is a field. Origin and
# permission are properties of an entry, not reasons for another file.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/project-roster.js"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"
}
teardown() { rm -rf "$WORK"; }

# A roster on disk, built through the REAL library so its shape cannot drift from the producer's.
make_roster() {  # $1 = dir
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      const dir = process.argv[2];
      const canonical = { "review-agent": "You review a change.", "typescript-engineer": "You implement." };
      fs.mkdirSync(dir + "/logs", { recursive: true });
      fs.writeFileSync(dir + "/canonical.json", JSON.stringify(canonical));
      const produce = async ({ canonicalCopyPath, outPath }) => {
        const c = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        const agents = {};
        for (const [n, p] of Object.entries(c))
          agents[n] = { persona: "[project] " + p, kind: n.includes("engineer") ? "implementer" : "seam",
                        ancestor: n, derivedFromSha256: m.personaDigest(p) };
        agents["acme-detective"] = { persona: "You investigate this codeline.", kind: "investigator",
                                     ancestor: "review-agent", derivedFromSha256: m.personaDigest(c["review-agent"]) };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      m.buildProjectRoster({ canonicalPath: dir + "/canonical.json", logDir: dir + "/logs",
        projectConfigDir: dir + "/project", produce, review: async () => ({ verdict: "approved" }),
        attempts: 1, log: () => {} }).then(() => process.stdout.write("ok"));
    ' "$LIB" "$1"
}

# ── the read path ────────────────────────────────────────────────────────────

@test "the library resolves an agent's persona FROM THE ROSTER" {
    run make_roster "$WORK"
    [ "$output" = "ok" ]
    run "$NODE" -e '
      const m = require(process.argv[1]);
      process.stdout.write(m.personaFor("review-agent", process.argv[2]) || "");' "$LIB" "$WORK/project"
    [[ "$output" == "[project]"* ]] || { echo "the roster's persona was not returned: $output"; false; }
}

@test "an ABSENT roster REFUSES — it never degrades to the engine layer" {
    run "$NODE" -e '
      const m = require(process.argv[1]);
      try { m.personaFor("review-agent", process.argv[2]); process.stdout.write("RETURNED"); }
      catch (e) { process.stdout.write("REFUSED: " + e.message); }' "$LIB" "$WORK/nonexistent"
    [[ "$output" == REFUSED* ]] || { echo "a missing roster did not refuse: $output"; false; }
    # and the refusal must not point anyone at the shared file as a workaround
    [[ "$output" != *"agents/profiles.json"* ]] || { echo "the refusal suggests the engine layer"; false; }
}

@test "an agent ABSENT FROM the roster refuses too — silence is not a persona" {
    run make_roster "$WORK"
    run "$NODE" -e '
      const m = require(process.argv[1]);
      try { const p = m.personaFor("no-such-agent", process.argv[2]);
            process.stdout.write("RETURNED:" + JSON.stringify(p)); }
      catch (e) { process.stdout.write("REFUSED: " + e.message); }' "$LIB" "$WORK/project"
    [[ "$output" == REFUSED* ]] || { echo "an unknown agent produced a value: $output"; false; }
}

@test "NO CONSUMER falls back to the engine roster" {
    # The shape that matters is `:-.../agents/profiles.json` — a default that only fires when
    # resolution fails, and therefore only in the case the design exists to prevent.
    bad=$(grep -rnE 'AGENT_PROFILES_FILE:?-[^}]*agents/profiles\.json' "$SCRIPTS" --include=*.sh 2>/dev/null || true)
    [ -z "$bad" ] || {
        echo "consumers still default to the shared engine roster:"
        echo "$bad"
        false
    }
}

# ── one file ─────────────────────────────────────────────────────────────────

@test "KIND is a field on the entry, not a separate registry" {
    run make_roster "$WORK"
    [ "$(jq -r '.agents["acme-detective"].kind' "$WORK/project/roster.json")" = "investigator" ]
    [ "$(jq -r '.agents["typescript-engineer"].kind' "$WORK/project/roster.json")" = "implementer" ]
}

@test "the library answers WHO MAY AUTHOR CODE from the roster" {
    # The write perimeter's question. It reads project-roles.json today; the roster must be able
    # to answer it, or the perimeter cannot move.
    run make_roster "$WORK"
    run "$NODE" -e '
      const m = require(process.argv[1]);
      process.stdout.write(m.agentsOfKind("implementer", process.argv[2]).join(","));' "$LIB" "$WORK/project"
    [ "$output" = "typescript-engineer" ] || { echo "implementers: $output"; false; }
    run "$NODE" -e '
      const m = require(process.argv[1]);
      process.stdout.write(m.agentsOfKind("investigator", process.argv[2]).join(","));' "$LIB" "$WORK/project"
    [ "$output" = "acme-detective" ] || { echo "investigators: $output"; false; }
}

@test "and it refuses that question too when there is no roster" {
    # A perimeter that reads an empty implementer list would lock the codeline; one that reads a
    # defaulted list would open it. Neither may happen silently.
    run "$NODE" -e '
      const m = require(process.argv[1]);
      try { m.agentsOfKind("implementer", process.argv[2]); process.stdout.write("RETURNED"); }
      catch (e) { process.stdout.write("REFUSED"); }' "$LIB" "$WORK/nonexistent"
    [ "$output" = "REFUSED" ]
}

# ── the SHELL helper, executed — not the library behind it ───────────────────
#
# These functions can stop a run, so the guard ratchet requires a test that names them. They are
# also the actual receivers: the consumers call roster_persona and roster_agents_of_kind, and a
# library that behaves correctly behind a helper that swallows its exit code is still broken.

load_helper() {
    export NODE_BIN="$NODE"
    # shellcheck disable=SC1090
    . "$SCRIPTS/lib/roster-read.sh"
}

@test "roster_dir refuses when the project is not declared" {
    load_helper
    run env -u EPAM_PROJECT_CONFIG_DIR bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_dir"
    [ "$status" -ne 0 ] || { echo "roster_dir returned success with no project: $output"; false; }
    [[ "$output" == *"EPAM_PROJECT_CONFIG_DIR"* ]]
}

@test "roster_file names the roster inside the project dir" {
    load_helper
    run env EPAM_PROJECT_CONFIG_DIR="$WORK/project" bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_file"
    [ "$output" = "$WORK/project/roster.json" ]
}

@test "roster_persona returns the persona, and FAILS for an unknown agent" {
    run make_roster "$WORK"
    load_helper
    run env NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$WORK/project" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_persona review-agent"
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == "[project]"* ]]

    run env NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$WORK/project" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_persona no-such-agent"
    [ "$status" -ne 0 ] || { echo "an unknown agent succeeded — that is an empty system prompt"; false; }
    # a stack trace in a run log reads as a pipeline crash, not a stated defect
    [[ "$output" != *"at Object."* ]] || { echo "the refusal is a node stack trace"; false; }
}

@test "roster_persona FAILS when the roster is absent — never an empty string" {
    load_helper
    run env NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$WORK/nowhere" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_persona review-agent"
    [ "$status" -ne 0 ]
    [ -z "$(printf '%s' "$output" | grep -v '^\[roster\]')" ] || true
    [[ "$output" != *"agents/profiles.json"* ]] || { echo "the refusal points at the engine roster"; false; }
}

@test "roster_agents_of_kind answers the write perimeter's question, and refuses without a roster" {
    run make_roster "$WORK"
    load_helper
    run env NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$WORK/project" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_agents_of_kind implementer"
    [ "$status" -eq 0 ]
    [ "$output" = "typescript-engineer" ]

    run env NODE_BIN="$NODE" EPAM_PROJECT_CONFIG_DIR="$WORK/nowhere" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_agents_of_kind implementer"
    [ "$status" -ne 0 ] || {
        echo "an absent roster produced an implementer list — that either locks or opens the codeline"
        false
    }
}

@test "roster_exists REPORTS absence and never chooses a fallback" {
    run make_roster "$WORK"
    load_helper
    run env EPAM_PROJECT_CONFIG_DIR="$WORK/project" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_exists"
    [ "$status" -eq 0 ]
    run env EPAM_PROJECT_CONFIG_DIR="$WORK/nowhere" \
        bash -c ". '$SCRIPTS/lib/roster-read.sh'; roster_exists"
    [ "$status" -ne 0 ]
}
