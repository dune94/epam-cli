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

# Is PRD_FILE about to be OVERWRITTEN by this run's own Jira ingest, before anything
# downstream ever reads today's content? ingest-jira-tickets.sh writes to
# JIRA_SYNTH_PRD_PATH if set, else falls through to PRD_FILE (run-agent-orchestration.sh
# `"${JIRA_SYNTH_PRD_PATH:-${PRD_FILE:-...}}"`). Whenever that target IS PRD_FILE, whatever
# is on disk right now is LAST run's leftover, not this run's input — checking its content
# is checking the wrong PRD.
#
# Caught live 2026-08-05: a metrolinx pre-flight failed on "pre-baked specification blocks"
# on AMSD-2041 in orchestrations/projects/metrolinx/prd.json — real contamination, but from
# the PREVIOUS run, about to be discarded by ingest before the writer ever runs. The earlier
# version of this guard only recognised a genuinely EMPTY placeholder (mock1's shape) and
# missed this — a non-empty stale file about to be overwritten is the same situation.
# The project's declared codeline root, read the same way the launcher reads it. Its presence is
# what tells this gate that scope — and therefore outputDir — is resolved during the run.
_codeline_root="${JIRA_CODELINE_ROOT:-}"
if [[ -z "$_codeline_root" ]] && [[ -n "${PROJECT_CONFIG_DIR:-}" ]] && [[ -f "${PROJECT_CONFIG_DIR}/config.env" ]]; then
  _codeline_root=$(sed -n 's/^[[:space:]]*JIRA_CODELINE_ROOT=//p' "${PROJECT_CONFIG_DIR}/config.env" \
                   | tail -1 | tr -d '"'"'"'"' )
fi

_prd_pending_ingest=0
if [[ -n "${JIRA_URL:-}" ]] && [[ -n "$PRD_FILE" ]]; then
  _synth_target="${JIRA_SYNTH_PRD_PATH:-$PRD_FILE}"
  if [[ -n "$_synth_target" ]] && [[ "$(cd "$(dirname "$_synth_target")" 2>/dev/null && pwd)/$(basename "$_synth_target")" == "$PRD_FILE" ]]; then
    _prd_pending_ingest=1
  fi
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
  _prd_is_canonical=$(python3 "$SCRIPT_DIR/lib/handlers/prd-is-canonical.py" "$PRD_FILE" 2>/dev/null || echo "false")

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
    _stale_spec=$(python3 "$SCRIPT_DIR/lib/handlers/prd-stale-specification-stories.py" "$PRD_FILE" 2>/dev/null || echo "")
    # A RESUME LEGITIMATELY CARRIES ITS OWN SPEC PASS.
    #
    # This gate reads a pending story's specification block as a PRIOR run baked into the
    # canonical, which is right for a fresh run and has fired for real (2026-07-06). A resume is
    # the second case it cannot distinguish, alongside the pending-ingest one below: the blocks
    # belong to the run being resumed, and that run IS this run. On 2026-08-18 it refused the
    # resume of 20260818T101809Z — whose canonical was correctly lean while the runtime PRD held
    # 6 and 3 verification criteria, 2 fix sites each and both roles — for carrying exactly the
    # output the resume exists to reuse.
    if [[ -n "$_stale_spec" ]] && [[ -n "${EPAM_RESUME_RUN:-}" ]]; then
      ok "PRD carries specification data for the run being resumed (EPAM_RESUME_RUN=${EPAM_RESUME_RUN}) — this is the resumed run's own output, not a prior run's"
      PASS=$((PASS+1))
    elif [[ -n "$_stale_spec" ]] && [[ "$_prd_pending_ingest" != "1" ]]; then
      fail "Canonical PRD has pre-baked 'specification' blocks on base stories (must be lean/unelaborated): $_stale_spec"
    elif [[ -n "$_stale_spec" ]]; then
      ok "PRD carries stale specification data from a prior run, but Jira ingest overwrites this exact file before anything reads it — deferred"
      PASS=$((PASS+1))
    else
      _base_count=$(python3 "$SCRIPT_DIR/lib/handlers/prd-story-count.py" "$PRD_FILE" 2>/dev/null || echo "?")
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
  elif [[ "$_prd_pending_ingest" == "1" ]]; then
    ok "PRD content is pending Jira ingest for this run — outputDir check deferred"
  elif [[ -n "$_codeline_root" ]]; then
    # DEFERRED FOR THE SAME REASON, ARRIVED AT DIFFERENTLY.
    #
    # project.outputDir is WRITTEN BY THE RUN: resolve-codeline-scope.sh calls
    # apply-codeline-scope.js, which sets outputDirs and outputDir from the codelines it
    # discovers. So this gate demanded a field the pipeline had not created yet, and no
    # PRD-authored project could ever pass it.
    #
    # The deferral above already exists for the Jira path — the same reasoning, keyed to
    # ingest. That is the Step 0.3 shape again: a mechanism written only for the branch it was
    # first needed on. A project that declares a codeline root resolves its scope the same way,
    # whether its PRD arrived from Jira or was authored by hand.
    ok "codeline scope is resolved during the run (root: $_codeline_root) — outputDir check deferred"
  else
    fail "PRD project.outputDir is NOT set, and no codeline root is declared to resolve it from"
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
    python3 "$SCRIPT_DIR/lib/handlers/prd-story-assignment-check.py" "$PRD_FILE" "$SCRIPT_DIR/../config/providers.json"
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

# ── 5. Every assigned model is a rung of a declared ladder ───────────────────
#
# A model absent from the chain cannot escalate: the successor lookup returns EMPTY,
# which every call site reads as "already at the top rung". The story then burns all of
# its attempts on one model and the log is indistinguishable from a legitimate ceiling.
#
# Live, run 20260814T224748Z: the prd-model-coordinator assigned `gpt-5-codex`, a model
# on no ladder this project declares. Its own deterministic reviewer checks STRUCTURE —
# which fields changed, whether stories were added — and never membership. The run only
# escaped because ladder position had persisted from an earlier run and it resumed
# mid-chain, ignoring the PRD's assignment entirely.
#
# Here rather than in one launcher: this file is what all eight launchers pre-flight
# through, and the same coordinator writes the PRD for every one of them.
echo "[ Model ladders ]"
_mlm_lib="$SCRIPT_DIR/lib/model-ladder-membership.sh"
_mlm_settings="${EPAM_LLM_SETTINGS_FILE:-${PROJECT_CONFIG_DIR:-}/llm-settings.json}"
if [[ ! -f "$_mlm_lib" ]]; then
  fail "lib/model-ladder-membership.sh missing — cannot verify assigned models can escalate"
elif [[ -z "${PRD_FILE:-}" || ! -f "${PRD_FILE:-}" ]]; then
  echo "  ⚠ no PRD to check model assignments against"
elif [[ ! -f "$_mlm_settings" ]]; then
  # UNKNOWN, not fine: a project whose ladders cannot be read must not look verified.
  fail "no llm-settings.json at '$_mlm_settings' — cannot tell whether assigned models can escalate"
else
  # shellcheck source=lib/model-ladder-membership.sh
  . "$_mlm_lib"
  if stories_with_unladdered_models "$PRD_FILE" "$_mlm_settings"; then
    ok "every assigned model is a rung of a declared ladder"
  else
    fail "a story is assigned a model that is on no declared ladder (see above) — it could never escalate"
  fi
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
# Honour an inherited LOG_DIR. This resolved ../logs unconditionally, so a run told to keep
# its artefacts elsewhere — a test run inside its own perimeter — still had the SHARED client
# log directory probed and reported here, and the operator was told artefacts would land in a
# directory the run never writes to.
LOG_DIR_DEFAULT="${LOG_DIR:-$(cd "$(dirname "$0")/../logs" 2>/dev/null && pwd || echo '')}"
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
# The watcher is a MACHINE-level daemon feeding the dashboards, not a per-run artefact, so its
# PID file lives with those dashboards rather than in whichever log directory this run happens
# to own. Reading it from LOG_DIR meant a run keeping its artefacts elsewhere looked for the
# file in its own empty directory and concluded the watcher was dead.
SNAP_PID_FILE="$(cd "$(dirname "$0")/../logs" 2>/dev/null && pwd || echo '')/dashboards-watch.pid"
_snap_ok=false
if [[ -f "$SNAP_PID_FILE" ]]; then
  _snap_pid="$(cat "$SNAP_PID_FILE" 2>/dev/null || echo '')"
  if [[ -n "$_snap_pid" ]] && ps -p "$_snap_pid" > /dev/null 2>&1; then
    _snap_ok=true
  fi
fi
# A RUNNING WATCHER WITH NO PID FILE IS STILL A RUNNING WATCHER.
#
# This fallback used to sit INSIDE the `-f "$SNAP_PID_FILE"` branch above, so it was reachable
# only when a PID file already existed. Started by hand — which is exactly what the check's own
# error message tells you to do — the watcher leaves no PID file, and the check then reported it
# dead while it was demonstrably polling every ten seconds. The next check (6f) proves it is
# actually refreshing, so this one only has to establish that it exists.
if [[ "$_snap_ok" != "true" ]] && pgrep -f 'snapshot-watch.js' > /dev/null 2>&1; then
  _snap_ok=true
fi
if [[ "$_snap_ok" == "true" ]]; then
  ok "snapshot-watch.js is running — build-info.json will refresh every 10s"
else
  fail "snapshot-watch.js is NOT running — health.html will stay permanently stale during the run; start it with: node orchestrations/scripts/snapshot-watch.js 10 &"
fi

# 6f. build-info.json was generated recently (within 120s) — proves the watcher
# is actively refreshing, not just present-but-stalled.
_generated_at=$(curl -sf "${_DASH}/build-info.json" 2>/dev/null \
  | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" generatedAt 2>/dev/null || echo '')
if [[ -n "$_generated_at" ]]; then
  _age_s=$(python3 "$SCRIPT_DIR/lib/handlers/iso-timestamp-age-seconds.py" "$_generated_at" 2>/dev/null || echo 9999)
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
# THE CHECK IS GONE BECAUSE THE TEMPLATE IS. It required every project to ship its own stored PRD
# template, because synthesis filled one and would otherwise borrow another project's identity.
# Synthesis now builds the PRD from the tracker and the project's own config, so there is no
# template to own and no identity to borrow.
if [ -n "${PROJECT_CONFIG_DIR:-}" ]; then
  if [ -n "${PROJECT_NAME:-}" ]; then
    ok "project declares its own name (${PROJECT_NAME}) — synthesis has an identity of its own"
  else
    fail "PROJECT_NAME is not set — the synthesised PRD would carry no project identity at all"
  fi
else
  echo "  – project config dir not given (--project-config); skipping identity check"
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
