#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# codegraph-reindex.sh — refresh ONE repo's CodeGraph index after its working
# tree has changed.
#
# THE BUG THIS CLOSES (2026-08-06)
# --------------------------------
# The index was built exactly once per run, by codegraph-preflight-index.sh,
# BEFORE any writer executed. Nothing ever rebuilt it afterwards:
#
#   - isCodeGraphIndexed() validates only that the SQLite file exists and
#     carries a valid header. It is existence-only; it never compares the
#     index's age against the working tree.
#   - ensureIndexed() therefore short-circuits to `true` for ANY pre-existing
#     index, however stale, and rebuilds only when the db is missing/corrupt.
#   - grep across run-agent-orchestration.sh / claude.sh / team-lead-review.sh
#     finds zero re-index calls anywhere in the post-write or review path.
#
# But team-lead-review.sh hands the reviewer `codegraph_query` explicitly to
# "check whether a helper already exists before accepting hand-rolled logic".
# So the reviewer was querying a PRE-WRITER snapshot: every file the writer
# created or modified was invisible to it, and any "does X exist?" query
# returned a false negative on the writer's own output.
#
# (Blast radius note, so this is not over-claimed: resolve_test_file in
# plugins/codeline-context-plugin.js does real fs.existsSync lookups, not index
# reads, so it always saw in-flight writes correctly. Only codegraph_query was
# affected.)
#
# WHY IT HOOKS ON COMMIT COMPLETION
# ---------------------------------
# A local commit is the point at which a story's writes are final and on disk
# — the natural, cheap, once-per-story boundary. Re-indexing per file-write
# would be wasteful; re-indexing at review time only would miss any other
# post-commit consumer. Per explicit instruction: "we need a codegraph agent
# to be invoked when a local commit completes to reindex."
#
# Cost: ~600ms-1s for a 1k-file TypeScript repo (see initCodeGraph's own
# measurement note in lib/codegraph-context.js).
#
# Usage: bash codegraph-reindex.sh <repo_path> [reason]
#
# Exit 0 ALWAYS. This is a freshness optimisation, never a pipeline blocker:
# a stale index degrades review quality, but a hard failure here would abort a
# run over a cache refresh. Failures are logged loudly instead — silence would
# recreate exactly the invisible-staleness problem this script exists to fix.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="${1:-}"
REASON="${2:-post-commit}"

log()  { echo "[codegraph-reindex] $*"; }
warn() { echo "[codegraph-reindex] WARN: $*" >&2; }

# Opt-out for a run that does not want the (small) per-commit cost.
if [ "${EPAM_CODEGRAPH_REINDEX_ENABLED:-1}" != "1" ]; then
  log "disabled via EPAM_CODEGRAPH_REINDEX_ENABLED — skipping"
  exit 0
fi

if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  warn "no valid repo path given ('${REPO}') — nothing to reindex"
  exit 0
fi

if ! command -v codegraph >/dev/null 2>&1; then
  # Not an error: a run without the binary simply has no index for anyone to
  # read, and every consumer already degrades gracefully on that.
  log "codegraph binary not on PATH — skipping reindex for $REPO"
  exit 0
fi

# Only meaningful for a repo that HAS an index. Building one here for a repo
# the run never indexed would silently change which repos have indices
# mid-run; ensureIndexed() already covers genuine build-on-demand.
if [ ! -f "$REPO/.codegraph/codegraph.db" ]; then
  log "no existing index at $REPO/.codegraph — nothing to refresh (ensureIndexed builds on demand)"
  exit 0
fi

# ── Dirty check ──────────────────────────────────────────────────────────────
# Only rebuild when the tree has actually moved ahead of the index. A commit
# does not imply the index is stale: a docs-only commit, a re-run over an
# already-fresh tree, or a second consumer firing the same hook would all pay
# a full rebuild for nothing.
#
# WHAT COUNTS AS "SOURCE" IS THE REPO'S OWN ANSWER, NOT OURS.
#
# The first version of this pruned `.git`, `node_modules` and `.codegraph` by
# name. That is a hardcoded stack assumption: it is correct for a JS/TS repo
# and wrong for every other one — a Python codeline would walk `.venv` and
# `__pycache__` and report dirty forever, and the comment here claimed to be
# "extension-agnostic" while hardcoding a directory name that is a stack fact.
#
# `git ls-files` asks the repository which files it actually tracks. That
# answer already excludes .git (never tracked), anything the repo's own
# .gitignore excludes (node_modules, .venv, dist, target, build — whatever
# THIS stack uses), and .codegraph (kept out via .git/info/exclude by
# protectIndexFromGitClean). No directory name appears here, so nothing about
# the codeline's language or toolchain is assumed.
#
# Untracked-but-not-ignored files are deliberately included (`--others
# --exclude-standard`): a brand-new source file the writer just created is not
# committed yet at reindex time, and it is exactly the file the reviewer must
# be able to see.
_db="$REPO/.codegraph/codegraph.db"
if [ "${EPAM_CODEGRAPH_REINDEX_FORCE:-0}" != "1" ]; then
  _newer=""
  while IFS= read -r _f; do
    [ -n "$_f" ] || continue
    if [ "$REPO/$_f" -nt "$_db" ]; then _newer="$_f"; break; fi
  done <<EOF
$(git -C "$REPO" ls-files --cached --others --exclude-standard 2>/dev/null)
EOF
  if [ -z "$_newer" ]; then
    log "index is CLEAN for $REPO (no tracked/untracked source file is newer than the db) — skipping rebuild (${REASON})"
    exit 0
  fi
  log "index is DIRTY for $REPO (e.g. ${_newer}) — rebuilding (${REASON})"
fi

_started=$(date +%s)
set +e
_out=$(timeout "${EPAM_CODEGRAPH_REINDEX_TIMEOUT_SECS:-180}" codegraph init "$REPO" 2>&1)
_rc=$?
set -e
_elapsed=$(( $(date +%s) - _started ))

if [ "$_rc" -eq 0 ]; then
  log "reindexed $REPO in ${_elapsed}s (${REASON}) — reviewer's codegraph_query now sees this story's writes"
elif [ "$_rc" -eq 124 ]; then
  warn "reindex TIMED OUT after ${EPAM_CODEGRAPH_REINDEX_TIMEOUT_SECS:-180}s for $REPO (${REASON}) — downstream codegraph_query results may be STALE"
else
  warn "reindex FAILED (exit ${_rc}) for $REPO (${REASON}) — downstream codegraph_query results may be STALE. Output:"
  warn "$_out"
fi

exit 0
