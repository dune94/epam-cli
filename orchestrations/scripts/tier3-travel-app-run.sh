#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 3: Travel App (Skyscanner) — DeepSeek V3 story agents + GPT-4o gates.
#
# Runs all three phases in sequence:
#   scaffold → core → ui_and_review
#
# Prerequisites:
#   - OPENROUTER_API_KEY set (DeepSeek V3 story agents)
#   - OPENAI_API_KEY set (GPT-4o coordinator + gates)
#   - RAPIDAPI_KEY set (SKY-001b API contract discovery)
#
# Estimated cost: $0.05–0.15 (11 stories, all low effort, DeepSeek pricing)
#
# Usage:
#   OPENROUTER_API_KEY=<key> OPENAI_API_KEY=<key> bash orchestrations/scripts/tier3-travel-app-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/tier3-travel-app-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-travel]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-travel] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3-travel] ✗${NC} $*"; exit 1; }

# Load .env if keys not already in environment
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
[ -z "${OPENAI_API_KEY:-}" ]     && fail "OPENAI_API_KEY is not set (needed for GPT-4o gates)"

# Auto-confirm when: --yes/-y flag, CI env var set, or no TTY (non-interactive shell)
AUTO_YES=false
for arg in "$@"; do [[ "$arg" == "--yes" || "$arg" == "-y" ]] && AUTO_YES=true; done
[[ "${CI:-}" == "true" || "${AUTO_YES_TIER3:-}" == "1" ]] && AUTO_YES=true
[[ ! -t 0 ]] && AUTO_YES=true

PRD_FILE="$REPO_ROOT/orchestrations/travel-app-prd.json"
OUTPUT_DIR="/tmp/skyscanner-app"

info "Tier 3 travel app run — DeepSeek V3 agents + GPT-4o gates (USES CREDITS)"
info "  PRD: $PRD_FILE"
info "  Output: $OUTPUT_DIR"
info "  Estimated cost: \$0.05–0.15"
info "  Log: $LOG_FILE"
echo ""

if [ "$AUTO_YES" = true ]; then
  info "Auto-confirmed (--yes flag)"
else
  read -rp "$(echo -e "${YELLOW}Confirm: spend OpenRouter + OpenAI credits? [yes/N]${NC} ")" confirm
  [ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }
fi

cd "$REPO_ROOT"

# Capture spend baseline
_usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
info "OpenRouter usage before: \$$_usage_before"
echo ""

# Clean output directory to prevent leftover artifacts from prior runs poisoning
# external verification (e.g. stale test files causing npm test to fail)
if [ -d "$OUTPUT_DIR" ]; then
  info "Cleaning output directory: $OUTPUT_DIR"
  rm -rf "$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"

# Export all required env vars directly so subprocesses inherit them without
# an `env` wrapper array (which caused silent exit due to empty-var expansion).
export OUTPUT_DIR
export PROJECT_ROOT="$OUTPUT_DIR"
export OPENROUTER_API_KEY
export EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY"
export OPENAI_API_KEY
export EPAM_API_KEY_OPENAI="$OPENAI_API_KEY"
export ORCH_GATE_PROVIDER="minimax"
export EPAM_ORCHESTRATION_PROVIDER="minimax"
export ORCH_GATE_MODEL="MiniMax-M3"
export ORCH_MINI_MODEL="${ORCH_MINI_MODEL:-MiniMax-M2.5}"
export ORCH_UPGRADE_MODEL="${ORCH_UPGRADE_MODEL:-MiniMax-M3}"
export EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-anthropic/claude-sonnet-4-6}"
export EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-qwen}"
export PRD_FILE
export SKIP_REGRESSION_GUARD=true
export EPAM_RALPH_WIGGUM_ENABLED=0
export EPAM_STORY_TIMEOUT_SECS=600
export EPAM_MAX_RETRIES=1
export SKIP_BROWSER_E2E_ROUTING=true
[ -n "${RAPIDAPI_KEY:-}" ] && export RAPIDAPI_KEY

PIPELINE_EXIT=0

# ── Pre-flight validation ─────────────────────────────────────────────────────
if ! bash orchestrations/scripts/preflight-check.sh \
     --runner tier3-travel-app-run.sh \
     --prd "$PRD_FILE"; then
  fail "Pre-flight checks failed — aborting run. Fix issues above first."
  exit 1
fi
echo ""

run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"
  local phase_exit=0
  bash orchestrations/scripts/run-agent-orchestration.sh \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""
  if [ "$phase_exit" -ne 0 ]; then
    fail "Phase '$phase' failed (exit $phase_exit) — aborting pipeline"
  fi
}

run_phase "scaffold"
run_phase "core"
run_phase "ui_and_review"

# Report spend
_usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "OpenRouter usage after: \$$_usage_after"
info "Total spent this run: \$$_spent"
echo ""

# Validate all 11 stories
info "Validating story completion..."
PASS=0; FAIL_LIST=""
for story in SKY-001 SKY-001b SKY-002 SKY-003 SKY-004 SKY-005 SKY-006 SKY-003a SKY-003b SKY-004-A SKY-004-B; do
  status=$(python3 -c "
import json, sys
with open('$PRD_FILE') as f:
  d = json.load(f)
for s in d['stories']:
  if s['id'] == '$story':
    print(s.get('status','unknown'))
    sys.exit(0)
print('not_found')
" 2>/dev/null)
  if [ "$status" = "completed" ]; then
    success "$story: completed"
    PASS=$((PASS+1))
  else
    echo -e "${RED}[tier3-travel] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 travel app FAILED — stories not completed:$FAIL_LIST"
fi

success "Tier 3 travel app PASSED — all $PASS/11 stories complete"
echo ""
echo "  App built at: $OUTPUT_DIR"
echo "  Log: $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
