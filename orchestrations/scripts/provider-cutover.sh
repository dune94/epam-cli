#!/bin/bash
#
# Provider cutover policy utility.
# Reassigns pending stories from one provider to another with guardrails.
#
# Usage:
#   provider-cutover.sh [--from opencode] [--to epam] [--phase <id>] [--apply] [--force] [--json]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
COST_LOG="${COST_LOG:-$AUTOMATION_DIR/logs/phase-cost.jsonl}"

FROM_PROVIDER="opencode"
TO_PROVIDER="epam"
PHASE_FILTER=""
APPLY_MODE=false
FORCE_MODE=false
JSON_MODE=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${CYAN}[$(date +'%H:%M:%S')]${NC} $1" >&2; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1" >&2; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1" >&2; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

usage() {
  cat << EOF
Usage: $(basename "$0") [OPTIONS]

Provider cutover policy utility.
Moves eligible pending stories from one aiProvider to another.

Options:
  --from <provider>   Source provider (default: opencode)
  --to <provider>     Target provider (default: epam)
  --phase <id>        Restrict to a phase in implementationOrder
  --apply             Persist changes to prd.json (default: dry-run/report)
  --force             Bypass policy preconditions (not recommended)
  --json              Emit machine-readable JSON summary
  --help              Show this help

Examples:
  $(basename "$0") --from opencode --to epam
  $(basename "$0") --phase finops --apply
  $(basename "$0") --apply --force
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_PROVIDER="$2"
      shift 2
      ;;
    --to)
      TO_PROVIDER="$2"
      shift 2
      ;;
    --phase)
      PHASE_FILTER="$2"
      shift 2
      ;;
    --apply)
      APPLY_MODE=true
      shift
      ;;
    --force)
      FORCE_MODE=true
      shift
      ;;
    --json)
      JSON_MODE=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [ ! -f "$PRD_FILE" ]; then
  error "PRD file not found: $PRD_FILE"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  error "jq is required but not installed"
  exit 1
fi

if [ -n "$PHASE_FILTER" ]; then
  phase_exists=$(jq --arg p "$PHASE_FILTER" '.implementationOrder | has($p)' "$PRD_FILE")
  if [ "$phase_exists" != "true" ]; then
    error "Phase '$PHASE_FILTER' not found in implementationOrder"
    exit 1
  fi
fi

blocked=false
block_reason=""

if [ "$FORCE_MODE" != true ]; then
  # Baseline guardrail: telemetry fix story must be complete before bulk cutover.
  epam028_completed=$(jq -r '.stories[] | select(.id=="EPAM-028") | .completed // false' "$PRD_FILE")
  if [ "$epam028_completed" != "true" ]; then
    blocked=true
    block_reason="EPAM-028 must be completed before provider cutover."
  fi

  # If cutover target is EPAM, ensure model registry exists.
  if [ "$blocked" = false ] && [ "$TO_PROVIDER" = "epam" ]; then
    allowed_model_count=$(jq -r '(.configuration.aiRuntime.allowedModels // []) | length' "$PRD_FILE")
    default_model=$(jq -r '.configuration.aiRuntime.defaultModel // ""' "$PRD_FILE")
    if [ "${allowed_model_count:-0}" -le 0 ] || [ -z "$default_model" ]; then
      blocked=true
      block_reason="EPAM target requires configuration.aiRuntime.allowedModels and defaultModel."
    fi
  fi
fi

eligible_json=$(jq -c \
  --arg from "$FROM_PROVIDER" \
  --arg phase "$PHASE_FILTER" '
  (.implementationOrder[$phase] // []) as $phase_ids |
  [
    .stories[]
    | select(.completed != true and .status != "completed")
    | select((.storyType // "") != "health_check")
    | select((.aiProvider // "") == $from)
    | select($phase == "" or (.id as $id | $phase_ids | index($id)))
    | {id, status, aiProvider}
  ]' "$PRD_FILE")
eligible_count=$(echo "$eligible_json" | jq -r 'length')

missing_cost_source_count=0
if [ -f "$COST_LOG" ] && [ -s "$COST_LOG" ]; then
  missing_cost_source_count=$(jq -rs --arg src "$FROM_PROVIDER" '
    map(
      select(
        (.resolved_provider // "" | ascii_downcase) == ($src | ascii_downcase) and
        (
          (.cost_source // "") == "unavailable" or
          ((.notes // "") | test("cost_source=unavailable"))
        )
      )
    ) | length
  ' "$COST_LOG" 2>/dev/null || echo "0")
fi

updated_count=0
if [ "$blocked" = false ] && [ "$APPLY_MODE" = true ] && [ "$eligible_count" -gt 0 ]; then
  lock_file="${PRD_FILE}.lock"
  tmp_file="${PRD_FILE}.cutover.$$"
  (
    flock -w 10 200 || { error "Could not acquire lock on $PRD_FILE"; exit 1; }
    jq --arg from "$FROM_PROVIDER" --arg to "$TO_PROVIDER" --arg phase "$PHASE_FILTER" '
      (.implementationOrder[$phase] // []) as $phase_ids |
      .stories |= map(
        if
          (.completed != true and .status != "completed") and
          ((.storyType // "") != "health_check") and
          ((.aiProvider // "") == $from) and
          ($phase == "" or (.id as $id | $phase_ids | index($id)))
        then
          . + {aiProvider: $to}
        else
          .
        end
      ) |
      .lastUpdated = (now | strftime("%Y-%m-%d"))
    ' "$PRD_FILE" > "$tmp_file" && mv "$tmp_file" "$PRD_FILE"
  ) 200>"$lock_file"
  updated_count="$eligible_count"
fi

if [ "$JSON_MODE" = true ]; then
  jq -n \
    --arg from "$FROM_PROVIDER" \
    --arg to "$TO_PROVIDER" \
    --arg phase "$PHASE_FILTER" \
    --argjson blocked "$( [ "$blocked" = true ] && echo true || echo false )" \
    --arg reason "$block_reason" \
    --argjson eligible "$eligible_count" \
    --argjson updated "$updated_count" \
    --argjson missing_cost_source "${missing_cost_source_count:-0}" \
    --arg mode "$( [ "$APPLY_MODE" = true ] && echo "apply" || echo "report" )" \
    '{
      fromProvider: $from,
      toProvider: $to,
      phase: (if $phase == "" then null else $phase end),
      mode: $mode,
      blocked: $blocked,
      blockReason: (if $reason == "" then null else $reason end),
      eligibleStories: $eligible,
      updatedStories: $updated,
      sourceProviderMissingCostSourceCount: $missing_cost_source
    }'
  exit 0
fi

echo ""
echo "Provider cutover policy"
echo "  from:  $FROM_PROVIDER"
echo "  to:    $TO_PROVIDER"
echo "  phase: ${PHASE_FILTER:-all}"
echo "  mode:  $([ "$APPLY_MODE" = true ] && echo "apply" || echo "report")"
echo ""

if [ "$blocked" = true ]; then
  error "Cutover blocked: $block_reason"
  if [ "$FORCE_MODE" != true ]; then
    warning "Use --force to bypass cutover preconditions."
  fi
  exit 1
fi

if [ "$missing_cost_source_count" -gt 0 ]; then
  warning "$missing_cost_source_count source-provider sessions have missing cost source metadata."
fi

if [ "$eligible_count" -eq 0 ]; then
  warning "No eligible stories found for cutover."
  exit 0
fi

echo "Eligible stories ($eligible_count):"
echo "$eligible_json" | jq -r '.[] | "  - \(.id) [\(.status)]"'

if [ "$APPLY_MODE" = true ]; then
  success "Updated $updated_count stories from '$FROM_PROVIDER' to '$TO_PROVIDER' in $(basename "$PRD_FILE")."
else
  log "Dry-run only. Re-run with --apply to persist changes."
fi

