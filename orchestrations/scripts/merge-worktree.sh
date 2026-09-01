#!/bin/bash
# Merges worktree branch back to main with automated conflict detection
# and test validation
# EPAM CLI orchestration worktree merge
#
# Usage:
#   merge-worktree.sh <LANE> <PHASE_ID>
#
# Arguments:
#   LANE      - Worktree lane (primary|independent)
#   PHASE_ID  - Phase identifier for commit message
#
# Environment variables:
#   SKIP_TESTS     - Set to 'true' to skip test execution (default: false)
#   MERGE_LOG      - Path to merge log (default: orchestrations/logs/merge-requests.jsonl)
#
# Exit codes:
#   0 - Merge successful
#   1 - Merge conflicts detected (requires manual resolution)
#   2 - Tests failed after merge
#   3 - Invalid arguments or prerequisites

set -euo pipefail

# _run_project_verification <project_root>
# Runs the project's declared check (.epam/verification.json) via the verification plugin.
# The engine names no tool, extension, directory or runtime path. Undeclared -> non-zero with a
# reason, never a silent pass.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _auto="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}"
    local _plugin="${_auto}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then echo "verification plugin missing at $_plugin"; return 2; fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}


# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${CYAN}[MERGE]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Parse arguments
if [ $# -lt 2 ]; then
    error "Missing required arguments"
    echo "Usage: $0 <LANE> <PHASE_ID>" >&2
    echo "  LANE: primary | independent" >&2
    echo "  PHASE_ID: Phase identifier (e.g., phase1_foundation)" >&2
    exit 3
fi

LANE=$1
PHASE_ID=$2
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
SKIP_TESTS="${SKIP_TESTS:-false}"
MERGE_LOG="${MERGE_LOG:-$AUTOMATION_DIR/logs/merge-requests.jsonl}"

# Validate lane
if [[ "$LANE" != "primary" && "$LANE" != "independent" ]]; then
    error "Invalid lane: $LANE (must be 'primary' or 'independent')"
    exit 3
fi

# Derive branch name from worktree
WORKTREE_PATH="$PROJECT_ROOT/../$(basename "$PROJECT_ROOT")-wt-$LANE"
BRANCH_NAME="wt-$LANE"

# Validate prerequisites
if [ ! -d "$WORKTREE_PATH" ]; then
    error "Worktree not found: $WORKTREE_PATH"
    error "Run setup-worktrees first or check worktree still exists"
    exit 3
fi

if ! git rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
    error "Branch not found: $BRANCH_NAME"
    exit 3
fi

# Ensure we're on the integration branch.
#
# This said `git checkout main`. A project whose trunk is develop, trunk or release/* was
# switched onto a branch that may not exist, and the merge either failed or landed on the
# wrong base. The branch is CONFIGURATION (JIRA_BASELINE_BRANCH) and, failing that,
# DETERMINABLE — the remote's own HEAD says what the default branch is. Never a literal.
cd "$PROJECT_ROOT"
_integration_branch="${JIRA_BASELINE_BRANCH:-}"
if [ -z "$_integration_branch" ]; then
    # origin/HEAD -> origin/<default>; ask the repository rather than assume a name.
    # `|| true`: under `set -euo pipefail` a failing symbolic-ref makes the whole pipeline
    # non-zero, and a BARE assignment from a failed substitution aborts the script — the
    # same set -e trap documented elsewhere in this pipeline. A repo with no origin is an
    # ordinary case here, not an error.
    _integration_branch=$(git symbolic-ref --short --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
fi
current_branch=$(git branch --show-current)
if [ -z "$_integration_branch" ]; then
    # No config and no remote HEAD to ask: a repository with no origin is already ON its
    # integration branch, so stay put rather than guess a name. Failing here would break
    # every local/offline repo; guessing "main" was the original defect.
    _integration_branch="$current_branch"
fi
if [ "$current_branch" != "$_integration_branch" ]; then
    warning "Not on ${_integration_branch} (currently on $current_branch)"
    log "Switching to ${_integration_branch}..."
    git checkout "$_integration_branch" || {
        error "Failed to checkout ${_integration_branch}"
        exit 3
    }
fi

log "Merging worktree lane '$LANE' (branch: $BRANCH_NAME) for phase '$PHASE_ID'"
echo ""

# Create log directory
mkdir -p "$(dirname "$MERGE_LOG")"

# ────────────────────────────────────────────
# Step 1: Pre-merge checks
# ────────────────────────────────────────────
log "Step 1: Pre-merge readiness checks..."

# Check if main is clean
if ! git diff-index --quiet HEAD --; then
    error "Main branch has uncommitted changes"
    error "Commit or stash changes before merging"
    git status --short
    exit 3
fi

# Check if worktree branch has commits
worktree_commits=$(git rev-list --count main.."$BRANCH_NAME" 2>/dev/null || echo "0")
if [ "$worktree_commits" -eq 0 ]; then
    warning "No new commits in $BRANCH_NAME (nothing to merge)"
    exit 0
fi

success "Pre-merge checks passed ($worktree_commits commits to merge)"
echo ""

# ────────────────────────────────────────────
# Step 2: Attempt merge
# ────────────────────────────────────────────
log "Step 2: Attempting merge..."

merge_output=$(mktemp)
# The expansion is deliberate: the trap must remove THE FILE CREATED ON THE LINE ABOVE, even if
# merge_output is later reassigned. Deferring it (single quotes) would delete whatever the variable
# happens to name at exit, which is not the temp file this trap was installed for.
# shellcheck disable=SC2064
trap "rm -f $merge_output" EXIT

if ! git merge --no-commit --no-ff "$BRANCH_NAME" 2>&1 | tee "$merge_output"; then
    # Merge command failed - could be conflicts or other error
    merge_failed=true
else
    merge_failed=false
fi

# Check for conflicts in output
if grep -qi "CONFLICT\|Automatic merge failed" "$merge_output"; then
    error "Merge conflicts detected"
    echo ""
    log "Conflict summary:"
    git status --short | grep "^UU\|^AA\|^DD" || true
    echo ""

    # Abort merge
    git merge --abort

    # Log conflict for Team Lead review
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    conflict_files=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "unknown")

    jq -nc \
        --arg lane "$LANE" \
        --arg branch "$BRANCH_NAME" \
        --arg phase "$PHASE_ID" \
        --arg ts "$timestamp" \
        --arg files "$conflict_files" \
        '{
            lane: $lane,
            branch: $branch,
            phase_id: $phase,
            status: "conflict",
            timestamp: $ts,
            conflict_files: ($files | split("\n")),
            requires_review: true
        }' >> "$MERGE_LOG"

    error "Merge aborted due to conflicts"
    warning "Team Lead review required"
    warning "To resolve manually:"
    echo "  1. git merge $BRANCH_NAME"
    echo "  2. Resolve conflicts"
    echo "  3. git add <resolved-files>"
    echo "  4. git commit"
    echo ""
    echo "Conflict logged to: $MERGE_LOG"
    exit 1
fi

success "Merge completed without conflicts"
echo ""

# ────────────────────────────────────────────
# Step 3: Run tests after merge
# ────────────────────────────────────────────
log "Step 3: Running post-merge validation..."

if [ "$SKIP_TESTS" = "true" ]; then
    warning "Test execution skipped (SKIP_TESTS=true)"
    tests_passed=true
else
    # Check if Node.js project with vitest exists
    if [ -f "$PROJECT_ROOT/package.json" ]; then
        log "  Checking TypeScript compilation..."
        if (cd "$PROJECT_ROOT" && _run_project_verification "$PROJECT_ROOT" > /dev/null 2>&1); then
            success "  TypeScript compilation passed"
            tests_passed=true
        else
            error "  TypeScript compilation failed"
            tests_passed=false
        fi
    else
        # No specific tests available, assume passing
        warning "  No package.json configured, assuming passing"
        tests_passed=true
    fi
fi

if [ "$tests_passed" = false ]; then
    error "Tests failed after merge"

    # Abort merge
    git reset --merge

    # Log test failure
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq -nc \
        --arg lane "$LANE" \
        --arg branch "$BRANCH_NAME" \
        --arg phase "$PHASE_ID" \
        --arg ts "$timestamp" \
        '{
            lane: $lane,
            branch: $branch,
            phase_id: $phase,
            status: "test_failure",
            timestamp: $ts,
            requires_review: true
        }' >> "$MERGE_LOG"

    error "Merge aborted due to test failures"
    echo "Test failure logged to: $MERGE_LOG"
    exit 2
fi

success "Post-merge validation passed"
echo ""

# ────────────────────────────────────────────
# Step 4: Commit merge
# ────────────────────────────────────────────
log "Step 4: Committing merge..."

# Get list of changed files for commit message
changed_files=$(git diff --cached --name-only | wc -l)

commit_msg="Merge $LANE lane: $PHASE_ID

Automated merge from worktree branch $BRANCH_NAME.
Changed files: $changed_files
All tests passing, no conflicts detected.

Phase: $PHASE_ID
Lane: $LANE
Commits merged: $worktree_commits

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

if git commit -m "$commit_msg"; then
    success "Merge committed successfully"
else
    error "Failed to commit merge"
    exit 3
fi

# Log successful merge
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
commit_sha=$(git rev-parse HEAD)

jq -nc \
    --arg lane "$LANE" \
    --arg branch "$BRANCH_NAME" \
    --arg phase "$PHASE_ID" \
    --arg ts "$timestamp" \
    --arg sha "$commit_sha" \
    --argjson commits "$worktree_commits" \
    --argjson files "$changed_files" \
    '{
        lane: $lane,
        branch: $branch,
        phase_id: $phase,
        status: "merged",
        timestamp: $ts,
        commit_sha: $sha,
        commits_merged: $commits,
        files_changed: $files
    }' >> "$MERGE_LOG"

echo ""
success "Merge completed successfully!"
echo ""
echo "Summary:"
echo "  Lane: $LANE"
echo "  Branch: $BRANCH_NAME"
echo "  Phase: $PHASE_ID"
echo "  Commits merged: $worktree_commits"
echo "  Files changed: $changed_files"
echo "  Commit: $commit_sha"
echo ""
echo "Merge logged to: $MERGE_LOG"

exit 0
