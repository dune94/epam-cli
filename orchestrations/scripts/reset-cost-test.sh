#!/usr/bin/env bash
# Reset cost test phases for re-running
# EPAM CLI orchestration cost test reset
# Usage: ./orchestrations/scripts/reset-cost-test.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="$AUTOMATION_DIR/prd.json"
LOG_DIR="$AUTOMATION_DIR/logs"

echo "=== Resetting Cost Test Phases ==="

# Helper: safely apply jq transformation to prd.json
# Validates output is valid JSON and has same story count before replacing
safe_jq_update() {
    local description="$1"
    shift
    local tmp_file="${PRD_FILE}.reset.$$"
    local orig_count=$(jq '.stories | length' "$PRD_FILE")

    if jq "$@" "$PRD_FILE" > "$tmp_file" 2>/dev/null; then
        local new_count=$(jq '.stories | length' "$tmp_file" 2>/dev/null || echo 0)
        if [ "$new_count" -eq "$orig_count" ] && [ "$new_count" -gt 0 ]; then
            mv "$tmp_file" "$PRD_FILE"
        else
            echo "ERROR: $description produced invalid output (stories: $orig_count -> $new_count), skipping"
            rm -f "$tmp_file"
            return 1
        fi
    else
        echo "ERROR: jq failed for $description, skipping"
        rm -f "$tmp_file"
        return 1
    fi
}

# 1. Restore agentRole from originalAgentRole for all COST-TEST stories
echo "Restoring original agent roles..."
safe_jq_update "restore roles" \
    '(.stories[] | select(.id | startswith("COST-TEST-"))) |= (.agentRole = .originalAgentRole)'

# 2. Reset all COST-TEST stories to pending
echo "Resetting story status..."
safe_jq_update "reset status" \
    '(.stories[] | select(.id | startswith("COST-TEST-"))) |=
    (.completed = false | .status = "pending" | del(.completedAt) | del(.lastAttempt))'

# 3. Archive all activity log files so dashboards start completely clean
# (phase-gates, code-reviews, phase-cost, agent-messages may contain data from
#  many prior runs; archiving the whole file gives a clean dashboard for inspection)
echo "Archiving activity logs for clean dashboard..."
ACTIVITY_ARCHIVE="$LOG_DIR/backups/activity-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ACTIVITY_ARCHIVE"
for f in phase-cost.jsonl phase-gates.jsonl code-reviews.jsonl agent-messages.jsonl; do
    if [ -f "$LOG_DIR/$f" ] && [ -s "$LOG_DIR/$f" ]; then
        mv "$LOG_DIR/$f" "$ACTIVITY_ARCHIVE/$f"
        echo "  Archived: $f"
    fi
done

# 4. Remove assessment records for cost_test phases
echo "Clearing assessment records..."
if [ -f "$LOG_DIR/phase-skill-assessments.jsonl" ]; then
    grep -v '"phase_cost_test_' "$LOG_DIR/phase-skill-assessments.jsonl" > "${LOG_DIR}/phase-skill-assessments.jsonl.tmp.$$" 2>/dev/null || true
    mv "${LOG_DIR}/phase-skill-assessments.jsonl.tmp.$$" "$LOG_DIR/phase-skill-assessments.jsonl"
fi

# 5. Remove improvement files for cost_test phases
echo "Clearing improvement files..."
rm -f "$LOG_DIR/phase-improvements/phase_cost_test_1.md"
rm -f "$LOG_DIR/phase-improvements/phase_cost_test_2.md"

# 6. Remove assessment logs
rm -f "$LOG_DIR/assessment-phase_cost_test_1.log"
rm -f "$LOG_DIR/assessment-phase_cost_test_2.log"

# 7. Remove test output files
rm -f "$AUTOMATION_DIR/test/cost-test-p1-001.txt"
rm -f "$AUTOMATION_DIR/test/cost-test-p1-002.txt"
rm -f "$AUTOMATION_DIR/test/cost-test-p2-001.txt"
rm -f "$AUTOMATION_DIR/test/cost-test-review.txt"

# 8. Remove pre-assessment backup
rm -f "${PRD_FILE}.pre-assessment"

# 8.5. Restore profiles.json from original backup (if exists)
PROFILES_FILE="$AUTOMATION_DIR/agents/profiles.json"
PROFILES_BACKUP="${PROFILES_FILE}.original"
if [ -f "$PROFILES_BACKUP" ]; then
    echo "Restoring profiles.json from original backup..."
    cp "$PROFILES_BACKUP" "$PROFILES_FILE"
    rm -f "$PROFILES_BACKUP"
fi

# 8.6. Clear profile audit records for cost_test phases
echo "Clearing profile audit records..."
if [ -f "$LOG_DIR/profiles-audit.jsonl" ]; then
    grep -v '"phase_cost_test_' "$LOG_DIR/profiles-audit.jsonl" > "${LOG_DIR}/profiles-audit.jsonl.tmp.$$" 2>/dev/null || true
    mv "${LOG_DIR}/profiles-audit.jsonl.tmp.$$" "$LOG_DIR/profiles-audit.jsonl"
fi

# 8.7. Remove pre-assessment logs and reports
rm -f "$LOG_DIR/pre-assessment-phase_cost_test_1.log"
rm -f "$LOG_DIR/pre-assessment-phase_cost_test_2.log"
rm -f "$LOG_DIR/phase-improvements/pre-phase_cost_test_1.md"
rm -f "$LOG_DIR/phase-improvements/pre-phase_cost_test_2.md"

# 9. Remove Claude output result files (case-insensitive: files named COST-TEST-*)
echo "Clearing Claude output files..."
find "$LOG_DIR/claude_outputs/" -maxdepth 1 -iname "cost-test-*" -delete 2>/dev/null || true

# 9.1. Archive ALL outbox/inbox messages so agent-messages.html starts clean
echo "Archiving all messages..."
MSGS_DIR="$LOG_DIR/messages"
if [ -d "$MSGS_DIR" ]; then
    MSG_ARCHIVE="$MSGS_DIR/archive/reset-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$MSG_ARCHIVE"
    # Move entire outbox and inbox dirs into archive, then recreate empty structure
    [ -d "$MSGS_DIR/outbox" ] && mv "$MSGS_DIR/outbox" "$MSG_ARCHIVE/outbox" || true
    [ -d "$MSGS_DIR/inbox"  ] && mv "$MSGS_DIR/inbox"  "$MSG_ARCHIVE/inbox"  || true
    # Recreate empty inbox agent dirs
    mkdir -p "$MSGS_DIR/outbox"
    for agent in backend-engineer devops-engineer frontend-engineer review-agent \
                 db-architect pipeline-engineer docs-engineer unit-test-runner \
                 qa-engineer mock-data-generator agent-skill-assessment-agent \
                 grooming-coordinator readiness-checker dedup-detector \
                 doc-coordinator docstring-agent api-doc-generator guide-author \
                 architecture-doc-agent changelog-agent doc-reviewer \
                 doc-index-builder doc-search-agent doc-site-builder; do
        mkdir -p "$MSGS_DIR/inbox/$agent"
    done
fi

# 10. Clear monitor status
rm -f "$LOG_DIR/agent-status.json"

echo "=== Reset Complete ==="
echo "Ready to re-run:"
echo "  ./orchestrations/scripts/run-agent-orchestration.sh --phase phase_cost_test_1"
echo "  ./orchestrations/scripts/run-agent-orchestration.sh --phase phase_cost_test_2"
