#!/bin/bash
# List messages from the central agent-messages JSONL bus
# EPAM CLI orchestration message listing
#
# Usage:
#   list-messages.sh [OPTIONS]
#
# Options:
#   --phase PHASE_ID     Filter by phase_id
#   --story STORY_ID     Filter by story_id
#   --to AGENT_ID        Filter by to_agent
#   --from AGENT_ID      Filter by from_agent
#   --type TYPE          Filter by message_type (e.g. plan_required, gate_decision, status)
#   --status STATUS      Filter by message status (new|read|acknowledged)
#   --limit N            Return at most N most recent messages (default: 50)
#   --count              Print count only, no message content
#
# Output:
#   JSON array of matching messages printed to stdout.
#   Empty array [] when no messages match or file does not exist.
#
# Exit codes:
#   0 - Success
#   1 - Error (bad arguments)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
MESSAGES_JSONL="${MESSAGES_JSONL:-$AUTOMATION_DIR/logs/agent-messages.jsonl}"

PHASE_FILTER=""
STORY_FILTER=""
TO_FILTER=""
FROM_FILTER=""
TYPE_FILTER=""
STATUS_FILTER=""
LIMIT=50
COUNT_ONLY=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --phase)  PHASE_FILTER="${2:-}";  shift 2 ;;
        --story)  STORY_FILTER="${2:-}";  shift 2 ;;
        --to)     TO_FILTER="${2:-}";     shift 2 ;;
        --from)   FROM_FILTER="${2:-}";   shift 2 ;;
        --type)   TYPE_FILTER="${2:-}";   shift 2 ;;
        --status) STATUS_FILTER="${2:-}"; shift 2 ;;
        --limit)  LIMIT="${2:-50}";       shift 2 ;;
        --count)  COUNT_ONLY=true; shift ;;
        -h|--help)
            grep '^#' "$0" | grep -v '^#!/' | sed 's/^# //' | sed 's/^#//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ ! -f "$MESSAGES_JSONL" ]; then
    if [ "$COUNT_ONLY" = true ]; then echo 0; else echo "[]"; fi
    exit 0
fi

# Build jq select chain from active filters
JQ_FILTER="."
[ -n "$PHASE_FILTER"  ] && JQ_FILTER+=" | select(.phase_id == \"${PHASE_FILTER}\")"
[ -n "$STORY_FILTER"  ] && JQ_FILTER+=" | select(.story_id == \"${STORY_FILTER}\")"
[ -n "$TO_FILTER"     ] && JQ_FILTER+=" | select(.to_agent == \"${TO_FILTER}\")"
[ -n "$FROM_FILTER"   ] && JQ_FILTER+=" | select(.from_agent == \"${FROM_FILTER}\")"
[ -n "$TYPE_FILTER"   ] && JQ_FILTER+=" | select((.message_type // .type) == \"${TYPE_FILTER}\")"
[ -n "$STATUS_FILTER" ] && JQ_FILTER+=" | select(.status == \"${STATUS_FILTER}\")"

if [ "$COUNT_ONLY" = true ]; then
    jq -c "$JQ_FILTER" "$MESSAGES_JSONL" 2>/dev/null | wc -l
else
    jq -c "$JQ_FILTER" "$MESSAGES_JSONL" 2>/dev/null \
        | tail -n "$LIMIT" \
        | jq -s '.'
fi

exit 0
