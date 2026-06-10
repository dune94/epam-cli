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

# Files/patterns to exclude from the untracked check
# (build artifacts, IDE dirs, OS files that agents shouldn't commit)
EXCLUDE_PATTERNS=(
    "*.dart_tool*"
    "*/build/*"
    "*/node_modules/*"
    "*.DS_Store"
    "*.idea/*"
    "orchestrations/logs/*"
    "orchestrations/prd.json.lock"
    "orchestrations/prd.json.backup"
)

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
    git -C "$wt_path" add \
        -- src/ lib/ packages/ \
        2>/dev/null || \
    git -C "$wt_path" add -A -- \
        ':!orchestrations/logs/*' \
        ':!*/node_modules/*' \
        ':!*/build/*' \
        ':!*/.next/*' \
        2>/dev/null || \
    git -C "$wt_path" add -A

    local changed_count
    changed_count=$(git -C "$wt_path" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

    if [ "${changed_count:-0}" -eq 0 ]; then
        warn "Auto-commit: nothing to stage in '$lane' after filtering"
        return 0
    fi

    local commit_msg
    commit_msg="$(cat <<EOF
chore(wt-$lane): auto-commit agent output for phase $PHASE

Automated commit of $changed_count file(s) produced by $lane agent.
Phase: $PHASE
Lane: $lane
Timestamp: $timestamp

WARNING: This was auto-committed by worktree-health-check.sh because
the agent did not commit its own changes. Review these files.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"

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
