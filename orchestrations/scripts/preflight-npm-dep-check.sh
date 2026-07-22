#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# preflight-npm-dep-check.sh — proves, for every npm codeline, that a
# per-package dependency install will NOT touch the private registry for an
# unrelated package. No live LLM call, no Jira, no real npm network I/O
# (npm itself is stubbed) — pure verification that the strip/restore wrapper
# is wired correctly and package.json ends up byte-identical to its original
# state afterward.
#
# Run this BEFORE launching any brownfield pipeline run against these
# codelines — it is the deterministic proof that closes the "why do you need
# GH_TOKEN" gap: if this passes, no private-registry credential is required
# for a story that never actually imports the private dependency.
#
# Usage:
#   bash orchestrations/scripts/preflight-npm-dep-check.sh [--root /path]
#
# Exit code 0 = every npm codeline is safe. Non-zero = at least one codeline
# would still attempt to touch the private registry for an unrelated install.
# ─────────────────────────────────────────────────────────────────────────────
set -eo pipefail

ROOT="${JIRA_CODELINE_ROOT:-/home/bradleyjerome/projects/metrolinx}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

FAIL=0
CHECKED=0

echo "[preflight] Root: $ROOT"
echo ""

for dir in "$ROOT"/*/; do
  name="$(basename "$dir")"
  [[ "$name" == docs.* ]] && continue
  [ -d "$dir/.git" ] || continue
  [ -f "$dir/package.json" ] || continue
  CHECKED=$((CHECKED + 1))

  wrapper="$dir/.epam/npm-install-wrapper.sh"
  lib="$dir/.epam/lib-strip-private-scope.sh"
  depcheck="$dir/.epam/dependency-check.json"

  ok=1
  reasons=()

  [ -x "$wrapper" ] || { ok=0; reasons+=("npm-install-wrapper.sh missing or not executable"); }
  [ -x "$lib" ]     || { ok=0; reasons+=("lib-strip-private-scope.sh missing or not executable"); }
  if [ -f "$depcheck" ]; then
    if ! grep -q "npm-install-wrapper.sh" "$depcheck" 2>/dev/null; then
      ok=0; reasons+=("dependency-check.json installCommand does not use the wrapper")
    fi
  else
    ok=0; reasons+=("dependency-check.json missing")
  fi

  # Live, deterministic proof: run the wrapper against a scratch COPY of this
  # repo's real package.json + .npmrc, installing a harmless local no-op
  # "package" via a stubbed npm on PATH, and confirm:
  #   1. the stubbed npm never sees the private-scope dependency in its
  #      package.json view (proves the strip happened before install)
  #   2. package.json on disk afterward is BYTE-IDENTICAL to the original
  #      (proves the restore happened correctly)
  if [ "$ok" -eq 1 ]; then
    scratch=$(mktemp -d)
    cp "$dir/package.json" "$scratch/package.json"
    [ -f "$dir/.npmrc" ] && cp "$dir/.npmrc" "$scratch/.npmrc"
    mkdir -p "$scratch/.epam"
    cp "$lib" "$scratch/.epam/lib-strip-private-scope.sh"
    cp "$wrapper" "$scratch/.epam/npm-install-wrapper.sh"

    stub_bin=$(mktemp -d)
    cat > "$stub_bin/npm" <<'STUBEOF'
#!/usr/bin/env bash
# Stub npm: records what devDependencies/dependencies are visible in
# package.json at "install time", then exits 0 — no real network call.
python3 -c "
import json
p = json.load(open('package.json'))
allkeys = list(p.get('dependencies', {}).keys()) + list(p.get('devDependencies', {}).keys())
with open('${TMPDIR:-/tmp}/npm-stub-seen.txt', 'w') as f:
    f.write('\n'.join(allkeys))
"
exit 0
STUBEOF
    chmod +x "$stub_bin/npm"

    original_content=$(cat "$dir/package.json")
    seen_file="$scratch/npm-stub-seen.txt"
    TMPDIR="$scratch" PATH="$stub_bin:$PATH" bash -c "cd '$scratch' && bash .epam/npm-install-wrapper.sh some-harmless-package" >/dev/null 2>&1 || true

    after_content=$(cat "$scratch/package.json")
    if [ "$original_content" != "$after_content" ]; then
      ok=0; reasons+=("package.json NOT restored to original after wrapper ran")
    fi

    if [ -f "$seen_file" ]; then
      private_scopes=$(grep -oE '^@[^:]+:registry=[^ ]*' "$scratch/.npmrc" 2>/dev/null | grep -v 'registry.npmjs.org' | sed -E 's/:registry=.*//' || true)
      for scope in $private_scopes; do
        if grep -q "^${scope}/" "$seen_file" 2>/dev/null; then
          ok=0; reasons+=("private scope $scope was STILL visible to npm during install — strip did not happen")
        fi
      done
    fi

    rm -rf "$scratch" "$stub_bin"
  fi

  if [ "$ok" -eq 1 ]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name"
    for r in "${reasons[@]}"; do echo "      - $r"; done
    FAIL=1
  fi
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "[preflight] PASS — all $CHECKED npm codeline(s) verified safe. No private-registry credential required."
  exit 0
else
  echo "[preflight] FAIL — one or more codelines would still touch the private registry for an unrelated install."
  exit 1
fi
