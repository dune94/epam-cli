#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#
# Only run this after BOTH Tier 1 and Tier 2 have passed cleanly.
#   bash orchestrations/scripts/tier1-mock-run.sh   # zero cost
#   bash orchestrations/scripts/tier2-free-run.sh   # zero cost
#   bash orchestrations/scripts/tier3-paid-run.sh   # ~$0.15–0.50
#
# What this validates above Tier 2:
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
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
LOG_FILE="/tmp/tier3-paid-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3]${NC} $*"; }
success() { echo -e "${GREEN}[tier3] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3] ✗${NC} $*"; exit 1; }

if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  load_env_file_safe "$REPO_ROOT/.env"
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
fi

PRD_FILE="$REPO_ROOT/orchestrations/hello-world-prd.json"

info "  Prerequisite: Tier 1 and Tier 2 must have passed"
info "  Estimated cost: \$0.15–0.50"
info "  Log: $LOG_FILE"
echo ""

read -rp "$(echo -e "${YELLOW}Confirm: spend OpenRouter credits? [yes/N]${NC} ")" confirm
[ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }

# ── Pre-flight assessment ─────────────────────────────────────────────────────
# Every launcher runs this. It was wired into two of eight, and the two being run daily
# were not among them — see lib/preflight.sh.
# shellcheck source=lib/preflight.sh
. "$SCRIPT_DIR/lib/preflight.sh"
# The run's spend figure comes from the ACTIVE SET, not a vendor hardcoded here.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/spend-probe.sh" 2>/dev/null || true

# Route through fail(), never a bare exit: fail() archives the run artefacts first.
# A bare `exit 1` here made a pre-flight abort the ONE outcome that recorded nothing —
# no run folder, no outcome.txt, no log — which is the outcome most worth keeping.
require_preflight || fail "Pre-flight assessment failed"
echo ""

cd "$REPO_ROOT"

# Record spend baseline
_usage_before="$(spend_probe_read)"
info "Usage before: \$$_usage_before"

# Clean hello-world repo state before run
HW_REPO=$(python3 -c "import json; d=json.load(open('$PRD_FILE')); print(d['project']['outputDir'])" 2>/dev/null || echo "")
if [ -n "$HW_REPO" ] && [ -d "$HW_REPO" ]; then
  info "Resetting hello-world repo (checkout + clean)..."
  git -C "$HW_REPO" checkout -- . 2>/dev/null || true
  git -C "$HW_REPO" clean -fd --quiet 2>/dev/null || true
fi

# THE CONTAMINATION GATE. Without it this launcher started a run on the PREVIOUS run's
# state: retry counts, ladder position, agent KB, agent-io, review feedback. `--reset`
# below is NOT this gate — it rewrites PRD story flags and clears checkpoints, nothing
# else. Six launchers gated and these did not; see lib/pre-run-reset-gate.sh.
# shellcheck source=lib/pre-run-reset-gate.sh
. "$SCRIPT_DIR/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"

OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY" \
OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
EPAM_API_KEY_OPENAI="${OPENAI_API_KEY:-}" \
ORCH_GATE_PROVIDER="openai" \
# ORCH_GATE_MODEL removed: a run-wide pin. The seam ladder decides.
PRD_FILE="$PRD_FILE" \
SKIP_REGRESSION_GUARD=true \
EPAM_RALPH_WIGGUM_ENABLED=0 \
EPAM_STORY_TIMEOUT_SECS=180 \
EPAM_MAX_RETRIES=1 \
SKIP_BROWSER_E2E_ROUTING=true \
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase hello_world_test \
    --reset \
    2>&1 | tee "$LOG_FILE"

PIPELINE_EXIT=${PIPESTATUS[0]}

# Report spend
_usage_after="$(spend_probe_read)"
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "Usage after: \$$_usage_after"
info "Total spent this run: \$$_spent"

echo ""
info "Validating story completion..."
PASS=0; FAIL_LIST=""
for story in HW-001 HW-002 HW-003 HW-004 HW-005 HW-006; do
  status=$(python3 "$SCRIPT_DIR/lib/handlers/story-status.py" "$PRD_FILE" "$story" 2>/dev/null)
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
