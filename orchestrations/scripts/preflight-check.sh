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
    _base_count=$(python3 -c "import json; print(len(json.load(open('$PRD_FILE'))['stories']))" 2>/dev/null || echo "?")
    ok "PRD integrity OK — $_base_count base user stories (canonical/pre-spec-pass — strict phase checks deferred until after spec pass elaboration)"
    PASS=$((PASS+1))
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

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "━━━ ✓ All $PASS checks passed — safe to run ━━━"
  exit 0
else
  echo "━━━ ✗ $FAIL check(s) FAILED — DO NOT run pipeline ━━━" >&2
  exit 1
fi
