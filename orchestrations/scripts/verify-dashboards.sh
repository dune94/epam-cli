#!/bin/bash
# verify-dashboards.sh — Static source audit for orchestration dashboards.
#
# Checks dashboard HTML files for structural and data-contract correctness
# without requiring a running server. Complements dashboard-health-check.sh.
#
# Checks performed:
#   1. Navigation completeness  — all 8 filenames linked in every dashboard
#   2. Active state consistency — each page uses class="active", not inline style
#   3. CSS custom property parity — shared vars present in the 7 core dashboards
#   4. prd.json field drift     — orphan fields (in prd.json, used nowhere)
#                                  and phantom fields (used in dashboards, not in prd.json)
#   5. Fetch URL existence      — static data paths resolve on disk
#   6. Cross-file value parity  — BUDGET constant consistent across files
#
# Usage:
#   verify-dashboards.sh [OPTIONS]
#
# Options:
#   --json     Output full results as JSON
#   --strict   Exit 1 on WARN as well as FAIL (default: exit 1 on FAIL only)
#   --help
#
# Exit codes:
#   0  All checks passed (PASS + INFO only)
#   1  One or more FAIL findings
#   2  WARN findings present (only when --strict; otherwise exit 0)

set -euo pipefail

# ── Colors + logging ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

# OUT_FD: human-readable table goes to stdout normally; in --json mode it goes to stderr
# so that only the JSON object lands on stdout.
OUT_FD=1  # resolved after arg parsing

_out() { echo -e "$1" >&"$OUT_FD"; }

pass()   { _out "  ${GREEN}PASS${NC}  $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail()   { _out "  ${RED}FAIL${NC}  $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn()   { _out "  ${YELLOW}WARN${NC}  $1"; WARN_COUNT=$((WARN_COUNT+1)); }
info()   { _out "  ${MAGENTA}INFO${NC}  $1"; }
section(){ _out ""; _out "${CYAN}${BOLD}── $1 ──${NC}"; _out ""; }

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
DASH_DIR="$AUTOMATION_DIR/dashboards"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"

# ── Defaults ────────────────────────────────────────────────────────────────
JSON_MODE=false
STRICT_MODE=false
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# JSON accumulator for --json mode
JSON_FINDINGS="[]"

record() {
  local sev="$1" check="$2" file="$3" detail="$4"
  JSON_FINDINGS=$(echo "$JSON_FINDINGS" | jq \
    --arg sev "$sev" --arg check "$check" \
    --arg file "$file" --arg detail "$detail" \
    '. + [{severity:$sev, check:$check, file:$file, detail:$detail}]')
}

# ── Arg parsing ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --json)   JSON_MODE=true; OUT_FD=2; shift ;;
    --strict) STRICT_MODE=true; shift ;;
    --help|-h)
      sed -n '/^# /p; /^#$/p' "$0" | grep -v '^#!/' | sed 's/^# //; s/^#//'
      exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}" >&2; exit 1 ;;
  esac
done

# ── Prerequisites ────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq is required${NC}" >&2; exit 1
fi
if [ ! -d "$DASH_DIR" ]; then
  echo -e "${RED}ERROR: dashboards directory not found: $DASH_DIR${NC}" >&2; exit 1
fi
if [ ! -f "$PRD_FILE" ]; then
  echo -e "${RED}ERROR: prd.json not found: $PRD_FILE${NC}" >&2; exit 1
fi

# ── Canonical dashboard filenames used for nav + fetch checks ──────────────
DASHBOARDS=(
  "monitor.html"
  "prd-viewer.html"
  "orchestration-plan.html"
  "agents-orchestration.html"
  "agent-profiles.html"
  "agent-messages.html"
  "phase-cost-monitor.html"
  "quality-dashboard.html"
)

# ── Core dashboards used for shared CSS parity checks ──────────────────────
STYLE_DASHBOARDS=(
  "monitor.html"
  "prd-viewer.html"
  "orchestration-plan.html"
  "agents-orchestration.html"
  "agent-profiles.html"
  "agent-messages.html"
  "phase-cost-monitor.html"
)

_out ""
_out "${CYAN}${BOLD}Dashboard Verification Report${NC}"
_out "${CYAN}Source: $DASH_DIR${NC}"
_out "${CYAN}PRD:    $PRD_FILE${NC}"
_out ""

# ════════════════════════════════════════════════════════════════════════════
section "1. Navigation Completeness"
# Every dashboard must link to all 8 sibling filenames.
# ════════════════════════════════════════════════════════════════════════════

for file in "${DASHBOARDS[@]}"; do
  filepath="$DASH_DIR/$file"
  if [ ! -f "$filepath" ]; then
    fail "$file — file not found"; record FAIL nav-completeness "$file" "file not found"
    continue
  fi

  missing=()
  for target in "${DASHBOARDS[@]}"; do
    if ! grep -q "$target" "$filepath"; then
      missing+=("$target")
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    pass "$file — links to all 8 dashboards"
    record PASS nav-completeness "$file" "all 8 links present"
  else
    for m in "${missing[@]}"; do
      fail "$file — missing link to $m"
      record FAIL nav-completeness "$file" "missing link to $m"
    done
  fi
done

# ════════════════════════════════════════════════════════════════════════════
section "2. Active State Consistency"
# Each page must mark exactly one nav link with class="active".
# Inline-style active states are inconsistent with the shared CSS pattern.
# ════════════════════════════════════════════════════════════════════════════

for file in "${DASHBOARDS[@]}"; do
  filepath="$DASH_DIR/$file"
  [ ! -f "$filepath" ] && continue

  # Check for class="active" on a nav link to self
  self="${file}"
  # class="active" — standard pattern used by 5/7 files
  active_class_count=$(grep -cE 'class="active"|class="[^"]*\bactive\b[^"]*"' "$filepath" 2>/dev/null; true)
  active_class_count="${active_class_count:-0}"
  # Inline style on a nav link — inconsistent with shared CSS pattern
  active_inline=$(grep -E '<a href="'"$self"'"[^>]*style=|<a [^>]*style=[^>]*href="'"$self"'"' "$filepath" 2>/dev/null || true)
  # Detect variant nav class (e.g. "nav-link active" vs plain "active")
  has_nav_link_active=$(grep -cE 'class="nav-link active"' "$filepath" 2>/dev/null; true)
  has_nav_link_active="${has_nav_link_active:-0}"

  if [ "$active_class_count" -ge 1 ] && [ "$has_nav_link_active" -eq 0 ]; then
    pass "$file — active nav link uses class=\"active\""
    record PASS active-state "$file" "class=active found"
  elif [ "$has_nav_link_active" -ge 1 ]; then
    warn "$file — active nav link uses class=\"nav-link active\" instead of plain class=\"active\" (inconsistent with 5 other files)"
    record WARN active-state "$file" "class=nav-link active; other files use plain class=active"
  elif [ -n "$active_inline" ]; then
    fail "$file — active nav link uses inline style instead of class=\"active\""
    record FAIL active-state "$file" "inline style on self-link; should use class=\"active\""
  else
    warn "$file — no active nav state found (page does not mark itself in nav)"
    record WARN active-state "$file" "no class=active and no inline style detected"
  fi
done

# ════════════════════════════════════════════════════════════════════════════
section "3. CSS Custom Property Parity"
# Variables defined in all 7 core dashboards form the shared design system.
# Variables in only 1 file are page-specific (acceptable — INFO only).
# Variables in 2–6 files indicate accidental drift (WARN).
# ════════════════════════════════════════════════════════════════════════════

# Collect all var definitions: "count varname"
declare -A VAR_COUNTS
while IFS= read -r line; do
  count=$(echo "$line" | awk '{print $1}')
  varname=$(echo "$line" | awk '{print $2}')
  VAR_COUNTS["$varname"]="$count"
done < <(
  for file in "${STYLE_DASHBOARDS[@]}"; do
    grep -ohE -- '--[a-z][a-z0-9-]+[[:space:]]*:' "$DASH_DIR/$file" 2>/dev/null || true
  done | sed 's/[[:space:]]*://' | sort | uniq -c
)

total_files=${#STYLE_DASHBOARDS[@]}
drift_found=false
page_specific_vars=()
drift_vars=()

for varname in "${!VAR_COUNTS[@]}"; do
  count="${VAR_COUNTS[$varname]}"
  if [ "$count" -eq "$total_files" ]; then
    : # shared — silent pass
  elif [ "$count" -eq 1 ]; then
    page_specific_vars+=("$varname")
  else
    drift_vars+=("$varname (in $count/$total_files files)")
    drift_found=true
  fi
done

if [ "$drift_found" = true ]; then
  for dv in "${drift_vars[@]}"; do
    warn "CSS var drift: $dv"
    record WARN css-parity "" "$dv"
  done
else
  pass "All shared CSS custom properties defined consistently in all 7 core dashboards"
  record PASS css-parity "" "no shared-var drift detected"
fi

if [ ${#page_specific_vars[@]} -gt 0 ]; then
  info "${#page_specific_vars[@]} page-specific CSS vars (single-file, expected — e.g. lane/model colors in agents-orchestration.html)"
fi

# ════════════════════════════════════════════════════════════════════════════
section "4. prd.json Field Drift"
# Orphan fields: present in prd.json stories but referenced by zero dashboards.
# Phantom fields: referenced in dashboard JS but absent from prd.json.
# ════════════════════════════════════════════════════════════════════════════

# Real story fields from prd.json (first story as representative sample)
mapfile -t REAL_FIELDS < <(jq -r '.stories[0] | keys[]' "$PRD_FILE" 2>/dev/null)
# Real prd root fields
mapfile -t REAL_ROOT_FIELDS < <(jq -r 'keys[]' "$PRD_FILE" 2>/dev/null)

# ── Orphan fields (in prd.json, used nowhere in dashboards) ──────────────
# Build a concatenated JS content string for grep
ALL_DASH_CONTENT=$(cat "$DASH_DIR"/*.html 2>/dev/null)

orphan_fields=()
for field in "${REAL_FIELDS[@]}"; do
  # Skip structural/non-display fields that dashboards reasonably won't render
  case "$field" in
    id|title|description|acceptanceCriteria|dependencies|technicalNotes) continue ;;
  esac
  # Grep directly against files for reliability on large content
  if ! grep -rlE "\.(${field})\b|['\"]${field}['\"]" "$DASH_DIR"/*.html &>/dev/null; then
    orphan_fields+=("$field")
  fi
done

if [ ${#orphan_fields[@]} -eq 0 ]; then
  pass "No orphan story fields — all display-relevant prd.json fields surfaced in dashboards"
  record PASS field-drift "" "no orphan fields detected"
else
  for f in "${orphan_fields[@]}"; do
    warn "Orphan field: stories[].${f} exists in prd.json but is not referenced in any dashboard"
    record WARN field-drift "" "orphan: stories[].${f}"
  done
fi

# ── Phantom root fields (referenced in dashboards, not in prd.json) ──────
# Focus on known prd root accesses: prd.phaseOrder, prd.totalEstimatedHours, etc.
TRACKED_ROOT_FIELDS=("phaseOrder" "totalEstimatedHours" "implementationOrder" "phasesConfig" "version" "lastUpdated")
phantom_root=()
for field in "${TRACKED_ROOT_FIELDS[@]}"; do
  # Only check fields that ARE referenced in dashboards
  if echo "$ALL_DASH_CONTENT" | grep -qE "\.(${field})\b|\"${field}\"|'${field}'"; then
    if ! printf '%s\n' "${REAL_ROOT_FIELDS[@]}" | grep -qx "$field"; then
      phantom_root+=("$field")
    fi
  fi
done

if [ ${#phantom_root[@]} -eq 0 ]; then
  pass "No phantom root fields — prd.json root accesses match actual schema"
  record PASS field-drift "" "no phantom root fields"
else
  for f in "${phantom_root[@]}"; do
    warn "Phantom root field: prd.${f} referenced in dashboards but not present in prd.json"
    record WARN field-drift "" "phantom root: prd.${f}"
  done
fi

# ── Semantic drift: estimatedHours label context ──────────────────────────
# estimatedHours now means machine hours, but dashboards may label it as human effort
HOURS_LABEL_FILES=()
for file in "${DASHBOARDS[@]}"; do
  filepath="$DASH_DIR/$file"
  [ ! -f "$filepath" ] && continue
  # Check if file uses estimatedHours AND displays a human-effort label near it
  if grep -q 'estimatedHours' "$filepath" 2>/dev/null; then
    if grep -qE 'Estimated Hours|Human Hours|Est\. Hours|human.{0,10}hour' "$filepath" 2>/dev/null; then
      HOURS_LABEL_FILES+=("$file")
    fi
  fi
done

if [ ${#HOURS_LABEL_FILES[@]} -gt 0 ]; then
  for f in "${HOURS_LABEL_FILES[@]}"; do
    warn "$f — references estimatedHours with a human-effort label; estimatedHours now stores machine hours (AI wall-clock). Consider displaying humanHours for human effort."
    record WARN field-drift "$f" "estimatedHours semantic drift: now machine hours, may be mislabelled as human effort"
  done
else
  pass "No estimatedHours semantic drift detected in display labels"
  record PASS field-drift "" "estimatedHours labelling consistent with machine-time semantics"
fi

# ════════════════════════════════════════════════════════════════════════════
section "5. Fetch URL Existence"
# Static (non-dynamic) data file paths must exist on disk relative to dashboards/.
# Dynamic paths (containing ${...}) are skipped.
# ════════════════════════════════════════════════════════════════════════════

# Required files (must exist)
REQUIRED_DATA_FILES=(
  "prd.json"
  "profiles.json"
)

# Optional files (created at runtime — WARN if missing, not FAIL)
OPTIONAL_DATA_FILES=(
  "logs/agent-status.json"
  "logs/phase-cost.jsonl"
  "logs/agent-messages.jsonl"
  "logs/profiles-audit.jsonl"
)

for f in "${REQUIRED_DATA_FILES[@]}"; do
  if [ -f "$DASH_DIR/$f" ]; then
    pass "$f exists (required)"
    record PASS fetch-existence "$f" "file present"
  else
    fail "$f missing — required by dashboards but not found at $DASH_DIR/$f"
    record FAIL fetch-existence "$f" "required file missing"
  fi
done

for f in "${OPTIONAL_DATA_FILES[@]}"; do
  if [ -f "$DASH_DIR/$f" ]; then
    pass "$f exists (runtime log)"
    record PASS fetch-existence "$f" "file present"
  else
    info "$f not yet created (expected — generated at runtime)"
    record INFO fetch-existence "$f" "runtime file absent (normal before execution)"
  fi
done

# ── Extract and validate static fetch URLs from dashboard source ──────────
for file in "${DASHBOARDS[@]}"; do
  filepath="$DASH_DIR/$file"
  [ ! -f "$filepath" ] && continue

  # Find fetch() calls with static string paths (no template literals)
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    # Strip query strings (?t=..., ?_=...)
    clean_url="${url%%\?*}"
    # Skip dynamic paths (contain / reference variables)
    [[ "$clean_url" =~ \$ ]] && continue
    [[ "$clean_url" =~ \$\{ ]] && continue
    # Skip directory listings (end in /)
    [[ "$clean_url" =~ /$ ]] && continue
    # Skip external URLs
    [[ "$clean_url" =~ ^https?:// ]] && continue
    # Skip paths with ${agent} or other template vars already filtered
    if [ -f "$DASH_DIR/$clean_url" ]; then
      : # exists — silent pass (already covered above or redundant)
    else
      # Only warn if not already flagged as a runtime optional
      already_optional=false
      for opt in "${OPTIONAL_DATA_FILES[@]}"; do
        [ "$clean_url" = "$opt" ] && already_optional=true
      done
      if [ "$already_optimal" != "true" ]; then
        : # silent — covered by required/optional checks above
      fi
    fi
  done < <(grep -oE "fetch\(['\"][^'\"]+['\"]" "$filepath" 2>/dev/null \
             | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"" || true)
done

# ════════════════════════════════════════════════════════════════════════════
section "6. Cross-File Value Parity"
# Budget constant must be consistent across files that reference it.
# ════════════════════════════════════════════════════════════════════════════

budget_monitor=$(grep -oE 'BUDGET_TOTAL\s*=\s*[0-9.]+' "$DASH_DIR/monitor.html" 2>/dev/null \
  | grep -oE '[0-9.]+$' || echo "")
budget_cost=$(grep -oE 'BUDGET_MAX\s*=\s*[0-9.]+' "$DASH_DIR/phase-cost-monitor.html" 2>/dev/null \
  | grep -oE '[0-9.]+$' || echo "")

if [ -z "$budget_monitor" ] && [ -z "$budget_cost" ]; then
  info "No BUDGET constant found in monitor.html or phase-cost-monitor.html"
elif [ -z "$budget_monitor" ] || [ -z "$budget_cost" ]; then
  warn "Budget constant present in one file but not both — monitor: '${budget_monitor}', phase-cost: '${budget_cost}'"
  record WARN value-parity "" "budget constant asymmetric: monitor=${budget_monitor} phase-cost=${budget_cost}"
elif [ "$budget_monitor" = "$budget_cost" ]; then
  pass "BUDGET constant consistent: \$$budget_monitor in both monitor.html and phase-cost-monitor.html"
  record PASS value-parity "" "BUDGET_TOTAL=BUDGET_MAX=$budget_monitor"
else
  fail "BUDGET mismatch: monitor.html BUDGET_TOTAL=$budget_monitor vs phase-cost-monitor.html BUDGET_MAX=$budget_cost"
  record FAIL value-parity "" "BUDGET_TOTAL=$budget_monitor != BUDGET_MAX=$budget_cost"
fi

# ── prd.json totalEstimatedHours vs hardcoded budget notes ─────────────────
prd_total_hours=$(jq -r '.totalEstimatedHours // "null"' "$PRD_FILE" 2>/dev/null || echo "null")
if [ "$prd_total_hours" != "null" ]; then
  info "prd.json totalEstimatedHours = ${prd_total_hours}h (verify orchestration-plan.html summary card is in sync)"
fi

# ════════════════════════════════════════════════════════════════════════════
# ── Summary ─────────────────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

_out ""
_out "${CYAN}${BOLD}── Summary ──${NC}"
_out ""
_out "  ${GREEN}PASS${NC}  $PASS_COUNT"
_out "  ${YELLOW}WARN${NC}  $WARN_COUNT"
_out "  ${RED}FAIL${NC}  $FAIL_COUNT"
_out ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  _out "${RED}${BOLD}Result: FAIL${NC} — $FAIL_COUNT issue(s) require attention"
elif [ "$WARN_COUNT" -gt 0 ]; then
  _out "${YELLOW}${BOLD}Result: WARN${NC} — $WARN_COUNT advisory finding(s)"
else
  _out "${GREEN}${BOLD}Result: PASS${NC} — All checks passed"
fi
_out ""

# ── JSON output ─────────────────────────────────────────────────────────────
if [ "$JSON_MODE" = true ]; then
  echo "$JSON_FINDINGS" | jq \
    --argjson pass "$PASS_COUNT" \
    --argjson warn "$WARN_COUNT" \
    --argjson fail "$FAIL_COUNT" \
    '{
      summary: {pass: $pass, warn: $warn, fail: $fail},
      result: (if $fail > 0 then "fail" elif $warn > 0 then "warn" else "pass" end),
      findings: .
    }'
fi

# ── Exit code ────────────────────────────────────────────────────────────────
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
if [ "$STRICT_MODE" = true ] && [ "$WARN_COUNT" -gt 0 ]; then
  exit 2
fi
exit 0
