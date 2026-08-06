#!/usr/bin/env bash
# codeline-write-perimeter.sh — OS-level write perimeter for client codelines.
#
# THE HOLE THIS CLOSES
# --------------------
# WriteFile.ts has a scope guard that blocks writes outside a story's declared
# files. Bash.ts has nothing: no cwd restriction, no command filtering, no deny
# list. It takes an arbitrary cwd and runs anything. Six agents hold `bash`
# against the client repo — code-graph-detective, team-lead-review,
# failure-analyst, prd-change-reviewer, plan-reviewer, lint-fix — and
# AI_GATE_ALLOW_TOOLS=1 also sets EPAM_DANGEROUS_SKIP_APPROVAL=1, so nothing
# prompts. Any of them can overwrite client source, and one did: run
# 20260806T113101Z lost ~1050 lines across five files during the spec pass,
# before the writer had run at all.
#
# A tool-level fix cannot hold — it has to be re-applied to every tool anyone
# adds. This enforces at the filesystem, where no tool can reach around it.
# Same reasoning, and the same mechanism, as _vendor_lock() in claude.sh, whose
# own comment says it exists because "an agent can reach for Bash and bypass it".
#
# THE RULE
#   baseline branch in the main checkout  -> READ-ONLY. Agents never write here.
#   a git worktree, or a story branch     -> writable. Edits land here.
#   .git                                  -> always writable (commits, resets,
#                                            git ls-files, index updates).
#
# Locking is decided by asking git where we are, not by a path list — so a new
# codeline is covered the moment discovery finds it, with no configuration.
#
# Usage:
#   . lib/codeline-write-perimeter.sh
#   perimeter_apply <repo>          # lock iff repo is on the baseline branch
#   perimeter_unlock <repo>         # reopen (writer step, teardown, reset)
#   perimeter_is_write_allowed <repo>   # exit 0 if writes are permitted here

# NO `set -uo pipefail` here. This file is SOURCED, so any shell option it sets
# leaks into every caller — git-ops.sh is itself sourced by claude.sh,
# run-agent-orchestration.sh and codemie-claude.sh, so a stray `set -u` here
# changes the behaviour of three top-level scripts and broke a commit path the
# first time this was written. A library configures nothing about its host.

_perim_log()  { echo "[write-perimeter] $*"; }
_perim_warn() { echo "[write-perimeter] WARN: $*" >&2; }

# The branch this project treats as its integration line. Configured per project
# (JIRA_BASELINE_BRANCH); no branch name is hardcoded here.
_perimeter_baseline_branch() {
    echo "${JIRA_BASELINE_BRANCH:-${EPAM_BASELINE_BRANCH:-main}}"
}

# A linked worktree has .git as a FILE (a gitdir pointer); a main checkout has
# it as a directory. That is git's own distinction, so it needs no path list.
perimeter_is_worktree() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -f "$repo/.git" ]
}

# Writes are allowed in a worktree, or on any branch that is not the baseline.
# Detached HEAD counts as "not a story branch" and stays locked — nothing should
# be authored there.
perimeter_is_write_allowed() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -e "$repo/.git" ] || return 0   # not a repo: not ours to lock
    perimeter_is_worktree "$repo" && return 0
    local branch
    branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
    [ "$branch" = "HEAD" ] && return 1                  # detached: locked
    [ "$branch" = "$(_perimeter_baseline_branch)" ] && return 1
    return 0
}

# WHAT GETS LOCKED: the client's own tracked source, and nothing else.
#
# `git ls-files` is the source of truth, so this assumes nothing about the
# project's language, build directory or vendor convention — and it already
# excludes .git, node_modules, .venv, dist and anything else the repo ignores,
# because none of those are tracked.
#
# ENGINE-INTERNAL PATHS ARE NEVER LOCKED. The pipeline writes its own state
# inside the codeline while a run is in flight — .epam/ (settings.json,
# codeline-facts.json, dependency-check.json, the vendor-lock and
# write-perimeter markers) and .codegraph/ (the index, rebuilt on commit).
# Those are engine artefacts, not client source; locking them would break the
# run rather than protect anything. They are normally untracked and so absent
# from ls-files anyway — filtered explicitly so that a project which happens to
# commit one of them cannot silently freeze the engine's own scratch space.
# Extendable per project via EPAM_PERIMETER_EXCLUDE (comma-separated prefixes).
_perimeter_targets() {
    local repo="$1"
    local extra="${EPAM_PERIMETER_EXCLUDE:-}"
    git -C "$repo" ls-files -z 2>/dev/null | while IFS= read -r -d '' f; do
        case "$f" in
            .epam/*|.codegraph/*|.epam|.codegraph) continue ;;
        esac
        local skip=0 pfx
        if [ -n "$extra" ]; then
            IFS=',' read -ra _pfxs <<< "$extra"
            for pfx in "${_pfxs[@]}"; do
                pfx="$(echo "$pfx" | tr -d '[:space:]')"
                [ -n "$pfx" ] && case "$f" in "$pfx"*) skip=1 ;; esac
            done
        fi
        [ "$skip" -eq 1 ] && continue
        printf '%s\0' "$f"
    done
}

perimeter_lock() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -d "$repo" ] || return 0
    local n=0
    while IFS= read -r -d '' f; do
        [ -f "$repo/$f" ] || continue
        chmod a-w "$repo/$f" 2>/dev/null && n=$((n + 1))
    done < <(_perimeter_targets "$repo")
    if [ "$n" -gt 0 ]; then
        mkdir -p "$repo/.epam" 2>/dev/null || true
        date -u +%Y-%m-%dT%H:%M:%SZ > "$repo/.epam/.write-perimeter-lock" 2>/dev/null || true
        _perim_log "LOCKED $n tracked file(s) read-only in $repo (on baseline branch — agents may not write here)"
    fi
    return 0
}

perimeter_unlock() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -d "$repo" ] || return 0
    local n=0
    while IFS= read -r -d '' f; do
        [ -f "$repo/$f" ] || continue
        chmod u+w "$repo/$f" 2>/dev/null && n=$((n + 1))
    done < <(_perimeter_targets "$repo")
    rm -f "$repo/.epam/.write-perimeter-lock" 2>/dev/null || true
    [ "$n" -gt 0 ] && _perim_log "unlocked $n tracked file(s) in $repo"
    return 0
}

# WHICH AGENTS MAY AUTHOR CODE AT ALL.
#
# Being on a story branch says WHERE writes may land; this says WHO may make
# them. Only agents whose job is to author files are listed. Everything else —
# code-graph-detective, team-lead-review, failure-analyst, prd-change-reviewer,
# plan-reviewer, the spec agents — reads code to form a judgement and has no
# reason to modify it. All six of those hold `bash` today, which is how ~1050
# lines of client source were rewritten during a spec pass with no writer
# running.
#
# The reviewer is deliberately NOT here: it reads the diff and the repo to
# decide, and returns a verdict. If a reviewer needs to change code, that is a
# writer re-implementation cycle, which is exactly what Step 3.6 already does.
#
# Configurable per project, never hardcoded to one pipeline's role names.
_PERIMETER_DEFAULT_WRITE_ROLES="writer,typescript-engineer,test-engineer,repro-test-writer,lint-fix"

perimeter_role_may_write() {
    local role="${1:-${EPAM_AGENT_NAME:-}}"
    [ -n "$role" ] || return 1                    # unknown caller: no writes
    local allowed="${EPAM_PERIMETER_WRITE_ROLES:-$_PERIMETER_DEFAULT_WRITE_ROLES}"
    local r
    IFS=',' read -ra _roles <<< "$allowed"
    for r in "${_roles[@]}"; do
        r="$(echo "$r" | tr -d '[:space:]')"
        [ -n "$r" ] && [ "${role%%:*}" = "$r" ] && return 0   # strip any ":plan" suffix
    done
    return 1
}

# Lock or leave open according to the rule. Safe to call repeatedly.
perimeter_apply() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -d "$repo" ] || return 0
    if perimeter_is_write_allowed "$repo"; then
        _perim_log "$repo is a worktree or story branch — writes permitted, not locking"
        perimeter_unlock "$repo" >/dev/null
    else
        perimeter_lock "$repo"
    fi
    return 0
}
