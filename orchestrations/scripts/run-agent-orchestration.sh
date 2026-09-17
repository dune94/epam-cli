#!/bin/bash

# A service URL has one home: config/services.json, read through this helper.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/service-urls.sh" 2>/dev/null || true

# THE SET DECIDES which provider a gate call actually reaches — see
# change-log/SEAM-CONSISTENCY-ANALYSIS.md. epam run --provider talks directly to the compiled CLI,
# which has no EPAM_PROVIDER_SET awareness at all (confirmed: grep across src/ turns up nothing),
# so unlike calls that route through llm-handler.sh, nothing downstream re-validates this one.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/resolve-primary-provider.sh"

# How much evidence each agent is shown, by name — see config/evidence-windows.json.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/evidence-windows.sh" 2>/dev/null || true

# Master orchestration script for parallel multi-agent execution
# Coordinates worktree-based parallel Claude agents across all EPAM CLI project phases

# ── Give the repositories back, on every exit ────────────────────────────────
# The write perimeter locks every codeline at run start. Nothing released them when the run
# ENDED — not on success, not on the pause before the writer, which is how these runs are
# meant to finish. Twice on 2026-08-06 a paused run left 23 of the operator's repositories
# read-only with no message. A trap covers every exit path, including the ones added later.
_release_write_perimeter() {
    local _lib
    _lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/codeline-write-perimeter.sh"
    [ -f "$_lib" ] || return 0
    # shellcheck source=lib/codeline-write-perimeter.sh
    . "$_lib" 2>/dev/null || return 0
    perimeter_release_all "${JIRA_CODELINE_ROOT:-}" || true
}
# ONE TRAP, MANY HANDLERS — see lib/exit-handlers.sh. bash keeps a single EXIT trap, so a later
# `trap ... EXIT` silently DELETES this one. That is exactly what happened: the heartbeat trap at
# the bottom of this file ate both this release and cleanup(), so a paused run left no cassette, no
# worktree cleanup and no perimeter release, in silence (live 20260910T222155Z).
# BASH_SOURCE, not SCRIPT_DIR: that is defined a hundred lines below this point.
# shellcheck source=lib/exit-handlers.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/exit-handlers.sh"
add_exit_handler _release_write_perimeter

# ── Take them, on every run ──────────────────────────────────────────────────
# The other half of the pair above, and it lived in ONE launcher. Sealing was an inline loop in
# tier3-metrolinx-run.sh; releasing was generalised into this engine after two paused runs left
# 23 repositories read-only. Seven launchers therefore ran with no perimeter, silently — a
# release with nothing to release logs nothing.
#
# specAgentEnv states the design: "Writes are NOT prevented here. They are prevented at the
# filesystem by the perimeter." Without this, a read-only tool grant is the only thing between a
# diagnosing agent and the operator's source, and it is not an enforcement. Live 2026-08-17 run
# 20260817T231306Z: mock-a was rewritten during the SPEC PASS, before the writer ran, so the
# regression guard then certified already-changed code as the baseline.
#
# Here rather than in each launcher: this is the one script they all run, the trap that undoes it
# is right above, and a launcher added later cannot forget a step it never had to take.
_engage_write_perimeter() {
    local _lib
    _lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/codeline-write-perimeter.sh"
    [ -f "$_lib" ] || return 0
    # shellcheck source=lib/codeline-write-perimeter.sh
    . "$_lib" 2>/dev/null || return 0
    perimeter_seal_all "${JIRA_CODELINE_ROOT:-}" || true
}
_engage_write_perimeter
#
# Usage:
#   ./run-agent-orchestration.sh                                    # Run default phase (finops)
#   ./run-agent-orchestration.sh --phase finops                     # Run specific phase
#   ./run-agent-orchestration.sh --dry-run                          # Preview execution plan
#   ./run-agent-orchestration.sh --skip-cleanup                     # Keep worktrees for inspection

set -e

# ONE REVIEWER PROMPT, THREE CALLERS.
#
# This prompt existed as three near-identical copies (ac_patch, profile_creation,
# profile_addendum) that differed only in the evidence they showed. A wording fix was a
# three-place edit, and they had already drifted: two showed a diff, one showed BEFORE and
# AFTER separately. The evidence SECTION is the caller's, heading included; everything else
# is one template.
_render_change_reviewer() {
    local _story="$1" _change_type="$2" _evidence="$3"
    local _cr_vals; _cr_vals=$(mktemp "${TMPDIR:-/tmp}/change-reviewer-vals-XXXXXX.json")
    jq_vals --arg story "$_story" --arg ct "$_change_type" \
          --rawfile ev <(printf '%s' "$_evidence") \
          '{"__STORY__":$story,"__CHANGE_TYPE__":$ct,"__EVIDENCE__":$ev}' > "$_cr_vals" 2>/dev/null
    local _out
    if ! _out=$(render_engine_prompt change-reviewer "$_cr_vals"); then
        echo "[change-reviewer] cannot render its prompt — refusing to review with no instructions" >&2
        rm -f "$_cr_vals"; return 1
    fi
    rm -f "$_cr_vals"
    printf '%s' "$_out"
}

# _run_project_verification <project_root>
# Runs the project's declared check (.epam/verification.json) via the verification plugin.
# The engine names no tool, extension, directory or runtime path. Undeclared -> non-zero with a
# reason, never a silent pass.
# ── The codeline's OWN test runner ────────────────────────────────────────────
#
# This file carried 40 executable `vitest` references and zero `jest` ones. metrolinx runs jest, so
# on that codeline the post-repair re-verification skipped silently, the review oracle skipped, and
# Step 19 executed a binary that does not exist and reported "vitest: FAIL — fix test failures
# before review proceeds": a missing binary reported as failing tests.
#
# codeline-ecosystem.js already answers this from the repository itself. The runner is a fact of
# the codeline, never of the engine.
_codeline_test_command() {
    local _root="${1:-$PROJECT_ROOT}"
    [ -n "$_root" ] || return 0
    local _facts
    _facts=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$_root" 2>/dev/null) || return 0
    [ -n "$_facts" ] || return 0
    printf '%s' "$_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" testCommand 2>/dev/null || true
}

# ── Failing test files, whatever printed them ─────────────────────────────────
#
# The COMMAND at Step 4.5 was genericised to the codeline's declared testCommand; the PARSER was
# left in vitest's output format (`^ FAIL `, `^ ❯ `, `^ +→ `). On a jest repo nothing matched, so
# no failing file was ever named, no bug-fix story could be created, and the run reported
# "Could not parse failing test files". Half the fix is not the fix.
#
# Both runners print FAIL followed by the path; jest indents differently and uses ● for the
# assertion. Matching on the FAIL line alone covers both without encoding either as the truth.
_parse_failing_test_files() {
    printf '%s\n' "$1" \
        | grep -aE '^[[:space:]]*(FAIL|✕|×)[[:space:]]+' \
        | sed -E 's/^[[:space:]]*(FAIL|✕|×)[[:space:]]+//' \
        | awk '{print $1}' \
        | grep -aE '\.[A-Za-z0-9]+$' \
        | sort -u
}

# _halt_recovery_state now lives in lib/halt-recovery.sh so the message an operator acts on can be
# executed by a test. See that file.
#
# RESOLVED FROM BASH_SOURCE, NOT SCRIPT_DIR. This sits above the line that defines SCRIPT_DIR, so
# "$SCRIPT_DIR/lib/..." expanded to "/lib/..." and every run died at startup with
# "No such file or directory". bash -n cannot see it — the path is only wrong at runtime — and a
# unit test cannot either, because tests source the lib directly. The free rehearsal caught it.
# shellcheck source=lib/halt-recovery.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/halt-recovery.sh"

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


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/seam-ladder.sh
# Nothing the pipeline spawns is entitled to the whole machine. See the file header:
# an unbounded client suite is what defeated RG-DELTA and aborted the 2026-09-04 run.
source "$SCRIPT_DIR/lib/bounded-exec.sh"
source "$SCRIPT_DIR/lib/prompt-variant.sh"
source "$SCRIPT_DIR/lib/seam-ladder.sh"
# The pipeline does not run code nobody has tested. Every stage below asks this first.
source "$SCRIPT_DIR/lib/stage-coverage-gate.sh"
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/lib/codeline-lanes.sh"

source "$SCRIPT_DIR/lib/control-plane.sh"

# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$AUTOMATION_DIR/scripts/lib/env-file.sh"

# Early-load Jira env only when Jira mode is already externally activated
# (JIRA_PIPELINE=1 set by the caller — e.g. `source jira/.env` before running).
# Loading unconditionally would force every canonical-PRD run through the Jira
# pipeline and pollute the env with JIRA_PIPELINE=1.
# Only auto-source jira/.env when the caller has NOT already set JIRA_URL —
# if JIRA_URL is already in the environment (set by orchestrate.sh from the
# project config) the caller's config must win; sourcing here would clobber it
# with whatever stale/wrong project is in jira/.env.
if [ "${JIRA_PIPELINE:-0}" = "1" ] && is_parent && \
   [ -z "${JIRA_URL:-}" ] && [ -f "$AUTOMATION_DIR/jira/.env" ]; then
  # Only when no launcher took it first — the earliest snapshot is the truthful one.
  if [ -z "${EPAM_OPERATOR_SET_VARS:-}" ] && [ -f "$SCRIPT_DIR/lib/run-modes.sh" ]; then
    . "$SCRIPT_DIR/lib/run-modes.sh"; snapshot_operator_env
  fi
  load_env_file_safe "$AUTOMATION_DIR/jira/.env"
fi

# Setsid guard: re-exec under a new session so parent SIGTERM doesn't propagate
# to long-running agent subprocesses. Only applies to top-level Jira pipeline runs.
if [ "${JIRA_PIPELINE:-0}" = "1" ] && is_parent && \
   [ -z "${_ORCH_SETSID_DONE:-}" ] && command -v setsid >/dev/null 2>&1; then
  export _ORCH_SETSID_DONE=1
  exec setsid bash "$0" "$@"
fi

PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
# Always resolve to absolute path — relative paths break when CWD changes in worktrees
PRD_FILE="$(cd "$(dirname "$PRD_FILE")" && pwd)/$(basename "$PRD_FILE")"
# Exported so subprocesses invoked by absolute path (e.g. team-lead-review.sh)
# resolve the SAME PRD as this run, instead of falling back to their own
# AUTOMATION_DIR/prd.json — which silently reviews the wrong project entirely
# whenever PRD_FILE points at an external test-app/codeline.
export PRD_FILE

# Resolve NODE_BIN once so all inline `node -e` calls (codeline extraction,
# story counting, etc.) use a consistent, working binary regardless of PATH.
# Callers that export NODE_BIN explicitly (e.g. CI / tier scripts) are respected.
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"
export NODE_BIN

# shellcheck source=lib/tc-writer-gate.sh
source "$SCRIPT_DIR/lib/tc-writer-gate.sh"
# shellcheck source=lib/story-guards.sh
source "$SCRIPT_DIR/lib/story-guards.sh"
source "$SCRIPT_DIR/lib/flags.sh"
source "$SCRIPT_DIR/lib/run-checkpoint.sh"
# shellcheck source=lib/git-ops.sh
source "$SCRIPT_DIR/lib/git-ops.sh"
source "$SCRIPT_DIR/lib/story-retry-state.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"

# Load timeout config from EPAM_PROJECT_CONFIG_DIR/llm-settings.json BEFORE
# any call to the watchdog wrapper defined further below — its `timeout`
# wrapper is computed synchronously the moment it's called, so this must run
# here, in THIS process, not inside claude.sh (which the watchdog invokes as
# a subprocess — too late by construction; see _load_timeout_config()'s
# docstring in lib/story-guards.sh).
_load_timeout_config

# EXPORT THE LADDER CHAINS HERE, IN THE PARENT — for exactly the reason above.
#
# export_model_ladders turns the project's declared ladders into EPAM_MODEL_LADDER_<TIER> so that
# seam_ladder_export can resolve a seam's declared tier to a real model. It was called in only two
# places, neither of them this one: claude.sh (which runs as a SUBPROCESS of this script) and
# detective-rerun.sh.
#
# Every seam script — team-lead-review.sh, brownfield-repro-test-writer.sh, agent-attempt-analyst.sh,
# code-review-cycle.sh, post-impl-tc-writer.sh — is a child of THIS process, not of claude.sh. So
# none of them inherited a chain, seam_ladder_export found nothing to resolve, and each fell back
# to whatever fixed model its own script named. That is why every archetype's `ladder` declaration
# was decorative: the declaration was read, and there was nothing on the other side of it.
#
# The literals are now gone, which turns that silence into a refusal — a seam with no resolvable
# model declines rather than guessing. Correct, and useless if the chains never arrive. They must
# be exported HERE, once, before any seam is invoked, the same reason _load_timeout_config is.
# shellcheck source=lib/project-config.sh
[ -f "$SCRIPT_DIR/lib/project-config.sh" ] && source "$SCRIPT_DIR/lib/project-config.sh"
# shellcheck source=lib/model-ladders.sh
[ -f "$SCRIPT_DIR/lib/model-ladders.sh" ] && source "$SCRIPT_DIR/lib/model-ladders.sh"
# A run that finishes leaves a cassette — see lib/cassette-archive.sh for the four runs that did
# not, and why a Langfuse trace is not one.
# shellcheck source=lib/cassette-archive.sh
[ -f "$SCRIPT_DIR/lib/cassette-archive.sh" ] && source "$SCRIPT_DIR/lib/cassette-archive.sh"

add_exit_handler _epam_export_cassette
# What a QA gate is SHOWN decides what it can conclude — see lib/qa-gate-evidence.sh.
# shellcheck source=lib/qa-gate-evidence.sh
[ -f "$SCRIPT_DIR/lib/qa-gate-evidence.sh" ] && source "$SCRIPT_DIR/lib/qa-gate-evidence.sh"
if command -v export_model_ladders >/dev/null 2>&1; then
    # THE VERDICT IS READ. This was `|| true`, which made the loader's return value decorative and
    # meant the else-branch below was the only way this could ever warn — a branch that fires when
    # the loader is MISSING, never when it is present and found no project. Those two have the same
    # outcome: no chains, and every seam declining or falling back.
    if ! export_model_ladders "$(command -v project_settings_file >/dev/null 2>&1 \
            && project_settings_file "${EPAM_PROJECT_CONFIG_DIR:-}" \
            || echo "${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}")"; then
        echo "[orch] WARNING: no ladder chains exported (see [model-ladders] above) — seams will have no resolvable model" >&2
    fi
else
    # NOT SILENT. A missing loader here means every seam runs with no resolvable model and, now
    # that the literals are gone, declines to run at all — the test-writer and the analyst would
    # simply not happen, and the run would look normal while doing less than it reports.
    echo "[orch] WARNING: lib/model-ladders.sh not loadable — no ladder chains exported; seams will have no resolvable model" >&2
fi

# Load project .env so API keys are available to all subprocesses (worktrees, epam-run, etc.)
# Preserve caller-set gate overrides so tier scripts can override .env defaults.
_pre_gate_provider="${ORCH_GATE_PROVIDER:-}"
_env_file="$(dirname "$AUTOMATION_DIR")/.env"
# PARSED, NOT EXECUTED. `set -a; . "$_env_file"` RUNS the file, and this repo's .env begins
# with a bare `cd` — which means "go to $HOME". That is precisely the defect
# lib/env-file.sh was written to prevent, and this was the last site still doing it.
#
# It also made every cost guard useless: keys unset before launch were RESTORED here, so a
# run told to use MockServer called the real API with a real key (2026-08-25, unapproved).
#
# Verified equivalent BEFORE the change: both mechanisms produce the SAME 80 variables from
# the real .env. Only the executable side effects are lost, which is the point.
# PRESERVE MODE: a value the CALLER set wins over .env. That is what this block already
# wanted — the line below it hand-restores two variables for exactly this reason — but it
# only protected those two, so every other caller-set value was silently overwritten.
#
# It is also the cost guard. Keys scrubbed before launch were RESTORED here, so a run told
# to use MockServer called the real API with a real key (2026-08-25, unapproved spend).
# With preserve, a placeholder set by the caller survives and cannot authenticate.
if [ -f "$_env_file" ]; then load_env_file_safe "$_env_file" preserve; fi
unset _env_file
# Restore caller overrides (tier scripts set these intentionally; .env has stale defaults)
[ -n "$_pre_gate_provider" ] && ORCH_GATE_PROVIDER="$_pre_gate_provider"
unset _pre_gate_provider
# When PRD_FILE is an external path (e.g. a test-app), derive PROJECT_ROOT from
# the directory two levels above the PRD file (prd sits in <root>/orchestrations/ normally,
# but for test apps it sits directly in the app root — detect via presence of package.json).
# PROJECT_ROOT can also be pre-set in the environment to force a specific directory.
_prd_dir="$(cd "$(dirname "$PRD_FILE")" && pwd)"
if [ -z "${PROJECT_ROOT:-}" ]; then
  # Read project.outputDir from PRD if present, else derive from PRD location
  _prd_output_dir=$(python3 -c "import sys,json; d=json.load(open('$PRD_FILE')); print(d.get('project',{}).get('outputDir',''))" 2>/dev/null || true)
  if [ -n "$_prd_output_dir" ]; then
    PROJECT_ROOT="$_prd_output_dir"
  elif [ -f "$_prd_dir/package.json" ]; then
    PROJECT_ROOT="$_prd_dir"
  elif [ -n "${JIRA_CODELINE_ROOT:-}" ] && [ -d "${JIRA_CODELINE_ROOT}" ]; then
    # THE PROJECT'S DECLARED CODELINE ROOT, WHICH IT ALREADY TOLD US ABOUT.
    #
    # project.outputDir is written LATER, by resolve-codeline-scope.sh — so at this point a
    # multi-codeline project whose PRD was authored (not Jira-ingested) has neither outputDir nor
    # a package.json beside its PRD, and fell through to `dirname $AUTOMATION_DIR`: the epam-cli
    # REPOSITORY ITSELF. The safety guard immediately below then refused the run, correctly, with
    # "PROJECT_ROOT resolves to the epam-cli repo root" — telling the operator to set a field the
    # pipeline populates for them a few steps later.
    #
    # The codeline root is the estate those codelines live in and is declared in config.env, which
    # the launcher has already loaded. Per-lane PROJECT_ROOT is still set by the codeline loop;
    # this only has to be somewhere outside the engine until then.
    PROJECT_ROOT="$JIRA_CODELINE_ROOT"
  else
    PROJECT_ROOT="$(dirname "$AUTOMATION_DIR")"
  fi
fi
export PROJECT_ROOT

# Safety guard: PROJECT_ROOT must never be the epam-cli repo itself.
# Test apps must live in a separate directory (e.g. /home/.../epam-test-apps/<name>
# or /tmp/<name>). This prevents test artifacts polluting the orchestration codebase.
_repo_root="$(cd "$AUTOMATION_DIR/.." && pwd)"
if [ "$PROJECT_ROOT" = "$_repo_root" ]; then
  echo "ERROR: PROJECT_ROOT resolves to the epam-cli repo root ('$_repo_root')." >&2
  echo "       Set project.outputDir in your PRD to an external test-app directory." >&2
  echo "       Convention: any directory OUTSIDE this repository — the engine must never write into itself." >&2
  exit 1
fi

# Safety guard: the binary must be built from the source in this tree.
# `epam` is a shim around dist/epam.js — the pipeline never runs src/ — so a
# stale dist means a source change silently does not execute while APPEARING to
# (2026-07-26: dist was two days old, and that morning's AgentRunner tool-budget
# change would have been a complete no-op in a live run; caught only by a manual
# check before launch). Sourced defensively so a missing lib cannot block a run.
if [ -f "$SCRIPT_DIR/lib/dist-freshness.sh" ]; then
  # shellcheck disable=SC1090
  . "$SCRIPT_DIR/lib/dist-freshness.sh"
  if ! assert_dist_fresh "$_repo_root"; then
    exit 1
  fi
fi

# WHERE THE AGENTS LIVE. One resolution point, honouring EPAM_AGENTS_DIR.
#
# Every site used $AUTOMATION_DIR/agents directly, so a run told to keep its artefacts
# elsewhere still read and WROTE the live roster. Live 2026-08-08: a test run's mint read the
# repository's profiles.json, found an agent a previous client run had minted, reported it
# "unchanged", minted nothing, and the run died at assignment — while also writing into the
# client's own agents directory. Unset, this is exactly the previous path.
EPAM_AGENTS_DIR="${EPAM_AGENTS_DIR:-$AUTOMATION_DIR/agents}"

# THE ROSTER FILE, DEFINED ONCE — IT NEVER WAS.
#
# AGENT_PROFILES_FILE is read in three places in this script and assigned in none, so it was empty
# on every path that did not inherit it from a caller. In a codeline lane that meant: profiles_backup
# became the bare string '.original', the canonical looked missing, `cp "" .original` failed the
# phase; and PROFILES_REL, built by realpath-ing the same empty string, rendered post-failure-analyst
# with an empty value, which the prompt layer correctly refuses. Both lanes died in the pre-phase
# skill assessment, and the message the operator saw was about a missing canonical roster.
#
# Derived here from the directory that is already resolved, so every reader gets the same answer and
# a caller that exports its own still wins.
AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$EPAM_AGENTS_DIR/profiles.json}"
export AGENT_PROFILES_FILE
# The roster is the only source of an agent's identity — lib/roster-read.sh. The default this
# replaces named the engine's own roster, which is what a client codeline's reviewer inherited.
# shellcheck source=lib/roster-read.sh
. "$SCRIPT_DIR/lib/roster-read.sh"
# Compute PRD path relative to PROJECT_ROOT for injecting into agent prompts.
# In the codeline-loop path, PRD_FILE is a per-codeline temp copy under /tmp/
# (e.g. /tmp/orch-<cl>-prd-$$.json) that lives nowhere near PROJECT_ROOT (a
# codeline worktree elsewhere under /tmp/ or the real project tree) — the
# "relative" path then requires several "../" hops out of the project root
# entirely (e.g. "../../../orch-mockhelloworld-prd-12345.json"). Found live
# 2026-07-23: an agent given that path burned its whole iteration budget
# reasoning about whether the traversal was valid instead of just reading
# the file, and never completed its actual task. Use the absolute path in
# that case — it's unambiguous and costs the agent nothing to resolve.
PRD_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$PRD_FILE")" 2>/dev/null || echo "orchestrations/prd.json")"
case "$PRD_REL" in
  ../*) PRD_REL="$(realpath "$PRD_FILE" 2>/dev/null || echo "$PRD_FILE")" ;;
esac
# B18 — agents run with cwd = the CODELINE, not this repo, so a BARE "profiles.json"
# does not resolve. The pre-phase assessment prompt named it bare eight times; unable
# to find it, the agent ran `find / -name profiles.json` and the pipeline sat there
# for 282 SECONDS (mock1, 2026-07-24 — nearly all of what looked like "slow LLM
# calls"). Same relative-inside / absolute-outside treatment as PRD_REL above.
PROFILES_REL="$(realpath --relative-to="$PROJECT_ROOT" "$(realpath "$AGENT_PROFILES_FILE")" 2>/dev/null || echo "$AGENT_PROFILES_FILE")"
case "$PROFILES_REL" in
  ../*) PROFILES_REL="$(realpath "$AGENT_PROFILES_FILE" 2>/dev/null || echo "$AGENT_PROFILES_FILE")" ;;
esac
# Select wrapper script based on PROVIDER override or CLAUDE_CMD
case "${EPAM_ORCHESTRATION_PROVIDER:-${CLAUDE_CMD}}" in
    # Repointed 2026-08-25 at the MAINTAINED script. codemie-claude.sh was a fork of
    # claude.sh that had fallen 10,712 lines behind, and it set STORY_MAX_TURNS=10/30 —
    # a flag Claude Code 2.1.245 no longer accepts, so it would have failed outright.
    # Provider selection still comes from config; only the wrapper mapping changed.
    codemie-claude) CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    copilot)        CLAUDE_SH="$SCRIPT_DIR/copilot.sh" ;;
    openai)         CLAUDE_SH="$SCRIPT_DIR/openai.sh" ;;
    # this was always an alias. What made the rename urgent is that the dispatch REJECTED
    # openrouter, so the value the operator asked for could not be set at all: a run launched
    # with it died at startup with "Unknown EPAM_ORCHESTRATION_PROVIDER 'openrouter'".
    openrouter)     CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    cursor)         CLAUDE_SH="$SCRIPT_DIR/cursor.sh" ;;
    codex)          CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    # Plain Claude Code, the same maintained script every other provider uses. Reached by
    # the mockserver set, which redirects it at MockServer via ANTHROPIC_BASE_URL — a
    # rehearsal must not go through the codemie wrapper, whose --base-url selects an SSO
    # profile and would demand credentials the mock has no business holding.
    claude)         CLAUDE_SH="$SCRIPT_DIR/claude.sh" ;;
    *)
        error "Unknown EPAM_ORCHESTRATION_PROVIDER '${EPAM_ORCHESTRATION_PROVIDER:-}'. Set it to one of: openrouter|openai|copilot|cursor|codex|codemie-claude|claude in your .env file."
        exit 1
        ;;
esac
# Run logs default to orchestrations/logs/ so the nginx-served dashboard can see
# them. OUTPUT_DIR is for generated app code, not run telemetry.
#
# An INHERITED LOG_DIR wins. Parallel lanes give each codeline its own directory
# so that files read back as state — phase-baseline-sha.txt above all — cannot
# leak between lanes. This assignment used to be unconditional, so the lane loop
# passed the right value and the script discarded it: live metrolinx 2026-07-29
# ran three lanes whose environments named three separate directories, all of
# them empty, with everything still written to the shared one. The wiring was
# correct and invisible.
LOG_DIR="${LOG_DIR:-$AUTOMATION_DIR/logs}"
MONITOR_STATUS_FILE="$LOG_DIR/agent-status.json"
MESSAGES_JSONL="$LOG_DIR/agent-messages.jsonl"
# Export so all subprocesses (claude.sh, update-monitor.sh, invoke.py) write to the same files
export MONITOR_FILE="$MONITOR_STATUS_FILE"
export ACTIVITY_FILE="$LOG_DIR/agent-activity.jsonl"
export MESSAGES_JSONL="$LOG_DIR/agent-messages.jsonl"
export PHASE_COST_FILE="$LOG_DIR/phase-cost.jsonl"
export REVIEW_LOG="$LOG_DIR/code-reviews.jsonl"
export GATE_LOG="$LOG_DIR/phase-gates.jsonl"
export COST_LOG="$LOG_DIR/phase-cost.jsonl"
export MESSAGES_DIR="$LOG_DIR/messages"
export LOG_DIR

# WHERE PUBLISHED AGENT OUTPUTS LIVE, agreed explicitly rather than derived twice.
#
# The store defaults to $LOG_DIR/agent-io, but claude.sh reassigns LOG_DIR unconditionally from
# its OWN location (claude.sh:25) and ignores what it inherited. A producer publishing under this
# process's LOG_DIR and a consumer collecting under claude.sh's would be two stores, and the
# consumer would simply find nothing — silently, which is the failure mode this framework exists
# to end. Naming it here makes both sides agree. It stays under LOG_DIR so the pre-run reset
# clears it with everything else: an input surviving into the next run is contamination.
export AGENT_IO_DIR="${AGENT_IO_DIR:-$LOG_DIR/agent-io}"

# NAMED RUN MODE. "Resume the writer" is one word, not six variables an operator must assemble.
# The mode declares which steps it turns off (config/run-modes.json); an unknown mode is refused
# rather than silently running everything. A variable the operator set themselves always wins.
. "$SCRIPT_DIR/lib/run-modes.sh"
# HARD-FAIL IF THIS DOES NOT LOAD. Sourcing a missing file is non-fatal without
# set -e, and phase_exit_is_retryable would then be "command not found" -> exit 127
# -> falsy -> the legitimate gate-remediation retry silently never happens. A
# capability that disappears without a word is the failure mode this whole change
# exists to remove.
. "$SCRIPT_DIR/lib/phase-exit.sh" || { echo "[preflight] lib/phase-exit.sh failed to load — refusing to run" >&2; exit 1; }
. "$SCRIPT_DIR/lib/cost-ledger.sh"

# ── A FREE RUN MUST BE INCAPABLE OF BILLING ──────────────────────────────────
# Gated here because this is the earliest point that knows BOTH the provider set and the project,
# and it is before any seam runs.
#
# On 2026-08-25 a run was launched as "mocked, cannot cost anything" and every seam called the
# real Anthropic API. The assurance rested on a dry run showing the mock redirect resolved, and on
# no key being present in the LAUNCHER. Neither was what mattered: a live child had
# ANTHROPIC_BASE_URL=UNSET and a real sk-ant- key, while MockServer sat at zero requests.
#
# The set declares whether it can spend. A set whose runner is plain `claude` pointed at a mock
# has no business holding a vendor key, so this REFUSES rather than trusting the redirect.
. "$SCRIPT_DIR/lib/free-run-guard.sh" 2>/dev/null || true
if declare -f free_run_requested >/dev/null 2>&1 && free_run_requested; then
    echo "[free-run-guard] EPAM_FREE_RUN is set — this run reaches no vendor; sealing credentials" >&2
    scrub_paid_keys "$(dirname "$AUTOMATION_DIR")/.env" "$AUTOMATION_DIR/jira/.env"
    assert_no_paid_key "${EPAM_PROJECT_CONFIG_DIR:-}" "$(dirname "$AUTOMATION_DIR")/.env" || exit 1
fi
if [ -n "${EPAM_RUN_MODE:-}" ]; then
    apply_run_mode "$EPAM_RUN_MODE" || exit 1
fi
# PHASE reaches ai-run.sh so each agent plan is filed under the phase that
# produced it. Unexported, every plan landed in plans-unknown.jsonl.
export PHASE
# Propagate OpenRouter mock URL to all subprocesses (CPA, spec, ai-run.sh, testing gates)
[ -n "${OPENROUTER_BASE_URL:-}" ] && export OPENROUTER_BASE_URL
[ -n "${OPENROUTER_API_KEY:-}" ] && export OPENROUTER_API_KEY
[ -n "${EPAM_API_KEY_OPENROUTER:-}" ] && export EPAM_API_KEY_OPENROUTER
[ -n "${EPAM_OPENROUTER_MODEL_OVERRIDE:-}" ] && export EPAM_OPENROUTER_MODEL_OVERRIDE
# Propagate MiniMax key to all subprocesses
[ -n "${MINIMAX_API_KEY:-}" ] && export MINIMAX_API_KEY
[ -n "${EPAM_API_KEY_MINIMAX:-}" ] && export EPAM_API_KEY_MINIMAX
[ -n "${MINIMAX_BASE_URL:-}" ] && export MINIMAX_BASE_URL
[ -n "${ORCH_MINI_MODEL:-}" ] && export ORCH_MINI_MODEL
[ -n "${ORCH_UPGRADE_MODEL:-}" ] && export ORCH_UPGRADE_MODEL
[ -n "${EPAM_FINAL_FALLBACK_MODEL:-}" ] && export EPAM_FINAL_FALLBACK_MODEL
[ -n "${EPAM_FINAL_FALLBACK_PROVIDER:-}" ] && export EPAM_FINAL_FALLBACK_PROVIDER
[ -n "${ORCH_GATE_PROVIDER:-}" ] && export ORCH_GATE_PROVIDER
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
if [ -n "${CLAUDE_CMD:-}" ]; then
    CLAUDE_CMD="$CLAUDE_CMD"
elif [ "${EPAM_ORCHESTRATION_PROVIDER:-}" = "codex" ]; then
    CLAUDE_CMD="codex"
# THE openrouter BRANCH IS GONE, NOT RENAMED. It selected a `openrouter` BINARY; openrouter never had one
# which is claude. Renaming it would have named a binary that does not exist either.
else
    CLAUDE_CMD="claude"
fi

EPAM_SANDBOX="${EPAM_SANDBOX:-false}"
EPAM_SANDBOX_ALLOW_NETWORK="${EPAM_SANDBOX_ALLOW_NETWORK:-false}"

# Timeout policy:
#   STORY_TIMEOUT_SECS   — override flat timeout (skips effort-based scaling)
#   EPAM_PAUSE_ON_TIMEOUT — when "true", double-timeout pauses for operator;
#                           default "false" skips the story and continues
#                           (appropriate for autonomous/CI runs)
#   EPAM_MAX_PAUSE_SECS  — even when pausing, auto-resume after this many
#                           seconds (default 300); prevents indefinite hangs
EPAM_PAUSE_ON_TIMEOUT="${EPAM_PAUSE_ON_TIMEOUT:-false}"
EPAM_MAX_PAUSE_SECS="${EPAM_MAX_PAUSE_SECS:-300}"
mkdir -p "$LOG_DIR"
DASHBOARD_WATCH_PID_FILE="$LOG_DIR/dashboards-watch.pid"
DASHBOARD_WATCH_LOG="$LOG_DIR/dashboards-watch.log"
DASHBOARD_WATCH_PID=""
DASHBOARD_WATCH_OWNED=false
# PER-LANE CONTROL-PLANE PORT.
#
# Live 2026-08-04 (run 20260804T011537Z, three metrolinx lanes): this was a bare
# `${CONTROL_PLANE_PORT:-8094}`, so every lane started a control plane on 8094. The first
# bound it and the rest exited ("port already in use"), leaving those lanes with no
# control plane — and because the startup path KILLS whatever holds the port first, a
# later lane reaped the running lane's control plane. Three "Killing stale process on
# port 8094" warnings in one run were lanes destroying each other.
#
# Same shape as the checkpoint collision (b76e414): a per-lane resource keyed on a
# run-global value. The lane is derived exactly as the checkpoint's is — CODELINE_NAME
# when set, otherwise project.outputDir matched back against project.outputDirs[], since
# the orchestrator keeps the lane name as a local and never exports it.
#
# The offset is the lane's INDEX in outputDirs, so it is stable across restarts (a resume
# must find its own control plane) and bounded by the number of codelines. A single-
# codeline run resolves no lane and keeps the base port, unchanged.
CONTROL_PLANE_BASE_PORT="${CONTROL_PLANE_BASE_PORT:-8094}"
CONTROL_PLANE_PORT="$(_resolve_control_plane_port)"
CONTROL_PLANE_PID=""
CONTROL_PLANE_LOG="$LOG_DIR/control-plane.log"

# GAP-P13 Phase 1 — Durable orchestration: idempotency key + file checkpoints
# Each run gets a unique ID. After each story completes, a checkpoint entry is
# written so a crash-restart can skip already-finished stories without needing
# RESET_STORIES=false (which would otherwise re-run everything from scratch).
# EXPORTED so every child inherits it — each agent call is a separate `epam run`
# subprocess, and TracedProvider uses ORCH_RUN_ID as the Langfuse sessionId to
# group a run's traces. Without the export it was set but invisible to children,
# so every trace had sessionId:null and all runs blended into one stream
# (which produced a wrong, retracted cost analysis on 2026-07-24).
# `date -u`: the id ends in Z, which asserts UTC. It was LOCAL time, so the same
# instant rendered as 15:36:35Z here and 19:37:20Z elsewhere — one run looking
# like two, hours apart.
# A RESUME IS THE SAME RUN FROM THE FIRST LINE. lib/orchestration-resume.sh sets ORCH_RUN_ID to
# EPAM_RESUME_RUN later, but by then a fresh id had been minted here, announced below as the RUN
# NUMBER, and baked into CHECKPOINT_FILE — so every resume printed a new run number and kept its
# story checkpoints under it (the "phantom run id", 2026-09-15).
export ORCH_RUN_ID="${ORCH_RUN_ID:-${EPAM_RESUME_RUN:-$(date -u +%Y%m%dT%H%M%SZ)}}"
CHECKPOINT_FILE="${LOG_DIR}/checkpoint-${PHASE:-main}-${ORCH_RUN_ID}.jsonl"

# Announce the run id IMMEDIATELY, before any work. The operator needs it to resume,
# to find the logs, and to refer to the run at all — printing it only at the end (or
# only at a pause) means a run that is still going, or that died, has no usable handle.
echo ""
echo "  RUN NUMBER: ${ORCH_RUN_ID}"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'

source "$SCRIPT_DIR/lib/orch-common.sh"

# ── Step status tracking ──────────────────────────────────────────────────────
# step_emit <step_id> <status> <label> [reason]
#   status: pending | running | pass | skip | fail | warn
# Writes to terminal + step-status.json (read by dashboard)
STEP_STATUS_FILE="${LOG_DIR:-/tmp}/step-status.json"
declare -A _STEP_LABELS=()
declare -A _STEP_STATUS=()
declare -A _STEP_REASON=()

source "$SCRIPT_DIR/lib/phase-assessment.sh"









# detect_and_install_dependencies <codeline_root> <node_bin>
# Generic, manifest-driven dependency install — detects the stack from
# manifest file PRESENCE (data), never assumes npm/Node is the only stack a
# codeline could use. Same detection matrix the old setup-deps.sh had, minus
# the private-scope-strip hack it also carried (that hack was rejected as
# permanent pipeline tooling — see feedback_no_client_repo_writes_or_
# hardcoding memory; a repair needing that kind of manifest mutation stays a
# manual, case-by-case decision, e.g. the azure.commerce.cdts cx-shared
# incident, 2026-07-22).
#
# Each handler is independent and non-fatal on its own failure — this
# mirrors run_dependency_check's own philosophy (a bad handler shouldn't
# block every other stack's install). Returns 0 if at least one recognized
# manifest was found and its handler didn't hard-fail; 1 if no manifest was
# recognized, or the one that WAS found failed outright.
# DEPENDENCY PROVISIONING LIVES IN lib/deps-install.sh.
#
# It was 138 lines here: nine `if` branches, one per ecosystem the engine happened to know, each
# with a hardcoded package-manager command. A tenth ecosystem meant a tenth branch inside this
# file. The ecosystem facts now come from the providers via lib/handlers/install-plan.js; the
# policy that is ours — clean installs are opt-in, and a repair that leaves less than it found is
# destruction — stayed, in the library, where it can be tested without sourcing 11,000 lines.
# shellcheck source=lib/deps-install.sh
. "$SCRIPT_DIR/lib/deps-install.sh"



source "$SCRIPT_DIR/lib/mint-and-spec.sh"



# record_story_actual_cost, check_cost_budget, wait_if_paused,
# apply_redirect_if_any, validate_mid_execution_splits, story_tsc_gate — now
# defined once in lib/story-guards.sh (sourced above) so every lane (main
# and worktree) runs the identical guard. See that file's docstring.

source "$SCRIPT_DIR/lib/gates-testing.sh"

# run_orch_prompt <prompt> [agent_type] [story_id]
# Runs a pipeline agent prompt, tracks cost to phase-cost.jsonl (GAP-P22),
# and returns the text output.
# run_orch_prompt now lives in lib/orch-prompt.sh so a test can reach it without running the
# pipeline. See that file for why. Sourced here, at the point it used to be defined.
# shellcheck source=lib/orch-prompt.sh
. "$SCRIPT_DIR/lib/orch-prompt.sh"

# run_orch_prompt_with_tools <prompt> [agent_type] [story_id]
# Identical to run_orch_prompt but enables ReadFile + Bash tool access for the agent.
# Required for QA gate agents that must read source files to ground their analysis:
# sast-sentinel, spec-validator, review-ranger, mutant-hunter, fuzz-weaver, perf-sentinel.
# Without tool access these agents hallucinate findings about files they cannot verify.
# STRUCTURAL, not prompt-level: the allowlist means write_file is never handed to
# the model, so "answering" by writing a file becomes unreachable. Live metrolinx
# 2026-07-26 — perf-sentinel's ENTIRE log was "The file has been written
# successfully.", both attempts exhausted, ~20 minutes spent reviewing nothing;
# fuzz-weaver produced a 0-byte log in the same run. Two of six quality gates
# passed the phase having examined nothing.
#
# This was already diagnosed and structurally fixed for the code-graph-detective
# on 2026-07-23, and src/tools/createTools.ts names "the source-reading QA gates"
# as intended beneficiaries — the wiring here was simply never done. In its place
# the pipeline grew two work-arounds for the symptom (a retry that detects "has
# been written" and prepends a corrective paragraph, and a recovery pass that
# hunts the project for the file the model wrote). Prompt instructions could not
# prevent it; removing the capability does. Those work-arounds stay as a
# backstop for any model that finds another way to avoid answering.
# Derived, not literal. The base built-in read-only set PLUS whatever plugins this project
# registered for the codeline — a project that adds a plugin gets it at the gates without
# editing this script. The literal here filtered every project plugin tool out before the
# model ever saw it, while the project had explicitly registered them.
# shellcheck source=lib/gate-tools.sh
. "${SCRIPT_DIR}/lib/gate-tools.sh" 2>/dev/null || true
if [ -z "${ORCH_GATE_ALLOWED_TOOLS:-}" ] && command -v gate_allowed_tools >/dev/null 2>&1; then
    ORCH_GATE_ALLOWED_TOOLS="$(gate_allowed_tools "${JIRA_CODELINE_ROOT:-${PROJECT_ROOT:-$PWD}}")"
fi
ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-bash,read_file,list_files,search}"
export ORCH_GATE_ALLOWED_TOOLS



# runtime_boundary_verdict now lives in lib/gate-verdicts.sh so its fail/warn/pass rules — and
# the grounding check that decides whether a fail may block — can be executed by a test.
# shellcheck source=lib/gate-verdicts.sh
. "$SCRIPT_DIR/lib/gate-verdicts.sh"

# _run_qa_gate_with_retry now lives in lib/gate-verdicts.sh, beside the verdict rules it feeds,
# so a gate becoming a decision can be executed by a test. Sourced above with that file.





source "$SCRIPT_DIR/lib/story-watchdog.sh"







source "$SCRIPT_DIR/lib/checkpoints.sh"



# wait_if_paused — now in lib/story-guards.sh (sourced above).

source "$SCRIPT_DIR/lib/prd-integrity.sh"

# capture_story_ids_snapshot / assert_no_story_ids_lost — deterministic
# invariant check against silent story deletion.
#
# Root cause this guards against (found live, 2026-07-09, tier3-travel-app
# run): SKY-002/003/004 vanished ENTIRELY from prd.stories[] — not merely
# stripped of technicalNotes.files (the already-fixed orphaned-pending-story
# gate scenario) — sometime during the scaffold phase. A deliberate repro
# attempt (fresh teardown + a poller watching the story-ID list every second)
# did NOT reproduce it, meaning the defect is intermittent, most likely tied
# to a specific LLM response shape in one of the three steps that give an
# agent full Bash/WriteFile tool access to the PRD (Step 0.5, Step 0.9, and
# run_phase_assessment's Step 3.5/Step 6 calls) — each of these is explicitly
# instructed (in its own prompt) to only ADD to profiles.json or change
# narrow fields, never restructure stories[], but that instruction is prose,
# not enforcement. No deterministic remediation step ever removes a story
# from stories[] either — deprecation is tracked via status field, the
# record itself is always kept ("archive"), per _prd_remediate_impl.py's own
# documented convention. So the story-ID SET must never shrink, anywhere in
# this pipeline, once Step 0 (spec-pass, the one step that legitimately
# reshapes IDs via splits) has completed for this phase.
#
# This does not fix the root cause (which agent turn is doing this, and why)
# — it makes the NEXT occurrence hard-fail immediately with the exact
# missing ID(s) and the step that just ran, instead of silently producing a
# phase that "completes" having done zero real work.
STORY_ID_SNAPSHOT_DIR="${STORY_ID_SNAPSHOT_DIR:-$(mktemp -d)}"







# apply_redirect_if_any — now in lib/story-guards.sh (sourced above).




# ── Jira pipeline mode ────────────────────────────────────────────────────────
# ── Shared codeline routing loop ──────────────────────────────────────────────
# Used by both Jira ingest flow and canonical PRD flow.
# Reads project.outputDirs from the PRD, validates/scaffolds worktrees, then
# re-execs itself (with JIRA_CODELINE_RUN=1) once per codeline per phase.
# The only difference between the two flows is how the PRD was sourced.
#
# $1 — path to PRD to route (synthesized or canonical)
# $2 — log file path (optional; defaults to a new tmp file)




# ── Jira ingest flow ───────────────────────────────────────────────────────────
# JIRA_PIPELINE=1: pull tickets, run AC gate, synthesize PRD, then route codelines.



# ── Entry point guards ─────────────────────────────────────────────────────────
# Both guards are parent-only (is_parent) — a lane re-exec must not repeat them.

# Pre-parse --phase from CLI args BEFORE routing so _run_codeline_loop knows which
# phase the caller is requesting. Without this, the multi-codeline routing fires
# before argument parsing, causing the phase filter to be silently dropped — which
# makes every `run-agent-orchestration.sh --phase scaffold` call from the tier3
# launcher run ALL phases (double-execution across codelines).
_ep_caller_phase=""
for (( _ep_i=1; _ep_i<=$#; _ep_i++ )); do
  if [ "${!_ep_i}" = "--phase" ]; then
    _ep_j=$((_ep_i + 1))
    _ep_caller_phase="${!_ep_j:-}"
    break
  fi
done
unset _ep_i _ep_j


# Resume — the block lives in lib/orchestration-resume.sh so its refusals can be tested.
# shellcheck source=lib/orchestration-resume.sh
. "$SCRIPT_DIR/lib/orchestration-resume.sh"
apply_resume_if_requested

if is_parent; then
  if [ "${JIRA_PIPELINE:-0}" = "1" ]; then
    # Jira flow: ingest → synthesize → route codelines
    _run_jira_pipeline; exit $?
  else
    # RESOLVE THE SCOPE BEFORE COUNTING IT.
    #
    # The count below is the whole dispatch decision, and it reads project.outputDirs — which
    # only the Jira synthesizer ever wrote. A project whose PRD is authored therefore counted 0
    # however many codelines it really had, fell through to single-lane execution, and the mint
    # reported success against one unnamed codeline.
    #
    # Discovery is not a Jira capability; it is the answer to "which repositories does this work
    # touch", which every brownfield project needs. The resolver is a no-op when the scope is
    # already declared, and a no-op when no codeline root is configured — so a single-repo
    # project and a project that declares its own codelines both reach the count unchanged.
    #
    # HALTS on failure. A run that proceeds with an unresolved scope writes to whichever single
    # repository it happens to land on.
    # Guarded so an unloaded library is skipped rather than fatal: an undefined function
    # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
    # harness runs this code with the gate library absent. The orchestrator sources it at the
    # top, and pre-flight is what actually gates a run.
    declare -f require_stage_coverage >/dev/null && { require_stage_coverage discovery || exit 1; }
    if ! bash "$SCRIPT_DIR/resolve-codeline-scope.sh" --prd "$PRD_FILE"; then
      error "[orch] codeline scope could not be resolved — refusing to run against an unknown scope"
      exit 1
    fi

    # THE MINT, on this path too. Scope is resolved above, so the codelines it needs exist.

    # THE MINT, on this path too. Scope is resolved above, so the codelines it needs exist.
    _run_agent_mint "$PRD_FILE" "${LOG_DIR:-}/orchestration.log" || exit 1

    # THE SAME REVIEW POINT THE INGESTING PATH GETS. A project that authors its PRD produces a
    # roster and assignments exactly as one that ingests does, so it stops here too.
    _pause_after_agent_mint

    # Canonical PRD flow: if the PRD defines multiple codelines, route them.
    # Single-codeline PRDs fall through to the normal phase execution below.
    _cl_count=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/cl-count.js" "$PRD_FILE" 2>/dev/null || echo 0)
    if [ "${_cl_count:-0}" -gt 1 ]; then
      # Pass _ep_caller_phase as third arg so the loop runs only the requested phase.
      # Empty string = run all PRD phases (Jira path, or direct invocation without --phase).
      _run_codeline_loop "$PRD_FILE" "" "${_ep_caller_phase}"; exit $?
    fi
  fi
fi

# Default configuration
PHASE="${PHASE:-finops}"
DRY_RUN=false
SKIP_CLEANUP=false
# Orchestration mode: bash (default, no change to existing flow) or hybrid
# Override: ORCH_MODE=hybrid ./run-agent-orchestration.sh  OR  --mode hybrid
ORCH_MODE="${ORCH_MODE:-bash}"


add_exit_handler cleanup



# Parse arguments — the loop lives in lib/orchestration-args.sh so it can be called by a test.
# shellcheck source=lib/orchestration-args.sh
. "$SCRIPT_DIR/lib/orchestration-args.sh"
parse_orchestration_args "$@"


# ── Sandbox bootstrap ─────────────────────────────────────────────────────────
if [ "${EPAM_SANDBOX:-false}" = "true" ]; then
    SANDBOX_INVOKE="$SCRIPT_DIR/lib/sandbox-invoke.sh"
    SANDBOX_IMAGE="${EPAM_SANDBOX_IMAGE:-epam-cli-sandbox:latest}"
    SANDBOX_DOCKERFILE="$SCRIPT_DIR/Dockerfile.sandbox"
    SANDBOX_BASE_IMAGE="${EPAM_SANDBOX_BASE_IMAGE:-$(derive_sandbox_base_image "$PRD_FILE")}"
    _RUNTIME=""
    for _rt in docker podman; do
        command -v "$_rt" &>/dev/null && { _RUNTIME="$_rt"; break; }
    done
    if [ -z "$_RUNTIME" ]; then
        error "--sandbox requires docker or podman — neither found in PATH"
        exit 1
    fi
    if [ ! -f "$SANDBOX_INVOKE" ]; then
        error "sandbox-invoke.sh not found at $SANDBOX_INVOKE"
        exit 1
    fi
    chmod +x "$SANDBOX_INVOKE"
    # Build image if not already present
    if ! "$_RUNTIME" image inspect "$SANDBOX_IMAGE" &>/dev/null 2>&1; then
        log "[sandbox] Building image ${SANDBOX_IMAGE} from ${SANDBOX_DOCKERFILE} (base: ${SANDBOX_BASE_IMAGE})..."
        "$_RUNTIME" build -t "$SANDBOX_IMAGE" --build-arg "BASE_IMAGE=${SANDBOX_BASE_IMAGE}" -f "$SANDBOX_DOCKERFILE" "$SCRIPT_DIR" \
            | sed 's/^/  [docker] /' || {
            error "[sandbox] Image build failed — check Dockerfile.sandbox"
            exit 1
        }
        success "[sandbox] Image ${SANDBOX_IMAGE} ready"
    else
        log "[sandbox] Image ${SANDBOX_IMAGE} already present — skipping build"
    fi
    # Override CLAUDE_CMD so claude.sh uses the sandbox wrapper
    export CLAUDE_CMD="$SANDBOX_INVOKE"
    export EPAM_SANDBOX_IMAGE="$SANDBOX_IMAGE"
    export EPAM_SANDBOX_ALLOW_NETWORK="${EPAM_SANDBOX_ALLOW_NETWORK:-false}"
    log "[sandbox] ENABLED — agent invocations will run in ${SANDBOX_IMAGE}"
    log "[sandbox] Runtime: ${_RUNTIME} | CPUs: ${EPAM_SANDBOX_CPUS:-2} | Memory: ${EPAM_SANDBOX_MEMORY:-4g}"
fi

# Reset story completed flags if requested (idempotent re-runs)
# When PHASE is set, only reset stories belonging to that phase — preserving prior-phase completions.
if [ "${RESET_STORIES:-false}" = "true" ]; then
    log "Resetting story completed flags in $PRD_FILE..."
    local_tmp=$(mktemp)
    # mktemp defaults to mode 0600; mv preserves that onto the final PRD file,
    # breaking anything not running as this user (e.g. the monitor
    # dashboard's nginx worker) -- found live 2026-07-14, this exact block
    # (the highest-frequency PRD write in the pipeline, firing at the start
    # of every --reset invocation) was the primary repeat offender after an
    # earlier pass fixed 5 other mktemp-based PRD writes but missed this one.
    chmod 644 "$local_tmp" 2>/dev/null
    # "in-progress" included alongside "completed"/"failed" (found live
    # 2026-08-02 alongside the Step 9 auto-commit fix): a story left
    # mid-execution across a retry boundary (e.g. a later gate blocked
    # before the story's own commit landed) never had its status flipped to
    # "completed" or "failed", so it silently survived every reset as
    # "in-progress" — a transient state that must never persist past a
    # --reset boundary.
    if [ -n "${PHASE:-}" ]; then
        # Scoped reset: only touch stories in implementationOrder[PHASE]
        jq --arg phase "$PHASE" '
          (.implementationOrder[$phase] // []) as $ids |
          (.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed" or .status == "in-progress"))
            |= (.completed = false | .status = "pending") |
          (.phases[]?.stories[]? | select(.id as $id | $ids | index($id) != null)
            | select(.completed == true or .status == "failed" or .status == "in-progress"))
            |= (.completed = false | .status = "pending")' \
            "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
        success "Stories reset to pending (phase: $PHASE)"
    else
        # Global reset: no phase scoping
        jq '(.stories[]? | select(.completed == true or .status == "failed" or .status == "in-progress")) |= (.completed = false | .status = "pending") |
            (.phases[]?.stories[]? | select(.completed == true or .status == "failed" or .status == "in-progress")) |= (.completed = false | .status = "pending")' \
            "$PRD_FILE" > "$local_tmp" && mv "$local_tmp" "$PRD_FILE"
        success "Stories reset to pending (all phases)"
    fi
    checkpoint_clear

    # Clean up review artifacts for review stories being reset so AC pre-existing-file guard doesn't block re-runs
    while IFS= read -r _review_id; do
        [ -z "$_review_id" ] && continue
        # INSIDE THE ENGINE PERIMETER. This wrote to $PROJECT_ROOT/review/, which is NOT in
        # _ENGINE_OWNED_DIRS — so git_add_client_outputs staged it and the engine's own review
        # markdown was COMMITTED into the customer's repository. Verified by execution: with
        # .epam/ and orchestrations/ correctly excluded, review/ came through.
        #
        # The fix is NOT to add "review" to _ENGINE_OWNED_DIRS: that name is generic enough that a
        # client repo may legitimately have one, and excluding it would silently drop their work
        # from every commit. .epam/ is already engine-owned and claims no new name.
        _review_artifact="$PROJECT_ROOT/.epam/review/${_review_id}-review.md"
        mkdir -p "$(dirname "$_review_artifact")" 2>/dev/null || true
        if [ -f "$_review_artifact" ]; then
            rm -f "$_review_artifact"
            info "  Removed stale review artifact: .epam/review/${_review_id}-review.md"
        fi
    done < <(jq -r '.stories[]? | select(.agentRole == "review-agent") | .id' "$PRD_FILE" 2>/dev/null)
    # Immediately push reset state to dashboard so viewer shows clean slate
    if [ -n "${OUTPUT_DIR:-}" ]; then
        cp "$PRD_FILE" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
    fi
fi

# A RESUME RE-QUEUES WHAT FAILED, AND ONLY THAT. A resume runs without --reset (a reset would
# tear down completed phases), so a story the previous invocation marked failed stayed failed —
# and the pre-flight integrity audit refused the whole resume on it ("Active stories not in clean
# pending state"), while the orchestrator's own last words were "recovery was NOT exhausted ...
# ladder still below its top rung" (regintel 20260916T200108Z, 2026-09-17). A failed, uncompleted
# story is exactly what a resume exists to retry: its ladder rung is persisted in
# story-retry-state and the next attempt climbs from there. Completed stories are untouched.
if [ "${RESET_STORIES:-false}" != "true" ] && [ -n "${EPAM_RESUME_RUN:-}" ]; then
    _requeue_tmp=$(mktemp); chmod 644 "$_requeue_tmp" 2>/dev/null
    _requeued=$(jq -r '[.stories[]? | select(.status == "failed" and (.completed // false) == false) | .id] | join(", ")' "$PRD_FILE" 2>/dev/null || echo "")
    if [ -n "$_requeued" ]; then
        jq '(.stories[]? | select(.status == "failed" and (.completed // false) == false)) |= (.status = "pending") |
            (.phases[]?.stories[]? | select(.status == "failed" and (.completed // false) == false)) |= (.status = "pending")' \
            "$PRD_FILE" > "$_requeue_tmp" && mv "$_requeue_tmp" "$PRD_FILE"
        success "Resume of run ${EPAM_RESUME_RUN}: re-queued failed story/ies for retry — ${_requeued}"
    else
        rm -f "$_requeue_tmp"
    fi
fi

# Verify prerequisites
if [ ! -f "$CLAUDE_SH" ]; then
    error "claude.sh not found at $CLAUDE_SH"
    exit 1
fi
if [ ! -f "$PRD_FILE" ]; then
    error "prd.json not found at $PRD_FILE"
    exit 1
fi
if ! command -v jq &> /dev/null; then
    error "jq is required but not installed"
    exit 1
fi

seed_runtime_logs

# Verify phase exists
phase_stories=$(jq -r --arg phase "$PHASE" '.implementationOrder[$phase] // empty' "$PRD_FILE")
if [ -z "$phase_stories" ] || [ "$phase_stories" = "null" ]; then
    error "Phase '$PHASE' not found in prd.json"
    echo ""
    echo "Available phases:"
    jq -r '.implementationOrder | keys[]' "$PRD_FILE" | while read p; do echo "  - $p"; done
    exit 1
fi

start_dashboards_watch
start_control_plane

# Resolve orch mode early so checklist can show accurate 0.6 status
RESOLVED_ORCH_MODE=$(resolve_orch_mode "$PHASE")

# Print step checklist BEFORE any step runs so user sees what's coming
STEP_STATUS_FILE="$LOG_DIR/step-status.json"
print_step_checklist


# ── Resume: start at implementation, not at the beginning ────────────────────
if [ "$DRY_RUN" = true ]; then
    step_emit "1" "skip" "Step 1: Specification pass" "dry-run"
    step_emit "1a" "skip" "  openspec (elaboration)" "dry-run"
    step_emit "1b" "skip" "  speckit (verification)" "dry-run"
    info "Step 1: Specification pass skipped during --dry-run"
elif [ "${EPAM_SPEC_MODE:-1}" = "0" ]; then
    step_emit "1" "skip" "Step 1: Specification pass" "EPAM_SPEC_MODE=0"
    step_emit "1a" "skip" "  openspec (elaboration)" "EPAM_SPEC_MODE=0"
    step_emit "1b" "skip" "  speckit (verification)" "EPAM_SPEC_MODE=0"
    info "Step 1: Specification pass disabled (EPAM_SPEC_MODE=0)"
else
    run_specification_pass "$PHASE"
fi


# Story-ID-loss invariant: snapshot the settled post-spec-pass story set for
# this phase. See capture_story_ids_snapshot's own docstring above for why.
capture_story_ids_snapshot "presplit"

_publish_agent_outputs

# ── Checkpoint: the spec pass's output is now settled ────────────────────────
# Persist it UNCONDITIONALLY, whether or not we are pausing. Anything generated and not
# written to disc is a project violation, and until now the spec pass's output existed
# only as an in-place mutation of the runtime PRD — which pre-run-reset.sh's next launch
# would overwrite. Saving costs one file copy and buys a resumable run.
if _ckpt_path=$(save_run_checkpoint "$PHASE" 2>&1); then
    info "[orch] checkpoint saved: ${_ckpt_path}"
else
    warning "[orch] could not save the post-spec checkpoint: ${_ckpt_path}"
    warning "[orch] this run will NOT be resumable — a later failure costs a full spec pass to retry."
fi


# ── Infra test gate ──────────────────────────────────────────────────────────
# Block any phase that depends on infra_test (anything except infra_test itself)
# unless all SP-T0x stories are completed.
if [ "$PHASE" != "infra_test" ]; then
    infra_test_stories=$(jq -r '
        (.implementationOrder["infra_test"] // []) as $ids |
        .stories[] | select(.id as $id | $ids | index($id))
        | .id' "$PRD_FILE" 2>/dev/null)

    if [ -n "$infra_test_stories" ]; then
        infra_incomplete=""
        while IFS= read -r sid; do
            [ -z "$sid" ] && continue
            completed=$(jq -r --arg id "$sid" '.stories[] | select(.id==$id) | .completed' "$PRD_FILE")
            if [ "$completed" != "true" ]; then
                infra_incomplete="$infra_incomplete $sid"
            fi
        done <<< "$infra_test_stories"

        if [ -n "$infra_incomplete" ]; then
            echo ""
            echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
            echo -e "${RED}║  INFRA TEST GATE — Phase '$PHASE' is BLOCKED         ║${NC}"
            echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "${YELLOW}The following infra_test stories must complete before running '$PHASE':${NC}"
            for sid in $infra_incomplete; do
                title=$(jq -r --arg id "$sid" '.stories[] | select(.id==$id) | .title' "$PRD_FILE")
                echo -e "  ${RED}✗${NC} $sid: $title"
            done
            echo ""
            echo -e "${CYAN}Run the infra_test phase first:${NC}"
            echo -e "  $(basename "$0") --phase infra_test"
            echo ""
            echo -e "${YELLOW}If infra_test has been run but status not updated, check:${NC}"
            echo -e "  curl -s $(service_url storyApi)/api/stories | jq '[.[] | select(.phase==\"infra_test\") | {id,status,completed}]'"
            echo ""
            exit 1
        fi
    fi
fi

# Create log directory
mkdir -p "$LOG_DIR"

# ── Step 0.1: Contextual Purveyor Agent (CPA) pre-pass ───────────────────────
# Reviews upcoming phase stories, adjusts estimates, and gates on confidence.
# Skip with: SKIP_CPA=1 ./run-agent-orchestration.sh --phase <phase>
# For strict mode (halt on 'review' gate): STRICT_CPA=1
# ─────────────────────────────────────────────────────────────────────────────
CPA_SCRIPT="$SCRIPT_DIR/contextualize-stories.sh"

if ! is_truthy "${SKIP_CPA:-}" && [ -f "$CPA_SCRIPT" ]; then
    step_emit "2" "running" "Step 2: CPA pre-pass"
    log "Step 2: Running CPA pre-pass for phase '$PHASE'..."

    cpa_flags="--phase $PHASE --apply"
    [ "${STRICT_CPA:-0}" = "1" ] && cpa_flags="$cpa_flags --strict"

    # Inject most recent prior-phase handoff if available
    _prev_handoff=""
    _handoff_search_dir="$(dirname "$LOG_DIR")"
    # Look for handoff files under any logs/ sub-directory, pick the most recent by mtime
    _prev_handoff=$(find "$_handoff_search_dir" -maxdepth 3 -name "phase-handoff-*.md" \
        ! -name "phase-handoff-${PHASE}.md" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | awk '{print $2}' || true)
    [ -f "${_prev_handoff:-}" ] && info "Step 2: Injecting prior-phase context from: ${_prev_handoff##*/}"

    cpa_exit=0
    # IMPORTANT: do NOT use `|| cpa_exit=$?` here.
    # Without pipefail, the pipeline exit code is tee's exit code (almost always 0),
    # so BLOCK (exit 3) and REVIEW (exit 2) from $CPA_SCRIPT were silently discarded
    # and the case statement below always took the "0) pass" branch.
    # PIPESTATUS[0] captures $CPA_SCRIPT's real exit code regardless of tee's success.
    # shellcheck disable=SC2086
    CLAUDE_CMD="$CLAUDE_CMD" AI_RUNNER_CMD="$AI_RUNNER_CMD" EPAM_CLI="${EPAM_CLI:-epam}" \
        PREV_PHASE_HANDOFF_FILE="${_prev_handoff:-}" \
        bash "$CPA_SCRIPT" $cpa_flags 2>&1 | tee "$LOG_DIR/cpa-${PHASE}.log"
    cpa_exit="${PIPESTATUS[0]}"

    case $cpa_exit in
        0)
            step_emit "2" "pass" "Step 2: CPA pre-pass"
            success "Step 2: CPA gate PASSED for phase '$PHASE'"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_pass" \
                "CPA gate passed — all stories cleared" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        2)
            step_emit "2" "warn" "Step 2: CPA pre-pass" "elevated risk — review"
            warning "Step 2: CPA gate REVIEW — some stories have elevated risk"
            warning "  Check: $LOG_DIR/cpa-${PHASE}.log"
            warning "  Continuing (use STRICT_CPA=1 to halt on review gates)"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_review" \
                "CPA gate REVIEW — proceeding with warnings" "" "main" "context-purveyor" 2>/dev/null || true
            ;;
        3)
            step_emit "2" "fail" "Step 2: CPA pre-pass"
            error "Step 2: CPA gate BLOCKED — one or more stories cannot proceed"
            error "  Check: $LOG_DIR/cpa-${PHASE}.log"
            error "  Resolve flagged issues, then re-run. Override: SKIP_CPA=1"
            "$SCRIPT_DIR/update-monitor.sh" event "cpa_block" \
                "CPA gate BLOCKED — pipeline halted" "" "main" "context-purveyor" 2>/dev/null || true
            exit 3
            ;;
        *)
            warning "Step 2: CPA script exited with code $cpa_exit (non-critical — continuing)"
            ;;
    esac
else
    if is_truthy "${SKIP_CPA:-}"; then
        step_emit "2" "skip" "Step 2: CPA pre-pass" "SKIP_CPA=1"
        info "Step 2: CPA pre-pass skipped (SKIP_CPA=1)"
    else
        step_emit "2" "skip" "Step 2: CPA pre-pass" "script not found"
        info "Step 2: CPA script not found — skipping pre-pass"
    fi
fi

echo ""
echo -e "${MAGENTA}============================================${NC}"
echo -e "${MAGENTA}  EPAM CLI Agent Orchestration${NC}"
echo -e "${MAGENTA}  Phase: ${WHITE}$PHASE${NC}"
echo -e "${MAGENTA}  Mode:  ${WHITE}$([ "$DRY_RUN" = true ] && echo "DRY RUN" || echo "LIVE")${NC}"
echo -e "${MAGENTA}  Orch:  ${WHITE}${RESOLVED_ORCH_MODE}$([ "$RESOLVED_ORCH_MODE" = "hybrid" ] && echo " (Agent Teams + MCP bus)" || echo " (bash-only)")${NC}"
echo -e "${MAGENTA}============================================${NC}"
echo ""

# Categorize stories by agent group
# Deprecated stories (e.g. a split child rejected for a same-file coherence
# violation) must never be selected here — found live 2026-07-10 when a
# deprecated SKY-002-test (completed == false, since it never ran) got
# re-queued and re-implemented on every orchestration loop restart, burning
# cost on work that had already been correctly abandoned.
main_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select((.agentGroup == "main" or .agentGroup == "preflight") and (.completed // false) == false) | .id' "$PRD_FILE")

primary_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "primary" and (.completed // false) == false) | .id' "$PRD_FILE")

independent_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentGroup == "independent" and (.completed // false) == false) | .id' "$PRD_FILE")

review_stories=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select(.agentRole == "review-agent" and (.completed // false) == false) | .id' "$PRD_FILE")

# Apply dependency-graph ordering within each group
main_stories=$(topo_sort_stories "$main_stories")
primary_stories=$(topo_sort_stories "$primary_stories")
independent_stories=$(topo_sort_stories "$independent_stories")
review_stories=$(topo_sort_stories "$review_stories")

# ── Topology routing (GAP-P11) ────────────────────────────────────────────────
# Build story metadata payload for the LLM router.
# Falls back to count heuristic when no API key is set or the call fails.
_wt_stories_list=""
[ -n "$primary_stories" ]     && _wt_stories_list="${_wt_stories_list}${primary_stories}"$'\n'
[ -n "$independent_stories" ] && _wt_stories_list="${_wt_stories_list}${independent_stories}"$'\n'
_wt_count=$(echo "$_wt_stories_list" | grep -c '[^[:space:]]') || _wt_count=0

# THE TOPOLOGY A PROJECT ALREADY KNOWS, DECLARED RATHER THAN INFERRED.
#
# The router asks a model which execution topology a phase should use — single, parallel or
# sequential worktrees. That is worth a call when the answer is genuinely uncertain, and it is spend
# with no decision in it when the operator already knows: an estate that always runs sequentially
# pays per phase to be told so, and a project with no minted router prompt fails its seam check over
# a question a declaration answers.
#
# EPAM_TOPOLOGY is that declaration. Set, it is used and no model is asked; unset, the router runs
# exactly as before and the count heuristic still backs it. Declared in the project's own config.env
# like every other project decision, so no engine change is needed to express one.
#
# Precedence, highest first: the operator's declaration, the router's answer, the count heuristic.
_topology_declared="${EPAM_TOPOLOGY:-}"
case "$_topology_declared" in
    single|parallel|sequential) ;;
    "") ;;
    *)
        warning "[orch] EPAM_TOPOLOGY='${_topology_declared}' is not one of single, parallel, sequential — ignoring it and asking the router"
        _topology_declared=""
        ;;
esac

_router_js="$SCRIPT_DIR/lib/topology-router.js"
_topology_decision=""
_topology_reason=""
_topology_source="heuristic"

if [ -n "$_topology_declared" ]; then
    _topology_decision="$_topology_declared"
    _topology_source="declared"
    _topology_reason="declared by the project as EPAM_TOPOLOGY"
elif [ "${EPAM_TOPOLOGY_ROUTER:-1}" = "0" ]; then
    # THE ROUTER, TURNED OFF, WITHOUT PINNING A SHAPE.
    #
    # EPAM_TOPOLOGY pins the answer; this declines to ASK while leaving the answer to the count
    # heuristic, which is deterministic and free. A project that does not want to pay a model per
    # phase to be told what a comparison already knows says so here, and the heuristic below runs
    # exactly as it does whenever the router returns nothing.
    _topology_source="heuristic"
elif [ -f "$_router_js" ] && command -v node &>/dev/null; then
    # Build JSON payload: story metadata from PRD
    _story_ids_json=$(echo "$_wt_stories_list" | grep '[^[:space:]]' | \
        jq -R . | jq -s 'map(select(. != ""))' 2>/dev/null || echo "[]")

    _stories_payload=$(jq -n \
        --arg phase "$PHASE" \
        --argjson ids "$_story_ids_json" \
        --argjson prd "$(cat "$PRD_FILE" 2>/dev/null || echo '{}')" \
        '{
            phase: $phase,
            stories: [
                $prd.stories[]?
                | select(.id as $id | $ids | index($id))
                | { id, effort: (.effort // "low"), agentRole: (.agentRole // ""),
                    storyType: (.storyType // "implementation"),
                    dependencies: (.technicalNotes.dependsOn // []) }
            ],
            cpaSignals: [
                $prd.stories[]?
                | select(.id as $id | $ids | index($id))
                | { id, filesExist: (.technicalNotes.filesExist // 0),
                    estimatedTurns: (.estimatedTurns // null) }
            ]
        }' 2>/dev/null || echo '')

        # AN INPUT NOBODY PRODUCED IS NOT AN INPUT. This fell back to
        # '{"phase":"","stories":[],"cpaSignals":[]}' when jq could not build the payload — a
        # well-formed object with nothing in it. topology-router.js then refused to render
        # ("EMPTY values for: __PHASE__"), its stderr went to /dev/null, and the heuristic ran
        # with nobody aware the model router had been skipped. The heuristic is a fine outcome;
        # being unable to tell it apart from a model decision is not.
        if [ -z "$_stories_payload" ]; then
            warning "  [topology-router] could not build its input from the PRD — SKIPPING the model router; the topology below is the heuristic's, not a model's"
        fi

    _router_started=$(date -Iseconds)
    _router_out=""
    [ -n "$_stories_payload" ] && _router_out=$(echo "$_stories_payload" | \
        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${EPAM_API_KEY_ANTHROPIC:-}}" \
        node "$_router_js" 2>/dev/null || echo "")

    if [ -n "$_router_out" ]; then
        _topology_decision=$(echo "$_router_out" | jq -r '.topology // empty' 2>/dev/null || echo "")
        _topology_reason=$(echo "$_router_out"   | jq -r '.reason   // empty' 2>/dev/null || echo "")
        _topology_source=$(echo "$_router_out"   | jq -r '.source   // "heuristic"' 2>/dev/null || echo "heuristic")
        # GAP-P22: track topology router cost when LLM was invoked
        if [ "$_topology_source" = "llm" ]; then
            # WHAT ACTUALLY RAN, or nothing. This is a COST record: a vendor literal here
            # attributes real spend to a model that was never invoked, which is worse than an
            # unattributed record because it looks correct in the cost report.
            _router_model=$(echo "$_router_out" | jq -r '.model // empty' 2>/dev/null || echo "")
            [ -n "$_router_model" ] || _router_model=$(seam_model_or_fail "prd-model-coordinator" 2>/dev/null || printf 'unrecorded')
            append_pipeline_cost_record "topology-router" "pipeline" "$_router_model" "$_router_started" \
                "0.001" "800" "50" "1" 2>/dev/null || true
        fi
    fi
fi

# Apply topology decision
if [ -z "$_topology_decision" ]; then
    # Pure count heuristic fallback
    if   [ "$_wt_count" -le 1 ]; then _topology_decision="single"
    elif [ "$_wt_count" -le 4 ]; then _topology_decision="parallel"
    else                               _topology_decision="sequential"; fi
    _topology_source="heuristic"
fi

# Log decision + reason to phase-cost.jsonl for dashboard visibility (compact — must be single-line JSONL)
jq -cn \
    --arg phase    "$PHASE" \
    --arg topology "$_topology_decision" \
    --arg reason   "${_topology_reason:-}" \
    --arg source   "$_topology_source" \
    '{ event:"topology_decision", phase:$phase, topology:$topology,
       reason:$reason, source:$source, timestamp:(now|todate) }' \
    >> "${PHASE_COST_FILE:-/dev/null}" 2>/dev/null || true

src_tag="[$_topology_source]"
[ "$_topology_source" = "llm" ] && src_tag="[llm:$(echo "$_router_out" | jq -r '.model // "haiku"' 2>/dev/null | sed 's/claude-//;s/-20[0-9]*//'  )]"
info "Topology: $_topology_decision $src_tag — ${_topology_reason:-count heuristic}"

# Collapse worktree lane when topology is single or sequential
if [ "$_topology_decision" = "single" ] || [ "$_topology_decision" = "sequential" ]; then
    if [ "$_wt_count" -ge 1 ]; then
        _collapsed=$(echo "$_wt_stories_list" | tr -s '\n' | grep '[^[:space:]]' || true)
        if [ -n "$main_stories" ]; then
            main_stories="${main_stories}
${_collapsed}"
        else
            main_stories="$_collapsed"
        fi
        main_stories=$(topo_sort_stories "$main_stories")
    fi
    primary_stories=""
    independent_stories=""
fi
# topology=parallel: leave primary_stories + independent_stories as-is for worktree execution

# Surface resume-from-failure: show progress if some stories already completed
_phase_total=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) | length' "$PRD_FILE" 2>/dev/null || echo 0)
_phase_done=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo 0)
if [ "${_phase_done:-0}" -gt 0 ] && [ "${_phase_total:-0}" -gt 0 ]; then
    _phase_remaining=$(( _phase_total - _phase_done ))
    info "Resuming phase '$PHASE': $_phase_done/$_phase_total stories already complete — $_phase_remaining remaining"
fi

# Display execution plan
echo -e "${CYAN}Execution Plan:${NC}"
echo ""
if [ -n "$main_stories" ]; then
    echo -e "  ${MAGENTA}Main branch (sequential):${NC}"
    echo "$main_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${CYAN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$primary_stories" ]; then
    echo -e "  ${GREEN}Worktree-1 (primary chain):${NC}"
    echo "$primary_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${GREEN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$independent_stories" ]; then
    echo -e "  ${CYAN}Worktree-2 (independent):${NC}"
    echo "$independent_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // "none"' "$PRD_FILE")
        echo -e "    $s: $title ${CYAN}[$role]${NC}"
    done
    echo ""
fi
if [ -n "$review_stories" ]; then
    echo -e "  ${RED}Review (after worktrees complete):${NC}"
    echo "$review_stories" | while read s; do
        [ -z "$s" ] && continue
        title=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .title' "$PRD_FILE")
        echo -e "    $s: $title ${RED}[review-agent]${NC}"
    done
    echo ""
fi

if [ "$DRY_RUN" = true ]; then
    info "Dry run complete. No actions taken."
    exit 0
fi

_checklist_heartbeat &
_HEARTBEAT_PID=$!
add_exit_handler _epam_kill_heartbeat

# ──────────────────────────────────────────────
# Initialize monitor status file for HTML dashboard
# ──────────────────────────────────────────────
log "Initializing monitor status file..."

# Build initial stories map from phase
stories_init=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id)) |
      {key: .id, value: {status: (if .completed then "complete" else "pending" end), lane: .agentGroup, role: (.agentRole // ""), title: .title, updatedAt: null}}] |
     from_entries' "$PRD_FILE")

cat > "$MONITOR_STATUS_FILE" << JSONEOF
{
  "startedAt": "$(date -Iseconds)",
  "phase": "$PHASE",
  "orchMode": "$RESOLVED_ORCH_MODE",
  "lanes": {
    "main": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "primary": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0},
    "independent": {"status": "idle", "currentStory": null, "storiesCompleted": 0, "storiesFailed": 0}
  },
  "events": [],
  "stories": $stories_init
}
JSONEOF

info "Monitor file: $MONITOR_STATUS_FILE"
info "Open orchestrations/monitor.html in a browser to watch progress"



step_emit "3" "running" "Step 3: Skill assessment"
log "Step 3: Running pre-phase skill assessment..."
if is_truthy "${SKIP_SKILL_ASSESSMENT:-}"; then
    step_emit "3" "skip" "Step 3: Skill assessment" "SKIP_SKILL_ASSESSMENT=1"
    log "Step 3: Skipped (SKIP_SKILL_ASSESSMENT=1)"
else
    run_pre_phase_assessment "$PHASE"
fi
assert_no_story_ids_lost "presplit" "Step 3: Skill assessment"
assert_no_story_ids_gained "presplit" "Step 3: Skill assessment"
assert_no_illegitimate_deprecation "presplit" "Step 3: Skill assessment"

# ── Mid-execution split validation ────────────────────────────────────────────
# Speckit must review ALL splits, not only those proposed by openspec during
# the spec pass (Step 0). The pre-phase assessment agent (Step 0.5) may write
# new stories directly to the PRD. Validate those before execution begins.
# validate_mid_execution_splits — now in lib/story-guards.sh (sourced above).
validate_mid_execution_splits "$PHASE"


check_ac_invariant "$PHASE"


if [ "$RESOLVED_ORCH_MODE" = "hybrid" ]; then
    log "Step 4: Hybrid mode — running pre-phase coordination..."
    run_hybrid_precoordination "$PHASE"
else
    step_emit "4" "skip" "Step 4: Hybrid pre-coord" "ORCH_MODE=${RESOLVED_ORCH_MODE}"
    info "Step 4: Skipped (ORCH_MODE=${RESOLVED_ORCH_MODE})"
fi

# ──────────────────────────────────────────────
# Step 0.7: Cross-phase regression guard
# Run the project's own test command before any story in this phase executes,
# introduced by the previous phase. Blocks on failure.
# Skip with: SKIP_REGRESSION_GUARD=true
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_REGRESSION_GUARD:-}"; then
    # Brownfield: run tests in the codeline directory, not PROJECT_ROOT.
    # The codeline has its own node_modules with its own test runner.
    _rg_root="$PROJECT_ROOT"
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -n "${JIRA_DEFAULT_CODELINE:-}" ]; then
        _cl_upper=$(echo "$JIRA_DEFAULT_CODELINE" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')
        # NOTE: `${!JIRA_WORKTREE_${_cl_upper}:-}` is NOT valid bash — nested
        # expansion inside an indirect reference is a FATAL "bad substitution" that
        # aborts the script. It sat here as dead code, immediately overwritten by
        # the correct two-step form below, and was only ever reachable when
        # JIRA_DEFAULT_CODELINE is set (no project set it until mock2 did on
        # 2026-07-24). Removed — the two-step form is the correct idiom.
        _wtvar="JIRA_WORKTREE_${_cl_upper}"
        _cl_path="${!_wtvar:-}"
        [ -n "$_cl_path" ] && _rg_root="$_cl_path"
    fi
    # Resolve node AFTER _rg_root is finalized — must be the version the
    # codeline itself declares (engines.node), not whatever version happens
    # to be active in the orchestrator's own shell. See resolve_codeline_node
    # above for why this matters (a Node major-version mismatch crashes
    # the test runner outright rather than reporting a normal test failure).
    _rg_node=$(resolve_codeline_node "$_rg_root" 2>/dev/null || true)
    # How this project runs its tests is the project's answer (see below).
    # HOW THIS PROJECT RUNS ITS TESTS IS THE PROJECT'S ANSWER, NOT OURS.
    #
    # This used to detect a runner by name and invoke `<runner> run`. Live
    # AMSD-2041 run 5: `run` is vitest's "run once" subcommand and a test PATH
    # PATTERN in jest, so jest searched 874 test files for paths matching "run",
    # found none, exited 1 — and the guard reported the client's baseline as
    # broken. A false red on the gate whose entire job is telling us whether the
    # baseline can be trusted, and it would have failed every lane in turn.
    #
    # Now: the project's own `scripts.test`, executed through the package manager
    # its lockfile names. No runner name and no runner-specific flag appears
    # here, so a stack neither of us has seen still works.
    # FROM THE ECOSYSTEM REGISTRY, not from a manifest this file names. It tested package.json and
    # four npm lockfiles, so a Rust, Python or Ruby codeline had _rg_test_declared=0, the condition
    # below never fired, and the cross-phase regression check was SILENTLY SKIPPED — the same free
    # pass codeline-health.sh was giving, and for the same reason. Its own comment two lines up
    # claims no runner name appears here, which was true of the runner and false of the ecosystem.
    _rg_facts="$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$_rg_root" 2>/dev/null || echo '{}')"
    _rg_test_cmd="$(printf '%s' "$_rg_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" testCommand 2>/dev/null || echo "")"
    _rg_pm="$(printf '%s' "$_rg_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" packageManager 2>/dev/null || echo "")"

    # A project that declares no test command has nothing to regress against. That is not a pass —
    # the caller below runs the guard only when there IS something to run, and says so either way.
    _rg_test_declared=0
    [ -n "$_rg_test_cmd" ] && _rg_test_declared=1

    # Kept for ensure_node_modules_healthy's smoke test below, which asks "is
    # node_modules usable" — any installed executable answers that.
    _rg_bin=""
    if [ -d "$_rg_root/node_modules/.bin" ]; then
        _rg_bin="$(find "$_rg_root/node_modules/.bin" -maxdepth 1 -type f -o -maxdepth 1 -type l 2>/dev/null | head -1)"
    fi
    # Brownfield environment prep: node_modules can be present-but-corrupted
    # (a prior interrupted install left truncated native binaries — real
    # incident, 2026-07-22) or missing entirely for a codeline the pipeline
    # hasn't touched before. Smoke-test + repair BEFORE trusting the test
    # runner, so a broken environment reads as a clear repair attempt, not a
    # confusing "tests broken" failure that's actually an environment issue.
    # The repair below is ecosystem-specific by nature: it repairs a vendored install. Gated on
    # the registry saying this ecosystem vendors in-repo, rather than on a manifest name.
    if [ -n "$_rg_node" ] && [ -n "$_rg_vendored" ] && [ "$_rg_vendored" != "null" ]; then
        # CANNOT-VERIFY is a third outcome, and it is never a pass.
        #
        # This was `|| true`. Live metrolinx 2026-07-29: the repair guard reported
        # "REPAIR DESTROYED WHAT IT FOUND ... 1134 entries -> 1011 ... its gates
        # cannot run", ensure_node_modules_healthy returned non-zero to say so,
        # and `|| true` discarded it — the run continued on a wrecked toolchain
        # with 15 processes. A regression guard run against broken dependencies
        # does not report a regression; it reports whatever a broken toolchain
        # emits, which is as likely to be a false PASS as a failure. Same shape
        # as review gates passing on zero files: a verdict with no evidence.
        #
        # The halt rule covers "failed after retries and self-heal". This is the
        # other case — nothing failed, and nothing can be trusted either.
        if ! ensure_node_modules_healthy "$_rg_root" "$_rg_node" "$_rg_bin"; then
            step_emit "5" "fail" "Step 5: Regression guard"
            error "Step 5: codeline CANNOT BE VERIFIED — its dependencies are unusable in $_rg_root"
            error "  This is not a test failure: the tests were never run against a sound tree."
            error "  Reinstall this codeline's dependencies, then re-run."
            error "  Bypass with: SKIP_REGRESSION_GUARD=true (accepts an unverified baseline)"
            exit 1
        fi
        # Re-detect — a first-time install creates node_modules/.bin/* that
        # didn't exist a moment ago. Any entry answers "is node_modules usable".
        _rg_bin=""
        if [ -d "$_rg_root/node_modules/.bin" ]; then
            _rg_bin="$(find "$_rg_root/node_modules/.bin" -maxdepth 1 -type f -o -maxdepth 1 -type l 2>/dev/null | head -1)"
        fi
    fi
    _rg_vendored="$(printf '%s' "$_rg_facts" | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" installDir 2>/dev/null || echo "")"
    # WHY IT IS NOT READY, NOT MERELY THAT IT IS NOT.
    #
    # "declares a test script but it could not be run" names no cause, so diagnosing it means
    # re-deriving four values by hand from outside the run. Each is known here; stating the one
    # that failed turns an afternoon of bisecting into a line of output.
    _rg_ready=1
    _rg_notready=""
    [ "$_rg_test_declared" -eq 1 ] || { _rg_ready=0; _rg_notready="no test command detected"; }
    # Only an ecosystem that vendors in-repo needs its interpreter and its install present before
    # the tests can be trusted. Requiring them of every ecosystem is what skipped the guard.
    if [ -n "$_rg_vendored" ] && [ "$_rg_vendored" != "null" ]; then
      if [ -z "$_rg_node" ]; then
          _rg_ready=0; _rg_notready="no node could be resolved for this codeline"
      elif [ -z "$_rg_bin" ]; then
          _rg_ready=0; _rg_notready="${_rg_vendored}/.bin holds no executable — dependencies not installed"
      fi
    fi
    if [ "$_rg_ready" -eq 1 ]; then
        step_emit "5" "running" "Step 5: Regression guard"
        log "Step 5: Cross-phase regression guard ($_rg_test_cmd) in $_rg_root..."
        _rg_log="$LOG_DIR/regression-guard-${PHASE}.log"
        # ── Retry before calling it a regression ──────────────────────────────
        # The rule this gate enforces is that coding must not INCREASE the
        # failure count — which needs a count that means something twice running.
        # Live AMSD-2041 (2026-07-28), next.gotransit.com at origin/develop with
        # a clean tree and no implementation yet: the suite reported 4 failures,
        # then 1, then 0 across three runs, and the failing test CHANGED between
        # them. In isolation those same files passed 3/3. That is interference
        # under a 737-suite parallel run, not broken code — and blocking on it
        # stops a run for something no one can fix.
        #
        # The WHOLE command is retried rather than re-running the individually
        # named failures: extracting test names means parsing a specific runner's
        # output, and this engine has to work on the next unknown project without
        # being taught its grammar. A green attempt ends the loop immediately, so
        # the common case still costs exactly one run.
        #
        # This is NOT baseline subtraction. Recording pre-existing failures and
        # subtracting them assumes a stable baseline; against a flaky suite it
        # would permanently excuse whichever tests happened to fail at capture
        # time, including a real regression in the same file.
        # HOW MANY WORKERS THIS MACHINE CAN AFFORD, read from the machine at this moment.
        # Unbounded, this suite took 16 workers and 9.7GB, and the resulting timeouts differed
        # between attempts — which is what made RG-DELTA's intersection unstable and hard-failed
        # a run over three failures unrelated to the story.
        _rg_workers="$(resolve_test_workers)"
        log "Step 5: bounding the suite to ${_rg_workers} worker(s) — an unbounded suite starves the host and destabilises its own result"
        _rg_retries="${EPAM_REGRESSION_GUARD_RETRIES:-2}"
        _rg_max=$(( _rg_retries + 1 ))
        _rg_rc=1
        for _rg_try in $(seq 1 "$_rg_max"); do
            # Each attempt keeps its own log — one path overwritten twice leaves
            # only the last attempt, and the first is usually the informative one.
            _rg_try_log="$_rg_log"
            [ "$_rg_try" -gt 1 ] && _rg_try_log="${_rg_log%.log}-attempt-${_rg_try}.log"
            set +e
            # The project's OWN command. Its node is put on PATH first so the script
            # resolves the version the codeline declares, without us naming a runner
            # or guessing its arguments.
            (cd "$_rg_root" && PATH="${_rg_node:+$(dirname "$_rg_node"):}$PATH" run_test_bounded "$_rg_workers" sh -c "$_rg_test_cmd") > "$_rg_try_log" 2>&1
            _rg_rc=$?
            set -e
            [ "$_rg_rc" -eq 0 ] && break
            if [ "$_rg_try" -lt "$_rg_max" ]; then
                warning "Step 5: attempt ${_rg_try}/${_rg_max} failed — re-running to tell a flaky suite from a real regression"
            fi
        done
        # RG-DELTA (backlog item, user requirement 2026-07-30): a fully-red
        # baseline used to be an unconditional hard-fail — live AMSD-2041,
        # 2026-07-31: gotransit had exactly ONE genuinely-failing test on
        # develop itself (unrelated to the story), and the guard blocked the
        # entire run over it. When the project declares testFailurePattern,
        # extract the failing-test IDENTITY from each attempt's log and take
        # the INTERSECTION — only tests failing in EVERY attempt are stable
        # (same bar the flake retry above already uses: "survives every
        # attempt"). A stable set is a trustworthy pre-existing baseline and
        # is tolerated; an UNSTABLE set (attempts disagree on what failed,
        # the exact live gotransit interference shape from 2026-07-28) cannot
        # be trusted and falls through to the existing hard-fail unchanged.
        # No testFailurePattern configured -> today's exact behavior, since
        # every existing project's manifest lacks this field.
        _rg_tolerated=0
        if [ $_rg_rc -ne 0 ]; then
            _rg_pattern=""
            if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
                _rg_pattern=$(jq -r '.testFailurePattern // empty' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null)
            fi
            if [ -n "$_rg_pattern" ]; then
                _rg_baseline_file="$LOG_DIR/regression-guard-baseline-${PHASE}.json"
                _rg_intersect=$(python3 "$SCRIPT_DIR/lib/handlers/rg-intersect.py" "$_rg_pattern" "$_rg_max" "$_rg_log"
)
                if printf '%s' "$_rg_intersect" | python3 "$SCRIPT_DIR/lib/handlers/json-bool.py" stable; then
                    # THE BASELINE MUST REACH DISK BEFORE THE GUARD IS TURNED GREEN.
                    #
                    # This wrote the file unchecked and then set _rg_rc=0 regardless. A failed
                    # write left Step 5 PASSING with pre-existing failures "tolerated" and no
                    # record of what was tolerated — and Step 3.58 compares against exactly that
                    # file. Without it, either every inherited failure is reported as newly
                    # introduced by the phase, or the delta gate cannot verify at all.
                    if printf '%s\n' "$_rg_intersect" > "$_rg_baseline_file"; then
                        _rg_tolerated_count=$(printf '%s' "$_rg_intersect" \
                            | jq -r '(.failures // []) | length' 2>/dev/null || echo 0)
                        _rg_tolerated=1
                        _rg_rc=0
                    else
                        error "Step 5: could not write the tolerated baseline to ${_rg_baseline_file} — refusing to pass the guard on a record that does not exist."
                    fi
                fi
            fi
        fi
        if [ $_rg_rc -ne 0 ]; then
            step_emit "5" "fail" "Step 5: Regression guard"
            error "Step 5: Regression guard FAILED — tests red in all ${_rg_max} attempt(s) before phase '$PHASE' starts"
            # SAY WHAT WAS ACTUALLY OBSERVED, NOT WHAT WOULD BE CONVENIENT TO CONCLUDE.
            #
            # This line used to read, unconditionally: "The failure survived every attempt, so it
            # is reproducible, not a flake." On 2026-09-04 that was FALSE. Every attempt failed,
            # but not on the same tests — attempt 1 failed one suite, attempts 2 and 3 failed two —
            # and it is precisely that disagreement that stopped RG-DELTA tolerating the baseline.
            # The guard had the evidence of instability in its hand and reported the opposite.
            #
            # `_rg_tolerated=0` after a pattern was configured means the intersection was judged
            # UNSTABLE, so the distinction is already computed; it was simply never said.
            if [ -n "${_rg_pattern:-}" ]; then
                error "  Every attempt failed, but they did NOT agree on WHICH tests failed."
                error "  An unstable failing set cannot be told from a real regression, so it is not tolerated."
                error "  Attempts that disagree usually mean interference, not broken code — most often the"
                error "  suite competing with itself for the machine. Compare the attempt logs below."
            else
                error "  The failure survived every attempt."
            fi
            error "  See: $_rg_log"
            for _rg_i in $(seq 2 "$_rg_max"); do
                [ -f "${_rg_log%.log}-attempt-${_rg_i}.log" ] && error "       ${_rg_log%.log}-attempt-${_rg_i}.log"
            done
            # NAME THE MECHANISM THAT WOULD HAVE TOLERATED THIS.
            #
            # Operator policy is that brownfield INHERITS pre-existing failures and is not expected
            # to fix them — and this step implements exactly that, by recording a stable failure
            # set as a tolerated baseline. It only does so when the project declares
            # testFailurePattern. Without it, a codeline carrying inherited failures hard-fails
            # here on EVERY run, and the operator was told to "fix failing tests from the previous
            # phase" — the one thing the policy says they should not have to do — with no hint
            # that the mechanism exists.
            if [ -z "${_rg_pattern:-}" ]; then
                error "  This project declares no testFailurePattern, so pre-existing failures cannot be told apart from new ones and none can be tolerated."
                error "  If these failures are INHERITED, declare testFailurePattern in ${EPAM_PROJECT_CONFIG_DIR:-<project config dir>}/dependency-check.json and they will be recorded as a tolerated baseline instead."
            else
                error "  Fix failing tests from the previous phase before continuing."
            fi
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
        if [ "$_rg_tolerated" = "1" ]; then
            step_emit "5" "pass" "Step 5: Regression guard"
            warning "Step 5: Regression guard — ${_rg_tolerated_count} pre-existing failure(s) tolerated (stable across ${_rg_max} attempts; baseline: $_rg_baseline_file)"
            success "Step 5: Regression guard PASSED — pre-existing failures recorded as a tolerated RG-DELTA baseline"
        else
            if [ "${_rg_try:-1}" -gt 1 ]; then
                warning "Step 5: baseline green on attempt ${_rg_try}/${_rg_max} — the suite is FLAKY; earlier attempts failed"
                warning "  This is the codeline's own instability, not a regression. Worth reporting upstream."
            fi
            step_emit "5" "pass" "Step 5: Regression guard"
            success "Step 5: Regression guard PASSED — baseline tests green"
        fi
    else
        # "This repo has no tests" and "we could not run this repo's tests" are
        # opposite situations, and this branch used to treat them identically —
        # emitting `skip` at info level either way.
        #
        # Live metrolinx 2026-07-28: "Step 5: Regression guard — node/vitest not
        # found" against a real client repository. The gate that catches "the
        # previous phase broke existing tests" did not run, and the run carried
        # on with nothing reading as a problem. That is the fail-open class this
        # pipeline keeps producing — the same shape as a lint gate exiting 2
        # having examined zero files.
        #
        # The repo itself says which case it is: a `test` script, or vitest/jest
        # among its dependencies. No stack knowledge in the engine, no
        # per-project configuration.
        # Not `local`: Step 5 runs at top level, not inside a function.
        # "Declares tests" is the project's own scripts.test — nothing else.
        # An earlier version also looked for two runner names in the dependency
        # lists, which is the same hard-coding that produced the false red above:
        # a project using a third runner would have been judged by a list that
        # never mentioned it.
        if [ "$_rg_test_declared" -eq 1 ]; then
            step_emit "5" "fail" "Step 5: Regression guard" "declares a test script but it could not be run"
            error "Step 5: Regression guard COULD NOT RUN — $_rg_root declares a test script but it could not be executed"
            error "  Reason: ${_rg_notready:-unknown}"
            error "  test command: ${_rg_test_cmd:-<none declared>}   package manager: ${_rg_pm:-<none detected>}   vendored: ${_rg_vendored:-<none>}"
            error "  The baseline is therefore UNVERIFIED: a break introduced by an earlier phase would not be caught."
            error "  This is an environment failure, not an absence of tests — check the codeline's node_modules install."
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi

        step_emit "5" "skip" "Step 5: Regression guard" "repo declares no tests — not applicable"
        info "Step 5: Regression guard not applicable — $_rg_root declares no test script or test runner"
    fi
else
    step_emit "5" "skip" "Step 5: Regression guard" "SKIP_REGRESSION_GUARD=true"
    info "Step 5: Regression guard skipped (SKIP_REGRESSION_GUARD=true)"
fi

# ──────────────────────────────────────────────
# Step 0.8: Ensure standard src/ subdirectories exist so M3 can write into them
# without relying on the model creating the directory first.
# ──────────────────────────────────────────────
step_emit "6" "running" "Step 6: mkdir src/ dirs"
# Only generic scaffolding dirs. A client-named subdirectory here was created in EVERY project
# the engine ran, regardless of what that project is — and `public/` was the same mistake one
# level of generality up: a web-frontend convention, meaningless to a library, a service or a
# Rust crate, and read by nothing in this pipeline. `review/` was engine output being created in
# the customer's tree; it lives under .epam/ now.
#
# src/ stays. WriteFile calls ensureDir on the parent, so an agent using it does not need this —
# but a story whose writer shells out does, and an empty directory git will not even track is a
# cheap way to keep that working.
mkdir -p "$PROJECT_ROOT/src" 2>/dev/null || true
step_emit "6" "pass" "Step 6: mkdir src/ dirs"

# ──────────────────────────────────────────────
# Step 0.9: PRD model coordinator — ensures every pending story (base +
# split children created by the spec pass) has explicit model, aiProvider,
# and reasoningEffort fields written into the PRD itself. Without this,
# split children silently fall back to a provider's hardcoded default model
# (e.g. MiniMax-M2.5 instead of MiniMax-M3) because they inherit no fields
# from their parent story. The PRD, not env vars or provider defaults, is
# the single source of truth for per-story model assignment.
# ──────────────────────────────────────────────
step_emit "7" "running" "Step 7: PRD model coordinator"

_emit_agent start "prd-model-coordinator" "PRD Model Coordinator"
if is_truthy "${SKIP_PRD_MODEL_COORDINATOR:-}"; then
    info "  [prd-model-coordinator] Skipped (SKIP_PRD_MODEL_COORDINATOR=1)"
    _emit_agent complete "prd-model-coordinator" "skipped"
    step_emit "7" "skip" "Step 7: PRD model coordinator" "SKIP_PRD_MODEL_COORDINATOR=1"
else
    _mc_phase="${CURRENT_PHASE:-${PHASE:-unknown}}"
    _mc_prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    _mc_profiles_file="${EPAM_AGENTS_DIR:-${AUTOMATION_DIR}/agents}/profiles.json"

    _mc_missing_count=$(jq -r --arg ph "$_mc_phase" '
        [.stories[] | select((.phase // $ph) == $ph)
          | select(.status == "pending")
          | select((.model // "") == "" or (.aiProvider // "") == "" or (.reasoningEffort // "") == "")
        ] | length
    ' "$_mc_prd_target" 2>/dev/null || echo 0)

    # RUNS WHETHER OR NOT A FIELD WAS MISSING.
    #
    # This sat inside the `else` below — the branch taken only when model/aiProvider/
    # reasoningEffort were ABSENT. So COMPLETE-BUT-WRONG was never checked: a story carrying a
    # model on no declared ladder had all three fields, took the fast path, and the guard written
    # to catch exactly that value was skipped. The operator saw the reassuring line, "All pending
    # stories already have model/aiProvider/reasoningEffort".
    #
    # Live 2026-09-02: AMSD-1919 carried MiniMax-M3 on the claude set and pre-flight refused two
    # launches. A check that only runs when something is ABSENT cannot catch something WRONG.
    # A MODEL ON NO LADDER CANNOT ESCALATE — CAUGHT HERE, NOT NEXT RUN.
    #
    # The coordinator writes its assignment straight into the PRD, and nothing looked at it
    # until the NEXT run's pre-flight, which then refused to start. Live 2026-08-28: mock3's two
    # stories were assigned MiniMax-M3 on a claude stack, EPAM_MODEL_PROVIDER_MAP routed
    # MiniMax-* to the minimax provider, and the writer spent twelve attempts against a model
    # this stack does not declare. The following run would not start at all.
    #
    # The permitted set is the project's own declared ladder — read, never listed. An assignment
    # outside it is corrected to that ladder's opening model and said out loud: the run keeps
    # moving on a model that can actually escalate, and the deviation is visible rather than
    # discovered a run later.
    _mc_enforce_ladder "$_mc_prd_target" "before the coordinator"

    if [ "${_mc_missing_count:-0}" -eq 0 ]; then
        info "  [prd-model-coordinator] All pending stories already have model/aiProvider/reasoningEffort"
    else
        info "  [prd-model-coordinator] ${_mc_missing_count} pending stor(y/ies) missing model assignment — coordinating..."
        _mc_prd_before=$(cat "$_mc_prd_target" 2>/dev/null || echo "{}")
        _mc_corrective_note=""
        _mc_final_outcome="noop"
        _mc_attempt=0

        # Retry-on-violation (2026-07-13): MC_REVIEW_PY below already computes
        # a clean, deterministic pass/fail signal — it just used to only ever
        # revert-and-give-up on 'fail', never tell the model what it did
        # wrong and let it try again. Same "detect, explain, retry" shape as
        # checkSplitMandateViolation's existing precedent in spec-mode-runner.js.
        for _mc_attempt in 1 2 3; do
        _mc_role_file=$(mktemp "${TMPDIR:-/tmp}/mc-role-XXXXXX.txt")
        jq -r '.["prd-model-coordinator"] // ""' "$_mc_profiles_file" > "$_mc_role_file" 2>/dev/null || : > "$_mc_role_file"
        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/prd-model-coordinator-vals-XXXXXX.json")
          # THE STACK'S OWN VOCABULARY, NOT THE PERSONA'S. The persona named MiniMax-M3 and
          # {minimax, openrouter} in prose, so on the claude stack the coordinator wrote a model no claude
          # ladder declares into every story -- no successor, so no escalation, and the NEXT run
          # refused to start (2026-08-28). Read from the resolved set, so a project declaring other
          # models or runners needs no change here.
          _mc_models=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/ladder-models.js" 2>/dev/null || echo "")
          _mc_providers=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/ladder-providers.js" 2>/dev/null || echo "")
          if [ -z "$_mc_models" ] || [ "$_mc_models" = "[]" ] || [ -z "$_mc_providers" ] || [ "$_mc_providers" = "[]" ]; then
              # Refuse rather than render an empty vocabulary: an unconstrained coordinator invents
              # names this stack cannot route, which is the defect this replaced.
              error "[prd-model-coordinator] the resolved provider set declares no models or no providers -- refusing to run it."
          fi
          jq_vals \
                --rawfile profile "$_mc_role_file" \
                --arg mc_prd_target "$_mc_prd_target" \
                --arg mc_phase "$_mc_phase" \
                --arg mc_models "$_mc_models" \
                --arg mc_providers "$_mc_providers" \
                '{"__PROFILE__":$profile,"__MC_PRD_TARGET__":$mc_prd_target,"__MC_PHASE__":$mc_phase,"__MC_PERMITTED_MODELS__":$mc_models,"__MC_PERMITTED_PROVIDERS__":$mc_providers}' > "$_cp_vals"
        _mc_prompt="$(render_engine_prompt prd-model-coordinator "$_cp_vals")"
        rm -f "$_cp_vals"
        rm -f "$_mc_role_file"
        if [ -n "$_mc_corrective_note" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/corrective-note-vals-XXXXXX.json")
            jq_vals \
                  --arg mc_corrective_note "${_mc_corrective_note}" \
                  --arg mc_prompt "${_mc_prompt}" \
                  '{"__MC_CORRECTIVE_NOTE__":$mc_corrective_note,"__MC_PROMPT__":$mc_prompt}' > "$_cp_vals"
            _mc_prompt="$(render_engine_prompt corrective-note "$_cp_vals" model_coordinator)"
            rm -f "$_cp_vals"
        fi
        # THE SEAM, ASKED FOR. This call resolved to no profile at all — the registry had none —
        # so a step that EDITS THE PRD every later stage reads ran with no ladder, no budget, and
        # a tool grant of AI_GATE_ALLOW_TOOLS=1 with no list. The seam declares all of it now.
        #
        # NO VENDOR LITERALS. The provider and model fell back to minimax / MiniMax-M3 written
        # here, which is the shape the ladder work removed everywhere else under the rule that a
        # seam with no resolvable model must decline rather than guess.
        # NOT SWALLOWED. I wrote this as 2>/dev/null || echo "" while fixing the defects above,
        # which is the same silence: a seam that fails to resolve would leave the call running on
        # ambient settings and looking as though it had asked. The handler says WHY on stderr.
        _mc_seam_err="$(mktemp "${TMPDIR:-/tmp}/mc-seam-err-XXXXXX")"
        _mc_seam="$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/seam-env-args.js" prd-model-coordinator "$AUTOMATION_DIR/agents" 2>"$_mc_seam_err")" || {
            warning "  [prd-model-coordinator] seam did not resolve — running on ambient settings: $(tail -c 200 "$_mc_seam_err" | tr '\n' ' ')"
            _mc_seam=""
        }
        rm -f "$_mc_seam_err"
        _mc_cost="${TMPDIR:-/tmp}/prd-model-coordinator-cost-$.json"
        _mc_result=$(echo "$_mc_prompt" | \
            env $_mc_seam \
            EPAM_AGENT_NAME=prd-model-coordinator \
            ORCH_JSON_RESULT="$_mc_cost" \
            AI_GATE_ALLOW_TOOLS=1 \
            ${ORCH_GATE_PROVIDER:+AI_PROVIDER="$ORCH_GATE_PROVIDER"} \
            ${EPAM_MODEL:+AI_MODEL="$EPAM_MODEL"} \
            EPAM_DANGEROUS_SKIP_APPROVAL=1 \
            EPAM_MAX_TOOL_CALLS="${PRD_MODEL_COORDINATOR_MAX_TOOL_CALLS:-12}" \
            CLAUDE_CMD="$CLAUDE_CMD" \
            EPAM_CLI="${EPAM_CLI:-epam}" \
            "$AI_RUNNER_CMD" \
                ${ORCH_GATE_PROVIDER:+--provider "$ORCH_GATE_PROVIDER"} \
                ${EPAM_MODEL:+--model "$EPAM_MODEL"} \
            2>&1 | tee -a "$LOG_DIR/prd-model-coordinator-${_mc_phase}.log")
        # PIPESTATUS[0], not the pipeline status: without pipefail this is tee's, always 0, so a
        # failed coordinator read as a success and every story kept whatever model it had.
        _mc_rc="${PIPESTATUS[0]}"
        # Every line here forwards a value to the child process, and each expansion deliberately reads
        # the OUTER value — which IS the value being forwarded. shellcheck is right about the shape and
        # wrong about the intent; rewriting it risks silently dropping a credential the child needs.
        # shellcheck disable=SC2097,SC2098
        ACTIVITY_FILE="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" LOG_DIR="$LOG_DIR" \
          "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/emit-cost.js" "$_mc_cost" prd-model-coordinator 2>/dev/null || true
        rm -f "$_mc_cost" 2>/dev/null || true
        if [ "${_mc_rc:-1}" != "0" ]; then
            warning "  [prd-model-coordinator] the call failed (exit ${_mc_rc}) — stories keep their existing assignment"
        fi

        _mc_assigned_count=$(echo "$_mc_result" | python3 "$SCRIPT_DIR/lib/handlers/mc-assigned-count.py" 2>/dev/null || echo 0)


        _mc_prd_after=$(cat "$_mc_prd_target" 2>/dev/null || echo "{}")
        # Gate on whether the PRD FILE actually changed, not the agent's own
        # self-reported assigned_count. Root cause of a live-run defect
        # (2026-07-03): the agent has tool access (AI_GATE_ALLOW_TOOLS=1) and
        # can write the PRD directly via WriteFile regardless of what its own
        # JSON summary claims. It silently split SKY-001 into SKY-001-A/B
        # while reporting "no assignments made" (assigned_count absent/0) —
        # so the old assigned_count-gated check never even looked at the
        # file, and the rogue split was never reviewed or reverted.
        if [ "${_mc_assigned_count:-0}" -gt 0 ] || [ "$_mc_prd_before" != "$_mc_prd_after" ]; then
            # Deterministic reviewer gate. This USED to ask an LLM to judge a
            # BEFORE/AFTER excerpt truncated to the LAST 1000 CHARACTERS of
            # the PRD — for any real multi-KB PRD, that is structurally
            # blind to a change anywhere earlier in the file. Root cause of a
            # live-run defect (2026-07-08/09): the coordinator silently
            # stripped technicalNotes.files from SKY-002/003/004 — nowhere
            # near the tail of the file — while the excerpt-based reviewer
            # saw nothing wrong and approved it; a later remediation step
            # then dropped those now-fileless stories from
            # implementationOrder.core, and the core phase silently ran as a
            # no-op with zero error.
            #
            # "A model-assignment write may only change model, aiProvider,
            # and reasoningEffort, on stories that were actually missing
            # them" is a 100% mechanically checkable invariant, not a
            # judgment call — so check it in code instead of asking an LLM to
            # eyeball a truncated excerpt. No blind spot, no token cost, no
            # chance of an LLM missing it. Enlarging the excerpt window would
            # only move the blind spot, never eliminate it.
            _mc_before_file=$(mktemp)
            _mc_after_file=$(mktemp)
            _mc_verdict_stderr=$(mktemp)
            printf '%s' "$_mc_prd_before" > "$_mc_before_file"
            printf '%s' "$_mc_prd_after" > "$_mc_after_file"
            _mc_verdict=$(python3 "$SCRIPT_DIR/lib/handlers/mc-review.py" "$_mc_before_file" "$_mc_after_file" \
                "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}}" \
                2>"$_mc_verdict_stderr"
)
            rm -f "$_mc_before_file" "$_mc_after_file"
            if [ "$_mc_verdict" = "fail" ]; then
                warning "  [prd-model-coordinator] Attempt ${_mc_attempt}/3 REJECTED by reviewer — reverting PRD"
                echo "$_mc_prd_before" > "$_mc_prd_target" 2>/dev/null || true
                _mc_corrective_note=$(tr '\n' ' ' < "$_mc_verdict_stderr")
                _mc_final_outcome="reverted"
                rm -f "$_mc_verdict_stderr"
                continue
            else
                success "  [prd-model-coordinator] ${_mc_assigned_count} stor(y/ies) assigned model/aiProvider/reasoningEffort (reviewer approved)"
                _mc_final_outcome="pass"
                rm -f "$_mc_verdict_stderr"
                break
            fi
        else
            _mc_no_assignment_verdict "${_mc_rc:-0}"
            break
        fi
        done

        _mc_violation_types="[]"
        if [ -n "$_mc_corrective_note" ]; then
            _mc_violation_types=$(printf '%s' "$_mc_corrective_note" | python3 "$SCRIPT_DIR/lib/handlers/mc-violation-types.py" 2>/dev/null || echo "[]")
        fi

        _log_guarded_step_retry "$(jq -n -c \
            --arg step "0.9" \
            --arg phase "$_mc_phase" \
            --argjson attempts "$_mc_attempt" \
            --arg outcome "$_mc_final_outcome" \
            --arg reason "$_mc_corrective_note" \
            --argjson violationTypes "$_mc_violation_types" \
            '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, reason: $reason, violationTypes: $violationTypes}' \
            2>/dev/null)"
    fi

    # Post-condition safety net: any pending story STILL missing a field after
    # the coordinator (agent unavailable, rejected, or skipped a story) falls
    # back to a fixed default so the pipeline never silently relies on a
    # provider's own hardcoded default model.
    ( flock -w 10 200 || { error "  [prd-model-coordinator] Could not acquire lock on $_mc_prd_target"; exit 1; }
    python3 "$SCRIPT_DIR/lib/handlers/mc-fallback.py" "$_mc_prd_target" "$_mc_phase"
    ) 200>"${_mc_prd_target}.lock"
fi
# AFTER EVERY WRITER ON THIS STEP, WHICHEVER RAN.
#
# The check above runs before the coordinator, and its selector `(.model // "") != ""` cannot see a
# story that has no model YET — which is precisely the story the coordinator is about to assign.
# Three writers land between there and here: the coordinator itself, its corrective-note retries,
# and mc-fallback.py's post-condition default. None of them was checked against the ladder.
#
# Deliberately OUTSIDE the if/else, so it also covers SKIP_PRD_MODEL_COORDINATOR=1: a set that
# skips the coordinator can still carry an off-ladder model written by an earlier run, and that
# set — the claude one — is where the failure was actually paid for.
_mc_enforce_ladder "${MAIN_PRD_FILE:-$PRD_FILE}" "after the coordinator"
_emit_agent complete "prd-model-coordinator" "PRD model assignments done"
step_emit "7" "pass" "Step 7: PRD model coordinator"
assert_no_story_ids_lost "presplit" "Step 7: PRD model coordinator"
assert_no_story_ids_gained "presplit" "Step 7: PRD model coordinator"
assert_no_illegitimate_deprecation "presplit" "Step 7: PRD model coordinator"

# ──────────────────────────────────────────────
# Step 1: Run main-branch stories (no dependencies, sequential)
# ──────────────────────────────────────────────
# Root cause fix (found live, 2026-07-11, tier3-travel-app run): main_stories
# is a snapshot captured once at phase start (~line 1670), before Step 0.5's
# mid-execution-split validation can run (validate_mid_execution_splits,
# first call ~line 2198). That validation can legitimately RESTORE a parent
# story that was deprecated-via-split at snapshot time (see spec-mode-
# runner.js's coherence-violation parent-restoration) — the restored parent
# is real, pending work, but the stale snapshot never re-included it, so it
# silently never ran even though the PRD said it should. Live symptom:
# SKY-001's 4 split children collided and were deprecated, SKY-001 itself
# was correctly restored to pending in the PRD, but Step 1 only logged
# skipping the 4 dead children and declared "Main-branch stories complete"
# having run nothing — the scaffold phase never wrote a single file.
#
# Extended (same day, second live occurrence): a restored parent can carry
# agentGroup=primary or independent (its original, pre-split group) — the
# first version of this fix only refreshed the main/preflight lane, so
# SKY-002/SKY-003 (agentGroup=primary) fell into a complete gap when
# topology had already collapsed the primary lane into main_stories BEFORE
# the restoration happened (topology="sequential", 11 stories): Step 2
# (worktree creation) had already decided "no parallel stories" from the
# pre-restoration snapshot and never reconsiders, so the restored stories
# sat "pending" forever with literally no code path that would ever execute
# them this phase. Route each newly-eligible story to whichever lane is
# STILL doing work for its own agentGroup (primary_stories/
# independent_stories, if non-empty — Step 2 hasn't run yet at this point in
# the pipeline and will see the update); fall back to main_stories when that
# lane is empty (already collapsed, or never had work) since main_stories is
# the only lane guaranteed to still process further pending work this phase.
_main_stories_current=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     select(.status != "deprecated") |
     select((.completed // false) == false) |
     select(.agentRole != "review-agent") |
     select((.agentGroup // "main") as $g | $g == "main" or $g == "preflight" or $g == "primary" or $g == "independent") |
     [.id, (.agentGroup // "main")] | @tsv' \
    "$PRD_FILE" 2>/dev/null || echo "")
if [ -n "$_main_stories_current" ]; then
    while IFS=$'\t' read -r _rid _rgroup; do
        [ -z "$_rid" ] && continue
        if grep -qxF "$_rid" <<< "$main_stories" \
            || { [ -n "$primary_stories" ] && grep -qxF "$_rid" <<< "$primary_stories"; } \
            || { [ -n "$independent_stories" ] && grep -qxF "$_rid" <<< "$independent_stories"; }; then
            continue
        fi
        _dest="main"
        case "$_rgroup" in
            primary)     [ -n "$primary_stories" ] && _dest="primary" ;;
            independent) [ -n "$independent_stories" ] && _dest="independent" ;;
        esac
        warning "  Story $_rid is newly pending for phase '$PHASE' (likely restored after a rejected split) — adding to the ${_dest} lane"
        case "$_dest" in
            primary)     primary_stories="${primary_stories}
${_rid}" ;;
            independent) independent_stories="${independent_stories}
${_rid}" ;;
            *)           main_stories="${main_stories}
${_rid}" ;;
        esac
    done <<< "$_main_stories_current"
    main_stories=$(topo_sort_stories "$main_stories")
    [ -n "$primary_stories" ] && primary_stories=$(topo_sort_stories "$primary_stories")
    [ -n "$independent_stories" ] && independent_stories=$(topo_sort_stories "$independent_stories")
fi

if [ -n "$main_stories" ]; then
    # Filter out review stories (those run at the end)
    non_review_main=$(echo "$main_stories" | while read s; do
        [ -z "$s" ] && continue
        role=$(jq -r --arg id "$s" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE")
        if [ "$role" != "review-agent" ]; then
            echo "$s"
        fi
    done)

    # Per-story TypeScript compile gate — story_tsc_gate, now in
    # lib/story-guards.sh (sourced above) so every lane runs the identical
    # gate.

    if [ -n "$non_review_main" ]; then
        _ckpt_total=$(jq '[.stories[] | select(.status != "deprecated")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
        _ckpt_done=$(jq '[.stories[] | select(.status == "completed")] | length' "$PRD_FILE" 2>/dev/null || echo 0)
        if [ "${_ckpt_total:-0}" -gt 0 ] && [ "${_ckpt_done:-0}" -ge "${_ckpt_total:-0}" ]; then
            info "[CHECKPOINT] All $_ckpt_total stories already completed — skipping Step 1 for phase '${PHASE:-main}'"
            step_emit "8" "pass" "Step 8: Main-branch stories (all checkpointed)"
        else
        # ── Gate: the specification review must have cleared these stories ───
        # The reviewer runs with filesystem access and checks each manifest against the
        # repository. Live 2026-08-04 it returned needs_review on all three lanes — two of
        # which had a manifest naming a file that does not exist — and the pipeline went
        # straight to implementation, because the only verdict the code branched on was
        # 'fail' and the schema never emits it. Enforced here, before the writer spends
        # anything. SPEC_REVIEW_ENFORCE=0 overrides deliberately.
        if ! spec_review_gate "$PRD_FILE"; then
            error "[orch] Halting phase '${PHASE}' before implementation — the spec review did not clear."
            exit 1
        fi

        # ── Checkpoint / pause: PRE-WRITER ───────────────────────────────────
        # Everything the writer consumes is settled by now — the spec pass, the CPA
        # pre-pass, the skill assessment and the detective have all run and written
        # their output into the PRD. This is the last point at which those inputs can
        # be inspected before any code is generated. Saved unconditionally: an artefact
        # that exists only in memory is a project violation.
        if _ckpt_path=$(save_run_checkpoint "$PHASE" pre-writer 2>&1); then
            info "[orch] pre-writer checkpoint saved: ${_ckpt_path}"
        else
            warning "[orch] could not save the pre-writer checkpoint: ${_ckpt_path}"
        fi
        if should_pause_before_writer; then
            echo ""
            echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
            echo -e "${GREEN}║  PAUSED — inputs ready, writer NOT started                         ║${NC}"
            echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "  RUN NUMBER:  ${GREEN}${ORCH_RUN_ID}${NC}"
            echo -e "  Phase:       ${PHASE}"
            echo -e "  Stories:     $(printf '%s\n' "$non_review_main" | awk 'NF{n++} END{print n+0}') queued for the writer"
            echo -e "  Artefacts:   ${_ckpt_path:-<not saved>}"
            echo ""
            echo -e "  Resume implementation with:"
            echo -e "    ${GREEN}EPAM_RESUME_RUN=${ORCH_RUN_ID}${NC} <your launcher>"
            echo ""
            step_emit "8" "skip" "Step 8: Main-branch stories" "paused before the writer (EPAM_PAUSE_BEFORE_WRITER)"
            record_run_pause pre-writer
            exit 0
        fi

        step_emit "8" "running" "Step 8: Main-branch stories"
    log "Step 8: Running main-branch stories..."
        # Capture baseline SHA before any story commits so the testing-gates
        # git diff oracle can diff the full run's changes (not just HEAD~1).
        # THE ONE WRITER, and the value every diff-based gate reads: review-ranger,
        # mutant-hunter, fuzz-weaver, sast-sentinel and the committed-change helper check.
        #
        # --verify --quiet, for the same reason the branch resolution above uses it: a bare
        # rev-parse ECHOES an unresolvable ref to stdout and exits 128, so the file would hold a
        # ref name rather than a commit and every gate would diff against nothing.
        #
        # An unwritable baseline is LOUD. It used to end in `|| true`, so a repository the run
        # could not read produced no file and every gate silently compared against nothing —
        # which reads as "this story changed no files", the shape of a false pass.
        if [ -d "$PROJECT_ROOT/.git" ]; then
            # THE DIVERGENCE POINT, not whatever HEAD happens to be right now. `rev-parse HEAD`
            # ran BEFORE the story loop, and ensure_story_branch (a few lines below) hard-resets
            # the story branch onto origin/<baseline> — orphaning the commit just recorded. The
            # two agree on a first run and disagree on every resume, where this recorded the
            # PREVIOUS leg's tip and every diff-based gate then read it.
            #
            # Live 2026-09-09, second resume of run 20260908T215555Z: runtime-boundary reported
            # the change was "confined to a Jest/RTL spec file" because its diff was taken from an
            # orphan, and mutant-hunter proposed 0 mutations from the same baseline and scored
            # 100% against them.
            # PROVISIONAL. ensure_story_branch has not run yet, so this is the fork point of
            # whatever branch is checked out NOW. It is refreshed immediately after the first
            # reset below; it stands only for a phase where no story branch is created (no
            # remote, greenfield, ensure_story_branch declining), which would otherwise leave
            # every diff-based gate with no baseline at all.
            _phase_baseline="$(qa_phase_baseline_sha "$PROJECT_ROOT" "${JIRA_BASELINE_BRANCH:-}" 2>/dev/null || echo "")"
            if [ -n "$_phase_baseline" ]; then
                echo "$_phase_baseline" > "$LOG_DIR/phase-baseline-sha.txt"
            else
                warning "[orch] could not resolve a baseline commit in $PROJECT_ROOT — every diff-based gate will compare against nothing"
            fi
        fi
        # _run_one_main_story: single-story execution body shared between the
        # main loop (fixed snapshot) and the tail-sweep pass (split children).
        # All required variables (PRD_FILE, PHASE, LOG_DIR, SCRIPT_DIR,
        # _phase_story_failures, ORCH_RUN_ID) are script-level so the function
        # reads/writes them directly without needing explicit arguments.
        _run_one_main_story() {
            local story="$1"
            # Root cause fix (found live, 2026-07-10, tier3-travel-app run):
            # non_review_main/main_stories is a SNAPSHOT captured once at
            # phase start (~line 1512-1555, before Step 0.5 and before this
            # loop even begins). validate_mid_execution_splits() runs AFTER
            # Step 0.5 and again after every story completes in this same
            # loop (line ~2535 below) — it can reject a same-file coherence
            # violation and mark a story deprecated that was ALREADY enqueued
            # in this stale snapshot before the violation was ever detected.
            # The earlier fix (main_stories query filters .status !=
            # "deprecated") only protects against a story that was ALREADY
            # deprecated before the snapshot was taken; it can't see a
            # deprecation that happens mid-phase, after the snapshot. Live
            # symptom: SKY-002-impl/-impl-1 both wrote client.ts, got
            # rejected and deprecated by the mid-execution split-gate right
            # after Step 0.5 — yet Step 1 still ran "Implementing story:
            # SKY-002-impl" moments later, burning real cost on a story that
            # had already been correctly abandoned. Re-check the CURRENT
            # status live, right before running each story, instead of
            # trusting the stale start-of-phase snapshot.
            local _story_current_status
            _story_current_status=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .status // "pending"' \
                "$PRD_FILE" 2>/dev/null || echo "pending")
            if [ "$_story_current_status" = "deprecated" ]; then
                info "  Skipping $story — deprecated after being enqueued (mid-execution split rejected this story)"
                return 0
            fi
            # "blocked" — set by the inline TC-writer retry gate below when 3
            # attempts still produce no valid testCriteria for this story. A
            # story blocked on an EARLIER iteration (or a prior run) must
            # never be picked up here — same live-status re-check pattern as
            # the deprecated-skip above, since implementation without real
            # grounding is worse than not running at all.
            if [ "$_story_current_status" = "blocked" ]; then
                info "  Skipping $story — blocked (no valid testCriteria after 3 attempts, see blocked-stories.jsonl)"
                return 0
            fi
            if [ "$_story_current_status" = "completed" ]; then
                info "  [CHECKPOINT] Skipping $story — already completed in prd.json"
                return 0
            fi
            if checkpoint_already_done "$story"; then
                info "  Skipping $story — already completed in checkpoint (run: $ORCH_RUN_ID)"
                return 0
            fi
            check_cost_budget
            wait_if_paused
            apply_redirect_if_any "$story"

            # Inline TC writer gate — single shared implementation (see
            # lib/tc-writer-gate.sh docstring for the full history/rationale;
            # this used to be duplicated inline here and was the reason
            # worktree lanes never got the same check). Runs right before a
            # pure-test story that still has zero testCriteria.facts
            # executes, so its paired impl story (which just ran earlier in
            # this same loop) grounds it. Returns 1 (BLOCKING this story,
            # not aborting the phase) if no valid testCriteria after 3
            # attempts.
            if ! run_inline_tc_writer_gate "$story" "$PHASE"; then
                return 0
            fi

            # Brownfield: this story commits to its own dedicated branch, not
            # directly onto the shared baseline branch. See ensure_story_branch
            # above for why (eliminates the stale-marker/reset-to-orphaned-
            # commit failure class entirely, rather than working around it).
            # `|| true` — a failed branch creation (e.g. no network, no origin
            # remote) must never abort the whole phase; the story just
            # proceeds on whatever branch is already checked out.
            ensure_story_branch "${PROJECT_ROOT:-}" "$story" "${JIRA_BASELINE_BRANCH:-}" || true

            # THE BASELINE IS ONLY TRUE ONCE THE BRANCH IT DESCRIBES EXISTS.
            #
            # The capture above runs before the story loop; ensure_story_branch (the line above)
            # then rebases this story onto origin/<baseline>. Anything a colleague merged upstream
            # in that window lands inside the recorded range and is attributed to THIS story by
            # every diff-based gate.
            #
            # Live 2026-09-09, run 20260908T215555Z: PR #5669 merged that morning, the baseline was
            # recorded one commit behind the branch's real fork point, and the gates were shown
            # three files of that colleague's work. plan-fidelity duly reported "the change went
            # outside the plan of record" — a finding about someone else's commit.
            #
            # Re-derived here, after the reset, and only for the FIRST story: the baseline is a
            # property of the phase, and every story in it branches from the same base.
            if [ -z "${_phase_baseline_after_reset:-}" ] && [ -d "$PROJECT_ROOT/.git" ]; then
                _phase_baseline_after_reset=1
                _pb_now="$(qa_phase_baseline_sha "$PROJECT_ROOT" "${JIRA_BASELINE_BRANCH:-}" 2>/dev/null || echo "")"
                if [ -n "$_pb_now" ] && [ "$_pb_now" != "${_phase_baseline:-}" ]; then
                    info "[orch] phase baseline re-derived after the story branch was based: ${_phase_baseline:-<none>} -> $_pb_now"
                    _phase_baseline="$_pb_now"
                    echo "$_phase_baseline" > "$LOG_DIR/phase-baseline-sha.txt"
                fi
            fi

            log "  Running: $story"
            local _story_monitor_role _story_model_hint _story_provider_hint
            # NO ROLE NAME AS A FALLBACK. This defaulted to typescript-engineer — one of
            # epam-cli's OWN roles, from its project-roles.json — so a client story with no
            # agentRole was displayed under a role that project never minted. The monitor showing
            # 'unassigned' is the true answer, and it is the one worth seeing.
            _story_monitor_role=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .agentRole // "unassigned"' \
                "$PRD_FILE" 2>/dev/null || echo "unassigned")
            _story_model_hint=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .model // ""' \
                "$PRD_FILE" 2>/dev/null || echo "")
            _story_provider_hint=$(jq -r --arg id "$story" \
                '.stories[] | select(.id == $id) | .provider // ""' \
                "$PRD_FILE" 2>/dev/null || echo "")
            # Export model/provider so claude.sh subprocess has them for its own
            # update_monitor_status calls (story_complete, error events, etc.).
            # ORCH_STORY_START_EMITTED suppresses claude.sh's redundant story_start
            # since we already emitted one here with the correct model.
            export STORY_MODEL="$_story_model_hint"
            export STORY_PROVIDER="$_story_provider_hint"
            export ORCH_STORY_START_EMITTED=1
            "$SCRIPT_DIR/update-monitor.sh" story_start "$story" "main" "$_story_monitor_role" "" \
                "$_story_provider_hint" "$_story_model_hint" 2>/dev/null || true
            local _story_exit=0
            run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log" || _story_exit=$?
            export ORCH_STORY_START_EMITTED=0
            # A genuine watchdog double-timeout gets ONE diagnose-then-restructure
            # recovery attempt before counting as a phase failure -- see
            # run_story_recovery_analyst's docstring for why this is scoped to
            # watchdog timeouts only (not every kind of story failure).
            if [ "$_story_exit" -ne 0 ]; then
                if run_story_recovery_analyst "$story" "$LOG_DIR/main-${story}.log"; then
                    _story_exit=0
                fi
            fi
            record_story_actual_cost "$story" "$LOG_DIR/main-${story}.log"
            if [ "$_story_exit" -ne 0 ]; then
                _phase_story_failures=$((_phase_story_failures+1))
                _phase_failed_stories="${_phase_failed_stories:-} $story"
                "$SCRIPT_DIR/update-monitor.sh" story_fail "$story" "main" "exit $_story_exit" 2>/dev/null || true
            else
                # Story reported success — verify TypeScript still compiles before moving on
                story_tsc_gate "$story" || { _phase_story_failures=$((_phase_story_failures+1)); _phase_failed_stories="${_phase_failed_stories:-} $story"; }
                "$SCRIPT_DIR/update-monitor.sh" story_complete "$story" "main" "" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
            fi
            checkpoint_complete "$story"
            # Validate any splits the agent registered mid-execution before the next story runs
            validate_mid_execution_splits "$PHASE"
        }
        _phase_story_failures=0
        _phase_failed_stories=""
        while IFS= read -r story; do
            [ -z "$story" ] && continue
            _run_one_main_story "$story"
        done <<< "$non_review_main"
        # ── Tail sweep: pick up TC-density split children ─────────────────────
        # When run_inline_tc_writer_gate splits the LAST story in non_review_main
        # (facts exceed EPAM_TC_FACTS_SPLIT_THRESHOLD), the resulting children
        # are written to implementationOrder[$PHASE] in prd.json AFTER the
        # fixed-snapshot iterator is exhausted — they would otherwise be silently
        # dropped and never executed in the same phase pass.
        # Re-read prd.json for any pending stories not present in the original
        # snapshot and run them through the same per-story logic.
        _tail_sweep_candidates=$(jq -r --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories[] |
             select(
               (.id as $id | $ids | index($id) != null) and
               .status != "deprecated" and
               .status != "completed" and
               .status != "blocked"
             ) | .id' \
            "$PRD_FILE" 2>/dev/null || true)
        _tail_sweep_new=""
        while IFS= read -r _ts; do
            [ -z "$_ts" ] && continue
            case $'\n'"$non_review_main"$'\n' in
                *$'\n'"$_ts"$'\n'*) ;; # already in original snapshot
                *) _tail_sweep_new="${_tail_sweep_new}${_ts}"$'\n' ;;
            esac
        done <<< "$_tail_sweep_candidates"
        if [ -n "$_tail_sweep_new" ]; then
            log "  [tail-sweep] Picking up $(printf '%s' "$_tail_sweep_new" | grep -c .) split children: $(printf '%s' "$_tail_sweep_new" | tr '\n' ' ')"
            while IFS= read -r story; do
                [ -z "$story" ] && continue
                _run_one_main_story "$story"
            done <<< "$_tail_sweep_new"
        fi
        if [ "$_phase_story_failures" -gt 0 ]; then
            step_emit "8" "fail" "Step 8: Main-branch stories"
            error "Phase '$PHASE': $_phase_story_failures story/stories failed — aborting phase"
            # WHY it failed, not just that it did. Aborting is correct — the mandate is let
            # recovery run, then halt — but a bare count cannot distinguish "the ladder is spent"
            # from "a gate returned a verdict on attempt 2 of 12". Live metrolinx 2026-08-19 was
            # the latter and was reported as the former, which is what stopped a converging run.
            for _psf in $_phase_failed_stories; do
                [ -n "$_psf" ] || continue
                _halt_recovery_state "$_psf"
            done
            exit 1
        fi
        step_emit "8" "pass" "Step 8: Main-branch stories"
        success "Main-branch stories complete"
        fi  # end checkpoint else
    fi
else
    step_emit "8" "skip" "Step 8: Main-branch stories" "no stories in lane"
    info "Step 8: No main-branch stories to run"
fi

# ──────────────────────────────────────────────
# Step 1.5: Auto-commit main-branch story output.
# Real agents may commit via git tools, but mock/epam-run agents only write files,
# and `_run_one_main_story` itself never commits (only the worktree-lane loop in
# claude.sh calls commit_completed_story()). Without this, a main-branch story's
# real output — including a brownfield fix's test file — never lands in git.
#
# Live bug (2026-07-22): this fired whenever there were worktree-bound
# stories AND the tree was dirty — with NO check that Step 8 actually ran
# any main-branch stories. A parallel-only run (all stories routed to
# worktrees, zero in the main lane — "no stories in lane" logged) still has
# a dirty tree from incidental pipeline writes (CodeGraph indexing,
# dependency-check manifests), which is NOT genuine story output. That fix
# gated on `$main_stories` also being non-empty, but LEFT the worktree-
# existence check in place as an ADDITIONAL required condition — which
# introduced a second, opposite bug: a phase with ONLY main-branch stories
# and ZERO worktree lanes (e.g. writer-retest.sh's single-story PRD) never
# gets committed AT ALL, no matter how real Step 8's output is. `implement_story`
# marks the story `completed:true` in the PRD regardless, so nothing downstream
# ever notices the missing commit — until the brownfield repro-gate (which
# diffs committed HEAD, never the working tree) permanently blocks with
# "no test file accompanies the change", because nothing was ever committed
# for it to see. Found live 2026-08-02 (AMSD-2041 Writer Retest: 3 codelines,
# all agentGroup=main, zero worktree lanes — every retry re-implemented the
# same fix, never landed it, forever).
#
# Fix: the worktree-existence check was never actually about whether Step 8
# needs a commit — drop it. Gate on `$main_stories` non-empty (Step 8's own
# condition, line ~4062) and a dirty tree; that's the complete, correct
# signal regardless of whether any worktree lane also exists this phase.
# When $main_stories WAS non-empty, the tree is already on the last story's
# ensure_story_branch branch (set inside the Step 8 loop above), so this
# commit correctly lands there too — no additional branch logic needed here.
if [ -n "${main_stories:-}" ] && \
   [ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]; then
    step_emit "9" "running" "Step 9: Auto-commit"
    log "Step 9: Auto-committing main-branch deliverables before worktree creation..."
    # Was a bare `git add -A`. lib/git-ops.sh had carried the engine-artefact exclusions
    # since 2026-08-01 — this site never received them, so Step 9 staged
    # orchestrations/agents/KB.md and .epam/* into the client repo (live 20260804T225443Z,
    # where it also tripped SECRET_SCAN and blocked the commit on two lanes).
    git_add_client_outputs "$PROJECT_ROOT" || true
    # THE COMMIT-TIME CREDENTIAL SCAN WAS REMOVED HERE (operator decision, 2026-08-09).
    #
    # It matched the SHAPE `credential_name: value` without inspecting `value`, so it refused a
    # commit for
    #
    #     management_token: SOME_SERVICE_API_TOKEN,
    #
    # an environment-derived identifier — the exact pattern its own error message recommends.
    # (Client identifiers and ticket ids are kept out of engine source, comments included: they
    # date the engine to one customer, and a generic prompt built from them is wrong for the
    # next one.)
    # The story is about wiring a preview token, so it would have blocked every commit the
    # work produced, and it had never caught a real leak. Worse, refusing here also unstaged
    # the writer's changes while the story was still reported "Implemented: 1, Failed: 0".
    #
    # The check moves to the review stage, where the reviewer has the diff and can be given a
    # tool that distinguishes a literal from an identifier. scan-secrets.sh is kept for that
    # tool to build on; it is no longer a commit gate. The other call site
    # (lib/git-ops.sh) was already default-skipped via SKIP_SECRET_SCAN.
    if false; then :
    else
        # Ticket-ID-first message — same commitlint-compatibility fix as
        # commit_completed_story()'s 2026-08-02 fix (lib/git-ops.sh) and
        # brownfield-repro-test-writer.sh's identical issue found the same
        # day. Leads with the first main-branch story's ID (usually the
        # only one) rather than a bare "chore:" prefix, which a client
        # repo's commitlint (e.g. commitlint-plugin-jira-rules) can reject
        # outright for having no ticket ID as the first token.
        _step9_commit_lead="$(printf '%s\n' "$main_stories" | head -1)"
        _step9_commit_msg="${_step9_commit_lead}: auto-commit main-branch output (phase $PHASE)"
        # Real stderr is captured (not discarded) instead of collapsing every
        # failure into "nothing to commit" — a client repo's commit-msg hook
        # rejecting the message for its OWN reason (any reason; this
        # pipeline cannot and should not hardcode a specific hook's rule set
        # per project) previously looked identical to "the tree was already
        # clean", which is actively misleading: files remain staged in the
        # first case but not the second. Distinguish them by checking
        # whether anything is still staged after the failed attempt.
        # set +e/-e: this whole script runs under `set -e` (line 12) — a bare
        # `_step9_commit_output=$(failing_cmd)` assignment would abort the
        # script immediately on a real commit failure, silently
        # reintroducing the exact defect this capture exists to fix (same
        # guard commit_completed_story() uses, lib/git-ops.sh).
        set +e
        _step9_commit_output=$(git -C "$PROJECT_ROOT" commit -m "$_step9_commit_msg" 2>&1)
        _step9_commit_rc=$?
        set -e
        if [ "$_step9_commit_rc" -eq 0 ]; then
            step_emit "9" "pass" "Step 9: Auto-commit"
            success "Step 9: Committed main-branch output"
        elif [ -n "$(git -C "$PROJECT_ROOT" diff --cached --name-only 2>/dev/null)" ]; then
            step_emit "9" "fail" "Step 9: Auto-commit" "commit rejected"
            error "Step 9: Commit failed — work remains staged/uncommitted. Output:"
            error "$_step9_commit_output"
        else
            step_emit "9" "skip" "Step 9: Auto-commit" "nothing to commit"
            warning "Step 9: Nothing new to commit (working tree already clean)"
        fi
    fi
else
    if [ -z "${main_stories:-}" ]; then
        step_emit "9" "skip" "Step 9: Auto-commit" "no main-branch stories ran"
        info "Step 9: No main-branch stories ran this phase — any dirty tree state is pipeline noise, not a deliverable; skipping auto-commit"
    else
        step_emit "9" "skip" "Step 9: Auto-commit" "already clean"
        info "Step 9: No uncommitted main-branch changes — skipping auto-commit"
    fi
fi
# ──────────────────────────────────────────────
# Step 10 (TC writer gate) has moved — see after Step 17 below. Running it
# here (before Step 14's worktree implementation) meant it ALWAYS found zero
# source files for any phase using worktree topology, since main-branch Step 8
# is empty in that case ("no stories in lane") and the real implementation
# only exists after Step 14/15 run and Step 17 merges them back. Confirmed
# live: this hard-aborted the entire core phase before implementation ever ran.
# ──────────────────────────────────────────────
need_worktrees=false
[ -n "$primary_stories" ] && need_worktrees=true
[ -n "$independent_stories" ] && need_worktrees=true

if [ "$need_worktrees" = true ]; then
    step_emit "13" "running" "Step 13: Create worktrees"
    log "Step 13: Creating git worktrees..."
    "$CLAUDE_SH" --setup-worktrees || { error "Failed to create worktrees"; exit 1; }
    step_emit "13" "pass" "Step 13: Create worktrees"
else
    step_emit "13" "skip" "Step 13: Create worktrees" "no parallel stories"
    info "Step 13: No worktree stories — skipping worktree creation"
fi

# ──────────────────────────────────────────────
# Step 3: Launch parallel agents
# ──────────────────────────────────────────────
PRIMARY_PID=""
INDEPENDENT_PID=""

if [ -n "$primary_stories" ]; then
    step_emit "14" "running" "Step 14: Primary agent"
    log "Step 14: Starting primary agent..."
    "$CLAUDE_SH" --worktree primary --phase "$PHASE" \
        > "$LOG_DIR/wt-primary.log" 2>&1 &
    PRIMARY_PID=$!
    info "  Primary agent PID: $PRIMARY_PID"
fi

if [ -n "$independent_stories" ]; then
    step_emit "15" "running" "Step 15: Independent agent"
    log "Step 15: Starting independent agent..."
    "$CLAUDE_SH" --worktree independent --phase "$PHASE" \
        > "$LOG_DIR/wt-independent.log" 2>&1 &
    INDEPENDENT_PID=$!
    info "  Independent agent PID: $INDEPENDENT_PID"
else
    step_emit "15" "skip" "Step 15: Independent agent" "no independent stories"
    info "Step 15: No independent stories — skipping independent agent"
fi

# Wait for both agents
PRIMARY_EXIT=0
INDEPENDENT_EXIT=0

if [ -n "$PRIMARY_PID" ]; then
    log "Waiting for primary agent (PID $PRIMARY_PID)..."
    wait $PRIMARY_PID || PRIMARY_EXIT=$?
    if [ $PRIMARY_EXIT -eq 0 ]; then
        step_emit "14" "pass" "Step 14: Primary agent"
        success "Primary agent completed successfully"
    else
        step_emit "14" "fail" "Step 14: Primary agent"
        error "Primary agent failed with exit code $PRIMARY_EXIT"
        error "Check log: $LOG_DIR/wt-primary.log"
    fi
fi

if [ -n "$INDEPENDENT_PID" ]; then
    log "Waiting for independent agent (PID $INDEPENDENT_PID)..."
    wait $INDEPENDENT_PID || INDEPENDENT_EXIT=$?
    if [ $INDEPENDENT_EXIT -eq 0 ]; then
        step_emit "15" "pass" "Step 15: Independent agent"
        success "Independent agent completed successfully"
    else
        step_emit "15" "fail" "Step 15: Independent agent"
        error "Independent agent failed with exit code $INDEPENDENT_EXIT"
        error "Check log: $LOG_DIR/wt-independent.log"
    fi
fi

# Do NOT exit immediately on a worktree failure. Stories inside a worktree now
# commit their own work as they complete (see commit_completed_story() in
# claude.sh); if a LATER story in the same lane exhausts its retries, the lane's
# exit code is non-zero even though earlier stories genuinely succeeded. Skipping
# Step 3.1/3.2 here used to mean those earlier commits were never merged and were
# then destroyed when the worktree got force-removed. Instead, continue through
# health-check + merge so completed work lands on the main branch, then fail the
# phase afterward (WORKTREE_HAD_FAILURE) so the pipeline still stops correctly.
WORKTREE_HAD_FAILURE=false
if [ "$PRIMARY_EXIT" -ne 0 ] || [ "$INDEPENDENT_EXIT" -ne 0 ]; then
    WORKTREE_HAD_FAILURE=true
    error "One or more worktree agents failed — attempting to commit/merge whatever stories DID complete before failing the phase"
fi

# ──────────────────────────────────────────────
# Step 3.1: Worktree health check + auto-commit
# Ensures agent-produced code is committed before gate assessment.
# Agents sometimes write files without committing (common failure mode).
if [ "$need_worktrees" = true ]; then
    step_emit "16" "running" "Step 16: Worktree health"
    log "Step 16: Worktree health check..."
    GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}" \
        PHASE="$PHASE" AUTO_COMMIT=true "$SCRIPT_DIR/worktree-health-check.sh" \
        2>&1 | tee "$LOG_DIR/worktree-health-${PHASE}.log"
    _health_exit=${PIPESTATUS[0]}
    if [ "$_health_exit" -ne 0 ]; then
        step_emit "16" "warn" "Step 16: Worktree health" "health issues auto-fixed"
        error "Worktree health check failed — see $LOG_DIR/worktree-health-${PHASE}.log"
        exit 1
    else
        step_emit "16" "pass" "Step 16: Worktree health"
    fi
else
    step_emit "16" "skip" "Step 16: Worktree health" "no worktrees"
    info "Step 16: No worktrees — skipping health check"
fi

# ──────────────────────────────────────────────
# Step 3.2: Merge worktree branches back to main branch
# After agents complete and health-check auto-commits, merge their
# work into the main branch so the next phase (which recreates
# worktree branches from HEAD) inherits all prior code.
# ──────────────────────────────────────────────
if [ "$need_worktrees" = true ]; then
    log "Step 17: Merging worktree branches back to main branch..."

    # Resolve the git root and current branch
    _merge_git_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    # If HEAD cannot be read, fall back to the CONFIGURED integration branch — never to a
    # guessed name. `|| echo "master"` meant a repo whose trunk is develop silently merged
    # against a branch that may not exist.
    _merge_current_branch=$(git -C "$_merge_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${JIRA_BASELINE_BRANCH:-}")

    # THE TARGET MUST BE A REAL BRANCH, AND SAYING SO IS THE WHOLE POINT.
    #
    # Two ways it is not, and NEITHER ANNOUNCES ITSELF. An unreadable HEAD with no configured
    # baseline leaves this EMPTY — and an empty side of a git range silently defaults to HEAD, so
    # `rev-list --count "..wt-primary"` returns a perfectly sensible number and every check below
    # passes. A detached HEAD makes `--abbrev-ref` return the literal string "HEAD", which is not a
    # branch either.
    #
    # Both then merge onto a detached HEAD: the merge commit is referenced by no branch, so the
    # lane's work is unreachable at the next checkout and the next phase, which recreates lane
    # branches from HEAD, inherits nothing. Every step reports success while the work is discarded.
    # Verified rather than assumed — see the-merge-back-says-what-actually-stopped-it.test.ts.
    if [ -z "$_merge_current_branch" ] || [ "$_merge_current_branch" = "HEAD" ] \
       || ! git -C "$_merge_git_root" show-ref --verify --quiet "refs/heads/$_merge_current_branch"; then
        error "Step 17: cannot resolve a branch to merge into in $_merge_git_root (HEAD resolves to '${_merge_current_branch:-<nothing>}')"
        error "  The lane branches and their commits are intact — this is the target, not the work. Nothing was merged and nothing was discarded."
        exit 1
    fi

    MERGE_FAILED=false

    _active_wt_branches=()
    [ -n "$primary_stories" ] && _active_wt_branches+=(wt-primary)
    [ -n "$independent_stories" ] && _active_wt_branches+=(wt-independent)

    for _wt_branch in "${_active_wt_branches[@]}"; do
        if ! git -C "$_merge_git_root" show-ref --verify --quiet "refs/heads/$_wt_branch"; then
            error "  Required branch $_wt_branch does not exist"
            MERGE_FAILED=true
            continue
        fi

        # Check if the branch has commits ahead of the current branch
        _ahead=$(git -C "$_merge_git_root" rev-list --count "$_merge_current_branch..$_wt_branch" 2>/dev/null || echo "0")
        if [ "${_ahead:-0}" -eq 0 ]; then
            error "  Active branch $_wt_branch has no new commits"
            MERGE_FAILED=true
            continue
        fi

        log "  Merging $_wt_branch ($_ahead commit(s) ahead) into $_merge_current_branch..."
        # Discard any uncommitted working-tree changes on the target branch before merging.
        # These can be left behind when the mock LLM writes wrong-branch files due to story
        # mis-detection, or from prior failed runs. Both tracked-modified and untracked files
        # that would block the merge are cleaned here.
        git -C "$_merge_git_root" checkout -- . 2>/dev/null || true
        # -e .codegraph: never delete the CodeGraph index (see
        # brownfield-preflight-reset.sh for the root cause — the .gitignore that
        # protects codegraph.db is itself removed by git clean's first pass,
        # exposing the db to deletion on any later clean like this one).
        git -C "$_merge_git_root" clean -fd -e .codegraph 2>/dev/null || true

        # Merge-integrity guard (found live via flow-gap analysis, 2026-07-12):
        # the real merge below uses `-X ours`, which silently resolves any
        # GENUINELY CONFLICTING hunk in favor of $_merge_current_branch's
        # content, discarding whatever $_wt_branch changed there — with no
        # error, no warning, and (confirmed empirically) no "CONFLICT" text
        # anywhere in git's own output; it exits 0 and looks identical to a
        # clean merge. Every downstream check (build gate, lint gate, Team
        # Lead Review, SAST) only ever sees the post-merge diff, so content
        # -X ours drops was never part of that diff — none of them can ever
        # catch this. `git merge-tree --write-tree` (git >= 2.38) computes
        # the same merge WITHOUT touching the working tree or creating a
        # commit, and exits non-zero with the conflicting file list when a
        # real conflict would occur — a pure git-history invariant, no
        # stack-specific logic, so refuse to silently auto-resolve instead.
        _mt_output=$(git -C "$_merge_git_root" merge-tree --write-tree --name-only \
            "$_merge_current_branch" "$_wt_branch" 2>&1)
        _mt_exit=$?
        if [ "$_mt_exit" -ne 0 ]; then
            _mt_conflict_files=$(echo "$_mt_output" | tail -n +2 | awk '/^$/{exit} {print}')
            error "  Merge-integrity guard: $_wt_branch conflicts with $_merge_current_branch in: ${_mt_conflict_files:-<unknown file>}"
            error "  Proceeding with '-X ours' would SILENTLY DISCARD $_wt_branch's changes there with no trace — refusing to auto-resolve."
            # BESIDE THE REPOSITORY THAT ACTUALLY CONFLICTED. This wrote to PROJECT_ROOT while the
            # merge runs in $_merge_git_root, so whenever the two differ the record landed next to a
            # repository that had no conflict, and the one that did carried no evidence.
            #
            # AND THE WRITE IS NOT SILENCED. It ended in `2>/dev/null`, so a failed jq left no file
            # and no message — this record is the only durable trace of which files a lane could not
            # merge, and the error above scrolls away with the run log.
            _mc_dir="${_merge_git_root}/.epam/merge-conflicts"
            if ! mkdir -p "$_mc_dir" 2>/dev/null || ! jq -n --arg branch "$_wt_branch" --arg target "$_merge_current_branch" \
                --arg files "$_mt_conflict_files" --arg phase "$PHASE" \
                '{phase: $phase, branch: $branch, target: $target, conflictingFiles: ($files | split("\n") | map(select(length > 0))), detectedAt: (now | todate)}' \
                > "${_mc_dir}/${PHASE}-${_wt_branch}.json"; then
                error "  Could not record the conflict to ${_mc_dir} — the file list above is the only copy."
            fi
            "$SCRIPT_DIR/update-monitor.sh" event "merge_conflict" \
                "Merge-integrity guard: $_wt_branch conflicts with $_merge_current_branch in ${_mt_conflict_files:-unknown file} — refusing silent -X ours resolution" "" "main" "orchestrator" 2>/dev/null || true
            MERGE_FAILED=true
            continue
        fi

        if git -C "$_merge_git_root" merge --no-ff -X ours "$_wt_branch" \
            -m "merge: phase $PHASE ${_wt_branch#wt-} lane ($_ahead commits)" 2>&1; then
            success "  Merged $_wt_branch into $_merge_current_branch"
            "$SCRIPT_DIR/update-monitor.sh" event "merge_back" \
                "Merged $_wt_branch into $_merge_current_branch ($_ahead commits)" "" "main" "orchestrator" 2>/dev/null || true
        else
            error "  Failed to merge $_wt_branch into $_merge_current_branch"
            error "  This may require manual conflict resolution"
            "$SCRIPT_DIR/update-monitor.sh" event "merge_conflict" \
                "CONFLICT merging $_wt_branch — manual resolution needed" "" "main" "orchestrator" 2>/dev/null || true
            MERGE_FAILED=true
            # Abort the failed merge so the repo is not left in a dirty state
            git -C "$_merge_git_root" merge --abort 2>/dev/null || true
        fi
    done

    if [ "$MERGE_FAILED" = true ]; then
        error "Step 17: One or more worktree merges failed — review conflicts before next phase"
        error "  Worktrees preserved for inspection. Re-run with --skip-cleanup to debug."
        exit 1
    else
        success "Step 17: All worktree branches merged back successfully"
    fi
else
    info "Step 17: No worktrees — skipping merge-back"
fi

# Now that any completed stories' commits have had a chance to merge, fail the
# phase if a worktree agent reported a failed story earlier.
if [ "$WORKTREE_HAD_FAILURE" = true ]; then
    error "One or more stories failed in a worktree agent — phase '$PHASE' did not fully succeed"
    error "  (completed stories in the same lane, if any, were committed and merged above)"
    exit 1
fi

# ──────────────────────────────────────────────
# Step 10: Post-impl TC (test criteria) writer gate.
# Runs HERE (after worktree merge-back, not before Step 3) so it always has
# real implementation to read regardless of topology — main-branch stories
# (Step 1) and worktree stories (Step 3a/3b, merged in Step 3.2) are both
# guaranteed to exist on the current branch by this point.
# Fires when impl stories have run and test stories in this phase need TCs.
# Reads actual .ts source files and writes testCriteria to prd.json.
# ACs are never modified — TCs are additive only.
# Skip with: SKIP_TC_WRITER=1
# ──────────────────────────────────────────────
# Unlike the INLINE gate above (Step 1 loop, pre-execution — see its own
# comment for why combo stories must be excluded there), this gate runs
# AFTER every Step 1 story has already completed: by now a combo story's own
# impl+test files genuinely exist on disk, so "any file is a test file" is
# the correct, safe classification here — this is deliberately NOT scoped to
# "all files" like the inline gate, since combo stories legitimately benefit
# from real TC generation once they're done (this is the original,
# unmodified behavior this gate always had).
if is_truthy "${SKIP_TC_WRITER:-}"; then
    step_emit "10" "skip" "Step 10: TC writer gate" "SKIP_TC_WRITER=1"
    info "Step 10: TC writer gate skipped (SKIP_TC_WRITER=1)"
    _tc_writer_needed=0
else
# WHICH STORIES NEED TEST CRITERIA — ASKED OF THE ONE PLACE THAT KNOWS.
#
# This was an inline jq matching endswith(".test.ts"). post-impl-tc-writer.sh, the script this
# gate exists to invoke, already asks lib/handlers/_testfile.py, which recognises .spec., .test.,
# _spec., _test., test_* and __tests__/. So on a project using ANY other convention — .spec.ts,
# test_*.py, anything not Node — this returned 0, the writer was never invoked, and the step
# reported "all TCs present". A gate that silently answers "nothing to do" on every project but
# one is not a gate. Verified against a fixture: the handler finds 2, this jq found 0.
_tc_writer_needed=$(python3 "$SCRIPT_DIR/lib/handlers/tc-stories-needing-criteria.py" \
    "$PRD_FILE" "$PHASE" "" 2>/dev/null | awk 'NF{n++} END{print n+0}')
fi

# TC WRITER IS A GREENFIELD MECHANISM (decision, 2026-07-26).
#
# Brownfield proves a change differently and better: verification criteria
# describe the observable outcome, the repro-test-writer builds a test from them
# plus the real fix diff, and the bug-reproduction gate then EXECUTES that test
# against the pre-fix and post-fix code. A test criterion is a written
# intention; RED→GREEN is a demonstration.
#
# Adding TCs on top would restate the VCs one model call further from the
# source, and give the writer a second, overlapping requirement list to drift
# from. Greenfield has no bug to reproduce and no baseline to run against, so
# there TCs remain the mechanism that says what "done" means.
# NOVEL BROWNFIELD WORK STILL NEEDS TEST CRITERIA.
#
# The reasoning above holds for a DEFECT: the bug-reproduction gate executes a failing test
# against pre-fix and post-fix code, which beats a written intention. It does not hold for a
# novel story — phase_stories_for_repro_gate excludes storyKind "novel" because there is no
# prior bug to reproduce, so skipping the TC writer for ALL brownfield left novel work with
# NO test mechanism at all.
#
# Live 2026-08-07, AMSD-2041 (novel): Step 10 skipped, Step 3.55 "passed" with nothing to
# check, and no step owned tests. The reviewer requested them on seven cycles across two runs,
# the writer never wrote any, the reviewer never approved, and the phase halted every time.
_tc_novel_stories="$(phase_stories_for_tc_writer "$PRD_FILE" "$PHASE" 2>/dev/null || true)"
_tc_novel_count=$(printf '%s\n' "$_tc_novel_stories" | awk 'NF{n++} END{print n+0}')
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_tc_novel_count" -eq 0 ]; then
    step_emit "10" "skip" "Step 10: TC writer gate" "brownfield defects — bug-reproduction gate proves them instead"
    info "Step 10: TC writer gate skipped — every phase story is a defect, proven by the bug-reproduction gate rather than by test criteria"
elif [ "${_tc_writer_needed:-0}" -gt 0 ]; then
    step_emit "10" "running" "Step 10: TC writer gate"
    log "Step 10: TC writer gate — ${_tc_writer_needed} test story/stories need testCriteria..."
    # Retry-on-violation (2026-07-13), same shape as the inline gate above:
    # give the batch call up to 3 attempts, then BLOCK only the specific
    # story IDs still lacking real testCriteria (not exit 1 the whole phase
    # — a script crash bad enough to make $PRD_FILE itself unreadable is the
    # only case that still stays a hard failure).
    for _tc_batch_attempt in 1 2 3; do
        # `if CMD | tee file; then` checks tee's exit code, not CMD's — tee
        # almost always exits 0, so this previously reported PASS even when
        # the TC writer agent itself failed. Use PIPESTATUS[0] instead.
        bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
            --prd "$PRD_FILE" \
            --phase "$PHASE" \
            --output-dir "${OUTPUT_DIR:-$PROJECT_ROOT}" \
            2>&1 | tee "$LOG_DIR/tc-writer-${PHASE}.log"
        _tc_writer_exit=${PIPESTATUS[0]}

        if ! jq empty "$PRD_FILE" 2>/dev/null; then
            step_emit "10" "fail" "Step 10: TC writer gate"
            error "Step 10: TC writer gate FAILED — $PRD_FILE is not valid JSON after the writer ran (attempt ${_tc_batch_attempt}/3)"
            error "  Fix: check $LOG_DIR/tc-writer-${PHASE}.log"
            exit 1
        fi

        # THE SAME QUESTION, SO THE SAME ANSWER. This carried its own copy of the .test.ts
        # match, so on any other convention it reported nothing still missing and the gate
        # PASSED — after a writer run that had produced nothing, because it was never needed.
        _tc_batch_still_missing=$(python3 "$SCRIPT_DIR/lib/handlers/tc-stories-needing-criteria.py" \
            "$PRD_FILE" "$PHASE" "" 2>/dev/null | awk 'NF{printf "%s%s", (n++ ? "," : ""), $0}')

        if [ -z "$_tc_batch_still_missing" ]; then
            step_emit "10" "pass" "Step 10: TC writer gate"
            success "Step 10: TC writer gate PASSED — testCriteria populated (attempt ${_tc_batch_attempt}/3)"
            break
        fi
        warning "  Step 10 attempt ${_tc_batch_attempt}/3: still missing testCriteria for: $_tc_batch_still_missing"
        # THE SAME SEAM SELF-HEALS THE SAME WAY AT BOTH ITS CALL SITES. The inline gate
        # (lib/tc-writer-gate.sh) classifies a failed attempt and asks the attempt analyst before
        # retrying; this batch loop retried blind, so a tc-writer that answered in prose was
        # simply asked again and nothing was diagnosed or recorded (£0 greenfield harness run 28,
        # 2026-09-14). Same classification, same analyst, same role — never fatal to the retry.
        if [ "$_tc_batch_attempt" -lt 3 ]; then
            _tc_batch_fclass="no_json"
            grep -qiE "reached maximum iterations" "$LOG_DIR/tc-writer-${PHASE}.log" 2>/dev/null && _tc_batch_fclass="max_iterations"
            grep -qiE "ai-run failed|no error output" "$LOG_DIR/tc-writer-${PHASE}.log" 2>/dev/null && _tc_batch_fclass="provider"
            log "  [tc-writer] batch attempt ${_tc_batch_attempt} failed (class=${_tc_batch_fclass}) — invoking self-heal analyst"
            AGENT_ANALYST_STORY_ID="${_tc_batch_still_missing%%,*}" STORY_ROLE="${STORY_ROLE:-tc-writer}" \
                bash "$SCRIPT_DIR/agent-attempt-analyst.sh" "$_tc_batch_fclass" "$LOG_DIR/tc-writer-${PHASE}.log" 2>>"$LOG_DIR/tc-writer-${PHASE}.log" \
                || warning "  [tc-writer] self-heal analyst FAILED (class=${_tc_batch_fclass}) — attempt $((_tc_batch_attempt + 1)) retries WITHOUT corrective guidance"
        fi
    done

    _tc_batch_violation_types="[]"
    if [ -n "$_tc_batch_still_missing" ]; then
        if [ "${_tc_writer_exit:-0}" -ne 0 ]; then
            _tc_batch_violation_types='["writer_exit_nonzero","empty_facts"]'
        else
            _tc_batch_violation_types='["empty_facts"]'
        fi
    fi

    _log_guarded_step_retry "$(jq -n -c \
        --arg step "tc-writer-batch" \
        --arg phase "$PHASE" \
        --argjson attempts "$_tc_batch_attempt" \
        --arg outcome "$([ -z "$_tc_batch_still_missing" ] && echo pass || echo blocked)" \
        --argjson violationTypes "$_tc_batch_violation_types" \
        '{timestamp: (now | todate), step: $step, phaseId: $phase, attempts: $attempts, outcome: $outcome, violationTypes: $violationTypes}' \
        2>/dev/null)"

    if [ -n "$_tc_batch_still_missing" ]; then
        step_emit "10" "warn" "Step 10: TC writer gate" "blocked stories, see blocked-stories.jsonl"
        warning "Step 10: TC writer gate — blocking $_tc_batch_still_missing after 3 attempts (not aborting the phase)"
        IFS=',' read -ra _tc_blocked_ids <<< "$_tc_batch_still_missing"
        for _tc_blocked_id in "${_tc_blocked_ids[@]}"; do
            jq --arg id "$_tc_blocked_id" '(.stories[] | select(.id == $id)).status = "blocked"' \
                "$PRD_FILE" > "${PRD_FILE}.tmp" && mv "${PRD_FILE}.tmp" "$PRD_FILE"
            jq -n -c --arg storyId "$_tc_blocked_id" --arg reason "no valid testCriteria after 3 attempts (batch gate)" \
                '{timestamp: (now | todate), storyId: $storyId, reason: $reason}' \
                >> "$LOG_DIR/blocked-stories.jsonl" 2>/dev/null || true
        done
    fi
else
    step_emit "10" "skip" "Step 10: TC writer gate" "all TCs present"
    info "Step 10: TC writer gate — all test stories already have TCs or no test stories in phase"
fi


if is_truthy "${SKIP_SKILLS_AUDIT:-}"; then
    step_emit "11" "skip" "Step 11: Skills coordinator audit" "SKIP_SKILLS_AUDIT=1"
else
    step_emit "11" "running" "Step 11: Skills coordinator audit"
    # A FAILED SCAN IS NOT A CLEAN SCAN. This substituted a zero-findings result for any failure
    # — a lock it could not take, a crashed handler, an unreadable profiles.json — and the step
    # then reported "pass" having audited nothing. The duplicate and self-contradictory notes this
    # step exists to catch went straight into the writer's profile.
    _skills_audit_ok=1
    if ! _skills_audit_result=$(run_skills_audit_scan "$AGENT_PROFILES_FILE" 2>&1); then
        _skills_audit_ok=0
        warning "  [SkillsAudit] scan failed — profiles.json was NOT audited this phase: ${_skills_audit_result}"
        _skills_audit_result='{"duplicates_removed":0,"contradictions":[]}'
    fi
    _skills_dupes_removed=$(echo "$_skills_audit_result" | jq -r '.duplicates_removed // 0' 2>/dev/null || echo 0)
    _skills_contradiction_count=$(echo "$_skills_audit_result" | jq -r '.contradictions | length' 2>/dev/null || echo 0)

    if [ "${_skills_dupes_removed:-0}" -gt 0 ]; then
        success "  [SkillsAudit] Removed ${_skills_dupes_removed} duplicate skill note(s) from profiles.json"
    fi

    if [ "${_skills_contradiction_count:-0}" -gt 0 ]; then
        warning "  [SkillsAudit] ${_skills_contradiction_count} suspected self-contradictory skill note(s) found — invoking skills-coordinator to rewrite"
        # A SNAPSHOT THAT FAILED IS NOT A SNAPSHOT. This fell back to "{}" — and the only use of
        # this variable is to be WRITTEN BACK over profiles.json when the coordinator corrupts it.
        # So an unreadable profiles.json produced a snapshot of "{}", and the "restore" destroyed
        # every agent profile in the project while logging that it had restored them.
        _skills_before=""
        _skills_before=$(cat "$AGENT_PROFILES_FILE" 2>/dev/null || true)
        while IFS= read -r _sc_row; do
            [ -z "$_sc_row" ] && continue
            _sc_role=$(echo "$_sc_row" | jq -r '.role')
            _sc_note=$(echo "$_sc_row" | jq -r '.note')
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/skills-coordinator-vals-XXXXXX.json")
            jq_vals \
                  --arg agent_profiles_file "${AGENT_PROFILES_FILE}" \
                  --arg sc_role "${_sc_role}" \
                  --arg sc_note "${_sc_note}" \
                  '{"__AGENT_PROFILES_FILE__":$agent_profiles_file,"__SC_ROLE__":$sc_role,"__SC_NOTE__":$sc_note}' > "$_cp_vals"
            # EXIT STATUS IS THE CONTRACT — render-engine-prompt.sh says so in its own header:
            # non-zero means nothing was rendered and the caller must refuse to invoke an agent
            # rather than send it an empty prompt. The assignment swallowed it, so a failed render
            # handed run_orch_prompt_with_tools an EMPTY prompt and an agent with Bash and
            # WriteFile answered from nothing, against profiles.json.
            if ! _sc_prompt="$(render_engine_prompt skills-coordinator "$_cp_vals")" || [ -z "$_sc_prompt" ]; then
                rm -f "$_cp_vals"
                error "  [SkillsAudit] could not render the skills-coordinator prompt for [${_sc_role}] — leaving the note as-is rather than invoking an agent with nothing to read"
                continue
            fi
            rm -f "$_cp_vals"
            _sc_attempt=0
            while [ "$_sc_attempt" -lt 2 ]; do
                _sc_run_prompt="$_sc_prompt"
                if [ "$_sc_attempt" -ge 1 ]; then
                  _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                  jq_vals \
                        --arg agent_profiles_file "${AGENT_PROFILES_FILE}" \
                        --arg sc_prompt "$_sc_prompt" \
                        '{"__AGENT_PROFILES_FILE__":$agent_profiles_file,"__SC_PROMPT__":$sc_prompt}' > "$_rp_vals"
                  # Same contract. A failed retry render used to blank the prompt that the first
                  # attempt had rendered correctly, turning a retry into an empty call.
                  if ! _sc_run_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" skills_coordinator)" \
                     || [ -z "$_sc_run_prompt" ]; then
                      warning "  [SkillsAudit] could not render the retry prefix — retrying with the original prompt"
                      _sc_run_prompt="$_sc_prompt"
                  fi
                  rm -f "$_rp_vals"
                fi
                # No story_id — phase-level audit, not tied to a single story.
                if run_orch_prompt_with_tools "$_sc_run_prompt" "skills_audit" > "$LOG_DIR/skills-coordinator-${PHASE}.log" 2>&1; then
                    if jq empty "$AGENT_PROFILES_FILE" 2>/dev/null; then
                        success "  [SkillsAudit] Rewrote contradictory note for [${_sc_role}]"
                        break
                    else
                        if [ -n "$_skills_before" ]; then
                            error "  [SkillsAudit] skills-coordinator corrupted profiles.json! Restoring pre-audit snapshot."
                            printf '%s\n' "$_skills_before" > "$AGENT_PROFILES_FILE"
                        else
                            error "  [SkillsAudit] skills-coordinator corrupted profiles.json AND no pre-audit snapshot was captured — leaving the file as-is rather than overwriting it with nothing. Restore it before the next phase."
                        fi
                        break
                    fi
                fi
                _sc_attempt=$(( _sc_attempt + 1 ))
                [ "$_sc_attempt" -lt 2 ] && warning "  [SkillsAudit] skills-coordinator attempt 1 failed — retrying with corrective note" || warning "  [SkillsAudit] skills-coordinator failed to rewrite note for [${_sc_role}] — leaving as-is"
            done
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg role "$_sc_role" --arg note "$_sc_note" \
                '{timestamp:$ts, phase:$phase, role:$role, event:"contradiction_rewrite", flagged_note:$note}' \
                >> "$LOG_DIR/skills-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_skills_audit_result" | jq -c '.contradictions[]' 2>/dev/null)
    fi
    # THE STATUS IS WHAT HAPPENED. This emitted "pass" unconditionally — after a scan that
    # failed, after a coordinator that gave up on a note ("leaving as-is"), and after one that
    # corrupted profiles.json and had to be rolled back. All three read as a clean audit.
    if [ "${_skills_audit_ok:-1}" -eq 1 ]; then
        step_emit "11" "pass" "Step 11: Skills coordinator audit"
    else
        step_emit "11" "warn" "Step 11: Skills coordinator audit" "scan failed — profiles.json not audited"
    fi
fi


if is_truthy "${SKIP_TOOLS_AUDIT:-}"; then
    step_emit "12" "skip" "Step 12: Tools coordinator audit" "SKIP_TOOLS_AUDIT=1"
else
    step_emit "12" "running" "Step 12: Tools coordinator audit"
    # A FAILED SCAN IS NOT A CLEAN SCAN — same substitution as Step 11 carried. A crashed handler
    # or an unreadable tools directory read as "no broken tools", and the step reported pass. The
    # broken tool then runs on every retry for the rest of the run, which is the exact cost this
    # step exists to stop.
    _tools_audit_ok=1
    if ! _tools_audit_result=$(run_tools_audit_scan "$PROJECT_ROOT/.epam/dynamic-tools" "$LOG_DIR" 2>&1); then
        _tools_audit_ok=0
        warning "  [ToolsAudit] scan failed — dynamic tools were NOT audited this phase: ${_tools_audit_result}"
        _tools_audit_result='{"broken":[],"duplicates":[]}'
    fi
    _tools_broken_count=$(echo "$_tools_audit_result" | jq -r '.broken | length' 2>/dev/null || echo 0)
    _tools_dup_count=$(echo "$_tools_audit_result" | jq -r '.duplicates | length' 2>/dev/null || echo 0)

    if [ "${_tools_broken_count:-0}" -gt 0 ] || [ "${_tools_dup_count:-0}" -gt 0 ]; then
        warning "  [ToolsAudit] ${_tools_broken_count} broken tool(s), ${_tools_dup_count} duplicate pair(s) found — invoking tools-coordinator"
        while IFS= read -r _tc_row; do
            [ -z "$_tc_row" ] && continue
            _tc_tool=$(echo "$_tc_row" | jq -r '.tool')
            _tc_reason=$(echo "$_tc_row" | jq -r '.reason')
            _tc_path="$PROJECT_ROOT/.epam/dynamic-tools/${_tc_tool}.sh"
            # Same failure as Step 11's snapshot, and worse here: an empty script passes `bash -n`,
            # so writing the failed snapshot back would neuter the tool AND report it as fixed.
            _tc_before=""
            _tc_before=$(cat "$_tc_path" 2>/dev/null || true)
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/tools-coordinator-vals-XXXXXX.json")
            jq_vals \
                  --arg tc_reason "${_tc_reason}" \
                  --arg tc_path "${_tc_path}" \
                  '{"__TC_REASON__":$tc_reason,"__TC_PATH__":$tc_path}' > "$_cp_vals"
            # EXIT STATUS IS THE CONTRACT. A failed render handed an EMPTY prompt to an agent
            # holding Bash and WriteFile, pointed at a script the pipeline then executes on every
            # subsequent retry.
            if ! _tc_prompt="$(render_engine_prompt tools-coordinator "$_cp_vals")" || [ -z "$_tc_prompt" ]; then
                rm -f "$_cp_vals"
                error "  [ToolsAudit] could not render the tools-coordinator prompt for [${_tc_tool}] — leaving the tool as-is rather than invoking an agent with nothing to read"
                continue
            fi
            rm -f "$_cp_vals"
            _tc_attempt=0
            while [ "$_tc_attempt" -lt 2 ]; do
                _tc_run_prompt="$_tc_prompt"
                if [ "$_tc_attempt" -ge 1 ]; then
                    _tc_bn_err=""
                    _tc_bn_err=$(bash -n "$_tc_path" 2>&1 || true)
                    # A CLEAN SYNTAX CHECK IS AN ANSWER, NOT AN ABSENCE. `bash -n` prints nothing when the
                    # file parses, which is the USUAL case here: this retry fires because the previous attempt
                    # failed, and most failures are not syntactic. The empty value made the retry-prefix render
                    # refuse, the handler below fell back to the ORIGINAL prompt, and the retry then repeated
                    # the identical call that had just failed — an unwinnable loop, reported only as "could not
                    # render the retry prefix". Same idiom as the analyst's "(empty — it produced nothing)":
                    # say what was observed rather than nothing at all.
                    [ -n "${_tc_bn_err//[[:space:]]/}" ] || \
                        _tc_bn_err="(the file parses cleanly — the previous attempt did not fail on syntax)"
                    _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                    jq_vals \
                          --arg tc_bn_err "${_tc_bn_err}" \
                          --arg tc_tool "${_tc_tool}" \
                          --arg tc_prompt "$_tc_prompt" \
                          '{"__TC_BN_ERR__":$tc_bn_err,"__TC_TOOL__":$tc_tool,"__TC_PROMPT__":$tc_prompt}' > "$_rp_vals"
                    if ! _tc_run_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" tools_coordinator)" \
                       || [ -z "$_tc_run_prompt" ]; then
                        warning "  [ToolsAudit] could not render the retry prefix — retrying with the original prompt"
                        _tc_run_prompt="$_tc_prompt"
                    fi
                    rm -f "$_rp_vals"
                fi
                # No story_id — phase-level audit, not tied to a single story.
                if run_orch_prompt_with_tools "$_tc_run_prompt" "tools_audit" > "$LOG_DIR/tools-coordinator-${PHASE}.log" 2>&1; then
                    if bash -n "$_tc_path" 2>/dev/null; then
                        success "  [ToolsAudit] Rewrote broken tool [${_tc_tool}]"
                        break
                    else
                        if [ "$_tc_attempt" -ge 1 ]; then
                            if [ -n "$_tc_before" ]; then
                                error "  [ToolsAudit] tools-coordinator left ${_tc_tool}.sh syntactically broken after 2 attempt(s)! Restoring pre-audit snapshot."
                                printf '%s\n' "$_tc_before" > "$_tc_path"
                            else
                                error "  [ToolsAudit] ${_tc_tool}.sh is broken and no pre-audit snapshot was captured — leaving it as-is. An empty script passes bash -n, so overwriting it would hide the breakage rather than fix it."
                            fi
                            break
                        fi
                        warning "  [ToolsAudit] tools-coordinator left ${_tc_tool}.sh broken on attempt 1 — retrying with corrective note"
                    fi
                else
                    # "LEAVING AS-IS" HAD TO BE MADE TRUE. If attempt 1 succeeded but left the
                    # script broken, and attempt 2 then errored, the loop ended with the agent's
                    # half-rewritten file on disk — reported as "leaving as-is", and executed on
                    # every later retry. Restore what was actually there.
                    if [ "$_tc_attempt" -ge 1 ]; then
                        if [ -n "$_tc_before" ] && ! bash -n "$_tc_path" 2>/dev/null; then
                            warning "  [ToolsAudit] tools-coordinator failed to fix [${_tc_tool}] and left it broken — restoring the pre-audit script"
                            printf '%s\n' "$_tc_before" > "$_tc_path"
                        else
                            warning "  [ToolsAudit] tools-coordinator failed to fix [${_tc_tool}] — leaving as-is"
                        fi
                    fi
                fi
                _tc_attempt=$(( _tc_attempt + 1 ))
            done
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg tool "$_tc_tool" --arg reason "$_tc_reason" \
                '{timestamp:$ts, phase:$phase, tool:$tool, reason:$reason, event:"broken_tool_rewrite"}' \
                >> "$LOG_DIR/tools-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_tools_audit_result" | jq -c '.broken[]' 2>/dev/null)

        while IFS= read -r _tc_dup_row; do
            [ -z "$_tc_dup_row" ] && continue
            _tc_a=$(echo "$_tc_dup_row" | jq -r '.tool_a')
            _tc_b=$(echo "$_tc_dup_row" | jq -r '.tool_b')
            warning "  [ToolsAudit] Duplicate tools detected: ${_tc_a}.sh and ${_tc_b}.sh solve overlapping problems — flagged for manual review (not auto-merged)"
            jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "${PHASE:-unknown}" \
                --arg a "$_tc_a" --arg b "$_tc_b" \
                '{timestamp:$ts, phase:$phase, tool_a:$a, tool_b:$b, event:"duplicate_flagged"}' \
                >> "$LOG_DIR/tools-coordinator-audit.jsonl" 2>/dev/null || true
        done < <(echo "$_tools_audit_result" | jq -c '.duplicates[]' 2>/dev/null)
    fi
    # THE STATUS IS WHAT HAPPENED, not what was attempted.
    if [ "${_tools_audit_ok:-1}" -eq 1 ]; then
        step_emit "12" "pass" "Step 12: Tools coordinator audit"
    else
        step_emit "12" "warn" "Step 12: Tools coordinator audit" "scan failed — dynamic tools not audited"
    fi
fi

# ──────────────────────────────────────────────
# Sync story data to monitor from cost log
"$SCRIPT_DIR/sync-monitor-stories.sh" 2>/dev/null || true



# Snapshot taken AFTER the parallel Step 1 loop (and any TC-writer-gate splits
# that ran inside it) but BEFORE Step 3.5's assessment agent runs. Used for
# assert_no_story_ids_gained at Step 3.5 and Step 6 — the "presplit" snapshot
# predates the parallel loop, so any stories added by the legitimate
# TC-fact-density split mechanism during Step 1 would appear as false-positive
# "unauthorized creations" if we used it here. "post-parallel" sees the
# already-split PRD and only flags stories added by the assessment agent itself.
capture_story_ids_snapshot "post-parallel"

# Only run assessment if cost tracking data exists
if is_truthy "${SKIP_SKILL_ASSESSMENT:-}"; then
    step_emit "18" "skip" "Step 18: Post-parallel assessment" "SKIP_SKILL_ASSESSMENT=1"
    info "Step 18: Skipped (SKIP_SKILL_ASSESSMENT=1)"
elif [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    step_emit "18" "running" "Step 18: Post-parallel assessment"
    log "Step 18: Running post-parallel skill assessment..."
    if run_phase_assessment "$PHASE"; then
        step_emit "18" "pass" "Step 18: Post-parallel assessment"
    else
        step_emit "18" "warn" "Step 18: Post-parallel assessment" "non-critical issues"
    fi
else
    step_emit "18" "skip" "Step 18: Post-parallel assessment" "no cost data"
    info "Step 18: No cost data yet — skipping post-parallel assessment"
fi
assert_no_story_ids_lost "presplit" "Step 18: Post-parallel assessment"
assert_no_story_ids_gained "post-parallel" "Step 18: Post-parallel assessment"

# ──────────────────────────────────────────────
    "$SCRIPT_DIR/update-monitor.sh" event "phase_assessment" "Running post-phase assessment" "" "main" "team-lead-agent" 2>/dev/null || true

# ──────────────────────────────────────────────
# Step 3.54: Dedicated reproducing-test writer (brownfield) — runs BEFORE the gate.
# Asking the impl agent to do BOTH the fix and a good reproducing test in one budget
# failed live (AMSD-1820 run #3: agent ran out of turns, shipped no test). Give
# test-writing its OWN agent turn here — it sees the committed fix diff + the VCs and
# writes a test that MATCHES the repo's convention (so the gate can run it). No-op if
# a test already accompanies the change. The Step 3.55 gate still independently
# validates fail-on-baseline/pass-with-fix; this only ensures a test EXISTS to check.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/brownfield-repro-test-writer.sh" ]; then
    # NO GUESSED BRANCH. This fell back to the literal "develop" — a branch name that is a fact of
    # some projects and not of others. Every diff the writer takes is against this ref, so on a
    # project whose trunk is named anything else it resolved nothing and the writer compared
    # against an empty baseline. The project declares it; otherwise take the repository's own
    # current branch, which is at least true.
    _tw_baseline="${JIRA_BASELINE_BRANCH:-}"
    if [ -z "$_tw_baseline" ]; then
        _tw_baseline=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        [ "$_tw_baseline" = "HEAD" ] && _tw_baseline=""
        [ -n "$_tw_baseline" ] && warning "Step 3.54: no JIRA_BASELINE_BRANCH declared — diffing against the checked-out branch '$_tw_baseline'"
    fi
    if [ -z "$_tw_baseline" ]; then
        error "Step 3.54: no baseline branch declared and none resolvable — skipping the reproducing-test writer rather than diffing against nothing. Step 3.55 will block these stories."
    else
    while IFS= read -r _tw_story; do
        [ -z "$_tw_story" ] && continue
        # THE WRITER'S EXIT STATUS SURVIVES THE PIPE. `cmd | tee` returns tee's status, which is
        # always 0, so a writer that produced no test at all reported success — and Step 3.55 then
        # blocked the story, pointing the investigation at the story rather than at the writer.
        PROJECT_ROOT="$PROJECT_ROOT" PRD_FILE="$PRD_FILE" LOG_DIR="$LOG_DIR" \
        JIRA_BASELINE_BRANCH="$_tw_baseline" \
            bash "$SCRIPT_DIR/brownfield-repro-test-writer.sh" "$_tw_story" 2>&1 | tee -a "$LOG_DIR/repro-test-writer-${PHASE}.log"
        _tw_rc=${PIPESTATUS[0]}
        # An explicit `if`, not `[ ... ] && warning`: that form returns non-zero when the test is
        # false, and as the last statement in a loop body it becomes the body's exit status.
        if [ "${_tw_rc:-0}" -ne 0 ]; then
            warning "Step 3.54: the reproducing-test writer produced no test for $_tw_story (exit ${_tw_rc}) — Step 3.55 will block it"
        fi
    # EVERY story in the phase, novel included. This selector was narrowed to
    # exclude novel by fe5d6cb, which was fixing the GATE below — the writer was
    # collateral. It does not need a bug: it reads the committed fix diff and the
    # story's verificationCriteria, and validates that its test PASSES against the
    # fix. See lib/story-guards.sh for the full history.
    done < <(phase_stories_brownfield_scope "$PRD_FILE" "$PHASE")
    fi
fi

# ──────────────────────────────────────────────
# Step 3.545: Update tests the fix legitimately INVALIDATED (brownfield).
# A defect fix changes behaviour that pre-existing tests asserted — those tests
# encoded the BUG. impl may not edit tests (it writes only the fix) and the
# test-writer only AUTHORS the new repro test, so without this step nobody updates
# them: Step 5's regression guard then blocks on a broken test the pipeline itself
# produced, and the self-heal retry fails identically (caught by mock1 2026-07-24,
# same shape as the metrolinx deadlock).
# It is deliberately narrow — it BLOCKS rather than editing whenever a failure is
# not explained by the story's Verification Criteria, so a wrong fix can never
# rewrite its own oracle to go green.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/update-invalidated-tests.sh" ]; then
    # Same resolution as Step 3.54: the project declares it, else the repository's own branch.
    # The literal "develop" is a fact of some projects and not of others, and every diff this step
    # takes is against this ref.
    _uit_baseline="${JIRA_BASELINE_BRANCH:-}"
    if [ -z "$_uit_baseline" ]; then
        _uit_baseline=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        [ "$_uit_baseline" = "HEAD" ] && _uit_baseline=""
    fi
    _uit_failed=0
    while IFS= read -r _uit_story; do
        [ -z "$_uit_story" ] && continue
        _uit_vcs=$(jq -r --arg id "$_uit_story" \
            '(.stories[] | select(.id == $id) | .verificationCriteria // []) | join("\n- ")' \
            "$PRD_FILE" 2>/dev/null || echo "")
        # THE ORACLE IS NOT OPTIONAL. The agent below is the only one granted write access to
        # PRE-EXISTING tests, and it decides what to edit by asking whether a failure is explained
        # by these criteria. With none, it was handed "(not supplied)" and asked to judge against
        # nothing while holding that grant — the path by which a wrong fix rewrites its own oracle.
        if [ -z "$_uit_vcs" ]; then
            warning "Step 3.545: $_uit_story declares no verification criteria — skipping it rather than letting a write-enabled agent judge against nothing"
            continue
        fi
        # NO GUESSED BRANCH — see Step 3.54. Resolved once above, from the project or the repo.
        PROJECT_ROOT="$PROJECT_ROOT" PRD_FILE="$PRD_FILE" LOG_DIR="$LOG_DIR" \
        JIRA_BASELINE_BRANCH="$_uit_baseline" \
        STORY_VERIFICATION_CRITERIA="$_uit_vcs" \
            bash "$SCRIPT_DIR/update-invalidated-tests.sh" "$_uit_story" 2>&1 \
            | tee -a "$LOG_DIR/update-invalidated-tests-${PHASE}.log"
        # No pipefail in this script — read the real exit code from PIPESTATUS.
        [ "${PIPESTATUS[0]}" -ne 0 ] && _uit_failed=1
    done < <(jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id) != null) | .id' \
        "$PRD_FILE" 2>/dev/null)
    # NON-BLOCKING (2026-07-25). This step exists to UPDATE pre-existing tests the
    # fix invalidated — it is not an enforcement gate and must never fail a phase.
    # It gated on the WHOLE suite being red, which includes the brand-new repro test
    # the test-writer had just committed. Judging that test belongs to the repro-gate
    # at Step 3.55, which knows how to do it properly (revert the fix, confirm the
    # test fails, restore, confirm it passes). Live 2026-07-24: this step pre-empted
    # the gate and killed a run whose fix and test were both committed and whose
    # reviewer had approved the same change standalone.
    # The repro-gate remains the enforcer.
    # RECORDED ON THE STORY, NOT ONLY LOGGED.
    #
    # This step stays NON-BLOCKING for the reason above. But "leaving it for the repro-gate to
    # judge" was a promise nothing kept: Step 3.55 selects via phase_stories_for_repro_gate(),
    # which excludes storyKind "novel" (lib/story-guards.sh:887, deliberately — a novel story
    # has no bug to reproduce and can never satisfy fail-on-baseline). So for a novel story the
    # deferral targets a gate that never examines it: the loop iterates zero stories,
    # _repro_blocked stays 0, and the phase reports "passed for all phase stories" — true of the
    # empty set.
    #
    # Live 2026-08-11, AMSD-2041/gotransit (novel): the suite was RED with ten broken suites,
    # this step deferred, 3.55 examined nothing, the phase reported SUCCESS, and the broken code
    # was already committed.
    #
    # A finding that exists only in a log line cannot be inherited. Stamped onto the story here
    # — the same mechanism 3.55 already uses when IT blocks (reviewStatus/reproGate below) — so
    # any later gate can see it regardless of which stories that gate selects.
    # INHERITED FAILURES ARE NOT THIS RUN'S TO ANSWER FOR.
    #
    # Operator policy: "For brownfield we [inherit] existing test failures, but we cannot be
    # expected to fix them." Without a baseline this step stamps suiteState=red on ANY red suite,
    # so a codeline carrying pre-existing failures would block every run on breakage it did not
    # cause — the inverse of the policy.
    #
    # Same mechanism the type check already uses: run the suite at the baseline SHA in a
    # throwaway worktree, cache by SHA, subtract on identity. The suite output this step already
    # captured is handed in, so the current run is not repeated.
    #
    # An UNDECLARED parse (no test.failurePattern) returns unknown, the delta declines, and the
    # stamp proceeds — reporting everything rather than guessing. That refusal is deliberate.

    if [ "$_uit_failed" -ne 0 ] && command -v baseline_new_failures >/dev/null 2>&1; then
        _uit_log="$LOG_DIR/update-invalidated-tests-${PHASE}.log"
        if [ -f "$_uit_log" ]; then
            if baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                   "$LOG_DIR" test "$_uit_log" >/dev/null 2>&1; then
                success "Step 3.545: the suite is red, but every failing suite was already failing at the baseline — none introduced by this phase."
                _uit_failed=0
            fi
        fi
    fi

    if [ "$_uit_failed" -eq 0 ]; then
        # RECOVERED. Clear anything an earlier pass stamped, or Step 3.55 fails a phase whose
        # suite is green — which is exactly what happened on 2026-08-15.
        _clear_suite_state_for_phase "$PRD_FILE" "$PHASE"
    fi

    if [ "$_uit_failed" -ne 0 ]; then
        warning "Step 3.545: could not reconcile a failing test — recording suiteState=red on the affected stories; a later gate must resolve or fail on it."
        while IFS= read -r _uit_story; do
            [ -z "$_uit_story" ] && continue
            _tmp_prd="$(mktemp)"
            if jq --arg id "$_uit_story" \
                '(.stories[] | select(.id == $id)) |= (. + {suiteState: "red", suiteStateStep: "3.545"})' \
                "$PRD_FILE" > "$_tmp_prd" 2>/dev/null; then
                mv "$_tmp_prd" "$PRD_FILE"
            else
                rm -f "$_tmp_prd"
                error "Step 3.545: could not record suiteState on $_uit_story — refusing to continue with an unrecorded RED suite."
                exit 2
            fi
        done < <(jq -r --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories[] | select(.id as $id | $ids | index($id) != null) | .id' \
            "$PRD_FILE" 2>/dev/null)
    fi
fi

# ──────────────────────────────────────────────
# Step 3.55: Bug-reproduction test gate (brownfield, hard) — runs BEFORE review.
# The fix + test are committed by now; require that each story's new test actually
# REPRODUCES the bug (fails on the pre-fix baseline, passes with the fix). A change
# that ships no test, or a test that passes without the fix, BLOCKS the phase.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/brownfield-repro-test-gate.sh" ]; then
    log "Step 3.55: Bug-reproduction test gate (brownfield)..."
    _repro_blocked=0
    while IFS= read -r _rg_story; do
        [ -z "$_rg_story" ] && continue
        # This script runs under `set -e` WITHOUT pipefail, so `if ! gate | tee`
        # tests tee's exit (always 0) — the gate's `exit 1` on BLOCK was swallowed
        # and a testless change PASSED (live AMSD-1820 run #3). Capture the gate's
        # real exit via ${PIPESTATUS[0]}; tee exits 0 so `set -e` is not tripped.
        # NO GUESSED BRANCH — see Step 3.54. The gate resolves its own when none is declared.
        PROJECT_ROOT="$PROJECT_ROOT" JIRA_BASELINE_BRANCH="${JIRA_BASELINE_BRANCH:-}" \
             bash "$SCRIPT_DIR/brownfield-repro-test-gate.sh" "$_rg_story" 2>&1 | tee -a "$LOG_DIR/repro-gate-${PHASE}.log"
        _rg_rc=${PIPESTATUS[0]}
        if [ "${_rg_rc:-1}" -ne 0 ]; then
            warning "Step 3.55: reproduction gate BLOCKED $_rg_story (gate exit ${_rg_rc})"
            _repro_blocked=1
            # THE FINDING HAS TO LAND ON THE STORY. Step 3.545 hard-fails when it cannot record
            # suiteState, for the same reason: a block that exists only in a log line cannot be
            # inherited, so the retry does not know which story failed and re-runs it unchanged.
            # This swallowed the write with `|| rm -f`.
            _tmp_prd="$(mktemp)"
            if jq --arg id "$_rg_story" \
                '(.stories[] | select(.id == $id)) |= (. + {reviewStatus: "escalated", reproGate: "failed"})' \
                "$PRD_FILE" > "$_tmp_prd" 2>/dev/null; then
                mv "$_tmp_prd" "$PRD_FILE"
            else
                rm -f "$_tmp_prd"
                error "Step 3.55: could not record the reproduction-gate block on $_rg_story — the retry would not know it failed."
                exit 2
            fi
        fi
    # Only stories with a bug to reproduce. A novel story cannot satisfy
    # fail-on-baseline and is deliberately not gated here (fe5d6cb).
    done < <(phase_stories_for_repro_gate "$PRD_FILE" "$PHASE")
    if [ "$_repro_blocked" -eq 1 ]; then
        error "Step 3.55: one or more stories failed the bug-reproduction test gate — the fix does not ship a test that reproduces the bug. Blocking before review."
        exit 2
    fi

    # INHERITED RED, from a step that could not judge it itself.
    #
    # The loop above deliberately skips novel stories, so `_repro_blocked` alone says nothing
    # about them — it reports the empty set as a pass. Step 3.545 records suiteState=red when it
    # cannot reconcile a failing test; this is where that finding is enforced, for EVERY story in
    # the phase rather than only the ones this gate selects.
    #
    # Without it: AMSD-2041 (novel), ten broken suites, both steps individually correct, phase
    # green, broken code committed.
    _inherited_red=$(jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         [ .stories[] | select(.id as $id | $ids | index($id) != null)
                      | select(.suiteState == "red") | .id ] | join(" ")' \
        "$PRD_FILE" 2>/dev/null)
    if [ -n "${_inherited_red// /}" ]; then
        error "Step 3.55: the test suite is RED for: ${_inherited_red}. Step 3.545 could not reconcile it and this gate does not examine these stories (novel stories are excluded by design), so nothing downstream would judge it. Blocking before review."
        exit 2
    fi

    success "Step 3.55: bug-reproduction test gate passed, and no story carries an unresolved RED suite"
fi

# ──────────────────────────────────────────────
# Step 3.56: Verification-criteria coverage report (brownfield, advisory).
# Does the story's test cover every verification criterion it was accepted
# against? Run 7 covered two of three and silently skipped the negative case —
# the repro gate cannot see that, because it only asks whether the test fails
# before the fix and passes after.
#
# ADVISORY: reports, never blocks.
#
# Runs over the FULL brownfield scope, not the repro gate's narrower set. This
# lived inside the gate's success branch, so a novel story — which the gate never
# selects — skipped coverage reporting as silently as it skipped test authoring.
# A novel story is precisely the case where VCs are the only definition of done,
# so it is the last one that should go unreported.
# ──────────────────────────────────────────────
if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/vc-coverage-check.sh" ]; then
    # story_outputs_tests lives in lib/story-outputs.sh, which is otherwise only
    # sourced inside _brownfield_gate_scope — so at this point in the run it may
    # not exist yet. Run 8: it did not, the call failed into /dev/null, and the
    # check vanished without a word.
    [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"
    while IFS= read -r _vc_story; do
        [ -z "$_vc_story" ] && continue
        # THIS STORY'S TEST, not the phase's first. story_outputs_tests reads the PHASE
        # manifest, which carries no story attribution — so `| head -1` gave every story the
        # same file and reported one story's coverage against another story's test. The check
        # ran, produced an artefact, and measured the wrong thing.
        _vc_test_file=$(story_outputs_tests_for "$PROJECT_ROOT" "$LOG_DIR" "$_vc_story" 2>/dev/null | head -1)
        if [ -n "$_vc_test_file" ]; then
            bash "$SCRIPT_DIR/vc-coverage-check.sh" \
                --prd "$PRD_FILE" --story "$_vc_story" \
                --test-file "$PROJECT_ROOT/$_vc_test_file" \
                --out "$LOG_DIR/vc-coverage-${_vc_story}.json" 2>&1 \
                | tee -a "$LOG_DIR/vc-coverage-${PHASE}.log" || true
        else
            # Never silent: "no test to check" and "everything covered" must not
            # look the same in the report.
            warning "  [vc-coverage] no test file in the writer manifest for ${_vc_story} — coverage NOT checked"
            # AND NEVER ABSENT. The warning goes to a log; the ARTIFACT is what a report, a
            # rerun or a human reads, and writing nothing meant absence had to be interpreted —
            # indistinguishable from a check that ran and found everything covered. That is the
            # shape of the coverage gate returning `complete: null` while claude.sh read null
            # as pass, which ran fail-open for its entire life. The survey sanitiser already
            # states the rule: silence is not a state.
            # AND THE WRITE ITSELF IS NOT SILENCED. This ended in `2>/dev/null || true` — so the
            # artefact whose whole purpose is that absence must never have to be interpreted
            # could fail to appear, silently, restoring exactly the ambiguity the comment above
            # exists to remove.
            if ! jq -n --arg s "$_vc_story" \
                '{state:"not_checked", story:$s, results:[],
                  reason:"this story committed no test file — nothing to check the verification criteria against"}' \
                > "$LOG_DIR/vc-coverage-${_vc_story}.json"; then
                warning "  [vc-coverage] could not write the not_checked record for ${_vc_story} — its absence must not be read as covered"
            fi
        fi
    done < <(phase_stories_brownfield_scope "$PRD_FILE" "$PHASE")
fi

# Step 3.58: Regression delta gate (RG-DELTA) — the "after" half of the
# before/after comparison Step 5's baseline capture set up. Compares the
# failing-test set AFTER this phase's implementation against Step 5's
# tolerated baseline (regression-guard-baseline-<phase>.json) — pass only if
# after is a subset of the baseline (nothing NEW broke), fail if a test that
# was NOT in the baseline now fails. A count-only comparison would miss a
# real regression when the total count stays the same but the IDENTITY
# differs, so this compares real test identities via testFailurePattern, not
# counts.
#
# Gated to effort:"high" stories only (user decision, 2026-07-31): re-running
# the entire suite a second time has a real cost, and most brownfield stories
# are narrow enough that their own TC-writer test + team-lead review is
# sufficient coverage. AMSD-2041 itself — effort:"low" despite spanning 3
# codelines — is the concrete case that should NOT pay this cost; complexity
# (CPA's own classification), not file/codeline count, is the trigger.
#
# Same fallback semantics as Step 5: no testFailurePattern configured, or no
# effort:"high" story in this phase, or SKIP_REGRESSION_GUARD=true, and this
# step is a no-op — never changes behavior for a project that hasn't opted in.
if ! is_truthy "${SKIP_REGRESSION_GUARD:-}"; then
    _rgd_pattern=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
        _rgd_pattern=$(jq -r '.testFailurePattern // empty' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null)
    fi
    _rgd_high_effort=0
    if [ -n "$_rgd_pattern" ] && [ -f "${PRD_FILE:-}" ]; then
        if jq -e --arg phase "$PHASE" '
              (.implementationOrder[$phase] // []) as $ids |
              any(.stories[]?; (.id as $sid | ($ids | index($sid)) != null) and .effort == "high")
            ' "$PRD_FILE" >/dev/null 2>&1; then
            _rgd_high_effort=1
        fi
    fi
    if [ -n "$_rgd_pattern" ] && [ "$_rgd_high_effort" = "1" ] && \
       [ -n "${_rg_root:-}" ] && [ -n "${_rg_test_cmd:-}" ] && [ "${_rg_test_declared:-0}" -eq 1 ]; then
        step_emit "3.58" "running" "Step 3.58: Regression delta gate"
        log "Step 3.58: Regression delta gate — re-running $_rg_test_cmd in $_rg_root (effort:high story in phase '$PHASE')..."
        _rgd_baseline_file="$LOG_DIR/regression-guard-baseline-${PHASE}.json"
        _rgd_max="${EPAM_REGRESSION_GUARD_RETRIES:-2}"
        _rgd_max=$(( _rgd_max + 1 ))
        _rgd_log="$LOG_DIR/regression-delta-${PHASE}.log"
        for _rgd_try in $(seq 1 "$_rgd_max"); do
            _rgd_try_log="$_rgd_log"
            [ "$_rgd_try" -gt 1 ] && _rgd_try_log="${_rgd_log%.log}-attempt-${_rgd_try}.log"
            # The project's OWN command, same as the guard above. Assembling "<pm> test" assumed an
            # ecosystem whose package manager takes a test subcommand.
            (cd "$_rg_root" && PATH="${_rg_node:+$(dirname "$_rg_node"):}$PATH" run_test_bounded "$(resolve_test_workers)" sh -c "$_rg_test_cmd") > "$_rgd_try_log" 2>&1 || true
        done
        _rgd_result=$(python3 "$SCRIPT_DIR/lib/handlers/rgd-diff.py" "$_rgd_pattern" "$_rgd_max" "$_rgd_log" "$_rgd_baseline_file"
)
        _rgd_verdict=$(echo "$_rgd_result" | python3 -c "import json,sys; print(json.load(sys.stdin)['verdict'])" 2>/dev/null || echo unknown)
        if [ "$_rgd_verdict" = "pass" ]; then
            step_emit "3.58" "pass" "Step 3.58: Regression delta gate"
            success "Step 3.58: Regression delta gate PASSED — no new test failures beyond the tolerated baseline"
        else
            step_emit "3.58" "fail" "Step 3.58: Regression delta gate"
            _rgd_new=$(echo "$_rgd_result" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin)['new_failures']))" 2>/dev/null || echo "")
            if [ "$_rgd_verdict" = "unknown" ]; then
                # SAY WHICH "cannot verify" THIS IS. There are three now — an uncompilable
                # pattern, a suite that produced no output, and a missing tolerated baseline —
                # and they are fixed in three different places. Naming only the pattern sent
                # every investigation at dependency-check.json.
                _rgd_reason=$(printf '%s' "$_rgd_result" \
                    | python3 "$SCRIPT_DIR/lib/handlers/json-field.py" reason 2>/dev/null || echo "")
                error "Step 3.58: Regression delta gate CANNOT VERIFY — ${_rgd_reason:-testFailurePattern does not compile as a regex}"
                error "  This is not a confirmed regression, but it cannot be ruled out either."
            else
                error "Step 3.58: Regression delta gate FAILED — this phase's changes broke test(s) that were passing at baseline: $_rgd_new"
                error "  Pre-existing failures are tolerated; these are NEW."
            fi
            error "  Bypass with: SKIP_REGRESSION_GUARD=true"
            exit 1
        fi
    else
        step_emit "3.58" "skip" "Step 3.58: Regression delta gate" "no effort:high story in this phase, or testFailurePattern not configured"
    fi
else
    step_emit "3.58" "skip" "Step 3.58: Regression delta gate" "SKIP_REGRESSION_GUARD=true"
fi

# Step 3.6: Team Lead Code Review — with a review → re-implement → re-review loop.
# ──────────────────────────────────────────────
# The reviewer can now TELL the impl agent to make changes: on changes_requested
# it writes review-feedback-<id>.json, which the re-implementation reads (see
# build_implementation_prompt) and the impl agent's own self-heal (failure-analyst
# + agent-KB) refines. Bounded by REVIEW_MAX_CYCLES; on exhaustion the story is
# marked escalated and the pipeline hard-blocks (a change that keeps failing
# review must never silently merge).
log "Step 3.6: Running Team Lead code review for phase..."
_emit_agent start "review-agent" "Team Lead Code Review"

# The ladder-exhaustion default: same default MAX_RETRIES claude.sh itself
# uses (rung = retry_count/2, so MAX_RETRIES=7 -> 4 rungs, top rung 3).
_review_max_retries="${EPAM_MAX_RETRIES:-7}"
# SAFETY VALVE ONLY, not the primary escalation trigger. Standing requirement:
# "Retries MUST proceed up the rungs — nothing is allowed to intercede." A
# story may only be escalated once ITS OWN ladder is exhausted (checked below
# via story_ladder_exhausted), never on a bare cycle count. This cap exists
# purely so a misconfigured or never-settling reviewer cannot loop forever;
# set comfortably above the ladder's own depth so it should not fire in
# normal operation — if it does, that itself is a signal worth investigating,
# logged as such below rather than silently treated as ordinary exhaustion.
# DERIVED from the ladder's real depth, never a magic number. The ladder is
# 2 attempts per rung (rung = retry_count/2), so it has (MAX_RETRIES/2)+1 rungs;
# a review cycle can advance at most one rung, and +2 leaves headroom for the
# cycles that re-run the REVIEWER rather than the writer (review_feedback_is_
# incomplete). Ladder exhaustion is what actually stops the loop — this only
# has to be large enough never to fire first. An explicit REVIEW_MAX_CYCLES
# still wins for an operator who wants a hard ceiling.
_review_max_cycles="${REVIEW_MAX_CYCLES:-$(( _review_max_retries / 2 + 3 ))}"
_review_cycle=1
# Direct escalation flag. The hard-block below USED to rely solely on stories
# being tagged reviewStatus=escalated by iterating review-feedback-*.json files —
# but when the reviewer produced NO such files (found live 2026-07-24, AMSD-1820:
# review escalated after 2 cycles yet 0 feedback files existed), nothing got
# tagged, the jq count was 0, and a change the reviewer NEVER approved fell
# through to PASSED. The loop itself knows it escalated; block on that fact
# directly, independent of any file the reviewer may or may not have written.
_review_escalated=0




while true; do
    _review_fp_now="$(_review_tree_fingerprint)"
    # Guarded so an unloaded library is skipped rather than fatal: an undefined function
    # returns 127, and `|| exit 1` on that silently killed the enclosing block wherever a
    # harness runs this code with the gate library absent. The orchestrator sources it at the
    # top, and pre-flight is what actually gates a run.
    declare -f require_stage_coverage >/dev/null && { require_stage_coverage gates || exit 1; }
    if "$SCRIPT_DIR/team-lead-review.sh" "$PHASE"; then
        if _review_approval_is_giveup "${_review_prev_blocker:-0}" "${_review_prev_fp:-}" "$_review_fp_now"; then
            error "Step 3.6: review APPROVED after a blocker-level rejection, with the codeline UNCHANGED since that rejection."
            error "Step 3.6: the verdict changed and the code did not — the blocker was never resolved. Escalating instead of approving."
            _emit_agent complete "review-agent" "Code review escalated (approval after unresolved blocker)"
            # NO REMEDY IS CLAIMED HERE. This called `_escalate_story_review`, which is defined
            # nowhere in the engine, wrapped in `|| true` so its absence could not even fail the
            # line. Live 2026-08-20: "Escalating instead of approving." followed immediately by
            # "_escalate_story_review: command not found", and the story carried on. The array it
            # iterated is not assigned until further below, so on this path it was empty anyway.
            #
            # The REFUSAL below is what actually took effect and is what matters: the loop exits
            # without recording the approval. Announcing an action the engine cannot take is worse
            # than announcing none — an operator reads the log and believes it was handled.
            #
            # The flip-flop this tried to compensate for is now prevented at its source: the
            # reviewer receives its own prior verdicts and is told an unresolved blocker still
            # stands (1f24c70).
            break
        fi
        success "Team Lead code review APPROVED for phase '$PHASE' (cycle $_review_cycle)"
        # Clear a reviewStatus:"escalated" tag left by an EARLIER cycle of
        # this same phase-retry sequence — found live 2026-08-02 (Writer
        # Retest run): a phase-level retry (after an unrelated later gate
        # failure) re-ran Step 3.6 from scratch; its first pass escalated
        # after 2 cycles (tagging reviewStatus:escalated), a LATER retry's
        # review then genuinely APPROVED the same story, but the hard-block
        # check below still found the stale tag from the earlier escalation
        # and blocked a change the reviewer HAD approved. Nothing ever
        # cleared it on a subsequent real approval — scoped to this phase's
        # own story IDs, same scoping the hard-block check itself uses.
        _tmp_prd_clear="$(mktemp)"; jq --arg phase "$PHASE" \
            '(.implementationOrder[$phase] // []) as $ids |
             .stories |= map(if (.id as $id | $ids | index($id) != null) and .reviewStatus == "escalated"
                              then . + {reviewStatus: null} else . end)' \
            "$PRD_FILE" > "$_tmp_prd_clear" 2>/dev/null && mv "$_tmp_prd_clear" "$PRD_FILE" || rm -f "$_tmp_prd_clear"
        _emit_agent complete "review-agent" "Code review approved"
        break
    fi
    # changes_requested — team-lead-review.sh wrote review-feedback-<id>.json per story.
    # B24 — is this "the code needs changing" or "the REVIEWER failed"?
    # (predicate: review_feedback_is_incomplete, defined near the top)
    # team-lead-review.sh fails SAFE when its agent produces no verdict: it emits a
    # synthetic changes_requested so an unreviewed change can never auto-approve.
    # But that verdict is PHASE-level, so no per-story review-feedback-<id>.json
    # exists — and the loop below then "re-implements" nothing at all. Live
    # 2026-07-24: two entirely empty cycles, then escalation with tagged-stories=0,
    # on a story whose fix AND verified reproducing test had passed every gate.
    # Re-implementing is the wrong response when the story was never the problem.
    if review_feedback_is_incomplete; then
        rm -f "$LOG_DIR/review-incomplete-${PHASE}.flag" 2>/dev/null || true

        # BOUNDED. This branch used to `continue` straight past the safety valve below, so it
        # was the ONE exit from `while true` with no ceiling on it. Live 2026-08-12: the
        # reviewer died on a bash runtime error (`local` at top level, 2bb230e) and this ran
        # 701 CYCLES on a story that had already implemented cleanly — 18 minutes, and it
        # would have continued to the story wall.
        #
        # Retrying a missing verdict is right ONCE OR TWICE (a model can return junk once) and
        # wrong forever after: a reviewer that cannot execute produces no verdict every time,
        # and no number of retries changes that. The loop cannot tell those apart, which is
        # exactly why it must be bounded rather than trusting.
        #
        # Reuses _review_max_cycles — the bound that already exists and already means "how many
        # times may this loop go round". A second counter would be a second thing to maintain.
        _review_noverdict_cycles=$(( ${_review_noverdict_cycles:-0} + 1 ))
        if [ "$_review_noverdict_cycles" -ge "$_review_max_cycles" ]; then
            error "Step 3.6: the REVIEWER produced NO VERDICT ${_review_noverdict_cycles} time(s) in a row (limit ${_review_max_cycles}) — it is not failing to approve, it is failing to RUN."
            error "         Nothing was reviewed. The change is NOT approved and this phase must not proceed."
            error "         Check the reviewer itself before re-running: bash -n does not catch a runtime error; try"
            error "           shellcheck -S error orchestrations/scripts/team-lead-review.sh"
            error "         and read the reviewer's own stderr in $LOG_DIR."
            exit 2
        fi
        warning "Step 3.6: the REVIEWER did not produce a verdict (no per-story feedback) — re-running the REVIEW, not re-implementing (cycle $_review_cycle → $((_review_cycle + 1)), no-verdict ${_review_noverdict_cycles}/${_review_max_cycles})"
        _review_cycle=$((_review_cycle + 1))
        continue
    fi
    # A verdict arrived: the reviewer is alive. Reset the streak so an earlier transient miss
    # cannot accumulate across a healthy run and trip the limit later.
    _review_noverdict_cycles=0
    # Partition rejected stories: a story whose ladder is ALREADY exhausted
    # (its persisted rung has reached the top — see lib/story-retry-state.sh)
    # has nothing left to try and escalates now, regardless of cycle count. A
    # story that can still climb is re-implemented. Standing requirement:
    # "Retries MUST proceed up the rungs — nothing is allowed to intercede" —
    # a fixed cycle cap must never cut a climbable story off early.
    _review_climbable_stories=()
    for _fb in "$LOG_DIR"/review-feedback-*.json; do
        [ -f "$_fb" ] || continue
        _fb_story="$(basename "$_fb" | sed 's/^review-feedback-//; s/\.json$//')"
        if story_ladder_exhausted "$LOG_DIR" "$_fb_story" "$_review_max_retries"; then
            warning "Step 3.6: $_fb_story's ladder is exhausted (already tried its top rung) — escalating"
            _review_escalated=1
            _escalate_review_story "$_fb" "$_fb_story"
        else
            _review_climbable_stories+=("$_fb_story:$_fb")
        fi
    done

    if [ "${#_review_climbable_stories[@]}" -eq 0 ]; then
        # Every rejected story has exhausted its ladder — nothing left to retry.
        _emit_agent complete "review-agent" "Code review escalated (every rejected story's ladder is exhausted)"
        break
    fi

    if [ "$_review_cycle" -ge "$_review_max_cycles" ]; then
        # Safety valve. Should not fire in normal operation — ladder
        # exhaustion above bounds this first at 4 rungs (default
        # MAX_RETRIES=7). If it does fire, that itself means the ladder-
        # exhaustion accounting is out of sync with reality; log loudly
        # rather than silently treating it as ordinary exhaustion.
        warning "Step 3.6: hit the ${_review_max_cycles}-cycle SAFETY VALVE with ${#_review_climbable_stories[@]} stor(y/ies) still not ladder-exhausted — escalating anyway. This should not happen; investigate the ladder-exhaustion accounting."
        _review_escalated=1
        for _entry in "${_review_climbable_stories[@]}"; do
            _fb_story="${_entry%%:*}"; _fb="${_entry#*:}"
            _escalate_review_story "$_fb" "$_fb_story"
        done
        _emit_agent complete "review-agent" "Code review escalated (safety-valve cycle cap)"
        break
    fi

    # Remember whether THIS rejection carried a blocker, and what the tree looked like, so the
    # next cycle's approval can be checked against it.
    _review_prev_blocker=0
    for _fbf in "${LOG_DIR}"/review-feedback-*.json; do
        [ -f "$_fbf" ] || continue
        if jq -e '[.issues // [] | .[] | select((.severity // "") == "blocker")] | length > 0' "$_fbf" >/dev/null 2>&1; then
            _review_prev_blocker=1; break
        fi
    done
    _review_prev_fp="$_review_fp_now"
    warning "Step 3.6: review requested changes — re-implementing (cycle $_review_cycle → $((_review_cycle + 1)))"
    for _entry in "${_review_climbable_stories[@]}"; do
        _fb_story="${_entry%%:*}"
        # A review rejection is itself evidence this attempt did not succeed,
        # even when the code built/tested fine internally — advance the
        # story's persisted rung BEFORE re-invoking, or the next claude.sh
        # subprocess (run_story_with_watchdog spawns a fresh one) silently
        # resumes at the SAME rung, and the ladder never climbs on a
        # review-rejection-only failure. This is the exact live bug fixed
        # this session: two review cycles both logged Rung0/R1.
        advance_story_retry_rung "$LOG_DIR" "$_fb_story" "$_review_max_retries"
        # Without this reset, the retry below is a guaranteed no-op. Step 8 marks a
        # story `completed` the moment the agent's turn ends — regardless of
        # whether the reviewer will accept it — and run_story_with_watchdog
        # invokes claude.sh "$story_id", whose FIRST check is
        # is_story_completed. Live AMSD-2041 2026-07-30: the reviewer rejected
        # with 7 blockers, this loop logged "Re-implementing... (self-heal
        # enabled)", and within the same second: "Story AMSD-2041 is already
        # completed, skipping" / "Implemented: 0, Failed: 0, Skipped: 1" — zero
        # new code, zero new review evidence, one of REVIEW_MAX_CYCLES's two
        # cycles wasted on every rejection. Scoped to exactly this ONE story:
        # a sibling that already passed review must not be re-run.
        _reset_story_for_reimplementation "$_fb_story"
        log "  Re-implementing $_fb_story to address reviewer feedback (self-heal enabled)..."
        # claude.sh reads review-feedback-<id>.json (injects it into the impl
        # prompt) and its existing failure-analyst self-heal + agent-KB run on any
        # test failure during the re-implementation.
        # NOT `|| true`. This is the one attempt to address a rejection the reviewer already
        # made; discarding its exit status meant the re-implementation could fail outright and
        # the loop moved on as though it had run, burning a review cycle on unchanged code with
        # nothing in the log to say why.
        _rr_rc=0
        run_story_with_watchdog "$_fb_story" "$LOG_DIR/main-${_fb_story}-rereview${_review_cycle}.log" || _rr_rc=$?
        if [ "$_rr_rc" -ne 0 ]; then
            warning "  Re-implementation of $_fb_story FAILED (exit ${_rr_rc}) — the reviewer's feedback was not addressed this cycle; see $LOG_DIR/main-${_fb_story}-rereview${_review_cycle}.log"
        fi
    done
    _review_cycle=$((_review_cycle + 1))
done

# Hard-block if any story was escalated (review loop exhausted without approval).
_escalated=$(jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     [.stories[] | select(.id as $id | $ids | index($id) != null) |
      select(.reviewStatus == "escalated")] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0")
if [ "${_review_escalated:-0}" -eq 1 ] || [ "${_escalated:-0}" -gt 0 ]; then
    error "Step 3.6: review changes unresolved after $_review_cycle cycle(s), ladder exhausted (escalated: flag=${_review_escalated:-0} tagged-stories=${_escalated:-0})"
    error "         A change the reviewer never approved must NOT proceed — human review required."
    # EXIT 3, NOT 2. This is a HALT, not a remediation. Every caller used to read 2 as
    # "a fix was applied, retry" and re-ran the phase — which hard-reset the branch,
    # orphaned the already-green committed work, and burned 12 attempts against a
    # ladder with nothing left to escalate to (live, 20260814T213253Z). The retryable
    # /not-retryable distinction is defined once in lib/phase-exit.sh.
    exit 3
fi

# ──────────────────────────────────────────────
# Step 3.7: Pre-review build gate
# Runs vitest + tsc unconditionally before review agents see the code.
# Blocks review if tests fail. Skip with SKIP_PRE_REVIEW_GATE=true.
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && [ -f "$PROJECT_ROOT/package.json" ]; then
    step_emit "19" "running" "Step 19: Pre-review gate"
    log "Step 19: Pre-review build gate (vitest + tsc)..."
    _pre_review_log="$LOG_DIR/pre-review-gate-${PHASE}.log"
    _pre_review_failed=0
    _node_bin="$(detect_node)"

    if [ -z "$_node_bin" ]; then
        warning "Step 19: Node binary not found — skipping pre-review gate"
    else
        echo "=== Pre-Review Gate: $PHASE @ $(date -Iseconds) ===" > "$_pre_review_log"
        cd "$PROJECT_ROOT"

        log "  Running vitest..."
        # Bounded timeout (added 2026-07-06): every vitest/npm invocation in
        # this file and claude.sh was unguarded — a live run's story-level
        # watchdog silently absorbed a hang in one of these (network-dependent
        # npm install, or a test that leaves a server/resource open) with zero
        # diagnostic signal about which command was actually stuck. Same fix
        # applied consistently across every instance in this file.
        _pr_test_cmd="$(_codeline_test_command "$PROJECT_ROOT")"
        if [ -z "$_pr_test_cmd" ]; then
            # An absent declaration is not a failure of the code under review. Reporting it as
            # "tests failed" blamed the story for the engine being unable to ask.
            warning "  Step 19: ${PROJECT_ROOT} declares no test command — pre-review tests NOT run"
            _pre_review_failed=1
        elif run_test_bounded "$(resolve_test_workers)" timeout "${EPAM_TEST_TIMEOUT_SECS:-300}" sh -c "$_pr_test_cmd" \
                2>&1 | tee -a "$_pre_review_log"; then
            success "  vitest: PASS"
            "$SCRIPT_DIR/update-monitor.sh" event "pre_review_test_pass" \
                "Pre-review vitest passed for $PHASE" "" "main" "unit-test-runner" 2>/dev/null || true
        else
            error "  vitest: FAIL — fix test failures before review proceeds"
            "$SCRIPT_DIR/update-monitor.sh" event "pre_review_test_fail" \
                "Pre-review vitest FAILED for $PHASE" "" "main" "unit-test-runner" 2>/dev/null || true
            _pre_review_failed=1
        fi

        log "  Running the project's declared type check..."
        _tsc_exit=0
        # No stack precondition — see lib/story-guards.sh. An undeclared project is refused
        # by the helper, not skipped, so there is nothing to pre-check here.
        if true; then
            _run_project_verification "$PROJECT_ROOT" 2>&1 | tee -a "$_pre_review_log"
            _tsc_exit=${PIPESTATUS[0]}
            if [ "$_tsc_exit" -eq 0 ]; then
                success "  tsc: PASS"
            else
                error "  tsc: FAIL — fix type errors before review proceeds"
                # Diagnostic instrumentation (2026-07-23): a recurring, so-far
                # unreproducible-in-isolation TS5108 (moduleResolution=node10)
                # failure at this exact step, with a tsconfig.json PROVEN
                # byte-identical to a known-good, passing config both before
                # and after. `tsc --showConfig` prints TypeScript's actual
                # RESOLVED configuration (post any `extends`/inheritance/
                # implicit-default resolution) — this is the ground truth,
                # not a guess, for what TS is really using, independent of
                # what the raw tsconfig.json file's text says.
                {
                    echo "=== DIAGNOSTIC: tsc --showConfig (resolved config TS is actually using) ==="
                    "$_node_bin" ./node_modules/.bin/tsc --showConfig 2>&1
                    echo "=== DIAGNOSTIC: node/tsc binary identity ==="
                    echo "node_bin=$_node_bin -> $(readlink -f "$_node_bin" 2>/dev/null || echo "$_node_bin")"
                    echo "tsc=./node_modules/.bin/tsc -> $(readlink -f ./node_modules/.bin/tsc 2>/dev/null || echo unknown)"
                    echo "typescript package version: $(cat ./node_modules/typescript/package.json 2>/dev/null | grep -m1 '"version"')"
                    echo "=== DIAGNOSTIC: every tsconfig*.json under PROJECT_ROOT ==="
                    find "$PROJECT_ROOT" -iname "tsconfig*.json" -not -path "*/node_modules/*" 2>/dev/null | while read -r _tc; do
                        echo "--- $_tc ---"
                        cat "$_tc"
                    done
                    echo "=== DIAGNOSTIC: pwd and git state ==="
                    pwd
                    git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null
                    git -C "$PROJECT_ROOT" status --short 2>/dev/null
                } >> "$_pre_review_log" 2>&1
                _pre_review_failed=1
            fi
        fi

        echo "=== Gate Result: $([ $_pre_review_failed -eq 0 ] && echo PASS || echo FAIL) ===" \
            >> "$_pre_review_log"

        if [ $_pre_review_failed -ne 0 ]; then
            step_emit "19" "fail" "Step 19: Pre-review gate"
            error "Step 19: Pre-review gate FAILED — review agents blocked on broken build"
            error "  Fix failures, then re-run: $0 --phase $PHASE"
            error "  Bypass (emergency only): SKIP_PRE_REVIEW_GATE=true $0 --phase $PHASE"
            error "  Log: $_pre_review_log"
            exit 1
        fi

        step_emit "19" "pass" "Step 19: Pre-review gate"
            success "Step 19: Pre-review gate PASSED"
    fi
else
    is_truthy "${SKIP_PRE_REVIEW_GATE:-}" && \
        step_emit "19" "skip" "Step 19: Pre-review gate" "SKIP_PRE_REVIEW_GATE=true"
        info "Step 19: Pre-review gate skipped (SKIP_PRE_REVIEW_GATE=true)"
fi

# ──────────────────────────────────────────────
# Step 3.8: Lint gate — tsc + eslint on PROJECT_ROOT/src
# Runs after the pre-review vitest/tsc gate and before review stories.
# Catches syntax and type errors that agents introduce during Step 1 so they
# don't propagate to expensive quality gates (SAST, perf-sentinel, etc.).
# Bypass: SKIP_LINT_GATE=true
# ──────────────────────────────────────────────
if ! is_truthy "${SKIP_LINT_GATE:-}" && [ -n "$_node_bin" ] && [ -x "$_node_bin" ]; then
    step_emit "20" "running" "Step 20: Lint gate"
    log "Step 20: Lint gate (tsc + eslint)..."
    _lint_log="$LOG_DIR/lint-gate-${PHASE}.log"
    _lint_failed=0
    echo "=== Lint Gate: $PHASE @ $(date -Iseconds) ===" > "$_lint_log"

    # ── tsc --noEmit ──────────────────────────────────────────────────────────
    log "  [lint] Running the project's declared type check..."
    _lint_tsc_exit=0
    # No stack precondition — see lib/story-guards.sh.
    if true; then
        _run_project_verification "$PROJECT_ROOT" 2>&1 | tee -a "$_lint_log"
        _lint_tsc_exit=${PIPESTATUS[0]}
        if [ "$_lint_tsc_exit" -eq 0 ]; then
            success "  [lint] tsc: PASS"
        else
            error "  [lint] tsc: FAIL (exit $_lint_tsc_exit) — fix TypeScript errors before proceeding"
            _lint_failed=1
        fi
    fi

    # ── eslint (if binary present) ────────────────────────────────────────────
    _eslint_bin=""
    for _candidate in \
        "$PROJECT_ROOT/node_modules/.bin/eslint" \
        "$(command -v eslint 2>/dev/null)"; do
        [ -x "$_candidate" ] && { _eslint_bin="$_candidate"; break; }
    done

    # Verify eslint can actually resolve its config before running on src/.
    # File-existence checks alone are insufficient: ESLint 6.x doesn't support .cjs/.mjs
    # config formats even if the file exists. Use --print-config as a dry-run probe.
    # Probe with a file eslint will really be asked to lint — probing a stack the
    # run then fails to cover is how this gate passed its own preflight and still
    # examined nothing.
    _probe_file=""
    if [ -n "$_eslint_bin" ]; then
        for _ext in js jsx mjs cjs ts tsx mts cts vue svelte; do
            # THE PROBE MUST LOOK WHERE THE GATE WILL LINT. eslint_baseline_gate below is given
            # $PROJECT_ROOT — the whole repository — but this probe searched only src/. So a repo
            # laying its code out any other way (lib/, app/, packages/, or flat at the root) found
            # no probe file, took the "nothing to lint" branch, and eslint was SKIPPED on a
            # codebase it would have linted perfectly well. The probe decided the gate's fate on a
            # narrower question than the gate itself asks.
            _probe_file="$(find "$PROJECT_ROOT" -type f -name "*.${_ext}" \
                            -not -path '*/node_modules/*' -not -path '*/.git/*' \
                            -print -quit 2>/dev/null)"
            [ -n "$_probe_file" ] && break
        done
    fi
    _eslint_config=""
    if [ -n "$_eslint_bin" ] && [ -n "$_probe_file" ] && \
       cd "$PROJECT_ROOT" && "$_eslint_bin" --print-config "$_probe_file" > /dev/null 2>&1; then
        _eslint_config="confirmed"
    fi

    if [ -n "$_eslint_bin" ] && [ -z "$_probe_file" ]; then
        # Not a failure: there is nothing here for ESLint to have an opinion
        # about. Reporting this as FAIL would push an empty finding into the
        # remediation pipeline, which can only answer "could not map lint
        # failure to a story".
        info "  [lint] eslint: SKIP (no lintable source files anywhere in the repository)"
        echo "eslint: no lintable source files in $PROJECT_ROOT — nothing examined" >> "$_lint_log"
    elif [ -n "$_eslint_bin" ] && [ -n "$_eslint_config" ]; then
        # Delegated to lib/eslint-baseline-gate.sh — see that file's header for
        # why. In short: this used to be `eslint src/ --max-warnings 0`, which
        # (a) expands a bare directory using --ext, default .js, so on the live
        # TypeScript codeline it examined ZERO files and failed with exit 2, and
        # (b) judged the whole tree, so on any codeline carrying pre-existing
        # lint debt it fails on files no agent ever touched. The gate now judges
        # the writers' output against the phase baseline, and fixes what is
        # auto-fixable rather than buying a full phase re-run to correct
        # whitespace.
        # shellcheck disable=SC1090
        . "$SCRIPT_DIR/lib/eslint-baseline-gate.sh"
        _eslint_gate_rc=0
        eslint_baseline_gate "$PROJECT_ROOT" "$_eslint_bin" "$LOG_DIR" "$_lint_log" || _eslint_gate_rc=$?
        [ "$_eslint_gate_rc" -ne 0 ] && _lint_failed=1
    elif [ -n "$_eslint_bin" ]; then
        info "  [lint] eslint found but no config in PROJECT_ROOT — skipping eslint (tsc only)"
        echo "eslint: binary present but no config file found" >> "$_lint_log"
    else
        info "  [lint] eslint not found in project — skipping eslint (tsc only)"
        echo "eslint: not configured in project" >> "$_lint_log"
    fi

    echo "=== Gate Result: $([ "$_lint_failed" -eq 0 ] && echo PASS || echo FAIL) ===" >> "$_lint_log"

    if [ "$_lint_failed" -ne 0 ]; then
        # Try the cheap repair FIRST. Run 7 ended here with everything it existed
        # for already correct — grounded diagnosis, minimal fix, a test proven
        # RED→GREEN, review approved — over a string literal repeated four times
        # in fixture data. The only remediation on offer was to rewrite the story
        # and rebuild the entire phase, discarding a correct fix and a proven test
        # to address a duplicated string. Fix the finding; do not rebuild around it.
        #
        # Every edit is verified (lint clean, types compile, tests still pass) and
        # reverted on any failure, so the worst case is exactly where we were.
        if _lint_fix_findings_directly "$_lint_log" "$PHASE"; then
            step_emit "20" "pass" "Step 20: Lint gate" "findings repaired in place"
            _lint_failed=0
        fi
    fi

    if [ "$_lint_failed" -ne 0 ]; then
        step_emit "20" "fail" "Step 20: Lint gate"
        error "Step 20: Lint gate FAILED — running self-healing remediation pipeline..."

        # ── Self-healing: route lint failure through gate-finding-analyst ─────
        # Same three-agent pipeline as testing gates (step 4.2):
        #   Agent 1 (gate-finding-analyst):  extracts grounded finding from lint log
        #   Agent 2 (story-ac-remediator):   augments owning story ACs in PRD
        #   Agent 3 (profile-augmentor):     records anti-pattern in agent profile
        _lint_remediation_applied=0
        _lint_rem_log="$LOG_DIR/lint-remediation-${PHASE}.log"
        _profiles_file="${EPAM_AGENTS_DIR:-${AUTOMATION_DIR}/agents}/profiles.json"

        if ! is_truthy "${SKIP_GATE_REMEDIATION:-}" && [ -f "$_lint_log" ]; then
            # ── Self-heal KB (episodic tier) ─────────────────────────────────
            # The lint log is the project's type check + eslint output — deterministic tool
            # signal, exactly what the signature must be derived from. Recorded
            # here because gate remediation is a DIFFERENT mechanism from
            # claude.sh's story-implementation heal: a mock run proved the story
            # path never fires for a gate failure, so wiring only that one left
            # this whole class unrecorded. Flag-guarded; never fails the gate.
            if [ -f "$SCRIPT_DIR/lib/kb-apply.sh" ]; then
                # shellcheck disable=SC1090
                . "$SCRIPT_DIR/lib/kb-apply.sh"
                head -c "$(evidence_window lintLogChars)" "$_lint_log" 2>/dev/null | \
                    kb_record_episode "${_phase:-${PHASE:-core}}" "lint-gate" "lint gate failed" || true
            fi
            info "  [lint-gate:analyst] Extracting grounded finding from lint log..."
            # The evidence, gathered into files. The log used to arrive `head -200` — a truncation of
            # the very evidence the analyst attributes, cutting mid-file-list, so the findings nobody
            # looked at were exactly the ones dropped. It goes whole.
            _lf_outputs_file=$(mktemp "${TMPDIR:-/tmp}/lint-outputs-XXXXXX.txt")
            _lf_stories_file=$(mktemp "${TMPDIR:-/tmp}/lint-stories-XXXXXX.txt")
            if [ -f "$SCRIPT_DIR/lib/story-outputs.sh" ]; then
              . "$SCRIPT_DIR/lib/story-outputs.sh" 2>/dev/null || true
              story_outputs_files "$PROJECT_ROOT" "$LOG_DIR" > "$_lf_outputs_file" 2>/dev/null || true
            fi
            python3 -c "import json,sys; d=json.load(open('${MAIN_PRD_FILE:-$PRD_FILE}')); active=[s for s in d.get('stories',[]) if not s.get('completed')]; print(json.dumps([{k:s.get(k) for k in ('id','title','agentRole')} for s in active], indent=2))" > "$_lf_stories_file" 2>/dev/null || echo "[]" > "$_lf_stories_file"
            _lp_vals=$(mktemp "${TMPDIR:-/tmp}/lint-finding-analyst-vals-XXXXXX.json")
            _lp_role_file=$(mktemp "${TMPDIR:-/tmp}/lint-finding-analyst-role-XXXXXX.txt")
            jq -r --arg r "gate-finding-analyst" '.[$r] // ""' "$_profiles_file" > "$_lp_role_file" 2>/dev/null || : > "$_lp_role_file"
            jq_vals --rawfile profile "$_lp_role_file" \
                  --rawfile lint_log "$_lint_log" \
                  --rawfile writer_outputs "$_lf_outputs_file" \
                  --rawfile active_stories "$_lf_stories_file" \
                  --arg phase "$PHASE" \
                  '{"__PROFILE__":$profile,"__LINT_LOG__":$lint_log,"__WRITER_OUTPUTS__":$writer_outputs,"__ACTIVE_STORIES__":$active_stories,"__PHASE__":$phase}' > "$_lp_vals"
            # The codeline's own facts — this template declares them and nothing supplied them.
            # Stack facts are the RENDERER's job — engine-prompt.js adds exactly the stack
            # placeholders this template DECLARES. Pre-merging all seven here made the
            # renderer throw "was given values it does not use" on every template that
            # declares fewer, and the caller reported "cannot render its prompt". Four
            # seams could not run at all, the fuzz-weaver among them.
            _lint_finding_prompt="$(render_engine_prompt lint-finding-analyst "$_lp_vals")"
            rm -f "$_lp_vals" "$_lp_role_file"
            rm -f "$_lf_outputs_file" "$_lf_stories_file"
            _lint_finding_raw=""
            _lga_attempt=0
            while [ "$_lga_attempt" -lt 2 ] && [ -z "$_lint_finding_raw" ]; do
                _lga_prompt="$_lint_finding_prompt"
                _lga_model="$(seam_model_or_fail "gate-finding-analyst")"
                if [ "$_lga_attempt" -ge 1 ]; then
                    [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _lga_model="${ESCALATION_MODEL_HIGH}"
                    _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                    jq_vals \
                          --arg lint_finding_prompt "$_lint_finding_prompt" \
                          --arg lint_log "${_lint_log}" \
                          '{"__LINT_FINDING_PROMPT__":$lint_finding_prompt,"__LINT_LOG__":$lint_log}' > "$_rp_vals"
                    _lga_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" lint_gate_analyst)"
                    rm -f "$_rp_vals"
                fi
                # Full agent audit, 2026-07-31: gate-finding-analyst gets tool
                # access via TWO DIFFERENT mechanisms at its two call sites —
                # here, calling `epam run` directly bypasses ai-run.sh
                # entirely, so ai-run.sh's --no-tools-by-default gating never
                # applies and the CLI's own default (tools ON) is used. The
                # OTHER call site (self-heal remediation, agent 1/3, further
                # below) goes through ai-run.sh with an explicit
                # AI_GATE_ALLOW_TOOLS=1. Both are correct TODAY — this is a
                # maintainability tripwire, not a bug: if a future refactor
                # routes this call through ai-run.sh (e.g. for consistency
                # with the retry/cost-tracking helpers elsewhere in this
                # file) without also adding AI_GATE_ALLOW_TOOLS=1, it will
                # silently lose tool access the same way codeline-bridge-agent
                # did. See gate-finding-analyst-dual-mechanism.test.ts.
                _gate_provider="$(resolve_primary_provider "${ORCH_GATE_PROVIDER:-}")"
                _lga_raw="$(echo "$_lga_prompt" | \
                    timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run ${_gate_provider:+--provider "$_gate_provider"} \
                        --model "${_lga_model}" \
                        --json - 2>>"$_lint_rem_log" || echo "")"
                if [ -n "$_lga_raw" ]; then
                    _lint_finding_raw="$_lga_raw"
                else
                    [ "$_lga_attempt" -lt 1 ] && warning "  [lint-gate:analyst] attempt 1 returned no output — retrying with escalated model" || warning "  [lint-gate:analyst] all 2 attempts returned no output — skipping lint remediation"
                fi
                _lga_attempt=$(( _lga_attempt + 1 ))
            done
            _lint_story_id="$(echo "$_lint_finding_raw" | python3 -c "
import sys,json,re
raw=sys.stdin.read()
m=re.search(r'\{[^{}]*\"story_id\"[^{}]*\}', raw, re.DOTALL)
if m:
    try: print(json.loads(m.group(0)).get('story_id',''))
    except: pass
" 2>/dev/null || echo "")"

            if [ -n "$_lint_story_id" ]; then
                info "  [lint-gate:analyst] Finding mapped to story: $_lint_story_id"
                # Agent 2: story-ac-remediator — add AC to prevent recurrence
                info "  [lint-gate:remediator] Augmenting ACs for story $_lint_story_id..."
                _lac_acs_file=$(mktemp "${TMPDIR:-/tmp}/lint-acs-XXXXXX.txt")
                python3 -c "import json; d=json.load(open('${MAIN_PRD_FILE:-$PRD_FILE}')); [print(json.dumps(s.get('acceptanceCriteria', []), indent=2)) for s in d.get('stories',[]) if s.get('id')=='$_lint_story_id']" > "$_lac_acs_file" 2>/dev/null || echo "[]" > "$_lac_acs_file"
                _lp_vals=$(mktemp "${TMPDIR:-/tmp}/lint-ac-remediator-vals-XXXXXX.json")
                _lp_role_file=$(mktemp "${TMPDIR:-/tmp}/lint-ac-remediator-role-XXXXXX.txt")
                jq -r --arg r "story-ac-remediator" '.[$r] // ""' "$_profiles_file" > "$_lp_role_file" 2>/dev/null || : > "$_lp_role_file"
                jq_vals --rawfile profile "$_lp_role_file" \
                      --rawfile current_acs "$_lac_acs_file" \
                      --arg story_id "$_lint_story_id" \
                      --arg finding "$_lint_finding_raw" \
                      '{"__PROFILE__":$profile,"__CURRENT_ACS__":$current_acs,"__STORY_ID__":$story_id,"__FINDING__":$finding}' > "$_lp_vals"
                _lint_ac_prompt="$(render_engine_prompt lint-ac-remediator "$_lp_vals")"
                rm -f "$_lp_vals" "$_lp_role_file"
                rm -f "$_lac_acs_file"
                _lint_ac_raw=""
                _lrem_attempt=0
                while [ "$_lrem_attempt" -lt 2 ] && [ -z "$_lint_ac_raw" ]; do
                    _lrem_prompt="$_lint_ac_prompt"
                    _lrem_model="$(seam_model_or_fail "story-ac-remediator")"
                    if [ "$_lrem_attempt" -ge 1 ]; then
                        [ -n "${ESCALATION_MODEL_HIGH:-}" ] && _lrem_model="${ESCALATION_MODEL_HIGH}"
                        _rp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-vals-XXXXXX.json")
                        jq_vals \
                              --arg lint_ac_prompt "$_lint_ac_prompt" \
                              '{"__LINT_AC_PROMPT__":$lint_ac_prompt}' > "$_rp_vals"
                        _lrem_prompt="$(render_engine_prompt agent-retry-prefix "$_rp_vals" lint_remediator)"
                        rm -f "$_rp_vals"
                    fi
                    _gate_provider="$(resolve_primary_provider "${ORCH_GATE_PROVIDER:-}")"
                    _lrem_raw="$(echo "$_lrem_prompt" | \
                        timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run ${_gate_provider:+--provider "$_gate_provider"} \
                            --model "${_lrem_model}" \
                            --json - 2>>"$_lint_rem_log" || echo "")"
                    if [ -n "$_lrem_raw" ]; then
                        _lint_ac_raw="$_lrem_raw"
                    else
                        [ "$_lrem_attempt" -lt 1 ] && warning "  [lint-gate:remediator] attempt 1 returned no output — retrying with escalated model" || warning "  [lint-gate:remediator] all 2 attempts returned no output — skipping AC augmentation"
                    fi
                    _lrem_attempt=$(( _lrem_attempt + 1 ))
                done
                _lint_ac_tmp="$(mktemp)"
                echo "$_lint_ac_raw" > "$_lint_ac_tmp"
                _lint_acs_added="$( ( flock -w 10 200 || { error "  [lint-gate:remediator] Could not acquire lock on ${MAIN_PRD_FILE:-$PRD_FILE}"; return 1; }
                python3 "$SCRIPT_DIR/lib/handlers/lint-ac.py" "${MAIN_PRD_FILE:-$PRD_FILE}" "$_lint_story_id" "$_lint_ac_tmp" 2>/dev/null || echo "0"
                ) 200>"${MAIN_PRD_FILE:-$PRD_FILE}.lock" )"
                rm -f "$_lint_ac_tmp"
                if [ "${_lint_acs_added:-0}" -gt 0 ]; then
                    success "  [lint-gate:remediator] ${_lint_acs_added} AC(s) added to $_lint_story_id"
                    _lint_remediation_applied=1
                fi

                # Agent 3: profile-augmentor — 1 retry on empty output
                info "  [lint-gate:augmentor] Recording lint anti-pattern in profile..."
                _gate_provider="$(resolve_primary_provider "${ORCH_GATE_PROVIDER:-}")"
                _laug_raw="$(echo "$_lint_finding_raw" | \
                    timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run ${_gate_provider:+--provider "$_gate_provider"} \
                        --model "$(seam_model_or_fail "gate-finding-analyst")" \
                        --json - 2>>"$_lint_rem_log" || echo "")"
                if [ -z "$_laug_raw" ]; then
                    warning "  [lint-gate:augmentor] attempt 1 returned no output — retrying"
                    _gate_provider="$(resolve_primary_provider "${ORCH_GATE_PROVIDER:-}")"
                    echo "$_lint_finding_raw" | \
                        timeout "${EPAM_GATE_TIMEOUT_SECS:-1200}" epam run ${_gate_provider:+--provider "$_gate_provider"} \
                            --model "$(seam_model_or_fail "story-ac-remediator")" \
                            --json - 2>>"$_lint_rem_log" || true
                fi
            else
                warning "  [lint-gate:analyst] Could not map lint failure to a story — skipping AC remediation"
            fi
        fi

        if [ "$_lint_remediation_applied" = "1" ]; then
            warning "Step 20: Lint gate remediation applied — caller should retry phase"
            error "Step 20: Lint gate FAILED — remediation applied, retry required"
            error "  Remediation log: $_lint_rem_log"
            exit 2  # exit 2 = remediated, tier3 runner resets and retries phase
        fi

        error "Step 20: Lint gate FAILED — fix errors before review proceeds"
        error "  Log: $_lint_log"
        error "  Bypass (emergency only): SKIP_LINT_GATE=true $0 --phase $PHASE"
        exit 1
    fi
    step_emit "20" "pass" "Step 20: Lint gate"
    success "Step 20: Lint gate PASSED"
else
    if is_truthy "${SKIP_LINT_GATE:-}"; then
        step_emit "20" "skip" "Step 20: Lint gate" "SKIP_LINT_GATE=true"
        info "Step 20: Lint gate skipped (SKIP_LINT_GATE=true)"
    else
        step_emit "20" "skip" "Step 20: Lint gate" "no node binary"
        info "Step 20: Lint gate skipped (node binary not found)"
    fi
fi

# ──────────────────────────────────────────────
# Step 4: Run review stories
# ──────────────────────────────────────────────
if [ -n "$review_stories" ]; then
    step_emit "21" "running" "Step 21: Review stories"
    log "Step 21: Running review stories..."
    while IFS= read -r story; do
        [ -z "$story" ] && continue
        check_cost_budget
        wait_if_paused
        apply_redirect_if_any "$story"
        "$SCRIPT_DIR/update-monitor.sh" event "code_review" "Team Lead code review completed" "" "main" "team-lead-agent" 2>/dev/null || true
        # Remove stale review artifact before each run so the pre-existing-file AC never blocks a retry
        _stale_review="$PROJECT_ROOT/.epam/review/${story}-review.md"
        if [ -f "$_stale_review" ]; then
            rm -f "$_stale_review"
            info "  Removed stale review artifact before retry: .epam/review/${story}-review.md"
        fi
        log "  Running review: $story"
        run_story_with_watchdog "$story" "$LOG_DIR/review-${story}.log"
        record_story_actual_cost "$story" "$LOG_DIR/review-${story}.log"
    done <<< "$review_stories"
    if [ "${_review_failed:-0}" -gt 0 ]; then
        step_emit "21" "fail" "Step 21: Review stories"
    else
        step_emit "21" "pass" "Step 21: Review stories"
    fi
    success "Review stories complete"
else
    step_emit "21" "skip" "Step 21: Review stories" "no review stories"
    info "Step 21: No review stories in this phase"
fi



# ──────────────────────────────────────────────
# Step 4.2: Testing gates (SAST + spec validation)
# ──────────────────────────────────────────────
run_testing_gates "$PHASE"
# _run_vitest_check was REMOVED 2026-08-09. It ran vitest and tsc and returned 1/2 on failure,
# and had ZERO call sites — 25 lines of gate that could never run. run_unit_tests_gate does the
# same work inline, including the identical "Type check FAILED (tsc)" path, so this was a
# superseded duplicate rather than a gate someone forgot to wire. A dead gate is worse than no
# gate: in the log it is indistinguishable from one that passed.
# gates-are-reachable-and-fail-closed.test.ts now fails if any gate loses its last call site.






# ──────────────────────────────────────────────
# Step 4.5: Unit test gate
# ──────────────────────────────────────────────
run_unit_tests_gate "$PHASE"

# ──────────────────────────────────────────────
# Step 4.8: Pre-gate worktree health verification
# Second chance to catch uncommitted files before gate assessment.
# (Step 3.1 auto-commits; this surfaces any residual issues clearly.)
log "Step 4.8: Pre-gate worktree verification..."
if ! PHASE="$PHASE" "$SCRIPT_DIR/worktree-health-check.sh" > /dev/null 2>&1; then
    warning "Step 4.8: Uncommitted files remain in worktrees after auto-commit — manual review recommended"
    warning "  Run: PHASE=$PHASE AUTO_COMMIT=true $SCRIPT_DIR/worktree-health-check.sh"
fi

# ──────────────────────────────────────────────
# Step 5: Check phase gate
# ──────────────────────────────────────────────
log "Step 5: Checking phase gate..."
"$SCRIPT_DIR/update-monitor.sh" event "phase_gate_check" "Checking phase gate for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true

# Run phase gate check (skip tests for now - future enhancement)
# PIPESTATUS[0], NOT THE PIPELINE STATUS.
#
# This read `| tee ... || gate_result=$?`. There is no `set -e` and no `pipefail` in this script --
# it says so in three other comments -- so a pipeline's status is the LAST command's, which is tee,
# which is always 0. The gate exits 1 to ask for a retry and 2 to escalate, and BOTH were read as
# GO. Its five checks -- review status, story completion, deliverables, unit tests, cost variance --
# could not stop a phase between them.
#
# Three other call sites in this file already recover the verdict this way. This one did not.
gate_result=0
SKIP_TESTS=true "$SCRIPT_DIR/check-phase-gate.sh" "$PHASE" 2>&1 | tee "$LOG_DIR/phase-gate-${PHASE}.log"
gate_result=${PIPESTATUS[0]}

case $gate_result in
    0)
        success "Phase gate: GO - All criteria passed"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_pass" "Phase gate passed for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        # Step 5.5: Interstitial E2E phase (runs <PHASE>_e2e if it exists)
        run_interstitial_e2e_phase "$PHASE"

        # Step 5.8: Auto-create PR if gh is available and there are commits ahead of origin
        if ! is_truthy "${SKIP_AUTO_PR:-}" && command -v gh >/dev/null 2>&1; then
            _current_branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
            # The remote's own HEAD is the answer; when it cannot be read, use the
            # CONFIGURED branch rather than guessing a name. A wrong guess here compares
            # against a nonexistent ref, so _commits_ahead comes back 0 and the PR step
            # silently does nothing.
            _default_branch=$(git -C "$PROJECT_ROOT" remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')
            [ -n "$_default_branch" ] || _default_branch="${JIRA_BASELINE_BRANCH:-}"
            _commits_ahead=$(git -C "$PROJECT_ROOT" rev-list --count "origin/${_default_branch}...HEAD" 2>/dev/null || echo 0)
            if [ "${_commits_ahead:-0}" -gt 0 ] && [ "${_current_branch}" != "${_default_branch}" ]; then
                log "Step 5.8: Creating PR for phase '$PHASE' (${_commits_ahead} commits ahead of origin/${_default_branch})..."
                _pr_title="feat: ${PHASE} phase complete"
                _completed_titles=$(jq -r --arg phase "$PHASE" \
                    '(.implementationOrder[$phase] // []) as $ids |
                     .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
                     "- \(.title)"' "$PRD_FILE" 2>/dev/null | head -10 || true)
                _pr_body="## Phase: ${PHASE}

### Stories Completed
${_completed_titles}

### Gate
Phase gate passed ✓

🤖 Auto-created by epam-cli orchestration"
                gh pr create \
                    --title "$_pr_title" \
                    --body "$_pr_body" \
                    --base "$_default_branch" \
                    --head "$_current_branch" \
                    >> "$LOG_DIR/pr-create-${PHASE}.log" 2>&1 && \
                    success "Step 5.8: PR created for phase '$PHASE'" || \
                    warning "Step 5.8: PR creation failed (may already exist) — see $LOG_DIR/pr-create-${PHASE}.log"
            else
                info "Step 5.8: Skipping PR creation (no commits ahead of origin or already on default branch)"
            fi
        fi
        ;;
    1)
        warning "Phase gate: RETRY - Issues found but fixable"
        warning "Check log for details: $LOG_DIR/phase-gate-${PHASE}.log"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_retry" "Phase gate requires retry for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        error "Pipeline blocked — fix issues then re-run this phase"
        exit 1
        ;;
    2)
        error "Phase gate: ESCALATE - Variance exceeds GATE_ESCALATE_THRESHOLD (${GATE_ESCALATE_THRESHOLD:-150}%)"
        error "Check log for details: $LOG_DIR/phase-gate-${PHASE}.log"
        error "Override: GATE_ESCALATE_THRESHOLD=200 $0 --phase NEXT_PHASE"
        "$SCRIPT_DIR/update-monitor.sh" event "phase_gate_escalate" "Phase gate requires escalation for $PHASE" "" "main" "team-lead-agent" 2>/dev/null || true
        exit 2
        ;;
esac

# ──────────────────────────────────────────────
# Step 24: Final Post-Phase Assessment
#
# Labelled "Step 6" here while emitting and logging 24, which is what the checklist registers
# ("6:mkdir" is a different step entirely). A header that disagrees with the step id sends anyone
# reading the monitor to the wrong block.
# ──────────────────────────────────────────────
log "Step 24: Running final post-phase assessment..."
if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
    # Non-critical, same as Step 3.5's identical call (line ~3671): under
    # `set -e`, a bare call to a function that can `return 1` (the real-
    # evidence gate added 2026-07-12) aborts the ENTIRE script, not just this
    # step. Found live the same night that gate shipped: a real,
    # already-GO-gated, fully-completed scaffold phase had its whole tier3
    # pipeline killed (exit 1, "Phase 'scaffold' failed — aborting pipeline")
    # over nothing but this LAST, informational assessment call producing no
    # new record — Step 3.5's own identical call earlier in the same run
    # correctly treated the same failure mode as a warning.
    if run_phase_assessment "$PHASE"; then
        step_emit "24" "pass" "Step 24: Final post-phase assessment"
    else
        step_emit "24" "warn" "Step 24: Final post-phase assessment" "non-critical issues"
    fi
else
    info "Step 24: No cost data — skipping final post-phase assessment"
fi
assert_no_story_ids_lost "presplit" "Step 24: Final post-phase assessment"
assert_no_story_ids_gained "post-parallel" "Step 24: Final post-phase assessment"

# Step 7 (Neo4j phase-graph load) REMOVED 2026-08-31 at the operator's instruction. It loaded the
# phase graph into a Neo4j instance nobody reads, warned and continued whenever Neo4j was absent —
# which was always — and its only consumer was a Bloom URL. Gone with load-phase-graph.sh.

# ──────────────────────────────────────────────
# Step 7.5: Write cross-phase handoff document
# ──────────────────────────────────────────────
_handoff_file="$LOG_DIR/phase-handoff-${PHASE}.md"
{
    echo "# Phase Handoff: ${PHASE}"
    echo "Generated: $(date -Iseconds)"
    echo ""
    echo "## Completed Stories"
    jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
         "- \(.id): \(.title)"' "$PRD_FILE" 2>/dev/null || true
    echo ""
    echo "## Key Artifacts"
    jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         .stories[] | select(.id as $id | $ids | index($id)) | select(.completed == true) |
         .technicalNotes.files[]? // empty' "$PRD_FILE" 2>/dev/null | sort -u | sed 's/^/- /' || true
    echo ""
    echo "## Cost Summary"
    if [ -s "$LOG_DIR/phase-cost.jsonl" ]; then
        python3 "$SCRIPT_DIR/lib/handlers/phase-cost-total.py" "$LOG_DIR/phase-cost.jsonl" 2>/dev/null || echo "(cost data unavailable)"
    else
        echo "(no cost data)"
    fi
    echo ""
    echo "## Review Results"
    if [ -s "$AUTOMATION_DIR/logs/code-reviews.jsonl" ]; then
        grep "\"phase_id\":\"${PHASE}\"" "$AUTOMATION_DIR/logs/code-reviews.jsonl" 2>/dev/null | \
            python3 "$SCRIPT_DIR/lib/handlers/run-interstitial-e2e-phase-2.py" 2>/dev/null || echo "(review data unavailable)"
    else
        echo "(no review data)"
    fi
} > "$_handoff_file"
info "Step 7.5: Phase handoff written: $_handoff_file"

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo -e "${MAGENTA}============================================${NC}"
echo -e "${MAGENTA}  Orchestration Complete${NC}"
echo -e "${MAGENTA}============================================${NC}"
echo ""

# Show final story status for this phase
jq -r --arg phase "$PHASE" \
    '(.implementationOrder[$phase] // []) as $ids |
     .stories[] | select(.id as $id | $ids | index($id)) |
     "\(if .completed then "  ✓" else "  ○" end) \(.id): \(.title) [\(.status // "pending")]"' \
    "$PRD_FILE"

echo ""

# Sync live prd.json to dashboard directory so dashboards reflect completed status
if [ -n "${OUTPUT_DIR:-}" ] && [ -f "$PRD_FILE" ]; then
    cp "$PRD_FILE" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
fi

# Finalize monitor
"$SCRIPT_DIR/update-monitor.sh" finalize 2>/dev/null || true
log "Log files:"
[ -f "$LOG_DIR/wt-primary.log" ] && info "  Primary:     $LOG_DIR/wt-primary.log"
[ -f "$LOG_DIR/wt-independent.log" ] && info "  Independent: $LOG_DIR/wt-independent.log"
info "  Claude outputs: $LOG_DIR/claude_outputs/"
info "  Monitor:     $MONITOR_STATUS_FILE"
[ -s "$LOG_DIR/phase-cost.jsonl" ] && info "  Phase costs: $LOG_DIR/phase-cost.jsonl"
[ -s "$LOG_DIR/phase-skill-assessments.jsonl" ] && info "  Assessments: $LOG_DIR/phase-skill-assessments.jsonl"

# Mark orchestration complete in monitor file
if [ -f "$MONITOR_STATUS_FILE" ]; then
    jq --arg ts "$(date -Iseconds)" \
        '.completedAt = $ts | .events += [{"type": "orchestration_complete", "story": "", "lane": "main", "role": "", "message": "All steps finished", "timestamp": $ts}]' \
        "$MONITOR_STATUS_FILE" > "$MONITOR_STATUS_FILE.tmp" && mv "$MONITOR_STATUS_FILE.tmp" "$MONITOR_STATUS_FILE"
fi

# Exit with error if any agent failed
if [ $PRIMARY_EXIT -ne 0 ] || [ $INDEPENDENT_EXIT -ne 0 ]; then
    exit 1
fi

# ──────────────────────────────────────────────
# Step 8: Automated phase promotion (opt-in)
# Set AUTO_PROMOTE_PHASE=true to chain into the next phase automatically.
# Phases with description containing "excluded from normal execution paths"
# (e.g. backlog_only) are skipped.
# ──────────────────────────────────────────────
if [ "${AUTO_PROMOTE_PHASE:-false}" = "true" ]; then
    # Verify all stories in current phase are complete before promoting
    _incomplete_count=$(jq -r --arg phase "$PHASE" \
        '(.implementationOrder[$phase] // []) as $ids |
         [.stories[] | select(.id as $id | $ids | index($id)) | select(.completed != true)] | length' \
        "$PRD_FILE" 2>/dev/null || echo 1)

    if [ "${_incomplete_count:-1}" -gt 0 ]; then
        warning "Step 8: Phase promotion skipped — $_incomplete_count stories still incomplete in '$PHASE'"
    else
        # Find next phase in insertion order, skipping excluded phases
        _next_phase=$(python3 "$SCRIPT_DIR/lib/handlers/next-phase.py" "$PRD_FILE" "$PHASE" 2>/dev/null || true)

        if [ -n "$_next_phase" ]; then
            success "Step 8: Promoting to next phase: '$_next_phase'"
            "$SCRIPT_DIR/update-monitor.sh" event "phase_promotion" \
                "Auto-promoting to phase '$_next_phase'" "" "main" "team-lead-agent" 2>/dev/null || true
            exec "$0" --phase "$_next_phase"
        else
            info "Step 8: No eligible next phase found — all phases complete or excluded"
        fi
    fi
fi
