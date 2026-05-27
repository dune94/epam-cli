#!/usr/bin/env bash
# validate-dashboards.sh — post-run dashboard data validation
#
# Usage:
#   validate-dashboards.sh --logs <logs-dir> --dashboards <dashboards-dir> [--prd <prd-file>] [--port <port>]
#
# Checks every known failure mode:
#   1. Required log files exist and are non-empty
#   2. All JSON/JSONL files parse without error
#   3. agent-status.json: stories are complete, storiesCompleted > 0
#   4. agent-messages.jsonl: has at least one message
#   5. dashboards/prd.json matches source PRD (stories completed)
#   6. phase-cost.jsonl has entries
#   7. HTML dashboards return HTTP 200 (if server is running)
#   8. HTML nav links resolve to files that exist

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PASS=0; FAIL=0; WARN=0
FAILURES=()

pass()  { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail()  { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; WARN=$((WARN+1)); }
header(){ echo -e "\n${CYAN}${BOLD}── $1 ──────────────────────────────────────────${NC}"; }

# ── Defaults ─────────────────────────────────────────────────────────────────
LOGS_DIR=""
DASHBOARDS_DIR=""
PRD_FILE=""
PORT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --logs)        LOGS_DIR="$2";       shift 2 ;;
        --dashboards)  DASHBOARDS_DIR="$2"; shift 2 ;;
        --prd)         PRD_FILE="$2";       shift 2 ;;
        --port)        PORT="$2";           shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ -z "$LOGS_DIR" ] || [ -z "$DASHBOARDS_DIR" ]; then
    echo "Usage: $0 --logs <logs-dir> --dashboards <dashboards-dir> [--prd <prd-file>] [--port <port>]"
    exit 1
fi

LOGS_DIR="$(realpath "$LOGS_DIR")"
DASHBOARDS_DIR="$(realpath "$DASHBOARDS_DIR")"

echo -e "${BOLD}Dashboard Validation${NC}"
echo -e "  Logs:       $LOGS_DIR"
echo -e "  Dashboards: $DASHBOARDS_DIR"
[ -n "$PRD_FILE" ] && echo -e "  PRD source: $PRD_FILE"
[ -n "$PORT" ]     && echo -e "  HTTP port:  $PORT"

# ─────────────────────────────────────────────────────────────────────────────
header "1. Required log files"
# ─────────────────────────────────────────────────────────────────────────────
REQUIRED_LOGS=(
    "agent-status.json"
    "agent-messages.jsonl"
    "agent-activity.jsonl"
    "phase-cost.jsonl"
    "phase-gates.jsonl"
    "testing-gates.jsonl"
    "progress.txt"
)

for f in "${REQUIRED_LOGS[@]}"; do
    path="$LOGS_DIR/$f"
    if [ ! -f "$path" ]; then
        fail "Missing: $f"
    elif [ ! -s "$path" ] && [[ "$f" != *".jsonl" ]]; then
        fail "Empty: $f"
    else
        pass "Exists: $f"
    fi
done

# ─────────────────────────────────────────────────────────────────────────────
header "2. JSON validity"
# ─────────────────────────────────────────────────────────────────────────────
check_json() {
    local file="$1"
    if [ ! -f "$file" ]; then return; fi
    if jq empty "$file" 2>/dev/null; then
        pass "Valid JSON: $(basename "$file")"
    else
        fail "Invalid JSON: $(basename "$file")"
    fi
}

check_jsonl() {
    local file="$1"
    if [ ! -f "$file" ] || [ ! -s "$file" ]; then return; fi
    local bad=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        if ! echo "$line" | jq empty 2>/dev/null; then
            bad=$((bad+1))
        fi
    done < "$file"
    if [ $bad -eq 0 ]; then
        pass "Valid JSONL: $(basename "$file")"
    else
        fail "Invalid JSONL ($bad bad lines): $(basename "$file")"
    fi
}

check_json  "$LOGS_DIR/agent-status.json"
check_jsonl "$LOGS_DIR/agent-messages.jsonl"
check_jsonl "$LOGS_DIR/agent-activity.jsonl"
check_jsonl "$LOGS_DIR/phase-cost.jsonl"
check_jsonl "$LOGS_DIR/phase-gates.jsonl"
check_jsonl "$LOGS_DIR/testing-gates.jsonl"
[ -f "$DASHBOARDS_DIR/prd.json" ] && check_json "$DASHBOARDS_DIR/prd.json"

# ─────────────────────────────────────────────────────────────────────────────
header "3. agent-status.json data"
# ─────────────────────────────────────────────────────────────────────────────
STATUS_FILE="$LOGS_DIR/agent-status.json"
if [ -f "$STATUS_FILE" ] && jq empty "$STATUS_FILE" 2>/dev/null; then
    # Check all stories are complete (not pending)
    pending=$(jq '[.stories // {} | to_entries[] | select(.value.status == "pending")] | length' "$STATUS_FILE")
    complete=$(jq '[.stories // {} | to_entries[] | select(.value.status == "complete" or .value.status == "completed")] | length' "$STATUS_FILE")
    total=$(jq '[.stories // {} | keys[]] | length' "$STATUS_FILE")

    if [ "$total" -eq 0 ]; then
        fail "agent-status.json: no stories recorded"
    elif [ "$pending" -gt 0 ]; then
        fail "agent-status.json: $pending/$total stories still pending (expected all complete)"
    else
        pass "agent-status.json: $complete/$total stories complete"
    fi

    # Check storiesCompleted counter
    main_completed=$(jq '.lanes.main.storiesCompleted // 0' "$STATUS_FILE")
    if [ "$main_completed" -gt 0 ]; then
        pass "agent-status.json: main lane storiesCompleted=$main_completed"
    else
        fail "agent-status.json: main lane storiesCompleted=0 (stories ran but counter not updated)"
    fi

    # Check completedAt is set
    completed_at=$(jq -r '.completedAt // empty' "$STATUS_FILE")
    if [ -n "$completed_at" ]; then
        pass "agent-status.json: completedAt=$completed_at"
    else
        fail "agent-status.json: completedAt not set (finalize may not have run)"
    fi
else
    fail "agent-status.json: missing or invalid"
fi

# ─────────────────────────────────────────────────────────────────────────────
header "4. agent-messages.jsonl data"
# ─────────────────────────────────────────────────────────────────────────────
MSG_FILE="$LOGS_DIR/agent-messages.jsonl"
if [ -f "$MSG_FILE" ]; then
    msg_count=$(grep -c '"message_type"' "$MSG_FILE" 2>/dev/null || echo 0)
    if [ "$msg_count" -gt 0 ]; then
        pass "agent-messages.jsonl: $msg_count messages"
        # Show senders
        jq -r '.from_agent + " -> " + .to_agent + " | " + .subject' "$MSG_FILE" 2>/dev/null | \
            while IFS= read -r line; do echo -e "    ${CYAN}↳${NC} $line"; done
    else
        fail "agent-messages.jsonl: empty (post_completion_message not firing)"
    fi
else
    fail "agent-messages.jsonl: missing"
fi

# ─────────────────────────────────────────────────────────────────────────────
header "5. dashboards/prd.json vs source PRD"
# ─────────────────────────────────────────────────────────────────────────────
DASH_PRD="$DASHBOARDS_DIR/prd.json"
if [ ! -f "$DASH_PRD" ]; then
    fail "dashboards/prd.json: missing (sync from source PRD not running)"
elif [ -n "$PRD_FILE" ] && [ -f "$PRD_FILE" ]; then
    # Check stories match and are completed
    dash_pending=$(jq '[.stories[]? | select(.completed == false or .status == "pending")] | length' "$DASH_PRD")
    src_completed=$(jq '[.stories[]? | select(.completed == true)] | length' "$PRD_FILE")
    dash_completed=$(jq '[.stories[]? | select(.completed == true)] | length' "$DASH_PRD")

    if [ "$dash_pending" -gt 0 ]; then
        fail "dashboards/prd.json: $dash_pending stories still pending (sync broken — source updated but dashboard copy was not)"
    else
        pass "dashboards/prd.json: all stories completed"
    fi

    if [ "$src_completed" -eq "$dash_completed" ]; then
        pass "dashboards/prd.json: in sync with source ($dash_completed completed)"
    else
        fail "dashboards/prd.json: out of sync — source has $src_completed completed, dashboard has $dash_completed"
    fi
else
    # No source PRD to compare — just check dashboard copy has completed stories
    completed=$(jq '[.stories[]? | select(.completed == true)] | length' "$DASH_PRD" 2>/dev/null || echo 0)
    if [ "$completed" -gt 0 ]; then
        pass "dashboards/prd.json: $completed stories completed"
    else
        fail "dashboards/prd.json: 0 completed stories"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
header "6. phase-cost.jsonl data"
# ─────────────────────────────────────────────────────────────────────────────
COST_FILE="$LOGS_DIR/phase-cost.jsonl"
if [ -f "$COST_FILE" ] && [ -s "$COST_FILE" ]; then
    cost_count=$(grep -c '"story_id"' "$COST_FILE" 2>/dev/null || echo 0)
    pass "phase-cost.jsonl: $cost_count cost records"
else
    warn "phase-cost.jsonl: empty (cost tracking not firing — check append_cost_record)"
fi

# ─────────────────────────────────────────────────────────────────────────────
header "7. Dashboard HTTP (port $PORT)"
# ─────────────────────────────────────────────────────────────────────────────
DASHBOARDS=(
    "monitor.html"
    "prd-viewer.html"
    "agent-messages.html"
    "agent-profiles.html"
    "agents-orchestration.html"
    "orchestration-plan.html"
    "phase-cost-monitor.html"
    "pipeline-stages.html"
    "quality-dashboard.html"
    "quality-assurance.html"
    "cpa-details.html"
    "agent-activity.html"
    "specification.html"
)

if [ -z "$PORT" ]; then
    warn "HTTP checks skipped (no --port supplied)"
else
    for dash in "${DASHBOARDS[@]}"; do
        url="http://localhost:${PORT}/${dash}"
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            pass "HTTP 200: $dash"
        elif [ "$code" = "000" ]; then
            warn "Unreachable (server down?): $dash"
        else
            fail "HTTP $code: $dash"
        fi
    done
fi

# ─────────────────────────────────────────────────────────────────────────────
header "8. HTML nav link integrity"
# ─────────────────────────────────────────────────────────────────────────────
if command -v python3 &>/dev/null && [ -d "$DASHBOARDS_DIR" ]; then
    broken=0
    while IFS= read -r html; do
        # Extract href="*.html" links
        links=$(grep -oP 'href="[^"]*\.html[^"]*"' "$html" 2>/dev/null | sed 's/href="//;s/".*//' | grep -v '^http' || true)
        while IFS= read -r link; do
            [ -z "$link" ] && continue
            # Strip query/hash
            target="${link%%\?*}"; target="${target%%#*}"
            target_path="$DASHBOARDS_DIR/$target"
            if [ ! -f "$target_path" ]; then
                fail "Broken link in $(basename "$html"): $link"
                broken=$((broken+1))
            fi
        done <<< "$links"
    done < <(find "$DASHBOARDS_DIR" -maxdepth 1 -name "*.html")

    if [ $broken -eq 0 ]; then
        pass "All HTML nav links resolve"
    fi
else
    warn "HTML link check skipped (no HTML files or python3 not found)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}────────────────────────────────────────────────${NC}"
echo -e "  ${GREEN}✓ Passed:  $PASS${NC}   ${RED}✗ Failed: $FAIL${NC}   ${YELLOW}⚠ Warned: $WARN${NC}"

if [ ${#FAILURES[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}Failures:${NC}"
    for f in "${FAILURES[@]}"; do
        echo -e "  ${RED}•${NC} $f"
    done
fi

echo ""
if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All checks passed.${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL check(s) failed.${NC}"
    exit 1
fi
