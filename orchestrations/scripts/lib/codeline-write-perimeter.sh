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
#   perimeter_seal <repo>           # RUN START: lock whatever branch it is on
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
#
# This list USED TO name them: "writer,typescript-engineer,test-engineer,repro-test-writer,
# lint-fix". Two of those five are epam-cli's own agents, carried from its first commit, and a
# role minted for some other project was in none of them. It would be proposed, briefed, wired,
# given inputs and tools, assigned a story — and then be unable to write a byte, because this
# gate is enforced with chmod below the tool layer. Every attempt fails, the ladder climbs, the
# budget exhausts, and nothing in the logs says the agent was never allowed to write.
#
# What remains here is the AUTHORING SEAMS: pipeline stages that write, which are not roster
# roles at all. Project roles are derived from the roster instead (see below), so a role minted
# tomorrow is covered without editing this file.
_PERIMETER_AUTHORING_SEAMS="writer,repro-test-writer,lint-fix"

# _perimeter_project_roles — this project's implementation roles, from the mint's registry.
#
# NOT derived as "the roster minus the canonical core". That was tried and it is wrong: of 38
# non-canonical roles in a live roster, only about nine implement anything — the rest is engine
# machinery (doc-*, failure-analyst, the vocabulary agents, code-graph-detective). Deriving from
# that set handed write access to the DETECTIVE, the exact agent whose lack of it is why this
# perimeter exists. The existing perimeter suite caught it.
#
# So the roster states what each agent IS, and this reads the `kind` field. One fact, one place:
# authorship is a property of an agent, not a separate registry that can disagree with it.
#
# THE ENGINE-LEVEL FALLBACK IS GONE. The previous resolver tried EPAM_PROJECT_ROLES_FILE, then the
# project's own project-roles.json, then agents/project-roles.json — so a client codeline whose
# project registry was missing inherited THIS repository's implementation roles.
#
# Fails CLOSED. No roster, unreadable roster, no project declared → contributes nothing, and only
# the authoring seams may write. A perimeter that fails open is not a perimeter; one that fails
# open quietly is worse, so the refusal is stated on stderr.
_perimeter_project_roles() {
    if [ -n "${_PERIM_PROJECT_ROLES_CACHE+x}" ]; then
        printf '%s' "$_PERIM_PROJECT_ROLES_CACHE"
        return 0
    fi
    local _lib_dir _out
    _lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
    _out=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
        # Through the library, so "which agents may author" has ONE definition — the same one the
        # producer validates against. A jq reimplementation here is a second answer to the
        # question, and the two drift the first time the roster's shape moves.
        _out=$("${NODE_BIN:-node}" -e '
          const m = require(process.argv[1]);
          try { process.stdout.write(m.agentsOfKind("implementer", process.argv[2]).join(",")); }
          catch (e) { process.stderr.write("[perimeter] " + (e && e.message) + "\n"); process.exit(1); }
        ' "${_lib_dir}/project-roster.js" "$EPAM_PROJECT_CONFIG_DIR" 2>/dev/null) || _out=""
    else
        echo "[perimeter] no project declared — no agent may author, only the authoring seams." >&2
    fi
    _PERIM_PROJECT_ROLES_CACHE="$_out"
    printf '%s' "$_out"
}

perimeter_role_may_write() {
    local role="${1:-${EPAM_AGENT_NAME:-}}"
    [ -n "$role" ] || return 1                    # unknown caller: no writes
    local allowed
    if [ -n "${EPAM_PERIMETER_WRITE_ROLES:-}" ]; then
        # An explicit operator override replaces the rule entirely — it is the escape hatch,
        # so it must not be silently unioned with anything derived.
        allowed="$EPAM_PERIMETER_WRITE_ROLES"
    else
        allowed="${_PERIMETER_AUTHORING_SEAMS},$(_perimeter_project_roles)"
    fi
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

# perimeter_seal <repo>
#
# THE RUN-START OPERATION. Locks a real checkout whatever branch it is on.
#
# perimeter_apply answers a different question — "is this repo in its write window?" — and
# unlocks whenever the checkout is on a branch other than the baseline, because that is how
# ensure_story_branch opens the window after resetting and creating the story branch. Calling
# it at RUN START reads a LEFTOVER branch as authorisation, and at run start no branch this run
# created can exist yet.
#
# Live 2026-08-09: next.metrolinx.com sat on a story branch left by a killed run, which
# survived the preflight reset. Run start logged "writes permitted, not locking", the repo
# stayed writable for the entire run, and a client source file was rewritten into an
# incompatible component during the SPEC PASS — in a run that paused before the writer and
# never started one. The two codelines on the baseline were sealed and untouched.
#
# The writer is unaffected: ensure_story_branch still calls perimeter_apply after it creates
# the branch, and that reopens the repo exactly as before.
#
# A linked worktree is exempt in both, because git's own structure makes it per-story rather
# than a name anyone can leave lying around.
perimeter_seal() {
    local repo="${1:-}"
    [ -n "$repo" ] && [ -d "$repo" ] || return 0
    [ -e "$repo/.git" ] || return 0                     # not a repo: not ours to lock
    if perimeter_is_worktree "$repo"; then
        _perim_log "$repo is a linked worktree — per-story by construction, not sealing"
        return 0
    fi
    perimeter_lock "$repo"
}

# perimeter_seal_all <codeline-root>
#
# Seal every repository under the root. The MIRROR of perimeter_release_all, and the reason
# this exists as a function at all: sealing used to be an inline loop in one launcher while
# releasing was generic in the engine, so seven of eight projects ran with no perimeter and
# nothing said so — releasing a repo that was never locked logs nothing.
#
# The defect that split cost: live 2026-08-17 run 20260817T231306Z, mock-a's src/fares.ts and
# test/fares.test.ts were rewritten during the SPEC PASS, before the writer stage was reached,
# on a project whose launcher never sealed. The same thing had already been recorded on the
# client estate — ~1050 lines across five files, same stage, which is why this library exists.
#
# Idempotent, and never fails the caller: a locked repo re-locks to the same state.
perimeter_seal_all() {
    local root="${1:-}"
    [ -n "$root" ] && [ -d "$root" ] || return 0
    local _n=0 _cl
    for _cl in "$root"/*/; do
        [ -e "${_cl}.git" ] || continue
        perimeter_seal "${_cl%/}" && _n=$((_n + 1))
    done
    [ "$_n" -gt 0 ] && _perim_log "sealed $_n codeline(s) — agents may not write until a story branch exists"
    return 0
}

# perimeter_release_all <codeline-root>
#
# Give every repository under the root back to the operator. Called when the RUN ends —
# including the successful ending, which for these runs is the pause before the writer.
#
# Nothing did this. perimeter_apply locked at run start, ensure_story_branch reopened a repo
# that reached a story branch, and the rest stayed read-only forever. Observed twice on
# 2026-08-06: after a run paused, 23 of the operator's repositories were still locked and
# nothing said so. The kill path has the same gap.
#
# Idempotent, and never fails the caller: it restores permission, it does not touch content.
perimeter_release_all() {
    local root="${1:-}"
    [ -n "$root" ] && [ -d "$root" ] || return 0
    local _n=0 _cl
    for _cl in "$root"/*/; do
        [ -e "${_cl}.git" ] || continue
        perimeter_unlock "${_cl%/}" >/dev/null 2>&1 && _n=$((_n + 1))
    done
    [ "$_n" -gt 0 ] && _perim_log "released $_n codeline(s) — repositories are writable again"
    return 0
}
