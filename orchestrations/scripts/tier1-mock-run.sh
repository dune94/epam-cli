#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 1: Mock LLM pipeline run — zero tokens, zero cost.
#
# Starts the epam-mock-llm Docker container, runs the full hello-world
# orchestration pipeline against it, then stops the container.
#
# What this tests:
#   • Pipeline routing (topology, worktrees, lanes, story ordering)
#   • Retry and verification logic (external npm test, node_modules install)
#   • Story completion tracking (--reset, .completed, .status flags)
#   • Review story sequencing (HW-003 runs after all implementation stories)
#   • PRD absolute-path resolution across worktrees
#   • All provider/tool-call plumbing without spending any API credits
#
# Usage:
#   bash orchestrations/scripts/tier1-mock-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MOCK_DIR="$REPO_ROOT/orchestrations/mock-llm"
MOCK_PORT=4000
MOCK_URL="http://localhost:${MOCK_PORT}/v1"
MOCK_CONTAINER="epam-mock-llm-run"
LOG_FILE="/tmp/tier1-mock-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()    { echo -e "${YELLOW}[tier1]${NC} $*"; }
success() { echo -e "${GREEN}[tier1] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier1] ✗${NC} $*"; exit 1; }

cleanup() {
  info "Stopping mock container..."
  docker rm -f "$MOCK_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── 1. Build / start mock server ───────────────────────────────────────────────
info "Building mock LLM image..."
docker build -q -t epam-mock-llm "$MOCK_DIR"

info "Starting mock LLM container on port $MOCK_PORT..."
docker rm -f "$MOCK_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$MOCK_CONTAINER" -p "${MOCK_PORT}:4000" epam-mock-llm >/dev/null

info "Waiting for mock server to be healthy..."
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${MOCK_PORT}/health" >/dev/null 2>&1; then
    success "Mock server ready"
    break
  fi
  [ "$i" -eq 20 ] && fail "Mock server did not start in time"
  sleep 1
done

# ── 2. Reset hello-world PRD ───────────────────────────────────────────────────
PRD_FILE="$REPO_ROOT/orchestrations/hello-world-prd.json"
info "PRD: $PRD_FILE"

# ── 3. Run the pipeline ────────────────────────────────────────────────────────
info "Launching pipeline (log: $LOG_FILE)..."
info "  OPENROUTER_BASE_URL=$MOCK_URL"
info "  OPENROUTER_API_KEY=mock-key (accepted by mock server)"

cd "$REPO_ROOT"
OPENROUTER_API_KEY="mock-key" \
OPENROUTER_BASE_URL="$MOCK_URL" \
EPAM_API_KEY_OPENROUTER="mock-key" \
PRD_FILE="$PRD_FILE" \
SKIP_REGRESSION_GUARD=true \
  bash orchestrations/scripts/run-agent-orchestration.sh \
    --phase hello_world_test \
    --reset \
    2>&1 | tee "$LOG_FILE"

PIPELINE_EXIT=${PIPESTATUS[0]}

# ── 4. Validate results ────────────────────────────────────────────────────────
echo ""
info "Validating story completion..."

PASS=0; FAIL_LIST=""
for story in HW-001 HW-002 HW-003 HW-004 HW-005 HW-006; do
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
    echo -e "${RED}[tier1] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 1 FAILED — stories not completed:$FAIL_LIST (pipeline exit: $PIPELINE_EXIT)"
fi

success "Tier 1 PASSED — all 6 stories completed (zero tokens consumed)"
echo ""
echo "  Log: $LOG_FILE"
echo "  Next: bash orchestrations/scripts/tier2-free-run.sh"
