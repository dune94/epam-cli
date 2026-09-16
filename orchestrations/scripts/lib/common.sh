#!/usr/bin/env bash
# common.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (6 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# KB IS KEYED BY CODELINE, NOT BY AGENT ROLE.
#
# The roster is ephemeral by design — regenerated every run, no aggregation — and the mint
# invents a new NAME each run for what is essentially the same agent. KB-<role>.md therefore
# named an address that changed every run: 32 files accumulated, each holding what one run
# learned, none reachable by any later run. The store persisted; the key did not.
#
# A codeline is stable, discovered rather than invented, already the investigator key, and the
# subject of most durable learning — where the SDK is initialised here, how this repository
# names its tests. Project-wide lessons that belong to no codeline go to the shared file.
# _resolved_baseline_ref [repo] — the ref every diff in this file compares against.
#
# NINE SITES SPELLED THIS `origin/${JIRA_BASELINE_BRANCH:-develop}`. "develop" is a fact of some
# projects and not of others, so on a codeline whose trunk is named anything else every one of
# those diffs resolved nothing — and a diff against a ref that does not exist is empty, which
# reads downstream exactly like "this story changed nothing".
#
# The project declares it; otherwise take the repository's OWN checked-out branch, which is at
# least true. Prefer origin/<branch> when that ref exists, because these are baseline comparisons
# and the remote is the shared baseline; fall back to the local branch when there is no remote.
# Prints nothing when nothing resolves, so a caller can refuse rather than diff against a name.
_resolved_baseline_ref() {
    local _repo="${1:-${PROJECT_ROOT:-.}}"
    local _branch="${JIRA_BASELINE_BRANCH:-}"
    if [ -z "$_branch" ]; then
        _branch="$(git -C "$_repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
        [ "$_branch" = "HEAD" ] && _branch=""
    fi
    [ -n "$_branch" ] || return 0
    if git -C "$_repo" rev-parse --verify --quiet "origin/${_branch}" >/dev/null 2>&1; then
        printf 'origin/%s' "$_branch"
    else
        printf '%s' "$_branch"
    fi
}

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" >&2
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    echo "[ERROR] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
    echo "[SUCCESS] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" >&2
    echo "[WARNING] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

info() {
    echo -e "${CYAN}[INFO]${NC} $1" >&2
}
