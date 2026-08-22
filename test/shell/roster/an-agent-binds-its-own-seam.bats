#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# WHICH SEAM AN AGENT ENTERS BY IS A PROPERTY OF THAT AGENT.
#
# The mint wrote `agentSeams` into orchestrations/agents/invocation-profiles.json — a per-project
# cross-reference stored in the file the ENGINE owns. So one project's minted agents were mapped
# in a registry every other project reads, and the mint wrote the engine layer on every run to
# maintain it.
#
# Operator's model: project prompts are tied explicitly to project profiles. The same holds for
# seams — an agent's identity says who it is, what kind it is, what it derives from, and now which
# seam it enters by. One entry, one place, and the engine registry goes back to describing seams
# rather than recording who uses them.
#
# CANONICAL AGENTS NEED NO BINDING: a profile whose name IS a seam resolves by exact name, which
# already wins over everything. The binding exists for MINTED agents, whose names the engine
# cannot know.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"; mkdir -p "$WORK/proj"
    "$NODE" -e '
      const fs = require("fs");
      const { personaDigest } = require(process.argv[2]);
      fs.writeFileSync(process.argv[1], JSON.stringify({ agents: {
        "acme-payments-engineer": { persona: "implements payments", kind: "implementer",
          ancestor: "typescript-engineer", derivedFromSha256: personaDigest("x"),
          seam: "story-writer" },
        "roster-review": { persona: "judges a roster", kind: "seam", ancestor: "review-agent",
          derivedFromSha256: personaDigest("y") },
      } }, null, 2));' "$WORK/proj/roster.json" "$SCRIPTS/lib/project-roster.js"
}
teardown() { rm -rf "$WORK"; }

resolve() {  # $1 = agent
    env EPAM_PROJECT_CONFIG_DIR="$WORK/proj" "$NODE" -e '
      const m = require(process.argv[1]);
      try { process.stdout.write(m.resolveSeam(process.argv[2])); }
      catch (e) { process.stdout.write("REFUSED: " + (e && e.message)); }
    ' "$SCRIPTS/lib/seam-invocation.js" "$1"
}

@test "the fixture is real — the roster loads and carries a minted agent" {
    run "$NODE" -e '
      const m = require(process.argv[1]);
      const r = m.loadRoster(process.argv[2]);
      process.stdout.write(Object.keys(r.agents).join(","));' "$SCRIPTS/lib/project-roster.js" "$WORK/proj"
    [[ "$output" == *"acme-payments-engineer"* ]]
}

@test "A MINTED AGENT ENTERS BY THE SEAM ITS ROSTER ENTRY NAMES" {
    run resolve acme-payments-engineer
    [ "$output" = "story-writer" ] || { echo "resolved to '$output', not the roster's seam"; false; }
}

@test "an agent that IS a seam resolves by exact name — no binding needed" {
    # A profile whose name IS a seam wins over everything, which is why only minted agents carry
    # a binding at all. Asserted with roster-review, which the registry defines: my first version
    # used review-agent, which is NOT a profile — so exact-match never applied and the test was
    # asserting the wrong rule.
    run resolve roster-review
    [ "$output" = "roster-review" ]
}

@test "a binding naming a seam the registry does not define is REFUSED" {
    "$NODE" -e '
      const fs = require("fs");
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      r.agents["acme-payments-engineer"].seam = "no-such-seam";
      fs.writeFileSync(process.argv[1], JSON.stringify(r, null, 2));' "$WORK/proj/roster.json"
    run resolve acme-payments-engineer
    [[ "$output" == REFUSED* ]] || { echo "a fabricated seam was accepted: $output"; false; }
    [[ "$output" == *"no-such-seam"* ]]
}

@test "NOTHING reads agentSeams from the engine registry any more" {
    bad=$(grep -rn 'agentSeams' "$SCRIPTS" --include=*.js --include=*.sh 2>/dev/null \
          | grep -vE ':[0-9]+:[[:space:]]*(#|//|\*)' || true)
    [ -z "$bad" ] || {
        echo "the engine registry is still the source of an agent's seam:"
        echo "$bad"
        false
    }
}

@test "and the mint no longer writes the registry to maintain it" {
    bad=$(grep -n 'writeFileSync(registryPath' "$SCRIPTS/mint-agents-step.js" || true)
    [ -z "$bad" ] || { echo "the mint still writes the engine registry: $bad"; false; }
}

@test "a bogus seam binding is refused WHERE THE ROSTER IS WRITTEN, not at first use" {
    # It would otherwise pass review, land on disk, and throw at whichever invocation happened to
    # reach that agent — mid-run, after the roster looked accepted.
    run "$NODE" -e '
      const m = require(process.argv[1]);
      const canonical = { "typescript-engineer": "impl" };
      const base = { persona: "p", kind: "implementer", ancestor: "typescript-engineer",
                     derivedFromSha256: m.personaDigest("impl") };
      const out = [];
      out.push("none:"  + m.checkEntry("a", base, canonical).ok);
      out.push("valid:" + m.checkEntry("a", { ...base, seam: "story-writer" }, canonical).ok);
      out.push("bogus:" + m.checkEntry("a", { ...base, seam: "no-such-seam" }, canonical).ok);
      out.push("empty:" + m.checkEntry("a", { ...base, seam: "  " }, canonical).ok);
      process.stdout.write(out.join(" "));' "$SCRIPTS/lib/project-roster.js"
    [ "$output" = "none:true valid:true bogus:false empty:false" ] || {
        echo "seam validation is wrong: $output"; false; }
}
