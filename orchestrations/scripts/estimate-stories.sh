#!/bin/bash
# Complexity-weighted estimation model for AI agent execution forecasting.
# Reads story metadata from prd.json and predicts 4 metrics per story:
#   - AI execution minutes
#   - Cost (USD)
#   - Tokens (count)
#   - Turns (count)
#
# Uses the model documented in orchestrations/estimation.md.
#
# Usage:
#   estimate-stories.sh [OPTIONS]
#
# Options:
#   --refine         Use historical actuals from phase-cost.jsonl to calibrate constants
#   --apply          Write estimates to prd.json (default: dry-run)
#   --phase <id>     Scope to a single phase
#   --json           Output as JSON instead of table
#   --help           Show usage
#
# Exit codes:
#   0 - Success
#   1 - Error (missing files, invalid data)

set -euo pipefail

# ────────────────────────────────────────────
# Colors + logging
# ────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()     { echo -e "${CYAN}[$(date +'%H:%M:%S')]${NC} $1" >&2; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1" >&2; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1" >&2; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ────────────────────────────────────────────
# Paths
# ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
COST_LOG="${COST_LOG:-$AUTOMATION_DIR/logs/phase-cost.jsonl}"

# ────────────────────────────────────────────
# Defaults
# ────────────────────────────────────────────
REFINE_MODE=false
APPLY_MODE=false
JSON_MODE=false
PHASE_FILTER=""

# ────────────────────────────────────────────
# Arg parsing
# ────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --refine)
            REFINE_MODE=true
            shift
            ;;
        --apply)
            APPLY_MODE=true
            shift
            ;;
        --phase)
            PHASE_FILTER="$2"
            shift 2
            ;;
        --json)
            JSON_MODE=true
            shift
            ;;
        --help|-h)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Complexity-weighted estimation model for AI agent execution forecasting.
Predicts AI minutes, cost, tokens, and turns per story.

Options:
  --refine         Use historical actuals from phase-cost.jsonl to calibrate constants
  --apply          Write estimates to prd.json (default: dry-run)
  --phase <id>     Scope to a single phase (e.g. health_check, finops)
  --json           Output as JSON instead of table
  --help           Show this help message

Examples:
  $(basename "$0")                         # Dry-run with formula defaults
  $(basename "$0") --phase health_check    # Estimate health_check phase only
  $(basename "$0") --refine --apply        # Calibrate from actuals and write to prd.json
  $(basename "$0") --json | jq '.[0]'     # JSON output, inspect first story

EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ────────────────────────────────────────────
# Prerequisites
# ────────────────────────────────────────────
if ! command -v jq &> /dev/null; then
    error "jq is required but not installed"
    exit 1
fi

if ! command -v bc &> /dev/null; then
    error "bc is required but not installed"
    exit 1
fi

if [ ! -f "$PRD_FILE" ]; then
    error "PRD file not found: $PRD_FILE"
    exit 1
fi

if [ "$REFINE_MODE" = true ] && [ ! -f "$COST_LOG" ]; then
    warning "Cost log not found: $COST_LOG -- falling back to formula defaults"
    REFINE_MODE=false
fi

# ────────────────────────────────────────────
# Constants (defaults from estimation.md)
# ────────────────────────────────────────────

# Human-to-AI ratio (1 human hour = X AI hours; default 0.08 = ~5 min/hr)
HUMAN_TO_AI_RATIO=0.08

# Tokens per minute by effort tier
TOKENS_PER_MIN_LOW=8000
TOKENS_PER_MIN_MED=12000
TOKENS_PER_MIN_HIGH=18000

# Minutes per turn by effort
MIN_PER_TURN_LOW=0.5
MIN_PER_TURN_MED=1.0
MIN_PER_TURN_HIGH=1.5

# Input/output token split
INPUT_RATIO=0.80
OUTPUT_RATIO=0.20

# Cache hit ratios by position in phase
CACHE_POS_1=0.00
CACHE_POS_2=0.40
CACHE_POS_3=0.55
CACHE_POS_4PLUS=0.65
CACHE_SAME_ROLE_BONUS=0.10

# Pricing table (USD per 1M tokens)
declare -A PRICING_INPUT=( [high]=15.00 [medium]=3.00 [low]=0.80 )
declare -A PRICING_CACHED=( [high]=1.50 [medium]=0.30 [low]=0.08 )
declare -A PRICING_OUTPUT=( [high]=75.00 [medium]=15.00 [low]=4.00 )

# ────────────────────────────────────────────
# Refinement from Historical Data
# ────────────────────────────────────────────
if [ "$REFINE_MODE" = true ]; then
    log "Calibrating constants from historical actuals..."

    completed_data=$(grep '"status":"completed"' "$COST_LOG" 2>/dev/null || true)

    if [ -z "$completed_data" ]; then
        warning "No completed records in $COST_LOG -- using formula defaults"
        REFINE_MODE=false
    else
        # Calibrate HUMAN_TO_AI_RATIO
        sum_elapsed=$(echo "$completed_data" | jq -s 'map(.elapsed_minutes // 0) | add // 0')
        sum_forecast_min=$(echo "$completed_data" | jq -s 'map((.forecast_hours // 0) * 60) | add // 0')

        if (( $(echo "$sum_forecast_min > 0" | bc -l) )); then
            HUMAN_TO_AI_RATIO=$(echo "scale=4; $sum_elapsed / $sum_forecast_min" | bc)
        fi

        # Calibrate tokens per minute by effort tier
        # Group by inferred effort: estimatedHours <= 2 → low, <= 6 → med, > 6 → high
        for tier in low med high; do
            case $tier in
                low)  filter='select((.forecast_hours // 0) <= 2)' ;;
                med)  filter='select((.forecast_hours // 0) > 2 and (.forecast_hours // 0) <= 6)' ;;
                high) filter='select((.forecast_hours // 0) > 6)' ;;
            esac

            tier_tokens=$(echo "$completed_data" | jq -s "[.[] | $filter | ((.task_tokens_in // 0) + (.task_tokens_out // 0))] | add // 0")
            tier_minutes=$(echo "$completed_data" | jq -s "[.[] | $filter | (.elapsed_minutes // 0)] | add // 0")

            if (( $(echo "$tier_minutes > 0" | bc -l) )); then
                calibrated=$(echo "scale=0; $tier_tokens / $tier_minutes" | bc)
                case $tier in
                    low)  TOKENS_PER_MIN_LOW=$calibrated ;;
                    med)  TOKENS_PER_MIN_MED=$calibrated ;;
                    high) TOKENS_PER_MIN_HIGH=$calibrated ;;
                esac
            fi
        done

        # Compute per-role averages for summary
        echo ""
        echo -e "${CYAN}=== Calibration Summary ===${NC}"
        echo ""
        printf "%-30s %15s\n" "Parameter" "Calibrated Value"
        echo "----------------------------------------------"
        printf "%-30s %15.4f\n" "HUMAN_TO_AI_RATIO" "$HUMAN_TO_AI_RATIO"
        printf "%-30s %15d\n" "TOKENS_PER_MIN (low/Haiku)" "$TOKENS_PER_MIN_LOW"
        printf "%-30s %15d\n" "TOKENS_PER_MIN (med/Sonnet)" "$TOKENS_PER_MIN_MED"
        printf "%-30s %15d\n" "TOKENS_PER_MIN (high/Opus)" "$TOKENS_PER_MIN_HIGH"
        printf "%-30s %15.1f\n" "Total elapsed minutes" "$sum_elapsed"
        printf "%-30s %15.1f\n" "Total forecast minutes" "$sum_forecast_min"
        completed_count=$(echo "$completed_data" | jq -s 'length')
        printf "%-30s %15d\n" "Completed stories" "$completed_count"
        echo ""
    fi
fi

# ────────────────────────────────────────────
# Story Extraction
# ────────────────────────────────────────────
log "Reading stories from $(basename "$PRD_FILE")..."

if [ -n "$PHASE_FILTER" ]; then
    # Validate phase exists
    phase_exists=$(jq --arg p "$PHASE_FILTER" '.implementationOrder | has($p)' "$PRD_FILE")
    if [ "$phase_exists" != "true" ]; then
        error "Phase '$PHASE_FILTER' not found in implementationOrder"
        echo "  Available phases: $(jq -r '.implementationOrder | keys | join(", ")' "$PRD_FILE")"
        exit 1
    fi
    story_ids=$(jq -r --arg p "$PHASE_FILTER" '.implementationOrder[$p][]' "$PRD_FILE")
else
    story_ids=$(jq -r '.stories[].id' "$PRD_FILE")
fi

story_count=$(echo "$story_ids" | wc -l)
log "Found $story_count stories to estimate"

# ────────────────────────────────────────────
# Codebase Signal Computation
# ────────────────────────────────────────────
compute_loc() {
    local story_id="$1"
    local total_loc=0
    local import_count=0

    local files
    files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$PRD_FILE")

    if [ -z "$files" ]; then
        echo "0|0"
        return
    fi

    while IFS= read -r f; do
        local full_path="$PROJECT_ROOT/$f"
        if [ -f "$full_path" ]; then
            local loc
            loc=$(wc -l < "$full_path")
            total_loc=$((total_loc + loc))
            local imports
            imports=$(grep -cE "^import |require\(" "$full_path" 2>/dev/null || true)
            import_count=$((import_count + imports))
        fi
    done <<< "$files"

    echo "${total_loc}|${import_count}"
}

# ────────────────────────────────────────────
# Complexity Index Computation
# ────────────────────────────────────────────
compute_complexity() {
    local priority="$1"
    local story_type="$2"
    local dep_count="$3"
    local skill_count="$4"
    local file_count="$5"
    local total_loc="$6"
    local required_skills="$7"

    # priority_weight
    local priority_weight
    case "$priority" in
        critical) priority_weight=1.3 ;;
        high)     priority_weight=1.1 ;;
        *)        priority_weight=1.0 ;;
    esac

    # story_type_weight
    local story_type_weight
    case "$story_type" in
        review)       story_type_weight=0.3 ;;
        health_check) story_type_weight=0.15 ;;
        *)            story_type_weight=1.0 ;;
    esac

    # error_retry_multiplier — product of applicable risk factors
    local error_retry="1.0"

    # Touches >3 files → 1.15x
    if [ "$file_count" -gt 3 ]; then
        error_retry=$(echo "scale=4; $error_retry * 1.15" | bc)
    fi

    # External dependencies: HTTP, MCP, SSE → 1.20x
    if echo "$required_skills" | grep -qiE "HTTP|MCP|SSE"; then
        error_retry=$(echo "scale=4; $error_retry * 1.20" | bc)
    fi

    # High-complexity skills: agent-orchestration, multi-agent, parallel-async → 1.25x
    if echo "$required_skills" | grep -qiE "agent-orchestration|multi-agent|parallel-async"; then
        error_retry=$(echo "scale=4; $error_retry * 1.25" | bc)
    fi

    # Compute C using formula from estimation.md
    local dep_factor skill_factor loc_factor file_factor
    dep_factor=$(echo "scale=4; 1 + 0.05 * $(max_zero $((dep_count - 1)))" | bc)
    skill_factor=$(echo "scale=4; 1 + 0.03 * $(max_zero $((skill_count - 2)))" | bc)

    local loc_excess
    loc_excess=$(max_zero $((total_loc - 200)))
    loc_factor=$(echo "scale=4; 1 + 0.02 * ($loc_excess / 100)" | bc)

    file_factor=$(echo "scale=4; 1 + 0.05 * $(max_zero $((file_count - 2)))" | bc)

    local C
    C=$(echo "scale=4; $priority_weight * $story_type_weight * $dep_factor * $skill_factor * $loc_factor * $file_factor * $error_retry" | bc)

    # Ensure leading zero (bc may output ".1950" instead of "0.1950")
    [[ "$C" =~ ^\. ]] && C="0${C}"
    echo "$C"
}

# Helper: max(0, n)
max_zero() {
    local n="$1"
    if [ "$n" -lt 0 ]; then
        echo 0
    else
        echo "$n"
    fi
}

# Helper: ceil function for bc
ceil_val() {
    local val="$1"
    local int_part
    int_part=$(echo "$val" | cut -d'.' -f1)
    local dec_part
    dec_part=$(echo "$val" | cut -d'.' -f2 2>/dev/null || echo "0")
    if [ -z "$int_part" ] || [ "$int_part" = "" ]; then
        int_part=0
    fi
    if [ -n "$dec_part" ] && [ "$dec_part" != "0" ] && [ "$dec_part" != "00" ] && [ "$dec_part" != "000" ] && [ "$dec_part" != "0000" ]; then
        echo $((int_part + 1))
    else
        echo "$int_part"
    fi
}

# Helper: get cache ratio based on position in phase
get_cache_ratio() {
    local position="$1"
    case "$position" in
        1) echo "$CACHE_POS_1" ;;
        2) echo "$CACHE_POS_2" ;;
        3) echo "$CACHE_POS_3" ;;
        *) echo "$CACHE_POS_4PLUS" ;;
    esac
}

# Helper: get effort tier from estimatedHours
get_effort_tier() {
    local hours="$1"
    if (( $(echo "$hours <= 2" | bc -l) )); then
        echo "low"
    elif (( $(echo "$hours <= 6" | bc -l) )); then
        echo "medium"
    else
        echo "high"
    fi
}

# ────────────────────────────────────────────
# Build phase position map
# ────────────────────────────────────────────
declare -A STORY_PHASE
declare -A STORY_POSITION

all_phases=$(jq -r '.implementationOrder | keys[]' "$PRD_FILE")
while IFS= read -r phase; do
    pos=1
    phase_story_ids=$(jq -r --arg p "$phase" '.implementationOrder[$p][]' "$PRD_FILE")
    while IFS= read -r sid; do
        STORY_PHASE["$sid"]="$phase"
        STORY_POSITION["$sid"]=$pos
        pos=$((pos + 1))
    done <<< "$phase_story_ids"
done <<< "$all_phases"

# ────────────────────────────────────────────
# Estimation Loop
# ────────────────────────────────────────────
log "Computing estimates..."
echo ""

# Accumulators for summary
declare -A PHASE_STORIES PHASE_MINUTES PHASE_TOKENS PHASE_COST
GRAND_STORIES=0
GRAND_MINUTES=0
GRAND_TOKENS=0
GRAND_COST=0

# JSON accumulator
JSON_RESULTS="[]"

# Track previous agent role per phase for same-role bonus
declare -A PREV_ROLE_IN_PHASE

while IFS= read -r sid; do
    # Extract story metadata via single jq call
    story_data=$(jq -r --arg id "$sid" '
        .stories[] | select(.id == $id) |
        "\(.id)|\(.title)|\(.estimatedHours // 0)|\(.priority // "medium")|\(.storyType // "implementation")|\(.agentRole // "none")|\(.dependencies | length)|\(.technicalNotes.requiredSkills | length)|\(.technicalNotes.files | length)|\(.technicalNotes.requiredSkills | join(","))"
    ' "$PRD_FILE")

    IFS='|' read -r s_id s_title s_hours s_priority s_type s_role s_deps s_skills s_files s_skill_csv <<< "$story_data"

    # Effort tier
    effort=$(get_effort_tier "$s_hours")

    # Phase and position
    phase="${STORY_PHASE[$sid]:-unknown}"
    position="${STORY_POSITION[$sid]:-1}"

    # Codebase LOC
    loc_data=$(compute_loc "$sid")
    IFS='|' read -r total_loc import_count <<< "$loc_data"

    # Complexity index
    C=$(compute_complexity "$s_priority" "$s_type" "$s_deps" "$s_skills" "$s_files" "$total_loc" "$s_skill_csv")

    # AI execution minutes
    ai_minutes=$(echo "scale=2; $s_hours * $HUMAN_TO_AI_RATIO * 60 * $C" | bc)
    # Ensure leading zero (bc may output ".93" instead of "0.93")
    [[ "$ai_minutes" =~ ^\. ]] && ai_minutes="0${ai_minutes}"

    # Tokens
    local_tpm=0
    local_mpt=0
    case "$effort" in
        low)    local_tpm=$TOKENS_PER_MIN_LOW;  local_mpt=$MIN_PER_TURN_LOW ;;
        medium) local_tpm=$TOKENS_PER_MIN_MED;  local_mpt=$MIN_PER_TURN_MED ;;
        high)   local_tpm=$TOKENS_PER_MIN_HIGH; local_mpt=$MIN_PER_TURN_HIGH ;;
    esac

    file_token_factor=$(echo "scale=4; 1 + 0.1 * $(max_zero $((s_files - 1)))" | bc)
    # Use / 1 to force bc to apply scale=0 (bc scale only affects division, not multiplication)
    tokens=$(echo "scale=0; ($ai_minutes * $local_tpm * $file_token_factor) / 1" | bc)

    # Turns
    if (( $(echo "$local_mpt > 0" | bc -l) )); then
        turns_raw=$(echo "scale=4; $ai_minutes / $local_mpt" | bc)
    else
        turns_raw="1"
    fi
    turns=$(ceil_val "$turns_raw")
    if [ "$turns" -lt 1 ]; then
        turns=1
    fi

    # Cache ratio
    cache_ratio=$(get_cache_ratio "$position")
    # Same-role bonus
    prev_role="${PREV_ROLE_IN_PHASE[$phase]:-}"
    if [ -n "$prev_role" ] && [ "$prev_role" = "$s_role" ]; then
        cache_ratio=$(echo "scale=2; $cache_ratio + $CACHE_SAME_ROLE_BONUS" | bc)
        # Cap at 0.85
        if (( $(echo "$cache_ratio > 0.85" | bc -l) )); then
            cache_ratio=0.85
        fi
    fi
    PREV_ROLE_IN_PHASE["$phase"]="$s_role"

    # Cost computation
    input_tokens=$(echo "scale=0; ($tokens * $INPUT_RATIO) / 1" | bc)
    output_tokens=$(echo "scale=0; ($tokens * $OUTPUT_RATIO) / 1" | bc)
    cache_tokens=$(echo "scale=0; ($input_tokens * $cache_ratio) / 1" | bc)
    uncached_input=$(echo "scale=0; ($input_tokens - $cache_tokens) / 1" | bc)

    price_input="${PRICING_INPUT[$effort]}"
    price_cached="${PRICING_CACHED[$effort]}"
    price_output="${PRICING_OUTPUT[$effort]}"

    cost=$(echo "scale=4; ($uncached_input / 1000000) * $price_input + ($cache_tokens / 1000000) * $price_cached + ($output_tokens / 1000000) * $price_output" | bc)

    # Format cost to 2 decimals
    cost=$(echo "scale=2; $cost / 1" | bc)
    # Ensure leading zero
    if echo "$cost" | grep -q '^\.' ; then
        cost="0$cost"
    fi

    # Format ai_minutes to 1 decimal
    ai_minutes_fmt=$(printf "%.1f" "$ai_minutes")

    # Comma-format tokens
    tokens_fmt=$(printf "%'d" "$tokens" 2>/dev/null || echo "$tokens")
    input_fmt=$(printf "%'d" "$input_tokens" 2>/dev/null || echo "$input_tokens")
    output_fmt=$(printf "%'d" "$output_tokens" 2>/dev/null || echo "$output_tokens")

    # Cache percentage
    cache_pct=$(echo "scale=0; ($cache_ratio * 100) / 1" | bc)

    # Model name by effort
    case "$effort" in
        low)    model_name="Haiku 4.5" ;;
        medium) model_name="Sonnet 4.6" ;;
        high)   model_name="Opus 4.6" ;;
    esac

    # Print formatted output
    if [ "$JSON_MODE" != true ]; then
        echo -e "${BOLD}${s_id}${NC}  ${s_title}"
        echo "  Human hours:    ${s_hours}h"
        echo "  AI minutes:     ${ai_minutes_fmt} min  (C=${C}, ratio=${HUMAN_TO_AI_RATIO})"
        echo "  Tokens:         ${tokens_fmt}   (in: ${input_fmt} / out: ${output_fmt})"
        echo "  Cache:          ${cache_pct}% hit   (position: ${position} in ${phase})"
        echo "  Turns:          ${turns}        (${local_mpt} min/turn, ${effort} effort)"
        echo "  Cost:           \$${cost}     (${model_name}, cached input: \$${price_cached}/1M)"
        echo ""
    fi

    # Accumulate JSON
    JSON_RESULTS=$(echo "$JSON_RESULTS" | jq \
        --arg id "$s_id" \
        --arg title "$s_title" \
        --arg phase "$phase" \
        --arg effort "$effort" \
        --argjson hours "$s_hours" \
        --argjson ai_min "$ai_minutes" \
        --argjson tokens "$tokens" \
        --argjson turns "$turns" \
        --argjson cost "$cost" \
        --argjson complexity "$C" \
        --argjson cache_pct "$cache_pct" \
        --argjson position "$position" \
        '. + [{
            id: $id,
            title: $title,
            phase: $phase,
            effort: $effort,
            estimatedHours: $hours,
            estimatedAiMinutes: ($ai_min * 100 | round / 100),
            estimatedTokens: $tokens,
            estimatedTurns: $turns,
            estimatedCost: ($cost * 100 | round / 100),
            complexityIndex: ($complexity * 10000 | round / 10000),
            cacheHitPct: $cache_pct,
            positionInPhase: $position
        }]')

    # Accumulate phase totals
    PHASE_STORIES["$phase"]=$(( ${PHASE_STORIES["$phase"]:-0} + 1 ))
    PHASE_MINUTES["$phase"]=$(echo "scale=2; ${PHASE_MINUTES["$phase"]:-0} + $ai_minutes" | bc)
    PHASE_TOKENS["$phase"]=$(echo "scale=0; ${PHASE_TOKENS["$phase"]:-0} + $tokens" | bc)
    PHASE_COST["$phase"]=$(echo "scale=4; ${PHASE_COST["$phase"]:-0} + $cost" | bc)

    GRAND_STORIES=$((GRAND_STORIES + 1))
    GRAND_MINUTES=$(echo "scale=2; $GRAND_MINUTES + $ai_minutes" | bc)
    GRAND_TOKENS=$(echo "scale=0; $GRAND_TOKENS + $tokens" | bc)
    GRAND_COST=$(echo "scale=4; $GRAND_COST + $cost" | bc)

done <<< "$story_ids"

# ────────────────────────────────────────────
# Summary Output
# ────────────────────────────────────────────
if [ "$JSON_MODE" = true ]; then
    echo "$JSON_RESULTS" | jq '.'
else
    echo -e "${CYAN}=== Phase Summary ===${NC}"
    echo ""
    printf "%-22s %8s %12s %15s %10s\n" "Phase" "Stories" "AI Minutes" "Tokens" "Cost"
    echo "------------------------------------------------------------------------"

    for phase in $(echo "${!PHASE_STORIES[@]}" | tr ' ' '\n' | sort); do
        p_stories="${PHASE_STORIES[$phase]}"
        p_minutes="${PHASE_MINUTES[$phase]}"
        p_tokens="${PHASE_TOKENS[$phase]}"
        p_cost="${PHASE_COST[$phase]}"
        # Leading zero for cost
        if echo "$p_cost" | grep -q '^\.' ; then
            p_cost="0$p_cost"
        fi
        p_tokens_fmt=$(printf "%'d" "$p_tokens" 2>/dev/null || echo "$p_tokens")
        printf "%-22s %8d %12.1f %15s %10.2f\n" \
            "$phase" "$p_stories" "$p_minutes" "$p_tokens_fmt" "$p_cost"
    done

    echo "------------------------------------------------------------------------"
    grand_tokens_fmt=$(printf "%'d" "$GRAND_TOKENS" 2>/dev/null || echo "$GRAND_TOKENS")
    # Leading zero for grand cost
    if echo "$GRAND_COST" | grep -q '^\.' ; then
        GRAND_COST="0$GRAND_COST"
    fi
    printf "${BOLD}%-22s %8d %12.1f %15s %10.2f${NC}\n" \
        "TOTAL" "$GRAND_STORIES" "$GRAND_MINUTES" "$grand_tokens_fmt" "$GRAND_COST"
    echo ""
fi

# ────────────────────────────────────────────
# Apply Mode
# ────────────────────────────────────────────
if [ "$APPLY_MODE" = true ]; then
    log "Applying estimates to prd.json..."

    # Backup
    backup_file="${PRD_FILE}.before-estimate"
    cp "$PRD_FILE" "$backup_file"
    success "Backed up prd.json to $backup_file"

    # Write estimates for each story
    while IFS= read -r sid; do
        # Pull estimates from JSON_RESULTS
        story_est=$(echo "$JSON_RESULTS" | jq --arg id "$sid" '.[] | select(.id == $id)')
        aim=$(echo "$story_est" | jq '.estimatedAiMinutes')
        tok=$(echo "$story_est" | jq '.estimatedTokens')
        trn=$(echo "$story_est" | jq '.estimatedTurns')
        cst=$(echo "$story_est" | jq '.estimatedCost')

        jq --arg id "$sid" \
           --argjson aim "$aim" \
           --argjson cost "$cst" \
           --argjson tok "$tok" \
           --argjson turns "$trn" \
           '(.stories[] | select(.id == $id)) |=
             . + {estimatedAiMinutes: $aim, estimatedCost: $cost,
                  estimatedTokens: $tok, estimatedTurns: $turns}' \
           "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
    done <<< "$story_ids"

    success "Applied estimates to $GRAND_STORIES stories in prd.json"
    echo ""
    echo "Review changes:"
    echo "  git diff $PRD_FILE"
    echo ""
    echo "To restore original:"
    echo "  cp $backup_file $PRD_FILE"
else
    if [ "$JSON_MODE" != true ]; then
        echo ""
        warning "DRY RUN - No changes applied to prd.json"
        echo "  To apply these estimates, run:"
        echo "  $(basename "$0") --apply"
    fi
fi

exit 0
