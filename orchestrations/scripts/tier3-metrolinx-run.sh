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
#   Story agents : z-ai/glm-5.2 (OpenRouter)
#   Gates/analyst: z-ai/glm-5.2
#   Retry ladder : glm-5.2 → glm-5.1 → kimi-k3 (HIGH ceiling)
#
# Prerequisites:
#   - MINIMAX_API_KEY set (MiniMax-M3 story agents)
#   - OPENROUTER_API_KEY set (GLM-5.x, Kimi K3 via OpenRouter)
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
# shellcheck source=lib/project-config.sh
. "$SCRIPT_DIR/lib/project-config.sh"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
LOG_FILE="/tmp/tier3-metrolinx-jira-$(date +%Y%m%dT%H%M%S)-$$.log"
# One identifier for the whole run. Previously only the CHILD orchestration
# script set this, so the parent could not name anything after it — the run
# folder, the Langfuse session and pre-run-reset's archive each invented their
# own timestamp and could not be tied together. Setting it here and exporting it
# means all three agree, and a run folder can be matched to its traces.
export ORCH_RUN_ID="${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-metrolinx-run.pid}"
echo "$$" > "$TIER3_PID_FILE"
trap 'rm -f "$TIER3_PID_FILE"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-metrolinx]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-metrolinx] ✓${NC} $*"; }
error()   { echo -e "${RED}[tier3-metrolinx] ✗${NC} $*" >&2; }
# ── Run artefacts, on EVERY outcome ──────────────────────────────────────────
# A failed run is the one you most need evidence from, and its artefacts are the
# most perishable: the working PRD lives in /tmp, profiles.json is restored from
# canonical at the next launch, and the KB scratchpad is cleared by
# pre-run-reset.sh. Archiving only on success meant every failure investigated
# today had to be reconstructed from a log after the fact.
#
# Never allowed to change the run's outcome: `|| true` throughout, and the
# original exit status is preserved.
_archive_run_artifacts() {
  local outcome="$1"
  # Assigned separately: `local dir="$(...)"` makes the exit status local's, always 0,
  # which would swallow the resolver's refusal — the very shape this file was fixed for.
  local _cfg dir
  _cfg="$(project_config_dir metrolinx "$REPO_ROOT")" || return 1
  dir="$_cfg/runs/${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  mkdir -p "$dir" 2>/dev/null || return 0
  AUTOMATION_DIR="$REPO_ROOT/orchestrations" \
  LOG_DIR="$REPO_ROOT/orchestrations/logs" \
  RUN_ARTIFACT_DIR="$dir" \
    bash "$SCRIPT_DIR/archive-run-artifacts.sh" >/dev/null 2>&1 || true
  [ -f "$LOG_FILE" ] && cp "$LOG_FILE" "$dir/run.log" 2>/dev/null || true
  printf '%s\n' "$outcome" > "$dir/outcome.txt" 2>/dev/null || true

  # The two deliverables a run owes: a narrative and a QA summary, built from
  # the artefacts just captured.
  python3 "$SCRIPT_DIR/generate-run-report.py" \
    --launch-log "$LOG_FILE" \
    --logs-dir "$REPO_ROOT/orchestrations/logs" \
    --codeline "$(sed 's/\x1b\[[0-9;]*m//g' "$LOG_FILE" 2>/dev/null | grep -oE "Codeline '\''[^'\'']+'\'' → \S+" | head -1 | awk '{print $NF}')" \
    --baseline "$(cat "$REPO_ROOT/orchestrations/logs/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')" \
    --prd "$dir/working-prd.json" \
    --out "$dir" >/dev/null 2>&1 || true
  echo -e "${YELLOW}[tier3-metrolinx]${NC} Run artefacts + reports: $dir"
}

fail()    {
  echo -e "${RED}[tier3-metrolinx] ✗${NC} $*"
  _archive_run_artifacts "FAILED: $*"
  exit 1
}

# ── Load .env then metrolinx project env ─────────────────────────────────────
# Before ANY config file is read: what the operator set on the command line. A mode overrides a
# project default but never this — see lib/run-modes.sh.
. "$SCRIPT_DIR/lib/run-modes.sh"
# HARD-FAIL IF THIS DOES NOT LOAD. Sourcing a missing file is non-fatal without
# set -e, and phase_exit_is_retryable would then be "command not found" -> exit 127
# -> falsy -> the legitimate gate-remediation retry silently never happens. A
# capability that disappears without a word is the failure mode this whole change
# exists to remove.
. "$SCRIPT_DIR/lib/phase-exit.sh" || { echo "[preflight] lib/phase-exit.sh failed to load — refusing to run" >&2; exit 1; }
snapshot_operator_env
load_env_file_safe "$REPO_ROOT/.env"
ENV_FILE="$SCRIPT_DIR/../jira/metrolinx.env"
[ -f "$ENV_FILE" ] && load_env_file_safe "$ENV_FILE" preserve || fail "metrolinx.env not found at $ENV_FILE"
# Project-level config (pipeline flags, semble, AC gate settings)
PROJECT_CONFIG="$SCRIPT_DIR/../projects/metrolinx/config.env"
[ -f "$PROJECT_CONFIG" ] && load_env_file_safe "$PROJECT_CONFIG" preserve

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
# NOT `[[ ! -t 0 ]] && AUTO_YES=true`.
#
# That line skipped the spend confirmation for ANY invocation without a terminal: a cron, a CI step,
# a script, an agent, a mis-pasted command. Its plausible purpose was background launches, but those
# pass --yes explicitly -- what it actually covered was launching non-interactively WITHOUT --yes,
# which is precisely the case where nobody is watching.
#
# Demonstrated twice on 2026-08-21, minutes apart. A TEST asserting "a non-interactive launch does
# not auto-confirm" ran this script with stdin from /dev/null and LAUNCHED A RUN -- and then
# mutation-testing that same test launched a second one. Both locked 33 codelines read-only and
# reached Jira ingest before dying; no credits were spent only because they failed early.
#
# The line above already covers legitimate automation: CI=true and AUTO_YES_TIER3=1 are explicit
# opt-ins somebody chose. Absence of a terminal is not consent.

# PRD_FILE: written by the Jira ingest step at runtime.
# PER-PROJECT. All three tier3 runners previously pointed here at
# orchestrations/travel-app-prd.json, so a metrolinx run's Jira ingest overwrote
# the travel-app PRD outright (4 SKY stories -> 1 AMSD story, 2026-07-25). The
# path now derives from the project identity that already exists a few lines up.
PRD_FILE="$(project_config_dir metrolinx "$REPO_ROOT")/prd.json" || exit 1

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

# ── Pre-flight: the built CLI must not be older than its source ──────────────
#
# `epam` is `exec node .../dist/epam.js`. Every test in the suite reads src/, so a change that
# is written, tested, committed and never built looks shipped from every angle a test can see.
#
# Live 2026-08-09: tool-usage logging was wired, unit-tested and reported working, and the run
# emitted nothing — dist had been built eighteen hours earlier. Nine passing tests, zero events.
#
# Fails rather than rebuilds: a launcher that silently recompiles under an operator who did not
# ask for it changes what is being run without saying so. EPAM_SKIP_BUILD_STALENESS_CHECK=1 for
# the case where an older binary is deliberate.
if [ "${EPAM_SKIP_BUILD_STALENESS_CHECK:-0}" != "1" ]; then
  _dist="$REPO_ROOT/dist/epam.js"
  if [ ! -f "$_dist" ]; then
    error "[preflight] $_dist does not exist — the pipeline has no binary to run."
    error "[preflight]   Build: ~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup"
    exit 1
  fi
  _newest_src=$(find "$REPO_ROOT/src" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.json' \) \
                  ! -name '*.test.ts' ! -name '*.d.ts' -newer "$_dist" -print -quit 2>/dev/null)
  if [ -n "$_newest_src" ]; then
    error "[preflight] dist/epam.js is OLDER than $(basename "$_newest_src") — the pipeline would run a stale binary."
    error "[preflight]   Newer source: ${_newest_src#$REPO_ROOT/}"
    error "[preflight]   Build: ~/.nvm/versions/node/v20.20.0/bin/node ./node_modules/.bin/tsup"
    error "[preflight]   Override (deliberate): EPAM_SKIP_BUILD_STALENESS_CHECK=1"
    exit 1
  fi
  info "Pre-flight: built CLI is current with src/"
fi

  # ── EVERY STORY DECLARES THE ROLE THAT WILL WRITE IT ────────────────────────
  #
  # agentRole decides which archetype's brief the writer runs under. A story with none falls
  # through to the generic writer, which is not bound by the specialist's rules — including the
  # test-ownership exclusion, "You do not create, edit, or maintain any test files."
  #
  # Live 2026-08-14, run 20260814T135343Z: agentRole was null, the writer ran generic, it edited a
  # pre-existing spec file, and that single test file in the diff silenced the dedicated
  # repro-test-writer ("a test already accompanies the change — nothing to write"). No reproducing
  # test was authored, and Step 3.55 blocked the story twice for opposite reasons: the tests failed
  # WITH the fix, then passed WITHOUT it. The code itself was fine and had already committed with a
  # clean type check.
  #
  # It is null because assignment belongs to the MINT, and every writer-style resume skips the mint
  # while the canonical PRD is reset each launch. So the role has to be DECLARED in the PRD, and
  # this check makes its absence visible before the run spends anything.
  if [ "${EPAM_SKIP_AGENT_ROLE_CHECK:-0}" != "1" ] && [ -f "$PRD_FILE" ]; then
    # WHETHER THE MINT IS ABOUT TO RUN DECIDES WHAT "MISSING" MEANS.
    #
    # This block compared the PRD's agentRole against profiles.json with no notion of the
    # mint — and it runs BEFORE the mint (here, vs ~line 297). Rosters are ephemeral: a
    # fresh run restores the canonical base and the mint then produces this run's roles,
    # so a role a PREVIOUS run minted can never match at this point. On 2026-08-14 that
    # refused a launch the very next step would have fixed; the following launch minted
    # the role and the run completed.
    #
    # The rule now lives in lib/agent-role-preflight.sh so it is testable and so the
    # other launchers can adopt it instead of copying it.
    . "$SCRIPT_DIR/lib/agent-role-preflight.sh"
    if ! agent_roles_resolve "$PRD_FILE" "$REPO_ROOT/orchestrations/agents/profiles.json" \
         "$([ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ] && echo 0 || echo 1)"; then
      error "[preflight]   Set agentRole in $PRD_FILE, or run the mint so assignment happens."
      error "[preflight]   Override (deliberate): EPAM_SKIP_AGENT_ROLE_CHECK=1"
      exit 1
    fi
    # AND THAT THE PERIMETER WILL PERMIT IT TO WRITE.
    #
    # Existing in profiles.json is not the same as being allowed to author code. The write
    # perimeter reads project-roles.json — and prefers the PER-PROJECT copy under
    # EPAM_PROJECT_CONFIG_DIR over orchestrations/agents/, deliberately, so a client project does
    # not inherit the engine's own implementation roles.
    #
    # Live 2026-08-14, run 20260814T185607Z: the role was declared on the story and present in
    # profiles.json, this check passed, and the run was refused three minutes later —
    # "not permitted to author code" — because the per-project file held roles: []. Verifying the
    # wrong registry is the same as not verifying.
    _perim_registry="${EPAM_PROJECT_ROLES_FILE:-}"
    if [ -z "$_perim_registry" ] && [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/project-roles.json" ]; then
      _perim_registry="${EPAM_PROJECT_CONFIG_DIR}/project-roles.json"
    fi
    [ -n "$_perim_registry" ] || _perim_registry="$REPO_ROOT/orchestrations/agents/project-roles.json"
    if [ -f "$_perim_registry" ]; then
      _unpermitted=$(jq -r --slurpfile reg "$_perim_registry" '[.stories[]? | select((.agentRole // "") != "") | select((.agentRole) as $r | (($reg[0].roles // []) | index($r)) == null) | .id + " -> " + .agentRole] | join("; ")' "$PRD_FILE" 2>/dev/null)
      if [ -n "$_unpermitted" ]; then
        error "[preflight] agentRole is not a registered implementer: $_unpermitted"
        error "[preflight]   The write perimeter reads: $_perim_registry"
        error "[preflight]   It will refuse the writer with 'not permitted to author code'."
        error "[preflight]   Add the role to .roles there, or run the mint so it is registered."
        exit 1
      fi
      info "Pre-flight: every agentRole is a registered implementer in $(basename "$_perim_registry")"
    fi
    info "Pre-flight: every story declares an agentRole the roster holds"
  fi

# Also into $LOG_FILE: the line above goes to stdout, which is the launch log
# that pre-run-reset deletes. The run report is generated from $LOG_FILE, so a
# balance recorded only on stdout leaves every report saying "Billed by
# provider $?" — the one number that is ground truth rather than our own tally.
printf 'OpenRouter usage before: $%s\n' "$_usage_before" >> "$LOG_FILE" 2>/dev/null || true
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
# NOT WHEN THE MINT IS SKIPPED. Restoring base state is right before a run that will mint afresh —
# it stops one run's profile mutations carrying into the next. When the mint is skipped there is
# nothing to rebuild what this overwrites, so the restore destroys the very roster the run intends
# to reuse. Live 2026-08-13: a writer-only launch found the generic base roster and the story's own
# agent did not exist in it.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ "${EPAM_SKIP_AGENT_MINT:-0}" = "1" ]; then
  info "profiles.json NOT restored — the mint is skipped, so this run reuses the roster it last minted"
elif [ -f "$PROFILES_ORIG" ]; then
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
#
# RESET ONLY THE CODELINES THIS RUN DECLARES.
#
# brownfield-preflight-reset.sh runs `git reset --hard <baseline>` plus `clean -fd`, and
# `reset --hard` MOVES THE BRANCH POINTER: it discards commits, not merely working-tree edits.
# So the set it is applied to is the set of repositories this launch may destroy, and that set
# must never be wider than the run.
#
# It used to be scoped by EPAM_ONLY_CODELINES — an operator typing the repository name at
# launch, matched by substring in both directions. That is deleted. See lib/codeline-scope.sh
# for why none of its three problems were fixable by choosing a better value.
#
# The scope comes from the PRD this launcher was already handed, and an EMPTY scope resets
# NOTHING: a run that has not resolved which codeline it belongs to cannot have dirtied one,
# and sweeping every repository under the root is exactly how a finished codeline gets
# destroyed by the next launch.
# shellcheck source=lib/codeline-scope.sh
. "$SCRIPT_DIR/lib/codeline-scope.sh"
_scoped=0
for _cl_dir in "$JIRA_CODELINE_ROOT"/*/; do
  [ -d "${_cl_dir}.git" ] || continue
  codeline_in_scope "${_cl_dir%/}" "$PRD_FILE" || continue
  _scoped=$((_scoped + 1))
  bash "$SCRIPT_DIR/brownfield-preflight-reset.sh" "${_cl_dir%/}" || true
done
if [ "$_scoped" -eq 0 ]; then
  info "  no codeline declared by $PRD_FILE — nothing reset (scope is resolved during the run)"
else
  info "  reset $_scoped codeline(s) declared by the PRD"
fi
echo ""

# ── Write perimeter: client source is READ-ONLY until a story branch exists ──
# Applied to every candidate codeline, before any agent runs. A repo sitting on
# its baseline branch is chmod'd read-only; ensure_story_branch reopens it once
# the repo is genuinely on that story's own branch, which is the only place
# edits may land.
#
# This is enforced at the filesystem because a per-tool allowlist cannot hold:
# WriteFile.ts has a scope guard, Bash.ts has none — no cwd restriction, no
# command filtering — and six agents hold `bash` against these repos. Live
# 20260806T113101Z: ~1050 lines across five files were rewritten during the
# SPEC PASS, before the writer had run at all.
#
# .epam/ and .codegraph/ are deliberately left writable: the engine writes its
# own state there mid-run. See lib/codeline-write-perimeter.sh.
. "$SCRIPT_DIR/lib/codeline-write-perimeter.sh"
# The loop that used to be here is now perimeter_seal_all, beside perimeter_release_all, and the
# engine calls it for every project. This call is kept only for its TIMING — it seals before this
# launcher's own preflight, earlier than the engine can. Same function, so the two cannot drift.
perimeter_seal_all "$JIRA_CODELINE_ROOT" || true
echo ""

# ── Wire the dashboard to this run's live PRD + logs ─────────────────────────
# MUST run BEFORE CodeGraph preflight below: pre-run-reset.sh resets
# agent-status.json. Emitting preflight events before that reset would have
# them wiped a moment later, before the dashboard ever showed them.
info "Wiring dashboard to serve this run's live PRD + logs..."
# Contamination ABORTS the launch; everything else stays non-fatal. One gate,
# lib/pre-run-reset-gate.sh, for all launchers — this used to be five copies of
# "|| info", all of which swallowed a contaminated-state exit as a Docker problem.
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"
echo "${OUTPUT_DIR:-$JIRA_CODELINE_ROOT}" > "orchestrations/dashboards/.active-output-dir" 2>/dev/null || true
echo ""

# ── Observability preflight: Langfuse + Grafana must be UP before we spend ───
#
# Live 2026-07-28: the machine crashed overnight and took the whole stack with
# it — grafana, postgres, redis and clickhouse all `Exited (255)` for 16 hours,
# with langfuse-server crash-looping on its dead dependencies. The AMSD-2041 run
# launched anyway and produced ZERO traces before anyone noticed. Cost tracking
# is priority #1 and observability #2; a run neither can see is a run whose
# spend and behaviour are unrecoverable after the fact.
#
# Checked at the ENDPOINT, not by `docker ps`: a container can report Up while
# still returning 5xx, and "the process exists" is not "the service works" —
# the same distinction that hid the Live Execution panel never working.
#
# Grafana answers 302 (redirect to login) when healthy, so any 2xx/3xx passes.
# Fails LOUD and aborts: discovering this mid-run is exactly what happened.
# OBSERVABILITY_PREFLIGHT=0 to bypass deliberately.
if [ "${OBSERVABILITY_PREFLIGHT:-1}" = "1" ]; then
  info "Observability preflight: verifying Langfuse and Grafana are serving..."
  _obs_failed=""
  _obs_check() {
    local _name="$1" _url="$2" _code
    _code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$_url" 2>/dev/null || echo "000")
    case "$_code" in
      2??|3??) success "  $_name: serving (HTTP $_code)" ;;
      *)       error   "  $_name: NOT serving (HTTP $_code) at $_url"
               _obs_failed="${_obs_failed}${_name} "; return 1 ;;
    esac
  }
  _obs_check "Langfuse" "${LANGFUSE_BASE_URL:-http://localhost:3100}" || true
  _obs_check "Grafana"  "${GRAFANA_BASE_URL:-http://localhost:3001}"  || true

  if [ -n "$_obs_failed" ]; then
    error "Observability preflight FAILED: ${_obs_failed}— aborting before any spend."
    error "  The stack is usually down because the host restarted. Bring it back with:"
    error "    docker compose -f docker-compose.observability.yml up -d postgres redis clickhouse"
    error "    docker compose -f docker-compose.observability.yml up -d langfuse-server grafana"
    error "  langfuse-server crash-loops until postgres/clickhouse/redis are healthy, so start them first."
    error "  Set OBSERVABILITY_PREFLIGHT=0 to launch without tracing (the run's cost will not be recoverable)."
    exit 1
  fi
  success "Observability preflight passed — Langfuse and Grafana both serving."
fi

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

# ── run_phase: invoke orch script with self-healing retry on exit 2 ───────────
run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  local phase_exit=0
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  if phase_exit_is_retryable "$phase_exit"; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    phase_exit=0
    SKIP_GATE_REMEDIATION=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
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
# Also into $LOG_FILE: the line above goes to stdout, which is the launch log
# that pre-run-reset deletes. The run report is generated from $LOG_FILE, so a
# balance recorded only on stdout leaves every report saying "Billed by
# provider $?" — the one number that is ground truth rather than our own tally.
printf 'OpenRouter usage after: $%s\n' "$_usage_after" >> "$LOG_FILE" 2>/dev/null || true
info "Total spent this run:   \$$_spent"
echo ""

# ── A PAUSE IS AN ENDING, NOT A FAILURE ───────────────────────────────────────
#
# The run is designed to stop at an operator checkpoint: after the roster is minted, and/or
# before the writer. At those points stories are legitimately still "pending" — no work was
# meant to happen yet. Reporting FAILED there is a false alarm that hides real failures by
# training the operator to ignore the line. Live 2026-08-07: the roster pause worked exactly
# as designed and the launcher declared the run failed.
_paused_marker=""
for _d in "${LOG_DIR:-}" "${OUTPUT_DIR:-}" "$SCRIPT_DIR/../logs"; do
  [ -n "$_d" ] && [ -f "$_d/PAUSED" ] && _paused_marker="$_d/PAUSED" && break
done
if [ -n "$_paused_marker" ] || [ -f "${LOG_DIR:-$SCRIPT_DIR/../logs}/roster-diff.md" ] && \
   { [ "${EPAM_PAUSE_AFTER_AGENT_MINT:-0}" = "1" ] || [ "${EPAM_PAUSE_BEFORE_WRITER:-0}" = "1" ]; }; then
  info "Run ended at an operator pause — stories are pending BY DESIGN, not by failure."
  info "  Roster:      ${LOG_DIR:-$SCRIPT_DIR/../logs}/roster-diff.md"
  info "  Mint inputs: ${LOG_DIR:-$SCRIPT_DIR/../logs}/mint-inputs.json"
  info "  Review, then resume with EPAM_RESUME_RUN=<run-id>."
  exit 0
fi

# ── Validate story completion from dynamically-generated PRD ──────────────────
if [ -f "$PRD_FILE" ]; then
  info "Validating story completion..."
  PASS=0; FAIL_LIST=""
  while IFS= read -r story; do
    [ -z "$story" ] && continue
    status=$(python3 "$SCRIPT_DIR/lib/handlers/story-status.py" "$PRD_FILE" "$story" 2>/dev/null)
    if [ "$status" = "completed" ]; then
      success "$story: completed"
      PASS=$((PASS+1))
    else
      echo -e "${RED}[tier3-metrolinx] ✗${NC} $story: $status"
      FAIL_LIST="$FAIL_LIST $story"
    fi
  done < <(python3 "$SCRIPT_DIR/lib/handlers/story-implementation-order.py" "$PRD_FILE" 2>/dev/null)
  echo ""
fi

if [ -n "${FAIL_LIST:-}" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 Metrolinx FAILED — stories not completed:${FAIL_LIST:-}"
fi

success "Tier 3 Metrolinx PASSED — all ${PASS:-0} stories complete"
_archive_run_artifacts "PASSED: ${PASS:-0} stories complete"
echo ""
echo "  Codeline: $JIRA_CODELINE_ROOT"
echo "  Log:      $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
