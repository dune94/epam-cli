#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A REVIEWER JUDGES ON THE MODEL THAT PRODUCED THE WORK. AN ANALYST HEALS ON THE MODEL THAT
# FAILED.
#
# Operator rule, 2026-08-22. Observed live in run 20260821T212250Z: the writer climbed
# MiniMax-M3 -> z-ai/glm-5.2 -> moonshotai/kimi-k3 across five attempts, while the reviewer ran
# z-ai/glm-5.2 on ALL THREE cycles, including the approval. So the final judgement was made by
# a weaker model than the one that produced the work — and it approved a diff that had DROPPED
# the unsubscribeOnEntryChange cleanup its own previous cycle had produced.
#
# A reviewer below the writer's rung cannot see what the writer's rung can do wrong. The same
# holds for the self-heal analysts: diagnosing a stronger model's attempt from a weaker one is
# guesswork about reasoning it cannot reproduce.
#
# The story's current model is already persisted — lib/story-retry-state.sh
# read_story_retry_model — because the ladder needs it to resume without restarting its climb.
# Nothing was reading it for this.
#
# WHAT STAYS WITH THE SEAM: escalation when the REVIEWER OR ANALYST ITSELF fails to produce
# output. That is its own failure, on its own ladder, and is untouched here.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    WORK="$(mktemp -d)"
    export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
}
teardown() { rm -rf "$WORK"; }

# The persisted model for a story, through the real helper.
persist_model() {  # $1 = story, $2 = model
    ( # shellcheck source=/dev/null
      . "$SCRIPTS/lib/story-retry-state.sh"
      write_story_retry_model "$LOG_DIR" "$1" "$2" )
}
read_model() {
    ( # shellcheck source=/dev/null
      . "$SCRIPTS/lib/story-retry-state.sh"
      read_story_retry_model "$LOG_DIR" "$1" )
}

@test "the fixture is real — the story's model is persisted and readable" {
    # This is the fact the whole rule rests on: the ladder already records where a story got to.
    persist_model S-1 'moonshotai/kimi-k3'
    [ "$(read_model S-1)" = "moonshotai/kimi-k3" ]
}

# THE REAL LINES, EXECUTED. A grep for `read_story_retry_model` passes on a comment, on a dead
# branch, and on a call whose result is thrown away — which is precisely the shape of the defect
# this rule exists to close. So both blocks are EXTRACTED FROM THE REAL SCRIPT by the marker that
# opens them and run under bash with a fixture, and the assertion is on the model that comes out.
extract() {  # $1 = script, $2 = first line of the block, $3 = how many lines
    awk -v pat="$2" -v n="$3" 'index($0,pat){f=1} f{print; if(++c>=n) exit}' "$1"
}

@test "THE REVIEWER runs on the story's current model, not its own seam default" {
    persist_model S-1 'moonshotai/kimi-k3'
    block=$(extract "$SCRIPTS/team-lead-review.sh" '_story_model=""' 9)
    [ -n "$block" ]
    run bash -c '
        . '"$SCRIPTS"'/lib/story-retry-state.sh
        log(){ :; }; story_id=S-1
        ORCH_GATE_MODEL="z-ai/glm-5.2"       # the seam default that judged kimi-k3 work live
        '"$block"'
        echo "$ORCH_GATE_MODEL"'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [ "$output" = "moonshotai/kimi-k3" ] || {
        echo "reviewer judged on '$output' while the story is on moonshotai/kimi-k3"; false; }
}

@test "THE ANALYST heals on the model whose attempt it is analysing" {
    persist_model S-2 'moonshotai/kimi-k3'
    block=$(extract "$SCRIPTS/agent-attempt-analyst.sh" '_attempt_model=""' 10)
    [ -n "$block" ]
    run bash -c '
        SCRIPT_DIR='"$SCRIPTS"'; warning(){ :; }
        AGENT_ANALYST_STORY_ID=S-2
        ORCH_GATE_MODEL="z-ai/glm-5.2"
        '"$block"'
        echo "$_model"'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [ "$output" = "moonshotai/kimi-k3" ] || {
        echo "analyst diagnosed on '$output' while the failing attempt was moonshotai/kimi-k3"; false; }
}

@test "an OPERATOR override still wins over the attempt's model" {
    # The rule binds the default, not the operator. Losing the override would make a deliberate
    # cross-rung diagnosis impossible.
    persist_model S-3 'moonshotai/kimi-k3'
    block=$(extract "$SCRIPTS/agent-attempt-analyst.sh" '_attempt_model=""' 10)
    run bash -c '
        SCRIPT_DIR='"$SCRIPTS"'; warning(){ :; }
        AGENT_ANALYST_STORY_ID=S-3; AGENT_ANALYST_MODEL="operator/choice"
        '"$block"'
        echo "$_model"'
    [ "$output" = "operator/choice" ]
}

@test "a story with NO persisted model leaves the seam default alone" {
    # First attempt of a fresh story: nothing recorded yet. Inventing a model here would be
    # worse than the seam's own declared rung, so BOTH judges must fall through untouched.
    [ -z "$(read_model NEVER-RAN)" ]
    block=$(extract "$SCRIPTS/team-lead-review.sh" '_story_model=""' 9)
    run bash -c '
        . '"$SCRIPTS"'/lib/story-retry-state.sh
        log(){ :; }; story_id=NEVER-RAN; ORCH_GATE_MODEL="seam/default"
        '"$block"'
        echo "$ORCH_GATE_MODEL"'
    [ "$output" = "seam/default" ]
    block=$(extract "$SCRIPTS/agent-attempt-analyst.sh" '_attempt_model=""' 10)
    run bash -c '
        SCRIPT_DIR='"$SCRIPTS"'; warning(){ :; }
        AGENT_ANALYST_STORY_ID=NEVER-RAN; ORCH_GATE_MODEL="seam/default"
        '"$block"'
        echo "$_model"'
    [ "$output" = "seam/default" ]
}

@test "the seam ladder still governs the judge's OWN failure" {
    # The reviewer escalating because IT produced no verdict is a different event from the
    # writer's rung, and must survive this change — it is what recovered run 20260821T162533Z
    # after three empty review-agent responses.
    run grep -c 'did not produce a verdict' "$SCRIPTS/run-agent-orchestration.sh"
    [ "$output" -ge 1 ]
    run grep -c 'seam_ladder_export' "$SCRIPTS/team-lead-review.sh"
    [ "$output" -ge 1 ]
}
