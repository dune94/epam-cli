#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 1 (Ollama): Real-model pipeline validation — zero paid credits.
#
# Uses local Ollama (qwen2.5:1.5b) as the LLM backend. Unlike the Docker mock
# server, Ollama actually generates responses — so it exercises error recovery,
# RalphWiggumLoop, retry paths, and tool-call parsing in a way the mock cannot.
#
# RalphWiggumLoop is NOT disabled here (unlike tier3). If the model fails,
# the recovery loop fires — that's the whole point: validate the recovery path
# without spending OpenRouter credits.
#
# What this validates beyond the mock:
#   • QwenProvider model-name override (EPAM_QWEN_MODEL_OVERRIDE=qwen2.5:1.5b)
#   • Tool-call parsing with real Ollama streaming responses
#   • RalphWiggumLoop fires and recovers when model writes bad code
#   • AgentRunner handles slow responses (Ollama ~2–5 tok/s on quiet machine)
#
# Expected runtime: 10–60 min depending on machine load
#
# Usage:
#   bash orchestrations/scripts/tier1-ollama-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OLLAMA_URL="http://127.0.0.1:11434/v1"
OLLAMA_MODEL="qwen2.5:1.5b"
LOG_FILE="/tmp/tier1-ollama-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()    { echo -e "${YELLOW}[tier1-ollama]${NC} $*"; }
success() { echo -e "${GREEN}[tier1-ollama] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier1-ollama] ✗${NC} $*"; exit 1; }

# ── 1. Preflight: Ollama running? ─────────────────────────────────────────────
info "Checking Ollama server at $OLLAMA_URL..."
if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  fail "Ollama not running. Start with: ollama serve"
fi

# Check model is available
if ! curl -sf "http://127.0.0.1:11434/api/tags" | python3 "$SCRIPT_DIR/lib/handlers/ollama-model-present.py" "$OLLAMA_MODEL" 2>&1; then
  info "Pulling $OLLAMA_MODEL (this may take a minute)..."
  ~/.local/bin/ollama pull "$OLLAMA_MODEL" || fail "Failed to pull $OLLAMA_MODEL"
fi
success "Ollama ready with model $OLLAMA_MODEL"

# ── 2. Build epam dist ────────────────────────────────────────────────────────
info "Building epam CLI..."
# ── Pre-flight assessment ─────────────────────────────────────────────────────
# Every launcher runs this. It was wired into two of eight, and the two being run daily
# were not among them — see lib/preflight.sh.
# shellcheck source=lib/preflight.sh
. "$SCRIPT_DIR/lib/preflight.sh"
# Route through fail(), never a bare exit: fail() archives the run artefacts first.
# A bare `exit 1` here made a pre-flight abort the ONE outcome that recorded nothing —
# no run folder, no outcome.txt, no log — which is the outcome most worth keeping.
require_preflight || fail "Pre-flight assessment failed"
echo ""

cd "$REPO_ROOT"
~/.local/share/fnm/node-versions/v24.14.1/installation/bin/node \
  ./node_modules/.bin/tsup 2>&1 | grep -E "success|error|warn|ERR" || true
success "dist built"

# ── 3. Reset hello-world repo ─────────────────────────────────────────────────
PRD_FILE="$REPO_ROOT/orchestrations/hello-world-prd.json"
HW_REPO="/home/bradleyjerome/projects/ai/epam-test-apps/hello-world"

info "Resetting hello-world repo to fixture-v1..."
git -C "$HW_REPO" reset --hard fixture-v1 2>/dev/null || \
  git -C "$HW_REPO" checkout -- . 2>/dev/null || true
git -C "$HW_REPO" clean -fd --quiet 2>/dev/null || true
success "hello-world reset to fixture-v1"

# ── 4. Run the pipeline ────────────────────────────────────────────────────────
info "Launching pipeline (log: $LOG_FILE)"
info "  OPENROUTER_BASE_URL=$OLLAMA_URL"
info "  EPAM_QWEN_MODEL_OVERRIDE=$OLLAMA_MODEL"
info "  RalphWiggumLoop: ENABLED (1 agent, 5-min timeout)"
info "  Expected runtime: 10–60 min on busy machine"
echo ""

OPENROUTER_API_KEY="ollama" \
OPENROUTER_BASE_URL="$OLLAMA_URL" \
EPAM_API_KEY_OPENROUTER="ollama" \
EPAM_QWEN_MODEL_OVERRIDE="$OLLAMA_MODEL" \
PRD_FILE="$PRD_FILE" \
SKIP_REGRESSION_GUARD=true \
SKIP_CPA=1 \
EPAM_SPEC_MODE=0 \
SKIP_TESTING_GATES=true \
SKIP_SKILL_ASSESSMENT=1 \
EPAM_RALPH_WIGGUM_AGENTS=1 \
EPAM_RALPH_WIGGUM_TIMEOUT_MS=300000 \
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase hello_world_test \
    --reset \
    2>&1 | tee "$LOG_FILE"

PIPELINE_EXIT=${PIPESTATUS[0]}

# ── 5. Validate results ────────────────────────────────────────────────────────
echo ""
info "Validating story completion..."

PASS=0; FAIL_LIST=""
for story in HW-001 HW-002 HW-003 HW-004 HW-005 HW-006; do
  status=$(python3 "$SCRIPT_DIR/lib/handlers/story-status.py" "$PRD_FILE" "$story" 2>/dev/null)
  if [ "$status" = "completed" ]; then
    success "$story: completed"
    PASS=$((PASS+1))
  else
    echo -e "${RED}[tier1-ollama] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 1 Ollama FAILED — stories not completed:$FAIL_LIST (pipeline exit: $PIPELINE_EXIT)"
fi

success "Tier 1 Ollama PASSED — all 6 stories completed (zero paid credits)"
echo ""
echo "  Model: $OLLAMA_MODEL (local)"
echo "  Log:   $LOG_FILE"
echo "  Next:  bash orchestrations/scripts/tier3-paid-run.sh  (Ralph now disabled in tier3)"
