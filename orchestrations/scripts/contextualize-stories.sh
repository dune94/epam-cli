#!/bin/bash
# Contextual Purveyor Agent (CPA) — Pre-orchestration inference pass.
#
# For each story, retrieves relevant KB chunks via TF-IDF, invokes Claude
# for a structured estimate review, blends with formula estimates using
# confidence-weighted interpolation, and gates on risk thresholds.
#
# Usage:
#   contextualize-stories.sh [OPTIONS]
#
# Options:
#   --phase <id>   Scope to one phase (default: all phases in prd.json)
#   --apply        Write blended estimates back to prd.json
#   --strict       Halt on any 'review' gate (default: halt only on 'block')
#   --dry-run      Run inference but skip prd.json writes and cpa-review.jsonl
#   --json         Output full results as JSON array to stdout
#   --reconcile    Compare prior CPA estimates against phase-cost.jsonl actuals
#   --help
#
# Exit codes:
#   0  All stories passed gate
#   2  One or more 'review' gate stories (only exits 2 with --strict)
#   3  One or more 'block' gate stories

set -euo pipefail

# ── Colors + logging ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

log()     { echo -e "${CYAN}[$(date +'%H:%M:%S')]${NC} $1" >&2; }
success() { echo -e "${GREEN}[CPA OK]${NC} $1" >&2; }
warning() { echo -e "${YELLOW}[CPA WARN]${NC} $1" >&2; }
error()   { echo -e "${RED}[CPA ERR]${NC} $1" >&2; }
info()    { echo -e "${MAGENTA}[CPA]${NC} $1" >&2; }

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
LIB_DIR="$SCRIPT_DIR/lib"

PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
COST_LOG="${COST_LOG:-$AUTOMATION_DIR/logs/phase-cost.jsonl}"
CPA_LOG="${CPA_LOG:-$AUTOMATION_DIR/logs/cpa-review.jsonl}"
SYSTEM_PROMPT_FILE="$AUTOMATION_DIR/prompts/cpa-system.md"
KB_DIR="$AUTOMATION_DIR/agents"   # KB.md and AGENTS.md live here

# Extra docs fed into TF-IDF beyond the KB dir
EXTRA_DOCS="$AUTOMATION_DIR/INSTRUCTIONS.md,$AUTOMATION_DIR/estimation.md,$AUTOMATION_DIR/README.md"

# Node 20 — honour project's nvm-pinned version
NODE_CMD="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
if [ ! -x "$NODE_CMD" ]; then
  NODE_CMD="$(command -v node 2>/dev/null || echo 'node')"
fi

# ── Defaults ────────────────────────────────────────────────────────────────
PHASE_FILTER=""
APPLY_MODE=false
STRICT_MODE=false
DRY_RUN=false
JSON_MODE=false
RECONCILE_MODE=false

# ── Confidence thresholds ───────────────────────────────────────────────────
BLEND_HIGH=0.75      # >= this: trust CPA fully
BLEND_LOW=0.50       # < BLEND_HIGH and >= this: interpolate
# < BLEND_LOW: keep formula + 20% uncertainty markup, gate=review
GATE_BLOCK=0.35      # confidence < this: gate=block
GATE_REVIEW_FLAGS=3  # riskFlags count > this: gate=review

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --phase)   PHASE_FILTER="$2"; shift 2 ;;
    --apply)   APPLY_MODE=true;   shift ;;
    --strict)  STRICT_MODE=true;  shift ;;
    --dry-run) DRY_RUN=true;      shift ;;
    --json)    JSON_MODE=true;    shift ;;
    --reconcile) RECONCILE_MODE=true; shift ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Contextual Purveyor Agent — pre-orchestration estimate calibration and risk gating.

Options:
  --phase <id>   Scope to one phase (default: all phases)
  --apply        Write blended estimates to prd.json
  --strict       Halt on any 'review' gate (default: halt only on 'block')
  --dry-run      Inference only — skip prd.json and cpa-review.jsonl writes
  --json         Output results as JSON array
  --reconcile    Compare prior CPA estimates against phase-cost.jsonl actuals
  --help

Environment:
  CLAUDE_CMD   claude binary override (default: 'claude'; already authenticated via Claude Code)
  NODE_CMD     Node.js binary path (default: ~/.nvm/versions/node/v20.20.0/bin/node)
  SKIP_CPA=1   Skip CPA entirely (set in run-agent-orchestration.sh)

Exit codes:
  0  All pass
  2  'review' gates present (only when --strict)
  3  'block' gate present

EOF
      exit 0 ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Prerequisites ────────────────────────────────────────────────────────────
for cmd in jq bc; do
  if ! command -v "$cmd" &>/dev/null; then
    error "$cmd is required but not installed"; exit 1
  fi
done

if [ ! -f "$PRD_FILE" ]; then
  error "PRD file not found: $PRD_FILE"; exit 1
fi

if [ ! -f "$LIB_DIR/tfidf.js" ]; then
  error "tfidf.js not found: $LIB_DIR/tfidf.js"; exit 1
fi

if [ ! -f "$LIB_DIR/cpa-inference.js" ]; then
  error "cpa-inference.js not found: $LIB_DIR/cpa-inference.js"; exit 1
fi

if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
  warning "CPA system prompt not found: $SYSTEM_PROMPT_FILE"
  warning "Using built-in fallback prompt (non-blocking)."
  SYSTEM_PROMPT="$(cat <<'EOF'
You are the Contextual Purveyor Agent (CPA).
Goal: refine formula-based implementation estimates for a software story using provided context.

Rules:
- Return strict JSON only.
- Be conservative when confidence is low.
- Surface concrete risk flags and missing knowledge areas.
- Prefer practical effort realism over optimism.

Output schema:
{
  "confidence": 0.0,
  "complexityAdjustment": 1.0,
  "adjustedEstimate": {
    "aiMinutes": 0,
    "cost": 0,
    "tokens": 0,
    "turns": 1
  },
  "riskFlags": [],
  "missingKbCoverage": [],
  "citedSources": [],
  "reasoning": "short rationale"
}
EOF
)"
else
  SYSTEM_PROMPT="$(cat "$SYSTEM_PROMPT_FILE")"
fi

# ── Reconcile mode ───────────────────────────────────────────────────────────
if [ "$RECONCILE_MODE" = true ]; then
  log "Reconciling CPA estimates against actuals in $COST_LOG..."

  if [ ! -f "$COST_LOG" ] || [ ! -s "$COST_LOG" ]; then
    warning "No actuals in $COST_LOG — nothing to reconcile"
    exit 0
  fi
  if [ ! -f "$CPA_LOG" ] || [ ! -s "$CPA_LOG" ]; then
    warning "No CPA reviews in $CPA_LOG — run CPA first"
    exit 0
  fi

  echo ""
  echo -e "${CYAN}=== CPA Reconciliation ===${NC}"
  echo ""
  printf "%-15s %12s %12s %12s %10s\n" "Story" "CPA Min" "Actual Min" "Delta%" "Accuracy"
  echo "-----------------------------------------------------------------------"

  total_acc=0
  total_count=0

  while IFS= read -r line; do
    sid=$(echo "$line" | jq -r '.task_id // empty' 2>/dev/null)
    [ -z "$sid" ] && continue
    actual_min=$(echo "$line" | jq -r '.elapsed_minutes // 0' 2>/dev/null)

    # Find latest CPA record for this story
    cpa_min=$(grep "\"storyId\":\"$sid\"" "$CPA_LOG" 2>/dev/null | tail -1 | \
      jq -r '.blendedEstimate.aiMinutes // 0' 2>/dev/null || echo "0")

    if (( $(echo "$actual_min > 0 && $cpa_min > 0" | bc -l) )); then
      delta_pct=$(echo "scale=1; (($cpa_min - $actual_min) / $actual_min) * 100" | bc)
      accuracy=$(echo "scale=2; 1 - ($cpa_min - $actual_min) ^ 2 / ($actual_min ^ 2)" | bc 2>/dev/null || echo "0")
      # Clamp accuracy to 0-1
      if (( $(echo "$accuracy < 0" | bc -l) )); then accuracy="0.00"; fi
      if (( $(echo "$accuracy > 1" | bc -l) )); then accuracy="1.00"; fi

      printf "%-15s %12.1f %12.1f %11.1f%% %10.2f\n" \
        "$sid" "$cpa_min" "$actual_min" "$delta_pct" "$accuracy"

      total_acc=$(echo "scale=4; $total_acc + $accuracy" | bc)
      total_count=$((total_count + 1))

      # Write retrievalAccuracy back to CPA log
      if [ "$DRY_RUN" != true ]; then
        tmp_log="${CPA_LOG}.tmp.$$"
        while IFS= read -r cpa_line; do
          cpa_sid=$(echo "$cpa_line" | jq -r '.storyId // empty' 2>/dev/null)
          if [ "$cpa_sid" = "$sid" ]; then
            echo "$cpa_line" | jq --argjson acc "$accuracy" \
              '.metrics.retrievalAccuracy = $acc' 2>/dev/null || echo "$cpa_line"
          else
            echo "$cpa_line"
          fi
        done < "$CPA_LOG" > "$tmp_log" && mv "$tmp_log" "$CPA_LOG"
      fi
    fi
  done < <(grep '"status":"completed"' "$COST_LOG" 2>/dev/null || true)

  echo "-----------------------------------------------------------------------"
  if [ "$total_count" -gt 0 ]; then
    avg_acc=$(echo "scale=2; $total_acc / $total_count" | bc)
    printf "${BOLD}%-15s %12s %12s %12s %10.2f${NC}\n" \
      "AVERAGE" "" "" "" "$avg_acc"
    echo ""
    if (( $(echo "$avg_acc >= 0.80" | bc -l) )); then
      success "CPA retrieval accuracy: ${avg_acc} (good)"
    elif (( $(echo "$avg_acc >= 0.60" | bc -l) )); then
      warning "CPA retrieval accuracy: ${avg_acc} (acceptable — consider --refine)"
    else
      warning "CPA retrieval accuracy: ${avg_acc} (low — KB coverage may need expansion)"
    fi
  else
    warning "No matching story pairs found between CPA log and cost log"
  fi
  exit 0
fi

# ── Story extraction ─────────────────────────────────────────────────────────
log "Loading stories from $(basename "$PRD_FILE")..."

if [ -n "$PHASE_FILTER" ]; then
  phase_exists=$(jq --arg p "$PHASE_FILTER" '.implementationOrder | has($p)' "$PRD_FILE")
  if [ "$phase_exists" != "true" ]; then
    error "Phase '$PHASE_FILTER' not found in implementationOrder"
    echo "  Available: $(jq -r '.implementationOrder | keys | join(", ")' "$PRD_FILE")" >&2
    exit 1
  fi
  story_ids=$(jq -r --arg p "$PHASE_FILTER" '.implementationOrder[$p][]' "$PRD_FILE")
else
  story_ids=$(jq -r '[.implementationOrder[]] | flatten | .[]' "$PRD_FILE")
fi

story_count=$(echo "$story_ids" | grep -c '.' || echo 0)
log "Found $story_count stories to contextualize"

# ── Build phase-position map for cache ratio ─────────────────────────────────
declare -A STORY_PHASE STORY_POSITION

while IFS= read -r phase; do
  pos=1
  while IFS= read -r sid; do
    STORY_PHASE["$sid"]="$phase"
    STORY_POSITION["$sid"]=$pos
    pos=$((pos + 1))
  done < <(jq -r --arg p "$phase" '.implementationOrder[$p][]' "$PRD_FILE")
done < <(jq -r '.implementationOrder | keys_unsorted[]' "$PRD_FILE")

# ── Helpers ──────────────────────────────────────────────────────────────────

get_effort() {
  local h="$1"
  if (( $(echo "$h <= 2" | bc -l) )); then echo "low"
  elif (( $(echo "$h <= 6" | bc -l) )); then echo "medium"
  else echo "high"; fi
}

ensure_leading_zero() {
  local v="$1"
  [[ "$v" =~ ^\. ]] && v="0${v}"
  echo "$v"
}

bc_eval() { echo "scale=4; $1" | bc | xargs printf "%.4f"; }

# ── Codebase signals ──────────────────────────────────────────────────────────
# Max lines per file snippet and max files to include snippets for
SNIPPET_LINES=30
SNIPPET_MAX_FILES=3

compute_signals() {
  local sid="$1"
  local total_loc=0 import_count=0 files_exist=0 file_count=0
  local snippets="[]"
  local snippet_count=0

  local files
  files=$(jq -r --arg id "$sid" \
    '.stories[] | select(.id==$id) | .technicalNotes.files[]? // empty' "$PRD_FILE")

  if [ -n "$files" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      file_count=$((file_count + 1))
      local fp="$PROJECT_ROOT/$f"
      if [ -f "$fp" ]; then
        files_exist=$((files_exist + 1))
        local loc; loc=$(wc -l < "$fp" || echo 0)
        total_loc=$((total_loc + loc))
        local imp; imp=$(grep -cE "^import |require\(" "$fp" 2>/dev/null; true); imp="${imp:-0}"
        import_count=$((import_count + imp))
        # Include code snippets for CPA grounding (first N lines, up to M files)
        if [ "$snippet_count" -lt "$SNIPPET_MAX_FILES" ]; then
          local snippet
          snippet=$(head -n "$SNIPPET_LINES" "$fp" 2>/dev/null | jq -Rs '.' 2>/dev/null || echo '""')
          snippets=$(echo "$snippets" | jq --arg path "$f" --argjson lines "$loc" --argjson code "$snippet" \
            '. + [{path: $path, lines: $lines, snippet: $code}]')
          snippet_count=$((snippet_count + 1))
        fi
      fi
    done <<< "$files"
  fi

  jq -n \
    --argjson loc "$total_loc" \
    --argjson fc "$file_count" \
    --argjson fe "$files_exist" \
    --argjson ic "$import_count" \
    --argjson snip "$snippets" \
    '{totalLoc:$loc, fileCount:$fc, filesExist:$fe, importCount:$ic, fileSnippets:$snip}'
}

# ── Confidence-weighted blending ──────────────────────────────────────────────
blend_estimates() {
  local conf="$1"
  local formula_min="$2" formula_cost="$3" formula_tok="$4" formula_turns="$5"
  local adj_min="$6"     adj_cost="$7"     adj_tok="$8"     adj_turns="$9"

  local bmin bcost btok bturns

  if (( $(echo "$conf >= $BLEND_HIGH" | bc -l) )); then
    # Trust CPA fully
    bmin="$adj_min"; bcost="$adj_cost"; btok="$adj_tok"; bturns="$adj_turns"
  elif (( $(echo "$conf >= $BLEND_LOW" | bc -l) )); then
    # Linear interpolation between CPA and formula
    local w; w=$(bc_eval "($conf - $BLEND_LOW) / ($BLEND_HIGH - $BLEND_LOW)")
    bmin=$(bc_eval  "$w * $adj_min  + (1 - $w) * $formula_min")
    bcost=$(bc_eval "$w * $adj_cost + (1 - $w) * $formula_cost")
    btok=$(echo "scale=0; ($w * $adj_tok + (1 - $w) * $formula_tok) / 1" | bc)
    bturns=$(echo "scale=0; ($w * $adj_turns + (1 - $w) * $formula_turns) / 1" | bc)
  else
    # Low confidence: keep formula + 20% uncertainty markup
    bmin=$(bc_eval  "$formula_min  * 1.20")
    bcost=$(bc_eval "$formula_cost * 1.20")
    btok=$(echo "scale=0; ($formula_tok * 1.20) / 1" | bc)
    bturns=$(echo "scale=0; ($formula_turns * 1.20) / 1" | bc)
  fi

  # Convert blended machine hours
  local mhrs; mhrs=$(bc_eval "$bmin / 60")
  mhrs=$(ensure_leading_zero "$mhrs")
  bmin=$(ensure_leading_zero "$bmin")
  bcost=$(ensure_leading_zero "$bcost")

  echo "${bmin}|${bcost}|${btok}|${bturns}|${mhrs}"
}

# ── Gate decision ─────────────────────────────────────────────────────────────
compute_gate() {
  local conf="$1"
  local flag_count="$2"
  local dep_unresolved="$3"

  local gate="pass"

  if (( $(echo "$conf < $GATE_BLOCK" | bc -l) )); then gate="block"; fi
  if [ "$dep_unresolved" -gt 0 ] && (( $(echo "$conf < 0.50" | bc -l) )); then gate="block"; fi
  if (( $(echo "$conf < $BLEND_LOW" | bc -l) )); then
    [ "$gate" != "block" ] && gate="review"
  fi
  if [ "$flag_count" -gt "$GATE_REVIEW_FLAGS" ]; then
    [ "$gate" != "block" ] && gate="review"
  fi

  echo "$gate"
}

# ── Accumulators ──────────────────────────────────────────────────────────────
JSON_RESULTS="[]"
GRAND_BLOCK=0
GRAND_REVIEW=0
GRAND_PASS=0

declare -A PHASE_PASS PHASE_REVIEW PHASE_BLOCK

echo "" >&2

# ── Main loop ─────────────────────────────────────────────────────────────────
while IFS= read -r sid; do
  [ -z "$sid" ] && continue

  info "Processing $sid..."

  # ── Extract story metadata ──────────────────────────────────────────────────
  story_json=$(jq --arg id "$sid" 'first(.stories[] | select(.id==$id))' "$PRD_FILE")
  if [ -z "${story_json:-}" ] || [ "$story_json" = "null" ]; then
    warning "  $sid: story not found in prd.json — skipping"
    continue
  fi

  s_title=$(echo "$story_json" | jq -r '.title')
  s_human_hours=$(echo "$story_json" | jq -r '.humanHours // .estimatedHours // 0')
  s_priority=$(echo "$story_json" | jq -r '.priority // "medium"')
  s_type=$(echo "$story_json" | jq -r '.storyType // "implementation"')
  s_skills=$(echo "$story_json" | jq -r '.technicalNotes.requiredSkills | join(" ")' 2>/dev/null || echo "")
  deps_json=$(echo "$story_json" | jq -c '.dependencies // []' 2>/dev/null || echo "[]")
  s_deps=$(echo "$deps_json" | jq -r 'if type=="array" then length else 0 end' 2>/dev/null || echo "0")
  s_description=$(echo "$story_json" | jq -r '.description // ""')

  # Existing formula estimates
  f_min=$(echo "$story_json" | jq -r '.estimatedAiMinutes // 0')
  f_cost=$(echo "$story_json" | jq -r '.estimatedCost // 0')
  f_tok=$(echo "$story_json" | jq -r '.estimatedTokens // 0')
  f_turns=$(echo "$story_json" | jq -r '.estimatedTurns // 1')
  f_effort=$(echo "$story_json" | jq -r '.effort // ""')

  # Infer effort from humanHours if not set
  if [ -z "$f_effort" ] || [ "$f_effort" = "null" ]; then
    f_effort=$(get_effort "$s_human_hours")
  fi

  # Phase and position
  phase="${STORY_PHASE[$sid]:-unknown}"
  position="${STORY_POSITION[$sid]:-1}"

  # Count unresolved dependencies
  dep_unresolved=0
  if [[ "$s_deps" =~ ^[0-9]+$ ]] && [ "$s_deps" -gt 0 ]; then
    dep_unresolved=$(jq --argjson deps "$deps_json" '
      if ($deps | type) != "array" then
        0
      else
        [.stories[]
          | select(.id as $did | $deps | index($did))
          | select(.completed != true)
        ] | length
      end
    ' "$PRD_FILE" 2>/dev/null || echo "0")
  fi

  # ── TF-IDF retrieval ────────────────────────────────────────────────────────
  tfidf_query="${s_title} ${s_description:0:200} ${s_skills}"
  kb_chunks="[]"

  if [ -n "$tfidf_query" ]; then
    kb_chunks=$("$NODE_CMD" "$LIB_DIR/tfidf.js" \
      --kb-dir "$KB_DIR" \
      --query "$tfidf_query" \
      --top 5 \
      --chunk-size 25 \
      --extra-docs "$EXTRA_DOCS" \
      2>/dev/null || echo "[]")
  fi

  chunk_count=$(echo "$kb_chunks" | jq 'length' 2>/dev/null || echo "0")

  # ── Codebase signals ─────────────────────────────────────────────────────────
  codebase_signals=$(compute_signals "$sid")

  # ── Adjacent stories (prev + next in phase) ───────────────────────────────────
  adjacent_json=$(jq --arg phase "$phase" --arg sid "$sid" '
    . as $root |
    (.implementationOrder[$phase] // []) as $ids |
    ($ids | index($sid)) as $pos |
    [
      if $pos > 0 then $ids[$pos-1] else null end,
      if $pos < (($ids | length) - 1) then $ids[$pos+1] else null end
    ] | map(select(. != null)) |
    map(. as $did | $root.stories[] | select(.id==$did) |
      {id, title, effort: (.effort // "medium"), status: (.status // "pending")})
  ' "$PRD_FILE" 2>/dev/null || echo "[]")

  # ── CPA inference ────────────────────────────────────────────────────────────
  formula_est_json=$(jq -n \
    --argjson min "$f_min" --argjson cost "$f_cost" \
    --argjson tok "$f_tok" --argjson turns "$f_turns" \
    '{aiMinutes: $min, cost: $cost, tokens: $tok, turns: $turns}')

  inference_input=$(jq -n \
    --argjson story "$story_json" \
    --argjson kbChunks "$kb_chunks" \
    --argjson codebaseSignals "$codebase_signals" \
    --argjson formulaEstimate "$formula_est_json" \
    --argjson adjacentStories "$adjacent_json" \
    --arg systemPrompt "$SYSTEM_PROMPT" \
    '{story: $story, kbChunks: $kbChunks, codebaseSignals: $codebaseSignals,
      formulaEstimate: $formulaEstimate, adjacentStories: $adjacentStories,
      systemPrompt: $systemPrompt}')

  t_start=$(date +%s%3N)
  cpa_raw=$(echo "$inference_input" | \
    CLAUDE_CMD="${CLAUDE_CMD:-claude}" \
    "$NODE_CMD" "$LIB_DIR/cpa-inference.js" 2>/dev/null || echo "")
  t_end=$(date +%s%3N)
  infer_ms=$(( t_end - t_start ))

  if [ -z "$cpa_raw" ]; then
    warning "  $sid: inference returned empty — using formula with 20% markup"
    cpa_raw=$(jq -n \
      --argjson fe "$formula_est_json" \
      '{confidence: 0.30, complexityAdjustment: 1.0,
        adjustedEstimate: $fe,
        riskFlags: ["CPA inference returned empty"],
        missingKbCoverage: [], citedSources: [],
        reasoning: "Inference failed — formula estimate used.",
        _metrics: {latencyMs: 0, tokensIn: 0, tokensOut: 0, tokenEfficiency: 0}}')
  fi

  # ── Parse CPA output ──────────────────────────────────────────────────────────
  confidence=$(echo "$cpa_raw" | jq -r '.confidence // 0.30')
  complexity_adj=$(echo "$cpa_raw" | jq -r '.complexityAdjustment // 1.0')
  adj_min=$(echo "$cpa_raw" | jq -r '.adjustedEstimate.aiMinutes // 0')
  adj_cost=$(echo "$cpa_raw" | jq -r '.adjustedEstimate.cost // 0')
  adj_tok=$(echo "$cpa_raw" | jq -r '.adjustedEstimate.tokens // 0')
  adj_turns=$(echo "$cpa_raw" | jq -r '.adjustedEstimate.turns // 1')
  risk_flags=$(echo "$cpa_raw" | jq -c '.riskFlags // []')
  missing_kb=$(echo "$cpa_raw" | jq -c '.missingKbCoverage // []')
  cited_sources=$(echo "$cpa_raw" | jq -c '.citedSources // []')
  reasoning=$(echo "$cpa_raw" | jq -r '.reasoning // ""')
  cpa_metrics=$(echo "$cpa_raw" | jq -c '._metrics // {latencyMs:0,tokensIn:0,tokensOut:0,tokenEfficiency:0}')

  flag_count=$(echo "$risk_flags" | jq 'length' 2>/dev/null || echo 0)
  inference_skipped=$(echo "$cpa_raw" | jq -r '._inferenceSkipped // false')
  cpa_tokens_in=$(echo "$cpa_metrics" | jq -r '.tokensIn // 0')
  cpa_tokens_out=$(echo "$cpa_metrics" | jq -r '.tokensOut // 0')
  token_eff=$(echo "$cpa_metrics" | jq -r '.tokenEfficiency // 0')

  # Ensure leading zeros for bc
  confidence=$(ensure_leading_zero "$confidence")
  adj_min=$(ensure_leading_zero "$adj_min")
  adj_cost=$(ensure_leading_zero "$adj_cost")
  f_min=$(ensure_leading_zero "$f_min")
  f_cost=$(ensure_leading_zero "$f_cost")

  # ── Citation coverage ─────────────────────────────────────────────────────────
  candidate_count="$chunk_count"
  cited_count=$(echo "$cited_sources" | jq 'length' 2>/dev/null || echo 0)
  citation_cov="0.00"
  if [ "$candidate_count" -gt 0 ]; then
    citation_cov=$(echo "scale=2; $cited_count / $candidate_count" | bc)
    citation_cov=$(ensure_leading_zero "$citation_cov")
  fi

  # ── Blending ──────────────────────────────────────────────────────────────────
  blended_data=$(blend_estimates \
    "$confidence" \
    "$f_min" "$f_cost" "$f_tok" "$f_turns" \
    "$adj_min" "$adj_cost" "$adj_tok" "$adj_turns")

  IFS='|' read -r b_min b_cost b_tok b_turns b_mhrs <<< "$blended_data"

  # ── Gate decision ─────────────────────────────────────────────────────────────
  # When inference was skipped (no API key), default to pass — don't penalise missing key
  if [ "$inference_skipped" = "true" ]; then
    gate="pass"
  else
    gate=$(compute_gate "$confidence" "$flag_count" "$dep_unresolved")
  fi

  # ── Accumulate gate totals ────────────────────────────────────────────────────
  case "$gate" in
    block)
      GRAND_BLOCK=$((GRAND_BLOCK + 1))
      PHASE_BLOCK["$phase"]=$(( ${PHASE_BLOCK["$phase"]:-0} + 1 ))
      ;;
    review)
      GRAND_REVIEW=$((GRAND_REVIEW + 1))
      PHASE_REVIEW["$phase"]=$(( ${PHASE_REVIEW["$phase"]:-0} + 1 ))
      ;;
    *)
      GRAND_PASS=$((GRAND_PASS + 1))
      PHASE_PASS["$phase"]=$(( ${PHASE_PASS["$phase"]:-0} + 1 ))
      ;;
  esac

  # ── Console output ────────────────────────────────────────────────────────────
  if [ "$JSON_MODE" != true ]; then
    gate_color="$GREEN"
    [ "$gate" = "review" ] && gate_color="$YELLOW"
    [ "$gate" = "block"  ] && gate_color="$RED"

    echo -e "${BOLD}${sid}${NC}  ${s_title}  ${gate_color}[${gate^^}]${NC}" >&2
    printf "  %-22s %8.2f min  →  %8.2f min  (conf: %.2f, adj: %.2fx)\n" \
      "Machine time:" "$f_min" "$b_min" "$confidence" "$complexity_adj" >&2
    printf "  %-22s \$%-9.2f  →  \$%-9.2f\n" "Cost:" "$f_cost" "$b_cost" >&2
    printf "  %-22s %-5d chunks retrieved   %-5d cited   cov: %.0f%%\n" \
      "KB coverage:" "$candidate_count" "$cited_count" \
      "$(echo "scale=0; $citation_cov * 100 / 1" | bc)" >&2
    if [ "$flag_count" -gt 0 ]; then
      echo "$risk_flags" | jq -r '.[]' 2>/dev/null | while IFS= read -r flag; do
        echo -e "  ${YELLOW}⚠${NC}  $flag" >&2
      done
    fi
    echo "" >&2
  fi

  # ── Build run ID ──────────────────────────────────────────────────────────────
  run_id="${RUN_ID:-$(date -Iseconds)}"

  # ── Accumulate JSON ───────────────────────────────────────────────────────────
  JSON_RESULTS=$(echo "$JSON_RESULTS" | jq \
    --arg sid "$sid" \
    --arg title "$s_title" \
    --arg phase "$phase" \
    --arg effort "$f_effort" \
    --arg gate "$gate" \
    --arg runId "$run_id" \
    --argjson confidence "$confidence" \
    --argjson complexityAdj "$complexity_adj" \
    --argjson humanHours "$s_human_hours" \
    --argjson formulaMin "$f_min" \
    --argjson formulaCost "$f_cost" \
    --argjson formulaTok "$f_tok" \
    --argjson formulaTurns "$f_turns" \
    --argjson adjMin "$adj_min" \
    --argjson adjCost "$adj_cost" \
    --argjson adjTok "$adj_tok" \
    --argjson adjTurns "$adj_turns" \
    --argjson bMin "$b_min" \
    --argjson bCost "$b_cost" \
    --argjson bTok "$b_tok" \
    --argjson bTurns "$b_turns" \
    --argjson bMhrs "$b_mhrs" \
    --argjson riskFlags "$risk_flags" \
    --argjson missingKb "$missing_kb" \
    --argjson citedSrc "$cited_sources" \
    --argjson candidateCount "$candidate_count" \
    --argjson citedCount "$cited_count" \
    --argjson citationCov "$citation_cov" \
    --arg reasoning "$reasoning" \
    --argjson tokIn "$cpa_tokens_in" \
    --argjson tokOut "$cpa_tokens_out" \
    --argjson tokEff "$token_eff" \
    --argjson latMs "$infer_ms" \
    '. + [{
      schema: "cpa-review-v1",
      runId: $runId,
      storyId: $sid,
      title: $title,
      phase: $phase,
      effort: $effort,
      reviewedAt: $runId,
      humanHours: $humanHours,
      formulaEstimate: {aiMinutes: $formulaMin, cost: $formulaCost, tokens: $formulaTok, turns: $formulaTurns},
      adjustedEstimate: {aiMinutes: $adjMin, cost: $adjCost, tokens: $adjTok, turns: $adjTurns},
      blendedEstimate: {aiMinutes: $bMin, cost: $bCost, tokens: $bTok, turns: $bTurns, machineHours: $bMhrs},
      confidence: $confidence,
      complexityAdjustment: $complexityAdj,
      gate: $gate,
      riskFlags: $riskFlags,
      missingKbCoverage: $missingKb,
      retrievedSources: ($citedSrc | if . == [] then [] else . end),
      citedSources: $citedSrc,
      reasoning: $reasoning,
      metrics: {
        latencyMs: $latMs,
        tokensIn: $tokIn,
        tokensOut: $tokOut,
        tokenEfficiency: $tokEff,
        citationCoverage: $citationCov,
        candidateSources: $candidateCount,
        citedSourceCount: $citedCount,
        retrievalAccuracy: null
      }
    }]')

done <<< "$story_ids"

# ── Summary table ─────────────────────────────────────────────────────────────
if [ "$JSON_MODE" != true ]; then
  echo -e "${CYAN}=== CPA Gate Summary ===${NC}" >&2
  echo "" >&2
  printf "%-20s %8s %8s %8s %8s\n" "Phase" "Pass" "Review" "Block" "Total" >&2
  echo "------------------------------------------------------" >&2

  for phase in $(jq -r '.implementationOrder | keys_unsorted[]' "$PRD_FILE"); do
    [ -z "$phase" ] && continue
    pp=${PHASE_PASS["$phase"]:-0}
    pr=${PHASE_REVIEW["$phase"]:-0}
    pb=${PHASE_BLOCK["$phase"]:-0}
    pt=$((pp + pr + pb))
    [ "$pt" -eq 0 ] && continue
    printf "%-20s %8d %8d %8d %8d\n" "$phase" "$pp" "$pr" "$pb" "$pt" >&2
  done

  echo "------------------------------------------------------" >&2
  total=$((GRAND_PASS + GRAND_REVIEW + GRAND_BLOCK))
  printf "${BOLD}%-20s %8d %8d %8d %8d${NC}\n" \
    "TOTAL" "$GRAND_PASS" "$GRAND_REVIEW" "$GRAND_BLOCK" "$total" >&2
  echo "" >&2

  if [ "$GRAND_BLOCK" -gt 0 ]; then
    error "$GRAND_BLOCK story/stories in BLOCK gate — resolve before orchestration"
  elif [ "$GRAND_REVIEW" -gt 0 ]; then
    warning "$GRAND_REVIEW story/stories in REVIEW gate — check risk flags"
  else
    success "All $GRAND_PASS stories passed the CPA gate"
  fi
  echo "" >&2
fi

# ── JSON output mode ──────────────────────────────────────────────────────────
if [ "$JSON_MODE" = true ]; then
  echo "$JSON_RESULTS" | jq '.'
fi

# ── Write cpa-review.jsonl ────────────────────────────────────────────────────
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$(dirname "$CPA_LOG")"
  echo "$JSON_RESULTS" | jq -c '.[]' >> "$CPA_LOG"
  log "Appended $story_count CPA records to $CPA_LOG"
fi

# ── Apply mode — write blended estimates to prd.json ─────────────────────────
if [ "$APPLY_MODE" = true ] && [ "$DRY_RUN" != true ]; then
  log "Applying blended estimates to prd.json..."
  backup="${PRD_FILE}.before-cpa"
  cp "$PRD_FILE" "$backup"
  success "Backed up prd.json → $(basename "$backup")"

  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    story_result=$(echo "$JSON_RESULTS" | jq --arg id "$sid" 'first(.[] | select(.storyId==$id))')
    if [ -z "${story_result:-}" ] || [ "$story_result" = "null" ]; then
      warning "  $sid: no CPA result found during apply — skipping"
      continue
    fi

    b_min=$(echo "$story_result"  | jq '.blendedEstimate.aiMinutes')
    b_cost=$(echo "$story_result" | jq '.blendedEstimate.cost')
    b_tok=$(echo "$story_result"  | jq '.blendedEstimate.tokens')
    b_turns=$(echo "$story_result"| jq '.blendedEstimate.turns')
    b_mhrs=$(echo "$story_result" | jq '.blendedEstimate.machineHours')
    b_eff=$(echo "$story_result"  | jq -r '.effort')
    b_conf=$(echo "$story_result" | jq '.confidence')
    b_gate=$(echo "$story_result" | jq -r '.gate')

    jq --arg id "$sid" \
       --argjson aim "$b_min" \
       --argjson cost "$b_cost" \
       --argjson tok "$b_tok" \
       --argjson turns "$b_turns" \
       --argjson mhrs "$b_mhrs" \
       --arg efr "$b_eff" \
       --argjson conf "$b_conf" \
       --arg gate "$b_gate" \
       '(.stories[] | select(.id==$id)) |=
         . + {
           estimatedAiMinutes: $aim,
           estimatedCost: $cost,
           estimatedTokens: $tok,
           estimatedTurns: $turns,
           estimatedHours: $mhrs,
           effort: $efr,
           cpaConfidence: $conf,
           cpaGate: $gate
         }' \
       "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"

  done < <(printf '%s\n' "$story_ids" | awk 'NF && !seen[$0]++')

  success "Applied CPA blended estimates to $story_count stories"
  echo "" >&2
  echo "  Review:   git diff $PRD_FILE" >&2
  echo "  Restore:  cp $backup $PRD_FILE" >&2
  echo "" >&2
elif [ "$DRY_RUN" = true ]; then
  warning "DRY RUN — no writes to prd.json or cpa-review.jsonl"
fi

# ── Exit with gate result ──────────────────────────────────────────────────────
if [ "$GRAND_BLOCK" -gt 0 ]; then
  exit 3
fi

if [ "$GRAND_REVIEW" -gt 0 ] && [ "$STRICT_MODE" = true ]; then
  exit 2
fi

exit 0
