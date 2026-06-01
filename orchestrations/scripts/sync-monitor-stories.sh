#!/usr/bin/env bash
# sync-monitor-stories.sh - Sync story data from prd.json and phase-cost.jsonl to monitor
# EPAM CLI orchestration monitor story sync
#
# Reads completed stories from prd.json and timing data from phase-cost.jsonl,
# then updates monitor with story_start and story_complete events.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"&& pwd)"
PRD_FILE="${PRD_FILE:-$SCRIPT_DIR/../prd.json}"
COST_LOG="${COST_LOG:-$SCRIPT_DIR/../logs/phase-cost.jsonl}"
MONITOR_FILE="${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}"

# Check if cost log exists
if [ ! -f "$COST_LOG" ]; then
  echo "No cost log found at $COST_LOG - skipping story sync"
  exit 0
fi

# Read all cost entries
while IFS= read -r line; do
  [ -z "$line" ] && continue

  STORY_ID=$(echo "$line" | jq -r '.story_id')
  STORY_TITLE=$(echo "$line" | jq -r '.story_title')
  AGENT_ROLE=$(echo "$line" | jq -r '.agent_name')
  STARTED_AT=$(echo "$line" | jq -r '.started_at')
  ENDED_AT=$(echo "$line" | jq -r '.ended_at')
  RESOLVED_MODEL=$(echo "$line" | jq -r '.resolvedModel // ""')

  # Determine lane from prd.json
  LANE=$(jq -r --arg id "$STORY_ID" '.stories[] | select(.id == $id) | .agentGroup // "main"' "$PRD_FILE")

  # Determine provider from prd.json or infer from model
  PROVIDER=$(jq -r --arg id "$STORY_ID" '.stories[] | select(.id == $id) | .aiProvider // ""' "$PRD_FILE")
  if [ -z "$PROVIDER" ] || [ "$PROVIDER" = "null" ]; then
    # Infer provider from model name
    case "$RESOLVED_MODEL" in
      *claude*|*sonnet*|*opus*|*haiku*) PROVIDER="claude" ;;
      *gpt*|*openai*) PROVIDER="openai" ;;
      *o1*|*o3*) PROVIDER="codex" ;;
      *) PROVIDER="claude" ;;
    esac
  fi

  # Create story entry with full metadata (lane, role, title, provider, model)
  "$SCRIPT_DIR/update-monitor.sh" story_start "$STORY_ID" "$LANE" "$AGENT_ROLE" "$STORY_TITLE" "$PROVIDER" "$RESOLVED_MODEL" 2>/dev/null || true

  # Update story status to complete
  "$SCRIPT_DIR/update-monitor.sh" story_complete "$STORY_ID" "$LANE" "$STORY_TITLE" 2>/dev/null || true

done < "$COST_LOG"

echo "Synced $(wc -l < "$COST_LOG") stories to monitor"
exit 0
