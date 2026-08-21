#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A FAILED RENDER MUST NOT BECOME AN EMPTY PROMPT.
#
# lib/render-engine-prompt.sh states its own contract:
#
#   "Exit status is the contract: non-zero means nothing was rendered, and the caller must
#    refuse to invoke an agent rather than send it an empty prompt."
#
# `|| true` discards exactly that. The value becomes "", the agent is invoked anyway, and it
# receives no directive at all — no error, no warning, and on two of the three sites the
# reason was additionally hidden behind 2>/dev/null.
#
# This is not hypothetical: preflight-static.sh's own ratchet exists because "a template value
# no producer supplies" caused THREE live render failures. On a swallowing caller each of those
# is an agent silently told nothing.
#
# The correct shape is already in the repo — update-invalidated-tests.sh:
#     if ! _prompt="$(render_engine_prompt <id> "$vals")"; then <refuse> ; fi
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/render-engine-prompt.sh"
    WORK="$(mktemp -d)"
}
teardown() { rm -rf "$WORK"; }

@test "the contract is the library's own, not this test's invention" {
    run grep -c 'Exit status is the contract' "$LIB"
    [ "$output" -ge 1 ]
}

@test "EXECUTED: an unrenderable template really does exit non-zero and emit nothing" {
    # Guards against the whole file being vacuous: if a bad render exited 0, every caller
    # would be correct by accident and this suite would prove nothing.
    printf '{}' > "$WORK/vals.json"
    run bash -c ". '$LIB'; render_engine_prompt definitely-not-a-template '$WORK/vals.json'"
    [ "$status" -ne 0 ]
    [ -z "$output" ] || [[ "$output" != *"__"* ]]
}

@test "and a missing values file is refused rather than rendered empty" {
    run bash -c ". '$LIB'; render_engine_prompt some-template '$WORK/nope.json'"
    [ "$status" -ne 0 ]
}

@test "NO CALLER SWALLOWS A FAILED RENDER" {
    cd "$REPO_ROOT"
    bad=""
    while IFS= read -r hit; do
        [ -n "$hit" ] || continue
        bad="${bad}
  ${hit}"
    done < <(grep -rnE 'render_engine_prompt ' "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh 2>/dev/null \
             | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
             | grep -E '\|\|[[:space:]]*(true|echo "")' \
             | cut -c1-150)
    [ -z "$bad" ] || {
        echo "a failed render is discarded — the agent is invoked with an empty prompt:$bad"
        echo "the library's contract: non-zero means nothing was rendered."
        false
    }
}

@test "and no caller hides WHY a render failed" {
    # 2>/dev/null on the render turns "template value no producer supplies" into silence.
    cd "$REPO_ROOT"
    bad=$(grep -rnE 'render_engine_prompt ' "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh 2>/dev/null \
          | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
          | grep -E '2>/dev/null' | cut -c1-150)
    [ -z "$bad" ] || { echo "the reason for a failed render is discarded:"; echo "$bad"; false; }
}

@test "the scan is not vacuous — callers exist to be checked" {
    cd "$REPO_ROOT"
    n=$(grep -rlE 'render_engine_prompt ' "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh 2>/dev/null | wc -l)
    [ "$n" -ge 3 ]
}
