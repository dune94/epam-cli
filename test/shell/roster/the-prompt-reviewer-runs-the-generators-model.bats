#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE PROMPT REVIEWER RUNS THE MODEL THAT WROTE THE PROMPT.
#
# Operator, 2026-08-22: "prompt reviewer must use same model as prompt generator agent." The same
# rule already binds the code reviewer to the writer's rung and the analyst to the attempt it is
# healing: a judge below the producer's rung cannot see what that rung gets wrong.
#
# Today they match by COINCIDENCE — both seams declare ladder=top, so both resolve the same first
# rung. Nothing enforces it. Change either declaration, or let the runner escalate one on an empty
# response, and they diverge with nothing to say so. A prompt is the contract every agent in the
# run executes against, so a reviewer that cannot reproduce the generator's reasoning is reviewing
# text it could not have written.
#
# So the generator's RESOLVED model is passed to the reviewer, the same way the writer's rung is
# passed to the code reviewer. Declared tiers are not the same fact as a resolved model.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    MINT="$SCRIPTS/mint-agents-step.js"
    REGISTRY="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

@test "the fixture is real — both seams exist and are separately declared" {
    run "$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      process.stdout.write([p["prompt-builder"], p["prompt-review"]].every(Boolean) ? "both" : "missing");
    ' "$REGISTRY"
    [ "$output" = "both" ]
}

@test "NEITHER seam names a model — the ladder owns that" {
    run "$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      const bad = ["prompt-builder", "prompt-review"]
        .filter((k) => p[k] && (p[k].model || p[k].maxIterations));
      process.stdout.write(bad.join(" "));' "$REGISTRY"
    [ -z "$output" ] || { echo "a seam names a model or an iteration count: $output"; false; }
}

@test "THE REVIEWER IS GIVEN THE GENERATOR'S RESOLVED MODEL" {
    # Not "both declare the same tier" — that is the coincidence this replaces. The generator's
    # env is resolved first, and the model it resolved to is handed to the reviewer.
    blk=$(awk "/seamInvocationEnv\('prompt-review'/{f=1} f{print; if(++n>=12) exit}" "$MINT")
    [ -n "$blk" ] || { echo "the prompt-review invocation is gone — this test is stale"; false; }
    [[ "$blk" == *"EPAM_MODEL"* ]] || {
        echo "the reviewer's env does not carry a model from the generator:"; echo "$blk"; false; }
}

@test "and it comes from the GENERATOR's env, not resolved independently" {
    src=$(cat "$MINT")
    [[ "$src" == *"_promptGeneratorModel"* ]] || {
        echo "no variable carries the generator's resolved model to the reviewer"; false; }
    # the generator's env must be resolved BEFORE the reviewer's, or there is nothing to pass
    gen=$(grep -n "seamInvocationEnv('prompt-builder'" "$MINT" | head -1 | cut -d: -f1)
    rev=$(grep -n "seamInvocationEnv('prompt-review'" "$MINT" | head -1 | cut -d: -f1)
    [ -n "$gen" ] && [ -n "$rev" ] && [ "$gen" -lt "$rev" ] || {
        echo "the reviewer's env is resolved at $rev, the generator's at $gen"; false; }
}

@test "a reviewer with NO generator model does not silently review on its own" {
    # The failure mode this must not have: an unset value falling through to whatever the
    # reviewer's own seam resolved, which is exactly how the code reviewer judged kimi-k3's work
    # from glm-5.2 for three cycles.
    src=$(cat "$MINT")
    [[ "$src" != *"_promptGeneratorModel ||"* ]] || {
        echo "the generator's model falls back to something else when unset"; false; }
}

@test "generator and reviewer sit on the SAME ladder — they move together or not at all" {
    # The resolved model is passed from one to the other, so a divergence here would be caught at
    # runtime. This catches it earlier and states the intent: dropping the generator a tier must
    # drop its reviewer too, or a weaker prompt is judged by a stronger model and the mismatch is
    # invisible until someone reads two profiles side by side.
    run "$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      const a = p["prompt-builder"] || {};
      const b = p["prompt-review"] || {};
      process.stdout.write(`${a.ladder}|${b.ladder}`);' "$REGISTRY"
    [ -n "$output" ]
    gen="${output%%|*}"; rev="${output##*|}"
    [ "$gen" = "$rev" ] || {
        echo "the generator is on '$gen' and its reviewer on '$rev'"; false; }
}

@test "and neither is pinned to the ceiling by default" {
    # Specialising a prompt is largely restatement, and the ceiling rung buys nothing for that —
    # the same argument that put the TC writer on medium. Recorded so a future change to `top`
    # has to say why.
    run "$NODE" -e '
      const p = require(process.argv[1]).profiles || {};
      process.stdout.write(String((p["prompt-builder"] || {}).ladder));' "$REGISTRY"
    [ "$output" != "top" ] || {
        echo "prompt generation is back on the ceiling rung with no stated reason"; false; }
}
