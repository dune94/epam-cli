#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE ROSTER STAGE IS EXECUTED, NOT PARSED.
#
# THREE BUGS SHIPPED PAST `node --check` AND A FULL GREEN SUITE, and a launch found the first:
#
#   renderEngineTemplate is not defined   — used, never imported
#   invocation registry unreadable        — seamInvocationEnv handed LOG_DIR, not AGENTS_DIR
#   promptExec is not a function          — called directly; every other seam passes it to
#                                           spec.runClaude
#
# All three are runtime errors in a code path no test entered. The test that was supposed to cover
# it ran mint-agents-step.js with no --prd, so it returned at the argument check and never reached
# the stage — and asserting "no ReferenceError" on a path that exits early proves nothing.
#
# This one supplies enough fixture to ENTER the stage: a PRD, an agents dir, a provider, a ladder.
# The API key is deliberately invalid, so the run reaches the model call and goes no further —
# what is asserted is that it got THAT far, which is past every error above.
# ─────────────────────────────────────────────────────────────────────────────

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing and failed for a reason that had nothing to do with the pipeline.
load "../helpers/env-run"

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    WORK="$(mktemp -d)"; mkdir -p "$WORK/logs" "$WORK/proj"
    printf '%s' '{"stories":[{"id":"T-1","title":"t","agentRole":"typescript-engineer","codelines":["metrolinx"]}],"implementationOrder":{"core":["T-1"]}}' \
        > "$WORK/prd.json"
}
teardown() { rm -rf "$WORK"; }

# Runs the real step in roster-only mode. No spend: the key is invalid, so the model call fails or
# stalls and the timeout ends it. The OUTPUT up to that point is what is under test.
run_stage() {
    # env_run is a shell FUNCTION, so `timeout` cannot exec it — it sets the environment and
    # then runs timeout, rather than the other way round.
    env_run \
        EPAM_ROSTER_ONLY=1 \
        `# An unreviewed roster is only sound if a human is going to look at it, so the step` \
        `# refuses unless a roster pause is configured. Every real roster-only run has one;` \
        `# the fixture did not, and failed on that guard rather than reaching the model call.` \
        EPAM_PAUSE_AFTER_AGENT_MINT=1 \
        EPAM_PROJECT_CONFIG_DIR="$WORK/proj" \
        LOG_DIR="$WORK/logs" \
        EPAM_ORCHESTRATION_PROVIDER=qwen ORCH_GATE_PROVIDER=qwen \
        OPENROUTER_API_KEY=sk-invalid-fixture EPAM_API_KEY_OPENROUTER=sk-invalid-fixture \
        EPAM_ROSTER_ATTEMPTS=1 \
        timeout 45 "$NODE" "$SCRIPTS/mint-agents-step.js" \
        --prd "$WORK/prd.json" --agents-dir "$REPO_ROOT/orchestrations/agents" \
        --log-dir "$WORK/logs" 2>&1 || true
}

@test "the fixture ENTERS the roster stage — otherwise everything below is vacuous" {
    run run_stage
    # "roster-only" alone, not the full sentence. The marker this asserted — "roster-only:
    # deriving" — is in no producer today, and the wording moved again on 2026-08-28 when the
    # skip reason stopped claiming a checkpoint that did not exist. Entry is what this test is
    # for; the prose around it is free to improve without failing a suite.
    [[ "$output" == *"roster-only"* ]] || {
        echo "the stage was never entered, so this suite proves nothing:"; echo "$output" | tail -5; false; }
}

@test "NO undefined identifier — the renderer and its helpers are all imported" {
    run run_stage
    # STANDS ALONE. A sibling test guards that the fixture enters the stage, but a test that
    # depends on a sibling to be meaningful is one deletion away from vacuous — so each asserts
    # the stage was entered before asserting what its output lacks.
    # "roster-only" alone, not the full sentence. The marker this asserted — "roster-only:
    # deriving" — is in no producer today, and the wording moved again on 2026-08-28 when the
    # skip reason stopped claiming a checkpoint that did not exist. Entry is what this test is
    # for; the prose around it is free to improve without failing a suite.
    [[ "$output" == *"roster-only"* ]] || {
        echo "the stage was never entered — this assertion proves nothing"; false; }
    [[ "$output" != *"is not defined"* ]] || {
        echo "an identifier the stage uses is not imported:"; echo "$output" | grep 'is not defined'; false; }
}

@test "NO wrong call shape — promptExec is handed to the runner, not invoked" {
    run run_stage
    # STANDS ALONE. A sibling test guards that the fixture enters the stage, but a test that
    # depends on a sibling to be meaningful is one deletion away from vacuous — so each asserts
    # the stage was entered before asserting what its output lacks.
    # "roster-only" alone, not the full sentence. The marker this asserted — "roster-only:
    # deriving" — is in no producer today, and the wording moved again on 2026-08-28 when the
    # skip reason stopped claiming a checkpoint that did not exist. Entry is what this test is
    # for; the prose around it is free to improve without failing a suite.
    [[ "$output" == *"roster-only"* ]] || {
        echo "the stage was never entered — this assertion proves nothing"; false; }
    [[ "$output" != *"is not a function"* ]] || {
        echo "the stage calls something that is not callable:"; echo "$output" | grep 'is not a function'; false; }
}

@test "the seam resolves its registry — the agents dir, not the log dir" {
    run run_stage
    # STANDS ALONE. A sibling test guards that the fixture enters the stage, but a test that
    # depends on a sibling to be meaningful is one deletion away from vacuous — so each asserts
    # the stage was entered before asserting what its output lacks.
    # "roster-only" alone, not the full sentence. The marker this asserted — "roster-only:
    # deriving" — is in no producer today, and the wording moved again on 2026-08-28 when the
    # skip reason stopped claiming a checkpoint that did not exist. Entry is what this test is
    # for; the prose around it is free to improve without failing a suite.
    [[ "$output" == *"roster-only"* ]] || {
        echo "the stage was never entered — this assertion proves nothing"; false; }
    [[ "$output" != *"invocation registry unreadable"* ]] || {
        echo "seamInvocationEnv was given the wrong directory:"; echo "$output" | grep -i 'registry'; false; }
}

@test "and it reaches the MODEL CALL, which is as far as a fixture can go" {
    # The positive assertion. Without it, every `!=` above passes on a stage that died even
    # earlier for some new reason — the vacuous-pass shape these tests keep catching.
    run run_stage
    # The same marker as the assertions above — this one was missed because it carries no
    # failure message and so did not appear in the earlier sweep.
    [[ "$output" == *"roster-only"* ]]
    # It DOES fail — the fixture key is invalid, so the runner exits non-zero. That failure is the
    # proof: reaching the runner means every step before it worked. What must not appear is a
    # failure from the stage's own code.
    if [[ "$output" == *"FAILED: "* ]]; then
        [[ "$output" == *"prompt runner exited"* || "$output" == *"could not produce an accepted roster"* ]] || {
            echo "the stage failed for a reason that is not the model call:"
            echo "$output" | grep 'FAILED:'
            false
        }
    fi
}
