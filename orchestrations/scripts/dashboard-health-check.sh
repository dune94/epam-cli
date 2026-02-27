#!/bin/bash
# Dashboard Health Check
# Verifies all orchestration dashboard pages and data endpoints are serving correctly.
#
# Usage:
#   ./dashboard-health-check.sh              # Check and report
#   ./dashboard-health-check.sh --fix        # Check, restart container if broken, re-check
#   ./dashboard-health-check.sh --watch      # Loop every 60s (Ctrl-C to stop)
#   ./dashboard-health-check.sh --watch 30   # Loop every 30s
#
# Exit codes:
#   0 - All endpoints healthy
#   1 - One or more endpoints failed (after --fix attempt if requested)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.epam-cli.yml"
DASHBOARD_BASE="http://localhost:8092"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

FIX_MODE=false
WATCH_MODE=false
WATCH_INTERVAL=60

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --fix)   FIX_MODE=true; shift ;;
        --watch) WATCH_MODE=true
                 if [[ "${2:-}" =~ ^[0-9]+$ ]]; then
                     WATCH_INTERVAL="$2"; shift 2
                 else
                     shift
                 fi
                 ;;
        -h|--help)
            grep '^#' "$0" | grep -v '^#!/' | sed 's/^# //' | sed 's/^#//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── Health check core ───────────────────────────────────────────────────────
PAGES=(
    "monitor.html"
    "prd-viewer.html"
    "agent-profiles.html"
    "phase-cost-monitor.html"
    "agent-messages.html"
    "agents-orchestration.html"
    "orchestration-plan.html"
)

DATA_FILES=(
    "prd.json"
    "profiles.json"
    "logs/agent-status.json"
)

# Data files that may not exist yet (created at runtime) — warn but don't fail
OPTIONAL_DATA=(
    "logs/phase-cost.jsonl"
    "logs/agent-messages.jsonl"
)

run_check() {
    local pass=0
    local fail=0
    local warn=0
    local ts
    ts=$(date '+%H:%M:%S')

    echo -e "${CYAN}[$ts] Dashboard Health Check${NC}"
    echo ""

    # Check if server is reachable (use monitor.html since / has no index)
    if ! curl -sf -o /dev/null --connect-timeout 3 "$DASHBOARD_BASE/monitor.html" 2>/dev/null; then
        echo -e "  ${RED}FAIL${NC} Server unreachable at $DASHBOARD_BASE"
        echo ""
        return 1
    fi

    echo -e "  ${CYAN}Pages:${NC}"
    for page in "${PAGES[@]}"; do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$DASHBOARD_BASE/$page" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            echo -e "    ${GREEN}OK${NC}   $page"
            ((pass++))
        else
            echo -e "    ${RED}FAIL${NC} $page (HTTP $code)"
            ((fail++))
        fi
    done

    echo ""
    echo -e "  ${CYAN}Data endpoints:${NC}"
    for f in "${DATA_FILES[@]}"; do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$DASHBOARD_BASE/$f" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            echo -e "    ${GREEN}OK${NC}   $f"
            ((pass++))
        else
            echo -e "    ${RED}FAIL${NC} $f (HTTP $code)"
            ((fail++))
        fi
    done

    for f in "${OPTIONAL_DATA[@]}"; do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$DASHBOARD_BASE/$f" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            echo -e "    ${GREEN}OK${NC}   $f"
            ((pass++))
        else
            echo -e "    ${YELLOW}WARN${NC} $f (HTTP $code — created at runtime)"
            ((warn++))
        fi
    done

    # Validate prd.json content
    local prd_title
    prd_title=$(curl -sf "$DASHBOARD_BASE/prd.json" 2>/dev/null | jq -r '.title // empty' 2>/dev/null || true)
    if [ -n "$prd_title" ]; then
        echo ""
        echo -e "  ${CYAN}Content validation:${NC}"
        echo -e "    ${GREEN}OK${NC}   prd.json parseable (\"$prd_title\")"
        local story_count
        story_count=$(curl -sf "$DASHBOARD_BASE/prd.json" 2>/dev/null | jq '.stories | length' 2>/dev/null || echo "?")
        echo -e "    ${GREEN}OK${NC}   $story_count stories loaded"
        ((pass+=2))
    else
        echo ""
        echo -e "  ${RED}FAIL${NC} prd.json not parseable or empty"
        ((fail++))
    fi

    # Docker container status
    echo ""
    echo -e "  ${CYAN}Container:${NC}"
    local container_status
    container_status=$(docker ps --filter "publish=8092" --format "{{.Status}}" 2>/dev/null || echo "not found")
    if echo "$container_status" | grep -q "Up"; then
        if echo "$container_status" | grep -q "unhealthy"; then
            echo -e "    ${YELLOW}WARN${NC} Container up but unhealthy: $container_status"
            ((warn++))
        else
            echo -e "    ${GREEN}OK${NC}   $container_status"
            ((pass++))
        fi
    else
        echo -e "    ${RED}FAIL${NC} Container status: $container_status"
        ((fail++))
    fi

    echo ""
    echo -e "  ${CYAN}Summary:${NC} ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}, ${YELLOW}$warn warnings${NC}"

    if [ "$fail" -gt 0 ]; then
        return 1
    fi
    return 0
}

# ── Fix: restart container ──────────────────────────────────────────────────
attempt_fix() {
    echo ""
    echo -e "${YELLOW}Attempting fix: restarting agent-monitor container...${NC}"
    if [ -f "$COMPOSE_FILE" ]; then
        docker compose -f "$COMPOSE_FILE" restart agent-monitor 2>&1 | grep -v "level=warning"
        echo "Waiting 3s for container startup..."
        sleep 3
    else
        echo -e "${RED}Cannot fix: $COMPOSE_FILE not found${NC}"
        return 1
    fi
}

# ── Main ────────────────────────────────────────────────────────────────────
if [ "$WATCH_MODE" = true ]; then
    echo -e "${CYAN}Watching dashboards every ${WATCH_INTERVAL}s (Ctrl-C to stop)${NC}"
    echo ""
    while true; do
        if run_check; then
            echo -e "${GREEN}All healthy.${NC}"
        else
            echo -e "${RED}Issues detected.${NC}"
            if [ "$FIX_MODE" = true ]; then
                attempt_fix
                echo ""
                echo -e "${CYAN}Re-checking after fix...${NC}"
                run_check || echo -e "${RED}Still failing after fix attempt.${NC}"
            fi
        fi
        echo ""
        echo -e "${CYAN}Next check in ${WATCH_INTERVAL}s...${NC}"
        echo "───────────────────────────────────────"
        sleep "$WATCH_INTERVAL"
    done
else
    if run_check; then
        echo ""
        echo -e "${GREEN}All dashboards healthy.${NC}"
        exit 0
    else
        if [ "$FIX_MODE" = true ]; then
            attempt_fix
            echo ""
            echo -e "${CYAN}Re-checking after fix...${NC}"
            if run_check; then
                echo ""
                echo -e "${GREEN}Fixed — all dashboards healthy.${NC}"
                exit 0
            else
                echo ""
                echo -e "${RED}Still failing after fix attempt.${NC}"
                exit 1
            fi
        else
            echo ""
            echo -e "${RED}Dashboards unhealthy. Run with --fix to auto-restart.${NC}"
            exit 1
        fi
    fi
fi
