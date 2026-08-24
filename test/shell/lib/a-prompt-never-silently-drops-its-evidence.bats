#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A VALUE NO PLACEHOLDER CONSUMES IS EVIDENCE THROWN AWAY.
#
# prompt-library.js render() throws on three things — a body using undeclared placeholders,
# a declaration never used, and a missing value — but NOT on a value supplied that nothing
# consumes. Those are silently dropped.
#
# engine-prompt.js rejects exactly that case: "'<id>' was given values it does not use". Two
# renderers, opposite strictness on the same class, and the lenient one loses evidence.
#
# Live 20260821T212250Z: the reviewer's prior-review text was generated correctly by
# lib/handlers/prior-reviews.py and supplied as __PRIOR_REVIEW__. metrolinx's prompt declares
# no such placeholder, so the value was dropped. All three review cycles ran with no memory of
# each other, and the approval missed a cleanup the earlier cycle had produced. The run log
# mentions prior review ZERO times — the only trace of a whole feedback loop going missing.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    LIB="$REPO_ROOT/orchestrations/scripts/lib/prompt-library.js"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

# render(doc, values) through the real library.
render() {  # $1 = body, $2 = placeholders csv, $3 = values json
    "$NODE" -e '
      const m = require(process.argv[1]);
      const doc = { id: "t", body: process.argv[2],
                    placeholders: process.argv[3] ? process.argv[3].split(",") : [] };
      try { process.stdout.write("OK:" + m.render(doc, JSON.parse(process.argv[4]))); }
      catch (e) { process.stdout.write("THREW:" + e.message); }
    ' "$LIB" "$1" "$2" "$3"
}

@test "the fixture is real — a well-formed render succeeds" {
    run render 'hello __A__' '__A__' '{"__A__":"world"}'
    [ "$output" = "OK:hello world" ]
}

@test "a missing value still fails loudly — the existing guard is untouched" {
    run render 'hello __A__' '__A__' '{}'
    [[ "$output" == THREW:* ]]
    [[ "$output" == *"missing values"* ]]
}

@test "THE DEFECT: a value nothing consumes must not be silently dropped" {
    # __B__ is supplied and appears nowhere. That is evidence the caller believed it sent.
    # LOUD, not fatal: throwing would take the reviewer out of every run whose project prompt
    # lags the template. The defect was the SILENCE — the drop itself is survivable.
    run bash -c "$(declare -f render); LIB='$LIB' NODE='$NODE' render 'hello __A__' '__A__' '{\"__A__\":\"world\",\"__B__\":\"the prior review\"}' 2>&1"
    [[ "$output" == *"__B__"* ]] || { echo "the drop was not reported at all"; false; }
    [[ "$output" == *"DROPPED"* ]] || { echo "the warning must say the evidence is dropped"; false; }
    [[ "$output" == *"OK:hello world"* ]] || { echo "it must still render — loud, not fatal"; false; }
}

@test "the refusal matches engine-prompt.js, which already rejects this" {
    run grep -c 'was given values it does not use' \
        "$REPO_ROOT/orchestrations/scripts/lib/engine-prompt.js"
    [ "$output" -ge 1 ]
}

@test "REPRODUCES the live loss: __PRIOR_REVIEW__ supplied to a prompt without it" {
    run bash -c "$(declare -f render); LIB='$LIB' NODE='$NODE' render 'Review this: __STORY_DIFF__' '__STORY_DIFF__' '{\"__STORY_DIFF__\":\"a diff\",\"__PRIOR_REVIEW__\":\"## YOUR PREVIOUS REVIEWS\"}' 2>&1"
    [[ "$output" == *"__PRIOR_REVIEW__"* ]]
    [[ "$output" == *"DROPPED"* ]]
}
