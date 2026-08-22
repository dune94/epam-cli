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
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"
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

    # RENDERED FROM THE TEMPLATE LAYER. Values via a file, never argv.
    _tpl_vals=$(mktemp "${TMPDIR:-/tmp}/vc-coverage-vals-XXXXXX.json")
    jq_vals --arg test_source "$_test_src" \
          --arg verification_criterion "$_vc" \
          '{"__TEST_SOURCE__":$test_source,"__VERIFICATION_CRITERION__":$verification_criterion}' > "$_tpl_vals" 2>/dev/null
    if ! _prompt=$(render_engine_prompt vc-coverage "$_tpl_vals"); then
        echo "[vc-coverage] cannot render its prompt — refusing to run with no instructions" >&2
        rm -f "$_tpl_vals"; exit 1
    fi
    rm -f "$_tpl_vals"

    # NO SUBSTITUTED MODEL. This ended `:-z-ai/glm-5.2`, so a broken ladder produced a coverage
    # verdict on a model the run never chose — and a coverage verdict is acted on. Refusing is
    # loud and fixable; substituting is silent and only visible in a bill.
    #
    # This runs at TOP LEVEL and the gate is ADVISORY (`exit 0` at the end, never fails a run),
    # so refusing means producing NO verdict — not a non-zero exit, which would change the
    # gate's contract, and not a substituted model, which would produce a verdict that looks
    # real. An absent coverage finding is honest; a fabricated one is acted on.
    _vcc_model="${VC_COVERAGE_MODEL:-${ORCH_GATE_MODEL:-}}"
    if [ -z "$_vcc_model" ]; then
        log "no model resolved for this seam — its ladder declares none, or the tier's chain is unset."
        log "Refusing to substitute one: NO coverage verdict this run, rather than a guessed model's."
        _raw=""
    else
    _raw=$(printf '%s' "$_prompt" | \
        EPAM_ALLOWED_TOOLS="${VC_COVERAGE_ALLOWED_TOOLS:-}" \
        EPAM_AGENT_NAME="vc-coverage" EPAM_STORY_ID="$STORY_ID" \
        timeout "${VC_COVERAGE_TIMEOUT_SECS:-300}" \
        bash "$AI_RUNNER_CMD" --provider "${ORCH_GATE_PROVIDER:-}" \
             --model "$_vcc_model" 2>/dev/null || echo "")
    fi

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
