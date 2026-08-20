#!/bin/bash
# worktree-health-check.sh
# Verifies git worktrees have committed their agent-produced code.
# Run: (1) before phase gate, (2) as part of each claude.sh --worktree iteration.
# EPAM CLI orchestration worktree health checker
#
# Exit codes:
#   0 -- healthy (all changes committed, or no worktrees active)
#   1 -- uncommitted files found (warn + optionally auto-commit)
#   2 -- worktree missing / corrupt
#
# Env:
#   AUTO_COMMIT=true     Auto-commit uncommitted files instead of just warning
#   PHASE                Current phase id (used in commit message)
#   LANE                 Worktree lane name (primary|independent), if known

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# git_add_client_outputs — the one staging rule. This script used to carry its own,
# weaker copy of the engine-artefact exclusions.
# shellcheck source=lib/git-ops.sh
source "$SCRIPT_DIR/lib/git-ops.sh"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"
PROJECT_ROOT="${GIT_WORK_ROOT:-${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

# Colors
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()     { echo -e "${CYAN}[wt-health]${NC} $*"; }
warn()    { echo -e "${YELLOW}[wt-health WARN]${NC} $*"; }
error()   { echo -e "${RED}[wt-health ERROR]${NC} $*"; }
success() { echo -e "${GREEN}[wt-health OK]${NC} $*"; }

AUTO_COMMIT="${AUTO_COMMIT:-false}"
PHASE="${PHASE:-unknown-phase}"
LANE="${LANE:-}"

# WHAT IS NOT THE AGENT'S UNCOMMITTED WORK — from the one place that knows.
#
# This was a hand-written list naming .dart_tool, build and node_modules, and lib/git-ops.sh
# carried a different one. It decides what counts as an uncommitted file, which sets issues=1,
# which makes Step 3.1 exit 1 — so on a Rust or Python codeline whose target/ or .venv/ was not
# gitignored, the build tree was reported as thousands of files of agent output and killed the
# phase.
#
# NO SILENT FALLBACK: an empty list here reports every artefact as agent work and fails the run,
# so a handler that cannot answer stops the check with a diagnosis instead.
EXCLUDE_PATTERNS=()
_wthc_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
if ! _wthc_ex=$("${NODE_BIN:-node}" "$_wthc_lib/handlers/repo-exclude-patterns.js" glob); then
    error "could not resolve the exclusion list — every build artefact would be reported as agent output"
    exit 1
fi
while IFS= read -r _wthc_pat; do
    [ -n "$_wthc_pat" ] && EXCLUDE_PATTERNS+=( "$_wthc_pat" )
done <<< "$_wthc_ex"

# ─────────────────────────────────────────────
# Build gitignore-style exclude args for git status
# ─────────────────────────────────────────────
_is_excluded() {
    local file="$1"
    for pat in "${EXCLUDE_PATTERNS[@]}"; do
        # shellcheck disable=SC2254
        case "$file" in
            $pat) return 0 ;;
        esac
    done
    return 1
}

# ─────────────────────────────────────────────
# Check a single worktree
# Returns: 0=ok, 1=uncommitted, 2=missing
# ─────────────────────────────────────────────
check_worktree() {
    local lane="$1"
    local git_basename
    git_basename="$(basename "$PROJECT_ROOT")"
    local wt_path="$PROJECT_ROOT/../${git_basename}-wt-$lane"
    local wt_branch="wt-$lane"
    local issues=0

    if [ ! -d "$wt_path" ]; then
        error "Worktree '$lane' does not exist at $wt_path"
        return 2
    fi

    log "Checking worktree: $lane ($wt_path)"

    # Verify it's a valid git worktree
    if ! git -C "$wt_path" rev-parse --git-dir > /dev/null 2>&1; then
        error "Worktree '$lane' is NOT a valid git repo: $wt_path"
        return 2
    fi

    # Check for untracked new files (agent-created files never committed)
    local untracked=()
    while IFS= read -r line; do
        local status="${line:0:2}"
        local file="${line:3}"
        # ?? = untracked, M = modified, A = added
        if [[ "$status" == "??" || "$status" =~ [MA] ]]; then
            if ! _is_excluded "$file"; then
                untracked+=("$file")
            fi
        fi
    done < <(git -C "$wt_path" status --short 2>/dev/null)

    if [ ${#untracked[@]} -gt 0 ]; then
        warn "Worktree '$lane' has ${#untracked[@]} uncommitted file(s):"
        for f in "${untracked[@]}"; do
            warn "  ?? $f"
        done
        issues=1
    fi

    # Check if branch has any commits ahead of the base (evidence of work)
    local ahead_commits
    ahead_commits=$(git -C "$wt_path" rev-list --count HEAD...origin/HEAD 2>/dev/null || \
                    git -C "$wt_path" rev-list --count "${wt_branch}" ^"$(git -C "$PROJECT_ROOT" rev-parse HEAD)" 2>/dev/null || \
                    echo 0)

    if [ "${ahead_commits:-0}" -eq 0 ] && [ ${#untracked[@]} -gt 0 ]; then
        warn "Worktree '$lane': 0 commits AND ${#untracked[@]} untracked files -- agent ran but never committed"
        issues=1
    elif [ "${ahead_commits:-0}" -gt 0 ]; then
        success "Worktree '$lane': $ahead_commits commit(s) ahead -- code is committed"
    fi

    # -- Auto-commit if requested --
    if [ $issues -gt 0 ] && [ "$AUTO_COMMIT" = "true" ]; then
        log "AUTO_COMMIT=true -- committing uncommitted files in '$lane'..."
        _auto_commit_worktree "$wt_path" "$lane"
        issues=0
    fi

    return $issues
}

# ─────────────────────────────────────────────
# Auto-commit all untracked/modified files in a worktree
# ─────────────────────────────────────────────
_auto_commit_worktree() {
    local wt_path="$1"
    local lane="$2"

    local timestamp
    timestamp=$(date -Iseconds)

    # Stage everything (agent code lives in src/ or similar -- not orchestrations/)
    # We deliberately exclude certain build artifact patterns
    # Was a third copy of the exclusion list, and the weakest: it excluded only
    # orchestrations/logs/*, so orchestrations/agents/KB.md passed straight through — and
    # it fell back to a bare `git add -A` that discarded even that. One implementation now.
    git_add_client_outputs "$wt_path"

    local changed_count
    changed_count=$(git -C "$wt_path" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

    if [ "${changed_count:-0}" -eq 0 ]; then
        warn "Auto-commit: nothing to stage in '$lane' after filtering"
        return 0
    fi

    # RENDERED FROM THE TEMPLATE LAYER. A commit message is prose a human reads in git log
    # months later; as a heredoc it could not be reviewed or diffed against anything else the
    # engine says, and its attribution line had gone stale where nobody would see it.
    local commit_msg _wt_vals
    _wt_vals=$(mktemp "${TMPDIR:-/tmp}/wt-autocommit-vals-XXXXXX.json")
    jq_vals --arg lane "$lane" \
          --arg phase "$PHASE" \
          --arg changed_count "$changed_count" \
          --arg timestamp "$timestamp" \
          --arg author "${EPAM_AUTOCOMMIT_AUTHOR:-Claude <noreply@anthropic.com>}" \
          '{"__LANE__":$lane,"__PHASE__":$phase,"__CHANGED_COUNT__":$changed_count,"__TIMESTAMP__":$timestamp,"__AUTHOR__":$author}' > "$_wt_vals"
    if ! commit_msg=$(render_engine_prompt worktree-autocommit-message "$_wt_vals"); then
        rm -f "$_wt_vals"
        error "cannot render the auto-commit message — refusing to write a commit nobody can explain"
        return 1
    fi
    rm -f "$_wt_vals"

    if git -C "$wt_path" commit -m "$commit_msg"; then
        success "Auto-committed $changed_count file(s) in worktree '$lane'"
    else
        error "Auto-commit failed in worktree '$lane'"
        return 1
    fi
}

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────
main() {
    local target_lane="${LANE:-}"
    local exit_code=0

    if [ -n "$target_lane" ]; then
        # Check specific lane
        check_worktree "$target_lane" || exit_code=$?
    else
        # Check all known lanes
        for lane in primary independent; do
            check_worktree "$lane" || exit_code=$((exit_code > $? ? exit_code : $?))
        done
    fi

    if [ $exit_code -eq 0 ]; then
        success "All worktrees healthy"
    elif [ "$AUTO_COMMIT" = "true" ]; then
        success "Auto-committed uncommitted files -- worktrees now healthy"
        exit_code=0
    else
        warn "Uncommitted files detected. Re-run with AUTO_COMMIT=true to fix."
        warn "Or manually: cd <worktree> && git add -A && git commit -m 'chore: agent output'"
    fi

    return $exit_code
}

main "$@"
