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
# Read from what the pipeline PERSISTED (LOG_DIR/analyst-inputs/<story>.attempt-N.md), not from a
# log name guessed here. A suite that ran hands the analyst its output; an attempt that never
# reached one hands it the class and the provisioning — so the class is required only then.
ain="$(ls -t "$LOGS"/analyst-inputs/"$STORY".attempt-*.md 2>/dev/null | head -1)"
if [ -z "$ain" ] || [ ! -s "$ain" ]; then
  fail "the analyst's input is not on disk" "nothing under $LOGS/analyst-inputs for $STORY — its diagnosis cannot be checked"
elif grep -q "Verification Failure\|FAILED\|AssertionError\|Error" "$ain" || grep -q "$CLASS" "$ain"; then
  pass "the analyst's input is persisted and carries the failure ($(basename "$ain"))"
else
  fail "the analyst's input carries neither the suite's failure nor the class $CLASS" "$ain"
fi

echo "== the analyst's remedy must reach what comes next =="
# THE REMEDY IT CHOSE, not one named here. The analyst answers with a target: a budget for a
# starved attempt, an escalation for a defect in another story's file, guidance for a wrong
# approach. Each has its own proof. (2026-09-24: this demanded a budget change when the analyst
# had correctly escalated, and credited a ladder effort step to nobody.)
TARGETS="$(python3 - "$HEAL" "$STORY" <<'PY' 2>/dev/null
import json, sys
seen = []
try:
    for line in open(sys.argv[1], encoding='utf-8'):
        try: e = json.loads(line)
        except ValueError: continue
        if str(e.get('storyId', e.get('story', ''))) in ('', sys.argv[2]):
            t = str(e.get('target', '') or '')
            if t and t not in seen: seen.append(t)
except OSError: pass
print(' '.join(seen))
PY
)"
echo "  the analyst chose: ${TARGETS:-nothing}"
case " $TARGETS " in
  *" escalate "*)
    if grep -aqE "\[Escalation\] $STORY escalated a defect in .* \(owned by " "$PLAIN" \
       && grep -aqE "\[Escalation\] .* (works in its own worktree|runs on its top rung|runs on its own ladder)" "$PLAIN"; then
      pass "the escalation reached the owning story and ran"
    else
      fail "the analyst escalated and the owner never ran" "see [Escalation] lines in $RUN"
    fi
    if grep -aq "no further scoped fix is possible" "$PLAIN"; then
      fail "an escalation was refused on a spent ladder" "the diagnosis of the defect was thrown away (see 2026-09-24)"
    else
      pass "no escalation was refused on a spent ladder"
    fi ;;
esac
if python3 - "$HEAL" "$STORY" <<'PY' 2>/dev/null
import json, sys
for line in open(sys.argv[1], encoding='utf-8'):
    try: e = json.loads(line)
    except ValueError: continue
    if str(e.get('storyId', '')) == sys.argv[2] and (e.get('provisioning') or {}):
        sys.exit(0)
sys.exit(1)
PY
then
  mapfile -t efforts < <(grep -ao 'Effort\[final\] -> maxIter=[0-9]* maxOutTok=[0-9]*' "$PLAIN")
  if [ "${#efforts[@]}" -ge 2 ] && [ "${efforts[0]}" != "${efforts[1]}" ]; then
    pass "the analyst asked for provisioning and attempt 2 ran under different provisioning"
  else
    fail "the analyst asked for provisioning and attempt 2 did not get it" "${efforts[*]:-no Effort lines}"
  fi
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
