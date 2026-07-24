#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# codegraph-preflight-index.sh — hard gate: every candidate codeline must be
# CodeGraph-indexed BEFORE codeline-discovery.js scores them. Aborts the whole
# launch (non-zero exit) if any repo cannot be indexed, rather than letting
# scoring silently continue with a zero-scored, unfairly-excluded repo.
#
# Live bug this closes (2026-07-22): codeline-discovery's scorer gave a repo
# missing its CodeGraph index a score of zero on the CodeGraph tier — not
# because the repo was irrelevant, but because nobody had indexed it yet.
# azure.commerce.cdts (the real AMSD-1820 fix site) was never indexed, never
# made the top-8 candidates handed to the LLM, and the wrong repo got picked.
#
# This script must run AFTER any teardown/reset step, so it indexes the
# ACTUAL tree state the pipeline is about to operate on — never a state that
# a later reset would invalidate.
#
# docs.* repos are excluded — same scope exclusion codeline-discovery.js
# itself applies (documentation projects are never brownfield fix targets).
#
# Usage: bash codegraph-preflight-index.sh <codeline_root>
# Exit 0 = every non-docs git repo under <codeline_root> is indexed.
# Exit 1 = codegraph binary missing, OR at least one repo could not be
#          indexed — caller MUST NOT proceed to codeline discovery.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="${1:?Usage: codegraph-preflight-index.sh <codeline_root>}"

log()  { echo "[codegraph-preflight] $*"; }
err()  { echo "[codegraph-preflight] $*" >&2; }

if [ ! -d "$ROOT" ]; then
  err "ABORT: codeline root does not exist: $ROOT"
  exit 1
fi

if ! command -v codegraph &>/dev/null; then
  err "ABORT: codegraph binary not found on PATH — cannot verify or build indices."
  exit 1
fi

# A plain `[ -f ]` check accepts a truncated/corrupt db as "indexed" — see
# codegraph-context.js's isCodeGraphIndexed() for the live failure this
# closes (a killed-mid-write process leaves .codegraph/.gitignore present
# with an empty/truncated codegraph.db that never gets re-indexed). Validates
# the real SQLite magic header instead of just checking the path exists —
# same check as the JS side, kept in sync deliberately.
is_valid_codegraph_db() {
  local db="$1"
  [ -f "$db" ] || return 1
  [ "$(head -c 15 "$db" 2>/dev/null)" = "SQLite format 3" ]
}

FAILED=()
CHECKED=0
ALREADY_INDEXED=0
INDEXED_NOW=0

for dir in "$ROOT"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [[ "$name" == docs.* ]] && continue
  [ -d "${dir}.git" ] || continue
  CHECKED=$((CHECKED + 1))

  if is_valid_codegraph_db "${dir}.codegraph/codegraph.db"; then
    ALREADY_INDEXED=$((ALREADY_INDEXED + 1))
    continue
  fi

  log "Indexing $name (no valid existing index)..."
  if codegraph init "${dir%/}" >/dev/null 2>&1; then
    if is_valid_codegraph_db "${dir}.codegraph/codegraph.db"; then
      INDEXED_NOW=$((INDEXED_NOW + 1))
      log "  OK: $name indexed"
    else
      # codegraph exited 0 but produced no valid db — treat as a failure, not a pass.
      FAILED+=("$name")
      err "  FAILED: $name — codegraph init exited 0 but no valid codegraph.db was produced"
    fi
  else
    FAILED+=("$name")
    err "  FAILED: $name — codegraph init exited non-zero"
  fi
done

log "Checked $CHECKED repo(s): $ALREADY_INDEXED already indexed, $INDEXED_NOW indexed just now, ${#FAILED[@]} failure(s)."

if [ "${#FAILED[@]}" -gt 0 ]; then
  err "ABORT: the following repo(s) could not be indexed and must not be silently scored as zero: ${FAILED[*]}"
  exit 1
fi

exit 0
