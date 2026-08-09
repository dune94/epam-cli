#!/usr/bin/env bash
# Shared git-mutation primitives — single source of truth, sourced by
# run-agent-orchestration.sh, claude.sh, and codemie-claude.sh.
#
# Root cause this fixes (found live, 2026-08-02, git-surface audit): before
# this file existed, setup_worktrees()/cleanup_worktrees() were independently
# copy-pasted into claude.sh AND codemie-claude.sh. claude.sh's copy got a
# real bug fix (2026-07-06: stale-worktree validation, branch deletion on
# cleanup, prune-before-delete ordering, a final zero-worktrees-remain
# verification) that codemie-claude.sh's copy never received — a silent,
# untested drift that would have reproduced the exact "fatal: a branch named
# 'wt-primary' already exists" live failure the first time codemie-claude.sh
# was used for a real run. Per the "all lanes must have the same flow, no
# deviations" principle already applied to lib/story-guards.sh, every caller
# now shares the exact same function bodies instead of re-implementing them.
#
# Requires from the caller's environment: the log/warning/success/error
# helpers — already defined identically in all three sourcing scripts (same
# convention lib/story-guards.sh already relies on).

# ensure_story_branch <codeline_root> <story_id> [baseline_branch]
# Every story commits to its OWN dedicated branch ("AI-<story_id>", derived
# entirely from the story ID in flight — never a hardcoded name), freshly
# created off origin/<baseline_branch> every single time via `checkout -B`
# (which resets the branch to that start-point if it already exists,
# discarding any prior half-done local attempt — same "clean slate every
# run" principle already applied elsewhere in this pipeline).
#
# Live bug this eliminates (2026-07-22): the previous design committed
# directly onto the shared baseline branch (develop) and relied on a durable
# local marker (record_brownfield_verified_baseline / brownfield-preflight-
# reset.sh) to know what "last known good" state to reset back to before each
# run. That marker only updates when a story genuinely passes story_tsc_gate
# — a manual correction to the branch (e.g. a human running `git reset --hard
# origin/develop`) doesn't update it, so it can point at an already-discarded,
# orphaned commit. The next run then trusts that stale marker and resets the
# shared branch BACKWARD onto abandoned history, and a new story commit lands
# on top of the wrong base — confirmed live: a discarded commit
# (.epam/setup-deps.sh cruft) got silently reintroduced this way, and the
# story commit built on top of it.
#
# Branching per story removes the entire problem class: there is no shared
# mutable branch state to protect via a local marker. Every story always
# starts from the ACTUAL current origin/<baseline_branch> tip, live, via
# `git fetch` — never a cached/remembered SHA that can go stale.
# _provision_epam_plugin_config <project_root>
# Writes .epam/settings.json (plugins) and .epam/codeline-facts.json for
# THIS project_root. Shared so every git-mutating reset that wipes .epam/
# (untracked, no .gitignore guarantee on a real client repo — confirmed live,
# none of Metrolinx's 3 codelines ignore it) has exactly one place to restore
# it from, instead of independently drifting copies.
#
# CodeGraph's query tool (orchestrations/plugins/codegraph-tools.js) ships
# with epam-cli itself — provisioned into .epam/settings.json's "tools"
# array for EVERY codeline unconditionally (mirroring run-agent-
# orchestration.sh's own per-codeline provisioning step), merged with
# whatever the project's own EPAM_PROJECT_CONFIG_DIR/plugins.json adds on
# top. codeline-facts.json remains purely project-config-driven and is a
# silent no-op when no project config dir is set or the codeline can't be
# matched against project.outputDirs.
_provision_epam_plugin_config() {
    local _project_root="$1"

    local _project_tools_json="[]"
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" ]; then
        _project_tools_json=$(jq -c '.tools // []' "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" 2>/dev/null || echo "[]")
    fi

    local _codegraph_plugin_abs=""
    local _codegraph_plugin_src="${SCRIPT_DIR:-}/../plugins/codegraph-tools.js"
    if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$_codegraph_plugin_src" ]; then
        _codegraph_plugin_abs="$(cd "$(dirname "$_codegraph_plugin_src")" 2>/dev/null && pwd)/$(basename "$_codegraph_plugin_src")"
    fi

    if [ -n "$_codegraph_plugin_abs" ] || [ "$_project_tools_json" != "[]" ]; then
        mkdir -p "${_project_root}/.epam"
        jq -n --argjson project "$_project_tools_json" --arg cg "$_codegraph_plugin_abs" \
            '{tools: (((if $cg != "" then [$cg] else [] end) + $project) | unique)}' \
            > "${_project_root}/.epam/settings.json"
    fi

    [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] || return 0
    local _facts_cfg="${EPAM_PROJECT_CONFIG_DIR}/codeline-facts.json"
    [ -f "$_facts_cfg" ] || return 0

    local _prd_for_lookup="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -f "${_prd_for_lookup:-}" ] || return 0
    local _cl
    _cl=$(jq -r --arg root "$_project_root" \
        '.project.outputDirs[]? | select(.path == $root) | .codeline' \
        "$_prd_for_lookup" 2>/dev/null | head -1)
    [ -n "$_cl" ] || return 0

    local _cl_facts
    _cl_facts=$(jq -c --arg cl "$_cl" '.[$cl] // empty' "$_facts_cfg" 2>/dev/null)
    if [ -n "$_cl_facts" ]; then
        mkdir -p "${_project_root}/.epam"
        echo "$_cl_facts" > "${_project_root}/.epam/codeline-facts.json"
    fi
}

# ── The engine's perimeter at the staging seam ──────────────────────────────
#
# Directories epam-cli writes into a client codeline so its gates can read them. They
# are never client content and must never be committed there.
#
# The list is the CLASS, not one instance. Excluding only .epam (as this first did) let
# .deepeval/.deepeval_telemetry.txt into a live metrolinx commit hours later — the same
# defect wearing a different filename. orchestrations/ was added 2026-08-01 after the KB
# writer dropped orchestrations/agents/KB.md into a client repo; only orchestrations/logs/*
# had been excluded, so the "excluded one instance, not the class" gap reappeared under a
# new path. All were verified absent from the client baseline tree (origin/develop).
#
# Kept in sync with src/config/enginePaths.ts, which enforces the same perimeter at the
# WRITE seam — where it actually belongs. This is defence in depth: by the time a file
# reaches staging it already exists in the customer's working tree, where the writer-output
# manifest picks it up as though the writer produced it (live 20260804T225443Z).
# shellcheck source=engine-paths.sh
. "$(dirname "${BASH_SOURCE[0]}")/engine-paths.sh"
. "$(dirname "${BASH_SOURCE[0]}")/codeline-write-perimeter.sh"

# git_add_client_outputs <repo> [timeout_secs]
# Stage every client change, never an engine artefact. Returns git's exit code.
#
# There is deliberately NO fallback that stages without the exclusions. Every previous
# call site had `... || git add -A`, which discarded the whole rule the moment the
# pathspec form returned non-zero — and `git add -A -- :!x` returns non-zero in ordinary
# situations (e.g. a repo with no HEAD). The exclusions existed at two of three sites and
# were bypassable at all three.
git_add_client_outputs() {
    local _repo="$1"
    local _timeout="${2:-${EPAM_COMMIT_TIMEOUT_SECS:-60}}"
    [ -n "$_repo" ] && [ -d "$_repo/.git" ] || return 0

    local _excludes=() _resets=() _d
    for _d in "${_ENGINE_OWNED_DIRS[@]}"; do
        _excludes+=( ":!${_d}/*" ":!*/${_d}/*" )
        _resets+=( "$_d" )
    done
    # Build artefacts are not engine state, but staging them is never right either.
    # BOTH forms are required: `:!*/node_modules/*` matches only a NESTED node_modules —
    # a top-level one (the usual case) needs `:!node_modules/*`. The original list carried
    # only the nested form, so a repo without node_modules in .gitignore staged the lot.
    for _d in 'node_modules' 'build' '.next'; do
        _excludes+=( ":!${_d}/*" ":!*/${_d}/*" )
    done

    timeout "$_timeout" git -C "$_repo" add -A -- "${_excludes[@]}" 2>/dev/null
    local _rc=$?

    # Belt and braces, run unconditionally: if the pathspec form above failed for any
    # reason, anything engine-owned that slipped into the index comes straight back out.
    # This is what makes the no-fallback rule safe rather than merely strict.
    timeout "$_timeout" git -C "$_repo" reset -q -- "${_resets[@]}" 2>/dev/null || true

    # ASK THE INDEX, NOT THE EXIT CODE.
    #
    # `git add` exits non-zero merely for NAMING an ignored path — which is exactly what the
    # exclusion pathspecs above do. Live 2026-08-09: the writer installed a dependency, so a
    # gitignored top-level node_modules appeared, git printed "The following paths are ignored
    # by one of your .gitignore files" and exited 1 — with all 323 insertions correctly staged.
    # The raw code propagated to commit_completed_story, the story was demoted as undelivered,
    # the phase aborted and the remaining two codelines never ran.
    #
    # Whether work is staged is a fact, so read it. A non-zero exit with a populated index is a
    # warning. A non-zero exit with an EMPTY index, when there was something to stage, is a real
    # failure and still fails. The comment above already predicted this class ("returns non-zero
    # in ordinary situations") without handling it.
    local _staged _pending
    # wc -l, not `grep -c . || echo 0`: on empty input grep prints 0 AND exits 1, so the
    # fallback appends a second 0 and the numeric comparison below errors out.
    _staged=$(timeout "$_timeout" git -C "$_repo" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    if [ "${_staged:-0}" -gt 0 ]; then
        return 0
    fi
    # Nothing staged. If nothing was stageable either, that is a correct no-op, not a failure.
    _pending=$(timeout "$_timeout" git -C "$_repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$_rc" -ne 0 ] && [ "${_pending:-0}" -eq 0 ]; then
        # git could not even report status: the repository is genuinely unusable.
        timeout "$_timeout" git -C "$_repo" status --porcelain >/dev/null 2>&1 || return "$_rc"
    fi
    [ "${_pending:-0}" -eq 0 ] && return 0
    return $_rc
}

ensure_story_branch() {
    local codeline_root="$1"
    local story_id="$2"
    local baseline_branch="${3:-${JIRA_BASELINE_BRANCH:-main}}"

    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "$codeline_root/.git" ] || return 0
    [ -n "$story_id" ] || return 0

    # EPAM_BRANCH_PREFIX is project-configurable (set in the project's own
    # config.env) — never hardcoded here. Some client repos enforce a branch
    # naming convention (e.g. commitlint/husky requiring a leading
    # feature|bugfix|tech|release|hotfix/ segment); most projects have no such
    # constraint, so the default preserves today's plain "AI-<story_id>" shape.
    local _branch="${EPAM_BRANCH_PREFIX:-}AI-${story_id}"

    if ! git -C "$codeline_root" fetch origin "$baseline_branch" --quiet 2>/dev/null; then
        warning "  [story-branch] $story_id: could not fetch origin/${baseline_branch} — proceeding on current branch state"
        return 1
    fi

    if git -C "$codeline_root" checkout -B "$_branch" "origin/${baseline_branch}" --quiet 2>/dev/null; then
        # checkout -B only forces tracked files that DIFFER between the old
        # branch tip and the new start-point — a tracked file whose content
        # is IDENTICAL in both survives untouched, dirty modifications and
        # all. Found live 2026-08-02 (metrolinx, AMSD-2041 Writer Retest): a
        # SEPARATE, already-killed run's leftover uncommitted contentstack.ts
        # changes plus an untracked spec file survived checkout -B intact, so
        # the NEXT run's agent burned its entire watchdog budget (600s+900s)
        # reconciling old debris against an "approved" commit instead of
        # doing fresh work — a real, systemic issue (the same class of
        # leftover-worktree-state bug already documented for gotransit in
        # agent-audit-2026-07-31.md). `checkout -B` promises "freshly based
        # on origin" for the BRANCH; it never promised a clean WORKING TREE.
        # reset --hard forces every tracked file back regardless of diff;
        # clean -fd drops untracked cruft — the exact "predictable teardown"
        # primitive brownfield-preflight-reset.sh already applies between
        # RUNS and _selective_worktree_reset applies between RUNGS, now also
        # applied here, once, before a story's FIRST attempt even begins.
        git -C "$codeline_root" reset --hard "origin/${baseline_branch}" --quiet 2>/dev/null || true
        git -C "$codeline_root" clean -fd --quiet 2>/dev/null || true
        _provision_epam_plugin_config "$codeline_root"
        # The repo is now on a story branch, which is where edits are allowed to
        # land — reopen it. While it sat on the baseline branch it was chmod'd
        # read-only (see lib/codeline-write-perimeter.sh): a spec-pass agent
        # rewrote ~1050 lines of client source there before any writer ran, and
        # a per-tool allowlist cannot stop that because `bash` bypasses it.
        perimeter_apply "$codeline_root"
        success "  [story-branch] $story_id: on branch '${_branch}', freshly based on origin/${baseline_branch} (working tree hard-reset + cleaned)"
        return 0
    fi

    warning "  [story-branch] $story_id: could not create/reset branch '${_branch}' off origin/${baseline_branch} — proceeding on current branch"
    return 1
}

# commit_completed_story <story_id>
# Stages and commits whatever a completed story wrote, scoped to the current
# GIT_WORK_ROOT (the worktree checkout when running --worktree, the main repo
# otherwise, falling back to PROJECT_ROOT for callers that only set that).
# Best-effort: a commit failure here must not fail the story itself, since
# the retry/health-check machinery downstream still has its own commit gates.
commit_completed_story() {
    local story_id="$1"
    local _commit_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    # Bounded timeout on git operations (added 2026-07-06): a live run's story-
    # level 600s watchdog killed the whole claude.sh subprocess with zero log
    # output after a story succeeded — generate_story_contract()/
    # commit_completed_story() were the only unlogged steps left, and neither
    # had any bound on how long its git/python calls could take (e.g. a stale
    # lock, a slow filesystem). 60s is generous for `git add`/`git commit` on
    # this project's size; a hang here now fails fast and visibly instead of
    # silently consuming the entire story-level watchdog budget.
    local _git_timeout="${EPAM_COMMIT_TIMEOUT_SECS:-60}"

    # set +e/-e around this block (found live, 2026-07-14, tier3-travel-app
    # run — first time a worktree lane ran real multi-story work): under
    # set -e (active for this whole script), `CMD1 || CMD2` as a bare
    # statement DOES still abort the script if CMD2 (the last command in the
    # || list) also fails — the fallback `git add -A` failing for ANY reason
    # (not just the 124-timeout case this code checks for) silently killed
    # the entire claude.sh process here, before `_add_rc=$?` was ever
    # reached, with zero warning logged and every remaining story in this
    # worktree lane (SKY-003-impl/-test, SKY-004 in the observed incident)
    # never even attempted.
    # ONE staging rule, one implementation. This block used to be duplicated in
    # worktree-health-check.sh (which excluded only orchestrations/logs/*, so
    # orchestrations/agents/KB.md passed straight through) and absent entirely from
    # run-agent-orchestration.sh's Step 9 (a bare `git add -A`). Three copies is how a
    # rule drifts; see git_add_client_outputs for the full history.
    set +e
    git_add_client_outputs "$_commit_root" "$_git_timeout"
    local _add_rc=$?
    set -e
    if [ "$_add_rc" -ne 0 ]; then
        if [ "$_add_rc" -eq 124 ]; then
            warning "  [commit_completed_story] git add timed out after ${_git_timeout}s for ${story_id} — work remains staged/uncommitted"
        else
            warning "  [commit_completed_story] git add failed (exit ${_add_rc}) for ${story_id} — work remains staged/uncommitted"
        fi
        return 1
    fi

    local _changed_count
    _changed_count=$(timeout "$_git_timeout" git -C "$_commit_root" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    if [ "${_changed_count:-0}" -eq 0 ]; then
        return 0
    fi

    # Generic credential scan (flow-gap analysis finding #2, 2026-07-12): no
    # commit site in this pipeline scanned staged changes for accidentally-
    # committed secrets before this. SAST (Step 4.2) is the first thing that
    # even looks at code content for this, and it runs long after this commit
    # would already be in git history. scan-secrets.sh is generic and stack-
    # agnostic (well-known credential formats only) — see its own header.
    local _scan_sh="${SCRIPT_DIR}/scan-secrets.sh"
    if [ "${SKIP_SECRET_SCAN:-true}" != "true" ] && [ -f "$_scan_sh" ]; then
        local _scan_output _scan_rc
        # set +e/-e (found live, 2026-07-14, same incident as the git-add fix
        # above): `var=$(failing_cmd)` as a bare assignment statement is
        # ALSO a set -e trigger — scan-secrets.sh exiting non-zero (its
        # intentional, designed signal for "found a secret") killed the
        # whole script on THIS line, one statement before `_scan_rc=$?` and
        # the warning/return-1 handling below ever ran, so a real secret hit
        # (or, per this incident, any other non-zero exit from the scan)
        # silently took down every remaining story in the lane instead of
        # gracefully unstaging and skipping just this one commit.
        set +e
        _scan_output=$(bash "$_scan_sh" "$_commit_root" 2>&1)
        _scan_rc=$?
        set -e
        if [ "$_scan_rc" -ne 0 ]; then
            warning "  [commit_completed_story] $_scan_output"
            warning "  [commit_completed_story] Refusing to commit for ${story_id} — unstaging (SECRET_SCAN)"
            timeout "$_git_timeout" git -C "$_commit_root" reset 2>/dev/null || true
            return 1
        fi
    fi

    # Real stderr (e.g. a pre-commit hook's own output — husky/lint-staged
    # can run type-check/eslint/prettier and legitimately fail or just be
    # slow under concurrent-lane load) was previously discarded entirely
    # (>/dev/null 2>&1), so a commit failure here was never diagnosable
    # after the fact — found live 2026-08-01, AMSD-2041: a real, verified-
    # correct, tsc-passing fix sat staged/uncommitted with no way to tell
    # whether a hook rejected it, it timed out, or something else failed.
    # set +e/-e (same reason as the git-add block above): this whole function
    # runs under set -e, so a bare `_commit_output=$(failing_cmd)` assignment
    # aborts the script immediately on a real commit failure — found while
    # testing this exact fix, 2026-08-01 — silently reintroducing the "commit
    # failure gives zero diagnosis" defect this stderr capture exists to fix.
    # Message leads with story_id, colon-separated — found live 2026-08-02:
    # a client repo's own commitlint (commitlint-plugin-jira-rules) rejected
    # "story: complete AMSD-2041 (3 file(s))" because the ticket ID must be
    # the FIRST token, not buried mid-message. This isn't Jira-specific
    # knowledge baked in here — ticket-ID-first is the standard shape most
    # commit-message linters expect, so it's a strictly more correct default
    # template, not a per-project config lookup. "story complete" is kept as
    # a stable marker — reset-to-baseline.sh's `git log --grep` and
    # run-agent-orchestration.sh's git-history story-id fallback both key off
    # it; both were updated in the SAME change (see their own comments).
    set +e
    local _commit_output
    _commit_output=$(timeout "$_git_timeout" git -C "$_commit_root" commit -m "${story_id}: story complete (${_changed_count} file(s))" 2>&1)
    local _commit_rc=$?
    set -e
    if [ "$_commit_rc" -eq 0 ]; then
        log "  Committed ${_changed_count} file(s) for ${story_id}"
        # Refresh the CodeGraph index now that this story's writes are final
        # on disk. Until 2026-08-06 the index was built ONCE per run, before
        # any writer ran, and never rebuilt — so the reviewer's codegraph_query
        # tool (team-lead-review.sh hands it out explicitly to check "does a
        # helper already exist?") was reading a pre-writer snapshot and could
        # not see the writer's own output. See codegraph-reindex.sh's docstring
        # for the full diagnosis. Never blocks: the script always exits 0.
        local _cg_reindex="${SCRIPT_DIR:-}/codegraph-reindex.sh"
        if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$_cg_reindex" ]; then
            bash "$_cg_reindex" "$_commit_root" "post-commit ${story_id}" || true
        fi
    elif [ "$_commit_rc" -eq 124 ]; then
        warning "  [commit_completed_story] git commit timed out after ${_git_timeout}s for ${story_id} — work remains staged/uncommitted"
    else
        warning "  Commit failed for ${story_id} (exit ${_commit_rc}) — work remains staged/uncommitted. Output:"
        warning "  $_commit_output"
    fi
}

# Setup git worktrees for parallel execution.
# Runs git commands from GIT_WORK_ROOT (falling back to PROJECT_ROOT for
# callers, like codemie-claude.sh, that only set that) — the directory
# containing .git. Worktrees are created as siblings of that root.
setup_worktrees() {
    local worktrees=("primary" "independent")
    local git_root
    git_root="$(cd "${GIT_WORK_ROOT:-$PROJECT_ROOT}" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Setting up git worktrees (git root: $git_root)..."

    # Validate the resolved root is a git repo
    if ! git -C "$git_root" rev-parse --is-inside-work-tree &>/dev/null; then
        error "Git root ($git_root) is not a git repository"
        return 1
    fi

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"
        local wt_branch="wt-$wt"

        # A directory existing at $wt_path is NOT sufficient proof of a usable
        # worktree — a prior crash (or a raw `rm -rf` instead of `git worktree
        # remove`) can leave a stale, non-git-tracked directory here, or a
        # directory whose worktree registration was lost. Silently "continuing"
        # on directory-existence alone left the CALLER believing a real
        # worktree was set up when it wasn't — verify it's actually a
        # registered, valid worktree of THIS repo before skipping creation.
        if [ -d "$wt_path" ]; then
            # `git worktree list --porcelain` reports canonicalized, resolved
            # paths — $wt_path contains a literal `..` component, so a raw
            # string comparison against the porcelain output NEVER matches
            # even for a genuinely valid worktree. Resolve $wt_path the same
            # way before comparing.
            local wt_path_resolved
            wt_path_resolved="$(cd "$wt_path" 2>/dev/null && pwd)"
            if [ -n "$wt_path_resolved" ] && git -C "$git_root" worktree list --porcelain 2>/dev/null | grep -q "^worktree ${wt_path_resolved}$"; then
                warning "Worktree already exists and is valid: $wt_path"
                continue
            fi
            warning "Stale non-worktree directory found at $wt_path (not registered with git) — removing before recreating"
            rm -rf "$wt_path"
        fi

        # Delete branch if it exists from previous run
        if git -C "$git_root" show-ref --verify --quiet "refs/heads/$wt_branch"; then
            info "Deleting existing branch: $wt_branch"
            git -C "$git_root" branch -D "$wt_branch" 2>/dev/null || true
        fi

        # Create worktree with a new branch based on current HEAD
        info "Creating worktree: $wt ($wt_path) on branch $wt_branch"
        git -C "$git_root" worktree add -b "$wt_branch" "$wt_path" HEAD || {
            error "Failed to create worktree: $wt"
            return 1
        }
    done

    success "Worktrees created successfully"
    return 0
}

# Cleanup git worktrees
cleanup_worktrees() {
    local worktrees=("primary" "independent")
    local git_root
    git_root="$(cd "${GIT_WORK_ROOT:-$PROJECT_ROOT}" && pwd)"
    local git_basename
    git_basename="$(basename "$git_root")"

    log "Cleaning up git worktrees..."

    for wt in "${worktrees[@]}"; do
        local wt_path="$git_root/../${git_basename}-wt-$wt"
        local wt_branch="wt-$wt"

        # Check if worktree exists
        if [ ! -d "$wt_path" ]; then
            info "Worktree does not exist: $wt_path (already removed)"
        else
            # Remove worktree — fall back to manual rm + prune if `git worktree
            # remove` fails (e.g. the directory was already partially deleted
            # out-of-band), so a failed removal never leaves the checkout
            # behind for the next run to trip over.
            info "Removing worktree: $wt ($wt_path)"
            if ! git -C "$git_root" worktree remove "$wt_path" --force 2>/dev/null; then
                warning "git worktree remove failed for $wt — falling back to manual rm + prune"
                rm -rf "$wt_path"
            fi
        fi

        # Prune BEFORE attempting the branch delete below — if the worktree
        # directory was removed out-of-band (not via `git worktree remove`),
        # git still considers the branch "checked out" by the orphaned admin
        # metadata and silently refuses `git branch -D` until pruned. This bug
        # was found live via this exact scenario in this function's own tests.
        git -C "$git_root" worktree prune 2>/dev/null || true

        # Delete the branch too — a worktree checkout being removed does NOT
        # delete the branch it pointed to, and a leftover branch collides with
        # the NEXT setup_worktrees() call's `git worktree add -b $wt_branch`
        # (the exact "fatal: a branch named 'wt-primary' already exists" live
        # failure this fixes). setup_worktrees() also deletes stale branches
        # defensively, but cleanup should not rely on the next run to do it.
        if git -C "$git_root" show-ref --verify --quiet "refs/heads/$wt_branch"; then
            git -C "$git_root" branch -D "$wt_branch" 2>/dev/null || true
        fi
    done

    # Prune worktree references
    git -C "$git_root" worktree prune

    # Final verification — a pristine cleanup MUST end with zero wt-* worktrees
    # registered. Fail loudly instead of silently leaving a corrupt registry.
    local remaining
    remaining=$(git -C "$git_root" worktree list --porcelain 2>/dev/null | grep -c "^worktree .*-wt-\(primary\|independent\)$" || true)
    if [ "${remaining:-0}" -gt 0 ]; then
        error "Worktree cleanup incomplete — ${remaining} wt-* worktree(s) still registered"
        git -C "$git_root" worktree list
        return 1
    fi

    success "Worktrees cleaned up"
    return 0
}
