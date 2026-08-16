#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Generic project orchestration launcher.
#
# Adding a new project requires only:
#   orchestrations/projects/<name>/config.env   — model ladder, Jira, phases
#   orchestrations/projects/<name>/dep-check.json    (greenfield only)
#   orchestrations/projects/<name>/contract-gen.json (greenfield only)
#   orchestrations/projects/<name>/known-fixes.json  (greenfield only)
#
# Usage:
#   bash orchestrations/scripts/orchestrate.sh --project <name> [--yes] [--phase <phase>]
#
# Examples:
#   bash orchestrations/scripts/orchestrate.sh --project skyscanner
#   bash orchestrations/scripts/orchestrate.sh --project metrolinx --yes
#   bash orchestrations/scripts/orchestrate.sh --project skyscanner --phase core
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# HARD-FAIL IF THIS DOES NOT LOAD. Sourcing a missing file is non-fatal without
# set -e, and phase_exit_is_retryable would then be "command not found" -> exit 127
# -> falsy -> the legitimate gate-remediation retry silently never happens. A
# capability that disappears without a word is the failure mode this whole change
# exists to remove.
. "$SCRIPT_DIR/lib/phase-exit.sh" || { echo "[preflight] lib/phase-exit.sh failed to load — refusing to run" >&2; exit 1; }
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"

# ── Parse args ────────────────────────────────────────────────────────────────
# Save original args BEFORE shift loop — setsid re-exec needs the raw list.
_ORIG_ARGS=("$@")
PROJECT=""
AUTO_YES=false
PHASE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) PROJECT="$2"; shift 2 ;;
    --yes|-y)     AUTO_YES=true; shift ;;
    --phase)      PHASE_OVERRIDE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$PROJECT" ] && { echo "Usage: orchestrate.sh --project <name> [--yes] [--phase <phase>]" >&2; exit 1; }

PROJECT_DIR="$REPO_ROOT/orchestrations/projects/$PROJECT"
CONFIG="$PROJECT_DIR/config.env"
[ -f "$CONFIG" ] || { echo "Project config not found: $CONFIG" >&2; exit 1; }

# ── setsid process-group isolation ───────────────────────────────────────────
# Ensures kill-tier3-run.sh can kill the entire tree (orch script, ai-run.sh,
# all forks) with a single signal regardless of nesting depth.
# See 2026-07-07 incident postmortem in tier3-skyscanner-app-run.sh.
if [ -z "${TIER3_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export TIER3_SETSID_DONE=1
  exec setsid bash "$0" "${_ORIG_ARGS[@]}"
fi

# ── Load env: global → secrets → project config (project config always wins) ─
# Load order matters: project config is sourced LAST so its values are never
# clobbered by global .env or shared secrets files that may contain stale/wrong
# Jira connection vars for a different project.
# Pass 1: global .env + project config → get SECRETS_FILE path
load_env_file_safe "$REPO_ROOT/.env"
load_env_file_safe "$CONFIG"
# Pass 2: load secrets file (tokens, not connection config) if declared.
# SECRETS_FILE is declared repo-relative so the config file needs no ${REPO_ROOT}
# interpolation — a config file is DATA and must not be evaluated. Resolve it
# here, where REPO_ROOT is genuinely known, rather than making the file executable.
if [ -n "${SECRETS_FILE:-}" ]; then
  case "$SECRETS_FILE" in
    /*) _secrets_abs="$SECRETS_FILE" ;;
     *) _secrets_abs="$REPO_ROOT/$SECRETS_FILE" ;;
  esac
  [ -f "$_secrets_abs" ] && load_env_file_safe "$_secrets_abs"
fi
# Pass 3: re-load project config so it wins over anything in the secrets file
load_env_file_safe "$CONFIG"

LOG_FILE="/tmp/tier3-${PROJECT}-$(date +%Y%m%dT%H%M%S).log"
TIER3_PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-${PROJECT}-run.pid}"
echo "$$" > "$TIER3_PID_FILE"
trap 'rm -f "$TIER3_PID_FILE"' EXIT

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[orchestrate:${PROJECT}]${NC} $*"; }
success() { echo -e "${GREEN}[orchestrate:${PROJECT}] ✓${NC} $*"; }
fail()    { echo -e "${RED}[orchestrate:${PROJECT}] ✗${NC} $*"; exit 1; }

[[ "${CI:-}" == "true" || "${AUTO_YES_TIER3:-}" == "1" ]] && AUTO_YES=true
[[ ! -t 0 ]] && AUTO_YES=true

# Resolve node binary — prefer PATH node (nvm/fnm managed)
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
export NODE_BIN

# PRD_FILE: runtime file written by Jira ingest (brownfield) or restored from
# canonical (greenfield). Both modes write to the same path; pre-run-reset clears it.
# PER-PROJECT. This defaulted to travel-app-prd.json, so `orchestrate.sh --project
# metrolinx` (PRD_FILE unset in its config.env) synthesized the AMSD PRD straight
# into the travel-app PRD — the same clobber the tier3 runner was fixed for.
PRD_FILE="${PRD_FILE:-${REPO_ROOT}/orchestrations/projects/${PROJECT}/prd.json}"
export PRD_FILE

# ── Required key validation ───────────────────────────────────────────────────
IFS=',' read -ra _required_keys <<< "${REQUIRED_KEYS:-}"
for _key in "${_required_keys[@]}"; do
  _key="${_key// /}"
  [ -z "${_key}" ] && continue
  [ -z "${!_key:-}" ] && fail "$_key is not set. Export it or add it to .env before launching."
done

# ── Phase resolution ──────────────────────────────────────────────────────────
PHASES="${PHASE_OVERRIDE:-${EPAM_PHASES:-core}}"

# ── Pre-launch summary ────────────────────────────────────────────────────────
info "Project:  $PROJECT"
info "Mode:     $([ "${EPAM_BROWNFIELD:-0}" = "1" ] && echo "BROWNFIELD (existing codeline, no teardown)" || echo "GREENFIELD (teardown + scaffold)")"
info "Phases:   $PHASES"
if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  info "Jira:     ${JIRA_URL:-n/a} / ${JIRA_PROJECT_KEY:-n/a}"
  info "Codeline: ${JIRA_CODELINE_ROOT:-n/a}"
  info "Baseline: ${JIRA_BASELINE_BRANCH:-n/a}"
else
  info "Output:   ${OUTPUT_DIR:-n/a}"
  info "PRD:      $PRD_FILE"
fi
info "Log:      $LOG_FILE"
echo ""

if [ "$AUTO_YES" = true ]; then
  info "Auto-confirmed (--yes flag or non-interactive)"
else
  read -rp "$(echo -e "${YELLOW}Confirm: spend credits for project '${PROJECT}'? [yes/N]${NC} ")" _confirm
  [ "$_confirm" != "yes" ] && { info "Aborted."; exit 0; }
fi

cd "$REPO_ROOT"

# ── Export all config vars so subprocesses inherit them ───────────────────────
set -a
EPAM_BROWNFIELD="${EPAM_BROWNFIELD:-0}"
EPAM_API_KEY_MINIMAX="${MINIMAX_API_KEY:-}"
EPAM_API_KEY_OPENROUTER="${OPENROUTER_API_KEY:-}"
set +a

# ── Capture OpenRouter spend baseline ─────────────────────────────────────────
_usage_before="0"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  _usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
    "$NODE_BIN" -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
  info "OpenRouter usage before: \$$_usage_before"
  echo ""
fi

# ── Greenfield setup ──────────────────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
  [ -z "${OUTPUT_DIR:-}" ] && fail "OUTPUT_DIR must be set in config.env for greenfield projects"
  [ -z "${PRD_CANONICAL:-}" ] && fail "PRD_CANONICAL must be set in config.env for greenfield projects"
  # Paths in a config file are repo-relative: a config file is DATA and cannot
  # interpolate ${REPO_ROOT}. Resolve here, where REPO_ROOT is genuinely known.
  case "$PRD_CANONICAL" in /*) ;; *) PRD_CANONICAL="$REPO_ROOT/$PRD_CANONICAL" ;; esac
  case "${PRD_FILE:-}" in ""|/*) ;; *) PRD_FILE="$REPO_ROOT/$PRD_FILE" ;; esac
  export PRD_CANONICAL PRD_FILE
  [ -f "$PRD_CANONICAL" ] || fail "PRD canonical file not found: $PRD_CANONICAL"
  export OUTPUT_DIR PROJECT_ROOT="$OUTPUT_DIR"

  # Full teardown — see 2026-07-11/12 incident: node_modules subdirs end up
  # non-writable after npm install; force write access before rm -rf.
  [ -d "$OUTPUT_DIR" ] && chmod -R u+w "$OUTPUT_DIR" 2>/dev/null || true
  info "Tearing down output directory: $OUTPUT_DIR"
  rm -rf "$OUTPUT_DIR"
  for _wt_dir in "${OUTPUT_DIR}-wt-"*; do
    [ -e "$_wt_dir" ] || continue
    chmod -R u+w "$_wt_dir" 2>/dev/null || true
    rm -rf "$_wt_dir" && info "Removed leftover worktree: $_wt_dir"
  done
  mkdir -p "$OUTPUT_DIR"
  git -C "$OUTPUT_DIR" init --quiet
  git -C "$OUTPUT_DIR" config user.email "epam-cli@local"
  git -C "$OUTPUT_DIR" config user.name "epam-cli"
  git -C "$OUTPUT_DIR" commit --allow-empty -m "init: ${PROJECT}" --quiet
  info "Output directory clean (deleted and reinitialised)"

  # Copy stack manifests from project dir into output dir
  mkdir -p "$OUTPUT_DIR/.epam"
  for _manifest in dep-check contract-gen known-fixes; do
    _src="$PROJECT_DIR/${_manifest}.json"
    if [ -f "$_src" ]; then
      cp "$_src" "$OUTPUT_DIR/.epam/${_manifest}.json"
      info "Copied ${_manifest}.json from project config"
    fi
  done

  # Secondary worktree teardown (multi-codeline PRDs)
  _sec_wts=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/secondary-codeline-dirs.js" "$PRD_CANONICAL" "$OUTPUT_DIR" 2>/dev/null || true)
  if [ -n "$_sec_wts" ]; then
    info "Multi-codeline PRD — tearing down secondary worktrees..."
    while IFS= read -r _sec_wt; do
      [ -z "$_sec_wt" ] && continue
      [ -d "$_sec_wt" ] && chmod -R u+w "$_sec_wt" 2>/dev/null || true
      rm -rf "$_sec_wt"
      mkdir -p "$_sec_wt"
      git -C "$_sec_wt" init --quiet
      git -C "$_sec_wt" commit --allow-empty -m "init: secondary-codeline-worktree" --quiet
      info "  Secondary worktree torn down: $_sec_wt"
    done <<< "$_sec_wts"
  fi

  # Restore PRD from canonical and validate integrity
  cp "$PRD_CANONICAL" "$PRD_FILE"
  _canonical_count=$(python3 -c "import json; print(len(json.load(open('$PRD_FILE'))['stories']))" 2>/dev/null || echo '?')
  info "prd.json restored from canonical ($_canonical_count base stories)"

  bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" || \
    fail "Pre-run PRD remediation failed — aborting."

  python3 - "$PRD_FILE" <<'PYEOF' || fail "PRD integrity check failed — canonical file is corrupt."
import json, sys
d = json.load(open(sys.argv[1]))
mid_exec = [s['id'] for s in d['stories'] if s.get('specification', {}).get('splitOrigin') == 'mid-execution']
dirty    = [s['id'] for s in d['stories'] if s.get('status') not in ('pending','deprecated') and not s.get('deprecated')]
errors = []
if mid_exec: errors.append(f"ABORT: {len(mid_exec)} mid-execution splits present: {mid_exec}")
if dirty:    errors.append(f"ABORT: {len(dirty)} stories with non-pending status: {dirty}")
if errors:
  [print(e, file=sys.stderr) for e in errors]; sys.exit(1)
print(f"  PRD integrity OK: {len(d['stories'])} stories, all pending")
PYEOF
  echo ""
fi

# ── Reset PRD + profiles.json for EVERY run (both modes) ─────────────────────
# Greenfield: PRD was already restored from canonical above.
# Brownfield: PRD canonical restore provides a clean slate; the Jira ingest step
# OVERWRITES this file with the synthesized PRD.  If ingest fails and does not
# write the file, the canonical PRD is left in place (0 matching stories in the
# brownfield codeline = clean abort, not a silent wrong-stories run).
# profiles.json is always restored from canonical so agent profiles can't drift
# across runs.
#
# This block runs for EVERY project on EVERY run — not debatable.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  # Brownfield: empty sentinel — PRD comes from Jira ingest, never from the
  # greenfield canonical (which belongs to a different project entirely).
  # Include project.outputDir = JIRA_CODELINE_ROOT so PROJECT_ROOT resolves to
  # the existing codeline repo, not the epam-cli repo (which triggers the safety guard).
  echo '{"project":{"name":"'"$PROJECT"'","outputDir":"'"${JIRA_CODELINE_ROOT:-}"'"},"stories":[],"implementationOrder":{}}' > "$PRD_FILE"
  info "PRD cleared (brownfield: Jira ingest will write the live PRD)"
fi

if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$REPO_ROOT/orchestrations/agents/profiles.json"
  _count=$(python3 -c "import json; print(len(json.load(open('$PROFILES_ORIG'))))" 2>/dev/null || echo '?')
  info "profiles.json restored from canonical ($_count profiles)"
else
  info "profiles.json.original not found — skipping profiles restore"
fi
echo ""

# ── Wire dashboard to this run's live PRD + logs ──────────────────────────────
info "Wiring dashboard..."
# Contamination ABORTS the launch; everything else stays non-fatal. One gate,
# lib/pre-run-reset-gate.sh, for all launchers — this used to be five copies of
# "|| info", all of which swallowed a contaminated-state exit as a Docker problem.
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/pre-run-reset-gate.sh"
pre_run_reset_or_abort --prd "$PRD_FILE"
if [ -n "${OUTPUT_DIR:-}" ]; then
  echo -n "$OUTPUT_DIR" > "$REPO_ROOT/orchestrations/dashboards/.active-output-dir"
fi
echo ""

# ── Scope-guard snapshot (greenfield only) ────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" != "1" ] && [ -d "${OUTPUT_DIR:-}/src" ]; then
  SCOPE_GUARD_BACKUP_DIR="/tmp/sg-backup-$$"
  export SCOPE_GUARD_BACKUP_DIR
  mkdir -p "$SCOPE_GUARD_BACKUP_DIR"
  (cd "$OUTPUT_DIR" && find src -name "*.ts" | while IFS= read -r f; do
    mkdir -p "$SCOPE_GUARD_BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$SCOPE_GUARD_BACKUP_DIR/$f"
  done)
  info "[scope-guard] Source snapshot created ($(find "$SCOPE_GUARD_BACKUP_DIR" -name '*.ts' | wc -l) files)"
fi

PIPELINE_EXIT=0

# ── run_phase ─────────────────────────────────────────────────────────────────
run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  # Greenfield only: remediate PRD before each phase to strip stale splits,
  # reset story state, and verify integrity without manual intervention.
  if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
    info "  Pre-phase PRD remediation..."
    if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" --phase "$phase" 2>&1 | tee -a "$LOG_FILE"; then
      fail "PRD remediation failed for phase '$phase'"
    fi
    echo ""
  fi

  local phase_exit=0
  bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  # exit 2 = gate remediation was applied — reset stories and retry once
  if phase_exit_is_retryable "$phase_exit"; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
      bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" --phase "$phase" --mid-phase-retry \
        2>&1 | tee -a "$LOG_FILE" || true
      echo ""
    fi
    phase_exit=0
    SKIP_GATE_REMEDIATION=1 bash "$SCRIPT_DIR/run-agent-orchestration.sh" \
      --phase "$phase" \
      --reset \
      2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
    echo ""
    [ "$phase_exit" -ne 0 ] && fail "Phase '$phase' failed after self-healing retry (exit $phase_exit) — aborting"
    success "Self-healing retry succeeded for phase '$phase'"
    return 0
  fi

  [ "$phase_exit" -ne 0 ] && fail "Phase '$phase' failed (exit $phase_exit) — aborting pipeline"
}

# ── Execute phases ────────────────────────────────────────────────────────────
for _phase in $PHASES; do
  run_phase "$_phase"
done

# ── Report spend ──────────────────────────────────────────────────────────────
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  _usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
    "$NODE_BIN" -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
  _spent=$("$NODE_BIN" -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
  info "OpenRouter usage after:   \$$_usage_after"
  info "Total spent this run:     \$$_spent"
  echo ""
fi

# ── Validate story completion ─────────────────────────────────────────────────
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
      echo -e "${RED}[orchestrate:${PROJECT}] ✗${NC} $story: $status"
      FAIL_LIST="$FAIL_LIST $story"
    fi
  done < <(python3 "$SCRIPT_DIR/lib/handlers/story-implementation-order.py" "$PRD_FILE" 2>/dev/null)
  echo ""
fi

if [ -n "${FAIL_LIST:-}" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Project '${PROJECT}' FAILED — stories not completed:${FAIL_LIST:-}"
fi

success "Project '${PROJECT}' PASSED — all ${PASS:-0} stories complete"
echo ""
[ -n "${OUTPUT_DIR:-}" ] && echo "  Output: $OUTPUT_DIR"
echo "  Log:    $LOG_FILE"
