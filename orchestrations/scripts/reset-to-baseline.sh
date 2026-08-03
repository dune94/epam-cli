#!/usr/bin/env bash
# reset-to-baseline.sh — resets a project's git state to the last known-good
# checkpoint, removing accumulated contamination from failed/incomplete story
# attempts.
#
# Root cause this fixes (found live, 2026-07-06): the full tier3-travel-app-run.sh
# wrapper does a genuine `rm -rf` + fresh `git init` before every run, so it never
# accumulates garbage — but a FASTER validation loop (invoking
# run-agent-orchestration.sh directly against an already-scaffolded project, to
# reuse completed stories' state instead of rebuilding from scratch every time)
# has no equivalent teardown of its own. Across several runs, every failed
# story attempt auto-committed its broken leftover files (worktree-health-
# check.sh's AUTO_COMMIT=true safety net), and those commits accumulated on
# master run after run — a later run's "whole test suite" external
# verification then failed for an EARLIER, otherwise-passing story purely
# because a sibling story's stale broken test file was still sitting in the
# tree. This is a workspace-hygiene bug, not a story-implementation bug.
#
# "Baseline" = the most recent commit whose message matches
# `^<story_id>: story complete ` (the exact shape commit_completed_story() in
# claude.sh already writes for every genuinely completed story — ticket ID
# leads the message, colon-separated, to satisfy commit-message linters that
# require it there; "story complete" is the stable marker regardless of
# story_id) — found dynamically via `git log --grep`, never a hardcoded SHA
# or story ID, so this works identically for any project and any number of
# completed stories.
#
# Usage:
#   reset-to-baseline.sh <project_root>
#
# Exit 0 = reset succeeded (or nothing to reset — already at HEAD with no
#          worktrees and no contaminating commits).
# Exit 1 = project_root is not a git repo, or no baseline commit was found
#          (nothing safe to reset TO — caller should fall back to full teardown).

set -euo pipefail

PROJECT_ROOT="${1:?Usage: reset-to-baseline.sh <project_root>}"

if [ ! -d "$PROJECT_ROOT/.git" ]; then
    echo "reset-to-baseline: $PROJECT_ROOT is not a git repository — nothing to reset" >&2
    exit 1
fi

cd "$PROJECT_ROOT"

# Find the most recent "<ID>: story complete" commit — the last point at which
# the working tree was known to be genuinely clean (not a contaminated
# auto-commit from a failed attempt, which always uses a DIFFERENT message:
# "chore(wt-<lane>): auto-commit agent output" or "merge: phase <phase> ...").
baseline_sha=$(git log --grep='^[^:]*: story complete ' --format='%H' -n 1 2>/dev/null || true)

if [ -z "$baseline_sha" ]; then
    echo "reset-to-baseline: no '<id>: story complete' commit found in history — nothing safe to reset to (caller should fall back to full teardown)" >&2
    exit 1
fi

baseline_subject=$(git log -1 --format='%s' "$baseline_sha")
echo "reset-to-baseline: resetting $PROJECT_ROOT to baseline $baseline_sha ($baseline_subject)"

# Remove leftover worktrees/branches from any incomplete prior run — these
# hold references that would otherwise block a hard reset of the branches
# they're checked out on, or silently keep stale files alive alongside a
# freshly-reset main checkout.
#
# Worktree removal must be PRISTINE: a raw `rm -rf` on the worktree directory
# deletes the checkout but can leave git's internal admin metadata
# (.git/worktrees/<name>/) dangling and referencing a path that no longer
# exists — the exact live failure this caused earlier the same session
# ("fatal: a branch named 'wt-primary' already exists" on the NEXT run's
# `git worktree add`, because the stale branch ref survived a directory-only
# delete). `git worktree remove --force` is the correct, atomic way to drop
# both the checkout AND the admin metadata together; only fall back to manual
# rm+prune if the directory is already gone (worktree remove would fail with
# nothing to remove) or the metadata itself is already corrupted.
project_name="$(basename "$PROJECT_ROOT")"
project_parent="$(dirname "$PROJECT_ROOT")"
while IFS= read -r wt_path; do
    [ -z "$wt_path" ] && continue
    [ "$wt_path" = "$PROJECT_ROOT" ] && continue
    echo "reset-to-baseline: removing leftover worktree $wt_path"
    if ! git worktree remove --force "$wt_path" 2>/dev/null; then
        rm -rf "$wt_path"
    fi
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
git worktree prune --verbose 2>/dev/null || true

# Belt-and-suspenders: directories matching this project's worktree naming
# convention that exist on disk but are NOT registered in git's worktree list
# at all (e.g. metadata already corrupted/lost from a prior crash) — these
# would never be caught by the loop above since it only iterates git's own
# registry, so remove them directly too.
for stale_dir in "$project_parent/${project_name}-wt-"*; do
    [ -d "$stale_dir" ] && rm -rf "$stale_dir"
done
git worktree prune --verbose 2>/dev/null || true

# Branches left behind after worktree removal (git worktree remove deletes
# the checkout but not necessarily the branch it pointed to) — force-delete
# unconditionally, never left dangling for a future `git worktree add
# -b wt-primary` to collide with.
while IFS= read -r branch; do
    [ -z "$branch" ] && continue
    git branch -D "$branch" >/dev/null 2>&1 || true
done < <(git branch --list 'wt-*' | tr -d ' *')

# Final verification — a pristine reset MUST end with zero worktrees other
# than the main checkout. Fail loudly rather than silently leaving a corrupt
# worktree registry for the caller to hit later.
remaining_worktrees=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -vc "^${PROJECT_ROOT}$" || true)
if [ "${remaining_worktrees:-0}" -gt 0 ]; then
    echo "reset-to-baseline: FATAL — ${remaining_worktrees} worktree(s) still registered after cleanup, refusing to proceed with a dirty worktree state" >&2
    git worktree list >&2
    exit 1
fi

git reset --hard "$baseline_sha"
git clean -fd

echo "reset-to-baseline: done — HEAD is now $baseline_sha ($baseline_subject)"
