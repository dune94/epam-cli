#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# brownfield-coverage-gate.sh — decides whether a brownfield change needs a NEW
# test, so the pipeline never generates "wild tests that aren't necessary".
#
# Brownfield testing strategy (distinct from greenfield): the agent MODIFIES
# existing code. Existing tests must still pass — the Step 5 regression guard and
# Step 4.5 unit gate already run the codeline's full suite for that, with ZERO
# new tests. A new test is warranted ONLY for a changed file that has no covering
# tests. This gate answers exactly that, deterministically, via CodeGraph's
# `affected` command (which test files exercise a given source file).
#
# Usage:
#   brownfield-coverage-gate.sh <changed_file> [<changed_file> …]
#     PROJECT_ROOT (or cwd) = the codeline repo.
#
# Output: the subset of the given files that are UNCOVERED (one per line) — these,
#   and only these, warrant a single targeted test for the changed behavior.
#   Empty output = every changed file is already covered → write NO new test.
#
# Exit codes:
#   0  gate ran; uncovered files (if any) printed to stdout
#   3  CodeGraph unavailable / repo not indexed — caller CANNOT rely on this
#      gate and must fall back to its existing behavior (do NOT silently skip).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="${PROJECT_ROOT:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

[ $# -ge 1 ] || { echo "usage: brownfield-coverage-gate.sh <changed_file> [more…]" >&2; exit 2; }

# Delegate to the tested library function (uncoveredChangedFiles). It returns
# null when the index is unavailable — surface that as exit 3 so a caller never
# mistakes "can't tell" for "all covered".
FILES_JSON=$(printf '%s\n' "$@" | "$NODE_BIN" -e '
  const cg = require(process.argv[1]);
  const repo = process.argv[2];
  let input = "";
  process.stdin.on("data", d => input += d);
  process.stdin.on("end", () => {
    const files = input.split("\n").map(s => s.trim()).filter(Boolean);
    const uncovered = cg.uncoveredChangedFiles(files, repo);
    if (uncovered === null) { process.exit(3); }
    process.stdout.write(JSON.stringify(uncovered));
  });
' "$SCRIPT_DIR/lib/codegraph-context.js" "$REPO") || {
  rc=$?
  if [ "$rc" = "3" ]; then
    echo "[coverage-gate] CodeGraph unavailable/unindexed for $REPO — cannot determine coverage" >&2
    exit 3
  fi
  exit "$rc"
}

printf '%s' "$FILES_JSON" | "$NODE_BIN" -e '
  let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
    try { (JSON.parse(s)||[]).forEach(f=>console.log(f)); } catch {}
  });
'
