#!/usr/bin/env bash
# Service endpoints come from orchestrations/config/services.json — one place to change
# a port, instead of the 20+ copies these URLs used to have across the pipeline.
. "$(dirname "${BASH_SOURCE[0]}")/lib/service-urls.sh"
_DASH="$(service_url dashboard)"

# preflight-check.sh — validates everything before a paid pipeline run.
# Catches missing exports, bad PRD config, missing API keys, and wrong paths.
# Called automatically by pre-run-reset.sh, or run standalone.
#
# Usage:
#   bash orchestrations/scripts/preflight-check.sh --runner tier3-travel-app-run.sh \
#        --prd orchestrations/travel-app-prd.json
#
# Exit 0 = all checks pass. Exit 1 = one or more checks failed (do NOT run).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"

# ── Args ─────────────────────────────────────────────────────────────────────
# Inherit from the launching environment when present: a launcher that already resolved
# PRD_FILE should not have to pass it again, and blanking it here made the pre-flight
# report "PRD_FILE is unset" about an environment where it was plainly set.
RUNNER_SCRIPT="${RUNNER_SCRIPT:-}"
PRD_FILE="${PRD_FILE:-}"
PROJECT_CONFIG_DIR="${EPAM_PROJECT_CONFIG_DIR:-}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --runner) RUNNER_SCRIPT="$SCRIPT_DIR/$2"; shift 2 ;;
    --prd)    PRD_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --project-config) PROJECT_CONFIG_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*" >&2; FAIL=$((FAIL+1)); }

echo ""
echo "━━━ Pre-flight checks ━━━"

# ── 1. Runner script exists and is shellcheck-clean ──────────────────────────
echo "[ Runner script ]"
if [[ -z "$RUNNER_SCRIPT" ]]; then
  fail "No --runner specified"
elif [[ ! -f "$RUNNER_SCRIPT" ]]; then
  fail "Runner not found: $RUNNER_SCRIPT"
else
  ok "Runner exists: $(basename "$RUNNER_SCRIPT")"
  if command -v shellcheck &>/dev/null; then
    if shellcheck --severity=error "$RUNNER_SCRIPT" 2>/dev/null; then
      ok "shellcheck clean"
    else
      fail "shellcheck errors in $(basename "$RUNNER_SCRIPT")"
    fi
  else
    ok "shellcheck not installed — skipping"
  fi
fi

# ── 2. Critical variables RESOLVE in the launching environment ───────────────
# This used to grep the launcher's source for "export VAR". A string in a file is not an
# environment: it missed tier3-metrolinx-run.sh's shared `export A B C` line and demanded
# OUTPUT_DIR/PROJECT_ROOT from a launcher that correctly sets them per lane downstream.
# Which variables matter is declared in config, not here.
echo "[ Critical variables ]"
_req_cfg="$REPO_ROOT/orchestrations/config/preflight-required-env.json"
if [ -f "$_req_cfg" ]; then
  while IFS=$'\t' read -r _var _why; do
    [ -n "$_var" ] || continue
    if [ -n "${!_var:-}" ]; then
      ok "$_var is resolved"
    else
      fail "$_var is unset — $_why"
    fi
  done < <(jq -r '.required | to_entries[] | "\(.key)\t\(.value)"' "$_req_cfg" 2>/dev/null)
  while IFS=$'\t' read -r _var _why; do
    [ -n "$_var" ] || continue
    [ -n "${!_var:-}" ] && ok "$_var is resolved" || echo "  – $_var unset — $_why"
  done < <(jq -r '.advisory | to_entries[] | "\(.key)\t\(.value)"' "$_req_cfg" 2>/dev/null)
else
  fail "preflight-required-env.json missing — cannot tell which variables this run needs"
fi

# ── 3. PRD integrity gate ────────────────────────────────────────────────────
echo "[ PRD integrity ]"
if [[ -z "$PRD_FILE" ]]; then
  fail "No --prd specified (required for integrity gate)"
elif [[ ! -f "$PRD_FILE" ]]; then
  fail "PRD not found: $PRD_FILE"
else
  # Detect canonical (pre-spec-pass) PRD: no story has specification.createdFrom set.
  # Strict phase/field checks only apply to elaborated PRDs — skip them for canonical.
  _prd_is_canonical=$(python3 -c "
import json
d = json.load(open('$PRD_FILE'))
has_splits = any(s.get('specification', {}).get('createdFrom') for s in d.get('stories', []))
print('false' if has_splits else 'true')
" 2>/dev/null || echo "false")

  if [[ "$_prd_is_canonical" == "true" ]]; then
    # Even on a canonical (pre-spec-pass) PRD, no base story should carry a
    # pre-baked 'specification' block (status, coordinatorReview, etc.) from
    # a prior run — the spec-mode coordinator reads this field to decide
    # whether to (re)assign agents, and stale "completed" data silently makes
    # it skip re-elaboration (and the split-mandate check inside that loop)
    # for that story. This has happened once already (2026-07-06); the
    # `has_splits` bypass above wouldn't catch it because these stories have
    # no `createdFrom`, only stale status data. A story already completed=true
    # in THIS run (e.g. SKY-001 after the scaffold phase) legitimately carries
    # its own real specification data from this run's own spec pass — only
    # PENDING stories carrying specification data indicate prior-run
    # contamination baked into canonical.
    _stale_spec=$(python3 -c "
import json
d = json.load(open('$PRD_FILE'))
print(','.join(s['id'] for s in d.get('stories', []) if s.get('specification') and not s.get('completed')))
" 2>/dev/null || echo "")
    if [[ -n "$_stale_spec" ]]; then
      fail "Canonical PRD has pre-baked 'specification' blocks on base stories (must be lean/unelaborated): $_stale_spec"
    else
      _base_count=$(python3 -c "import json; print(len(json.load(open('$PRD_FILE'))['stories']))" 2>/dev/null || echo "?")
      ok "PRD integrity OK — $_base_count base user stories (canonical/pre-spec-pass — strict phase checks deferred until after spec pass elaboration)"
      PASS=$((PASS+1))
    fi
  else
    integrity_out=$(bash "$SCRIPT_DIR/preflight-prd-integrity.sh" --prd "$PRD_FILE" 2>&1) || integrity_exit=$?
    echo "$integrity_out"
    if [[ "${integrity_exit:-0}" -ne 0 ]]; then
      FAIL=$((FAIL+1))
    else
      PASS=$((PASS+1))
    fi
  fi
fi

# ── 4. PRD file valid JSON with required fields ───────────────────────────────
echo "[ PRD file ]"
if [[ -z "$PRD_FILE" ]]; then
  fail "No --prd specified"
elif [[ ! -f "$PRD_FILE" ]]; then
  fail "PRD not found: $PRD_FILE"
else
  ok "PRD exists: $(basename "$PRD_FILE")"
  if python3 -c "import json; json.load(open('$PRD_FILE'))" 2>/dev/null; then
    ok "PRD valid JSON"
  else
    fail "PRD is not valid JSON"
  fi

  # outputDir must be set
  OUTPUT_DIR_VAL=$(python3 -c "import json; d=json.load(open('$PRD_FILE')); print(d.get('project',{}).get('outputDir',''))" 2>/dev/null || true)
  if [[ -n "$OUTPUT_DIR_VAL" ]]; then
    ok "PRD project.outputDir = $OUTPUT_DIR_VAL"
  else
    fail "PRD project.outputDir is NOT set — deliverables check will use wrong path"
  fi

  # The RESOLVED OUTPUT_DIR must agree with the PRD's. This used to scrape `OUTPUT_DIR=`
  # out of the launcher's SOURCE with grep+sed, which is the same anti-pattern as the export
  # check above and failed the same way: tier3-mock-run.sh takes its output directory from
  # --project-root and never spells OUTPUT_DIR= at all, so the scrape produced '' and the
  # pre-flight declared a mismatch against a perfectly correct launcher. A launcher that
  # resolves the directory per lane has nothing to compare here, and saying so is honest.
  if [[ -n "$OUTPUT_DIR_VAL" ]]; then
    if [[ -z "${OUTPUT_DIR:-}" ]]; then
      echo "  – OUTPUT_DIR not resolved in this environment (set per lane downstream) — nothing to compare"
    elif [[ "${OUTPUT_DIR}" == "$OUTPUT_DIR_VAL" ]]; then
      ok "OUTPUT_DIR agrees with PRD outputDir ($OUTPUT_DIR_VAL)"
    else
      fail "OUTPUT_DIR='${OUTPUT_DIR}' does NOT match PRD outputDir='$OUTPUT_DIR_VAL' — deliverables would be checked in the wrong place"
    fi
  fi

  # Story field checks — skip for canonical PRD (aiProvider/model added by spec pass)
  if [[ "$_prd_is_canonical" == "true" ]]; then
    ok "Story field checks deferred — canonical PRD has no implementation stories yet"
    PASS=$((PASS+1))
  else
    python3 << PYEOF
import json, sys
with open('$PRD_FILE') as f:
    d = json.load(f)
stories = d.get('stories', [])
errors = []
warns  = []
valid_providers = {'qwen','openai','anthropic','claude','gemini','codex','cursor','opencode','minimax'}
for s in stories:
    sid = s.get('id','?')
    provider = s.get('aiProvider','')
    model    = s.get('model','')
    effort   = s.get('effort','medium')
    status   = s.get('status','pending')

    if not provider:
        errors.append(f"{sid}: aiProvider is MISSING")
    elif provider not in valid_providers:
        errors.append(f"{sid}: aiProvider='{provider}' is not a known provider")

    if effort == 'low' and provider in ('qwen','openai','anthropic','claude','gemini'):
        warns.append(f"{sid}: effort=low maps to HAIKU badge in viewer — consider 'medium'")

    if status not in ('pending','completed','failed','deprecated'):
        errors.append(f"{sid}: status='{status}' is unexpected")

for e in errors:
    print(f"  ✗ {e}")
for w in warns:
    print(f"  ⚠ {w}")
if not errors:
    print(f"  ✓ All {len(stories)} stories have valid aiProvider/model/status")
sys.exit(1 if errors else 0)
PYEOF
    story_exit=$?
    [[ $story_exit -eq 0 ]] && ((PASS++)) || ((FAIL++))
  fi
fi

# ── 4. Required API keys ──────────────────────────────────────────────────────
echo "[ API keys ]"
# Load .env if present
load_env_file_safe "$REPO_ROOT/.env"

for key in OPENROUTER_API_KEY OPENAI_API_KEY; do
  if [[ -n "${!key:-}" ]]; then
    ok "$key is set"
  else
    fail "$key is NOT set — run will fail"
  fi
done

# RAPIDAPI optional but warn
if [[ -z "${RAPIDAPI_KEY:-}" ]]; then
  echo "  ⚠ RAPIDAPI_KEY not set — API contract discovery story may fail"
fi

# ── Machine-environment checks: on by default ────────────────────────────────
# Sections 5 and 6 and the service probes in 7 assess THIS MACHINE — is the dashboard up,
# is the snapshot watcher alive, is Langfuse answering. A real launch must pass them.
#
# EPAM_PREFLIGHT_ENVIRONMENT=0 assesses the PROJECT only. It exists for callers that invoke
# a launcher without launching on the machine's behalf — mock-launcher-parity.test.ts drives
# the real launcher into a forced-failure phase to prove a failed run still archives its
# evidence, and would otherwise pass or fail with whether a watcher happened to be running.
# It cannot hide a project defect: every project-readiness check still runs and still blocks.
_assess_environment="${EPAM_PREFLIGHT_ENVIRONMENT:-1}"
if [ "$_assess_environment" = "0" ]; then
  echo "[ Machine environment ]"
  echo "  – SKIPPED by EPAM_PREFLIGHT_ENVIRONMENT=0 — project checks below still apply"
  echo ""
fi

# ── 5. Dashboard is up ───────────────────────────────────────────────────────
if [ "$_assess_environment" != "0" ]; then
echo "[ Dashboard ]"
if curl -sf ${_DASH}/prd.json >/dev/null 2>&1; then
  ok "Dashboard serving prd.json at ${_DASH}"
else
  fail "Dashboard not responding — run pre-run-reset.sh first"
fi

# ── 6. Self-heal observability routing ───────────────────────────────────────
# Verifies the full chain: claude.sh writes healing-events.jsonl to LOG_DIR
# (orchestrations/logs), docker mounts orchestrations/logs at /logs-dir, and
# nginx serves /logs/healing-events.jsonl so agent-activity.html and health.html
# both read real data — not stale events from a previous run.
echo "[ Self-heal observability ]"

# 6a. LOG_DIR write path is writable
LOG_DIR_DEFAULT="$(cd "$(dirname "$0")/../logs" 2>/dev/null && pwd || echo '')"
if [[ -d "$LOG_DIR_DEFAULT" ]] && touch "$LOG_DIR_DEFAULT/.preflight-write-test" 2>/dev/null; then
  rm -f "$LOG_DIR_DEFAULT/.preflight-write-test"
  ok "LOG_DIR ($LOG_DIR_DEFAULT) is writable — healing-events.jsonl will land here"
else
  fail "LOG_DIR ($LOG_DIR_DEFAULT) is not writable — self-heal events will be lost"
fi

# 6b. healing-events.jsonl at LOG_DIR is NOT stale from a prior run
# (pre-run-reset.sh should have cleared it; non-empty means it was not reset)
HEAL_LOG="$LOG_DIR_DEFAULT/healing-events.jsonl"
if [[ -s "$HEAL_LOG" ]]; then
  fail "healing-events.jsonl is non-empty from a prior run — run pre-run-reset.sh to clear it (stale data pollutes health.html)"
else
  ok "healing-events.jsonl is empty/absent — clean slate for this run"
fi

# 6c. Dashboard /logs/healing-events.jsonl is served by nginx (routing sanity)
if curl -sf ${_DASH}/logs/healing-events.jsonl >/dev/null 2>&1; then
  ok "nginx serves /logs/healing-events.jsonl — agent-activity.html and health.html will read it"
else
  fail "nginx /logs/healing-events.jsonl not reachable — docker /logs-dir mount may be wrong; run pre-run-reset.sh"
fi

# 6d. build-info.json is fresh and contains selfHealing (health.html depends on it)
if curl -sf "${_DASH}/build-info.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'selfHealing' in d.get('metrics',{}), 'selfHealing missing'" 2>/dev/null; then
  ok "build-info.json has metrics.selfHealing — health.html will render correctly"
else
  fail "build-info.json missing or lacks metrics.selfHealing — health.html will show nothing; check snapshot-watch.js process"
fi

# 6e. Snapshot watcher (snapshot-watch.js) is running — health.html OOMs when
# Eleventy's full watcher runs; snapshot-watch.js is the lightweight replacement.
# If the PID file is missing or the process is dead, build-info.json will never
# update during the run, leaving health.html permanently stale.
SNAP_PID_FILE="$LOG_DIR_DEFAULT/dashboards-watch.pid"
_snap_ok=false
if [[ -f "$SNAP_PID_FILE" ]]; then
  _snap_pid="$(cat "$SNAP_PID_FILE" 2>/dev/null || echo '')"
  if [[ -n "$_snap_pid" ]] && ps -p "$_snap_pid" > /dev/null 2>&1; then
    _snap_ok=true
  else
    # PID file exists but process gone — check if node child is still running
    if pgrep -f 'snapshot-watch.js' > /dev/null 2>&1; then _snap_ok=true; fi
  fi
fi
if [[ "$_snap_ok" == "true" ]]; then
  ok "snapshot-watch.js is running — build-info.json will refresh every 10s"
else
  fail "snapshot-watch.js is NOT running — health.html will stay permanently stale during the run; start it with: node orchestrations/scripts/snapshot-watch.js 10 &"
fi

# 6f. build-info.json was generated recently (within 120s) — proves the watcher
# is actively refreshing, not just present-but-stalled.
_generated_at=$(curl -sf "${_DASH}/build-info.json" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('generatedAt',''))" 2>/dev/null || echo '')
if [[ -n "$_generated_at" ]]; then
  _age_s=$(python3 -c "
import datetime, sys
try:
    ts = datetime.datetime.fromisoformat('$_generated_at'.replace('Z','+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(int((now-ts).total_seconds()))
except Exception as e:
    print(9999)
" 2>/dev/null || echo 9999)
  if [[ "$_age_s" -lt 120 ]]; then
    ok "build-info.json is ${_age_s}s old — snapshot watcher is actively refreshing"
  else
    fail "build-info.json is ${_age_s}s old (> 120s) — snapshot watcher may be stalled; kill and restart snapshot-watch.js"
  fi
else
  fail "build-info.json missing generatedAt field — snapshot watcher may be writing corrupted output"
fi

fi

# ── 7. PROJECT READINESS ─────────────────────────────────────────────────────
# Added 2026-08-05. Four launches that day died on conditions nothing checked before
# spending: a stale dist (twice, caught by a phase gate AFTER the run started), a dead
# observability stack, and a project with no synthesis template that silently ran under
# ANOTHER project's identity. A pre-flight that does not assess the PROJECT is not
# assessing what actually breaks.
echo "[ Project readiness ]"

# dist/ must be newer than src/ — the pipeline executes dist/epam.js, so a stale bundle
# means the code under test is not the code that runs.
_newest_src=$(find "$REPO_ROOT/src" -name '*.ts' -newer "$REPO_ROOT/dist/epam.js" -print -quit 2>/dev/null)
if [ ! -f "$REPO_ROOT/dist/epam.js" ]; then
  fail "dist/epam.js missing — the pipeline runs dist, not src. Build with: node ./node_modules/.bin/tsup"
elif [ -n "$_newest_src" ]; then
  fail "dist/ is STALE (e.g. $(basename "$_newest_src")) — source changes would NOT execute. Rebuild with tsup."
else
  ok "dist/ is newer than src/"
fi

# The project must own its synthesis template. Without one, synthesize-prd-from-jira.js
# falls back to another project's canonical and inherits ITS project block — observed
# 2026-08-05: hello-dolly runs were labelled project.name: skyscanner-app.
if [ -n "${PROJECT_CONFIG_DIR:-}" ]; then
  if [ -f "${PROJECT_CONFIG_DIR}/prd.canonical.json" ]; then
    ok "project has its own prd.canonical.json (no borrowed identity)"
  else
    fail "no prd.canonical.json in ${PROJECT_CONFIG_DIR} — synthesis will fall back to ANOTHER project's template and this run will be labelled with that project's name"
  fi
else
  echo "  – project config dir not given (--project-config); skipping template check"
fi

# Observability: a run aborts at the tier launcher's own preflight when these are down, so
# finding out here costs nothing and saves a launch cycle.
if [ "${EPAM_PREFLIGHT_SKIP_NETWORK:-0}" != "1" ] && [ "$_assess_environment" != "0" ]; then
  for _svc in langfuse grafana; do
    _url=""
    if [ -f "$SCRIPT_DIR/lib/service-urls.sh" ]; then
      # shellcheck source=lib/service-urls.sh
      . "$SCRIPT_DIR/lib/service-urls.sh" 2>/dev/null || true
      _url="$(service_url "$_svc" 2>/dev/null || true)"
    fi
    [ -n "$_url" ] || continue
    _code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$_url" 2>/dev/null || echo "000")
    if [ "$_code" = "000" ]; then
      fail "${_svc} NOT serving at ${_url} — the run will abort at the observability preflight"
    else
      ok "${_svc} serving (HTTP ${_code})"
    fi
  done
fi
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "━━━ ✓ All $PASS checks passed — safe to run ━━━"
  exit 0
else
  echo "━━━ ✗ $FAIL check(s) FAILED — DO NOT run pipeline ━━━" >&2
  exit 1
fi
