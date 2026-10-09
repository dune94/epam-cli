#!/usr/bin/env bash
# THE LADDER'S MODELS ANSWER — every (model, effort) a provider set's ladder can reach, through the real handler.
#
#   run.sh <work-dir> [set=claude] [calls=3]
#
# Operator, 2026-10-09: "Confirm at least 3 times — any settings changes to ensure llm calls will not fail". The pairs
# are DERIVED from the set's own declaration (config/llm-defaults.<set>.json: each tier's startModel walked along its
# modelLadder, each rung's reasoningEffort), plus each model at the runner's default effort (how seams that are not
# in a story attempt call it) and the set's finalFallback. Each pair is called <calls> times through
# scripts/llm-handler.sh with a one-line prompt. A pair passes only when every call exits 0, answers, and the call's
# own record names the model asked for — a silent fallback to another model is a failure, not a pass.
#
# On the claude set the subscription's OAuth session pays; any ANTHROPIC_API_KEY is unset so it cannot outrank it.
# Nothing is written outside <work-dir>. Prints RESULT lines; the last is the verdict. Exit 0 always.
set -uo pipefail
W="${1:?work dir}"; SET="${2:-claude}"; CALLS="${3:-3}"
rm -rf "$W"; mkdir -p "$W/logs"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
ORCH="$REPO_ROOT/orchestrations"; NODE="${NODE_BIN:-$(command -v node)}"
CFG="$ORCH/config/llm-defaults.$SET.json"
[ -f "$CFG" ] || { echo "RESULT setup=no settings for set '$SET' at $CFG"; exit 0; }
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC

# The pairs, from the declaration.
"$NODE" - "$CFG" > "$W/pairs.txt" <<'JS'
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const tiers = d.ladders || d.tiers || Object.fromEntries(Object.entries(d).filter(([, v]) => v && v.startModel));
const pairs = new Set();
for (const t of Object.values(tiers)) {
  if (!t || !t.startModel) continue;
  let m = t.startModel; const hops = t.modelLadder || []; const rungs = t.rungs || [{}];
  rungs.forEach((r, i) => {
    if (i > 0) { const h = hops.find((x) => x.from === m); if (h) m = h.to; }
    pairs.add(`${m} ${r.reasoningEffort || '-'}`);
    pairs.add(`${m} -`);
  });
}
if (d.finalFallback && d.finalFallback.model) pairs.add(`${d.finalFallback.model} -`);
console.log([...pairs].sort().join('\n'));
JS
echo "RESULT pairs=$(wc -l < "$W/pairs.txt") calls_each=$CALLS"

export EPAM_PROVIDER_SET="$SET" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_NAME="${LADDER_CHECK_SEAM:-prompt-claim-adjudicator}"
FAILED=0; i=0
while read -r MODEL EFFORT; do
  [ -n "$MODEL" ] || continue
  ok=0
  for n in $(seq 1 "$CALLS"); do
    i=$((i + 1)); R="$W/result-$i.json"; O="$W/out-$i.txt"
    EFF=(); [ "$EFFORT" != "-" ] && EFF=("EPAM_REASONING_EFFORT=$EFFORT")
    printf 'Reply with exactly the word READY and nothing else.' | \
      /usr/bin/env AI_PROVIDER="$SET" AI_MODEL="$MODEL" ORCH_JSON_RESULT="$R" EPAM_MAX_ITERATIONS=1 ${EFF[@]+"${EFF[@]}"} \
      bash "$ORCH/scripts/llm-handler.sh" --provider "$SET" --model "$MODEL" > "$O" 2> "$W/err-$i.txt"
    rc=$?
    used=$("$NODE" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const u=r.model||r.modelUsed||(r.modelUsage&&Object.keys(r.modelUsage)[0])||"";process.stdout.write(String(u))}catch{process.stdout.write("")}' "$R")
    ans=$(tr -d '\r' < "$O" | grep -c READY)
    if [ "$rc" -eq 0 ] && [ "$ans" -gt 0 ] && [ -n "$used" ] && { [ "${used#"$MODEL"}" != "$used" ] || [ "$used" = "$MODEL" ]; }; then
      ok=$((ok + 1)); verdict=ok
    else
      verdict="FAIL rc=$rc answered=$ans recorded_model=${used:-<none>} $(tail -c 200 "$W/err-$i.txt" | tr '\n' ' ')"
    fi
    echo "RESULT $MODEL effort=$EFFORT call $n: $verdict${used:+ (record: $used)}"
  done
  [ "$ok" -eq "$CALLS" ] || FAILED=$((FAILED + 1))
done < "$W/pairs.txt"
echo "RESULT pairs_failed=$FAILED"
echo "RESULT verdict=$([ "$FAILED" -eq 0 ] && echo "GREEN — every pair answered $CALLS/$CALLS on the model asked for" || echo RED)"
