#!/bin/bash
# Validates story dependencies before execution
# Returns 0 if dependencies satisfied, 1 otherwise
# EPAM CLI orchestration dependency checker
#
# Usage:
#   check-dependencies.sh <STORY_ID>
#
# Environment variables:
#   PRD_FILE - Path to prd.json (default: orchestrations/prd.json)
#
# Exit codes:
#   0 - All dependencies satisfied
#   1 - One or more dependencies not satisfied
#   2 - Story not found or invalid input

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
if [ $# -lt 1 ]; then
    echo -e "${RED}ERROR: Missing required argument STORY_ID${NC}" >&2
    echo "Usage: $0 <STORY_ID>" >&2
    exit 2
fi

STORY_ID=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PRD_FILE="${PRD_FILE:-$PROJECT_ROOT/orchestrations/prd.json}"

# Validate PRD file exists
if [ ! -f "$PRD_FILE" ]; then
    echo -e "${RED}ERROR: PRD file not found: $PRD_FILE${NC}" >&2
    exit 2
fi

# Check if story exists
if ! jq -e ".stories[] | select(.id==\"$STORY_ID\")" "$PRD_FILE" > /dev/null 2>&1; then
    echo -e "${RED}ERROR: Story $STORY_ID not found in PRD${NC}" >&2
    exit 2
fi

# Get dependencies for this story
deps=$(jq -r ".stories[] | select(.id==\"$STORY_ID\") | .dependencies // [] | .[]" "$PRD_FILE" 2>/dev/null)

if [ -z "$deps" ]; then
    # No dependencies, OK to proceed
    echo -e "${GREEN}+ No dependencies for $STORY_ID${NC}"
    exit 0
fi

# Count dependencies
total_deps=$(echo "$deps" | wc -l)
satisfied=0
unsatisfied=0
missing=()

# Check each dependency
while IFS= read -r dep; do
    [ -z "$dep" ] && continue

    # Check if dependency exists
    if ! jq -e ".stories[] | select(.id==\"$dep\")" "$PRD_FILE" > /dev/null 2>&1; then
        echo -e "${RED}x Dependency $dep not found in PRD (invalid dependency)${NC}" >&2
        missing+=("$dep")
        unsatisfied=$((unsatisfied + 1))
        continue
    fi

    # Check dependency completion status
    dep_status=$(jq -r ".stories[] | select(.id==\"$dep\") | .completed" "$PRD_FILE")

    if [ "$dep_status" = "true" ]; then
        echo -e "${GREEN}+ Dependency $dep satisfied (completed)${NC}"
        satisfied=$((satisfied + 1))
    else
        echo -e "${RED}x Dependency $dep NOT satisfied (completed=$dep_status)${NC}" >&2
        missing+=("$dep")
        unsatisfied=$((unsatisfied + 1))
    fi
done <<< "$deps"

# Summary
echo ""
if [ $unsatisfied -eq 0 ]; then
    echo -e "${GREEN}+ All $total_deps dependencies satisfied for $STORY_ID${NC}"
    exit 0
else
    echo -e "${RED}x $unsatisfied of $total_deps dependencies NOT satisfied for $STORY_ID${NC}" >&2
    echo -e "${YELLOW}  Unsatisfied: ${missing[*]}${NC}" >&2
    exit 1
fi
