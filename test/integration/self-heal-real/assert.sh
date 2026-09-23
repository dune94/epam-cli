#!/usr/bin/env bash
# The assertions. Each one names the live failure it exists to prevent.
# Read from what the pipeline itself wrote — nothing is inferred from what a model said.
set -uo pipefail
W="${WORK:?}"; LOGS="$W/install/orchestrations/logs"; RUN="${RUNLOG:?}"
PLAIN="$W/run.plain.log"; sed 's/\x1b\[[0-9;]*m//g' "$RUN" > "$PLAIN"
FAILURES="$LOGS/story-failures.jsonl"; HEAL="$LOGS/healing-events.jsonl"
rc=0
pass(){ printf '  PASS  %s\n' "$1"; }
fail(){ printf '  FAIL  %s\n     -> %s\n' "$1" "$2"; rc=1; }

echo "== the failure must be REAL, and the one that happened =="
# 360 conversion functions plus their tests cannot be emitted in 8,192 tokens. The starvation is
# arithmetic, not hope: if attempt 1 did NOT hit the cap, this fixture is no longer a valid
# reproduction and the test says so rather than passing vacuously.
if grep -q '"failureClass":"output_cap"' "$FAILURES" 2>/dev/null; then
  pass "attempt 1 failed as output_cap — the live failure is reproduced"
else
  fail "attempt 1 did not fail as output_cap" "no output_cap record in $FAILURES — the fixture no longer starves the writer, so nothing below is meaningful"
  echo "== VACUOUS — stopping =="; exit 1
fi

echo "== no failure may be filtered out of self-heal =="
# LIVE: healing-events.jsonl was 0 bytes for two days. run_failure_analyst returned at its second
# line unless VERIFICATION_FAILURE was set, and an attempt truncated at its cap never reaches
# verification — so the analyst was invoked ZERO times across two paid runs.
if [ -s "$HEAL" ] && grep -q '${STORY:-REGI-009a}' "$HEAL"; then
  pass "the analyst ran on the failed attempt"
else
  fail "the analyst never ran" "healing-events.jsonl is empty — the failure was filtered out of self-heal"
fi

echo "== the analyst must be told what failed =="
# Its declared input failure-evidence has no declared producer (agent census, 2026-09-22), so
# nothing governed what it received. It must contain the class, the provisioning and the evidence.
ain="$(ls -t "$LOGS"/*analyst*.log 2>/dev/null | head -1)"
if [ -n "$ain" ] && grep -q "output_cap" "$ain" && grep -qE "8192|max_tokens|truncat" "$ain"; then
  pass "the analyst's input carried the failure summary"
else
  fail "the analyst's input did not carry the failure summary" "${ain:-no analyst log at all}"
fi

echo "== the analyst must remedy the next attempt =="
# LIVE: the budget moved once, by a hardcoded engine bump (8192 -> 32768), and maxIter stayed at 6
# for every attempt. The remedy must come from the analyst and must reach the next attempt.
mapfile -t efforts < <(grep -ao 'Effort\[final\] -> maxIter=[0-9]* maxOutTok=[0-9]*' "$PLAIN")
if [ "${#efforts[@]}" -ge 2 ]; then
  a1_it=$(sed 's/.*maxIter=\([0-9]*\).*/\1/' <<<"${efforts[0]}"); a2_it=$(sed 's/.*maxIter=\([0-9]*\).*/\1/' <<<"${efforts[1]}")
  a1_ot=$(sed 's/.*maxOutTok=\([0-9]*\).*/\1/' <<<"${efforts[0]}"); a2_ot=$(sed 's/.*maxOutTok=\([0-9]*\).*/\1/' <<<"${efforts[1]}")
  if [ "$a2_ot" -gt "$a1_ot" ] || [ "$a2_it" -gt "$a1_it" ]; then
    pass "attempt 2 was provisioned differently (iter $a1_it->$a2_it, out $a1_ot->$a2_ot)"
  else
    fail "attempt 2 repeated the starved provisioning" "iter $a1_it->$a2_it, out $a1_ot->$a2_ot"
  fi
  if grep -qiE "analyst.*(budget|iteration|output|effort)|\[FailureAnalyst\].*(rais|increas|budget|iteration)" "$PLAIN"; then
    pass "the change is attributable to the analyst"
  else
    fail "nothing attributes the change to the analyst" "a deterministic bump is not self-heal"
  fi
else
  fail "there was no second attempt to inspect" "only ${#efforts[@]} Effort[final] line(s)"
fi

echo "== the loop must recover =="
# Not model luck: if a real model cannot finish this story, the cause is what the pipeline gave it,
# and the artefacts above say which input was missing.
if python3 - "$W/prd.json" <<'PY'
import json,sys
print('completed' if json.load(open(sys.argv[1]))['stories'][0].get('status')=='completed' else 'not')
PY
  [ "$(python3 -c "import json;print(json.load(open('$W/prd.json'))['stories'][0].get('status'))")" = "completed" ]; then
  pass "the story completed after self-heal"
else
  fail "the story did not complete" "see $RUN and $LOGS"
fi

echo; [ $rc -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"; exit $rc
