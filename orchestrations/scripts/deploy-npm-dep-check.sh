#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-npm-dep-check.sh — deploys the generic dependency-check tooling
# (setup-deps.sh, lib-strip-private-scope.sh, npm-install-wrapper.sh,
# dependency-check.json) to every npm-manifest codeline under JIRA_CODELINE_ROOT.
#
# Root cause this closes (live bug, 2026-07-22): run_dependency_check's
# per-package installCommand re-resolves the WHOLE package.json manifest on
# every install, including any private-registry (e.g. GitHub Packages)
# devDependency — even when installing a totally unrelated package for a
# story that never touches the private dependency. Confirmed on
# azure.commerce.cdts (which uses @metrolinx/cx-shared, only referenced in
# migration-scripts/, never in any story-relevant code) — this fix mitigates
# the SAME exposure for every other npm codeline with a private npm scope,
# not just the one repo where it was first found.
#
# Idempotent: skips a repo's dependency-check.json if it already routes
# installCommand through npm-install-wrapper.sh (already fixed). Always
# refreshes setup-deps.sh / lib-strip-private-scope.sh / npm-install-wrapper.sh
# to the canonical versions (safe — fully generic, no repo-specific content).
#
# Usage:
#   bash orchestrations/scripts/deploy-npm-dep-check.sh [--root /path/to/repos] [--dry-run]
# ─────────────────────────────────────────────────────────────────────────────
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${JIRA_CODELINE_ROOT:-/home/bradleyjerome/projects/metrolinx}"
DRY_RUN=0
CANONICAL_REPO="azure.commerce.cdts"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)    ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

CANONICAL_DIR="$ROOT/$CANONICAL_REPO/.epam"
for f in setup-deps.sh lib-strip-private-scope.sh npm-install-wrapper.sh; do
  if [ ! -f "$CANONICAL_DIR/$f" ]; then
    echo "ERROR: canonical file missing: $CANONICAL_DIR/$f — deploy to $CANONICAL_REPO first."
    exit 1
  fi
done

echo "[deploy-npm-dep-check] Root: $ROOT"
echo "[deploy-npm-dep-check] Canonical source: $CANONICAL_DIR"
[ "$DRY_RUN" -eq 1 ] && echo "[deploy-npm-dep-check] DRY RUN — no files will be written"
echo ""

DEPLOYED=0
SKIPPED=0

for dir in "$ROOT"/*/; do
  name="$(basename "$dir")"
  [[ "$name" == docs.* ]] && continue
  [ -d "$dir/.git" ] || continue
  [ -f "$dir/package.json" ] || continue

  epam_dir="$dir/.epam"
  depcheck="$epam_dir/dependency-check.json"

  # Idempotency check: already routed through the wrapper?
  if [ -f "$depcheck" ] && grep -q "npm-install-wrapper.sh" "$depcheck" 2>/dev/null; then
    echo "  SKIP (already fixed): $name"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "  DEPLOY: $name"
  DEPLOYED=$((DEPLOYED + 1))
  [ "$DRY_RUN" -eq 1 ] && continue

  mkdir -p "$epam_dir"
  cp "$CANONICAL_DIR/setup-deps.sh" "$epam_dir/setup-deps.sh"
  cp "$CANONICAL_DIR/lib-strip-private-scope.sh" "$epam_dir/lib-strip-private-scope.sh"
  cp "$CANONICAL_DIR/npm-install-wrapper.sh" "$epam_dir/npm-install-wrapper.sh"
  chmod +x "$epam_dir/setup-deps.sh" "$epam_dir/lib-strip-private-scope.sh" "$epam_dir/npm-install-wrapper.sh"

  if [ -f "$depcheck" ]; then
    # Existing dependency-check.json — just repoint installCommand and ensure
    # preInstallHook is set, preserving every other repo-specific field
    # (ignorePackages, requiredDevDependencies, etc.) exactly as authored.
    python3 - "$depcheck" <<'PYEOF'
import json, sys
p = sys.argv[1]
with open(p) as f:
    d = json.load(f)
d['preInstallHook'] = 'bash .epam/setup-deps.sh'
d['installCommand'] = 'bash .epam/npm-install-wrapper.sh {package}'
with open(p, 'w') as f:
    json.dump(d, f, indent=2)
PYEOF
  else
    # No dependency-check.json yet — write the canonical npm/TS template.
    cp "$CANONICAL_DIR/dependency-check.json" "$depcheck"
  fi
done

echo ""
echo "[deploy-npm-dep-check] Deployed: $DEPLOYED, Skipped (already fixed): $SKIPPED"
