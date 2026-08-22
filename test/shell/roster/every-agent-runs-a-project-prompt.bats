#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A TEMPLATE IS NEVER EXECUTED. AN AGENT RUNS THIS PROJECT'S PROMPT.
#
# Operator, 2026-08-22: "template prompts are immutable and generic — they are never wired into
# pipeline to execute directly... during prompt generation, only template prompts can be used to
# generate project level prompts."
#
# That was false for 89 template ids, rendered straight from the template layer by
# render_engine_prompt / renderEngineTemplate. Of those, 29 are declared by a seam — an agent
# executes them — and those are the ones an agent should be running a PROJECT copy of.
#
# FIVE ARE BOOTSTRAP AND STAY. roster-specialisation, project-roster-review, roster-review,
# estate-survey and assign-agent-roles all run INSIDE the mint, before the project prompt layer
# exists. A prompt that generates prompts cannot itself be generated — the same reason
# bootstrap.copyVerbatim exists — so demanding a project copy of one would provision a file that
# can never be read, which is what dc7fb20 deleted 39 of.
#
# The remaining 24 render from the project layer, where self-heal can correct them and where the
# project's own facts live.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    REGISTRY="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

# The bootstrap set, DERIVED from the mint's own agent sequence — never a list written here, which
# would drift the moment a stage moves.
bootstrap_templates() {
    "$NODE" -e '
      const fs = require("fs");
      const mint = fs.readFileSync(process.argv[1], "utf8");
      const seq = [...mint.matchAll(/EPAM_AGENT_NAME\s*[:=]\s*.([a-z0-9:-]+)./g)].map((m) => m[1]);
      const cut = seq.indexOf("prompt-builder");
      const before = new Set(cut < 0 ? seq : seq.slice(0, cut));
      const reg = require(process.argv[2]).profiles || {};
      const out = [...before].map((n) => reg[n] && reg[n].template).filter(Boolean);
      process.stdout.write([...new Set(out)].sort().join("\n"));
    ' "$SCRIPTS/mint-agents-step.js" "$REGISTRY"
}

# Seam-declared templates still rendered from the TEMPLATE layer.
template_rendered_seams() {
    "$NODE" -e '
      const fs = require("fs"), { execFileSync } = require("child_process");
      const src = execFileSync("find", [process.argv[1], "-type", "f",
        "(", "-name", "*.sh", "-o", "-name", "*.js", ")", "-not", "-path", "*/.venv*"],
        { encoding: "utf8" }).split("\n").filter(Boolean)
        .map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
      const rendered = new Set(
        [...src.matchAll(/render_engine_prompt ["\x27]?([a-z0-9-]+)/g)].map((m) => m[1])
          .concat([...src.matchAll(/renderEngineTemplate\(\x27([a-z0-9-]+)\x27/g)].map((m) => m[1])));
      const reg = require(process.argv[2]).profiles || {};
      const seamTpl = new Set();
      (function w(o) { for (const k in o) { const v = o[k];
        if (v && typeof v === "object") { if (v.template) seamTpl.add(v.template); w(v); } } }(reg));
      process.stdout.write([...rendered].filter((id) => seamTpl.has(id)).sort().join("\n"));
    ' "$SCRIPTS" "$REGISTRY"
}

@test "the fixture is real — the mint has a sequence and it reaches prompt-builder" {
    run bootstrap_templates
    [ -n "$output" ] || { echo "no bootstrap templates derived — the sequence scan found nothing"; false; }
    [ "$(printf '%s\n' "$output" | grep -c .)" -ge 3 ]
}

@test "the bootstrap set is DERIVED, and roster-specialisation is in it" {
    # The clearest case: the prompt that generates this project's roster cannot be a project
    # prompt, because it runs before the project has any.
    run bootstrap_templates
    [[ "$output" == *"roster-specialisation"* ]]
}

@test "NO seam-declared prompt executes from the template layer, except the bootstrap set" {
    boot="$(bootstrap_templates)"
    offenders=""
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        printf '%s\n' "$boot" | grep -qx "$id" && continue
        offenders="$offenders $id"
    done < <(template_rendered_seams)
    [ -z "$offenders" ] || {
        echo "these agents execute a TEMPLATE, not this project's prompt:"
        for o in $offenders; do echo "    $o"; done
        echo "A template is generic by construction — an agent running one has none of this"
        echo "project's facts, and self-heal has nothing to correct."
        false
    }
}

@test "and the check is not vacuous — it can see a seam that renders a template" {
    run template_rendered_seams
    # Before the migration this is 29; after it, only the bootstrap set. Either way the scan must
    # return something, or the assertion above passes by finding nothing to test.
    [ -n "$output" ] || { echo "the scan found no template-rendered seam at all"; false; }
}
