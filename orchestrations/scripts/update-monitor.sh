#!/usr/bin/env bash
# update-monitor.sh - Update monitor status file with events and state changes
# EPAM CLI orchestration monitor updater
#
# Usage:
#   update-monitor.sh <event_type> [args...]
#
# Event types:
#   init <phase_id>                                                  - Initialize monitor file
#   story_start <story_id> <lane> <role> [title] [provider] [model] - Mark story as started
#   story_complete <story_id> <lane>                                 - Mark story as completed
#   story_fail <story_id> <lane> <error>                             - Mark story as failed
#   event <type> <message> [story] [lane] [role]                     - Add generic event
#   finalize                                                          - Mark orchestration complete

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_FILE="${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}"
ACTIVITY_FILE="${ACTIVITY_FILE:-$SCRIPT_DIR/../logs/agent-activity.jsonl}"
LOCK_FILE="$MONITOR_FILE.lock"

# Acquire lock
exec 200>"$LOCK_FILE"
flock -w 10 200 || { echo "Failed to acquire lock on $LOCK_FILE" >&2; exit 1; }

EVENT_TYPE="${1:-}"
shift || true

timestamp() {
  date -Iseconds
}

resolve_phase() {
  if [ -f "$MONITOR_FILE" ]; then
    jq -r '.phase // empty' "$MONITOR_FILE" 2>/dev/null || true
  fi
}

normalize_activity_type() {
  case "${1:-}" in
    story_start|story_complete|story_fail|tool_run|tool_result|finding|gate_decision|cost_snapshot|message_sent|message_received|spec_update|phase_start|phase_complete|error|info)
      echo "$1"
      ;;
    *)
      echo "info"
      ;;
  esac
}

append_activity_event() {
  local raw_type="${1:-info}"
  local story_id="${2:-}"
  local phase_id="${3:-}"
  local role="${4:-}"
  local lane="${5:-main}"
  local message="${6:-}"
  local effective_type
  effective_type="$(normalize_activity_type "$raw_type")"
  local ts
  ts="$(timestamp)"
  local event_id
  event_id="evt-$(date +%s%N)-$RANDOM"

  mkdir -p "$(dirname "$ACTIVITY_FILE")"
  jq -cn \
    --arg ts "$ts" \
    --arg agent "${role:-orchestrator}" \
    --arg type "$effective_type" \
    --arg story "$story_id" \
    --arg phase "$phase_id" \
    --arg lane "$lane" \
    --arg message "$message" \
    --arg rawType "$raw_type" \
    --arg eventId "$event_id" \
    '{
      event_id: $eventId,
      timestamp: $ts,
      agent: $agent,
      story_id: (if $story == "" then null else $story end),
      phase: (if $phase == "" then null else $phase end),
      type: $type,
      detail: {
        lane: $lane,
        message: $message,
        source: "update-monitor.sh",
        rawType: $rawType
      }
    }' >> "$ACTIVITY_FILE" || true
}

# Load current monitor data
if [ -f "$MONITOR_FILE" ]; then
  MONITOR_DATA=$(cat "$MONITOR_FILE")
else
  MONITOR_DATA='{}'
fi

case "$EVENT_TYPE" in
  init)
    PHASE_ID="$1"
    cat > "$MONITOR_FILE" <<EOF
{
  "startedAt": "$(timestamp)",
  "phase": "$PHASE_ID",
  "lanes": {
    "main": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "primary": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "independent": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0}
  },
  "events": [],
  "stories": {}
}
EOF
    append_activity_event "phase_start" "" "$PHASE_ID" "orchestrator" "main" "Monitor initialized for phase $PHASE_ID"
    ;;

  story_start)
    STORY_ID="$1"
    LANE="$2"
    ROLE="$3"
    TITLE="${4:-}"
    PROVIDER="${5:-claude}"
    MODEL="${6:-}"

    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg story "$STORY_ID" \
      --arg lane "$LANE" \
      --arg role "$ROLE" \
      --arg title "$TITLE" \
      --arg provider "$PROVIDER" \
      --arg model "$MODEL" \
      --arg ts "$(timestamp)" \
      '
      .lanes[$lane].status = "running" |
      .lanes[$lane].currentStory = $story |
      .stories[$story] = {
        "status": "start",
        "lane": $lane,
        "role": $role,
        "title": $title,
        "provider": $provider,
        "model": $model,
        "updatedAt": $ts
      } |
      .events += [{
        "type": "story_start",
        "story": $story,
        "lane": $lane,
        "role": $role,
        "provider": $provider,
        "model": $model,
        "message": "Starting \($title)",
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
    PHASE_ID="$(resolve_phase)"
    append_activity_event "story_start" "$STORY_ID" "$PHASE_ID" "$ROLE" "$LANE" "Starting $TITLE"
    ;;

  story_complete)
    STORY_ID="$1"
    LANE="$2"
    TITLE="${3:-}"

    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg story "$STORY_ID" \
      --arg lane "$LANE" \
      --arg title "$TITLE" \
      --arg ts "$(timestamp)" \
      '
      .lanes[$lane].currentStory = null |
      .lanes[$lane].storiesCompleted += 1 |
      .stories[$story].status = "complete" |
      .stories[$story].updatedAt = $ts |
      .events += [{
        "type": "story_complete",
        "story": $story,
        "lane": $lane,
        "role": (.stories[$story].role // ""),
        "message": "Completed \($title)",
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
    PHASE_ID="$(resolve_phase)"
    ROLE="$(echo "$MONITOR_DATA" | jq -r --arg story "$STORY_ID" '.stories[$story].role // "orchestrator"')"
    append_activity_event "story_complete" "$STORY_ID" "$PHASE_ID" "$ROLE" "$LANE" "Completed $TITLE"
    ;;

  story_fail)
    STORY_ID="$1"
    LANE="$2"
    ERROR="${3:-Unknown error}"

    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg story "$STORY_ID" \
      --arg lane "$LANE" \
      --arg error "$ERROR" \
      --arg ts "$(timestamp)" \
      '
      .lanes[$lane].currentStory = null |
      .lanes[$lane].storiesFailed += 1 |
      .stories[$story].status = "fail" |
      .stories[$story].updatedAt = $ts |
      .events += [{
        "type": "story_fail",
        "story": $story,
        "lane": $lane,
        "role": (.stories[$story].role // ""),
        "message": $error,
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
    PHASE_ID="$(resolve_phase)"
    ROLE="$(echo "$MONITOR_DATA" | jq -r --arg story "$STORY_ID" '.stories[$story].role // "orchestrator"')"
    append_activity_event "story_fail" "$STORY_ID" "$PHASE_ID" "$ROLE" "$LANE" "$ERROR"
    ;;

  event)
    TYPE="$1"
    MESSAGE="$2"
    STORY="${3:-}"
    LANE="${4:-main}"
    ROLE="${5:-}"

    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg type "$TYPE" \
      --arg msg "$MESSAGE" \
      --arg story "$STORY" \
      --arg lane "$LANE" \
      --arg role "$ROLE" \
      --arg ts "$(timestamp)" \
      '
      .events += [{
        "type": $type,
        "story": $story,
        "lane": $lane,
        "role": $role,
        "message": $msg,
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
    PHASE_ID="$(resolve_phase)"
    append_activity_event "$TYPE" "$STORY" "$PHASE_ID" "$ROLE" "$LANE" "$MESSAGE"
    ;;

  finalize)
    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg ts "$(timestamp)" \
      '
      .completedAt = $ts |
      .lanes.main.status = "done" |
      .lanes.primary.status = "done" |
      .lanes.independent.status = "done" |
      .events += [{
        "type": "orchestration_complete",
        "story": "",
        "lane": "main",
        "role": "",
        "message": "All steps finished - \(.lanes.primary.storiesCompleted + .lanes.independent.storiesCompleted + .lanes.main.storiesCompleted) stories completed",
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
    PHASE_ID="$(resolve_phase)"
    append_activity_event "phase_complete" "" "$PHASE_ID" "orchestrator" "main" "Orchestration finalized"
    ;;

  *)
    echo "Unknown event type: $EVENT_TYPE" >&2
    echo "Usage: update-monitor.sh <event_type> [args...]" >&2
    exit 1
    ;;
esac

# Release lock
flock -u 200

exit 0
