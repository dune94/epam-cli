#!/bin/bash
# Analyzes historical cost data and suggests forecasts for stories without estimates
# EPAM CLI orchestration cost forecast updater
#
# Usage:
#   update-cost-forecasts.sh [--apply]
#
# Options:
#   --apply    Apply recommended forecasts to prd.json (default: dry-run)
#
# Exit codes:
#   0 - Success
#   1 - Error (missing files, invalid data)

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${CYAN}[$(date +'%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="$AUTOMATION_DIR/prd.json"
COST_LOG="$AUTOMATION_DIR/logs/phase-cost.jsonl"
APPLY_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --apply)
            APPLY_MODE=true
            shift
            ;;
        --help|-h)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Analyzes historical cost data and suggests forecasts for stories without estimates.

Options:
  --apply    Apply recommended forecasts to prd.json (default: dry-run)
  --help     Show this help message

Examples:
  $(basename "$0")             # Preview recommendations
  $(basename "$0") --apply     # Apply recommendations to prd.json

EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate prerequisites
if [ ! -f "$PRD_FILE" ]; then
    error "PRD file not found: $PRD_FILE"
    exit 1
fi

if [ ! -f "$COST_LOG" ]; then
    error "Cost log not found: $COST_LOG"
    warning "Run at least one phase to generate cost data first"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    error "jq is required but not installed"
    exit 1
fi

log "Analyzing historical cost data..."

# Calculate statistics by agent role
declare -A role_avg_hours
declare -A role_avg_cost
declare -A role_count

while IFS= read -r line; do
    agent=$(echo "$line" | jq -r '.agent_id // .agent_name')
    elapsed_min=$(echo "$line" | jq -r '.elapsed_minutes // 0')
    cost=$(echo "$line" | jq -r '.task_cost_usd // 0')
    status=$(echo "$line" | jq -r '.status // "unknown"')

    # Only include completed stories
    if [ "$status" != "completed" ]; then
        continue
    fi

    # Convert minutes to hours
    elapsed_hours=$(echo "scale=2; $elapsed_min / 60" | bc)

    # Accumulate statistics
    if [ ! -v role_avg_hours[$agent] ]; then
        role_avg_hours[$agent]=0
        role_avg_cost[$agent]=0
        role_count[$agent]=0
    fi

    role_avg_hours[$agent]=$(echo "scale=4; ${role_avg_hours[$agent]} + $elapsed_hours" | bc)
    role_avg_cost[$agent]=$(echo "scale=4; ${role_avg_cost[$agent]} + $cost" | bc)
    role_count[$agent]=$((${role_count[$agent]} + 1))
done < "$COST_LOG"

# Calculate averages
for role in "${!role_count[@]}"; do
    count=${role_count[$role]}
    if [ "$count" -gt 0 ]; then
        role_avg_hours[$role]=$(echo "scale=4; ${role_avg_hours[$role]} / $count" | bc)
        role_avg_cost[$role]=$(echo "scale=4; ${role_avg_cost[$role]} / $count" | bc)
    fi
done

echo ""
echo -e "${CYAN}=== Historical Cost Statistics ===${NC}"
echo ""
printf "%-25s %10s %15s %15s\n" "Agent Role" "Tasks" "Avg Hours" "Avg Cost"
echo "------------------------------------------------------------------------"
for role in $(echo "${!role_count[@]}" | tr ' ' '\n' | sort); do
    printf "%-25s %10d %15.4f %15.4f\n" \
        "$role" \
        "${role_count[$role]}" \
        "${role_avg_hours[$role]}" \
        "${role_avg_cost[$role]}"
done
echo ""

# Find stories without estimates
stories_without_forecast=$(jq -r '.stories[] | select(.estimatedHours == null or .estimatedHours == 0) | "\(.id)|\(.agentRole // "none")"' "$PRD_FILE")

if [ -z "$stories_without_forecast" ]; then
    success "All stories have cost forecasts!"
    exit 0
fi

total_without_forecast=$(echo "$stories_without_forecast" | wc -l)
log "Found $total_without_forecast stories without cost forecasts"

# Generate recommendations
echo ""
echo -e "${CYAN}=== Forecast Recommendations ===${NC}"
echo ""

declare -a recommendations=()

while IFS='|' read -r story_id agent_role; do
    # Get recommended forecast based on agent role average
    if [ -v role_avg_hours[$agent_role] ]; then
        recommended_hours=${role_avg_hours[$agent_role]}
        recommended_cost=${role_avg_cost[$agent_role]}
        confidence="High (based on ${role_count[$agent_role]} tasks)"
    else
        # No historical data for this role, use global average
        global_avg_hours=0
        global_avg_cost=0
        global_count=0
        for role in "${!role_count[@]}"; do
            global_avg_hours=$(echo "scale=4; $global_avg_hours + ${role_avg_hours[$role]}" | bc)
            global_avg_cost=$(echo "scale=4; $global_avg_cost + ${role_avg_cost[$role]}" | bc)
            global_count=$((global_count + 1))
        done
        if [ "$global_count" -gt 0 ]; then
            recommended_hours=$(echo "scale=4; $global_avg_hours / $global_count" | bc)
            recommended_cost=$(echo "scale=4; $global_avg_cost / $global_count" | bc)
            confidence="Low (no data for $agent_role, using global average)"
        else
            recommended_hours=1.0
            recommended_cost=0
            confidence="Very Low (no historical data)"
        fi
    fi

    echo -e "${YELLOW}$story_id${NC} [$agent_role]"
    echo "  Recommended: $recommended_hours hours (~\$$recommended_cost)"
    echo "  Confidence:  $confidence"
    echo ""

    recommendations+=("$story_id|$recommended_hours")
done <<< "$stories_without_forecast"

# Apply recommendations if requested
if [ "$APPLY_MODE" = true ]; then
    log "Applying recommended forecasts to prd.json..."

    # Backup prd.json
    backup_file="${PRD_FILE}.before-forecast-update"
    cp "$PRD_FILE" "$backup_file"
    success "Backed up prd.json to $backup_file"

    # Apply each recommendation
    for rec in "${recommendations[@]}"; do
        IFS='|' read -r story_id forecast_hours <<< "$rec"

        jq --arg id "$story_id" \
           --argjson hours "$forecast_hours" \
           '(.stories[] | select(.id == $id) | .estimatedHours) = $hours' \
           "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"

        log "  Updated $story_id: estimatedHours = $forecast_hours"
    done

    success "Applied $total_without_forecast forecast updates to prd.json"
    echo ""
    echo "Review changes:"
    echo "  git diff $PRD_FILE"
    echo ""
    echo "To restore original:"
    echo "  cp $backup_file $PRD_FILE"
else
    echo ""
    warning "DRY RUN - No changes applied to prd.json"
    echo "  To apply these recommendations, run:"
    echo "  $(basename "$0") --apply"
fi

exit 0
