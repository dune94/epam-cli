#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE PROJECT ROSTER: DERIVED FROM CANONICAL, EVERY ENTRY ANCESTRED, REVIEWED BEFORE IT LANDS.
#
# Agent identity used to live in five files across two layers with no owner. A project DEFINED two
# agents and INHERITED twenty-five from a roster it shared with the engine and could not override,
# which is why a metrolinx review ran five times with a persona describing this repository.
#
# The shape mirrors the prompt layer on purpose — immutable source, agentic derivation, review
# gate. What makes ancestry load-bearing rather than decorative is that STRUCTURE comes from the
# ancestor: ladder, tool grant, output contract. An agent invented from nothing has none of those,
# and something has to invent them — which is how the engine's registry came to be written during
# a run.
#
# Executed against the real library with a STUB specialiser: no model spend, and the contract is
# exercised rather than described.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/project-roster.js"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"
    CANON="$WORK/canonical.json"
    # A canonical stand-in, not the real one: this asserts the CONTRACT, and pinning it to the
    # live file would make it fail whenever a persona is edited for unrelated reasons.
    cat > "$CANON" <<'JSON'
{
  "review-agent": "You review a change against its criteria and emit a verdict.",
  "typescript-engineer": "You implement changes in TypeScript.",
  "code-graph-detective": "You locate the site of a defect and report it."
}
JSON
}
teardown() { rm -rf "$WORK"; }

# Drive the REAL builder with a stubbed AGENT — one that writes the file, as the seam does.
# `mode` shapes what it writes, so each contract clause is exercised rather than described.
build() {  # $1 = mode
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      const mode = process.argv[4];
      const produce = async ({ canonicalCopyPath, outPath }) => {
        const canonical = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        const agents = {};
        for (const [n, persona] of Object.entries(canonical)) {
          agents[n] = {
            persona: `[project] ${persona} Codeline specifics here.`,
            kind: n.includes("engineer") ? "implementer" : n.includes("detective") ? "investigator" : "seam",
            ancestor: n,
            derivedFromSha256: m.personaDigest(persona),
          };
        }
        if (mode === "bad-kind") agents["review-agent"].kind = "wizard";
        if (mode === "empty-persona") agents["review-agent"].persona = "   ";
        if (mode === "no-ancestor") agents["review-agent"].ancestor = "";
        if (mode === "minted" || mode === "minted-no-ancestor" || mode === "minted-bad-ancestor") {
          const anc = mode === "minted-no-ancestor" ? ""
                    : mode === "minted-bad-ancestor" ? "no-such-agent" : "typescript-engineer";
          agents[mode === "minted" ? "acme-payments-engineer" : mode === "minted-bad-ancestor" ? "impostor-agent" : "orphan-agent"] = {
            persona: "You implement payments on this codeline.", kind: "implementer",
            ancestor: anc, derivedFromSha256: m.personaDigest(canonical[anc] || ""),
          };
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      const review = mode === "rejected"
        ? async () => ({ verdict: "changes_requested", reason: "personas do not match the codeline" })
        : async () => ({ verdict: "approved", findings: [] });
      m.buildProjectRoster({
        canonicalPath: process.argv[2], logDir: process.argv[3] + "/logs",
        projectConfigDir: process.argv[3] + "/project",
        produce, review, attempts: 1, log: () => {},
      }).then(() => process.stdout.write("BUILT"))
        .catch((e) => { process.stdout.write("REFUSED: " + e.message); });
    ' "$LIB" "$CANON" "$WORK" "$1"
}

roster() { cat "$WORK/project/roster.json"; }

@test "the fixture is real — the library loads and canonical has entries" {
    run "$NODE" -e 'const m=require(process.argv[1]); process.stdout.write(typeof m.buildProjectRoster)' "$LIB"
    [ "$output" = "function" ]
    [ "$(jq -r 'keys|length' "$CANON")" -eq 3 ]
}

@test "the run's canonical COPY lands in the log dir, never beside the output" {
    run build normal
    [ "$output" = "BUILT" ] || { echo "$output"; false; }
    [ -f "$WORK/logs/roster-canonical-copy.json" ]
    [ ! -f "$WORK/project/roster-canonical-copy.json" ]
}

@test "EVERY entry names a canonical ancestor and carries its digest" {
    run build normal
    [ "$output" = "BUILT" ]
    bad=$(jq -r '[.agents | to_entries[] | select((.value.ancestor // "") == "")] | length' "$WORK/project/roster.json")
    [ "$bad" -eq 0 ] || { echo "$bad entr(y/ies) with no ancestor"; false; }
    dig=$(jq -r '[.agents | to_entries[] | select((.value.derivedFromSha256 // "") | length != 64)] | length' "$WORK/project/roster.json")
    [ "$dig" -eq 0 ] || { echo "$dig entr(y/ies) with no provenance digest"; false; }
}

@test "CONTENT may diverge from the ancestor without being refused" {
    run build normal
    [ "$output" = "BUILT" ]
    p=$(jq -r '.agents["review-agent"].persona' "$WORK/project/roster.json")
    [[ "$p" == "[project]"* ]] || { echo "the project's persona was not kept: $p"; false; }
    [[ "$p" == *"Codeline specifics here."* ]]
}

@test "an entry that names NO ancestor is refused" {
    # Ancestry is what supplies structure. An entry without it has no ladder and no tool grant,
    # and something downstream has to invent them.
    run build no-ancestor
    [[ "$output" == REFUSED* ]] || { echo "an unancestred entry was accepted: $output"; false; }
    [ ! -f "$WORK/project/roster.json" ]
}

@test "an ancestor that is not in canonical is refused" {
    # Only reachable through a MINTED agent now: a canonical-derived entry cannot name a foreign
    # ancestor, because the builder sets it from what it actually derived from.
    run build minted-bad-ancestor
    [[ "$output" == REFUSED* ]] || { echo "a fabricated ancestor was accepted: $output"; false; }
    [[ "$output" == *"not in canonical"* ]] || { echo "the reason does not name the problem: $output"; false; }
    [ ! -f "$WORK/project/roster.json" ]
}

@test "a MINTED agent must name an ancestor too — that is the whole point" {
    run build minted
    [ "$output" = "BUILT" ] || { echo "$output"; false; }
    [ "$(jq -r '.agents["acme-payments-engineer"].ancestor' "$WORK/project/roster.json")" = "typescript-engineer" ]

    run build minted-no-ancestor
    [[ "$output" == REFUSED* ]] || {
        echo "an agent invented from nothing was accepted — it has no ladder and no tool grant"
        false
    }
}

@test "an unrecognised kind and an empty persona are both refused" {
    run build bad-kind
    [[ "$output" == REFUSED* ]]
    run build empty-persona
    [[ "$output" == REFUSED* ]]
}

@test "a REJECTED review means no roster is written" {
    run build rejected
    [[ "$output" == REFUSED* ]] || { echo "a rejected roster landed: $output"; false; }
    [ ! -f "$WORK/project/roster.json" ]
}

@test "STRUCTURE resolves from the ancestor, not from the roster entry" {
    # The load-bearing property. A minted agent with no seam profile of its own still has a
    # ladder and a tool grant, because its ancestor does.
    run build minted
    [ "$output" = "BUILT" ]
    run "$NODE" -e '
      const m = require(process.argv[1]);
      const roster = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
      const registry = { profiles: { "typescript-engineer": { ladder: "mid", toolGrant: "write" } } };
      const s = m.structureFor("acme-payments-engineer", roster, registry);
      process.stdout.write(JSON.stringify(s));' "$LIB" "$WORK/project/roster.json"
    [[ "$output" == *'"from":"typescript-engineer"'* ]] || { echo "structure did not come from the ancestor: $output"; false; }
    [[ "$output" == *'"ladder":"mid"'* ]]
    [[ "$output" == *'"toolGrant":"write"'* ]]
}

@test "NO MODEL IS CONSULTED to check the contract — this ran with a stub" {
    # Guards the test itself: if the builder needed a live model, none of the above proves
    # anything about a real run, because a real run could not be exercised here at all.
    run build normal
    [ "$output" = "BUILT" ]
    [ -s "$WORK/project/roster.json" ]
}

@test "STALENESS IS ARITHMETIC — a roster whose ancestor has since changed fails its contract" {
    # The property the whole design rests on, and the one a mutation slipped through until this
    # existed. 40 project prompts drifted against their templates precisely because nothing ever
    # asked "is this still derived from what it says it is". Provenance answers that by
    # subtraction: no comparison of prose, no heuristic about which differences matter.
    run build normal
    [ "$output" = "BUILT" ]

    run "$NODE" -e '
      const fs = require("fs");
      const m = require(process.argv[1]);
      const roster = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const canonical = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));

      const before = m.checkRoster(roster, canonical);
      // Canonical moves on — exactly what happened to the reviewer template on 2026-08-19.
      canonical["review-agent"] += " And you must cite the evidence you read.";
      const after = m.checkRoster(roster, canonical);

      process.stdout.write(JSON.stringify({
        beforeOk: before.ok,
        afterOk: after.ok,
        names: after.bad.join(" | "),
      }));' "$LIB" "$WORK/project/roster.json" "$WORK/logs/roster-canonical-copy.json"

    [[ "$output" == *'"beforeOk":true'* ]]  || { echo "the roster was not valid to begin with: $output"; false; }
    [[ "$output" == *'"afterOk":false'* ]]  || { echo "canonical moved and the roster still passed — staleness is invisible"; false; }
    [[ "$output" == *"review-agent"* ]]     || { echo "the stale entry is not named: $output"; false; }
    # and ONLY the entry whose ancestor moved
    [[ "$output" != *"typescript-engineer"* ]] || { echo "unrelated entries were flagged stale too"; false; }
}
