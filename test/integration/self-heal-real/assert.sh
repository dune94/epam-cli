#!/usr/bin/env bash
# The assertions. Each one names the live failure it exists to prevent.
# Read from what the pipeline itself wrote — nothing is inferred from what a model said.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="${WORK:?}"; LOGS="$W/install/orchestrations/logs"; RUN="${RUNLOG:?}"
PLAIN="$W/run.plain.log"; sed 's/\x1b\[[0-9;]*m//g' "$RUN" > "$PLAIN"
FAILURES="$LOGS/story-failures.jsonl"; HEAL="$LOGS/healing-events.jsonl"
rc=0
pass(){ printf '  PASS  %s\n' "$1"; }
fail(){ printf '  FAIL  %s\n     -> %s\n' "$1" "$2"; rc=1; }

echo "== the failure must be REAL, and the one that happened =="
# WHAT THE ATTEMPT ACTUALLY FAILED AS -- not a class named here in advance.
# This demanded output_cap, because that is what starved the writer when the harness was written:
# 360 conversion functions in 8,192 tokens. The ceilings work of 2026-09-22 raised the writer to
# the model's own maximum, so output_cap can no longer occur naturally -- and this assertion then
# declared VACUOUS on every run, which meant the harness could never certify anything at all.
#
# The premise the harness actually rests on is NOT "the failure was output_cap". It is "attempt 1
# really failed, and the self-heal loop then recovered the story". So it reads the class the
# pipeline itself recorded and carries it forward. Vacuity is still refused, for the true reason:
# no recorded failure at all means there was nothing to heal.
CLASS="$(python3 "$HERE/failure-class.py" "$FAILURES" "$STORY" 2>/dev/null)"
if [ -n "$CLASS" ]; then
  pass "attempt 1 failed for real, as $CLASS — there is something to heal"
else
  fail "no attempt failure was recorded at all" "nothing in $FAILURES for $STORY — the fixture no longer makes the writer fail, so nothing below is meaningful"
  echo "== VACUOUS — stopping =="; exit 1
fi

echo "== no failure may be filtered out of self-heal =="
# LIVE: healing-events.jsonl was 0 bytes for two days. run_failure_analyst returned at its second
# line unless VERIFICATION_FAILURE was set, and an attempt truncated at its cap never reaches
# verification — so the analyst was invoked ZERO times across two paid runs.
# THE LITERAL-STRING GREP. Single quotes meant this searched healing-events.jsonl for the twenty
# characters ${STORY:-REGI-009a} rather than for the story, so it could only ever fail.
if [ -s "$HEAL" ] && grep -q "$STORY" "$HEAL"; then
  pass "the analyst ran on the failed attempt"
else
  fail "the analyst never ran" "healing-events.jsonl is empty — the failure was filtered out of self-heal"
fi

echo "== the analyst must be told what failed =="
# Its declared input failure-evidence has no declared producer (agent census, 2026-09-22), so
# nothing governed what it received. It must contain the class, the provisioning and the evidence.
# The class is whatever the pipeline recorded above, and the provisioning is whatever it handed
# the attempt -- neither is named here. Hardcoding "output_cap" and "8192" pinned this to one run.
ain="$(ls -t "$LOGS"/*analyst*.log 2>/dev/null | head -1)"
if [ -n "$ain" ] && grep -q "$CLASS" "$ain" && grep -qE "maxOutputTokens|maxIterations|max_tokens" "$ain"; then
  pass "the analyst's input carried the failure summary (class $CLASS + provisioning)"
else
  fail "the analyst's input did not carry the failure summary (expected class $CLASS and the provisioning)" "${ain:-no analyst log at all}"
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
