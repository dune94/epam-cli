#!/usr/bin/env bash
# resolve-codeline-scope.sh — decide which codelines a run touches, however its PRD arrived.
#
# WHY THIS EXISTS. Codeline discovery used to be invoked from exactly one place: inside the Jira
# ingest, behind `if JIRA_PIPELINE = 1`. That made a capability every project needs reachable only
# by projects that ingest from a tracker. A project whose PRD is authored never reached it, so
# project.outputDirs stayed empty, the entry dispatch counted zero codelines, and the run silently
# collapsed to one unnamed lane while the mint reported success.
#
# The rule is the same for every project and names none of them:
#
#     scope undeclared + a codeline root configured  ⇒  resolve it
#
# The work items come from the PRD, which every project has however it arrived. Discovery reads
# key, title, description and components; a PRD story carries all four.
#
# Usage:
#   resolve-codeline-scope.sh --prd <path> [--root <dir>] [--out <dir>] [--dry-run]
#
#   --root     defaults to JIRA_CODELINE_ROOT
#   --out      where to persist the discovery artefact; defaults to LOG_DIR
#   --dry-run  score and rank without calling a model — the highest-scored candidate wins
#
# Exit 0 = scope is resolved, or was already declared and left alone.
# Exit 1 = it could not be resolved. That is a HALT, not a warning: a run that proceeds with an
#          unresolved scope writes to whichever single repository it happens to land on.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"

PRD_ARG=""
ROOT_ARG="${JIRA_CODELINE_ROOT:-}"
OUT_DIR="${LOG_DIR:-}"
DRY_FLAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --prd)     PRD_ARG="$2"; shift 2 ;;
    --root)    ROOT_ARG="$2"; shift 2 ;;
    --out)     OUT_DIR="$2"; shift 2 ;;
    --dry-run) DRY_FLAG="--dry-run"; shift ;;
    *) echo "[scope] unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$PRD_ARG" ] || { echo "[scope] --prd is required" >&2; exit 1; }
[ -f "$PRD_ARG" ] || { echo "[scope] PRD not found: $PRD_ARG" >&2; exit 1; }

# ── Already declared? Then there is nothing to resolve ────────────────────────
# Asked before anything is scanned or spent. A project that declares its codelines has answered
# the question, and this stage exists to fill a gap rather than to have an opinion.
_declared=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/cl-count.js" "$PRD_ARG" 2>/dev/null || echo 0)
if [ "${_declared:-0}" -gt 0 ]; then
  echo "[scope] ${_declared} codeline(s) already declared in the PRD — nothing to resolve"
  exit 0
fi

if [ -z "$ROOT_ARG" ]; then
  # Not an error. A project with no codeline root is single-repo by construction, and there is
  # nothing to discover; the dispatch's single-lane path is the right answer for it.
  echo "[scope] no codeline root configured — leaving scope undeclared (single-repo project)"
  exit 0
fi
[ -d "$ROOT_ARG" ] || { echo "[scope] codeline root does not exist: $ROOT_ARG" >&2; exit 1; }

_work="$(mktemp -d "${TMPDIR:-/tmp}/scope-XXXXXX")"
trap 'rm -rf "$_work"' EXIT

# ── The work items, from the PRD ──────────────────────────────────────────────
_items="$_work/work-items.json"
"$NODE_BIN" "$SCRIPT_DIR/lib/handlers/work-items-from-prd.js" "$PRD_ARG" > "$_items"

# ── Discovery, at its own seam ────────────────────────────────────────────────
# The SAME agent the Jira path runs, with the same ladder, budget and cost capture. A second
# implementation here would be a second thing to keep correct.
_disc="$_work/codeline-discovery.json"
"$NODE_BIN" "$SCRIPT_DIR/lib/codeline-discovery.js" \
  --issues "$_items" \
  --root   "$ROOT_ARG" \
  --out    "$_disc" \
  $DRY_FLAG

# ── Persist it where later stages look ────────────────────────────────────────
# The mint reads this artefact by path. It used to be exported as environment variables from a
# child process, which is how the mint once saw one codeline while three were in scope.
if [ -n "$OUT_DIR" ] && [ -d "$OUT_DIR" ]; then
  cp "$_disc" "$OUT_DIR/codeline-discovery.json"
  echo "[scope] discovery persisted → $OUT_DIR/codeline-discovery.json"
fi

# ── Write the scope into the PRD ──────────────────────────────────────────────
"$NODE_BIN" "$SCRIPT_DIR/lib/handlers/apply-codeline-scope.js" "$PRD_ARG" "$_disc"
