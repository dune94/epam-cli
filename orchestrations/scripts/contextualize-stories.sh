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
# Unconditional assignment here (no ${PROJECT_ROOT:-...} fallback) always
# overwrote the caller's real codeline path with epam-cli's own repo root —
# same bug class already fixed in team-lead-review.sh. Found live 2026-07-23
# on AMSD-1820: CPA's file-existence check (compute_signals below) looked for
# "$PROJECT_ROOT/$f" in epam-cli's own tree instead of the real Metrolinx
# codeline (/home/.../metrolinx/azure.commerce.cdts), so 3 real, verified-to-
# exist files were reported as "don't exist" and contributed to a BLOCK
# verdict on a legitimate, correctly-grounded story.
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$AUTOMATION_DIR")}"
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
CALIBRATE_MODE=false

# ── Confidence thresholds ───────────────────────────────────────────────────
BLEND_HIGH=0.75      # >= this: trust CPA fully
BLEND_LOW=0.60       # < BLEND_HIGH and >= this: interpolate (raised from 0.50 — narrows
                     #   the zone where a low LLM estimate can dominate the blend)
# < BLEND_LOW: keep formula + 20% uncertainty markup, gate=review
GATE_BLOCK=0.35      # confidence < this: gate=block
GATE_REVIEW_FLAGS=3  # riskFlags count > this: gate=review

# Floor: adjusted estimate cannot be less than this fraction of formula.
# Prevents the LLM from claiming a story costs 97% less than calibration data shows.
BLEND_ADJ_FLOOR=0.25

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --phase)   PHASE_FILTER="$2"; shift 2 ;;
    --apply)   APPLY_MODE=true;   shift ;;
    --strict)  STRICT_MODE=true;  shift ;;
    --dry-run) DRY_RUN=true;      shift ;;
    --json)    JSON_MODE=true;    shift ;;
    --reconcile) RECONCILE_MODE=true; shift ;;
    --calibrate) CALIBRATE_MODE=true; shift ;;
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

# Semantic search disabled — pipeline is MiniMax/GLM/Kimi only; no OpenAI embeddings.
# TF-IDF (tfidf.js) is used unconditionally.
SEMANTIC_SEARCH_JS="$LIB_DIR/semantic-search.js"
USE_SEMANTIC_RAG=false
info "Retrieval: TF-IDF"

# Brownfield context: optional existing-repo ingestion.
# Set via PRD .brownfield.repoRoot — absent means greenfield (no change).
BROWNFIELD_CONTEXT_JS="$LIB_DIR/brownfield-context.js"
BROWNFIELD_REPO_ROOT=$(jq -r '.brownfield.repoRoot // empty' "$PRD_FILE" 2>/dev/null || true)
if [ -n "$BROWNFIELD_REPO_ROOT" ] && [ -f "$BROWNFIELD_CONTEXT_JS" ]; then
  USE_BROWNFIELD=true
  info "Retrieval: +brownfield (git:${BROWNFIELD_REPO_ROOT})"
else
  USE_BROWNFIELD=false
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

# ── Calibrate mode ────────────────────────────────────────────────────────────
if [ "$CALIBRATE_MODE" = true ]; then
  log "Updating calibration.json from phase-cost.jsonl actuals..."
  CAL_PY="$SCRIPT_DIR/calibrate.py"
  if [ ! -f "$CAL_PY" ]; then
    error "calibrate.py not found: $CAL_PY"; exit 1
  fi
  python3 "$CAL_PY" --cost-log "$COST_LOG" --cal-file "$AUTOMATION_DIR/logs/calibration.json"
  exit $?
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

# grep -c already prints "0" on zero matches while also exiting 1 —
# `|| echo 0` would double-print ("0\n0"), garbling this log message.
story_count=$(echo "$story_ids" | { grep -c '.' || true; })
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

# ── Calibration loader ────────────────────────────────────────────────────────
# Load calibration.json once; expose lookup function.
CAL_FILE="${AUTOMATION_DIR}/logs/calibration.json"
CAL_DATA=""
CAL_MIN_N=3   # minimum samples before trusting calibration for a category
# Current invoke mode — matches invokeMode field written to phase-cost.jsonl
CAL_INVOKE_MODE="cli"
[ "${EPAM_SDK_INVOKE:-0}" = "1" ] && CAL_INVOKE_MODE="sdk"

load_calibration() {
  if [ -f "$CAL_FILE" ]; then
    CAL_DATA="$(cat "$CAL_FILE" 2>/dev/null || echo '{}')"
    # Load pipeline overhead ratio (default 1.0 = no overhead data yet)
    PIPELINE_OVERHEAD_RATIO=$(echo "$CAL_DATA" | jq -r '.pipeline_overhead_ratio // 1.0' 2>/dev/null || echo "1.0")
  else
    CAL_DATA="{}"
    PIPELINE_OVERHEAD_RATIO="1.0"
  fi
}
PIPELINE_OVERHEAD_RATIO="1.0"

# get_calibrated_baseline <effort> <storyType> [modelAlias]
# Lookup order (most specific → least specific):
#   1. effort:storyType:invokeMode:modelAlias  (model-aware — avoids Haiku/Sonnet blending)
#   2. effort:storyType:invokeMode             (mode-specific legacy)
#   3. effort:storyType                        (legacy two-part)
# Prints: "minutes|cost|tokens|turns|n|key" or empty string if not enough data.
get_calibrated_baseline() {
  local effort="$1" stype="$2" model_alias="${3:-}"
  if [ -z "$CAL_DATA" ] || [ "$CAL_DATA" = "{}" ]; then
    echo ""; return
  fi

  local key n

  # 1. Model-aware 4-part key (preferred when model is known)
  if [ -n "$model_alias" ]; then
    key="${effort}:${stype}:${CAL_INVOKE_MODE}:${model_alias}"
    n=$(echo "$CAL_DATA" | jq -r --arg k "$key" '.categories[$k].n // 0' 2>/dev/null || echo "0")
    if (( n >= CAL_MIN_N )); then
      local cm cc ct cturns
      cm=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_minutes // 0' 2>/dev/null || echo "0")
      cc=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_cost    // 0' 2>/dev/null || echo "0")
      ct=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_tokens  // 0' 2>/dev/null || echo "0")
      cturns=$(echo "$CAL_DATA"| jq -r --arg k "$key" '.categories[$k].mean_turns   // 0' 2>/dev/null || echo "0")
      echo "${cm}|${cc}|${ct}|${cturns}|${n}|${key}"; return
    fi
  fi

  # 2. Mode-specific 3-part key
  key="${effort}:${stype}:${CAL_INVOKE_MODE}"
  n=$(echo "$CAL_DATA" | jq -r --arg k "$key" '.categories[$k].n // 0' 2>/dev/null || echo "0")

  # 3. Legacy 2-part key
  if (( n < CAL_MIN_N )); then
    key="${effort}:${stype}"
    n=$(echo "$CAL_DATA" | jq -r --arg k "$key" '.categories[$k].n // 0' 2>/dev/null || echo "0")
  fi

  if (( n >= CAL_MIN_N )); then
    local cm cc ct cturns
    cm=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_minutes // 0' 2>/dev/null || echo "0")
    cc=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_cost    // 0' 2>/dev/null || echo "0")
    ct=$(echo "$CAL_DATA"    | jq -r --arg k "$key" '.categories[$k].mean_tokens  // 0' 2>/dev/null || echo "0")
    cturns=$(echo "$CAL_DATA"| jq -r --arg k "$key" '.categories[$k].mean_turns   // 0' 2>/dev/null || echo "0")
    echo "${cm}|${cc}|${ct}|${cturns}|${n}|${key}"
  else
    echo ""
  fi
}

load_calibration

# compute_escalation_profile <effort> <base_cost> <mean_tokens> <base_model>
# Returns a JSON object with expected escalation cost, self-heal cost, model
# profile per rung, and expected retries — all as probability-weighted values.
# Reads escalationRates from calibration.json and pricing from model-pricing.json.
# Falls back to conservative defaults when calibration data is absent.
compute_escalation_profile() {
  local effort="$1" base_cost="$2" mean_tokens="$3" base_model="${4:-MiniMax-M3}"
  python3 - <<PYEOF
import json, os, sys

effort      = "$effort"
base_cost   = float("$base_cost" or 0)
mean_tokens = int(float("$mean_tokens" or 0))
base_model  = "$base_model"

# ── Escalation rate priors (from calibration.json) ───────────────────────────
try:
    cal = json.load(open("$CAL_FILE"))
    r = cal.get("escalationRates", {}).get(effort, {})
except Exception:
    r = {}

p_r2       = r.get("p_rung2",  0.10)
p_r3       = r.get("p_rung3",  0.030)
p_k3       = r.get("p_k3",     0.005)
self_heal_p= r.get("selfHealP",0.25)

# ── Ladder models from env ────────────────────────────────────────────────────
rung2_model = os.environ.get("ESCALATION_MODEL",      "z-ai/glm-5.2")
rung3_model = os.environ.get("ESCALATION_MODEL_HIGH", "z-ai/glm-5.1")
gate_model  = os.environ.get("ORCH_GATE_MODEL",       "z-ai/glm-5.2")

# kimi-k3 rung: top entry in HIGH ladder (from=rung3_model)
k3_model = "moonshotai/kimi-k3"
ladder_high = os.environ.get("EPAM_MODEL_LADDER_HIGH", "")
for pair in ladder_high.split("|"):
    if "=" in pair:
        f, t = pair.split("=", 1)
        if f == rung3_model:
            k3_model = t
            break

# ── Model pricing ─────────────────────────────────────────────────────────────
try:
    pricing = json.load(open("$SCRIPT_DIR/model-pricing.json"))
except Exception:
    pricing = {}

def get_price(model):
    p = pricing.get(model, {})
    if not p:
        ml = model.lower()
        for k, v in pricing.items():
            if k.lower() == ml or k.lower() in ml or ml in k.lower():
                p = v; break
    return float(p.get("input", 0)), float(p.get("output", 0))

def rung_cost(model, tok_in, tok_out):
    inp, out = get_price(model)
    return (tok_in * inp + tok_out * out) / 1_000_000

# Token estimate: assume 80/20 in/out split
tok_in  = int(mean_tokens * 0.80) if mean_tokens > 0 else 40_000
tok_out = int(mean_tokens * 0.20) if mean_tokens > 0 else 10_000

cost_r2_attempt  = rung_cost(rung2_model, tok_in, tok_out)
cost_r3_attempt  = rung_cost(rung3_model, tok_in, tok_out)
cost_k3_attempt  = rung_cost(k3_model,    tok_in, tok_out)

# Analyst/self-heal: gate model on ~150K in / 5K out (typical failure analysis)
cost_per_heal = rung_cost(gate_model, 150_000, 5_000)

# Expected attempts per rung before escalating (empirical: ~1.5 at each mid-rung)
avg_r2 = 1.5; avg_r3 = 1.5; avg_k3 = 2.0

exp_r2_cost   = p_r2 * avg_r2 * cost_r2_attempt
exp_r3_cost   = p_r3 * avg_r3 * cost_r3_attempt
exp_k3_cost   = p_k3 * avg_k3 * cost_k3_attempt
exp_heal_cost = self_heal_p * cost_per_heal
esc_cost      = exp_r2_cost + exp_r3_cost + exp_k3_cost
exp_retries   = p_r2 * avg_r2 + p_r3 * avg_r3 + p_k3 * avg_k3

out = {
    "modelProfile": {
        "rung1": {"model": base_model,  "p_resolves": round(1 - p_r2, 3),
                  "expectedCost": round(base_cost, 4)},
        "rung2": {"model": rung2_model, "p_reached": round(p_r2, 3),
                  "costPerAttempt": round(cost_r2_attempt, 4),
                  "expectedCost":   round(exp_r2_cost, 4)},
        "rung3": {"model": rung3_model, "p_reached": round(p_r3, 3),
                  "costPerAttempt": round(cost_r3_attempt, 4),
                  "expectedCost":   round(exp_r3_cost, 4)},
        "k3":    {"model": k3_model,    "p_reached": round(p_k3, 3),
                  "costPerAttempt": round(cost_k3_attempt, 4),
                  "expectedCost":   round(exp_k3_cost, 4)}
    },
    "expectedRetries":  round(exp_retries,   2),
    "selfHealP":        round(self_heal_p,   2),
    "selfHealCost":     round(exp_heal_cost, 4),
    "escalationCost":   round(esc_cost,      4),
    "totalStoryCost":   round(base_cost + esc_cost + exp_heal_cost, 4)
}
print(json.dumps(out))
PYEOF
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

  # Apply floor: adjusted estimate can't be < BLEND_ADJ_FLOOR × formula.
  # Guards against LLM over-adjusting below what calibration data shows is realistic.
  local floor="${BLEND_ADJ_FLOOR:-0.25}"
  local adj_min_floored adj_cost_floored adj_tok_floored
  adj_min_floored=$(bc_eval  "if ($adj_min  < $formula_min  * $floor) $formula_min  * $floor else $adj_min")
  adj_cost_floored=$(bc_eval "if ($adj_cost < $formula_cost * $floor) $formula_cost * $floor else $adj_cost")
  adj_tok_floored=$(echo "scale=0; \
    if ($(echo "$adj_tok < $formula_tok * $floor" | bc -l)) \
      $formula_tok * $floor / 1 \
    else $adj_tok / 1" | bc 2>/dev/null || echo "$adj_tok")
  adj_min="$adj_min_floored"
  adj_cost="$adj_cost_floored"
  adj_tok="$adj_tok_floored"

  if (( $(echo "$conf >= $BLEND_HIGH" | bc -l) )); then
    # Trust CPA fully (floored)
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

  # Existing formula estimates (from prd.json)
  f_min=$(echo "$story_json" | jq -r '.estimatedAiMinutes // 0')
  f_cost=$(echo "$story_json" | jq -r '.estimatedCost // 0')
  f_tok=$(echo "$story_json" | jq -r '.estimatedTokens // 0')
  f_turns=$(echo "$story_json" | jq -r '.estimatedTurns // 1')
  f_effort=$(echo "$story_json" | jq -r '.effort // ""')
  # plannerModel: when set, a planning invocation runs before execution.
  # Add 15% overhead to formula estimates to account for the planning turn cost.
  f_planner_model=$(echo "$story_json" | jq -r '.plannerModel // ""')
  if [ -n "$f_planner_model" ] && [ "$f_planner_model" != "null" ]; then
    f_min=$(echo "scale=2; $f_min * 1.15" | bc 2>/dev/null || echo "$f_min")
    f_cost=$(echo "scale=4; $f_cost * 1.15" | bc 2>/dev/null || echo "$f_cost")
    f_tok=$(echo "scale=0; $f_tok * 1.15 / 1" | bc 2>/dev/null || echo "$f_tok")
    info "  $sid: plannerModel=$f_planner_model — formula estimates +15% for planning turn"
  fi

  # Infer effort from humanHours if not set
  if [ -z "$f_effort" ] || [ "$f_effort" = "null" ]; then
    f_effort=$(get_effort "$s_human_hours")
  fi

  # ── Override formula baseline with calibration actuals (when available) ──────
  # Determine the model alias that will run this story so calibration lookup
  # uses model-specific data (haiku/sonnet/opus) rather than a blended average.
  _story_model=$(echo "$story_json" | jq -r '.model // ""' 2>/dev/null || echo "")
  _model_alias=""
  if [ -n "$_story_model" ] && [ "$_story_model" != "null" ]; then
    case "$_story_model" in
      *haiku*) _model_alias="haiku" ;;
      *opus*)  _model_alias="opus"  ;;
      *sonnet*)_model_alias="sonnet";;
      # Qwen via OpenRouter — keep calibration data separate from Claude tiers
      *qwen3.7-max*)   _model_alias="qwen-max"   ;;
      *qwen3.7-plus*)  _model_alias="qwen-plus"  ;;
      *qwen3.6-flash*) _model_alias="qwen-flash" ;;
      *qwen3-coder*)   _model_alias="qwen-coder" ;;
      *qwen*)          _model_alias="qwen"       ;;
      # DeepSeek via OpenRouter — tracked separately from Qwen/Claude tiers
      *deepseek*)      _model_alias="deepseek"   ;;
      # OpenAI via OpenRouter — separate buckets per model family
      *gpt-4o-mini*)   _model_alias="gpt4omini"  ;;
      *gpt-4o*)        _model_alias="gpt4o"       ;;
      *gpt-4.1-mini*)  _model_alias="gpt4omini"  ;;
      *gpt-4.1*)       _model_alias="gpt4o"       ;;
      *openai/*)       _model_alias="openai"      ;;
    esac
  else
    # Infer from effort (mirrors claude.sh resolve_model_settings logic)
    case "$f_effort" in
      low)    _model_alias="qwen"   ;;
      high)   _model_alias="sonnet" ;;
      *)      _model_alias="sonnet" ;;
    esac
  fi
  cal_baseline=$(get_calibrated_baseline "$f_effort" "$s_type" "$_model_alias")
  f_baseline_source="prd.json"
  if [ -n "$cal_baseline" ]; then
    IFS='|' read -r cal_min cal_cost cal_tok cal_turns cal_n cal_key <<< "$cal_baseline"
    # 4-part model-aware key or 3-part mode key: always preferred over legacy 2-part
    # Legacy 2-part key: only use when prd.json is zero (different mode may have run)
    is_mode_specific=false
    [[ "$cal_key" == *":${CAL_INVOKE_MODE}"* ]] && is_mode_specific=true
    if [ "$is_mode_specific" = true ] || \
       (( $(echo "$f_min == 0" | bc -l) )) || (( $(echo "$f_tok == 0" | bc -l) )); then
      f_min="$cal_min"
      f_cost="$cal_cost"
      f_tok=$(printf "%.0f" "$cal_tok")
      f_turns=$(printf "%.0f" "$cal_turns")
      f_baseline_source="calibration[${cal_key}](n=${cal_n})"
    fi
  fi
  f_min=$(ensure_leading_zero "$f_min")
  f_cost=$(ensure_leading_zero "$f_cost")
  info "  $sid: formula baseline from ${f_baseline_source}: ${f_min}min \$${f_cost}"

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
  retrieval_query="${s_title} ${s_description:0:200} ${s_skills}"
  kb_chunks="[]"

  if [ -n "$retrieval_query" ]; then
    # TF-IDF only — OpenAI semantic search is disabled (pipeline uses MiniMax/GLM/Kimi)
    if true; then
      kb_chunks=$("$NODE_CMD" "$LIB_DIR/tfidf.js" \
        --kb-dir "$KB_DIR" \
        --query "$retrieval_query" \
        --top 5 \
        --chunk-size 25 \
        --extra-docs "$EXTRA_DOCS" \
        2>/dev/null || echo "[]")
    fi
  fi

  # ── Brownfield context merge ─────────────────────────────────────────────────
  if [ "$USE_BROWNFIELD" = true ]; then
    brownfield_chunks=$("$NODE_CMD" "$BROWNFIELD_CONTEXT_JS" \
      --repo-root "$BROWNFIELD_REPO_ROOT" \
      --query "$retrieval_query" \
      --top 3 \
      --chunk-size 25 \
      2>/dev/null || echo "[]")
    if [ -n "$brownfield_chunks" ] && [ "$brownfield_chunks" != "[]" ] && \
       echo "$brownfield_chunks" | jq -e 'type == "array"' >/dev/null 2>&1; then
      kb_chunks=$(echo "$kb_chunks $brownfield_chunks" | jq -s '.[0] + .[1]')
    fi
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
    AI_PROVIDER="${CPA_PROVIDER:-${AI_PROVIDER:-qwen}}" \
    AI_MODEL="${CPA_MODEL:-${AI_MODEL:-z-ai/glm-5.2}}" \
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

  # ── Escalation profile (probability-weighted model composition) ───────────────
  # Token basis: prefer calibrated mean_tokens; fall back to blended token estimate
  _esc_tok="${cal_tok:-${b_tok:-0}}"
  _esc_profile=$(compute_escalation_profile "$f_effort" "$b_cost" "$_esc_tok" "${_story_model:-MiniMax-M3}" 2>/dev/null || echo "{}")
  esc_cost=$(echo "$_esc_profile"    | jq -r '.escalationCost // 0')
  esc_heal_cost=$(echo "$_esc_profile" | jq -r '.selfHealCost // 0')
  esc_retries=$(echo "$_esc_profile"   | jq -r '.expectedRetries // 0')
  esc_heal_p=$(echo "$_esc_profile"    | jq -r '.selfHealP // 0')
  esc_model_profile=$(echo "$_esc_profile" | jq -c '.modelProfile // {}')
  esc_total=$(echo "$_esc_profile"     | jq -r '.totalStoryCost // 0')
  esc_cost=$(ensure_leading_zero "$esc_cost")
  esc_heal_cost=$(ensure_leading_zero "$esc_heal_cost")
  esc_total=$(ensure_leading_zero "$esc_total")

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
    printf "  %-22s \$%-9.4f  →  \$%-9.4f\n" "Cost (story):" "$f_cost" "$b_cost" >&2
    # Escalation and self-heal breakdown
    if [ "$_esc_profile" != "{}" ]; then
      _r2_p=$(echo "$_esc_profile" | jq -r '.modelProfile.rung2.p_reached // 0')
      _r2_c=$(echo "$_esc_profile" | jq -r '.modelProfile.rung2.expectedCost // 0')
      _r3_p=$(echo "$_esc_profile" | jq -r '.modelProfile.rung3.p_reached // 0')
      _r3_c=$(echo "$_esc_profile" | jq -r '.modelProfile.rung3.expectedCost // 0')
      _k3_p=$(echo "$_esc_profile" | jq -r '.modelProfile.k3.p_reached // 0')
      _k3_c=$(echo "$_esc_profile" | jq -r '.modelProfile.k3.expectedCost // 0')
      printf "  %-22s +\$%-8.4f    (r2@%.0f%%=+\$%.4f r3@%.0f%%=+\$%.4f k3@%.1f%%=+\$%.4f)\n" \
        "Escalation:" "$esc_cost" \
        "$(echo "$_r2_p * 100" | bc -l | xargs printf '%.0f')" "$_r2_c" \
        "$(echo "$_r3_p * 100" | bc -l | xargs printf '%.0f')" "$_r3_c" \
        "$(echo "$_k3_p * 100" | bc -l | xargs printf '%.1f')" "$_k3_c" >&2
      printf "  %-22s +\$%-8.4f    (p=%.0f%%)\n" \
        "Self-heal:" "$esc_heal_cost" \
        "$(echo "$esc_heal_p * 100" | bc -l | xargs printf '%.0f')" >&2
      printf "  %-22s  %-6.2f\n" "Retries (exp):" "$esc_retries" >&2
    fi
    if (( $(echo "$PIPELINE_OVERHEAD_RATIO > 1.01" | bc -l) )); then
      total_cost=$(bc_eval "($esc_total) * $PIPELINE_OVERHEAD_RATIO")
      printf "  %-22s \$%-9.4f      (story+esc+heal=\$%.4f × pipeline %.2fx)\n" \
        "Total (est):" "$total_cost" "$esc_total" "$PIPELINE_OVERHEAD_RATIO" >&2
    fi
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
    --arg por "${PIPELINE_OVERHEAD_RATIO:-1.0}" \
    --argjson escCost "$esc_cost" \
    --argjson escHealCost "$esc_heal_cost" \
    --argjson escRetries "$esc_retries" \
    --argjson escHealP "$esc_heal_p" \
    --argjson escTotal "$esc_total" \
    --argjson modelProfile "$esc_model_profile" \
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
      blendedEstimate: {
        aiMinutes: $bMin, cost: $bCost, tokens: $bTok, turns: $bTurns, machineHours: $bMhrs,
        escalationCost: $escCost,
        selfHealCost: $escHealCost,
        totalStoryCost: $escTotal,
        totalCost: ($escTotal * ($por | tonumber))
      },
      escalation: {
        modelProfile: $modelProfile,
        expectedRetries: $escRetries,
        selfHealP: $escHealP,
        selfHealCost: $escHealCost,
        escalationCost: $escCost,
        pipelineOverheadRatio: ($por | tonumber),
        totalEstimate: ($escTotal * ($por | tonumber))
      },
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

  _cpa_profiles_file="${AUTOMATION_DIR}/agents/profiles.json"
  _cpa_ai_runner_cmd="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"

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

    # Set the story's INITIAL model-escalation ladder tier from complexity
    # signals CPA just computed — fully automated, no human override, no LLM
    # call (classify_ladder_tier() in claude.sh already checks a PRD
    # .ladderTier override FIRST, before its own reactive failure-history
    # fallback; this is what populates that override, deterministically, at
    # the point complexity is first known). Reuses cpaGate/effort AS-IS
    # (already-established categorical values: gate is pass|review|block,
    # effort is low|medium|high) rather than inventing a new numeric
    # threshold on cpaConfidence.
    case "$b_gate" in
      block|review) b_ladder_tier="high" ;;
      *)
        case "$b_eff" in
          high) b_ladder_tier="high" ;;
          *)    b_ladder_tier="medium" ;;
        esac
        ;;
    esac

    _cpa_before=$(jq --arg id "$sid" '.stories[] | select(.id==$id) | {estimatedAiMinutes,estimatedCost,estimatedTokens,estimatedTurns,estimatedHours,effort,cpaConfidence,cpaGate,ladderTier}' "$backup" 2>/dev/null || echo '{}')

    jq --arg id "$sid" \
       --argjson aim "$b_min" \
       --argjson cost "$b_cost" \
       --argjson tok "$b_tok" \
       --argjson turns "$b_turns" \
       --argjson mhrs "$b_mhrs" \
       --arg efr "$b_eff" \
       --argjson conf "$b_conf" \
       --arg gate "$b_gate" \
       --arg ltier "$b_ladder_tier" \
       '(.stories[] | select(.id==$id)) |=
         . + {
           estimatedAiMinutes: $aim,
           estimatedCost: $cost,
           estimatedTokens: $tok,
           estimatedTurns: $turns,
           estimatedHours: $mhrs,
           effort: $efr,
           cpaConfidence: $conf,
           cpaGate: $gate,
           ladderTier: $ltier
         }' \
       "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"

    # Reviewer gate — validates the estimate/effort write before accepting it.
    # A bad `effort` value here silently propagates into resolve_effort_settings
    # (iteration/token budget) and prd-model-coordinator's reasoningEffort default.
    if [ -n "${ORCH_GATE_PROVIDER:-}" ] && [ -f "$_cpa_profiles_file" ]; then
      _cpa_after=$(jq --arg id "$sid" '.stories[] | select(.id==$id) | {estimatedAiMinutes,estimatedCost,estimatedTokens,estimatedTurns,estimatedHours,effort,cpaConfidence,cpaGate}' "$PRD_FILE" 2>/dev/null || echo '{}')
      _cpa_reviewer_profile=$(jq -r '."prd-change-reviewer" // ""' "$_cpa_profiles_file" 2>/dev/null || echo "")
      if [ -n "$_cpa_reviewer_profile" ]; then
        _cpa_verdict=$(echo "${_cpa_reviewer_profile}

STORY: ${sid}
CHANGE TYPE: cpa_estimate

BEFORE:
${_cpa_before}

AFTER:
${_cpa_after}

Emit ONLY: {\"verdict\":\"pass|fail\",\"issues\":[],\"reason\":\"\"}" | \
          AI_PROVIDER="${ORCH_GATE_PROVIDER}" \
          AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \
          EPAM_CLI="${EPAM_CLI:-epam}" \
          EPAM_MAX_OUTPUT_TOKENS="${CPA_GATE_MAX_OUTPUT_TOKENS:-16384}" \
          "$_cpa_ai_runner_cmd" \
              --provider "${ORCH_GATE_PROVIDER}" \
              --model    "${ORCH_GATE_MODEL:-MiniMax-M3}" \
          2>/dev/null | \
          python3 -c "
import sys, json, re
text = sys.stdin.read()
try:
    obj = json.loads(text.strip())
    print(obj.get('verdict','pass'))
    sys.exit(0)
except Exception:
    pass
m = re.search(r'\"verdict\"\s*:\s*\"(pass|fail)\"', text)
print(m.group(1) if m else 'pass')
" 2>/dev/null || echo "pass")
        if [ "$_cpa_verdict" = "fail" ]; then
          warning "  $sid: CPA estimate REJECTED by reviewer — reverting to pre-CPA values"
          jq --arg id "$sid" --argjson before "$_cpa_before" \
             '(.stories[] | select(.id==$id)) |= (. + $before)' \
             "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
        fi
      fi
    fi

  done < <(printf '%s\n' "$story_ids" | awk 'NF && !seen[$0]++')

  success "Applied CPA blended estimates to $story_count stories"
  echo "" >&2
  echo "  Review:   git diff $PRD_FILE" >&2
  echo "  Restore:  cp $backup $PRD_FILE" >&2
  echo "" >&2
elif [ "$DRY_RUN" = true ]; then
  warning "DRY RUN — no writes to prd.json or cpa-review.jsonl"
fi

# ── Auto-calibrate from actuals (non-blocking) ───────────────────────────────
# Runs silently after every CPA pass (dry-run excluded) to keep calibration.json
# up-to-date. Failures are logged but never block the pipeline.
if [ "$DRY_RUN" != true ]; then
  CAL_PY="$SCRIPT_DIR/calibrate.py"
  if [ -f "$CAL_PY" ] && [ -f "$COST_LOG" ] && [ -s "$COST_LOG" ]; then
    python3 "$CAL_PY" \
      --cost-log "$COST_LOG" \
      --cal-file "$AUTOMATION_DIR/logs/calibration.json" \
      2>/dev/null && log "Calibration updated from actuals" || \
      warning "Auto-calibration failed (non-blocking)"
  fi
fi

# ── Exit with gate result ──────────────────────────────────────────────────────
if [ "$GRAND_BLOCK" -gt 0 ]; then
  exit 3
fi

if [ "$GRAND_REVIEW" -gt 0 ] && [ "$STRICT_MODE" = true ]; then
  exit 2
fi

exit 0
