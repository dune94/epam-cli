#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE WRITER TELLS THE REVIEWER WHAT PRODUCED THE WORK. IT IS NOT INFERRED.
#
# Operator, 2026-08-22: "why is reviewer hardcoded? the writer model should be provided to
# reviewer dynamically."
#
# team-lead-review.sh holds no model literal and never did — it reads ORCH_GATE_MODEL, whose
# value four launchers hardcode (skyscanner z-ai/glm-5.2, travel z-ai/glm-5.1, paid gpt-4o,
# mock1 z-ai/glm-5.1). The fix committed in 7edf627 made the reviewer FOLLOW the story, but by
# reading lib/story-retry-state.sh — a file whose contract is ladder-resume bookkeeping, not
# "what produced this diff". Two consequences:
#
#   * write_story_retry_model REFUSES to persist an empty model, deliberately and correctly for
#     its own purpose. So if STORY_MODEL is ever unset the reviewer falls through to the
#     launcher's literal WITH NO TRACE — the silent-degrade shape this pipeline keeps paying for.
#   * It is written at ladder bookkeeping points, so the reviewer infers the rung the ladder
#     REACHED rather than being handed the model that produced the artifact in front of it.
#
# lib/story-outputs.sh already exists to hand gates the writers' output instead of letting them
# rediscover it. The producing model is a property of that output, so it belongs there.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/story-outputs.sh"
    WORK="$(mktemp -d)"; export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
}
teardown() { rm -rf "$WORK"; }

# The real library, in a subshell — never a reimplementation of it here.
in_lib() { ( set +e; . "$LIB" >/dev/null 2>&1; eval "$*" ); }

@test "the manifest library records the model that produced a story's output" {
    in_lib "story_outputs_record_model '$LOG_DIR' S-1 'moonshotai/kimi-k3'"
    [ "$(in_lib "story_outputs_model '$LOG_DIR' S-1")" = "moonshotai/kimi-k3" ]
}

@test "a story nothing has produced for yet reads as ABSENT, not as some default" {
    # Absent must stay absent. Substituting a model here is how a judge ends up authoritative
    # about work it never saw the producer of.
    [ -z "$(in_lib "story_outputs_model '$LOG_DIR' NEVER-RAN")" ]
}

@test "recording an EMPTY model is refused LOUDLY, not silently dropped" {
    # This is the whole difference from story-retry-state, which returns 0 on empty by design.
    # Here an empty model means the writer could not say what it ran, and that is a defect the
    # next person must be able to see.
    # Asserted on the CONTENT of the complaint, not merely on stderr being non-empty: before
    # the function existed this test passed on bash's own "command not found".
    run bash -c ". '$LIB'; story_outputs_record_model '$LOG_DIR' S-2 ''"
    [[ "$output" == *"S-2"* && "$output" == *"NO model"* ]] || {
        echo "empty model was not reported against the story; got: $output"; false; }
    [ -z "$(in_lib "story_outputs_model '$LOG_DIR' S-2")" ]
}

@test "THE PRODUCER is wired: record_story_outputs hands the story's model forward" {
    # Extracted from the real claude.sh and executed — a grep would pass on a comment.
    block=$(awk '/^record_story_outputs\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SCRIPTS/claude.sh")
    [ -n "$block" ]
    run bash -c '
        . '"$LIB"'
        story_outputs_record(){ :; }          # the file-list half is not under test here
        LOG_DIR='"$LOG_DIR"'; SCRIPT_DIR='"$SCRIPTS"'; PROJECT_ROOT=""
        STORY_MODEL="moonshotai/kimi-k3"
        '"$block"'
        record_story_outputs S-3
        story_outputs_model "'"$LOG_DIR"'" S-3'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == *"moonshotai/kimi-k3"* ]] || {
        echo "record_story_outputs did not hand the model forward; got: $output"; false; }
}

@test "THE CONSUMER prefers what the writer handed it over inferred ladder state" {
    # Both present and DIFFERENT: the writer's own statement must win. If the reviewer took
    # retry-state here it would judge on the rung the ladder reached, not on what produced
    # the diff — and on a re-implementation those are not the same model.
    in_lib "story_outputs_record_model '$LOG_DIR' S-4 'from/the-writer'"
    ( . "$SCRIPTS/lib/story-retry-state.sh"; write_story_retry_model "$LOG_DIR" S-4 'from/ladder-state' )
    block=$(awk 'index($0,"_story_model=\"\""){f=1} f{print; if(++c>=12) exit}' "$SCRIPTS/team-lead-review.sh")
    [ -n "$block" ]
    run bash -c '
        . '"$SCRIPTS"'/lib/story-retry-state.sh; . '"$LIB"'
        log(){ :; }; story_id=S-4; LOG_DIR='"$LOG_DIR"'
        ORCH_GATE_MODEL="z-ai/glm-5.2"
        '"$block"'
        echo "${_story_model:-$ORCH_GATE_MODEL}"'
    [ "$output" = "from/the-writer" ] || {
        echo "reviewer used '$output' — it should judge on the model the WRITER handed it"; false; }
}

@test "and it still falls back to ladder state when the writer said nothing" {
    # A producer that predates this handoff, or a phase with no writer, must not regress to
    # the launcher literal while resume state is sitting right there.
    ( . "$SCRIPTS/lib/story-retry-state.sh"; write_story_retry_model "$LOG_DIR" S-5 'from/ladder-state' )
    block=$(awk 'index($0,"_story_model=\"\""){f=1} f{print; if(++c>=12) exit}' "$SCRIPTS/team-lead-review.sh")
    run bash -c '
        . '"$SCRIPTS"'/lib/story-retry-state.sh; . '"$LIB"'
        log(){ :; }; story_id=S-5; LOG_DIR='"$LOG_DIR"'
        ORCH_GATE_MODEL="z-ai/glm-5.2"
        '"$block"'
        echo "${_story_model:-$ORCH_GATE_MODEL}"'
    [ "$output" = "from/ladder-state" ]
}

@test "NO LAUNCHER-SHAPED FALLBACK survives when neither source has anything" {
    # Nothing recorded anywhere: the seam's own model stands, untouched and unguessed.
    block=$(awk 'index($0,"_story_model=\"\""){f=1} f{print; if(++c>=12) exit}' "$SCRIPTS/team-lead-review.sh")
    run bash -c '
        . '"$SCRIPTS"'/lib/story-retry-state.sh; . '"$LIB"'
        log(){ :; }; story_id=S-6; LOG_DIR='"$LOG_DIR"'
        ORCH_GATE_MODEL="seam/default"
        '"$block"'
        echo "${_story_model:-$ORCH_GATE_MODEL}"'
    [ "$output" = "seam/default" ]
}

@test "the consumer really has that function in scope in the REAL script" {
    # The tests above stub the library in. If team-lead-review.sh does not source it before the
    # block runs, the `command -v` guard skips silently and every one of them proves nothing.
    src=$(grep -n 'lib/story-outputs.sh' "$SCRIPTS/team-lead-review.sh" | head -1 | cut -d: -f1)
    use=$(grep -n '_story_model=""' "$SCRIPTS/team-lead-review.sh" | head -1 | cut -d: -f1)
    [ -n "$src" ] && [ -n "$use" ] && [ "$src" -lt "$use" ] || {
        echo "story-outputs.sh is sourced at '$src', used at '$use' — the guard would skip"; false; }
}

@test "the producing-model record does NOT survive the pre-run reset" {
    # The archive sweep matches `story-outputs-*.txt`; this is a directory of extensionless
    # per-story files. story-retry-state fell into that exact gap and needed its own explicit
    # clear. A survivor here means the next run's reviewer judges on the rung the PREVIOUS
    # run's writer reached — a model chosen by nobody.
    in_lib "story_outputs_record_model '$LOG_DIR' S-STALE 'last/run-model'"
    [ -n "$(in_lib "story_outputs_model '$LOG_DIR' S-STALE")" ]   # fixture is real

    block=$(awk 'index($0,"_PRODUCER_MODEL_DIR=\"$LOG_DIR")||f{f=1;print; if(f&&/^fi$/) exit}' \
            "$SCRIPTS/pre-run-reset.sh")
    [ -n "$block" ] || { echo "pre-run-reset.sh does not clear story-outputs-model at all"; false; }
    run bash -c '
        LOG_DIR='"$LOG_DIR"'; info(){ :; }; fail_contamination(){ echo "CONTAMINATED: $*"; exit 1; }
        '"$block"'
        echo "remaining=$(find '"$LOG_DIR"'/story-outputs-model -type f | wc -l)"'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == *"remaining=0"* ]] || { echo "a prior run's model survived: $output"; false; }
    [ -z "$(in_lib "story_outputs_model '$LOG_DIR' S-STALE")" ]
}
