#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# WHAT THE REVIEWER WRITES MUST PARSE WITH WHAT READS IT.
#
# Live, 2026-08-21, metrolinx AMSD-2041: the reviewer flagged a hardcoded endpoint and a
# wrong SDK config key as `major` in cycle 2, then APPROVED the same code in cycle 3 with
# both still present. It had no memory of its own findings.
#
# The prompt wiring was correct — team-lead-review.sh:653 injects __PRIOR_REVIEW__, built
# from lib/handlers/prior-reviews.py. Running that handler against the real log returned
# ZERO BYTES, because:
#
#   1. jq -n WITHOUT -c writes pretty-printed multi-line JSON into a .jsonl file.
#      0 of 24 lines parsed. prior-reviews.py reads line-by-line and its own header says
#      "a malformed line is skipped, never fatal" — so every line was skipped, silently.
#   2. The record has no `story` field (the handler filters on it) — it is a PHASE
#      summary: phase_id, review_status, issues_found, stories_reviewed.
#   3. It carries no `issues`, so even correctly parsed there is nothing to feed back.
#
# A SECOND consumer broke on cause 1 alone: run-agent-orchestration.sh:10837 greps
# '"phase_id":"<phase>"' — compact form — and matched 0 lines.
#
# And the failure was swallowed twice: `2>/dev/null || true` at the call site makes an
# unreadable log indistinguishable from a first review.
#
# Every unit here had tests. Nobody ever ran the writer's output into the reader.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    WRITER="$SCRIPTS/team-lead-review.sh"
    READER="$SCRIPTS/lib/handlers/prior-reviews.py"
    WORK="$(mktemp -d)"
    export REVIEW_LOG="$WORK/code-reviews.jsonl"
}
teardown() { rm -rf "$WORK"; }

# THE PER-STORY RECORD, lifted from INSIDE the writer's story loop and executed.
#
# The first version of this fixture extracted the PHASE-SUMMARY block at the end of the
# file and set STORY_ID/REVIEW_ISSUES itself. Those variables do not exist there — the
# story loop closes ~100 lines earlier — so the fixture manufactured a precondition the
# script never has, and every test passed against an inert fix. Extract from where the
# data actually lives, and set only what the loop itself provides.
story_block() {
    sed -n "/THE REVIEWER'S MEMORY OF THIS STORY/,/^    fi\$/p" "$WRITER"
}

write_record() {   # $1=phase $2=verdict $3=story_id  (issues via $REVIEW_ISSUES)
    {
        echo "PHASE_ID='$1'; STORY_VERDICT='$2'; story_id='$3'"
        echo "REVIEW_JSON='{\"issues\": ${REVIEW_ISSUES:-[]}}'"
        echo 'warning() { echo "WARN: $*"; }'
        story_block
    } > "$WORK/w.sh"
    bash "$WORK/w.sh"
}

@test "the extraction is real — the writer's own in-loop record lines" {
    block=$(story_block)
    [ -n "$block" ]
    [ "$(printf '%s\n' "$block" | wc -l)" -gt 8 ]
    [[ "$block" == *"jq -cn"* ]]
    [[ "$block" == *'>> "$REVIEW_LOG"'* ]]
}

@test "THE FIXTURE-FIDELITY GUARD: the record uses only variables the loop really sets" {
    # This is the assertion whose absence made the first fix inert. Every shell variable the
    # extracted block reads must be assigned INSIDE the story loop, not invented by a test.
    block=$(story_block)
    bad=""
    # jq's own --arg/--argjson names are jq variables, not shell ones — exclude them.
    jqvars=$(printf '%s' "$block" | grep -oE -- '--arg(json)? +[A-Za-z_][A-Za-z0-9_]*' \
             | awk '{print $NF}' | sort -u | tr '\n' '|')
    for v in $(printf '%s' "$block" | grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*' | tr -d '${' | sort -u); do
        case "$v" in PHASE_ID|STORY_VERDICT|story_id|REVIEW_JSON|REVIEW_LOG|LOG_DIR|AUTOMATION_DIR) continue;; esac
        [ -n "$jqvars" ] && case "|$jqvars" in *"|$v|"*) continue;; esac
        grep -qE "^[[:space:]]*(export )?${v}=" "$WRITER" || bad="$bad $v"
    done
    [ -z "$bad" ] || { echo "record reads variables nothing assigns:$bad"; false; }
}

@test "THE FILE IS JSONL: every record is exactly one line of valid JSON" {
    write_record core changes_requested S-1
    write_record core approved S-1
    [ "$(wc -l < "$REVIEW_LOG")" -eq 2 ]
    while IFS= read -r line; do
        printf '%s' "$line" | jq -e . >/dev/null || { echo "not valid JSON on one line: $line"; false; }
    done < "$REVIEW_LOG"
}

@test "THE SEAM: the reader gets non-empty history back from what the writer wrote" {
    # The whole defect, in one assertion.
    write_record core changes_requested S-1
    run python3 "$READER" "$REVIEW_LOG" S-1
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" == *"PREVIOUS REVIEWS"* ]]
}

@test "and the history carries the ISSUES, not just a count" {
    REVIEW_ISSUES='[{"severity":"major","description":"hardcoded endpoint api.example.invalid"}]' \
        write_record core changes_requested S-1
    run python3 "$READER" "$REVIEW_LOG" S-1
    [[ "$output" == *"hardcoded endpoint"* ]]
}

@test "history is scoped to the story — another story's findings do not leak in" {
    write_record core changes_requested S-1
    write_record core changes_requested S-2
    run python3 "$READER" "$REVIEW_LOG" S-2
    [ -n "$output" ]
    run python3 "$READER" "$REVIEW_LOG" S-NOBODY
    [ -z "$output" ]
}

@test "THE SECOND CONSUMER: the engine's compact-form grep matches" {
    # run-agent-orchestration.sh:10837 greps '"phase_id":"<phase>"'. Pretty-printed
    # output has a space after the colon and matched nothing.
    write_record core approved S-1
    run grep -c '"phase_id":"core"' "$REVIEW_LOG"
    [ "$output" -ge 1 ]
}

@test "the call site does not swallow the reader's failure" {
    # `2>/dev/null || true` made an unreadable log look exactly like a first review.
    run grep -n 'prior-reviews.py' "$WRITER"
    [[ "$output" != *"2>/dev/null || true"* ]]
}

@test "an unreadable log is REPORTED, not silently treated as no history" {
    # BOTH, not either. `||` here would pass on the stderr message alone while the exit
    # status still said "fine" — and the exit status is what the call site reads.
    printf 'this is not json\n' > "$REVIEW_LOG"
    run python3 "$READER" "$REVIEW_LOG" S-1
    [ "$status" -ne 0 ]
    [[ "$output" == *"not JSONL"* ]] || [[ "$output" == *"none parseable"* ]]
}

@test "and a log with SOME bad lines still yields the good ones" {
    # The handler's original promise — one bad line must not cost the history — must
    # survive the stricter rule above.
    write_record core changes_requested S-1
    printf 'garbage not json\n' >> "$REVIEW_LOG"
    write_record core approved S-1
    run python3 "$READER" "$REVIEW_LOG" S-1
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}
