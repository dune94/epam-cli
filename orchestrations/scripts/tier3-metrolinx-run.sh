#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 3: Metrolinx Brownfield — GLM + Kimi multi-model pipeline.
#
# Brownfield mode: EPAM_BROWNFIELD=1. The existing codeline at
# JIRA_CODELINE_ROOT is discovered at runtime by codeline-discovery.js and
# modified in-place — no teardown, no git init, no scaffold phase.
#
# Phases:
#   core only (scaffold is a no-op for brownfield)
#
# Model assignment:
#   Story agents : MiniMax-M3 (direct) and moonshotai/kimi-k2 (OpenRouter)
#   Gates/analyst: z-ai/glm-5.2
#   Retry ladder : glm-5.2 → glm-5.1 → kimi-k2 (HIGH ceiling)
#
# Prerequisites:
#   - MINIMAX_API_KEY set (MiniMax-M3 story agents)
#   - OPENROUTER_API_KEY set (Kimi K2, GLM-Z1 via OpenRouter)
#   - JIRA_TOKEN set (Metrolinx Atlassian API token)
#
# Usage:
#   source .env && bash orchestrations/scripts/tier3-metrolinx-run.sh [--yes]
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# setsid process-group isolation — same pattern as tier3-skyscanner-app-run.sh.
# Ensures kill-tier3-run.sh can kill the entire tree with one signal regardless
# of how deep subprocesses nest (run-agent-orchestration.sh, ai-run.sh, etc.).
if [ -z "${TIER3_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export TIER3_SETSID_DONE=1
  exec setsid bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/tier3-metrolinx-jira-$(date +%Y%m%dT%H%M%S)-$$.log"

TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-metrolinx-run.pid}"
echo "$$" > "$TIER3_PID_FILE"
trap 'rm -f "$TIER3_PID_FILE"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-metrolinx]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-metrolinx] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3-metrolinx] ✗${NC} $*"; exit 1; }

# ── Load .env then metrolinx project env ─────────────────────────────────────
[ -f "$REPO_ROOT/.env" ] && { set -a; source "$REPO_ROOT/.env"; set +a; }
ENV_FILE="$SCRIPT_DIR/../jira/metrolinx.env"
[ -f "$ENV_FILE" ] && { set -a; source "$ENV_FILE"; set +a; } || fail "metrolinx.env not found at $ENV_FILE"
# Project-level config (pipeline flags, semble, AC gate settings)
PROJECT_CONFIG="$SCRIPT_DIR/../projects/metrolinx/config.env"
[ -f "$PROJECT_CONFIG" ] && { set -a; source "$PROJECT_CONFIG"; set +a; }

# Project-level tool config (dependency-check.json, etc.) — lives in epam-cli's
# own codeline, never in a client repo. See run_dependency_check in claude.sh.
export EPAM_PROJECT_CONFIG_DIR="$SCRIPT_DIR/../projects/metrolinx"

# ── Required key checks ───────────────────────────────────────────────────────
[ -z "${MINIMAX_API_KEY:-}" ]    && fail "MINIMAX_API_KEY is not set. Export it or add it to .env"
[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
[ -z "${JIRA_TOKEN:-}" ]         && fail "JIRA_TOKEN is not set. Export it before launching."

# ── Auto-confirm ──────────────────────────────────────────────────────────────
AUTO_YES=false
for arg in "$@"; do [[ "$arg" == "--yes" || "$arg" == "-y" ]] && AUTO_YES=true; done
[[ "${CI:-}" == "true" || "${AUTO_YES_TIER3:-}" == "1" ]] && AUTO_YES=true
[[ ! -t 0 ]] && AUTO_YES=true

# PRD_FILE: written by the Jira ingest step at runtime.
# PER-PROJECT. All three tier3 runners previously pointed here at
# orchestrations/travel-app-prd.json, so a metrolinx run's Jira ingest overwrote
# the travel-app PRD outright (4 SKY stories -> 1 AMSD story, 2026-07-25). The
# path now derives from the project identity that already exists a few lines up.
PRD_FILE="${EPAM_PROJECT_CONFIG_DIR:-$REPO_ROOT/orchestrations/projects/metrolinx}/prd.json"

info "Tier 3 Metrolinx brownfield run — GLM + Kimi multi-model pipeline (USES CREDITS)"
info "  Jira:    ${JIRA_URL} / project ${JIRA_PROJECT_KEY}"
info "  Codeline root: ${JIRA_CODELINE_ROOT}"
info "  Baseline: ${JIRA_BASELINE_BRANCH}"
info "  Mode:    BROWNFIELD (existing codeline, no teardown)"
info "  Log:     $LOG_FILE"
echo ""

if [ "$AUTO_YES" = true ]; then
  info "Auto-confirmed (--yes flag)"
else
  read -rp "$(echo -e "${YELLOW}Confirm: spend MiniMax + OpenRouter credits for Metrolinx? [yes/N]${NC} ")" confirm
  [ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }
fi

cd "$REPO_ROOT"

# ── Capture spend baseline ────────────────────────────────────────────────────
_usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
info "OpenRouter usage before: \$$_usage_before"
echo ""

# ── Export all env vars so subprocesses inherit them ─────────────────────────
export MINIMAX_API_KEY
export EPAM_API_KEY_MINIMAX="$MINIMAX_API_KEY"
export OPENROUTER_API_KEY
export EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY"
export JIRA_TOKEN
export EPAM_BROWNFIELD=1
export JIRA_PIPELINE=1
export JIRA_URL JIRA_EMAIL JIRA_PROJECT_KEY JIRA_BOARD_ID
export JIRA_CODELINE_ROOT JIRA_BASELINE_BRANCH

# Model config (sourced from metrolinx.env; re-export to ensure inheritance)
export ORCH_GATE_PROVIDER EPAM_ORCHESTRATION_PROVIDER ORCH_GATE_MODEL
export ESCALATION_MODEL ESCALATION_MODEL_HIGH
export EPAM_TEMPERATURE
export SPEC_MODE_PROVIDER SPEC_MODE_OPENSPEC_MODEL SPEC_MODE_OPENSPEC_MODEL_HIGH
export SPEC_MODE_SPECKIT_MODEL SPEC_MODE_SPECKIT_MODEL_HIGH SPEC_MODE_MODEL
export SPEC_PASS_BLOCK_ON_TIMEOUT RUNCLAUDE_TIMEOUT_MS SPEC_MODE_MAX_OUTPUT_TOKENS
export SPEC_AGENT_MAX_RETRIES
export EPAM_MODEL_LADDER_MEDIUM EPAM_MODEL_LADDER_HIGH EPAM_MODEL_LADDER
export EPAM_FINAL_FALLBACK_MODEL EPAM_FINAL_FALLBACK_PROVIDER
export EPAM_MODEL_PROVIDER_MAP
export MINIMAX_TOOL_TIMEOUT_MS ORCH_MINI_MODEL ORCH_UPGRADE_MODEL
export EPAM_RETRY_EXTENSION_ENABLED EPAM_RETRY_EXTENSION_MAX
export SKIP_REGRESSION_GUARD EPAM_RALPH_WIGGUM_ENABLED
export EPAM_STORY_TIMEOUT_SECS EPAM_GATE_TIMEOUT_SECS EPAM_MAX_RETRIES
export SKIP_BROWSER_E2E_ROUTING
export PRD_FILE
export AC_GATE_AUTO_ELABORATE
export SEMBLE_ENABLED
export CODEGRAPH_ENABLED

PIPELINE_EXIT=0

# ── Restore profiles.json from canonical original ─────────────────────────────
# Agent mutations (profile-augmentor additions) must not carry forward across runs.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$REPO_ROOT/orchestrations/agents/profiles.json"
  info "profiles.json restored from canonical original"
else
  info "profiles.json.original not found — skipping profiles restore"
fi
echo ""

# ── Predictable teardown to pre-run state (standing mandate, not new) ────────
# A run may be repeated 200+ times until it succeeds. Any commit made during
# a previous run that got KILLED before its own gate-failure self-heal could
# run (reset_brownfield_story_commit in story-guards.sh, the in-run half of
# this mandate) may still be sitting on a codeline as unverified work. Reset
# every codeline under JIRA_CODELINE_ROOT to its last verified-gate-passed
# baseline before codeline discovery even runs — codeline-discovery.js picks
# the target dynamically, so every candidate must already be clean rather
# than trying to reset just the one that ends up selected. Cheap: a no-op
# for any codeline with no marker yet (nothing known-good to reset to) or
# already at its verified baseline.
info "Predictable teardown: resetting codelines to last verified baseline..."
for _cl_dir in "$JIRA_CODELINE_ROOT"/*/; do
  [ -d "${_cl_dir}.git" ] || continue
  bash "$SCRIPT_DIR/brownfield-preflight-reset.sh" "${_cl_dir%/}" || true
done
echo ""

# ── Wire the dashboard to this run's live PRD + logs ─────────────────────────
# MUST run BEFORE CodeGraph preflight below: pre-run-reset.sh resets
# agent-status.json. Emitting preflight events before that reset would have
# them wiped a moment later, before the dashboard ever showed them.
info "Wiring dashboard to serve this run's live PRD + logs..."
bash orchestrations/scripts/pre-run-reset.sh --prd "$PRD_FILE" || \
  info "  pre-run-reset.sh failed or Docker unavailable — dashboard may show stale data (non-fatal, continuing)"
echo "${OUTPUT_DIR:-$JIRA_CODELINE_ROOT}" > "orchestrations/dashboards/.active-output-dir" 2>/dev/null || true
echo ""

# ── CodeGraph preflight: every codeline must be indexed before codeline ──────
# discovery scoring ever runs — abort the launch otherwise. MUST run AFTER
# both the teardown loop (indexing a pre-reset tree would build an index that
# no longer matches the post-reset files) and the dashboard-wiring step above
# (so its agent-activity events land in the freshly-reset agent-status.json,
# not one about to be wiped). Live bug (2026-07-22): codeline-discovery's
# scoring gave a repo missing its CodeGraph index a score of zero on that
# tier regardless of true relevance — azure.commerce.cdts (the actual
# AMSD-1820 fix site) was never indexed, never made the top-8 candidates
# handed to the LLM, and the wrong repo got selected instead. Silently
# indexing on-demand mid-scoring (also fixed, in codeline-discovery.js, as
# defense in depth) is not enough alone — a failure there is swallowed and
# scoring continues anyway. This gate fails loud, before any Jira/spec work
# starts, if indexing cannot be completed for any candidate codeline — and
# emits its own progress to agent-activity so it's visible on the dashboard,
# not just buried in a log file.
info "CodeGraph preflight: verifying every codeline is indexed..."
_emit_preflight_event() {
  local msg="$1"
  local monitor_file="${MONITOR_FILE:-orchestrations/logs/agent-status.json}"
  [ -f "$monitor_file" ] || return 0
  local tmp_file="${monitor_file}.tmp.$$"
  (
    flock -w 5 200 || return 1
    jq --arg type "preflight" \
       --arg msg "$msg" \
       --arg ts "$(date -Iseconds)" \
       '.events += [{"type": $type, "story": "", "lane": "preflight", "role": "codegraph-preflight", "message": $msg, "timestamp": $ts}]' \
       "$monitor_file" > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$monitor_file"
  ) 200>"${monitor_file}.lock"
}
_emit_preflight_event "CodeGraph preflight started — verifying every codeline under $JIRA_CODELINE_ROOT is indexed"
if bash "$SCRIPT_DIR/codegraph-preflight-index.sh" "$JIRA_CODELINE_ROOT" 2>&1 | tee /tmp/codegraph-preflight-$$.log; then
  _emit_preflight_event "CodeGraph preflight passed — all codelines indexed, safe to proceed to codeline discovery"
else
  _preflight_summary=$(tail -5 /tmp/codegraph-preflight-$$.log | tr '\n' ' ')
  _emit_preflight_event "CodeGraph preflight FAILED — aborting before codeline discovery: ${_preflight_summary}"
  rm -f /tmp/codegraph-preflight-$$.log
  fail "CodeGraph preflight failed — one or more codelines could not be indexed. Aborting before codeline discovery ever runs."
fi
rm -f /tmp/codegraph-preflight-$$.log
echo ""

# ── run_phase: invoke orch script with self-healing retry on exit 2 ───────────
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
      fail "Phase '$phase' failed after self-healing retry (exit $phase_exit) — aborting pipeline"
    fi
    success "Self-healing retry succeeded for phase '$phase'"
    return 0
  fi

  if [ "$phase_exit" -ne 0 ]; then
    fail "Phase '$phase' failed (exit $phase_exit) — aborting pipeline"
  fi
}

# Brownfield: no scaffold phase. Jira ingest + codeline discovery happen inside
# the orch script at the start of the core phase (JIRA_PIPELINE=1 path).
run_phase "core"

# ── Report spend ──────────────────────────────────────────────────────────────
_usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "OpenRouter usage after: \$$_usage_after"
info "Total spent this run:   \$$_spent"
echo ""

# ── Validate story completion from dynamically-generated PRD ──────────────────
if [ -f "$PRD_FILE" ]; then
  info "Validating story completion..."
  PASS=0; FAIL_LIST=""
  while IFS= read -r story; do
    [ -z "$story" ] && continue
    status=$(python3 -c "
import json
with open('$PRD_FILE') as f:
  d = json.load(f)
for s in d['stories']:
  if s['id'] == '$story':
    print(s.get('status','unknown'))
    break
else:
  print('not_found')
" 2>/dev/null)
    if [ "$status" = "completed" ]; then
      success "$story: completed"
      PASS=$((PASS+1))
    else
      echo -e "${RED}[tier3-metrolinx] ✗${NC} $story: $status"
      FAIL_LIST="$FAIL_LIST $story"
    fi
  done < <(python3 -c "
import json
with open('$PRD_FILE') as f:
  d = json.load(f)
seen = set()
for ids in d.get('implementationOrder', {}).values():
  for i in ids:
    if i not in seen:
      print(i)
      seen.add(i)
" 2>/dev/null)
  echo ""
fi

if [ -n "${FAIL_LIST:-}" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 Metrolinx FAILED — stories not completed:${FAIL_LIST:-}"
fi

success "Tier 3 Metrolinx PASSED — all ${PASS:-0} stories complete"
echo ""
echo "  Codeline: $JIRA_CODELINE_ROOT"
echo "  Log:      $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
