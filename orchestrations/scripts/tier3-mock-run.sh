#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# tier3-mock-run.sh — the SAME real launch process every tier3-*-run.sh uses
# (pre-run-reset.sh, then run-agent-orchestration.sh with self-heal retry on
# exit 2), parameterized for a disposable mock project instead of a fixed one.
#
# Built 2026-07-23 to replace mock1/mock2's original hand-rolled `spawn()`
# invocation, which skipped pre-run-reset.sh entirely — no log archiving/
# clearing before the run, so mock and real-run data accumulated together in
# the same orchestrations/logs/ files, visible mixed together on the live
# dashboard. This wrapper is not a separate, simplified process — it is the
# exact same two-step sequence tier3-metrolinx-run.sh uses (compare its own
# run_phase() function), with only the PRD path and project root
# parameterized, since those legitimately vary per disposable test fixture.
#
# Usage:
#   bash orchestrations/scripts/tier3-mock-run.sh \
#     --prd /tmp/xyz/prd.json --project-root /tmp/xyz/clone --phase some_phase
#
# All other configuration (EPAM_BROWNFIELD, JIRA_BASELINE_BRANCH,
# AGENT_PROFILES_FILE, ORCH_GATE_PROVIDER/MODEL, EPAM_DANGEROUS_SKIP_APPROVAL,
# STORY_TIMEOUT_SECS, etc.) is inherited from the caller's environment exactly
# like every other tier3 script inherits its config from sourced .env files —
# nothing is hardcoded here that would diverge per mock scenario.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-mock]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-mock] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3-mock] ✗${NC} $*" >&2; exit 1; }

PRD_ARG=""
PROJECT_ROOT_ARG=""
PHASE_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --prd)          PRD_ARG="$2"; shift 2 ;;
    --project-root)  PROJECT_ROOT_ARG="$2"; shift 2 ;;
    --phase)        PHASE_ARG="$2"; shift 2 ;;
    *)              fail "Unknown argument: $1. Usage: --prd <path> --project-root <path> --phase <phase>" ;;
  esac
done
[ -z "$PRD_ARG" ] && fail "--prd <path> is required"
[ -z "$PROJECT_ROOT_ARG" ] && fail "--project-root <path> is required"
[ -z "$PHASE_ARG" ] && fail "--phase <phase> is required"

export PRD_FILE="$PRD_ARG"
export PROJECT_ROOT="$PROJECT_ROOT_ARG"

cd "$REPO_ROOT"

# ── Step 1: same reset every real run does — archive/clear logs, reset
# agent-status.json, wire the dashboard to serve THIS run's PRD. LOG_DIR is
# left at its default (orchestrations/logs) since run-agent-orchestration.sh's
# own LOG_DIR always resolves there regardless of PROJECT_ROOT (confirmed:
# it is not overridable) — this matches how mock data has always landed.
#
# pre-run-reset.sh requires the PRD file to already EXIST (it only reads the
# basename to patch nginx's /prd.json alias — content doesn't matter yet).
# On a real repeat run (tier3-metrolinx-run.sh) this is always true — the
# previous run's synthesized PRD is still on disk when pre-run-reset.sh
# fires, about to be overwritten by fresh Jira data at the SAME path. A
# first-time Jira-ingest run has no such file yet. Dashboards MUST show a
# real run's data — non-fatally skipping the wiring step is not acceptable
# here — so create an empty placeholder at the exact target path first: the
# real synthesized PRD lands at this same path moments later, and because
# nginx mounts the PARENT DIRECTORY (not the file itself, precisely so a
# later rename/rewrite is visible immediately — see nginx.conf), the
# dashboard picks up the real content automatically with no second wiring.
[ -f "$PRD_FILE" ] || { mkdir -p "$(dirname "$PRD_FILE")" && echo '{}' > "$PRD_FILE"; }

bash orchestrations/scripts/pre-run-reset.sh --prd "$PRD_FILE" || \
  info "  pre-run-reset.sh failed (e.g. Docker unavailable) — dashboard may show stale data (non-fatal, matching tier3-metrolinx-run.sh's own real fallback)"

LOG_FILE="/tmp/tier3-mock-run-$(date +%Y%m%dT%H%M%S)-$$.log"
info "Log: $LOG_FILE"

# ── Step 2: run_phase — copied verbatim from tier3-metrolinx-run.sh's own
# self-healing retry on exit 2 (gate remediation), not a simplified stand-in.
run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  local phase_exit=0
  bash orchestrations/scripts/run-agent-orchestration.sh \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  if [ "$phase_exit" -eq 2 ]; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    phase_exit=0
    SKIP_GATE_REMEDIATION=1 bash orchestrations/scripts/run-agent-orchestration.sh \
      --phase "$phase" \
      --reset \
      2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
    echo ""
    if [ "$phase_exit" -ne 0 ]; then
      fail "Phase '$phase' failed after self-healing retry (exit $phase_exit) — aborting"
    fi
    success "Self-healing retry succeeded for phase '$phase'"
    return 0
  fi

  if [ "$phase_exit" -ne 0 ]; then
    fail "Phase '$phase' failed (exit $phase_exit) — aborting"
  fi
}

run_phase "$PHASE_ARG"

success "tier3-mock-run.sh complete — log: $LOG_FILE"
