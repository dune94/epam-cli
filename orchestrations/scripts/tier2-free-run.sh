#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 2: Free-model pipeline run — real LLM, zero OpenRouter credits.
#
# Uses OpenRouter's free-tier models (`:free` suffix) which are rate-limited
# but cost $0.  Validates real LLM integration: streaming, token handling,
# QwenProvider parsing, and actual code generation on a small model.
#
# Prerequisite: Tier 1 must pass first.
#   bash orchestrations/scripts/tier1-mock-run.sh
#
# What this tests (on top of Tier 1):
#   • Real OpenRouter API calls (auth, headers, streaming SSE)
#   • QwenProvider streaming/tool-call parsing on live responses
#   • Actual code generation (not scripted) — model must write passing TS
#   • Token accumulation stays within budget (autoCompressAt guard)
#
# Free models used (no credits consumed):
#   qwen/qwen3-coder:free  — same provider family as production Qwen3-Coder-30B
#
# Usage:
#   bash orchestrations/scripts/tier2-free-run.sh   (reads .env automatically)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
LOG_FILE="/tmp/tier2-free-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier2]${NC} $*"; }
success() { echo -e "${GREEN}[tier2] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier2] ✗${NC} $*"; exit 1; }

# Source .env if not already set
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  load_env_file_safe "$REPO_ROOT/.env"
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
fi

PRD_FILE="$REPO_ROOT/orchestrations/hello-world-prd.json"

# Free Qwen coder model — same provider as production, zero credits
FREE_MODEL="${FREE_MODEL:-qwen/qwen3-coder:free}"
# WHICH provider gets moved onto the free model. It was written into the patch program itself, so
# this launcher could only ever patch one; it is a setting now.
FREE_PROVIDER="${FREE_PROVIDER:-openrouter}"

info "Tier 2 free-model run"
info "  Model: $FREE_MODEL (zero credits)"
info "  Log:   $LOG_FILE"
echo ""

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

# Patch PRD temporarily to use free model, restore on exit
BACKUP_PRD="/tmp/hello-world-prd-backup-$(date +%s).json"
cp "$PRD_FILE" "$BACKUP_PRD"

restore_prd() {
  cp "$BACKUP_PRD" "$PRD_FILE"
  info "PRD restored from backup"
}
trap restore_prd EXIT

python3 "$SCRIPT_DIR/lib/handlers/prd-set-model-for-provider.py" "$PRD_FILE" "$FREE_PROVIDER" "$FREE_MODEL"

# THE CONTAMINATION GATE. Without it this launcher started a run on the PREVIOUS run's
# state: retry counts, ladder position, agent KB, agent-io, review feedback. `--reset`
# below is NOT this gate — it rewrites PRD story flags and clears checkpoints, nothing
# else. Six launchers gated and these did not; see lib/pre-run-reset-gate.sh.
# shellcheck source=lib/pre-run-reset-gate.sh
. "$SCRIPT_DIR/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"

OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY" \
PRD_FILE="$PRD_FILE" \
SKIP_REGRESSION_GUARD=true \
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase hello_world_test \
    --reset \
    2>&1 | tee "$LOG_FILE"

PIPELINE_EXIT=${PIPESTATUS[0]}

echo ""
info "Validating story completion..."
PASS=0; FAIL_LIST=""
for story in HW-001 HW-002 HW-003 HW-004 HW-005 HW-006; do
  status=$(python3 "$SCRIPT_DIR/lib/handlers/story-status.py" "$PRD_FILE" "$story" 2>/dev/null)
  if [ "$status" = "completed" ]; then
    success "$story: completed"
    PASS=$((PASS+1))
  else
    echo -e "${RED}[tier2] ✗${NC} $story: $status"
    FAIL_LIST="$FAIL_LIST $story"
  fi
done

echo ""
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 2 FAILED — stories not completed:$FAIL_LIST (pipeline exit: $PIPELINE_EXIT)"
fi

success "Tier 2 PASSED — all 6 stories completed with free model (zero credits spent)"
echo ""
echo "  Log: $LOG_FILE"
echo "  Next: bash orchestrations/scripts/tier3-paid-run.sh"
