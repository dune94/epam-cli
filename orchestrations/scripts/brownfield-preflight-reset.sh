#!/usr/bin/env bash
# brownfield-preflight-reset.sh — run-START backstop for the predictable-
# teardown mandate (6+ months standing, not new — see
# orchestrations/scripts/lib/story-guards.sh's reset_brownfield_story_commit
# for the immediate, in-run half of this same mandate).
#
# A brownfield run may be repeated 200+ times until it succeeds. Any
# commit made during an incomplete/failed run is provisional until a story
# is verified to pass ALL of its gates (story_tsc_gate, specifically).
# reset_brownfield_story_commit() already self-heals the NORMAL failure path
# (gate fails mid-run -> immediate hard reset to that run's own
# phase-baseline-sha.txt). This script is the backstop for the case that
# self-heal can't cover: a run that gets KILLED before story_tsc_gate ever
# runs (mid-story, no gate check reached, no self-heal triggered) — leaving
# either an uncommitted dirty working tree, or a "story: complete X" commit
# that was NEVER actually gate-verified.
#
# Source of truth: record_brownfield_verified_baseline() (story-guards.sh)
# writes the current HEAD SHA to a marker OUTSIDE the codeline entirely
# (~/.epam/brownfield-baselines/<md5 of PROJECT_ROOT>.sha) every time a story
# genuinely passes story_tsc_gate. That marker survives `git reset --hard`
# unconditionally (it isn't part of the git working tree) and persists
# across runs regardless of how the previous run ended.
#
# If the marker exists and current HEAD differs from it, HEAD carries
# unverified work from an interrupted run — hard-reset to the marker.
# If the marker doesn't exist yet (first run ever for this codeline, or the
# state dir was cleared), this is a safe no-op — nothing known-good to reset
# to, so the codeline is left exactly as found.
#
# Usage:
#   bash orchestrations/scripts/brownfield-preflight-reset.sh <project_root>
#
# Exit 0 always (this is a best-effort backstop, never a hard pipeline
# blocker — a failure here should not prevent a run from starting).

set -uo pipefail

PROJECT_ROOT="${1:?Usage: brownfield-preflight-reset.sh <project_root>}"
STATE_DIR="${EPAM_BROWNFIELD_STATE_DIR:-$HOME/.epam/brownfield-baselines}"

log()  { echo "[brownfield-preflight-reset] $*"; }
warn() { echo "[brownfield-preflight-reset] WARN: $*" >&2; }

if [ ! -d "$PROJECT_ROOT/.git" ]; then
    warn "$PROJECT_ROOT is not a git repository — skipping (nothing to reset)"
    exit 0
fi

KEY=$(printf '%s' "$PROJECT_ROOT" | md5sum 2>/dev/null | cut -d' ' -f1)
if [ -z "$KEY" ]; then
    warn "could not compute state key — skipping"
    exit 0
fi

MARKER_FILE="$STATE_DIR/${KEY}.sha"

# ── Baseline branch takes PRECEDENCE over the verified marker ────────────────
# The true pre-run state is the baseline branch (JIRA_BASELINE_BRANCH, e.g.
# "develop"), NOT the verified-baseline marker. The marker records the last SHA
# that passed story_tsc_gate — but once a run COMMITS a fix that passes the gate,
# that fix BECOMES the marker, so "reset to the verified baseline" resets to the
# previous fix and every re-run of the same story builds ON TOP of it instead of
# starting clean. Found live 2026-07-24 (AMSD-1820): cdts's marker was the prior
# run's fix commit (ca30ebf, one commit above develop), so the detective saw
# already-fixed code and the run was invalid. When a baseline branch is set and
# resolvable in THIS repo, reset to it (discarding any story branch/fix on top)
# and refresh the marker to it so it can never re-accumulate a fix.
BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-}"
if [ -n "$BASELINE_BRANCH" ]; then
    # --verify: fail cleanly (no output) for a non-existent ref. Without it,
    # `git rev-parse origin/develop` echoes the literal "origin/develop" to
    # stdout when there's no such ref, which would then be used as a bogus SHA.
    BASELINE_SHA=$(git -C "$PROJECT_ROOT" rev-parse --verify --quiet "origin/${BASELINE_BRANCH}" 2>/dev/null \
                || git -C "$PROJECT_ROOT" rev-parse --verify --quiet "${BASELINE_BRANCH}" 2>/dev/null || echo "")
    if [ -n "$BASELINE_SHA" ]; then
        CUR=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")
        DRT=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null || echo "")
        if [ "$CUR" = "$BASELINE_SHA" ] && [ -z "$DRT" ]; then
            log "$PROJECT_ROOT already at baseline branch ${BASELINE_BRANCH} ($BASELINE_SHA) with a clean tree — nothing to do"
        else
            log "resetting $PROJECT_ROOT to baseline branch ${BASELINE_BRANCH} ($BASELINE_SHA) — discarding any prior-run fix on top (current: ${CUR:-unknown}, dirty: $([ -n "$DRT" ] && echo yes || echo no))"
            if git -C "$PROJECT_ROOT" reset --hard "$BASELINE_SHA" >/dev/null 2>&1; then
                git -C "$PROJECT_ROOT" clean -fd -e .codegraph >/dev/null 2>&1 || true
                log "reset complete — $PROJECT_ROOT is now at baseline ${BASELINE_BRANCH} ($BASELINE_SHA)"
            else
                warn "git reset --hard to ${BASELINE_BRANCH} failed — leaving repo as-is"
            fi
        fi
        # Refresh the marker to the baseline so a later gate-pass can't leave it
        # pointing at a fix commit for the NEXT run.
        mkdir -p "$STATE_DIR" 2>/dev/null || true
        printf '%s\n' "$BASELINE_SHA" > "$MARKER_FILE" 2>/dev/null || true
        exit 0
    fi
    log "baseline branch '${BASELINE_BRANCH}' not found in $PROJECT_ROOT — falling back to verified-marker logic"
fi

if [ ! -f "$MARKER_FILE" ]; then
    log "no verified-baseline marker yet for $PROJECT_ROOT — nothing known-good to reset to, leaving as-is"
    exit 0
fi

VERIFIED_SHA=$(tr -d '[:space:]' < "$MARKER_FILE")
if [ -z "$VERIFIED_SHA" ]; then
    warn "marker file is empty — skipping"
    exit 0
fi

CURRENT_SHA=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")
DIRTY=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null || echo "")

if [ "$CURRENT_SHA" = "$VERIFIED_SHA" ] && [ -z "$DIRTY" ]; then
    log "$PROJECT_ROOT already at the last verified baseline ($VERIFIED_SHA) with a clean working tree — nothing to do"
    exit 0
fi

# Verify the marker SHA actually exists in this repo's history before
# resetting to it — a stale marker from a different clone/rebase history
# must never cause a reset to a nonexistent or wrong commit.
if ! git -C "$PROJECT_ROOT" cat-file -e "${VERIFIED_SHA}^{commit}" 2>/dev/null; then
    warn "marker SHA $VERIFIED_SHA not found in $PROJECT_ROOT's history — skipping reset (stale marker, leaving repo untouched)"
    exit 0
fi

log "resetting $PROJECT_ROOT to last verified baseline $VERIFIED_SHA (current: ${CURRENT_SHA:-unknown}, dirty: $([ -n "$DIRTY" ] && echo yes || echo no))"
if git -C "$PROJECT_ROOT" reset --hard "$VERIFIED_SHA" >/dev/null 2>&1; then
    # -e .codegraph: NEVER let git clean touch the CodeGraph index. Root cause
    # found live 2026-07-23: the index is protected only by an untracked
    # .codegraph/.gitignore (which ignores codegraph.db). But `git clean -fd`
    # removes that .gitignore itself on its FIRST pass (it's untracked and not
    # ignored) — which un-ignores codegraph.db, so the NEXT `git clean -fd`
    # anywhere in the run (this script runs once, but the merge step and any
    # per-story reset run more) deletes the db and the whole .codegraph/ dir.
    # Empirically confirmed: two passes of `git clean -fd` destroy the entire
    # index. Excluding .codegraph directly protects it regardless of pass count.
    git -C "$PROJECT_ROOT" clean -fd -e .codegraph >/dev/null 2>&1 || true
    log "reset complete — $PROJECT_ROOT is now at $VERIFIED_SHA"
else
    warn "git reset --hard failed — leaving repo as-is"
fi
exit 0
