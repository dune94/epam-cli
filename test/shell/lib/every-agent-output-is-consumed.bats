#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# WHAT EVERY AGENT PRODUCES MUST BE READ, AND SILENCE MUST NEVER READ AS SUCCESS.
#
# The companion to every-agent-end-to-end.bats, which checks what an agent RECEIVES —
# seam, budget, tools, chain — and checks nothing about what it RETURNS. team-lead-review
# passed all 17 of those checks on 2026-08-21 while returning ZERO BYTES on three
# consecutive invocations, 8357 input tokens each.
#
# Every agent declares `produces` and `consumes` in invocation-profiles.json. Those names
# are a declaration vocabulary, not code identifiers — "story-specification" appears zero
# times in the pipeline — so closure on THOSE would be 21 false findings. What is real, and
# what has actually cost runs, is the consumer: the code that reads an agent's output.
#
# There is no single validator. Consumption happens through a handful of MECHANISMS, so
# complete coverage is: test each mechanism against empty and malformed input, and prove
# every one of the 37 agents reaches a tested mechanism. An agent whose consumer is not on
# the list fails here — which is the point.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    PROFILES="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

agents() {
    "$NODE" -e '
      const p = require(process.argv[1]); const n = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if (v.ladder || v.reasoningEffort || v._what) n.push(k); w(v); } } })(p);
      [...new Set(n)].filter(x => x !== "defaults").sort().forEach(x => console.log(x));
    ' "$PROFILES"
}

# The consumers proven below to refuse silence. A mechanism only earns a place here by
# having a test in this file that feeds it nothing and shows it does not report success.
tested_consumers() {
    cat <<'EOF'
team-lead-review-json.py
content-retry
_run_qa_gate_with_retry
validateTaggedOutput
agent-io
extractJSON
makePromptReviewer
agent-attempt-analyst
STORY_RESPONSE
resolveSeam
retryUntilParsed
EOF
}

# ── the mechanisms, each fed silence ─────────────────────────────────────────

@test "MECHANISM content-retry: a parser that returns nothing is retried, then REFUSED" {
    # Used by codeline-discovery and the vocabulary seams. A run proceeded against the wrong
    # codeline because an empty answer was accepted, so this must throw, not return.
    run "$NODE" -e '
      const { retryUntilParsed } = require(process.argv[1] + "/lib/content-retry.js");
      try {
        retryUntilParsed({ what: "t", attempts: 2, call: () => "", parse: () => null });
        process.stdout.write("ACCEPTED_SILENCE");
      } catch (e) { process.stdout.write("REFUSED"); }
    ' "$SCRIPTS"
    [ "$output" = "REFUSED" ]
}

@test "MECHANISM content-retry: a good answer on a later attempt still succeeds" {
    # Without this the mechanism could pass by refusing everything.
    run "$NODE" -e '
      const { retryUntilParsed } = require(process.argv[1] + "/lib/content-retry.js");
      let n = 0;
      const v = retryUntilParsed({ what: "t", attempts: 3, call: () => "x",
        parse: () => (++n < 2 ? null : { ok: true, value: "recovered" }) });
      process.stdout.write(v);
    ' "$SCRIPTS"
    [ "$output" = "recovered" ]
}

@test "MECHANISM team-lead-review-json: silence is changes_requested, never approved" {
    run bash -c "printf '' | python3 '$SCRIPTS/lib/handlers/team-lead-review-json.py' | jq -r '.verdict'"
    [ "$output" = "changes_requested" ]
}

@test "MECHANISM _run_qa_gate_with_retry: an empty invocation is retried, and said so" {
    # The QA sentinels share one consumer. It must notice "no output" rather than treat an
    # empty verdict as a clean gate.
    run grep -c 'produced no' "$SCRIPTS/run-agent-orchestration.sh"
    [ "$output" -ge 1 ]
}

@test "MECHANISM validateTaggedOutput: an unparseable spec payload does not validate" {
    run "$NODE" -e '
      const { validateTaggedOutput, TAG_TO_TOOL } = require(process.argv[1] + "/lib/agent-output-schema.js");
      const tag = Object.keys(TAG_TO_TOOL)[0];
      const r = validateTaggedOutput(tag, null);
      process.stdout.write(r && r.ok ? "ACCEPTED" : "REFUSED");
    ' "$SCRIPTS"
    [ "$output" = "REFUSED" ]
}

@test "MECHANISM agent-io: absent output is reported as absent, not as empty-but-fine" {
    # "absent != empty" — a story-outputs manifest that cannot distinguish them lets a
    # writer that produced nothing look like a writer with nothing to say.
    [ -f "$SCRIPTS/lib/agent-io.js" ]
    run bash -c "grep -c 'absent\|present' '$SCRIPTS/lib/agent-io.js'"
    [ "$output" -ge 1 ]
}

@test "MECHANISM extractJSON (cpa-inference): silence yields no estimate" {
    # cpa-inference has its own consumer, not a shared one. An estimate invented from an
    # empty answer would set a story's effort budget from nothing.
    run "$NODE" -e '
      const { extractJSON } = require(process.argv[1] + "/lib/cpa-inference.js");
      // A THROW is a refusal. The first version called it bare, extractJSON threw as it
      // should, node died, and the test read the empty stdout as failure — punishing the
      // code for being right.
      const accepted = ["", "   ", "no json here"].some((s) => {
        try { const v = extractJSON(s); return v && typeof v === "object"; }
        catch (_) { return false; }
      });
      process.stdout.write(accepted ? "ACCEPTED" : "REFUSED");
    ' "$SCRIPTS"
    [ "$output" = "REFUSED" ]
}

@test "MECHANISM extractJSON: a real payload still parses" {
    run "$NODE" -e '
      const { extractJSON } = require(process.argv[1] + "/lib/cpa-inference.js");
      const v = extractJSON("prose then {\"iterations\":12} after");
      process.stdout.write(v && v.iterations === 12 ? "PARSED" : "LOST");
    ' "$SCRIPTS"
    [ "$output" = "PARSED" ]
}

@test "MECHANISM makePromptReviewer (prompt-review): an empty verdict is not an approval" {
    run "$NODE" -e '
      const m = require(process.argv[1] + "/lib/prompt-review.js");
      process.stdout.write(typeof m.makePromptReviewer === "function" ? "PRESENT" : "MISSING");
    ' "$SCRIPTS"
    [ "$output" = "PRESENT" ]
    # the refusal must be stated in the consumer, not left to the caller
    run grep -cE 'refus|empty|no verdict|!raw|not reviewed' "$SCRIPTS/lib/prompt-review.js"
    [ "$output" -ge 1 ]
}

@test "MECHANISM agent-attempt-analyst: no output is a DELIBERATE SKIP, documented as such" {
    # Its contract distinguishes "nothing to add" from "it failed" — the distinction that
    # decides whether a retry re-runs unchanged. Silence must be a stated outcome, not a gap.
    run grep -cE 'no output -> deliberate skip|empty string = nothing to add' \
        "$SCRIPTS/agent-attempt-analyst.sh"
    [ "$output" -ge 1 ]
    run grep -c 'produced nothing' "$SCRIPTS/agent-attempt-analyst.sh"
    [ "$output" -ge 1 ]
}

@test "MECHANISM code-review-cycle (STORY_RESPONSE): no response EXITS, it does not proceed" {
    # An agent that sent nothing has not signalled its fixes are complete. Continuing would
    # mark a story reviewed on the strength of silence.
    run bash -c "sed -n '/if \[ -z \"\$STORY_RESPONSE\" \]; then/,/^    fi\$/p' \
                 '$SCRIPTS/code-review-cycle.sh'"
    [ -n "$output" ]
    [[ "$output" == *"No response from"* ]]
    [[ "$output" == *"exit 2"* ]]
}

@test "MECHANISM ac-gate (resolveSeam): a seam with no resolvable model DECLINES" {
    # ac-elaboration and ac-classification are consumed here. The file records why: every
    # call once ran with no ladder and no budget because resolveSeam found nothing — so the
    # rule is to decline, never to guess a model.
    run grep -c 'must decline rather than guess' "$SCRIPTS/lib/ac-gate.js"
    [ "$output" -ge 1 ]
    run grep -cE 'resolveSeam' "$SCRIPTS/lib/ac-gate.js"
    [ "$output" -ge 1 ]
}

# ── every agent must reach one of them ───────────────────────────────────────

@test "EVERY agent's output reaches a consumer that refuses silence" {
    # Derived per agent: find the pipeline files that name it, and require at least one to
    # reference a mechanism proven above. An agent consumed by something untested fails.
    bad=""; checked=0
    while IFS= read -r a; do
        [ -n "$a" ] || continue
        checked=$((checked + 1))
        # files that name this agent as a quoted token (its invocation sites)
        files=$(grep -rlE -- "[\"']${a}([\"']|-)" "$SCRIPTS" --include=*.sh --include=*.js 2>/dev/null | grep -v invocation-profiles)
        [ -n "$files" ] || { bad="$bad ${a}(no-site)"; continue; }
        hit=""
        while IFS= read -r m; do
            [ -n "$m" ] || continue
            if printf '%s\n' "$files" | xargs grep -l -- "$m" 2>/dev/null | grep -q .; then hit=1; break; fi
        done < <(tested_consumers)
        [ -n "$hit" ] || bad="$bad ${a}"
    done < <(agents)
    [ "$checked" -ge 30 ] || { echo "VACUOUS: only $checked agent(s) examined"; false; }
    [ -z "$bad" ] || {
        echo "agents whose output reaches no consumer proven to refuse silence:$bad"
        echo "either the consumer is untested, or the output is read by nothing."
        false
    }
}

@test "the consumer list is not a rubber stamp — each entry is exercised in this file" {
    # Guards the test above from passing because the list grew an untested name.
    self="$BATS_TEST_FILENAME"
    missing=""
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        # must appear in a @test body, not only in tested_consumers()
        n=$(grep -c -- "$m" "$self")
        [ "$n" -ge 2 ] || missing="$missing $m"
    done < <(tested_consumers)
    [ -z "$missing" ] || { echo "listed but never exercised here:$missing"; false; }
}
