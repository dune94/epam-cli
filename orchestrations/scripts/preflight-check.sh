#!/usr/bin/env bash
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

# ── Args ─────────────────────────────────────────────────────────────────────
RUNNER_SCRIPT=""
PRD_FILE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --runner) RUNNER_SCRIPT="$SCRIPT_DIR/$2"; shift 2 ;;
    --prd)    PRD_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
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

# ── 2. Runner exports critical vars ──────────────────────────────────────────
echo "[ Critical exports in runner ]"
if [[ -f "$RUNNER_SCRIPT" ]]; then
  for var in OUTPUT_DIR PROJECT_ROOT PRD_FILE ORCH_GATE_MODEL ORCH_GATE_PROVIDER; do
    if grep -q "export ${var}" "$RUNNER_SCRIPT"; then
      ok "export $var present"
    else
      fail "export $var MISSING in $(basename "$RUNNER_SCRIPT")"
    fi
  done
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

  # Runner OUTPUT_DIR must match PRD outputDir
  if [[ -f "$RUNNER_SCRIPT" && -n "$OUTPUT_DIR_VAL" ]]; then
    RUNNER_OUTPUT=$(grep 'OUTPUT_DIR=' "$RUNNER_SCRIPT" | grep -v '^#' | head -1 | sed 's/.*OUTPUT_DIR="\?\([^"]*\)"\?.*/\1/' | sed 's/\${\([A-Z_]*\):-\(.*\)}/\2/')
    if [[ "$RUNNER_OUTPUT" == "$OUTPUT_DIR_VAL" ]]; then
      ok "Runner OUTPUT_DIR matches PRD outputDir ($OUTPUT_DIR_VAL)"
    else
      fail "Runner OUTPUT_DIR='$RUNNER_OUTPUT' does NOT match PRD outputDir='$OUTPUT_DIR_VAL'"
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
[[ -f .env ]] && set -a && source .env 2>/dev/null && set +a || true

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

# ── 5. Dashboard is up ───────────────────────────────────────────────────────
echo "[ Dashboard ]"
if curl -sf http://localhost:8092/prd.json >/dev/null 2>&1; then
  ok "Dashboard serving prd.json at http://localhost:8092"
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
if curl -sf http://localhost:8092/logs/healing-events.jsonl >/dev/null 2>&1; then
  ok "nginx serves /logs/healing-events.jsonl — agent-activity.html and health.html will read it"
else
  fail "nginx /logs/healing-events.jsonl not reachable — docker /logs-dir mount may be wrong; run pre-run-reset.sh"
fi

# 6d. build-info.json is fresh and contains selfHealing (health.html depends on it)
if curl -sf "http://localhost:8092/build-info.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'selfHealing' in d.get('metrics',{}), 'selfHealing missing'" 2>/dev/null; then
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
_generated_at=$(curl -sf "http://localhost:8092/build-info.json" 2>/dev/null \
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

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "━━━ ✓ All $PASS checks passed — safe to run ━━━"
  exit 0
else
  echo "━━━ ✗ $FAIL check(s) FAILED — DO NOT run pipeline ━━━" >&2
  exit 1
fi
