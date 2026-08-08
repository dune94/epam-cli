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

# ── setsid process-group isolation — identical to the real launcher ──────────
# Without this, kill-tier3-run.sh cannot stop the tree with one signal and a
# hand `pkill` leaves the orchestration running and still billing (observed
# live 2026-08-03 when a mock run was cancelled: the vitest wrapper died, the
# detached pipeline kept spawning agent calls).
if [ -z "${TIER3_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export TIER3_SETSID_DONE=1
  exec setsid bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# One identifier for the whole run, so the run folder, traces and archive agree.
export ORCH_RUN_ID="${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

# PID file so the TESTED killer can find this run (kill-tier3-run.sh collects
# every /tmp/tier3-*.pid). A mock that cannot be stopped the same way as a real
# run is not a rehearsal of one.
TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-mock-run.pid}"
echo "$$" > "$TIER3_PID_FILE"
trap 'rm -f "$TIER3_PID_FILE"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-mock]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-mock] ✓${NC} $*"; }
# fail() archives BEFORE exiting — mirroring the real launcher. Previously the
# archive call sat after run_phase, which fail() can never reach because it exits
# directly: a FAILED run, the one whose evidence matters most, was archived not at
# all. Proven by a dry run that failed and produced no runs/ directory, while a
# static parity check reported the capability present. Guarded because fail() also
# fires during argument parsing, before these are defined.
fail()    {
  echo -e "${RED}[tier3-mock] ✗${NC} $*" >&2
  if declare -F _archive_run_artifacts >/dev/null 2>&1; then
    _archive_run_artifacts "FAILED: $*" || true
  fi
  exit 1
}

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

LOG_FILE="/tmp/tier3-mock-run-$(date +%Y%m%dT%H%M%S)-$$.log"

# ── Project config dir — the gateway the mock previously never opened ────────
# EPAM_PROJECT_CONFIG_DIR is what makes run-agent-orchestration.sh provision
# .epam/settings.json (plugins), .epam/codeline-facts.json, .env.local and load
# llm-settings.json. Without it a mock cannot exercise plugin provisioning,
# project-tool advertisement, or per-model iteration budgets AT ALL — every one
# of which is real pipeline behaviour a real run depends on. Points at the
# MOCK's own project dir, never a client's.
export EPAM_PROJECT_CONFIG_DIR="${EPAM_PROJECT_CONFIG_DIR:-$REPO_ROOT/orchestrations/projects/hello-dolly}"
info "Project config: $EPAM_PROJECT_CONFIG_DIR"

# ── THE TEST PERIMETER ───────────────────────────────────────────────────────
#
# A test run and a client run must not share a single byte of state. They did:
# orchestrations/logs/lanes/ held mock-a and mock-b beside gotransit and metrolinx, this
# launcher overwrote the repo's own agents/profiles.json on every mock run, and a stale
# roster-review.json from a client run was read mid-test and nearly reported as current.
#
# The comment that justified it was simply wrong. It claimed run-agent-orchestration.sh's
# LOG_DIR "is not overridable"; line 221 of that script reads
#     LOG_DIR="${LOG_DIR:-$AUTOMATION_DIR/logs}"
# which honours an inherited value. Test artefacts were landing in client space on a false
# premise, and archive/reset then swept client evidence on a test run's schedule.
#
# INSIDE the perimeter (a test run owns these, and nothing else):
#     EPAM_TEST_PERIMETER=1 with LOG_DIR, EPAM_AGENTS_DIR and EPAM_PROJECT_CONFIG_DIR
#     all pointed at a disposable root, plus its own codelines under JIRA_CODELINE_ROOT.
# OUTSIDE it (never written by a test run):
#     orchestrations/logs/**, orchestrations/agents/**, orchestrations/projects/<client>/**
#     and any real codeline.
#
# Both defaults are unchanged when the variables are unset, so a real run behaves exactly as
# before and only an opted-in test run is redirected.
MOCK_LOG_DIR="${LOG_DIR:-$REPO_ROOT/orchestrations/logs}"
MOCK_AGENTS_DIR="${EPAM_AGENTS_DIR:-$REPO_ROOT/orchestrations/agents}"
export LOG_DIR="$MOCK_LOG_DIR"
if [ "${EPAM_TEST_PERIMETER:-0}" = "1" ]; then
  case "$MOCK_LOG_DIR" in
    "$REPO_ROOT/orchestrations/logs"*)
      fail "EPAM_TEST_PERIMETER=1 but LOG_DIR is inside the shared log directory ($MOCK_LOG_DIR). A test run must own its own artefacts." ;;
  esac
  case "$MOCK_AGENTS_DIR" in
    "$REPO_ROOT/orchestrations/agents"*)
      fail "EPAM_TEST_PERIMETER=1 but EPAM_AGENTS_DIR is the shared agents directory ($MOCK_AGENTS_DIR). A test run must not mutate the live roster." ;;
  esac
  mkdir -p "$MOCK_LOG_DIR" "$MOCK_AGENTS_DIR"
  info "test perimeter: logs=$MOCK_LOG_DIR agents=$MOCK_AGENTS_DIR"
fi

# ── Run artefacts, on EVERY outcome ─────────────────────────────────────────
# A failed run is the one whose evidence is most perishable. Never allowed to
# change the run's outcome: `|| true` throughout.
_archive_run_artifacts() {
  local outcome="$1"
  [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] || return 0   # called before setup (arg parsing)
  local dir="${EPAM_PROJECT_CONFIG_DIR}/runs/${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  mkdir -p "$dir" 2>/dev/null || return 0
  AUTOMATION_DIR="$REPO_ROOT/orchestrations" \
  LOG_DIR="$MOCK_LOG_DIR" \
  RUN_ARTIFACT_DIR="$dir" \
    bash "$SCRIPT_DIR/archive-run-artifacts.sh" >/dev/null 2>&1 || true
  [ -f "$LOG_FILE" ] && cp "$LOG_FILE" "$dir/run.log" 2>/dev/null || true
  printf '%s\n' "$outcome" > "$dir/outcome.txt" 2>/dev/null || true
}

# ── Restore profiles.json from canonical original ───────────────────────────
# Agent mutations must not carry forward between runs — a mock that inherits a
# previous run's skill notes is testing a state no real run starts from.
# Restored INTO THE PERIMETER. This used to overwrite the repo's own profiles.json on every
# mock run, so a test mutated the live roster a client run reads.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$MOCK_AGENTS_DIR/profiles.json"
  # A perimeter run starts from the canonical roster but keeps it in its own directory; the
  # seeded copy is what every later step reads, via AGENT_PROFILES_FILE.
  [ "${EPAM_TEST_PERIMETER:-0}" = "1" ] && export AGENT_PROFILES_FILE="$MOCK_AGENTS_DIR/profiles.json"
  info "profiles.json restored from canonical original into $MOCK_AGENTS_DIR"
else
  info "profiles.json.original not found — skipping profiles restore"
fi

# ── Predictable teardown to pre-run state ───────────────────────────────────
# Same mandate as a real run. The mock's codelines are disposable, so this is a
# cheap no-op when there is no verified baseline marker yet — but the CODE PATH
# runs, which is the point of parity.
if [ -n "${JIRA_CODELINE_ROOT:-}" ] && [ -d "${JIRA_CODELINE_ROOT}" ]; then
  info "Predictable teardown: resetting codelines to last verified baseline..."
  for _cl_dir in "$JIRA_CODELINE_ROOT"/*/; do
    [ -d "${_cl_dir}.git" ] || continue
    bash "$SCRIPT_DIR/brownfield-preflight-reset.sh" "${_cl_dir%/}" || true
  done
fi

# ── Step 1: same reset every real run does — archive/clear logs, reset
# agent-status.json, wire the dashboard to serve THIS run's PRD. LOG_DIR comes
# from the perimeter block above: inherited when a test run sets it, and the
# shared orchestrations/logs otherwise. (The previous comment here claimed the
# orchestrator's LOG_DIR "is not overridable" — it reads
# LOG_DIR="${LOG_DIR:-$AUTOMATION_DIR/logs}", so it always was, and test
# artefacts were landing in client space because of that mistake.)
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

info "Log: $LOG_FILE"

# ── CodeGraph preflight — every codeline indexed before the detective needs it
# The detective silently returns nothing against an unindexed repo, which reads
# as "no fix site found" rather than "never looked". Same preflight the real
# launcher runs; a no-op when CodeGraph is unavailable.
if [ -n "${JIRA_CODELINE_ROOT:-}" ] && [ -x "$SCRIPT_DIR/codegraph-preflight-index.sh" ]; then
  info "CodeGraph preflight: verifying every codeline is indexed..."
  bash "$SCRIPT_DIR/codegraph-preflight-index.sh" "$JIRA_CODELINE_ROOT" >>"$LOG_FILE" 2>&1 \
    || info "  CodeGraph preflight reported a problem — continuing (non-fatal, matching the real launcher)"
fi

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

# ── Step 2: run_phase — copied verbatim from tier3-metrolinx-run.sh's own
# self-healing retry on exit 2 (gate remediation), not a simplified stand-in.
run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  local phase_exit=0
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  if [ "$phase_exit" -eq 2 ]; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    phase_exit=0
    SKIP_GATE_REMEDIATION=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
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

_mock_exit=0
run_phase "$PHASE_ARG" || _mock_exit=$?

_archive_run_artifacts "$([ "$_mock_exit" -eq 0 ] && echo success || echo "failed(exit $_mock_exit)")"

[ "$_mock_exit" -eq 0 ] || exit "$_mock_exit"
success "tier3-mock-run.sh complete — log: $LOG_FILE"
