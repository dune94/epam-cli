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

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing and failed for a reason that had nothing to do with the pipeline.
load "../helpers/env-run"

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

@test "A SEAM PROMPT RENDERS FROM THE PROJECT COPY — executed, not grepped" {
    # BEHAVIOURAL. The first version scanned call sites for render_engine_prompt <id> and would
    # now report every one of them, because the enforcement moved INTO the renderer: a caller asks
    # for a prompt and gets the one an agent may execute. Scanning callers tests where the rule
    # used to be.
    #
    # Proven by content: the project copy is edited in a scratch dir, and the render must show
    # that edit. Reading the template while the renderer reads the project copy is exactly how a
    # fixture comes to assert against bytes nobody executes.
    proj="$BATS_TEST_TMPDIR/proj"; mkdir -p "$proj/prompts"
    id=qa-sast-sentinel
    "$NODE" -e '
      const fs = require("fs");
      const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      src.body = "PROJECT-COPY-MARKER\n" + src.body;
      src.authority = "project";
      fs.writeFileSync(process.argv[2], JSON.stringify(src, null, 2));
    ' "$REPO_ROOT/orchestrations/projects/metrolinx/prompts/$id.json" "$proj/prompts/$id.json"

    run env_run EPAM_PROJECT_CONFIG_DIR="$proj" "$NODE" -e '
      const lib = require(process.argv[1]);
      const ep = require(process.argv[2]);
      const d = lib.loadProjectPrompt(process.argv[3], process.env.EPAM_PROJECT_CONFIG_DIR);
      const vals = {};
      [...new Set(lib.placeholdersIn(d.body))].forEach((p) => { vals[p] = "x"; });
      process.stdout.write(ep.renderEngineTemplate(process.argv[3], vals).slice(0, 40));
    ' "$SCRIPTS/lib/prompt-library.js" "$SCRIPTS/lib/engine-prompt.js" "$id"

    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == PROJECT-COPY-MARKER* ]] || {
        echo "the renderer returned the TEMPLATE, not this project's copy: $output"; false; }
}

@test "a BOOTSTRAP prompt still renders from the template — it runs before any copy exists" {
    run env_run EPAM_PROJECT_CONFIG_DIR="$BATS_TEST_TMPDIR/empty" "$NODE" -e '
      const ep = require(process.argv[1]);
      try { ep.renderEngineTemplate("roster-specialisation", {}); process.stdout.write("rendered"); }
      catch (e) { process.stdout.write(e.message); }
    ' "$SCRIPTS/lib/engine-prompt.js"
    # It fails for MISSING VALUES — meaning it reached the template — not for a missing copy.
    [[ "$output" == *"missing values"* ]] || {
        echo "a bootstrap prompt did not render from the template: $output"; false; }
}

@test "a seam prompt with NO project declared refuses — it never falls back to the template" {
    run env_run -u EPAM_PROJECT_CONFIG_DIR "$NODE" -e '
      const ep = require(process.argv[1]);
      try { ep.renderEngineTemplate("qa-sast-sentinel", {}); process.stdout.write("RENDERED"); }
      catch (e) { process.stdout.write(e.message); }
    ' "$SCRIPTS/lib/engine-prompt.js"
    [[ "$output" != RENDERED* ]] || { echo "a template was executed for an agent"; false; }
    [[ "$output" == *"EPAM_PROJECT_CONFIG_DIR"* ]]
}

@test "and the check is not vacuous — it can see a seam that renders a template" {
    run template_rendered_seams
    # Before the migration this is 29; after it, only the bootstrap set. Either way the scan must
    # return something, or the assertion above passes by finding nothing to test.
    [ -n "$output" ] || { echo "the scan found no template-rendered seam at all"; false; }
}

@test "a project that runs agents DECLARES generate, not copy" {
    # copy installs each prompt byte-identical to its generic template, so an agent executes text
    # with none of this codeline's facts in it and self-heal has nothing project-specific to
    # correct. The whole point of a project prompt layer is that its prompts are the project's.
    #
    # Checked per project rather than globally: a fixture project with no agents has nothing to
    # specialise, and demanding generation from it would be cost for no reader.
    for cfg in "$REPO_ROOT"/orchestrations/projects/*/config.env; do
        [ -f "$cfg" ] || continue
        proj="$(basename "$(dirname "$cfg")")"
        grep -q 'EPAM_PROMPT_PROVISION_MODE' "$cfg" || continue
        mode=$(grep -E '^EPAM_PROMPT_PROVISION_MODE=' "$cfg" | tail -1 | cut -d= -f2)
        [ "$mode" != "copy" ] || {
            echo "$proj declares EPAM_PROMPT_PROVISION_MODE=copy —"
            echo "its agents execute generic templates, not this project's prompts."
            false
        }
    done
}

@test "the specialisation contract asks each ADDED agent which seam it enters by" {
    # Without it the name is matched against patterns, and a pattern is a guess about what an
    # agent does from how it is spelled — which is how an agent named for review came to enter
    # through an inference seam, with another seam's budget and tools.
    run "$NODE" -e '
      const d = require(process.argv[1]);
      process.stdout.write(/"seam":/.test(d.body) && /which seam an agent enters by/i.test(d.body)
        ? "asks" : "silent");' "$REPO_ROOT/orchestrations/prompts/templates/roster-specialisation.json"
    [ "$output" = "asks" ] || { echo "the specialiser is not asked for a seam binding"; false; }
}

@test "NO PROJECT FORCES one timeout over every seam's declaration" {
    # RUNCLAUDE_TIMEOUT_MS is the operator's debugging lever and wins over everything. Set in a
    # project's config it holds ONE number over all 36 seams, each of which declares the budget its
    # own work needs — so 76031b1 ("36 seams declared one, nothing read it") made those
    # declarations live everywhere except the projects that force a value.
    #
    # The cost is not theoretical: that commit records prompt-builder declaring 900s and being cut
    # off at 360s, taking a survey, a roster, an assignment and 12 generated prompts with it. The
    # roster specialiser hit the same cap while escalating to kimi-k3 and doing real work.
    forced=""
    for cfg in "$REPO_ROOT"/orchestrations/projects/*/config.env; do
        [ -f "$cfg" ] || continue
        grep -qE '^[[:space:]]*RUNCLAUDE_TIMEOUT_MS=' "$cfg" || continue
        forced="$forced $(basename "$(dirname "$cfg")")"
    done
    [ -z "$forced" ] || {
        echo "project(s) forcing one timeout over every seam:$forced"
        echo "Set it temporarily to debug a hang — leaving it set makes every declaration"
        echo "documentation."
        false
    }
}
