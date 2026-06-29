#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Tier 3: Travel App (Skyscanner) — DeepSeek V3 story agents + GPT-4o gates.
#
# Runs all three phases in sequence:
#   scaffold → core → ui_and_review
#
# Prerequisites:
#   - OPENROUTER_API_KEY set (DeepSeek V3 story agents)
#   - OPENAI_API_KEY set (GPT-4o coordinator + gates)
#   - RAPIDAPI_KEY set (SKY-001b API contract discovery)
#
# Estimated cost: $0.05–0.15 (11 stories, all low effort, DeepSeek pricing)
#
# Usage:
#   OPENROUTER_API_KEY=<key> OPENAI_API_KEY=<key> bash orchestrations/scripts/tier3-travel-app-run.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="/tmp/tier3-travel-app-run-$(date +%Y%m%dT%H%M%S).log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${YELLOW}[tier3-travel]${NC} $*"; }
success() { echo -e "${GREEN}[tier3-travel] ✓${NC} $*"; }
fail()    { echo -e "${RED}[tier3-travel] ✗${NC} $*"; exit 1; }

# Load .env if keys not already in environment
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

[ -z "${OPENROUTER_API_KEY:-}" ] && fail "OPENROUTER_API_KEY is not set. Export it or add it to .env"
[ -z "${OPENAI_API_KEY:-}" ]     && fail "OPENAI_API_KEY is not set (needed for GPT-4o gates)"

# Auto-confirm when: --yes/-y flag, CI env var set, or no TTY (non-interactive shell)
AUTO_YES=false
for arg in "$@"; do [[ "$arg" == "--yes" || "$arg" == "-y" ]] && AUTO_YES=true; done
[[ "${CI:-}" == "true" || "${AUTO_YES_TIER3:-}" == "1" ]] && AUTO_YES=true
[[ ! -t 0 ]] && AUTO_YES=true

PRD_FILE="$REPO_ROOT/orchestrations/travel-app-prd.json"
OUTPUT_DIR="${OUTPUT_DIR:-/home/bradleyjerome/projects/skyscanner-app}"

info "Tier 3 travel app run — DeepSeek V3 agents + GPT-4o gates (USES CREDITS)"
info "  PRD: $PRD_FILE"
info "  Output: $OUTPUT_DIR"
info "  Estimated cost: \$0.05–0.15"
info "  Log: $LOG_FILE"
echo ""

if [ "$AUTO_YES" = true ]; then
  info "Auto-confirmed (--yes flag)"
else
  read -rp "$(echo -e "${YELLOW}Confirm: spend OpenRouter + OpenAI credits? [yes/N]${NC} ")" confirm
  [ "$confirm" != "yes" ] && { info "Aborted."; exit 0; }
fi

cd "$REPO_ROOT"

# Capture spend baseline
_usage_before=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
info "OpenRouter usage before: \$$_usage_before"
echo ""

# Tear down the entire output directory before every run.
# DELETE EVERYTHING — not a git clean, not a status reset, full rm -rf.
# Stale package.json, tsconfig, test files, and accumulated artifacts from
# prior runs all poison the next run. The only safe state is no state.
info "Tearing down output directory: $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
git -C "$OUTPUT_DIR" init --quiet
git -C "$OUTPUT_DIR" commit --allow-empty -m "init: skyscanner-app" --quiet
info "Output directory clean (deleted and reinitialised)"

# Export all required env vars directly so subprocesses inherit them without
# an `env` wrapper array (which caused silent exit due to empty-var expansion).
export OUTPUT_DIR
export PROJECT_ROOT="$OUTPUT_DIR"
export OPENROUTER_API_KEY
export EPAM_API_KEY_OPENROUTER="$OPENROUTER_API_KEY"
export OPENAI_API_KEY
export EPAM_API_KEY_OPENAI="$OPENAI_API_KEY"
export ORCH_GATE_PROVIDER="minimax"
export EPAM_ORCHESTRATION_PROVIDER="minimax"
export ORCH_GATE_MODEL="MiniMax-M3"
export SPEC_MODE_PROVIDER="qwen"
export SPEC_MODE_OPENSPEC_MODEL="${SPEC_MODE_OPENSPEC_MODEL:-moonshotai/kimi-k2}"
export SPEC_MODE_SPECKIT_MODEL="${SPEC_MODE_SPECKIT_MODEL:-zhipuai/glm-4-plus}"
export SPEC_MODE_MODEL="${SPEC_MODE_MODEL:-moonshotai/kimi-k2}"
export MINIMAX_TOOL_TIMEOUT_MS="${MINIMAX_TOOL_TIMEOUT_MS:-15000}"
export ORCH_MINI_MODEL="${ORCH_MINI_MODEL:-MiniMax-M2.5}"
export ORCH_UPGRADE_MODEL="${ORCH_UPGRADE_MODEL:-MiniMax-M3}"
export EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-moonshotai/kimi-k2}"
export EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-qwen}"
export PRD_FILE
export SKIP_REGRESSION_GUARD=true
export EPAM_RALPH_WIGGUM_ENABLED=0
export EPAM_STORY_TIMEOUT_SECS=600
export EPAM_MAX_RETRIES=3
export SKIP_BROWSER_E2E_ROUTING=true
[ -n "${RAPIDAPI_KEY:-}" ] && export RAPIDAPI_KEY

PIPELINE_EXIT=0

# ── Canonical restore: prd.json + profiles.json ──────────────────────────────
# Every run starts from the canonical originals so accumulated agent mutations
# (split stories, extra profiles, stale statuses) never carry forward.
# profiles.json.original is the authoritative set of agent profiles.
# prd.json canonical is kept in git — restore it and strip orphan stories
# (stories not in implementationOrder) so the file stays tight.
# profiles.json.original is the canonical floor: all core agents + any non-core
# agents added for this project's scaffolding. Update it whenever a new permanent
# agent is introduced. The test in profiles-canonical.test.ts asserts that all
# core pipeline agents are present. Restore from it before each run so
# agent-accumulated mutations (extra profiles written by profile-augmentor) never
# carry forward across runs.
PROFILES_ORIG="$REPO_ROOT/orchestrations/agents/profiles.json.original"
if [ -f "$PROFILES_ORIG" ]; then
  cp "$PROFILES_ORIG" "$REPO_ROOT/orchestrations/agents/profiles.json"
  info "profiles.json restored from canonical original ($(python3 -c "import json; print(len(json.load(open('$PROFILES_ORIG'))))" 2>/dev/null || echo '?') profiles)"
else
  info "profiles.json.original not found — skipping profiles restore"
fi

# Restore prd.json from the CANONICAL file — never from git HEAD.
# git HEAD accumulates runtime split children across runs; the canonical file
# contains only the 12 curated base stories and is never mutated at runtime.
PRD_CANONICAL="$REPO_ROOT/orchestrations/travel-app-prd.canonical.json"
if [ ! -f "$PRD_CANONICAL" ]; then
  fail "travel-app-prd.canonical.json not found — cannot restore clean PRD. Aborting."
fi
# Restore from canonical (4 base user stories). The spec pass (Step 0) elaborates these
# into implementation stories each run. SKY-005 and SKY-006 are generated dynamically.
cp "$PRD_CANONICAL" "$PRD_FILE"
_canonical_count=$(jq '.stories | length' "$PRD_FILE" 2>/dev/null || echo '?')
info "prd.json restored from canonical file ($_canonical_count base user stories)"
echo ""

# ── Pre-run PRD remediation (before preflight, so stale artifacts don't block) ─
# Removes BUG-* stories, stale splits, extra phases, completed-state flags, and
# oversized ACs left by any previous failed run. The preflight then sees a clean PRD.
info "Pre-run PRD remediation..."
if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE"; then
  fail "Pre-run PRD remediation failed — aborting. Fix prd.json manually."
fi
echo ""

# ── PRD integrity guard — abort if canonical restore produced a corrupt PRD ──
# Checks: no accumulated split children (stories whose parent is also in the PRD),
# all stories pending. If either fails, the canonical file itself is corrupt and
# must be manually repaired before running.
python3 - "$PRD_FILE" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
# After restoring from canonical, the PRD has only the 4 base user stories.
# Any mid-execution splits from a prior run must not be present.
mid_exec = [s['id'] for s in d['stories']
            if s.get('specification', {}).get('splitOrigin') == 'mid-execution']
dirty = [s['id'] for s in d['stories']
         if s.get('status') not in ('pending', 'deprecated') and s.get('deprecated') is not True]
errors = []
if mid_exec:
    errors.append(f"ABORT: PRD has {len(mid_exec)} mid-execution splits from a prior run — canonical restore failed: {mid_exec}")
if dirty:
    errors.append(f"ABORT: PRD has {len(dirty)} stories with non-pending status: {dirty}")
if errors:
    for e in errors: print(e, file=sys.stderr)
    sys.exit(1)
print(f"  PRD integrity OK: {len(d['stories'])} stories, all pending, zero mid-execution splits")
PYEOF
if [ $? -ne 0 ]; then
  fail "PRD integrity check failed — canonical file is corrupt. Repair travel-app-prd.canonical.json before running."
  exit 1
fi
echo ""

# ── Pre-flight validation ─────────────────────────────────────────────────────
if ! bash orchestrations/scripts/preflight-check.sh \
     --runner tier3-travel-app-run.sh \
     --prd "$PRD_FILE"; then
  fail "Pre-flight checks failed — aborting run. Fix issues above first."
  exit 1
fi
echo ""

run_phase() {
  local phase="$1"
  info "━━━ Phase: $phase ━━━"

  # Auto-remediate PRD before every phase: removes stale splits, trims ACs,
  # resets story state, and verifies integrity. Prevents run failures from
  # prior-run mutations without requiring manual intervention.
  info "  Pre-phase PRD remediation..."
  if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" 2>&1 | tee -a "$LOG_FILE"; then
    fail "PRD remediation failed for phase '$phase' — aborting. Fix prd.json manually."
  fi
  echo ""

  local phase_exit=0
  bash orchestrations/scripts/run-agent-orchestration.sh \
    --phase "$phase" \
    --reset \
    2>&1 | tee -a "$LOG_FILE" || phase_exit=${PIPESTATUS[0]}
  echo ""

  # exit 2 = gate remediation was applied — reset stories and retry once
  if [ "$phase_exit" -eq 2 ]; then
    info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
    if ! bash "$SCRIPT_DIR/prd-remediate.sh" --prd "$PRD_FILE" 2>&1 | tee -a "$LOG_FILE"; then
      fail "PRD remediation failed during self-healing retry for phase '$phase'"
    fi
    echo ""
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

# ── Scope-guard snapshot ─────────────────────────────────────────────────────
# Take a snapshot of all .ts source files before any agent runs. This baseline
# is used by run_external_verification() in claude.sh to restore files outside
# a story's declared scope before running npm test — so Bash-based file writes
# cannot contaminate test results for stories that don't own those files.
SCOPE_GUARD_BACKUP_DIR="/tmp/sg-backup-$$"
export SCOPE_GUARD_BACKUP_DIR
if [ -d "$PROJECT_ROOT/src" ]; then
  mkdir -p "$SCOPE_GUARD_BACKUP_DIR"
  (cd "$PROJECT_ROOT" && find src -name "*.ts" | while IFS= read -r f; do
    mkdir -p "$SCOPE_GUARD_BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$SCOPE_GUARD_BACKUP_DIR/$f"
  done)
  info "[scope-guard] Source snapshot created at $SCOPE_GUARD_BACKUP_DIR ($(find "$SCOPE_GUARD_BACKUP_DIR" -name '*.ts' | wc -l) files)"
fi

run_phase "scaffold"
run_phase "core"
run_phase "ui_and_review"

# Report spend
_usage_after=$(curl -s "https://openrouter.ai/api/v1/auth/key" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 2>/dev/null | \
  node -e "process.stdout.write(''+JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.usage)" 2>/dev/null || echo "0")
_spent=$(node -e "console.log(($_usage_after-$_usage_before).toFixed(4))" 2>/dev/null || echo "?")
info "OpenRouter usage after: \$$_usage_after"
info "Total spent this run: \$$_spent"
echo ""

# Validate all stories from implementationOrder — read dynamically, never hardcoded
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
    echo -e "${RED}[tier3-travel] ✗${NC} $story: $status"
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
if [ -n "$FAIL_LIST" ] || [ "$PIPELINE_EXIT" -ne 0 ]; then
  fail "Tier 3 travel app FAILED — stories not completed:$FAIL_LIST"
fi

success "Tier 3 travel app PASSED — all $PASS stories complete"
echo ""
echo "  App built at: $OUTPUT_DIR"
echo "  Log: $LOG_FILE"
echo "  Check OpenRouter dashboard for actual token costs."
