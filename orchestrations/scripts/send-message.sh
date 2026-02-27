#!/bin/bash
# Sends a message from one agent to another
# EPAM CLI orchestration agent messaging
#
# Usage:
#   send-message.sh --from <FROM_AGENT> --to <TO_AGENT> --type <TYPE> --subject <SUBJECT> --text <TEXT> [OPTIONS]
#
# Required:
#   --from        Sending agent ID
#   --to          Receiving agent ID (or 'all' for broadcast)
#   --type        Message type (review_request, review_feedback, approval, rejection, info, etc.)
#   --subject     Message subject
#   --text        Message body text
#
# Optional:
#   --story       Story ID (if applicable)
#   --phase       Phase ID (if applicable)
#   --priority    Message priority (low, normal, high, urgent) - default: normal
#   --reply-to    Message ID this is replying to
#   --data        Additional JSON data (must be valid JSON string)
#
# Exit codes:
#   0 - Message sent successfully
#   1 - Invalid arguments or validation error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
MESSAGES_DIR="$AUTOMATION_DIR/logs/messages"

# Required parameters
FROM_AGENT=""
TO_AGENT=""
MESSAGE_TYPE=""
SUBJECT=""
TEXT=""

# Optional parameters
STORY_ID=""
PHASE_ID=""
PRIORITY="normal"
REPLY_TO=""
DATA="{}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --from)
            FROM_AGENT="$2"
            shift 2
            ;;
        --to)
            TO_AGENT="$2"
            shift 2
            ;;
        --type)
            MESSAGE_TYPE="$2"
            shift 2
            ;;
        --subject)
            SUBJECT="$2"
            shift 2
            ;;
        --text)
            TEXT="$2"
            shift 2
            ;;
        --story)
            STORY_ID="$2"
            shift 2
            ;;
        --phase)
            PHASE_ID="$2"
            shift 2
            ;;
        --priority)
            PRIORITY="$2"
            shift 2
            ;;
        --reply-to)
            REPLY_TO="$2"
            shift 2
            ;;
        --data)
            DATA="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$FROM_AGENT" ] || [ -z "$TO_AGENT" ] || [ -z "$MESSAGE_TYPE" ] || [ -z "$SUBJECT" ] || [ -z "$TEXT" ]; then
    echo "ERROR: Missing required parameters" >&2
    echo "Usage: $0 --from <FROM> --to <TO> --type <TYPE> --subject <SUBJECT> --text <TEXT>" >&2
    exit 1
fi

# Validate DATA is valid JSON
if ! echo "$DATA" | jq empty 2>/dev/null; then
    echo "ERROR: --data must be valid JSON" >&2
    exit 1
fi

# Create message directories
mkdir -p "$MESSAGES_DIR/inbox/$TO_AGENT"
mkdir -p "$MESSAGES_DIR/outbox"
mkdir -p "$MESSAGES_DIR/archive"

# Generate message ID
MESSAGE_ID="msg-$(date +%s%3N)"
TIMESTAMP=$(date -Iseconds)

# Build message body
BODY=$(jq -n \
    --arg text "$TEXT" \
    --arg story "$STORY_ID" \
    --arg phase "$PHASE_ID" \
    --argjson data "$DATA" \
    '{
        text: $text,
        story_id: (if $story != "" then $story else null end),
        phase_id: (if $phase != "" then $phase else null end),
        data: $data
    }')

# Build full message
MESSAGE=$(jq -n \
    --arg id "$MESSAGE_ID" \
    --arg ts "$TIMESTAMP" \
    --arg from "$FROM_AGENT" \
    --arg to "$TO_AGENT" \
    --arg type "$MESSAGE_TYPE" \
    --arg priority "$PRIORITY" \
    --arg subject "$SUBJECT" \
    --argjson body "$BODY" \
    --arg reply_to "$REPLY_TO" \
    --arg story "$STORY_ID" \
    --arg phase "$PHASE_ID" \
    '{
        message_id: $id,
        timestamp: $ts,
        from_agent: $from,
        to_agent: $to,
        type: $type,
        priority: $priority,
        subject: $subject,
        story_id: (if $story != "" then $story else null end),
        phase_id: (if $phase != "" then $phase else null end),
        body: $body,
        in_reply_to: (if $reply_to != "" then $reply_to else null end),
        requires_response: false,
        status: "sent"
    }')

# Write to recipient's inbox
INBOX_FILE="$MESSAGES_DIR/inbox/$TO_AGENT/${MESSAGE_ID}.json"
echo "$MESSAGE" > "$INBOX_FILE"

# Copy to outbox for sender's record
OUTBOX_FILE="$MESSAGES_DIR/outbox/${MESSAGE_ID}.json"
echo "$MESSAGE" > "$OUTBOX_FILE"

# Append to central agent-messages.jsonl bus (flat JSONL for hybrid mode / list-messages.sh)
CENTRAL_JSONL="$(dirname "$MESSAGES_DIR")/agent-messages.jsonl"
CENTRAL_LOCK="${CENTRAL_JSONL}.lock"
touch "$CENTRAL_JSONL"
(
    flock -w 10 200 || true
    echo "$MESSAGE" | jq -c '.' >> "$CENTRAL_JSONL"
) 200>"$CENTRAL_LOCK"

# Output message ID for reference
echo "$MESSAGE_ID"

exit 0
