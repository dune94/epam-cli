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
  export STARTED_AT=$(echo "$line" | jq -r '.started_at')
  export ENDED_AT=$(echo "$line" | jq -r '.ended_at')
  RESOLVED_MODEL=$(echo "$line" | jq -r '.resolvedModel // ""')

  # phase-cost.jsonl also carries phase-level pipeline records (agent_type
  # spec-pass/assessment/qa-gate:*, story_id set to the phase name itself,
  # e.g. "scaffold"/"core" — see append_pipeline_cost_record in
  # run-agent-orchestration.sh) alongside real per-story records (see
  # append_cost_record in claude.sh). Those phase-level records were never
  # stories and have no PRD entry — treating them as one produced fake
  # "story_start"/"story_complete" events with story_id="scaffold" (found
  # live 2026-07-13). Skip any story_id that isn't a real PRD story.
  if ! jq -e --arg id "$STORY_ID" '.stories[] | select(.id == $id)' "$PRD_FILE" >/dev/null 2>&1; then
    continue
  fi

  # story_title/agent_name were never fields on phase-cost.jsonl records (the
  # real schema has no such keys on either record type) — jq -r on a missing
  # key returns the JSON null token stringified as the literal text "null",
  # which is exactly what showed up as agent="null"/"Starting null" in the
  # dashboard (found live 2026-07-13). The real source of truth for a
  # story's title/role is prd.json, same as claude.sh's own
  # update_monitor_status looks it up — not the cost-log line itself.
  STORY_TITLE=$(jq -r --arg id "$STORY_ID" '.stories[] | select(.id == $id) | .title // $id' "$PRD_FILE")
  AGENT_ROLE=$(jq -r --arg id "$STORY_ID" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE")

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
