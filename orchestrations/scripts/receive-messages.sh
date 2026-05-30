#!/bin/bash
# Receives messages for an agent
# EPAM CLI orchestration agent message receiver
#
# Usage:
#   receive-messages.sh <AGENT_ID> [OPTIONS]
#
# Arguments:
#   AGENT_ID      Agent ID to check messages for
#
# Options:
#   --unread      Only show unread messages (status != 'read')
#   --type TYPE   Filter by message type
#   --mark-read   Mark retrieved messages as read
#   --archive     Move read messages to archive
#
# Exit codes:
#   0 - Success (messages found or not)
#   1 - Invalid arguments

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
MESSAGES_DIR="${MESSAGES_DIR:-$AUTOMATION_DIR/logs/messages}"

AGENT_ID=""
UNREAD_ONLY=false
TYPE_FILTER=""
MARK_READ=false
ARCHIVE_READ=false

# Parse arguments
if [ $# -lt 1 ]; then
    echo "ERROR: Missing AGENT_ID" >&2
    echo "Usage: $0 <AGENT_ID> [OPTIONS]" >&2
    exit 1
fi

AGENT_ID=$1
shift

while [[ $# -gt 0 ]]; do
    case $1 in
        --unread)
            UNREAD_ONLY=true
            shift
            ;;
        --type)
            TYPE_FILTER="$2"
            shift 2
            ;;
        --mark-read)
            MARK_READ=true
            shift
            ;;
        --archive)
            ARCHIVE_READ=true
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Create inbox if doesn't exist
INBOX_DIR="$MESSAGES_DIR/inbox/$AGENT_ID"
mkdir -p "$INBOX_DIR"
mkdir -p "$MESSAGES_DIR/archive"

# Find message files
MESSAGE_FILES=$(find "$INBOX_DIR" -name "msg-*.json" -type f 2>/dev/null | sort)

if [ -z "$MESSAGE_FILES" ]; then
    echo "[]"  # No messages
    exit 0
fi

# Process messages
MESSAGES="["
FIRST=true

while IFS= read -r file; do
    [ -z "$file" ] && continue

    MESSAGE=$(cat "$file")

    # Apply filters
    if [ "$UNREAD_ONLY" = true ]; then
        STATUS=$(echo "$MESSAGE" | jq -r '.status')
        if [ "$STATUS" = "read" ]; then
            continue
        fi
    fi

    if [ -n "$TYPE_FILTER" ]; then
        MSG_TYPE=$(echo "$MESSAGE" | jq -r '.type')
        if [ "$MSG_TYPE" != "$TYPE_FILTER" ]; then
            continue
        fi
    fi

    # Add to output
    if [ "$FIRST" = true ]; then
        FIRST=false
    else
        MESSAGES="${MESSAGES},"
    fi
    MESSAGES="${MESSAGES}${MESSAGE}"

    # Mark as read if requested
    if [ "$MARK_READ" = true ]; then
        UPDATED=$(echo "$MESSAGE" | jq '.status = "read"')
        echo "$UPDATED" > "$file"
        MESSAGE="$UPDATED"
    fi

    # Archive if requested and read
    if [ "$ARCHIVE_READ" = true ]; then
        STATUS=$(echo "$MESSAGE" | jq -r '.status')
        if [ "$STATUS" = "read" ]; then
            BASENAME=$(basename "$file")
            mv "$file" "$MESSAGES_DIR/archive/$BASENAME"
        fi
    fi

done <<< "$MESSAGE_FILES"

MESSAGES="${MESSAGES}]"

# Output messages as JSON array
echo "$MESSAGES" | jq '.'

exit 0
