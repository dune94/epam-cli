#!/usr/bin/env bash
# update-monitor.sh - Update monitor status file with events and state changes
# EPAM CLI orchestration monitor updater
#
# Usage:
#   update-monitor.sh <event_type> [args...]
#
# Event types:
#   init <phase_id>                           - Initialize monitor file
#   story_start <story_id> <lane> <role>      - Mark story as started
#   story_complete <story_id> <lane>          - Mark story as completed
#   story_fail <story_id> <lane> <error>      - Mark story as failed
#   event <type> <message> [story] [lane] [role] - Add generic event
#   finalize                                   - Mark orchestration complete

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_FILE="${MONITOR_FILE:-$SCRIPT_DIR/../logs/agent-status.json}"
LOCK_FILE="$MONITOR_FILE.lock"

# Acquire lock
exec 200>"$LOCK_FILE"
flock -w 10 200 || { echo "Failed to acquire lock on $LOCK_FILE" >&2; exit 1; }

EVENT_TYPE="${1:-}"
shift || true

timestamp() {
  date -Iseconds
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
    ;;

  story_start)
    STORY_ID="$1"
    LANE="$2"
    ROLE="$3"
    TITLE="${4:-}"

    MONITOR_DATA=$(echo "$MONITOR_DATA" | jq \
      --arg story "$STORY_ID" \
      --arg lane "$LANE" \
      --arg role "$ROLE" \
      --arg title "$TITLE" \
      --arg ts "$(timestamp)" \
      '
      .lanes[$lane].status = "running" |
      .lanes[$lane].currentStory = $story |
      .stories[$story] = {
        "status": "start",
        "lane": $lane,
        "role": $role,
        "title": $title,
        "updatedAt": $ts
      } |
      .events += [{
        "type": "story_start",
        "story": $story,
        "lane": $lane,
        "role": $role,
        "message": "Starting \($title)",
        "timestamp": $ts
      }]
      ')
    echo "$MONITOR_DATA" > "$MONITOR_FILE"
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
