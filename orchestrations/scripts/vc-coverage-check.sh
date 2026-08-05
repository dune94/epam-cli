#!/usr/bin/env bash
# vc-coverage-check.sh — does the written test actually cover every verification
# criterion? Asks a model, one criterion at a time, and reports.
#
# Live metrolinx 2026-07-26, run 7. Three verification criteria were written; the
# generated test covered two — unprompted and well — and silently skipped the
# third (the negative case: no promo code, so no discount shown). Nothing
# noticed. The bug-reproduction gate proves a test fails before the fix and
# passes after; it says nothing about whether the test covers the criteria the
# story was accepted against. A change can be "proven" while a stated
# requirement goes entirely untested.
#
# WHY A MODEL, having first tried not to. A term-overlap version was written and
# thrown away: tested against this very run it reported "0 of 3 uncovered",
# because the negative criterion ("no promo code ... does NOT display") shares
# the words "return" and "trip" with the positive test that asserts the discount
# IS applied. Bag-of-words cannot represent negation, and special-casing "not"
# would be English hardcoded into the engine. False assurance is worse than a
# known gap, so that approach was deleted rather than shipped.
#
# This is the narrow use of a model that has worked elsewhere in this pipeline
# (the detective's evidence gate): a single closed question about artefacts that
# both exist, answered yes/no with a reason — verification, not generation.
#
# ADVISORY. Always exits 0. A coverage opinion must never fail a run: the test
# has already been proven RED→GREEN by execution, and a model's doubt is weaker
# evidence than that. It reports so a human, or a later gate, can act.
#
# Usage:
#   vc-coverage-check.sh --prd <file> --story <id> --test-file <path> [--out <file>]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"

PRD_FILE=""; STORY_ID=""; TEST_FILE=""; OUT_FILE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --prd)       PRD_FILE="${2:-}"; shift 2 ;;
        --story)     STORY_ID="${2:-}"; shift 2 ;;
        --test-file) TEST_FILE="${2:-}"; shift 2 ;;
        --out)       OUT_FILE="${2:-}"; shift 2 ;;
        *) shift ;;
    esac
done

log() { echo "  [vc-coverage] $*"; }

[ -f "${PRD_FILE:-}" ] && [ -n "$STORY_ID" ] || { log "no PRD/story — skipping"; exit 0; }
[ -f "${TEST_FILE:-}" ] || { log "no test file — skipping"; exit 0; }

_vcs_json=$(jq -c --arg id "$STORY_ID" \
    '[.stories[] | select(.id == $id) | .verificationCriteria[]? | select(type == "string")]' \
    "$PRD_FILE" 2>/dev/null || echo '[]')
_vc_count=$(printf '%s' "$_vcs_json" | jq 'length' 2>/dev/null || echo 0)
[ "${_vc_count:-0}" -gt 0 ] || { log "no verification criteria — nothing to check"; exit 0; }

# The whole test, not an extract. Reading it is the point: a summary would put
# the model back to guessing, which is what the discarded version did.
#
# The comment said that while the code did `head -c 24000` — silently. Real test files in
# these codelines reach 59-65KB, so the tail of a large test was judged ABSENT rather than
# unread, and this step is what decides whether a verification criterion is covered. A cap
# here manufactures the "uncovered VC" verdicts it exists to report.
_test_src=$(cat "$TEST_FILE" 2>/dev/null)
[ -n "$_test_src" ] || { log "test file unreadable — skipping"; exit 0; }

_uncovered=0
_results="[]"

for _i in $(seq 0 $(( _vc_count - 1 ))); do
    _vc=$(printf '%s' "$_vcs_json" | jq -r ".[$_i]" 2>/dev/null)
    [ -n "$_vc" ] || continue

    _prompt="You are checking whether a test suite covers ONE specific requirement.

## The requirement
${_vc}

## The test file (complete)
\`\`\`
${_test_src}
\`\`\`

Answer ONE question: does this test file contain a case that would FAIL if this
requirement were violated?

Judge the ASSERTIONS, not the titles. A test whose name mentions the same words
is irrelevant if it does not actually exercise the requirement — in particular a
requirement stating something must NOT happen is not covered by a test asserting
that it DOES happen, however similar the wording.

Output ONLY this JSON, nothing else:
{\"covered\": true|false, \"case\": \"<the test case name that covers it, or empty>\", \"why\": \"<one sentence>\"}"

    _raw=$(printf '%s' "$_prompt" | \
        EPAM_ALLOWED_TOOLS="${VC_COVERAGE_ALLOWED_TOOLS:-}" \
        EPAM_AGENT_NAME="vc-coverage" EPAM_STORY_ID="$STORY_ID" \
        timeout "${VC_COVERAGE_TIMEOUT_SECS:-300}" \
        bash "$AI_RUNNER_CMD" --provider "${ORCH_GATE_PROVIDER:-qwen}" \
             --model "${VC_COVERAGE_MODEL:-${ORCH_GATE_MODEL:-z-ai/glm-5.2}}" 2>/dev/null || echo "")

    _verdict=$(printf '%s' "$_raw" | python3 -c '
import json, sys
raw = sys.stdin.read()
dec = json.JSONDecoder()
i = 0
while True:
    s = raw.find("{", i)
    if s == -1:
        break
    try:
        obj, end = dec.raw_decode(raw, s)
        if isinstance(obj, dict) and "covered" in obj:
            print(json.dumps(obj)); sys.exit(0)
        i = end
    except ValueError:
        i = s + 1
print("")
' 2>/dev/null || echo "")

    if [ -z "$_verdict" ]; then
        # No answer is NOT evidence of a gap. Say so rather than counting it.
        log "UNKNOWN   ${_vc:0:100}"
        log "          the checker returned no usable verdict — not counted either way"
        _results=$(printf '%s' "$_results" | jq -c --arg vc "$_vc" \
            '. + [{vc:$vc, covered:null}]' 2>/dev/null || printf '%s' "$_results")
        continue
    fi

    _covered=$(printf '%s' "$_verdict" | jq -r '.covered // false' 2>/dev/null)
    _case=$(printf '%s' "$_verdict" | jq -r '.case // ""' 2>/dev/null)
    _why=$(printf '%s' "$_verdict" | jq -r '.why // ""' 2>/dev/null)
    if [ "$_covered" = "true" ]; then
        log "COVERED   ${_vc:0:100}"
        [ -n "$_case" ] && log "          ↳ ${_case:0:100}"
    else
        _uncovered=$(( _uncovered + 1 ))
        log "UNCOVERED ${_vc:0:110}"
        [ -n "$_why" ] && log "          ${_why:0:110}"
    fi
    _results=$(printf '%s' "$_results" | jq -c --argjson v "$_verdict" --arg vc "$_vc" \
        '. + [($v + {vc:$vc})]' 2>/dev/null || printf '%s' "$_results")
done

log "VC_UNCOVERED=${_uncovered} of ${_vc_count}"
if [ "$_uncovered" -gt 0 ]; then
    log "the change is still proven by the bug-reproduction gate — this is a COVERAGE gap, not a correctness one"
fi
[ -n "$OUT_FILE" ] && printf '%s\n' "$_results" > "$OUT_FILE" 2>/dev/null

exit 0   # ADVISORY: never fails a run
