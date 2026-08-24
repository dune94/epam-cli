#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# ONE AGENT WRITES THE ROSTER. THE PIPELINE VALIDATES WHAT IT WROTE.
#
# Operator: "the roster agent writes out the roster with proper tools; the review agent reads the
# new roster and reviews."
#
# So the producer is a SEAM, not a loop of per-entry calls the pipeline drives: the agent is given
# the canonical copy and a path, it writes the file with its own tools, and the pipeline checks
# the artefact. A per-entry callback would be one model call per canonical entry every run, and
# would also let the pipeline decide the shape of each persona — which is the pipeline doing the
# agent's thinking.
#
# WHAT IS ASSERTED HERE IS WIRING AND CONTRACT, executed with a stubbed runner: that the seam is
# declared, that its prompt exists in the template layer and asks for what the caller supplies,
# that the review receives BOTH roster and canonical, and that an unwritten or malformed artefact
# is refused rather than assumed. No model is called.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/project-roster.js"
    TEMPLATES="$REPO_ROOT/orchestrations/prompts/templates"
    REGISTRY="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"
    CANON="$WORK/canonical.json"
    cat > "$CANON" <<'JSON'
{
  "review-agent": "You review a change against its criteria and emit a verdict.",
  "typescript-engineer": "You implement changes in TypeScript."
}
JSON
}
teardown() { rm -rf "$WORK"; }

# ── the seam is declared as DATA ─────────────────────────────────────────────

@test "a roster-specialiser seam is declared, with a ladder and a tool grant" {
    run "$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      const find = (o) => { for (const k in o) { const v = o[k];
        if (v && typeof v === "object") { if (k === "roster-specialiser") return v; const r = find(v); if (r) return r; } }
        return null; };
      const s = find(p);
      process.stdout.write(s ? JSON.stringify({ ladder: s.ladder, toolGrant: s.toolGrant,
        template: s.template, model: s.model || null, maxIterations: s.maxIterations || null }) : "");
    ' "$REGISTRY"
    [ -n "$output" ] || { echo "no roster-specialiser seam in the registry"; false; }
    [[ "$output" == *'"ladder"'* ]] || { echo "the seam declares no ladder: $output"; false; }
    [[ "$output" == *'"toolGrant"'* ]] || { echo "the seam declares no tool grant: $output"; false; }
    # The ladder owns the budget; a seam naming a model or an iteration count is the defect
    # the ladder exists to remove.
    [[ "$output" == *'"model":null'* ]] || { echo "the seam names a model: $output"; false; }
    [[ "$output" == *'"maxIterations":null'* ]] || { echo "the seam names an iteration count: $output"; false; }
}

@test "its prompt lives in the TEMPLATE layer, not in code" {
    tpl=$("$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      const find = (o) => { for (const k in o) { const v = o[k];
        if (v && typeof v === "object") { if (k === "roster-specialiser") return v; const r = find(v); if (r) return r; } }
        return null; };
      const s = find(p); process.stdout.write(s && s.template ? s.template : "");' "$REGISTRY")
    [ -n "$tpl" ] || { echo "the seam names no template"; false; }
    [ -f "$TEMPLATES/$tpl.json" ] || { echo "no template at $TEMPLATES/$tpl.json"; false; }
}

@test "the specialisation prompt carries NO project fact and NO agent list" {
    tpl=$("$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      const find = (o) => { for (const k in o) { const v = o[k];
        if (v && typeof v === "object") { if (k === "roster-specialiser") return v; const r = find(v); if (r) return r; } }
        return null; };
      const s = find(p); process.stdout.write(s && s.template ? s.template : "");' "$REGISTRY")
    run "$NODE" -e '
      const d = require(process.argv[1]);
      const body = typeof d.body === "string" ? d.body : Object.values(d.bodies || {}).join("\n");
      const bad = [];
      // no project may be named, and the agents to specialise arrive as data, never as a list
      for (const p of require("fs").readdirSync(process.argv[2]))
        if (new RegExp("\\\\b" + p + "\\\\b", "i").test(body)) bad.push("names project " + p);
      if (/\bmetrolinx|contentstack\b/i.test(body)) bad.push("names a client fact");
      if (/review-agent|typescript-engineer|code-graph-detective/.test(body)) bad.push("hardcodes an agent name");
      process.stdout.write(bad.join("; "));' "$TEMPLATES/$tpl.json" "$REPO_ROOT/orchestrations/projects"
    [ -z "$output" ] || { echo "$output"; false; }
}

# ── the producer is a seam that WRITES, and the artefact is validated ────────

# Drive the real builder with a stubbed agent. `mode` shapes what the "agent" writes.
build() {
    "$NODE" -e '
      const fs = require("fs");
      const m = require(process.argv[1]);
      const mode = process.argv[4];
      const canonicalPath = process.argv[2], work = process.argv[3];
      const produce = async ({ canonicalCopyPath, outPath }) => {
        if (mode === "writes-nothing") return;
        const canonical = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        if (mode === "malformed") { fs.mkdirSync(require("path").dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, "not json"); return; }
        const agents = {};
        for (const [n, persona] of Object.entries(canonical)) {
          agents[n] = { persona: "[project] " + persona, kind: n.includes("engineer") ? "implementer" : "seam",
                        ancestor: n, derivedFromSha256: m.personaDigest(persona) };
        }
        if (mode === "drops-one") delete agents["review-agent"];
        fs.mkdirSync(require("path").dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      let sawRoster = false, sawCanonical = false;
      const review = async ({ roster, canonical }) => {
        sawRoster = !!(roster && roster.agents); sawCanonical = !!(canonical && Object.keys(canonical).length);
        return mode === "rejected" ? { verdict: "changes_requested", reason: "not this codeline" }
                                   : { verdict: "approved", findings: [] };
      };
      m.buildProjectRoster({ canonicalPath, logDir: work + "/logs",
        projectConfigDir: work + "/project", produce, review, attempts: 1, log: () => {} })
        .then(() => process.stdout.write("BUILT sawRoster=" + sawRoster + " sawCanonical=" + sawCanonical))
        .catch((e) => process.stdout.write("REFUSED: " + e.message));
    ' "$LIB" "$CANON" "$WORK" "$1"
}

@test "the agent writes the roster; the pipeline validates the artefact" {
    run build normal
    [[ "$output" == BUILT* ]] || { echo "$output"; false; }
    [ -f "$WORK/project/roster.json" ]
    [ "$(jq -r '.agents | length' "$WORK/project/roster.json")" -eq 2 ]
}

@test "REVIEW RECEIVES BOTH the roster and canonical" {
    # With only the roster it can judge plausibility. Falsifying "is this ancestor close" and
    # "was inherited structure quietly changed" needs the source too.
    run build normal
    [[ "$output" == *"sawRoster=true"* ]]  || { echo "review never saw the roster: $output"; false; }
    [[ "$output" == *"sawCanonical=true"* ]] || { echo "review never saw canonical: $output"; false; }
}

@test "an agent that writes NOTHING is refused — absence is not success" {
    run build writes-nothing
    [[ "$output" == REFUSED* ]] || { echo "a missing roster read as success: $output"; false; }
    [ ! -f "$WORK/project/roster.json" ]
}

@test "an unparseable roster is refused, and never left on disk" {
    run build malformed
    [[ "$output" == REFUSED* ]] || { echo "malformed output was accepted: $output"; false; }
}

@test "a roster missing a canonical agent is refused — the set must be complete" {
    # No subset logic anywhere: whatever canonical holds, the roster holds. The moment a subset
    # is allowed, something must decide which agents matter, and a fallback to the engine layer
    # has to exist for the rest.
    run build drops-one
    [[ "$output" == REFUSED* ]] || { echo "an incomplete roster was accepted: $output"; false; }
    [[ "$output" == *"review-agent"* ]] || { echo "the missing agent is not named: $output"; false; }
}

@test "a rejected review writes nothing" {
    run build rejected
    [[ "$output" == REFUSED* ]]
    [ ! -f "$WORK/project/roster.json" ]
}

@test "SKIPPING THE MINT still derives the roster — a resume is not identity-less" {
    # EPAM_SKIP_AGENT_MINT is honoured on every writer-style resume, deliberately: the merge is
    # additive and re-minting accumulated duplicate roles. Deriving the roster is not minting.
    # Without this a resumed run reaches its first seam with no persona for it, and there is no
    # engine roster to fall back to any more.
    blk=$(awk '/Agent mint skipped \(EPAM_SKIP_AGENT_MINT=1\)/{f=1} f{print; if(/^  fi$/) exit}' \
          "$SCRIPTS/run-agent-orchestration.sh")
    [ -n "$blk" ] || { echo "the skip branch is gone — this test is stale"; false; }
    [[ "$blk" == *"EPAM_ROSTER_ONLY=1"* ]] || {
        echo "the skip path does not derive a roster; a resumed run would have no identities"; false; }
    [[ "$blk" == *"PIPESTATUS[0]"* ]] || {
        echo "the status is read from the pipeline, so tee's success would mask a failed derivation"; false; }
}

# The roster-only EXECUTION test lived here and was VACUOUS: it ran the step with no --prd, so it
# returned at the argument check and never reached the stage, while asserting the absence of a
# ReferenceError on output that had none because nothing ran. Three runtime bugs shipped behind it.
# Replaced by the-roster-stage-actually-executes.bats, which supplies enough fixture to enter the
# stage and asserts a POSITIVE — that it reaches the model call.

@test "the roster stage is defined BEFORE both of its call sites" {
    def=$(grep -n 'const runRosterStage' "$SCRIPTS/mint-agents-step.js" | head -1 | cut -d: -f1)
    [ -n "$def" ]
    for line in $(grep -n 'await runRosterStage' "$SCRIPTS/mint-agents-step.js" | cut -d: -f1); do
        [ "$line" -gt "$def" ] || { echo "call at $line precedes the definition at $def"; false; }
    done
}

@test "A FAILED REVIEW does not discard a roster that passed its contract" {
    # Live 2026-08-23: the reviewer returned its own PLAN as a blocking finding, with verdict
    # 'nothing_to_review'. That was translated to changes_requested, so a roster that had SATISFIED
    # its contract was deleted and regenerated — paying for new work and blaming the artefact for
    # the judge's failure. The schema draws three states on purpose: examined-and-sound,
    # examined-and-defective, did-not-examine. All three must survive the translation.
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      const canonicalPath = process.argv[2], work = process.argv[3];
      let produced = 0;
      const produce = async ({ canonicalCopyPath, outPath }) => {
        produced += 1;
        const c = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        const agents = {};
        for (const [n, p] of Object.entries(c))
          agents[n] = { persona: "[p] " + p, kind: "seam", ancestor: n,
                        derivedFromSha256: m.personaDigest(p) };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      let reviews = 0;
      const review = async () => {
        reviews += 1;
        // Fails to examine twice, then works — the shape actually observed.
        if (reviews < 3) return { verdict: "review_failed", reason: "returned a plan, not a review" };
        return { verdict: "approved", findings: [] };
      };
      m.buildProjectRoster({ canonicalPath, logDir: work + "/logs",
        projectConfigDir: work + "/project", produce, review, attempts: 3, log: () => {} })
        .then(() => process.stdout.write(`BUILT produced=${produced} reviews=${reviews}`))
        .catch((e) => process.stdout.write("REFUSED: " + e.message));
    ' "$LIB" "$CANON" "$WORK" > "$WORK/out.txt"
    out=$(cat "$WORK/out.txt")

    [[ "$out" == BUILT* ]] || { echo "a recoverable review failure sank the run: $out"; false; }
    # THE POINT: the specialiser ran ONCE. Two review failures cost the reviewer, not the roster.
    [[ "$out" == *"produced=1"* ]] || {
        echo "the roster was regenerated for a failure that was not its own: $out"; false; }
    [[ "$out" == *"reviews=3"* ]] || { echo "the review was not retried: $out"; false; }
}

@test "a review that NEVER examines the roster halts, and says the roster is not implicated" {
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      const produce = async ({ canonicalCopyPath, outPath }) => {
        const c = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        const agents = {};
        for (const [n, p] of Object.entries(c))
          agents[n] = { persona: "[p] " + p, kind: "seam", ancestor: n,
                        derivedFromSha256: m.personaDigest(p) };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      const review = async () => ({ verdict: "review_failed", reason: "returned a plan" });
      m.buildProjectRoster({ canonicalPath: process.argv[2], logDir: process.argv[3] + "/logs",
        projectConfigDir: process.argv[3] + "/project", produce, review, attempts: 2, log: () => {} })
        .then(() => process.stdout.write("BUILT"))
        .catch((e) => process.stdout.write("REFUSED: " + e.message));
    ' "$LIB" "$CANON" "$WORK" > "$WORK/out2.txt"
    out=$(cat "$WORK/out2.txt")
    [[ "$out" == REFUSED* ]] || { echo "an unreviewed roster was accepted: $out"; false; }
    [[ "$out" == *"review is what failed"* ]] || {
        echo "the halt blames the roster instead of the review: $out"; false; }
}

@test "a RUNNER FAILURE costs one attempt, not the whole stage" {
    # Live 2026-08-23: "prompt runner exited with code 1" propagated straight out of an unguarded
    # await and ended the stage having used NONE of its three attempts — after a previous attempt
    # had already produced a contract-passing roster. Declaring attempts:3 and spending zero of
    # them on a transient is the same as declaring one.
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      let calls = 0;
      const produce = async ({ canonicalCopyPath, outPath }) => {
        calls += 1;
        if (calls === 1) throw new Error("prompt runner exited with code 1");
        const c = JSON.parse(fs.readFileSync(canonicalCopyPath, "utf8"));
        const agents = {};
        for (const [n, p] of Object.entries(c))
          agents[n] = { persona: "[p] " + p, kind: "seam", ancestor: n,
                        derivedFromSha256: m.personaDigest(p) };
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify({ agents }, null, 2));
      };
      m.buildProjectRoster({ canonicalPath: process.argv[2], logDir: process.argv[3] + "/logs",
        projectConfigDir: process.argv[3] + "/project", produce,
        review: async () => ({ verdict: "approved" }), attempts: 3, log: () => {} })
        .then(() => process.stdout.write("BUILT calls=" + calls))
        .catch((e) => process.stdout.write("REFUSED: " + e.message));
    ' "$LIB" "$CANON" "$WORK" > "$WORK/out3.txt"
    out=$(cat "$WORK/out3.txt")
    [[ "$out" == BUILT* ]] || { echo "a transient runner failure sank the stage: $out"; false; }
    [[ "$out" == *"calls=2"* ]] || { echo "the retry did not happen: $out"; false; }
}

@test "and a runner that ALWAYS fails exhausts its attempts and says so" {
    "$NODE" -e '
      const m = require(process.argv[1]);
      const produce = async () => { throw new Error("prompt runner exited with code 1"); };
      m.buildProjectRoster({ canonicalPath: process.argv[2], logDir: process.argv[3] + "/logs",
        projectConfigDir: process.argv[3] + "/project", produce,
        review: async () => ({ verdict: "approved" }), attempts: 2, log: () => {} })
        .then(() => process.stdout.write("BUILT"))
        .catch((e) => process.stdout.write("REFUSED: " + e.message));
    ' "$LIB" "$CANON" "$WORK" > "$WORK/out4.txt"
    out=$(cat "$WORK/out4.txt")
    [[ "$out" == REFUSED* ]]
    [[ "$out" == *"specialiser call failed"* ]] || { echo "the reason does not name the cause: $out"; false; }
}
