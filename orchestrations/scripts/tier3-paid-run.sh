#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 3: Production run — Qwen3-30B on OpenRouter (costs credits).
#
# Only run this after BOTH Tier 1 and Tier 2 have passed cleanly.
#   bash orchestrations/scripts/tier1-mock-run.sh   # zero cost
#   bash orchestrations/scripts/tier2-free-run.sh   # zero cost
#   bash orchestrations/scripts/tier3-paid-run.sh   # ~$0.15–0.50
#
# What this validates above Tier 2:
#   • Production model quality (Qwen3-coder-30B)
#   • Real-world token costs within expected budget
#   • Full ACs met with the target model
#
# Estimated cost: $0.15–0.50 for hello-world (6 stories, low effort)
#
# Usage:
#   OPENROUTER_API_KEY=<your-key> bash orchestrations/scripts/tier3-paid-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/tier3-paid-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3]${NC} $*"; }
success() { echo -e "${GREEN}[tier3] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3] ✗${NC} $*"; exit 1; }

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
fi

PRD_FILE="$REPO_ROOT/orchestrations/hello-world-prd.json"

info "Tier 3 production run — Qwen3-coder-30B (USES OPENROUTER CREDITS)"
info "  Prerequisite: Tier 1 and Tier 2 must have passed"
info "  Estimated cost: \$0.15–0.50"
info "  Log: $LOG_FILE"
echo ""

read -rp "$(echo -e "${YELLOW}Confirm: spend OpenRouter credits? [yes/N]${NC} ")" confirm
[ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }

cd "$REPO_ROOT"

# Record spend baseline
_usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
info "Usage before: \$$_usage_before"

# Clean hello-world repo state before run
HW_REPO=$(python3 -c "import json; d=json.load(open('$PRD_FILE')); print(d['project']['outputDir'])" 2>/dev/null || echo "")
if [ -n "$HW_REPO" ] && [ -d "$HW_REPO" ]; then
  info "Resetting hello-world repo (checkout + clean)..."
  git -C "$HW_REPO" checkout -- . 2>/dev/null || true
  git -C "$HW_REPO" clean -fd --quiet 2>/dev/null || true
fi

OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY" \
OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
EPAM_API_KEY_OPENAI="${OPENAI_API_KEY:-}" \
ORCH_GATE_PROVIDER="openai" \
ORCH_GATE_MODEL="gpt-4o" \
PRD_FILE="$PRD_FILE" \
SKIP_REGRESSION_GUARD=true \
EPAM_RALPH_WIGGUM_ENABLED=0 \
EPAM_STORY_TIMEOUT_SECS=180 \
EPAM_MAX_RETRIES=1 \
SKIP_BROWSER_E2E_ROUTING=true \
  bash orchestrations/scripts/run-agent-orchestration.sh \
    --phase hello_world_test \
    --reset \
    2>&1 | tee "$LOG_FILE"

PIPELINE_EXIT=${PIPESTATUS[0]}

# Report spend
_usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "Usage after: \$$_usage_after"
info "Total spent this run: \$$_spent"

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
    echo -e "${RED}[tier3] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 FAILED — stories not completed:$FAIL_LIST"
fi

success "Tier 3 PASSED — full production hello-world run complete"
echo ""
echo "  Log: $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
