#!/usr/bin/env bash
# Reports on the DeepEval diagnosis-groundedness check's real-world impact
# for a given project output directory: how often it actually ran (vs
# skipped), the grounded/ungrounded split, and -- the signal that actually
# matters -- whether an "ungrounded" verdict for a story predicts that same
# story needed MORE retries/escalations before converging (or failed
# outright), by joining against healing-events.jsonl on story_id.
#
# Usage: groundedness-impact-report.sh <output_dir>
#   e.g. groundedness-impact-report.sh /home/bradleyjerome/projects/skyscanner-app

set -euo pipefail

# This script lives in tools/, so the handlers it runs are one directory up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUTPUT_DIR="${1:?Usage: groundedness-impact-report.sh <output_dir>}"
GROUNDEDNESS_LOG="$OUTPUT_DIR/failure-diagnosis-groundedness.jsonl"
HEALING_LOG="$OUTPUT_DIR/healing-events.jsonl"

if [ ! -f "$GROUNDEDNESS_LOG" ]; then
    echo "No groundedness log found at $GROUNDEDNESS_LOG — nothing to report yet."
    echo "(The check only writes an entry when it actually produces a real, non-skipped score.)"
    exit 0
fi

# NOTE: claude.sh's writer currently emits pretty-printed (multi-line) JSON
# per entry, not one-line-per-object -- a real JSONL-format bug (found live,
# 2026-07-12) that breaks `wc -l`-based counting here and any line-based
# tailing tool. Use `jq -s length` (slurp mode, tolerates multi-line objects)
# so this report stays correct regardless of which format is on disk; the
# writer itself needs a `-c` fix in claude.sh (deferred while it was live).
TOTAL=$(jq -s 'length' "$GROUNDEDNESS_LOG" 2>/dev/null || echo 0)
echo "=== Diagnosis Groundedness — $TOTAL evaluation(s) recorded ==="
echo ""

echo "--- Verdict split ---"
jq -r '.verdict' "$GROUNDEDNESS_LOG" | sort | uniq -c

echo ""
echo "--- Score distribution ---"
jq -r '.score' "$GROUNDEDNESS_LOG" | python3 "$SCRIPT_DIR/lib/handlers/groundedness-impact.py"

echo ""
echo "--- Per-story detail ---"
jq -r '[.storyId, .verdict, (.score|tostring), .diagnosis] | @tsv' "$GROUNDEDNESS_LOG" | \
    while IFS=$'\t' read -r story verdict score diagnosis; do
        printf "  %-16s %-11s score=%-5s %s\n" "$story" "$verdict" "$score" "${diagnosis:0:80}"
    done

if [ -f "$HEALING_LOG" ]; then
    echo ""
    echo "--- Correlation with healing-events.jsonl (retry count per story) ---"
    # For each story that has a groundedness verdict, count how many healing
    # events (retries) that story generated in total -- a rough proxy for
    # "how much self-heal work this story needed before converging."
    jq -r '.storyId' "$GROUNDEDNESS_LOG" | sort -u | while read -r story; do
        [ -z "$story" ] && continue
        verdicts=$(jq -r --arg s "$story" 'select(.storyId==$s) | .verdict' "$GROUNDEDNESS_LOG" | tr '\n' ',' | sed 's/,$//')
        retry_count=$(jq -r --arg s "$story" 'select(.story_id==$s) | .retry' "$HEALING_LOG" 2>/dev/null | wc -l | tr -d ' ')
        max_retry=$(jq -r --arg s "$story" 'select(.story_id==$s) | .retry' "$HEALING_LOG" 2>/dev/null | sort -n | tail -1)
        printf "  %-16s verdicts=[%s] total_heal_events=%s max_retry_reached=%s\n" "$story" "$verdicts" "$retry_count" "${max_retry:-n/a}"
    done
else
    echo ""
    echo "(No healing-events.jsonl found at $HEALING_LOG — cannot correlate with retry counts yet.)"
fi
