#!/bin/bash
# Acknowledge (or update status of) a message in the central agent-messages JSONL bus
# EPAM CLI orchestration message acknowledgement
#
# Usage:
#   ack-message.sh <MESSAGE_ID> [--status acknowledged|read]
#
# Arguments:
#   MESSAGE_ID      The id or message_id field of the message to update
#
# Options:
#   --status VALUE  New status value (default: acknowledged)
#
# The JSONL file is rewritten atomically under flock.
# A .lock file is used to prevent concurrent modifications.
#
# Exit codes:
#   0 - Message found and updated successfully
#   1 - Message not found, bad arguments, or lock failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
MESSAGES_JSONL="${MESSAGES_JSONL:-$AUTOMATION_DIR/logs/agent-messages.jsonl}"
LOCK_FILE="${MESSAGES_JSONL}.lock"

if [ $# -lt 1 ]; then
    echo "ERROR: Missing MESSAGE_ID" >&2
    echo "Usage: $0 <MESSAGE_ID> [--status acknowledged|read]" >&2
    exit 1
fi

MESSAGE_ID="$1"
NEW_STATUS="acknowledged"
shift

while [[ $# -gt 0 ]]; do
    case $1 in
        --status) NEW_STATUS="${2:-acknowledged}"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ ! -f "$MESSAGES_JSONL" ]; then
    echo "ERROR: No messages file at $MESSAGES_JSONL" >&2
    exit 1
fi

TMP_FILE="${MESSAGES_JSONL}.tmp.$$"

(
    flock -w 10 200 || { echo "ERROR: Could not acquire lock on $LOCK_FILE" >&2; exit 1; }

    FOUND=false
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # Match on either 'id' or 'message_id' field
        line_id=$(echo "$line" | jq -r '.message_id // .id // empty' 2>/dev/null || true)
        if [ "$line_id" = "$MESSAGE_ID" ]; then
            echo "$line" | jq --arg s "$NEW_STATUS" '.status = $s' >> "$TMP_FILE"
            FOUND=true
        else
            echo "$line" >> "$TMP_FILE"
        fi
    done < "$MESSAGES_JSONL"

    if [ "$FOUND" = false ]; then
        rm -f "$TMP_FILE"
        echo "ERROR: Message '$MESSAGE_ID' not found in $MESSAGES_JSONL" >&2
        exit 1
    fi

    mv "$TMP_FILE" "$MESSAGES_JSONL"
    echo "OK: message '$MESSAGE_ID' status -> '$NEW_STATUS'"

) 200>"$LOCK_FILE"

exit 0
