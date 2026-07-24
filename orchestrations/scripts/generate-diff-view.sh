#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# generate-diff-view.sh — renders a story branch's real diff as a standalone
# HTML page (via diff2html-cli) and drops it where nginx already serves the
# rest of the dashboard (orchestrations/dashboards/live/), plus updates a
# JSON manifest the diff-viewer.html page reads to list what's available.
#
# Works identically for brownfield and greenfield — both are just a git repo
# with a story branch; only how the caller resolves BASELINE_REF differs
# (brownfield: JIRA_BASELINE_BRANCH, usually "main"; greenfield: the
# scaffold's own initial commit, also usually "main" since scaffold-*-repo.sh
# creates its first commit there — same default works for both).
#
# Usage:
#   generate-diff-view.sh <repo_path> <branch> <story_id> [baseline_ref]
#
# baseline_ref defaults to "main", falling back to "origin/main", falling
# back to the repo's first commit if neither ref exists (covers repos whose
# default branch isn't literally named "main").
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_PATH="${1:?Usage: generate-diff-view.sh <repo_path> <branch> <story_id> [baseline_ref]}"
BRANCH="${2:?Usage: generate-diff-view.sh <repo_path> <branch> <story_id> [baseline_ref]}"
STORY_ID="${3:?Usage: generate-diff-view.sh <repo_path> <branch> <story_id> [baseline_ref]}"
BASELINE_REF_ARG="${4:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIVE_DIR="$REPO_ROOT/orchestrations/dashboards/live"
DIFFS_DIR="$LIVE_DIR/diffs"
MANIFEST="$DIFFS_DIR/index.json"
mkdir -p "$DIFFS_DIR"

if [ ! -d "$REPO_PATH/.git" ]; then
  echo "[diff-view] Not a git repo: $REPO_PATH" >&2
  exit 1
fi

resolve_baseline() {
  local ref
  for ref in "$BASELINE_REF_ARG" "main" "origin/main" "master" "origin/master"; do
    [ -z "$ref" ] && continue
    if git -C "$REPO_PATH" rev-parse --verify --quiet "$ref" >/dev/null; then
      echo "$ref"
      return 0
    fi
  done
  # Last resort: the repo's very first commit (covers greenfield scaffolds
  # or any repo whose default branch isn't named main/master).
  git -C "$REPO_PATH" rev-list --max-parents=0 HEAD | tail -1
}

BASELINE_REF="$(resolve_baseline)"
if [ -z "$BASELINE_REF" ]; then
  echo "[diff-view] Could not resolve a baseline ref for $REPO_PATH" >&2
  exit 1
fi

if ! git -C "$REPO_PATH" rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  echo "[diff-view] Branch not found: $BRANCH (repo: $REPO_PATH)" >&2
  exit 1
fi

REPO_NAME="$(basename "$REPO_PATH")"
SAFE_STORY="$(printf '%s' "$STORY_ID" | tr -c 'A-Za-z0-9_-' '_')"
OUT_HTML="$DIFFS_DIR/${SAFE_STORY}.html"
TMP_DIFF="$(mktemp)"
trap 'rm -f "$TMP_DIFF"' EXIT

git -C "$REPO_PATH" diff "$BASELINE_REF" "$BRANCH" > "$TMP_DIFF"

if [ ! -s "$TMP_DIFF" ]; then
  echo "[diff-view] No diff between $BASELINE_REF and $BRANCH — nothing to render" >&2
  exit 0
fi

npx --yes diff2html-cli \
  -i file \
  -s side \
  --su open \
  -t "${STORY_ID} — ${REPO_NAME} (${BASELINE_REF}...${BRANCH})" \
  -F "$OUT_HTML" \
  -- "$TMP_DIFF"

# Update the manifest the diff-viewer.html page reads. Node (not jq) so a
# single dependency-free call can both read-modify-write the JSON array and
# de-dupe by storyId (re-running for the same story replaces its old entry
# rather than accumulating duplicates across repeat runs of the same ticket).
NODE_BIN="${NODE_BIN:-node}"
"$NODE_BIN" -e "
  const fs = require('fs');
  const manifestPath = '${MANIFEST}';
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { entries = []; }
  entries = entries.filter(e => e.storyId !== '${STORY_ID}');
  entries.unshift({
    storyId: '${STORY_ID}',
    repo: '${REPO_NAME}',
    branch: '${BRANCH}',
    baselineRef: '${BASELINE_REF}',
    file: 'diffs/${SAFE_STORY}.html',
    generatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
"

echo "[diff-view] ✓ ${STORY_ID}: ${REPO_NAME} (${BASELINE_REF}...${BRANCH}) → ${OUT_HTML}"
