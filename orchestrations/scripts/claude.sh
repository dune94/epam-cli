#!/bin/bash

# The run's spend figure comes from the ACTIVE SET, not a vendor hardcoded here.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/spend-probe.sh" 2>/dev/null || true

# STORY_PROVIDER's own default was "codex" — a vendor no provider set can select — reached
# whenever the roster left a story's aiProvider unassigned. See
# change-log/SEAM-CONSISTENCY-ANALYSIS.md. provider_to_cli("codex") spawns a `codex` binary
# directly, which does not exist on a claude-only machine; other vendors route to the compiled
# epam CLI, which has no EPAM_PROVIDER_SET awareness at all.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/resolve-primary-provider.sh"

# How much evidence each agent is shown, by name — see config/evidence-windows.json.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/evidence-windows.sh" 2>/dev/null || true
# shellcheck source=lib/story-acs-block.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/story-acs-block.sh"

# EPAM CLI Orchestration Script - AI-driven development loop
# This script orchestrates Claude Code CLI for autonomous story implementation
#
# Usage:
#   ./claude.sh                      # Implement next stories (priority order)
#   ./claude.sh --phase phase1       # Implement all stories in a phase
#   ./claude.sh --list-phases        # Show available phases
#   ./claude.sh US-001 US-002        # Implement specific stories
#   ./claude.sh --dry-run            # Show what would be implemented
#   ./claude.sh --status             # Show current PRD status
#   ./claude.sh --interactive        # Run with permission prompts (safer)
#
# Note: By default, runs with --dangerously-bypass-approvals-and-sandbox for autonomous operation.
#       Use --interactive flag if you want to approve each file operation.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOMATION_DIR="$(dirname "$SCRIPT_DIR")"
# Respect PROJECT_ROOT from environment (set by run-agent-orchestration.sh when PRD_FILE is external)
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$AUTOMATION_DIR")}"
PRD_FILE="${PRD_FILE:-$AUTOMATION_DIR/prd.json}"
LOG_DIR="$AUTOMATION_DIR/logs"
# EXPORTED: every child — the agent-io store above all — must be in THIS run (lib/agent-io.js).
export LOG_DIR

# shellcheck source=lib/tc-writer-gate.sh
source "$SCRIPT_DIR/lib/tc-writer-gate.sh"
# shellcheck source=lib/render-engine-prompt.sh
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# shellcheck source=lib/story-guards.sh
source "$SCRIPT_DIR/lib/story-guards.sh"
source "$SCRIPT_DIR/lib/flags.sh"
# Prompt-trim budgets, from config rather than literals (see lib/prompt-budget.sh).
source "$SCRIPT_DIR/lib/prompt-budget.sh"

# The writer's tool policy, read from orchestrations/config/spec-mode-defaults.json rather than
# spelled out here: which shell verbs redirect to which tool, and what a dependency path should
# use instead. Empty when the config omits it, which disables the redirect — the CLI treats an
# unset value as "no policy", so a missing config degrades to today's behaviour rather than to a
# wall the writer cannot get past.
_tool_policy_redirect="$("${NODE_BIN:-node}" -e '
  try {
    const cfg = require(process.argv[1]);
    const p = (cfg.toolPolicy || {}).bashExplorationRedirect;
    process.stdout.write(p ? JSON.stringify(p) : "");
  } catch (_) { process.stdout.write(""); }
' "$SCRIPT_DIR/../config/spec-mode-defaults.json" 2>/dev/null || echo "")"

# Read dedupe, from the SAME config as the redirect above rather than a literal at the call site.
# It was `EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-0}"` — a hardcoded 0 that no config value could
# override, so toolPolicy.readDedupe was decorative: flipping it changed nothing, and the flag
# stayed off for reasons nobody could see from the config that claimed to own it.
# Emits 1/0 (not true/false) because the tool tests `=== '1'`. An unreadable config yields 0,
# matching the redirect's fail-open: a missing config degrades to today's behaviour, never to a
# suppression the writer cannot get past.
_tool_policy_read_dedupe="$("${NODE_BIN:-node}" -e '
  try {
    const cfg = require(process.argv[1]);
    process.stdout.write((cfg.toolPolicy || {}).readDedupe === true ? "1" : "0");
  } catch (_) { process.stdout.write("0"); }
' "$SCRIPT_DIR/../config/spec-mode-defaults.json" 2>/dev/null || echo "0")"
source "$SCRIPT_DIR/lib/project-tools.sh"
# shellcheck source=lib/git-ops.sh
source "$SCRIPT_DIR/lib/git-ops.sh"
# shellcheck source=lib/story-retry-state.sh
source "$SCRIPT_DIR/lib/story-retry-state.sh"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"
. "$SCRIPT_DIR/lib/agent-io.sh"
# shellcheck source=lib/runner-settings.sh
. "$SCRIPT_DIR/lib/runner-settings.sh"
. "$SCRIPT_DIR/lib/agent-ladder.sh"
PROGRESS_LOG="$LOG_DIR/progress.txt"
AGENTS_FILE="$AUTOMATION_DIR/agents/AGENTS.md"
CLAUDE_OUTPUT_DIR="$LOG_DIR/claude_outputs"
# shellcheck source=lib/roster-read.sh
. "$SCRIPT_DIR/lib/roster-read.sh"

source "$SCRIPT_DIR/lib/common.sh"

source "$SCRIPT_DIR/lib/knowledge-base.sh"


# Read-only gate tool allowlist. Normally exported by run-agent-orchestration.sh; computed
# here too so claude.sh invoked standalone gives its gates the same capability. Derived from
# the project's own registered plugins rather than a literal — the literal silently dropped
# every project plugin tool at three seams below.
# shellcheck source=lib/gate-tools.sh
. "$SCRIPT_DIR/lib/gate-tools.sh" 2>/dev/null || true
if [ -z "${ORCH_GATE_ALLOWED_TOOLS:-}" ] && command -v gate_allowed_tools >/dev/null 2>&1; then
    ORCH_GATE_ALLOWED_TOOLS="$(gate_allowed_tools "${JIRA_CODELINE_ROOT:-${PROJECT_ROOT:-$PWD}}")"
fi
ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-bash,read_file,list_files,search}"
export ORCH_GATE_ALLOWED_TOOLS
MONITOR_STATUS_FILE="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"
# Single source of truth for the skill_note/kb_entry imperative-opener rule
# (the reviewer's own stated format rule -- see prd-change-reviewer's profile
# text). Both _skill_note_format_ok (the check) and _ensure_imperative_opener
# (the normalizer) read this SAME variable, so the two can never silently
# drift out of sync if the accepted word list is ever tuned. Configurable via
# env var rather than hardcoded in either function.
SKILL_NOTE_IMPERATIVE_OPENERS="${SKILL_NOTE_IMPERATIVE_OPENERS:-do not|never|always|avoid|use|prefer}"
# The word _ensure_imperative_opener prepends when a note doesn't already
# open with one of the words above. Must itself be a member of that list
# (enforced at the top of _ensure_imperative_opener, not assumed) -- "always"
# is chosen specifically because it's semantically safe to prepend to an
# ARBITRARY clause without inverting its meaning; "never"/"avoid"/"do not"
# would negate whatever follows, so picking the first list entry
# programmatically would be unsafe if the list order ever changed.
SKILL_NOTE_NORMALIZATION_OPENER="${SKILL_NOTE_NORMALIZATION_OPENER:-Always}"
export MONITOR_FILE="$MONITOR_STATUS_FILE"
export ACTIVITY_FILE="${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}"

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"

source "$SCRIPT_DIR/lib/cli-commands.sh"

# Save caller-set gate overrides BEFORE loading .env so tier-script values survive.
# .env contains stale defaults; the tier script intentionally overrides them at runtime.
_claude_pre_gate_provider="${ORCH_GATE_PROVIDER:-}"
_claude_pre_orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
# Launcher-provided temperature floor (e.g. tier3-travel-app-run.sh's project-wide
# GLM pin) — captured once here so the per-story reset below can restore it
# instead of unsetting to nothing. Read-only for the rest of this process; the
# mid-story FailureDiversity override still applies on top per-story as before.
_claude_temperature_floor="${EPAM_TEMPERATURE:-}"

load_env_file "$(dirname "$AUTOMATION_DIR")/.env"
load_env_file "$PROJECT_ROOT/.env"

# Restore: tier-script values win over .env defaults
[ -n "$_claude_pre_gate_provider" ] && ORCH_GATE_PROVIDER="$_claude_pre_gate_provider"
[ -n "$_claude_pre_orch_provider" ] && EPAM_ORCHESTRATION_PROVIDER="$_claude_pre_orch_provider"
unset _claude_pre_gate_provider _claude_pre_gate_model_REMOVED _claude_pre_orch_provider
export ORCH_GATE_PROVIDER EPAM_ORCHESTRATION_PROVIDER

source "$SCRIPT_DIR/lib/model-ladder.sh"
load_llm_settings_json

# Git work root — the directory containing .git (defaults to PROJECT_ROOT)
# Override when the git repo lives in a subdirectory (e.g., PROJECT_ROOT/application)
GIT_WORK_ROOT="${GIT_WORK_ROOT:-$PROJECT_ROOT}"

# AI_RUNNER_CMD / CONTROL_PLANE_PORT — same defaults as
# run-agent-orchestration.sh. Neither is exported there, so a worktree
# subprocess launched via --worktree doesn't inherit them from the parent's
# environment; needed here by validate_mid_execution_splits and
# wait_if_paused (lib/story-guards.sh) for worktree lanes.
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
# WHICH SEAM THE STORY WRITER IS — declared ONCE. Every other seam names itself at its call
# (lib/orch-prompt.sh: "NAME THE AGENT AT THE CALL"); the writer never did, because it invokes the
# runner directly and the anonymous-agent guard only watches callers of the hub. So the recorder
# labelled its turns with whatever EPAM_AGENT_NAME the child inherited: `prompt-review` on
# 2026-09-09, the bare story id on 2026-09-10 — 232 turns no replayer or mock loader could find by
# seam. Passed as an env prefix at each runner invocation and at the replay delegate, never
# exported into this shell, so nothing lingers into the seams that follow the writer.
STORY_WRITER_SEAM="story-writer"
# Replay lives in ONE place (lib/llm-handler.sh). This file carries a SECOND provider dispatch
# that never reaches it — see lib/replay-delegate.sh for the rehearsal that proved it.
# shellcheck source=lib/replay-delegate.sh
[ -f "$SCRIPT_DIR/lib/replay-delegate.sh" ] && source "$SCRIPT_DIR/lib/replay-delegate.sh"
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"

# Worktree configuration (set by --worktree flag)
WORKTREE_MODE=""        # "primary", "independent", or "" for main
MAIN_PRD_FILE=""        # Points to main repo's prd.json when in worktree mode
export REVIEW_PHASE=""         # Phase name for --review-phase mode
CURRENT_PHASE=""        # Current phase being executed (for cost tracking)

# Configuration
CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # Allow override via environment
EPAM_CLI="${EPAM_CLI:-$SCRIPT_DIR/bin/epam}"        # epam-cli binary; override with mock for testing
MAX_RETRIES="${EPAM_MAX_RETRIES:-7}"
RETRY_DELAY=5
# Orchestration mode — inherited from run-agent-orchestration.sh or set directly
ORCH_MODE="${ORCH_MODE:-bash}"
# SDK invocation mode — when 1, routes Claude provider calls through invoke.py
# using the Anthropic Python SDK instead of the claude CLI.
# All other providers (opencode, codex, copilot, openai, openrouter, cursor) are unaffected.
# Requires: pip install -r orchestrations/scripts/requirements.txt
# and ANTHROPIC_API_KEY to be set in the environment.
EPAM_SDK_INVOKE="${EPAM_SDK_INVOKE:-0}"
INVOKE_PY="$SCRIPT_DIR/invoke.py"
INVOKE_PYTHON="${INVOKE_PYTHON:-$SCRIPT_DIR/.venv/bin/python3}"
# Fall back to system python3 if venv not present
[ -x "$INVOKE_PYTHON" ] || INVOKE_PYTHON="python3"

EFFORT_MODEL_LOW="${EPAM_EFFORT_MODEL_LOW:-$(_effort_model_for_position low)}"
EFFORT_MODEL_MEDIUM="${EPAM_EFFORT_MODEL_MEDIUM:-$(_effort_model_for_position medium)}"
EFFORT_MODEL_HIGH="${EPAM_EFFORT_MODEL_HIGH:-$(_effort_model_for_position high)}"
# Set by resolve_planner_settings; empty means single-invocation mode (no split)
STORY_PLANNER_MODEL=""
# Set by resolve_effort_settings; controls EPAM_MAX_ITERATIONS for epam-run stories.
# Low=6 (write 2 files + tsc + vitest + one fix), medium=10, high=15
STORY_MAX_ITERATIONS="${EPAM_EFFORT_LOW_MAX_ITERATIONS}"
# Set by resolve_effort_settings; controls EPAM_MAX_OUTPUT_TOKENS for epam-run stories.
STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_LOW_MAX_OUTPUT_TOKENS}"
# Set by resolve_generator_settings; true when agentRole=generator (pure file creation, no context reads).
STORY_GENERATOR_MODE=""







source "$SCRIPT_DIR/lib/worktree-rungs.sh"





source "$SCRIPT_DIR/lib/story-attempt.sh"


# _committed_change_uses_helpers <story_id>
# THE COMMIT IS THE ARTIFACT. MEASURE THAT.
#
# verify_prescribed_helper_used checks `git diff <baseline>` — the WORKING TREE — and it is
# right to, because it must reject an attempt before that attempt ends. But a story's
# attempts share one tree, partial work is deliberately carried across them
# ("WorktreeReset: skipped — partial work preserved"), and the commit is assembled at the
# end. So a helper can be present when that guard looks and absent from what ships.
#
# Live, run 20260815T142007Z (metrolinx, AMSD-2041): the plan named five files and four
# verified helpers; the write-time guard did not fire; the story was marked complete; and
# the commit contained ContentstackContext 0, getContentByKey 0, useContent 0, Stack 7.
# The previous pass — discarded by a retry and recovered only from
# epam-rescue/AMSD-2041-8341407b — used all four and made the context reactive. What
# shipped configures the SDK and subscribes to entry changes, but nothing re-queries, so
# draft content never reaches the page. Every other gate passed it: tsc is happy, and the
# tests assert that init was called, never that a consumer re-renders with new data.
#
# I could not establish from the logs WHY the working-tree guard stayed silent. This check
# does not depend on knowing: it reads the committed range, so whatever happened inside the
# attempt, the thing that ships is the thing that is judged.
#
# Same filter as the write-time guard, deliberately — one definition of "required helper".
# No symbol, path or project vocabulary appears here.
# ── Does the change DUPLICATE a format the prescribed helper already owns? ───────────────────
#
# Helper-ABSENCE was the wrong signal. It holds only for defect stories, where the prescribed
# helper sits on the changed line by construction (mock3 MOCK3-1: the fix IS `age >= 65` on the
# line returning CONCESSION_FARE_CENTS, so the helper cannot be absent). For a feature it is a
# design choice: gotransit SHIPPED AMSD-2041 working, 9 files, with ContentstackFactory and
# getSinglePageEntry absent — and the absence rule rejects that.
#
# The 2026-07-26 defect was never about absence. It was DUPLICATION: the change hand-rolled a
# format the repository already parses — `startsWith(id + '-')` while
# dispatch-line-item-key.ts declares `const DIVIDER = '#'`. So the fix could never match.
#
# The rule: if the helper's own module declares a separator-like literal, and the change performs
# format surgery with a DIFFERENT one, the change is re-creating knowledge the helper owns.
# Absence alone proves nothing and is never rejected.

source "$SCRIPT_DIR/lib/deliverables.sh"







source "$SCRIPT_DIR/lib/story-cost-record.sh"







# Agent behavioral contract — injected into every claude invocation as a system
# prompt prefix. Rules are non-negotiable; they cannot be overridden by story
# prompts or KB content. Kept minimal: only invariants that prevent data loss or
# security incidents if violated.
# Read from orchestrations/config/agent-contract.json — not composed here.
#
# It was a heredoc: five rules of English in engine code, which no project could change,
# nothing could translate, and which named tsc, vitest, jest and npm inside a rule labelled
# NON-NEGOTIABLE. A rule that lists one ecosystem's tools is wrong for every project that uses
# none of them and silently incomplete for every project that uses something else — so the rules
# now name CAPABILITIES the orchestrator owns, and the project supplies the wording.
#
# Two contradictions went with it. The old rule 3 asserted "all necessary context is in this
# prompt" and forbade reading before the first write, while the prompt body told the agent to
# read files not listed — measured live: 126 read_file calls against a rule labelled
# non-negotiable. It now states one thing: read when you need more than you were given.
#
# Falls back to empty rather than to a built-in default: a contract nobody can read is a contract
# that should be visibly absent, not silently replaced by whatever was compiled in.
AGENT_CONSTITUTION="$("${NODE_BIN:-node}" -e '
  try {
    const c = require(process.argv[1]);
    const rules = Array.isArray(c.rules) ? c.rules : [];
    if (!rules.length) { process.stdout.write(""); process.exit(0); }
    const filled = rules.map((r, i) => `${i + 1}. ` + String(r)
      .replace(/\{projectRoot\}/g, process.argv[2] || "")
      .replace(/\{engineDirs\}/g, process.argv[3] || ""));
    process.stdout.write("AGENT BEHAVIORAL CONTRACT — NON-NEGOTIABLE:\n" + filled.join("\n"));
  } catch (_) { process.stdout.write(""); }
' "$SCRIPT_DIR/../config/agent-contract.json" "${PROJECT_ROOT:-}" ".epam/, orchestrations/" 2>/dev/null || echo "")"

# Claude CLI permission flags
# These allow Claude to read/write files and execute commands without prompting.
#
# READ BY lib/story-attempt.sh (implement_story builds effective_permissions from it). Removed
# on 2026-09-16 as "assigned here and never read" when per-file shellcheck reported SC2034 — a
# read in another file of the same program — and from that release every writer on the claude
# set ran WITHOUT --dangerously-skip-permissions and without the agent constitution: each write
# was refused with "you haven't granted it yet", the writer reported the wall, and the story
# failed after 8 attempts (regintel 20260916T200108Z, three resumes, 2026-09-17). Restored
# verbatim. The cross-file read is what the split-program shellcheck exists to see.
CLAUDE_PERMISSIONS=(
    "--dangerously-skip-permissions"
    "--append-system-prompt"
    "$AGENT_CONSTITUTION"
)

# Alternative: Use granular permissions (uncomment if preferred over skip-permissions)
# CLAUDE_PERMISSIONS=(
#     "--allowedTools" "Read,Write,Edit,Glob,Grep,Bash"
# )

# DIAGNOSTICS GO TO STDERR.
#
# build_implementation_prompt (and several other builders) are captured with $( ), so anything a
# diagnostic writes to STDOUT becomes part of the value being built. Live 2026-08-10 that put
# warning text INSIDE the writer's deliverable list:
#
#   - <ansi>[WARNING]<ansi> Deliverable '.../src/context/contentstackContext.tsx' resolved
#     case-insensitively to '/hom
#   /home/.../src/context/ContentstackContext.tsx (ReadFile this only if you need it ...)
#
# splitting a path across two lines and embedding ANSI escapes and timestamps in the instruction
# body. The corrupted entry was the case-mismatched file — the resolver's own diagnostic destroyed
# the rendering of the path it had just repaired — and it appeared twice, once per duplicate
# declaration. No rewording of the prompt can fix that; the damage is in the data.
#
# error() already wrote to stderr; these four were never made consistent with it. Both streams are
# redirected to the run log by every launcher, so nothing is lost from the operator's view — the
# diagnostics simply stop being able to reach a captured string.
# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color








source "$SCRIPT_DIR/lib/writer-prompt.sh"

source "$SCRIPT_DIR/lib/prd-state.sh"






















# Verify every file declared by the story exists in the execution root.
# This prevents a successful provider response from completing a story that
# produced no deliverables.
# record_story_outputs <story_id>
# Records what this story actually produced, so the phase gates can be HANDED
# that set instead of rediscovering it.
#
# Step 20's lint gate used to lint the whole tree and fail on any finding,
# which is only survivable on a codeline with zero pre-existing lint debt.
# Scoping it to the writers' output is the fix, and this is the producer half
# of that contract (lib/eslint-baseline-gate.sh is the consumer).
#
# The set is derived from git rather than from technicalNotes.files: that field
# is empty on the live metrolinx PRD shape — which is precisely why the
# zero-declared-files fallback below exists — so trusting it would hand the
# gates an empty scope and silently disable them.
#
# Writes nothing at all when there is no baseline to diff against (greenfield).
# An ABSENT manifest tells the gate to fall back and say so; an EMPTY one would
# assert "the writers produced nothing", which is a lie that disables the gate.
# Never fails the story: this is a reporting aid, not a verdict.
# Delegates to lib/story-outputs.sh, which owns the one implementation: there
# is more than one producer (this loop, and the repro-test-writer, which commits
# LATER), and a second copy of this logic is how they would drift apart.
# The rung record and the output manifest come from the same library, loaded once at start-up
# rather than per-call: story_rung_record runs on every attempt of every story.
if [ -f "${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/story-outputs.sh" ]; then
    # shellcheck disable=SC1090
    . "${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/story-outputs.sh"
fi









source "$SCRIPT_DIR/lib/external-verification.sh"



source "$SCRIPT_DIR/lib/failure-healing.sh"











# run_external_verification <story_id> <output_file>
# Runs the project test suite externally after the agent writes files.
# This keeps the agent loop short (write-only) while still enforcing AC tests.
# Returns 0 on pass. On failure, appends a ## Verification Failure section
# to output_file so the retry prompt includes the actual test output.
# DETERMINISTIC_CHECK_FAILURE distinguishes "a deterministic pre-test check found a
# known, precisely-described violation" (relative-import-check, mock-completeness-
# check) from "the actual test suite failed" (needs an LLM to diagnose). The former
# never needed an LLM call to know what's wrong — the check's own message already
# names the exact fix — so the retry loop skips run_failure_analyst's gate-model
# call for these and doesn't spend ladder-escalation budget on them either (see
# the retry loop inside implement_story, below).
VERIFICATION_FAILURE=""
DETERMINISTIC_CHECK_FAILURE=0





# ── The project's SUITE declaration, read through the plugin ──────────────────
#
# Four ecosystem facts used to live in run_external_verification: a manifest filename, a key
# inside it, a command, and a test-file naming convention. Hardcoding is permitted in plugins
# and nowhere else, so all four moved to .epam/verification.json's `test` section, read by
# orchestrations/plugins/verification-plugin.js. These wrappers carry no stack knowledge — they
# print what the project declared, or nothing.














# ── Inference Ladder Coordinator ─────────────────────────────────────────────
#
# Two-layer gate that runs BEFORE each model-up event:
#
#   Layer 1 (rule-based triage, always on, zero cost):
#     Inspects raw result file and result text to classify the failure into:
#       env        — CLI crashed before any API call (raw = 0 bytes, non-zero exit)
#       capability — model ran but hit max iterations or produced no deliverables
#       quality    — deliverables exist but external tests failed
#     Class "env" immediately suppresses escalation (a stronger model won't fix it).
#
#   Layer 2 (LLM gate, opt-in via EPAM_MODEL_COORDINATOR_ENABLED=1):
#     For Class B/C failures, calls ORCH_GATE_MODEL with a structured prompt that
#     includes the failure log snippet. The gate returns:
#       escalate: yes|no        — whether to upgrade the model
#       failure_class: <class>  — refined classification
#       prompt_amendment: <txt> — optional targeted addition to the retry prompt
#     This layer distinguishes "context limit hit" (upgrade helps) from
#     "hallucination loop" (prompt amendment more effective than model upgrade).
#
# Sets globals:
#   COORDINATOR_ESCALATE        — "yes" | "no"
#   COORDINATOR_FAILURE_CLASS   — "env" | "capability" | "quality" | "unknown"
#   COORDINATOR_PROMPT_AMENDMENT — additional text to append to retry prompt, or ""

COORDINATOR_ESCALATE="yes"
COORDINATOR_FAILURE_CLASS="unknown"
COORDINATOR_PROMPT_AMENDMENT=""

















source "$SCRIPT_DIR/lib/prd-change-review.sh"






# run_change_with_reviewer_retry <story_id> <change_type> <before> <candidate> [max_retries=3]
# Wraps run_prd_change_reviewer with a summarize-and-resubmit loop instead of discarding
# a rejected self-heal change immediately. On rejection, run_prd_change_summarizer
# rewrites the candidate to address the reviewer's stated issues, then resubmits — up
# to <max_retries> total review attempts. This exists because kb_entry/skill_note
# writes were being rejected (and discarded) near-100% of the time on fixable FORMAT
# issues, silently defeating the entire self-heal-persistence mechanism.
# Prints "pass" or "fail" to stdout (same contract as run_prd_change_reviewer).
# Sets REVIEWER_RETRY_TEXT to the final (possibly reformatted) candidate either way.












source "$SCRIPT_DIR/lib/retry-extension.sh"





















# Main entry point
main() {
    local dry_run_mode=false
    local status_mode=false
    local list_phases_mode=false
    local interactive_mode=false
    local phase_filter=""
    local stories=()

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                usage
                exit 0
                ;;
            --status)
                status_mode=true
                shift
                ;;
            --list-phases)
                list_phases_mode=true
                shift
                ;;
            --phase)
                if [ -z "$2" ] || [[ "$2" == --* ]]; then
                    error "--phase requires a phase name"
                    exit 1
                fi
                phase_filter="$2"
                shift 2
                ;;
            --dry-run)
                dry_run_mode=true
                shift
                ;;
            --worktree)
                if [ -z "$2" ] || [[ "$2" == --* ]]; then
                    error "--worktree requires a worktree name (primary|independent)"
                    exit 1
                fi
                if [[ "$2" != "primary" && "$2" != "independent" ]]; then
                    error "Invalid worktree name: $2 (must be 'primary' or 'independent')"
                    exit 1
                fi
                WORKTREE_MODE="$2"
                # Save main PRD location for reference
                MAIN_PRD_FILE="$PRD_FILE"
                # Save main project root BEFORE switching to worktree path.
                # technicalNotes.files in the PRD contain absolute paths referencing
                # the main repo (e.g. /path/to/skyscanner-app/src/foo.ts).
                # We rewrite these to the worktree path in verify_story_deliverables
                # and in the agent prompt so agents write to the worktree, not the main repo.
                MAIN_PROJECT_ROOT="$(cd "$GIT_WORK_ROOT" && pwd)"
                # Update GIT_WORK_ROOT and PROJECT_ROOT to worktree for file operations
                local _git_basename
                _git_basename="$(basename "$MAIN_PROJECT_ROOT")"
                GIT_WORK_ROOT="$(cd "$GIT_WORK_ROOT/.." && pwd)/${_git_basename}-wt-$WORKTREE_MODE"
                PROJECT_ROOT="$GIT_WORK_ROOT"
                # Keep PRD_FILE pointing to MAIN - single source of truth
                # (Do NOT set PRD_FILE to worktree's prd.json - it will be stale)
                shift 2
                ;;
            --setup-worktrees)
                initialize
                check_prerequisites
                setup_worktrees
                exit $?
                ;;
            --cleanup-worktrees)
                cleanup_worktrees
                exit $?
                ;;
            --interactive)
                interactive_mode=true
                shift
                ;;
            -*)
                error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                stories+=("$1")
                shift
                ;;
        esac
    done

    # If interactive mode, clear the permission flags
    if [ "$interactive_mode" = true ]; then
        CLAUDE_PERMISSIONS=()
        warning "Running in interactive mode - you will be prompted for permissions"
    fi

    # Initialize
    initialize
    check_prerequisites

    # Execute requested mode
    if [ "$status_mode" = true ]; then
        show_status
        exit 0
    fi

    if [ "$list_phases_mode" = true ]; then
        list_phases
        exit 0
    fi

    # If phase filter specified, get stories for that phase
    if [ -n "$phase_filter" ]; then
        local phase_stories
        phase_stories=$(get_phase_stories "$phase_filter")
        if [ -z "$phase_stories" ]; then
            error "Phase '$phase_filter' not found or has no stories"
            echo ""
            echo "Available phases:"
            get_phases | while read p; do echo "  - $p"; done
            exit 1
        fi

        # When in worktree mode, filter phase stories by agent group
        if [ -n "$WORKTREE_MODE" ]; then
            local filtered_stories=()
            while IFS= read -r sid; do
                [ -z "$sid" ] && continue
                local story_group
                story_group=$(jq -r --arg id "$sid" \
                    '.stories[] | select(.id == $id) | .agentGroup // "main"' "$PRD_FILE")
                if [ "$story_group" = "$WORKTREE_MODE" ]; then
                    filtered_stories+=("$sid")
                fi
            done <<< "$phase_stories"
            stories=("${filtered_stories[@]}")
            info "Filtered to ${#stories[@]} stories for agent group: $WORKTREE_MODE"
        else
            mapfile -t stories < <(echo "$phase_stories")
        fi
        CURRENT_PHASE="$phase_filter"
        info "Running phase: $phase_filter"

        # Initialize/update monitor status file for this phase, merging with existing stories
        local existing_phase
        existing_phase=$(jq -r '.phase // ""' "$MONITOR_STATUS_FILE" 2>/dev/null || echo "")
        if [ ! -f "$MONITOR_STATUS_FILE" ] || [ "$existing_phase" != "$phase_filter" ]; then
            local new_stories
            new_stories=$(jq -r --arg phase "$phase_filter" \
                '(.implementationOrder[$phase] // []) as $ids |
                 [.stories[] | select(.id as $id | $ids | index($id)) |
                  {key: .id, value: {status: (if .completed then "complete" else "pending" end),
                   lane: (.agentGroup // "main"), role: (.agentRole // ""),
                   title: .title, updatedAt: null}}] |
                 from_entries' "$PRD_FILE" 2>/dev/null || echo '{}')
            local orch_mode
            orch_mode=$(jq -r --arg ph "$phase_filter" '.phasesConfig[$ph].orchestrationMode // "bash"' "$PRD_FILE" 2>/dev/null || echo "bash")
            # Merge: keep existing stories, add new phase stories on top
            local existing_stories='{}'
            if [ -f "$MONITOR_STATUS_FILE" ]; then
                existing_stories=$(jq -r '.stories // {}' "$MONITOR_STATUS_FILE" 2>/dev/null || echo '{}')
            fi
            local merged_stories
            merged_stories=$(jq -n --argjson existing "$existing_stories" --argjson new "$new_stories" \
                '$existing * $new')
            local tmp_init
            tmp_init=$(mktemp "${MONITOR_STATUS_FILE}.init.XXXXXX")
            jq -n \
                --arg started "$(date -Iseconds)" \
                --arg phase "$phase_filter" \
                --arg mode "$orch_mode" \
                --argjson stories "$merged_stories" \
                '{startedAt: $started, phase: $phase, orchMode: $mode,
                  lanes: {
                    main:        {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0},
                    primary:     {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0},
                    independent: {status:"idle",currentStory:null,storiesCompleted:0,storiesFailed:0}
                  },
                  events: [], stories: $stories}' > "$tmp_init" && mv "$tmp_init" "$MONITOR_STATUS_FILE"
            info "Monitor status file updated for phase: $phase_filter"
        fi
    fi

    if [ "$dry_run_mode" = true ]; then
        dry_run "${stories[@]}"
        exit 0
    fi

    # Step 0.5: Pre-phase skill assessment (main process only, not worktree subprocesses)
    # Skip when phase_filter is empty — per-story invocations have no phase context
    [ -z "$WORKTREE_MODE" ] && ! is_truthy "${SKIP_SKILL_ASSESSMENT:-}" && [ -n "$phase_filter" ] && run_pre_phase_assessment "$phase_filter"

    # -- Parallel lane execution --
    # When not already in worktree mode, partition stories by agentGroup.
    # main stories run sequentially first; primary + independent launch in parallel.
    if [ -z "$WORKTREE_MODE" ] && [ -n "$phase_filter" ]; then
        local main_stories=() primary_stories=() independent_stories=()
        for sid in "${stories[@]}"; do
            local grp
            grp=$(jq -r --arg id "$sid" \
                '.stories[] | select(.id == $id) | .agentGroup // "main"' "$PRD_FILE")
            case "$grp" in
                primary)     primary_stories+=("$sid") ;;
                independent) independent_stories+=("$sid") ;;
                *)           main_stories+=("$sid") ;;
            esac
        done

        # Run main-lane stories sequentially first
        if [ ${#main_stories[@]} -gt 0 ]; then
            info "Running ${#main_stories[@]} main-lane stories sequentially..."
            run_implementation "${main_stories[@]}"
        fi

        # If there are worktree-lane stories, set up worktrees and launch in parallel
        local need_worktrees=false
        [ ${#primary_stories[@]} -gt 0 ]     && need_worktrees=true
        [ ${#independent_stories[@]} -gt 0 ] && need_worktrees=true

        if [ "$need_worktrees" = true ]; then
            info "Setting up git worktrees for parallel execution..."
            setup_worktrees || warning "Worktree setup had errors — continuing"

            local PRIMARY_PID="" INDEPENDENT_PID=""
            local SCRIPT_PATH
            SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"

            if [ ${#primary_stories[@]} -gt 0 ]; then
                info "Launching primary lane (${#primary_stories[@]} stories) in background..."
                PRD_FILE="$PRD_FILE" "$SCRIPT_PATH" --worktree primary --phase "$phase_filter" \
                    > "$LOG_DIR/wt-primary.log" 2>&1 &
                PRIMARY_PID=$!
                info "  Primary agent PID: $PRIMARY_PID"
            fi

            if [ ${#independent_stories[@]} -gt 0 ]; then
                info "Launching independent lane (${#independent_stories[@]} stories) in background..."
                PRD_FILE="$PRD_FILE" "$SCRIPT_PATH" --worktree independent --phase "$phase_filter" \
                    > "$LOG_DIR/wt-independent.log" 2>&1 &
                INDEPENDENT_PID=$!
                info "  Independent agent PID: $INDEPENDENT_PID"
            fi

            # Wait for parallel lanes to finish
            local primary_exit=0 independent_exit=0
            if [ -n "$PRIMARY_PID" ]; then
                wait "$PRIMARY_PID" || primary_exit=$?
                [ $primary_exit -eq 0 ] \
                    && success "Primary lane completed" \
                    || warning "Primary lane exited with code $primary_exit — see $LOG_DIR/wt-primary.log"
            fi
            if [ -n "$INDEPENDENT_PID" ]; then
                wait "$INDEPENDENT_PID" || independent_exit=$?
                [ $independent_exit -eq 0 ] \
                    && success "Independent lane completed" \
                    || warning "Independent lane exited with code $independent_exit — see $LOG_DIR/wt-independent.log"
            fi
        fi

        return 0
    fi

    # Fallback: no phase filter or already in worktree mode — run sequentially
    run_implementation "${stories[@]}"
}


# RUNNING IS OPT-IN — the guard mock-expectations.js and agent-check.js already carry.
#
# This file is 12,219 lines and 155 functions, and its tests reach them by COPYING function bodies
# into `bash -c "<string>"` harnesses. bash then attributes every traced line to that string, so the
# writer stage reads 21% while its tests exist and pass: there is no file for the coverage to land on.
#
# Sourced, this defines the functions and stops. Executed, `main "$@"` runs exactly as before —
# `return` outside a function succeeds only in a sourced file, which is how the two are told apart.
# Nothing above this line changes, so an executed run reaches main having done identically what it
# did before.
if (return 0 2>/dev/null); then
    return 0
fi

# Run main
main "$@"
