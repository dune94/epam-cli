#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# EVERY JUDGE INHERITS THE RUNG THE WRITER CONVERGED ON.
#
# Operator, 2026-08-22:
#   "Writers model MUST be persisted and provided to reviewer dynamically - if writer's model
#    moves up ladder, the reviewer must follow along and use the same rung EXACT setup the
#    writer used to converge. No other interpretations of this. No hard coding. No guards.
#    Persistence."
#   "Same with self heal - if analyst is used in a retry the self-heal ladder rung must be
#    inherited by the analyst."
#
# A RUNG IS NOT A MODEL. claude.sh's ladder moves model, provider, reasoning effort and
# temperature together — rung 1 effort medium / temp 0, rung 2 escalates the model, rung 3
# effort high / temp 0.7. A judge handed only the model runs a configuration the writer never
# used, and its verdict describes work it cannot reproduce.
#
# Live 20260821T212250Z: writer climbed MiniMax-M3 -> glm-5.2 -> kimi-k3 over five attempts;
# all three review cycles ran glm-5.2, the approval included, and it approved a diff that had
# dropped a cleanup its own earlier cycle produced.
#
# NO GUARDS IS PART OF THE REQUIREMENT. claude.sh writes the rung on every attempt before the
# writer runs, so for any implemented story it exists. A `command -v` guard or a `:-$DEFAULT`
# fallback would turn a missing record — a real defect — back into a silent judgement on the
# seam default, which is precisely what this replaces.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/story-outputs.sh"
    WORK="$(mktemp -d)"; export LOG_DIR="$WORK/logs"; mkdir -p "$LOG_DIR"
}
teardown() { rm -rf "$WORK"; }

# Record a rung THROUGH THE REAL PRODUCER, driving it with the writer's own variables — the
# same way claude.sh does. Never by hand-writing the JSON, which would let the file's shape
# drift from what the library actually writes.
record_rung() {  # $1 model  $2 provider  $3 effort  $4 temperature
    ( . "$LIB"
      STORY_MODEL="$1" STORY_PROVIDER="$2" EPAM_REASONING_EFFORT="$3" EPAM_TEMPERATURE="$4" \
      STORY_MAX_ITERATIONS=185 STORY_MAX_OUTPUT_TOKENS=32768 \
      story_rung_record "$LOG_DIR" "$5" )
}
rung() { ( . "$LIB"; story_rung_get "$LOG_DIR" "$1" "$2" ); }

# Blocks are EXTRACTED FROM THE REAL SCRIPTS and executed. A grep passes on a comment, on a
# dead branch, and on a call whose result is discarded — which is the shape of this defect.
extract() { awk -v pat="$2" -v n="$3" 'index($0,pat){f=1} f{print; if(++c>=n) exit}' "$1"; }

# ── The record itself ────────────────────────────────────────────────────────

@test "the producer captures the WHOLE rung, not just the model" {
    record_rung 'moonshotai/kimi-k3' 'openrouter' 'high' '0.7' S-1
    [ "$(rung S-1 model)"           = "moonshotai/kimi-k3" ]
    [ "$(rung S-1 provider)"        = "openrouter" ]
    [ "$(rung S-1 reasoningEffort)" = "high" ]
    [ "$(rung S-1 temperature)"     = "0.7" ]
}

@test "a story with no rung on record reads as ABSENT, never as a default" {
    [ -z "$(rung NEVER-RAN model)" ]
    [ -z "$(rung NEVER-RAN provider)" ]
}

@test "climbing the ladder OVERWRITES — the record is the rung it converged on" {
    # The whole point: the reviewer must follow the writer UP. A record that kept the first
    # attempt would pin every judge to rung 0 forever.
    record_rung 'MiniMax-M3'         'minimax'    ''       '0'   S-2
    record_rung 'z-ai/glm-5.2'       'openrouter' 'medium' '0'   S-2
    record_rung 'moonshotai/kimi-k3' 'openrouter' 'high'   '0.7' S-2
    [ "$(rung S-2 model)"           = "moonshotai/kimi-k3" ]
    [ "$(rung S-2 reasoningEffort)" = "high" ]
    [ "$(rung S-2 temperature)"     = "0.7" ]
}

# ── The writer writes it, on every attempt ───────────────────────────────────

@test "THE WRITER persists the rung at the rung boundary, before it is invoked" {
    # Extracted from claude.sh and executed: the call must sit AFTER the escalation block (so
    # it captures the escalated rung) and BEFORE the invocation (so a killed attempt still
    # leaves the rung it was running).
    esc=$(grep -n 'story_rung_record "$LOG_DIR" "$story_id"' "$SCRIPTS/claude.sh" | head -1 | cut -d: -f1)
    [ -n "$esc" ] || { echo "claude.sh never persists a rung"; false; }
    kb=$(grep -n 'local next_kb_id' "$SCRIPTS/claude.sh" | head -1 | cut -d: -f1)
    lad=$(grep -n 'InferenceLadder\[Rung3' "$SCRIPTS/claude.sh" | head -1 | cut -d: -f1)
    [ "$esc" -gt "$lad" ] || { echo "rung recorded BEFORE escalation — it would capture rung 0"; false; }
    [ "$esc" -lt "$kb" ]  || { echo "rung recorded after the prompt is built — too late"; false; }
}

@test "the writer's record is REACHABLE: the library is loaded in claude.sh" {
    run bash -c "grep -c 'lib/story-outputs.sh' '$SCRIPTS/claude.sh'"
    [ "$output" -ge 1 ]
    # and story_rung_record is genuinely defined by that library
    run bash -c ". '$LIB'; command -v story_rung_record"
    [ "$status" -eq 0 ]
}

# ── The reviewer inherits it ─────────────────────────────────────────────────

@test "THE REVIEWER takes the writer's model AND provider as parameters" {
    run bash -c "grep -n 'run_review_prompt \"\$REVIEW_PROMPT\"' '$SCRIPTS/team-lead-review.sh'"
    [[ "$output" == *'"$_rung_model" "$_rung_provider"'* ]] || {
        echo "the call site does not pass the rung: $output"; false; }
    sig=$(awk '/^run_review_prompt\(\) \{/{f=1} f{print; if(/_base_provider=/) exit}' \
          "$SCRIPTS/team-lead-review.sh")
    [[ "$sig" == *'_base_model="$writer_model"'* && "$sig" == *'_base_provider="$writer_provider"'* ]] || {
        echo "run_review_prompt does not take the rung as parameters"; false; }
}

@test "THE REVIEWER resolves the rung it will run — executed, not grepped" {
    record_rung 'moonshotai/kimi-k3' 'openrouter' 'high' '0.7' S-3
    block=$(extract "$SCRIPTS/team-lead-review.sh" '_rung_model=$(story_rung_get' 4)
    [ -n "$block" ]
    run bash -c '
        . '"$LIB"'; story_id=S-3; LOG_DIR='"$LOG_DIR"'
        '"$block"'
        echo "$_rung_model|$_rung_provider|$_rung_effort|$_rung_temperature"'
    [ "$output" = "moonshotai/kimi-k3|openrouter|high|0.7" ] || {
        echo "reviewer resolved '$output' — not the rung the writer converged on"; false; }
}

@test "THE REVIEWER APPLIES effort and temperature, not merely reads them" {
    # Reading the rung and invoking on the seam's effort/temp is the same defect with extra
    # logging. These are exported because that is how ai-run.sh reads them.
    blk=$(awk '/_rung_temperature=\$\(story_rung_get/{f=1} f{print; if(/^    log .*takes the writer/) exit}' \
          "$SCRIPTS/team-lead-review.sh")
    [[ "$blk" == *'export EPAM_REASONING_EFFORT="$_rung_effort"'* ]] || {
        echo "reasoning effort is read but never applied"; false; }
    [[ "$blk" == *'export EPAM_TEMPERATURE="$_rung_temperature"'* ]] || {
        echo "temperature is read but never applied"; false; }
}

@test "NO GUARD and NO FALLBACK stands between the reviewer and the record" {
    # The requirement is persistence, not defence. A guard here silently restores the old
    # behaviour the moment the record is missing.
    blk=$(awk '/THE REVIEWER RUNS THE WRITER/{f=1} f{print; if(/^    log .*takes the writer/) exit}' \
          "$SCRIPTS/team-lead-review.sh")
    [ -n "$blk" ]
    [[ "$blk" != *'command -v story_rung_get'* ]] || { echo "a command -v guard is back"; false; }
    [[ "$blk" != *'ORCH_GATE_MODEL}'* ]]         || { echo "a seam-default fallback is back"; false; }
    [[ "$blk" != *'read_story_retry_model'* ]]   || { echo "ladder resume state is being used again"; false; }
}

@test "a MISSING rung is refused out loud — never reviewed on the seam default" {
    blk=$(awk '/if \[ -z "\$_rung_model" \]; then/{f=1} f{print; if(/^    fi$/) exit}' \
          "$SCRIPTS/team-lead-review.sh")
    [ -n "$blk" ] || { echo "a missing rung is not handled at all"; false; }
    [[ "$blk" == *'changes_requested'* ]] || { echo "a missing rung could still approve"; false; }
    [[ "$blk" == *'reviewIncomplete'* ]]  || { echo "a failed review is not marked incomplete"; false; }
}

# ── The analyst inherits it too ──────────────────────────────────────────────

@test "THE ANALYST heals on the rung whose attempt it is analysing" {
    # Operator: "if analyst is used in a retry the self-heal ladder rung must be inherited by
    # the analyst." Diagnosing a stronger rung's attempt from a weaker one is guesswork about
    # reasoning the analyst cannot reproduce — and the diagnosis reads as authoritative anyway.
    record_rung 'moonshotai/kimi-k3' 'openrouter' 'high' '0.7' S-4
    # To the block's CLOSE, not a fixed line count — a truncated `if` is a bash syntax error
    # that the assertion would then report as a wrong model.
    block=$(awk '/_rung_model=\$\(story_rung_get/{f=1} f{print; if(/^fi$/) exit}' \
            "$SCRIPTS/agent-attempt-analyst.sh")
    [ -n "$block" ] || { echo "agent-attempt-analyst.sh never reads the attempt's rung"; false; }
    run bash -c '
        . '"$LIB"'; AGENT_ANALYST_STORY_ID=S-4; LOG_DIR='"$LOG_DIR"'
        SCRIPT_DIR='"$SCRIPTS"'; warning(){ :; }
        '"$block"'
        echo "$_rung_model|$_rung_provider"'
    [ "$output" = "moonshotai/kimi-k3|openrouter" ] || {
        echo "analyst resolved '$output' — not the rung that failed"; false; }
}

@test "THE ANALYST uses that rung for its own invocation" {
    sig=$(grep -nE '^_model=|^_provider=' "$SCRIPTS/agent-attempt-analyst.sh")
    [[ "$sig" == *'_rung_model'* ]]    || { echo "the analyst's model ignores the rung: $sig"; false; }
    [[ "$sig" == *'_rung_provider'* ]] || { echo "the analyst's provider ignores the rung: $sig"; false; }
}

@test "THE ANALYST applies the rung's effort and temperature as well" {
    blk=$(awk '/_rung_model=\$\(story_rung_get/{f=1} f{print; if(/^_model=/) exit}' \
          "$SCRIPTS/agent-attempt-analyst.sh")
    [[ "$blk" == *'EPAM_REASONING_EFFORT'* ]] || { echo "analyst ignores the rung's effort"; false; }
    [[ "$blk" == *'EPAM_TEMPERATURE'* ]]      || { echo "analyst ignores the rung's temperature"; false; }
}

# ── Isolation and lifecycle ──────────────────────────────────────────────────

@test "one story's rung does NOT leak into the next" {
    # Two stories, one reviewer process, different rungs. With a process-wide global the second
    # inherits the first whenever its own lookup is empty.
    record_rung 'moonshotai/kimi-k3' 'openrouter' 'high' '0.7' A-1
    record_rung 'MiniMax-M3'         'minimax'    ''     '0'   A-2
    [ "$(rung A-1 model)" = "moonshotai/kimi-k3" ]
    [ "$(rung A-2 model)" = "MiniMax-M3" ]
    [ "$(rung A-1 temperature)" = "0.7" ]
    [ "$(rung A-2 temperature)" = "0" ]
}

@test "the rung record does NOT survive the pre-run reset" {
    # The archive sweep matches *.log and story-outputs-*.txt only; this is a directory of
    # .json files under LOG_DIR. story-retry-state fell into that exact gap and needed its own
    # explicit clear. A survivor means the next run's judges inherit the PREVIOUS run's rung.
    record_rung 'last/run-model' 'openrouter' 'high' '0.7' S-STALE
    [ -n "$(rung S-STALE model)" ]
    blk=$(awk 'index($0,"_RUNG_STATE_DIR=\"$LOG_DIR")||f{f=1;print; if(f&&/^fi$/) exit}' \
          "$SCRIPTS/pre-run-reset.sh")
    [ -n "$blk" ] || { echo "pre-run-reset.sh does not clear the rung records"; false; }
    run bash -c '
        LOG_DIR='"$LOG_DIR"'; info(){ :; }; fail_contamination(){ echo "CONTAMINATED: $*"; exit 1; }
        '"$blk"'
        echo "remaining=$(find '"$LOG_DIR"'/story-rung -type f 2>/dev/null | wc -l)"'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" == *"remaining=0"* ]] || { echo "a prior run's rung survived: $output"; false; }
    [ -z "$(rung S-STALE model)" ]
}

@test "the reviewer's FIRST attempt runs the writer's provider, not the orchestration default" {
    # A surviving mutation found this gap: asserting the parameter is declared does not prove
    # the invocation uses it. Routing the same model through a different provider IS a different
    # setup — MiniMax direct vs via a gateway differed 99.8% on cache hits alone.
    blk=$(awk '/^        else$/{f=1;next} f{print; if(/_provider=/) exit}' \
          "$SCRIPTS/team-lead-review.sh")
    [ -n "$blk" ]
    run bash -c '
        _base_model="moonshotai/kimi-k3"; _base_provider="openrouter"
        EPAM_ORCHESTRATION_PROVIDER="should-not-win"
        '"$blk"'
        echo "$_model|$_provider"'
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [ "$output" = "moonshotai/kimi-k3|openrouter" ] || {
        echo "reviewer invoked '$output' — it dropped the writer's provider"; false; }
}
