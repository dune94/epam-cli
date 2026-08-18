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
# CodeGraph's query tool (orchestrations/plugins/codegraph-plugin.js) ships
# with epam-cli itself — provisioned into .epam/settings.json's "tools"
# array for EVERY codeline unconditionally (mirroring run-agent-
# orchestration.sh's own per-codeline provisioning step), merged with
# whatever the project's own EPAM_PROJECT_CONFIG_DIR/plugins.json adds on
# top. codeline-facts.json remains purely project-config-driven and is a
# silent no-op when no project config dir is set or the codeline can't be
# matched against project.outputDirs.

# _epam_write_verification_manifest <project_root>
# Generates .epam/verification.json by asking the verification plugin to detect how THIS repo
# checks itself (its own package scripts, its own lockfile). Never invents a command: an
# unrecognised stack writes no manifest, and the plugin then reports UNKNOWN rather than a pass.
_epam_write_verification_manifest() {
    local _root="$1"
    local _plugin="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}/plugins/verification-plugin.js"
    [ -f "$_plugin" ] || return 0
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    command -v "$_node" >/dev/null 2>&1 || return 0
    "$_node" -e '
      const p = require(process.argv[1]);
      const root = process.argv[2];
      // BOTH sections. This wrote only `typecheck`, so the `test` section never existed and
      // every reader of it fell back to an engine-side guess. Detection is independent: a repo
      // may declare one and not the other, and writing a partial manifest is correct — the
      // reader reports UNKNOWN for whichever half is absent, never a pass.
      const d = { ...(p.detectVerification(root) || {}), ...(p.detectTests(root) || {}) };
      if (!Object.keys(d).length) process.exit(3);
      const fs = require("node:fs"), path = require("node:path");
      // PRESERVE WHAT THE PROJECT ALREADY DECLARED. Detection is a default, not an authority:
      // an operator who hand-tuned a command must not have it silently overwritten on the next
      // provisioning pass.
      const out = path.join(root, ".epam", "verification.json");
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(out, "utf8")) || {}; } catch { existing = {}; }
      const merged = { ...d, ...existing };
      fs.mkdirSync(path.join(root, ".epam"), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
    ' "$_plugin" "$_root" 2>/dev/null || true
}

_provision_epam_plugin_config() {
    local _project_root="$1"

    local _project_tools_json="[]"
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" ]; then
        _project_tools_json=$(jq -c '.tools // []' "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" 2>/dev/null || echo "[]")
    fi

    local _codegraph_plugin_abs=""
    local _codegraph_plugin_src="${SCRIPT_DIR:-}/../plugins/codegraph-plugin.js"
    if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$_codegraph_plugin_src" ]; then
        _codegraph_plugin_abs="$(cd "$(dirname "$_codegraph_plugin_src")" 2>/dev/null && pwd)/$(basename "$_codegraph_plugin_src")"
    fi

    if [ -n "$_codegraph_plugin_abs" ] || [ "$_project_tools_json" != "[]" ]; then
        mkdir -p "${_project_root}/.epam"
        # Verification manifest, generated from the repo's OWN scripts (never a tool name baked
        # into the engine). Written per codeline at provisioning time so every writer, gate and
        # worktree has it. detect + emit live in the plugin; this only places the file.
        _epam_write_verification_manifest "${_project_root}"
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
# Report a staging failure with git's own words. Writes to stderr so it lands in the run log
# beside the WARNING the caller emits; a bare "exit 1" is not a diagnosis.
_git_add_report_failure() {
    local _repo="$1" _rc="$2" _stderr="$3" _summary="$4"
    # A "FAILED ... (exit 0)" line is its own defect: it sends the next investigation after a
    # failure that never happened. Caught by the state sweep the same hour this was added.
    [ "$_rc" -eq 0 ] && return 0
    echo "[git-add] FAILED in ${_repo} (exit ${_rc}): ${_summary}" >&2
    if [ -n "$_stderr" ]; then
        printf '%s\n' "$_stderr" | head -20 | sed 's/^/[git-add]   /' >&2
    else
        echo "[git-add]   (git printed nothing)" >&2
    fi
}

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
        # ONE GLOB, NOT TWO PREFIX FORMS. ":!<dir>/*" is FATAL, not merely unmatched, when the
        # directory is a symlink — git refuses a pathspec that crosses one:
        #
        #   fatal: pathspec ':(exclude)node_modules/*' is beyond a symbolic link
        #
        # Live 2026-08-18, both lanes, at the LAST step of a run that had otherwise succeeded:
        # the fix was correct, tests passed, the type check passed, and every commit failed with
        # exit 128 because both codelines symlink node_modules to a shared install. Nothing could
        # ever be committed in such a repo.
        #
        # The bare ":!<dir>" form survives the symlink but stops excluding NESTED copies, which
        # would stage a client's vendored tree — fixing the error by weakening the exclusion. This
        # glob is correct on all three counts: top-level contents, nested contents, and a
        # symlinked directory.
        _excludes+=( ":(exclude,glob)**/${_d}/**" ":(exclude,glob)**/${_d}" )
        _resets+=( "$_d" )
    done
    # Build artefacts are not engine state, but staging them is never right either. This named
    # node_modules, build and .next — one ecosystem — so a Rust codeline whose target/ was not
    # gitignored had its whole build tree staged into the CUSTOMER'S repository. The list now
    # comes from lib/ecosystems.js (ecosystem artefacts) and config/repo-artifacts.json (editor
    # and OS droppings), which is also where worktree-health-check.sh reads it — they were two
    # hand-written lists that had drifted apart.
    #
    # NO SILENT FALLBACK. An empty exclusion list stages a client's build tree, so a handler that
    # cannot answer stops the staging rather than widening it.
    local _ex_out
    if ! _ex_out=$("${NODE_BIN:-node}" "$(dirname "${BASH_SOURCE[0]}")/handlers/repo-exclude-patterns.js" pathspec); then
        echo "[git-add] could not resolve the exclusion list — refusing to stage without it" >&2
        return 1
    fi
    while IFS= read -r _ex; do
        [ -n "$_ex" ] && _excludes+=( "$_ex" )
    done <<< "$_ex_out"

    # CAPTURE THE REASON. This was `2>/dev/null`, and live 2026-08-09 a run halted on
    # "git add failed (exit 1)" with no diagnosis at all: the deliverable gate had passed, tsc
    # had passed, the work was real, and two fixtures reproducing the plausible causes both
    # returned 0 — the actual reason was unknown, because this line deleted it. git's message
    # here is specific and useful ("index file smaller than expected", "The following paths are
    # ignored by one of your .gitignore files") and is the difference between a fix and a theory.
    # Held in a variable rather than passed straight through, so the success path stays silent:
    # an ignored-path warning is normal and must not print on every story.
    local _add_stderr
    _add_stderr=$(timeout "$_timeout" git -C "$_repo" add -A -- "${_excludes[@]}" 2>&1)
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
    # A TIMEOUT IS NEVER SUCCESS, whatever the index looks like. `timeout` reports 124, and a
    # wedged git is a different condition from git objecting to an ignored pathspec: the repo
    # may be locked or the filesystem hung, and a partially-populated index proves nothing about
    # whether the rest would have staged. Checked BEFORE the index, or the index check silently
    # converts a hang into a clean commit — which it did, until
    # per-story-commit-and-partial-merge.test.ts caught it.
    if [ "$_rc" -eq 124 ]; then
        _git_add_report_failure "$_repo" "$_rc" "$_add_stderr" "timed out after ${_timeout}s"
        return $_rc
    fi

    local _staged _pending
    # wc -l, not `grep -c . || echo 0`: on empty input grep prints 0 AND exits 1, so the
    # fallback appends a second 0 and the numeric comparison below errors out.
    _staged=$(timeout "$_timeout" git -C "$_repo" diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    if [ "${_staged:-0}" -gt 0 ]; then
        return 0
    fi
    # Nothing staged. If nothing was stageable either, that is a correct no-op, not a failure.
    # ASK THE SAME QUESTION THE STAGING ANSWERED.
    #
    # This was a bare `git status --porcelain | wc -l`, which counts EVERYTHING pending —
    # including .epam/ and the other engine-owned paths that `git add` above deliberately
    # excludes. So "nothing staged although something is pending" was a false conclusion
    # whenever the only pending path was one we never intended to stage.
    #
    # Live 2026-08-09, gotransit, reproduced exactly by
    # git-add-verdict-across-repo-states.test.ts: a gitignored top-level node_modules makes
    # `git add` exit 1 merely for naming the ignored path; nothing stages because there is no
    # client work; .epam/ is the only thing "pending" — and the story was demoted as
    # undelivered, the phase aborted, and the codeline HALTed over a repo that had nothing to
    # commit.
    #
    # engine_paths_filter is the same single definition the staging exclusions come from, and the
    # artefact dirs now are too — this was a THIRD copy of the list, naming node_modules, build and
    # .next. A pending target/ or .venv/ counted as work, so a Rust or Python repo with nothing to
    # commit produced 'nothing reached the index although N path(s) are pending' and HALTed the
    # codeline. Reusing $_ex_re, already resolved above; if it is empty the filter is skipped
    # rather than degenerating into a regex that matches everything.
    local _ex_re
    _ex_re=$("${NODE_BIN:-node}" "$(dirname "${BASH_SOURCE[0]}")/handlers/repo-exclude-patterns.js" regex 2>/dev/null || echo "")
    _pending=$(timeout "$_timeout" git -C "$_repo" status --porcelain 2>/dev/null \
        | sed 's/^...//' \
        | sed 's/^.* -> //' \
        | engine_paths_filter \
        | { if [ -n "$_ex_re" ]; then grep -vE "$_ex_re"; else cat; fi; } \
        | wc -l | tr -d ' ')
    if [ "$_rc" -ne 0 ] && [ "${_pending:-0}" -eq 0 ]; then
        # git could not even report status: the repository is genuinely unusable.
        if ! timeout "$_timeout" git -C "$_repo" status --porcelain >/dev/null 2>&1; then
            _git_add_report_failure "$_repo" "$_rc" "$_add_stderr" "the repository is unusable — git cannot even report status"
            return "$_rc"
        fi
    fi
    [ "${_pending:-0}" -eq 0 ] && return 0
    _git_add_report_failure "$_repo" "$_rc" "$_add_stderr" \
        "nothing reached the index although ${_pending} path(s) are pending"
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

    # THE START POINT IS WHAT VARIES, NOT THE PROCEDURE.
    #
    # This used to begin `git fetch origin` and return on failure, so a repository with no remote
    # never reached checkout -B: the writer worked directly on the baseline branch and one warning
    # line said so. That became a hard failure once the write perimeter went generic, because
    # perimeter_apply — the call that REOPENS the repository — sits past that early return. A
    # sealed repo with no remote could never be unsealed, and the writer was locked out of the one
    # repository it was asked to change.
    #
    # With a remote, everything below is unchanged: fetch, then base off origin/<baseline>.
    # Without one, the LOCAL baseline branch is the start point. With neither, this still fails.
    local _base_ref=""
    if git -C "$codeline_root" remote get-url origin >/dev/null 2>&1; then
        if ! git -C "$codeline_root" fetch origin "$baseline_branch" --quiet 2>/dev/null; then
            warning "  [story-branch] $story_id: could not fetch origin/${baseline_branch} — proceeding on current branch state"
            return 1
        fi
        _base_ref="origin/${baseline_branch}"
    elif git -C "$codeline_root" rev-parse --verify --quiet "refs/heads/${baseline_branch}" >/dev/null 2>&1; then
        _base_ref="$baseline_branch"
        info "  [story-branch] $story_id: no 'origin' remote — basing off the local '${baseline_branch}'"
    else
        warning "  [story-branch] $story_id: no 'origin' remote and no local '${baseline_branch}' — proceeding on current branch state"
        return 1
    fi

    # NOTHING IS DISCARDED SILENTLY OR UNRECOVERABLY.
    #
    # The hard reset below is wanted and stays. What is not acceptable is what it did
    # on 2026-08-14: a story that had COMPLETED — `npm run test` green, `tsc` green,
    # 4 files committed — was rejected by the reviewer over one inconsistent
    # dependency declaration, and the retry moved this branch pointer back to
    # origin/develop. The commit stopped being reachable from any ref. It survived
    # only in the reflog, where nothing in this pipeline looks and where gc removes
    # it. The same shape orphaned three FINISHED gotransit commits the same day
    # (e780a8b7 / 45c82f2a / 20c2cea4), recovered by hand.
    #
    # The log line "freshly based on origin/<baseline>" reads as hygiene. It was
    # deletion. So: before the pointer moves, anything that would stop being
    # reachable is pinned under a real ref and named — recovery must never depend on
    # the reflog. This is a local ref only; it pushes nothing.
    local _unreachable=0
    _unreachable=$(git -C "$codeline_root" rev-list --count "${_base_ref}..HEAD" 2>/dev/null || echo 0)
    case "$_unreachable" in (''|*[!0-9]*) _unreachable=0 ;; esac
    if [ "$_unreachable" -gt 0 ]; then
        local _rescue_ref _head_short
        _head_short=$(git -C "$codeline_root" rev-parse --short HEAD 2>/dev/null || echo unknown)
        _rescue_ref="epam-rescue/${story_id}-${_head_short}"
        if git -C "$codeline_root" branch -f "$_rescue_ref" HEAD --quiet 2>/dev/null; then
            warning "  [story-branch] $story_id: ${_unreachable} commit(s) would have been discarded by this reset — preserved on branch '${_rescue_ref}'"
            warning "  [story-branch]   recover with: git -C '${codeline_root}' log ${_rescue_ref}"
        else
            error "  [story-branch] $story_id: ${_unreachable} commit(s) are about to become unreachable and the rescue ref could not be created — refusing to reset"
            return 1
        fi
    fi

    if git -C "$codeline_root" checkout -B "$_branch" "$_base_ref" --quiet 2>/dev/null; then
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
        git -C "$codeline_root" reset --hard "$_base_ref" --quiet 2>/dev/null || true
        git -C "$codeline_root" clean -fd --quiet 2>/dev/null || true
        _provision_epam_plugin_config "$codeline_root"
        # The repo is now on a story branch, which is where edits are allowed to
        # land — reopen it. While it sat on the baseline branch it was chmod'd
        # read-only (see lib/codeline-write-perimeter.sh): a spec-pass agent
        # rewrote ~1050 lines of client source there before any writer ran, and
        # a per-tool allowlist cannot stop that because `bash` bypasses it.
        perimeter_apply "$codeline_root"
        success "  [story-branch] $story_id: on branch '${_branch}', freshly based on ${_base_ref} (working tree hard-reset + cleaned)"
        return 0
    fi

    warning "  [story-branch] $story_id: could not create/reset branch '${_branch}' off ${_base_ref} — proceeding on current branch"
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
