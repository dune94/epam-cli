#!/usr/bin/env bash
# index-codelines.sh — Build/refresh CodeGraph indexes for all Metrolinx codelines.
#
# Skips:
#   - docs.* repos (not in maintenance scope)
#   - Already-indexed repos (unless --force is passed)
#   - Anything without a .git directory
#
# Usage:
#   bash orchestrations/scripts/index-codelines.sh [--root /path/to/repos] [--force] [--parallel N]
#
# Env:
#   JIRA_CODELINE_ROOT  — repo root (overridden by --root flag)
#   CODEGRAPH_BIN       — codegraph binary path override

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${JIRA_CODELINE_ROOT:-}"
# No client path default: an engine default pointing at one client's checkout is
# hardcoding, and silently indexes the wrong tree when the var is forgotten.
if [ -z "$ROOT" ]; then
    echo "JIRA_CODELINE_ROOT is not set — cannot index codelines." >&2
    exit 1
fi
FORCE=0
MAX_PARALLEL=4
BIN="${CODEGRAPH_BIN:-$(which codegraph 2>/dev/null || echo '')}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)      ROOT="$2"; shift 2 ;;
    --force)     FORCE=1;   shift   ;;
    --parallel)  MAX_PARALLEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$BIN" ]]; then
  echo "ERROR: codegraph binary not found. Run: npm i -g @colbymchenry/codegraph"
  exit 1
fi

echo "[index-codelines] Using codegraph: $BIN ($(\"$BIN\" --version 2>/dev/null))"
echo "[index-codelines] Root: $ROOT"
echo "[index-codelines] Parallel workers: $MAX_PARALLEL"
echo ""

# Collect repos to index
REPOS=()
for dir in "$ROOT"/*/; do
  name="$(basename "$dir")"
  # Exclude docs.* repos
  if [[ "$name" == docs.* ]]; then
    echo "  SKIP (docs): $name"
    continue
  fi
  # Must be a git repo
  if [[ ! -d "$dir/.git" ]]; then
    echo "  SKIP (not git): $name"
    continue
  fi
  # Skip already-indexed unless --force
  if [[ $FORCE -eq 0 && -f "$dir/.codegraph/codegraph.db" ]]; then
    echo "  ALREADY INDEXED: $name"
    continue
  fi
  REPOS+=("$dir")
done

echo ""
TOTAL=${#REPOS[@]}
if [[ $TOTAL -eq 0 ]]; then
  echo "[index-codelines] Nothing to index."
  exit 0
fi
echo "[index-codelines] Indexing $TOTAL repos (parallel=$MAX_PARALLEL)..."
echo ""

# Index in parallel batches
PIDS=()
DONE=0
FAILED=()

index_repo() {
  local dir="$1"
  local name="$(basename "$dir")"
  local start_ts=$SECONDS
  echo "[$(date +%H:%M:%S)] START  $name"
  if "$BIN" init "$dir" 2>&1 | tail -1; then
    echo "[$(date +%H:%M:%S)] DONE   $name  ($((SECONDS - start_ts))s)"
    return 0
  else
    echo "[$(date +%H:%M:%S)] FAILED $name"
    return 1
  fi
}

export -f index_repo
export BIN

for dir in "${REPOS[@]}"; do
  # Wait if at max parallel
  while [[ ${#PIDS[@]} -ge $MAX_PARALLEL ]]; do
    NEW_PIDS=()
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        NEW_PIDS+=("$pid")
      else
        wait "$pid" && true || FAILED+=("$pid")
        ((DONE++)) || true
      fi
    done
    PIDS=("${NEW_PIDS[@]}")
    [[ ${#PIDS[@]} -ge $MAX_PARALLEL ]] && sleep 0.5
  done
  bash -c "index_repo \"$dir\"" &
  PIDS+=($!)
done

# Wait for remaining
for pid in "${PIDS[@]}"; do
  wait "$pid" && true || FAILED+=("$pid")
  ((DONE++)) || true
done

echo ""
echo "[index-codelines] Complete. $DONE/$TOTAL repos processed."
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "[index-codelines] FAILED PIDs: ${FAILED[*]}"
  exit 1
fi
exit 0
