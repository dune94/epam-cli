#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# AN AGENT THAT SAID NOTHING MUST NOT COUNT AS AN AGENT THAT APPROVED.
#
# Live 2026-08-21, run 20260821T162533Z: the review-agent returned ZERO BYTES on its first
# three invocations. review-agent-AMSD-2041.log was empty, 8357 input tokens spent, nothing
# out. The pipeline survived only because this parser refuses to guess a verdict.
#
# That refusal had no test. The fleet audit written the same day checked that every agent
# receives its configuration — seam, budget, tools, chain — and checked nothing about what
# an agent RETURNS. team-lead-review passed all 17 of those while being unable to produce a
# verdict at all.
#
# The failure it guards against is documented in its own body:
#   2026-07-23  an unparseable review rubber-stamped an unreviewed change
#   2026-07-26  a repro-gate-verified fix was re-implemented on a phantom verdict
#   2026-07-31  a complete 10-blocker review discarded over one stray quote after a number
#
# Every one of those is a case below, executed against the real handler.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    PARSER="$REPO_ROOT/orchestrations/scripts/lib/handlers/team-lead-review-json.py"
}

# verdict_of <raw agent output>  -> the parsed verdict
verdict_of() { printf '%s' "$1" | python3 "$PARSER" | jq -r '.verdict // "NONE"'; }
incomplete_of() { printf '%s' "$1" | python3 "$PARSER" | jq -r '.reviewIncomplete // false'; }

@test "the fixture is real — the handler exists and answers" {
    [ -f "$PARSER" ]
    run bash -c "printf '%s' '{\"verdict\":\"approved\"}' | python3 '$PARSER'"
    [ "$status" -eq 0 ]
    [[ "$output" == *approved* ]]
}

# ── the live failure: the agent returned nothing ─────────────────────────────

@test "EMPTY output is NOT approved — the run that produced it spent 8357 tokens for silence" {
    [ "$(verdict_of '')" = "changes_requested" ]
}

@test "and empty output is flagged as a REVIEWER failure, not a code finding" {
    # The orchestration loop keys on this to re-run the REVIEW rather than re-implement a
    # story nobody looked at. Getting it wrong burns a writer attempt on a phantom verdict.
    [ "$(incomplete_of '')" = "true" ]
}

@test "whitespace-only output is not approved either" {
    [ "$(verdict_of '
	  ')" = "changes_requested" ]
}

@test "prose with no JSON at all is not approved" {
    [ "$(verdict_of 'I reviewed the change and it looks fine to me.')" = "changes_requested" ]
    [ "$(incomplete_of 'I reviewed the change and it looks fine to me.')" = "true" ]
}

@test "an object with no verdict key is not approved" {
    [ "$(verdict_of '{"summary":"all good","issues":[]}')" = "changes_requested" ]
}

@test "an ARRAY of reviews yields its FIRST object — documented, not asserted as safe" {
    # The handler's contract is "find the first JSON object", and it does. Pinning the real
    # behaviour rather than a stricter rule I would have had to change working code to meet.
    #
    # RESIDUAL RISK, recorded deliberately: an agent returning [approved, blocked] would be
    # read as approved and the later findings dropped — the partial-read-as-complete shape.
    # No agent has been observed emitting an array, so this is not fixed on a theory; if one
    # ever does, this test says exactly what will happen.
    [ "$(verdict_of '[{"verdict":"approved"}]')" = "approved" ]
}

@test "truncated JSON — the shape a cut-off agent produces — is not approved" {
    [ "$(verdict_of '{"verdict":"approved","issues":[{"severity":"bloc')" = "changes_requested" ]
}

# ── what must still get through ──────────────────────────────────────────────

@test "a real approval IS approved — the guard must not block everything" {
    # Without this the file passes by refusing every input, which proves nothing.
    [ "$(verdict_of '{"verdict":"approved","issues":[],"summary":"looks right"}')" = "approved" ]
    [ "$(incomplete_of '{"verdict":"approved","issues":[]}')" = "false" ]
}

@test "PRETTY-PRINTED JSON with nested issues parses — the 2026-07-07 regression" {
    # grep and the original regex both assumed flat single-line JSON, so every real
    # changes_requested review fell through to a hardcoded approved default.
    raw='{
  "verdict": "changes_requested",
  "issues": [
    { "severity": "blocker", "description": "hardcoded endpoint" },
    { "severity": "major",   "description": "no cleanup" }
  ],
  "summary": "two findings"
}'
    [ "$(verdict_of "$raw")" = "changes_requested" ]
    [ "$(incomplete_of "$raw")" = "false" ]
    [ "$(printf '%s' "$raw" | python3 "$PARSER" | jq '.issues | length')" -eq 2 ]
}

@test "JSON preceded by prose still parses — models narrate before answering" {
    raw='Here is my review:
{"verdict":"changes_requested","issues":[{"severity":"major","description":"x"}]}'
    [ "$(verdict_of "$raw")" = "changes_requested" ]
    [ "$(incomplete_of "$raw")" = "false" ]
}

@test "THE 2026-07-31 REPAIR: one stray quote after a number does not discard 10 blockers" {
    # A complete, valid review was thrown away because a field read "line":130", instead of
    # "line":130,. That token can never appear in valid JSON, so stripping exactly it is a
    # narrow repair — and it must still work.
    raw='{"verdict":"changes_requested","issues":[{"severity":"blocker","line":130","description":"real finding"}]}'
    [ "$(verdict_of "$raw")" = "changes_requested" ]
    [ "$(incomplete_of "$raw")" = "false" ]
    [ "$(printf '%s' "$raw" | python3 "$PARSER" | jq -r '.issues[0].description')" = "real finding" ]
}

@test "the repair is NARROW — it does not lenient-parse arbitrary broken JSON into approval" {
    # If the repair were a general fixer it could manufacture a verdict from noise.
    [ "$(verdict_of '{"verdict" "approved" issues [}')" = "changes_requested" ]
}

# ── the consumer ─────────────────────────────────────────────────────────────

@test "THE RECEIVER: the engine re-runs the REVIEW on incompleteness, not the writer" {
    # A story re-implemented on a phantom verdict costs a full writer attempt and changes
    # code nobody found fault with. The loop must key on reviewIncomplete.
    cd "$REPO_ROOT"
    run grep -n 'did not produce a verdict' orchestrations/scripts/run-agent-orchestration.sh
    [ "$status" -eq 0 ]
    [[ "$output" == *"re-running the REVIEW"* ]]
    [[ "$output" == *"not re-implementing"* ]]
}

@test "and reviewing NOTHING is never reported as approved" {
    cd "$REPO_ROOT"
    run grep -c 'reviewed NO stories — refusing to report approved' orchestrations/scripts/team-lead-review.sh
    [ "$output" -ge 1 ]
}
