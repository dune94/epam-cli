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

# KB IS KEYED BY CODELINE, NOT BY AGENT ROLE.
#
# The roster is ephemeral by design — regenerated every run, no aggregation — and the mint
# invents a new NAME each run for what is essentially the same agent. KB-<role>.md therefore
# named an address that changed every run: 32 files accumulated, each holding what one run
# learned, none reachable by any later run. The store persisted; the key did not.
#
# A codeline is stable, discovered rather than invented, already the investigator key, and the
# subject of most durable learning — where the SDK is initialised here, how this repository
# names its tests. Project-wide lessons that belong to no codeline go to the shared file.
# _resolved_baseline_ref [repo] — the ref every diff in this file compares against.
#
# NINE SITES SPELLED THIS `origin/${JIRA_BASELINE_BRANCH:-develop}`. "develop" is a fact of some
# projects and not of others, so on a codeline whose trunk is named anything else every one of
# those diffs resolved nothing — and a diff against a ref that does not exist is empty, which
# reads downstream exactly like "this story changed nothing".
#
# The project declares it; otherwise take the repository's OWN checked-out branch, which is at
# least true. Prefer origin/<branch> when that ref exists, because these are baseline comparisons
# and the remote is the shared baseline; fall back to the local branch when there is no remote.
# Prints nothing when nothing resolves, so a caller can refuse rather than diff against a name.
_resolved_baseline_ref() {
    local _repo="${1:-${PROJECT_ROOT:-.}}"
    local _branch="${JIRA_BASELINE_BRANCH:-}"
    if [ -z "$_branch" ]; then
        _branch="$(git -C "$_repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
        [ "$_branch" = "HEAD" ] && _branch=""
    fi
    [ -n "$_branch" ] || return 0
    if git -C "$_repo" rev-parse --verify --quiet "origin/${_branch}" >/dev/null 2>&1; then
        printf 'origin/%s' "$_branch"
    else
        printf '%s' "$_branch"
    fi
}

_kb_file_for_story() {
    local _story_id="$1" _kb_dir="$2"
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _cl="${EPAM_CODELINE:-}"
    if [ -z "$_cl" ] && [ -n "$_story_id" ] && [ -f "$_prd_target" ]; then
        _cl=$(jq -r --arg id "$_story_id" \
            '.stories[] | select(.id == $id) | .codeline // ""' "$_prd_target" 2>/dev/null || echo "")
    fi
    # NORMALISED IDENTICALLY TO THE SEED SIDE (lib/agent-roster.js kbFileForCodeline):
    # lowercased, punctuation collapsed to '-'. Without this, "next.gotransit.com" and
    # "next-gotransit-com" address two different stores and one of them is never read. A test
    # executes both implementations and compares them character for character.
    local _slug
    _slug=$(printf '%s' "$_cl" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-*//; s/-*$//')
    if [ -n "$_slug" ]; then
        printf '%s/KB-%s.md' "$_kb_dir" "$_slug"
    else
        printf '%s/KB-shared.md' "$_kb_dir"
    fi
}


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

# Delegates to lib/env-file.sh: loading configuration must not EXECUTE it. This function
# used to `. "$env_file"`, and a bare `cd` on line 1 of the repo's .env sent this script —
# the agent invoker — to $HOME every time it started.
load_env_file() {
    load_env_file_safe "$1"
}

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

# Load EPAM_PROJECT_CONFIG_DIR/llm-settings.json (schema:
# orchestrations/config/llm-settings.schema.json) as FALLBACK DEFAULTS for the
# ladder/retry/self-heal/cost-control settings below — every value here only
# fires when the corresponding EPAM_* var isn't already set (tier-script env,
# a project .env file, or the launch shell all still win). This must run
# before MAX_RETRIES is read a few lines down, so it's called immediately.
load_llm_settings_json() {
    local _settings_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}"
    # NOTE: no early return when the project has no settings file. The engine-wide budget
    # defaults below must still be applied — returning here left every budget unset and the
    # literals in the case statement were the only thing filling them in.
    [ -f "$_settings_file" ] || _settings_file="/dev/null"

    # `|| true` is load-bearing (found live, 2026-08-02): this function runs
    # under `set -e` (claude.sh:18) — a malformed llm-settings.json makes jq
    # exit non-zero on the PARSE error itself (the `// empty` fallback only
    # covers a valid-but-absent VALUE, not a parse failure), and every call
    # site here is `_v=$(_get ...)`, a bare simple command whose failing exit
    # status would otherwise kill the whole script under set -e — silently
    # contradicting this loader's own "malformed config never blocks" intent.
    _get() { jq -r "$1 // empty" "$_settings_file" 2>/dev/null || true; }
    local _v

    # Per-story BUDGETS: engine-wide defaults, project overrides. Two tiers so a project
    # states only what it changes. These were literals in the effort-tier case statement
    # below — the exact knobs an operator tunes, invisible and uneditable without a code
    # change. `|| true` for the same set -e reason documented above.
    local _defaults_file="${EPAM_LLM_DEFAULTS_FILE:-$AUTOMATION_DIR/config/llm-defaults.json}"
    _getd() { jq -r "$1 // empty" "$_defaults_file" 2>/dev/null || true; }
    _budget() {  # <jq-path> <env-var>: project value wins, else engine default
        local _path="$1" _var="$2" _val
        _val=$(_get "$_path"); [ -n "$_val" ] || _val=$(_getd "$_path")
        [ -n "$_val" ] && [ -z "${!_var:-}" ] && export "$_var=$_val"
        # ALWAYS succeed. A trailing false test makes this function return 1, and under
        # `set -e` that propagates out of load_llm_settings_json and kills the caller — the
        # same trap this file documents for the git-add and scan-secrets blocks. "No value
        # to apply" is the normal case, not an error.
        return 0
    }
    local _tier
    for _tier in low medium high; do
        _budget ".effortTiers.${_tier}.maxIterations"   "EPAM_EFFORT_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]')_MAX_ITERATIONS"
        _budget ".effortTiers.${_tier}.maxOutputTokens" "EPAM_EFFORT_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]')_MAX_OUTPUT_TOKENS"
    done
    _budget '.roleOverrides.generator.maxIterations'   'EPAM_ROLE_GENERATOR_MAX_ITERATIONS'
    _budget '.roleOverrides.generator.maxOutputTokens' 'EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS'
    _budget '.outputTokenFloors.planning' 'EPAM_OUTPUT_FLOOR_PLANNING'
    _budget '.outputTokenFloors.review'   'EPAM_OUTPUT_FLOOR_REVIEW'
    _budget '.outputTokenFloors.mutation' 'EPAM_OUTPUT_FLOOR_MUTATION'

    _v=$(_get '[.planning.autoPlannerTiers[]?] | join("|")'); [ -z "${EPAM_AUTO_PLANNER_TIERS:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_PLANNER_TIERS="$_v"
    _v=$(_get '.planning.temperature'); [ -z "${EPAM_PLANNING_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_TEMPERATURE="$_v"
    _v=$(_get '.planning.topP'); [ -z "${EPAM_PLANNING_TOP_P:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_TOP_P="$_v"
    _v=$(_get '.planning.reasoningEffort'); [ -z "${EPAM_PLANNING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_PLANNING_EFFORT="$_v"
    _v=$(_get '[.ladders | keys[]] | join("|")')
    [ -z "${EPAM_LADDER_TIERS:-}" ] && [ -n "$_v" ] && export EPAM_LADDER_TIERS="$_v"
    _v=$(_get '[.effortLadder[]?] | join("|")')
    [ -z "${EPAM_EFFORT_LADDER:-}" ] && [ -n "$_v" ] && export EPAM_EFFORT_LADDER="$_v"
    _v=$(_get '.temperatureFloor'); [ -z "${EPAM_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_TEMPERATURE="$_v"

    _v=$(_get '.retries.maxRetries'); [ -z "${EPAM_MAX_RETRIES:-}" ] && [ -n "$_v" ] && export EPAM_MAX_RETRIES="$_v"
    _v=$(_get 'if .retries.selfHeal.enabled == true then "1" elif .retries.selfHeal.enabled == false then "0" else empty end')
    [ -z "${EPAM_RETRY_EXTENSION_ENABLED:-}" ] && [ -n "$_v" ] && export EPAM_RETRY_EXTENSION_ENABLED="$_v"
    _v=$(_get '.retries.selfHeal.extensionMax'); [ -z "${EPAM_RETRY_EXTENSION_MAX:-}" ] && [ -n "$_v" ] && export EPAM_RETRY_EXTENSION_MAX="$_v"

    _v=$(_get '.timeouts.secondsPerIteration'); [ -z "${EPAM_SECONDS_PER_ITERATION:-}" ] && [ -n "$_v" ] && export EPAM_SECONDS_PER_ITERATION="$_v"
    _v=$(_get '.timeouts.storyTimeoutMaxSecs'); [ -z "${EPAM_STORY_TIMEOUT_MAX_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_MAX_SECS="$_v"
    _v=$(_get '.timeouts.storyTimeoutSecs'); [ -z "${EPAM_STORY_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_TIMEOUT_SECS="$_v"
    _v=$(_get '.timeouts.gateTimeoutSecs'); [ -z "${EPAM_GATE_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_GATE_TIMEOUT_SECS="$_v"
    # The test timeout belongs with the other timeouts, not in config.env. It was the only one a
    # project could not declare: six call sites read a bare ${EPAM_TEST_TIMEOUT_SECS:-300} with no
    # declared source, so raising it meant reintroducing the duplication that consolidating
    # timeouts into this file removed (EPAM_STORY_TIMEOUT_SECS had already drifted 690 vs 600).
    # 300s is a real constraint on a large suite, and when `timeout` kills it the run reports
    # FAILING TESTS rather than a timeout.
    _v=$(_get '.timeouts.testTimeoutSecs'); [ -z "${EPAM_TEST_TIMEOUT_SECS:-}" ] && [ -n "$_v" ] && export EPAM_TEST_TIMEOUT_SECS="$_v"

    _v=$(_get '.brownfield.minOutputTokens'); [ -z "${EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS:-}" ] && [ -n "$_v" ] && export EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS="$_v"
    _v=$(_get '.brownfield.maxScaledIterations'); [ -z "${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-}" ] && [ -n "$_v" ] && export EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS="$_v"

    _v=$(_get '.compaction.defaultAutoCompressAt'); [ -z "${EPAM_AUTO_COMPRESS_AT:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_COMPRESS_AT="$_v"
    _v=$(_get '.compaction.defaultAutoCompressEveryNIterations'); [ -z "${EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS:-}" ] && [ -n "$_v" ] && export EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS="$_v"

    # Per-rung temperature/effort overrides — rungs[] is shared by BOTH
    # ladders (only the model each rung resolves to differs), so these env
    # vars are read once, not per-ladder. iterationBump/outputTokenBump are
    # NOT wired here — those are still hardcoded in the rung case statement
    # (driven by CPA's iterationEstimate scaling and the brownfield output
    # floor respectively), so the rungs[] entries for those two fields are
    # documentation of current behavior only, not yet a configurable input.
    _v=$(_get '.rungs[] | select(.rung==0) | .reasoningEffort'); [ -z "${EPAM_RUNG0_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG0_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==1) | .reasoningEffort'); [ -z "${EPAM_RUNG1_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG1_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==2) | .reasoningEffort'); [ -z "${EPAM_RUNG2_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG2_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==3) | .reasoningEffort'); [ -z "${EPAM_RUNG3_REASONING_EFFORT:-}" ] && [ -n "$_v" ] && export EPAM_RUNG3_REASONING_EFFORT="$_v"
    _v=$(_get '.rungs[] | select(.rung==1) | .temperature'); [ -z "${EPAM_RUNG1_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG1_TEMPERATURE="$_v"
    _v=$(_get '.rungs[] | select(.rung==2) | .temperature'); [ -z "${EPAM_RUNG2_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG2_TEMPERATURE="$_v"
    _v=$(_get '.rungs[] | select(.rung==3) | .temperature'); [ -z "${EPAM_RUNG3_TEMPERATURE:-}" ] && [ -n "$_v" ] && export EPAM_RUNG3_TEMPERATURE="$_v"

    # Model ladder chains: modelLadder[] -> "from=to|from2=to2" string, matching
    # EPAM_MODEL_LADDER_HIGH/MEDIUM's existing format exactly (the format the
    # ladder-step lookup function further below already parses) — this is a
    # direct serialization, not a new format.
    # ONE READER FOR THE LADDERS — lib/model-ladders.sh, shared with every other entry point.
    # This used to be three hand-written lines here and NOWHERE ELSE, so a process that did not
    # start from this script (detective-rerun.sh) had no ladders at all.
    # ${SCRIPT_DIR:-} and a guarded source: this function runs under `set -e` AND is exercised
    # under `set -u`, where a bare $SCRIPT_DIR aborts the WHOLE loader and every budget below it
    # silently goes unset — which is exactly what happened when this was first written.
    # seam-ladder.sh alongside it: the ladders give the CHAINS, the seams say which position an
    # agent occupies. Reading one without the other is how a model literal stayed necessary here.
    local _sl_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/seam-ladder.sh"
    # shellcheck source=lib/seam-ladder.sh
    [ -f "$_sl_lib" ] && . "$_sl_lib"
    local _ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
    if [ -f "$_ml_lib" ]; then
        # shellcheck source=lib/model-ladders.sh
        . "$_ml_lib" || true
        command -v export_model_ladders >/dev/null 2>&1 && export_model_ladders "$_settings_file" || true
    fi

    # Model-specific overrides (modelOverrides.*) are NOT flattened into env
    # vars here — there can be any number of entries (e.g. separate MiniMax-M2.5
    # vs MiniMax-M3 tuning), so a fixed set of env var names can't represent
    # them. They're read directly from $_settings_file at invocation time,
    # per-attempt, against the FINAL resolved STORY_PROVIDER/STORY_MODEL — see
    # the "Model-specific overrides" block in the provider-invocation code,
    # ~line 7700.

    # Cost controls
    _v=$(_get '.costControls.maxToolCallsPerStory'); [ -z "${EPAM_STORY_MAX_TOOL_CALLS:-}" ] && [ -n "$_v" ] && export EPAM_STORY_MAX_TOOL_CALLS="$_v"
    _v=$(_get '.costControls.storyBudgetWarningUsd'); [ -z "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] && [ -n "$_v" ] && export EPAM_STORY_BUDGET_WARNING_USD="$_v"
    _v=$(_get '.costControls.storyBudgetHardLimitUsd'); [ -z "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ] && [ -n "$_v" ] && export EPAM_STORY_BUDGET_HARD_LIMIT_USD="$_v"

    unset -f _get
    echo "  LLMSettings: loaded fallback defaults from $_settings_file" >&2
}
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
CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-8094}"

# Worktree configuration (set by --worktree flag)
WORKTREE_MODE=""        # "primary", "independent", or "" for main
MAIN_PRD_FILE=""        # Points to main repo's prd.json when in worktree mode
export REVIEW_PHASE=""         # Phase name for --review-phase mode
CURRENT_PHASE=""        # Current phase being executed (for cost tracking)

# Configuration
CLAUDE_CMD="${CLAUDE_CMD:-claude}"  # Allow override via environment
EPAM_CLI="${EPAM_CLI:-epam}"        # epam-cli binary; override with mock for testing
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

# Effort -> model + max-turns mapping
# Stories carry an optional "effort" field: low | medium (default) | high
# These map to a model and a max-turns cap for the Claude CLI invocation.
# Env-overridable, not hardcoded to one provider's model: a project whose
# story's aiProvider is never "codex" (e.g. Metrolinx, which routes brownfield
# work through minimax/openrouter) still got "gpt-5-codex" here as the CONFIG
# DEFAULT resolve_model_from_story() falls back to before overriding from the
# story's own .model field — harmless when the story sets .model, but a real
# footgun for any invocation path that reaches this default without one
# (found live, 2026-08-01: the writer sandbox test's first run invoked codex
# via this exact default, 4 straight zero-token failures, no OPENAI_API_KEY
# in the environment — this project never uses codex at all).
# THE LADDERS DICTATE EVERY MODEL CALL — NO EXCEPTIONS.
#
# These three defaulted to the literal `gpt-5-codex`: one model for all three effort tiers, and one
# with no entry in ANY ladder. So the effort axis collapsed to a constant — measured across 211
# archived story records, 205 carry the same assigned model — and an unresolved effort silently
# called a vendor this pipeline does not use.
#
# The tier START models are already exported by lib/model-ladders.sh from the project's own
# llm-settings.json (EPAM_MODEL_LADDER_<TIER>_START). Effort maps onto the project's DECLARED tier
# order, lowest to highest, so a project that names its tiers differently — or declares four of
# them — still resolves without this file knowing any of their names.
#
# Unresolved stays EMPTY on purpose. A wrong model is more expensive than a stopped run and far
# harder to notice; the caller checks and fails rather than substituting something plausible.
_effort_model_for_position() {
    local _pos="$1" _order _tier _var
    # Declared lowest-to-highest. Env first (operator override), then whatever the project declared.
    _order="${EPAM_MODEL_LADDER_TIER_ORDER:-}"
    [ -n "$_order" ] || return 0
    # shellcheck disable=SC2086
    set -- $_order
    case "$_pos" in
        low)    _tier="${1:-}" ;;
        medium) _tier="${2:-${1:-}}" ;;
        high)   _tier="${3:-${2:-${1:-}}}" ;;
        *)      return 0 ;;
    esac
    [ -n "$_tier" ] || return 0
    _var="EPAM_MODEL_LADDER_$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9\n' '_')_START"
    printf '%s' "${!_var:-}"
}
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

# resolve_effort_settings <story_id>
# Sets STORY_MODEL and STORY_MAX_TURNS globals based on story's effort field.
resolve_effort_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local effort
    effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .effort // "medium"' \
        "$prd_target" 2>/dev/null || echo "medium")

    # A self-heal `effort_tier` constraint compiles to EPAM_EFFORT_TIER. Apply it
    # UPGRADE-ONLY: this is the one place that holds BOTH the story's tier and the
    # proposed one, so the comparison needs no baseline plumbing — which is exactly
    # what defeated four successive numeric guards.
    #
    # A downgrade after a failure would repeat the mistake the raw integers made
    # (EPAM_MAX_ITERATIONS=1 "to prevent iterative retries"): taking room away from
    # an agent that ran out of it. Refused, and said out loud.
    if [ -n "${EPAM_EFFORT_TIER:-}" ]; then
        # RANKED BY THE PROJECT'S DECLARED effortLadder, not by tier names written here. The four
        # case statements this replaces knew three of the four declared tiers, so "max" ranked
        # below "high" and the highest effort a project can ask for was silently treated as mid.
        local _rank_new
        _rank_new=$(effort_rank "$EPAM_EFFORT_TIER")
        if effort_is_higher "$EPAM_EFFORT_TIER" "$effort"; then
            log "  EffortTier[KB] -> upgrading ${effort} → ${EPAM_EFFORT_TIER} (self-heal constraint)"
            effort="$EPAM_EFFORT_TIER"
        elif [ "$_rank_new" -gt 0 ]; then
            log "  EffortTier[KB] -> IGNORING ${EPAM_EFFORT_TIER} (not an upgrade on ${effort}); budgets are increase-only"
        fi
    fi

    # CPA's own complexity judgment (gate=review|block, complexityAdjustment)
    # and the detective's coverage check (checkFixSiteCoverage, spec-mode-
    # runner.js) each persist an upgrade-only effort signal onto the story —
    # cpaEffortTier (contextualize-stories.sh) and
    # fixSiteAnalysisCoverage.complete. Neither ever touched the REAL
    # iteration/token budget before this fix: cpaEffortTier only fed
    # ladderTier (which MODEL handles escalation retries, not how many turns
    # the implementer gets), and coverage was not read here at all. Live
    # AMSD-2041, 2026-08-01: CPA flagged gate="review"/1.3x and the
    # detective's 2-site prescription left 4 verification criteria uncovered,
    # but STORY_MAX_ITERATIONS stayed keyed to the story's untouched "low"
    # input classification — the implementer got the smallest budget for a
    # change every downstream signal had already flagged as underscoped.
    # Same upgrade-only discipline as the EPAM_EFFORT_TIER block above: never
    # take room away, only ever add it when a later signal says more is needed.
    local _cpa_tier _cov_complete
    _cpa_tier=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .cpaEffortTier // ""' "$prd_target" 2>/dev/null || echo "")
    # NOTE: deliberately NOT `.fixSiteAnalysisCoverage.complete // true` — jq's
    # `//` treats a literal `false` as falsy too, so that would silently turn
    # every real "incomplete" (false) result into "true". Explicit null check.
    _cov_complete=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | (if .fixSiteAnalysisCoverage.complete == null then true else .fixSiteAnalysisCoverage.complete end)' "$prd_target" 2>/dev/null || echo "true")
    local _proposed_tier="$_cpa_tier"
    if [ "$_cov_complete" = "false" ]; then
        # An incomplete prescription always needs at least "medium" — a gap in
        # the detective's own coverage must never silently leave a story at "low".
        case "$_proposed_tier" in high) : ;; *) _proposed_tier="medium" ;; esac
    fi
    # A DECLARED AGENT IS AUTHORITATIVE. CPA MAY PROPOSE, NOT OVERRIDE.
    #
    # CPA estimates a story's shape and proposes an effort tier. That is the right input where an
    # agent has no settled opinion. Where the ARCHETYPE declares its own effort, the operator has
    # already decided how much room that role gets, and a per-story estimate must not move it —
    # the estimate knows the story, not the role.
    #
    # THE PROTECTED SET IS DERIVED, NEVER LISTED. An archetype that declares `effort` in
    # invocation-profiles.json is protected; one that declares nothing keeps the previous
    # behaviour exactly. No agent name appears here, so protecting a new role is a declaration
    # and never an engine change.
    local _declared_effort=""
    if [ -n "${story_role:-}" ]; then
        _declared_effort=$("${NODE_BIN:-node}" -e '
          const { resolveSeam } = require(process.argv[1]);
          try {
            const reg = process.argv[2];
            const seam = resolveSeam(process.argv[3], reg);
            const p = JSON.parse(require("fs").readFileSync(reg, "utf8")).profiles[seam] || {};
            process.stdout.write(p.effort == null ? "" : String(p.effort));
          } catch (_) { process.stdout.write(""); }
        ' "$SCRIPT_DIR/lib/seam-invocation.js" \
          "${AGENT_PROFILES_REGISTRY:-$(dirname "$SCRIPT_DIR")/agents/invocation-profiles.json}" \
          "$story_role" 2>/dev/null || printf '')
    fi

    if [ -n "$_declared_effort" ]; then
        effort="$_declared_effort"
        if [ -n "$_proposed_tier" ] && [ "$_proposed_tier" != "$_declared_effort" ]; then
            log "  EffortTier[CPA] -> NOT overriding '${story_role}': its archetype declares effort=${_declared_effort} (CPA proposed ${_proposed_tier})"
        fi
    elif [ -n "$_proposed_tier" ]; then
        # Same declared ranking as the KB block above — one source, one order.
        if effort_is_higher "$_proposed_tier" "$effort"; then
            log "  EffortTier[CPA] -> upgrading ${effort} → ${_proposed_tier} (cpaEffortTier=${_cpa_tier:-none} coverageComplete=${_cov_complete})"
            effort="$_proposed_tier"
        fi
    fi

    case "$effort" in
        low)
            STORY_MODEL="$EFFORT_MODEL_LOW"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_LOW_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_LOW_MAX_OUTPUT_TOKENS}"
            ;;
        high)
            STORY_MODEL="$EFFORT_MODEL_HIGH"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_HIGH_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            ;;
        *)  # medium (default)
            STORY_MODEL="$EFFORT_MODEL_MEDIUM"
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_MEDIUM_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            ;;
    esac
    # NOTE: deliberately does NOT log the model here (found live, 2026-07-10):
    # STORY_MODEL at this point is only the effort-tier CONFIG DEFAULT
    # (currently gpt-5-codex for every tier) -- resolve_model_from_story()
    # runs immediately after this and overrides it from prd.json in every
    # observed live case. Logging "model=gpt-5-codex" here was misleading:
    # that model was never actually dispatched, and no Cost[...] line ever
    # named it, but read at a glance mid-run it looked like a third model
    # was in rotation and costing money. resolve_model_from_story() now
    # always logs whichever model actually ends up used.
    log "  Effort[$effort] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"
}

# resolve_generator_settings <story_id>
# When agentRole=generator, overrides iteration/token settings for pure file-creation stories.
# Generator stories write one new file from spec — they need no context reads, few iterations,
# and a large output token budget for the generated content.
resolve_generator_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_GENERATOR_MODE=""
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ "$role" = "generator" ]; then
        STORY_GENERATOR_MODE="true"
        STORY_MAX_ITERATIONS="${EPAM_ROLE_GENERATOR_MAX_ITERATIONS}"
        STORY_MAX_OUTPUT_TOKENS="${EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS}"
        log "  GeneratorMode: enabled (agentRole=generator) — maxIter=3 maxOutTok=16384"
    fi
}

# resolve_test_engineer_effort_floor <story_id>
# Test-writing structurally requires MORE research/verification turns than
# implementation at the same nominal effort tier: a test story must read its
# contract file AND the paired impl story's full source, extract exact
# signatures/error strings verbatim, THEN write mocks, THEN iterate until the
# real test suite actually passes -- work an impl story of the same "effort"
# label never has to do (it defines its own interface as it goes). Root cause
# found live (2026-07-11, tier3-travel-app run): impl stories at effort=low
# (maxIter=6) routinely completed in 1 attempt; test-engineer stories at the
# SAME effort=low budget needed repeated retries and even a watchdog timeout
# before ever reaching npm test, purely from running out of iterations partway
# through the read-then-write workflow above -- not from any deficiency in the
# test-engineer profile's own guidance. Bump the effort tier ONE step for any
# agentRole == "test-engineer" story (low->medium, medium->high); high stays
# high. Only ever raises the budget, never lowers it.
resolve_test_engineer_effort_floor() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    [ "$role" = "test-engineer" ] || return 0
    local effort
    effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .effort // "medium"' \
        "$prd_target" 2>/dev/null || echo "medium")
    case "$effort" in
        low)
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_MEDIUM_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            log "  TestEngineerEffortFloor: low -> medium (maxIter=10 maxOutTok=6144) -- test-writing needs more research/verification turns than impl at the same tier"
            ;;
        medium)
            STORY_MAX_ITERATIONS="${EPAM_EFFORT_HIGH_MAX_ITERATIONS}"
            STORY_MAX_OUTPUT_TOKENS="${EPAM_EFFORT_MEDIUM_MAX_OUTPUT_TOKENS}"
            log "  TestEngineerEffortFloor: medium -> high (maxIter=15 maxOutTok=6144)"
            ;;
        *) : ;;  # high already has the largest budget -- nothing to bump
    esac
}

# resolve_brownfield_effort_floor <story_id>
# Brownfield-specific output-budget floor. The default effort tiers give tiny
# output budgets (low=3072, medium=6144) tuned for greenfield NON-reasoning
# writes. But brownfield runs on REASONING models (MiniMax-M3, GLM) that emit a
# large <think> block BEFORE any tool call — and that reasoning counts against
# the output-token budget. Found live 2026-07-23 (AMSD-1820): every attempt at
# the default budget was TRUNCATED mid-<think> at ~18k tokens and never reached
# a WriteFile/Edit — reported as "deliverables UNCHANGED" for 3 straight
# attempts. The one attempt that completed only did so once its output reached
# ~22k. So a reasoning model needs room to think AND write in the same
# response. Floor the output budget high for brownfield (never lower it), so
# the model can finish reasoning and still emit the edit. Iterations get a
# floor too, since a multi-file brownfield fix legitimately spans several
# read/edit turns. Only ever RAISES the budget.
#
# Note on effort: the detective already did the deep reasoning (the root cause
# is injected into the prompt), so brownfield implementation does NOT need the
# model to re-reason from scratch — but rather than fight the InferenceLadder's
# effort ramp here, we simply guarantee enough output budget that the think
# block, however large, still leaves room to write. Override the floor with
# EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS if a project needs more/less.
resolve_brownfield_effort_floor() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _bf_min_out="${EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS:-24576}"
    local _bf_min_iter="${EPAM_BROWNFIELD_MIN_ITERATIONS:-12}"
    # When the detective already prescribed the fix (fixSiteAnalysis + helper), the
    # "reasoning headroom" rationale is inverted — the thinking is done; the agent just
    # applies the handed fix. Bumping to 12 then wastes ~11 ReAct turns, each re-sending
    # the accumulating conversation → input ballooned to ~169K (live 2026-07-24). Keep the
    # effort-tier default (do not inflate iterations) for a prescribed fix; the output-token
    # floor still applies (writing needs room). Env-overridable.
    #
    # But "a prescription exists" != "the prescription is minimal": the shortcut above
    # was applied to ANY story with at least one helper-bearing finding, including
    # multi-site fixes and fixes checkFixSiteCoverage (spec-mode-runner.js) flags as
    # not addressing some of the story's own verification criteria. Live AMSD-2041,
    # 2026-08-01: 2 fixSiteAnalysis entries + 4 uncovered VCs still got floor=6-12 —
    # the same budget as a true one-file fix — for a change review confirmed needed
    # 7-8 files touched (SDK install, service layer, interfaces, API route, tests).
    # Only take the fast, low-iteration path for a GENUINE single-site, fully-covered
    # fix; otherwise scale the floor with how much the detective actually left unsaid.
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    # Ceiling, computed once regardless of which branch below fires: more
    # iterations means more accumulated ReAct-conversation re-sent on every
    # turn — the same mechanism that made 11 "wasted" iterations balloon
    # input to ~169K tokens on a SIMPLE story (see the 2026-07-24 note
    # above). Left unbounded, a large-enough story could trade
    # "under-budgeted" for "runs into a real context-window limit mid-run"
    # instead of a clean "reached maximum iterations". Capped, not silently
    # — a story that hits the cap is still logged so this isn't invisible.
    local _scaled_cap="${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-30}"
    local _num_sites _has_helper _num_uncovered
    _num_sites=$(jq -r --arg id "$story_id" '[.stories[] | select(.id==$id) | .fixSiteAnalysis[]?] | length' "$_prd_target" 2>/dev/null || echo 0)
    _has_helper=$(jq -r --arg id "$story_id" '[.stories[] | select(.id==$id) | .fixSiteAnalysis[]?.helper] | map(select(. != null and . != "")) | length' "$_prd_target" 2>/dev/null || echo 0)
    _num_uncovered=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.fixSiteAnalysisCoverage.uncoveredVerificationCriteria // []) | length' "$_prd_target" 2>/dev/null || echo 0)
    if [ "${_num_sites:-0}" -eq 1 ] && [ "${_has_helper:-0}" -gt 0 ] && [ "${_num_uncovered:-0}" -eq 0 ]; then
        _bf_min_iter="${EPAM_BROWNFIELD_PRESCRIBED_MIN_ITERATIONS:-6}"
    elif [ "${_num_sites:-0}" -gt 0 ] || [ "${_num_uncovered:-0}" -gt 0 ]; then
        local _scaled=$(( 8 + 4 * ${_num_sites:-0} + 3 * ${_num_uncovered:-0} ))
        if [ "$_scaled" -gt "$_scaled_cap" ]; then
            log "  BrownfieldEffortFloor: scaled iteration need (${_scaled}) exceeds cap (${_scaled_cap}) — capping. Story ${story_id} may be underscoped for a single implementation pass; consider a split."
            _scaled="$_scaled_cap"
        fi
        [ "$_scaled" -gt "$_bf_min_iter" ] && _bf_min_iter="$_scaled"
    fi

    # CPA's brownfield-only iterationEstimate — an ABSOLUTE turn-count
    # estimate (1-500, clamped in cpa-inference.js; persisted as
    # cpaIterationEstimate by contextualize-stories.sh — see cpa-system.md
    # "Iteration Estimate"), not a multiplier on top of whichever floor was
    # picked above. Redesigned 2026-08-01: a 1.0-3.0x multiplier on an
    # already-scaled base cannot span "5 for a bug fix" to "200 for a large
    # multi-layer change" — a real ~40x range. CPA sees the SAME
    # fixSiteAnalysis + coverage verdict fed into its prompt, plus KB
    # coverage, manifest facts, and the full verification criteria the
    # heuristic above cannot weigh holistically — it can correct a case the
    # naive single-site/helper/coverage-complete check misclassifies as
    # trivial (found live, 2026-08-01, AMSD-2041/upexpress: 1 site, has a
    # helper, coverage heuristic reported "complete" via a bag-of-words false
    # positive). Only ever raises the floor — a default of 1 (CPA never ran,
    # or genuinely found nothing extra) changes nothing.
    local _cpa_iter_estimate
    _cpa_iter_estimate=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.cpaIterationEstimate // 1)' "$_prd_target" 2>/dev/null || echo 1)
    if [ "${_cpa_iter_estimate:-0}" -gt "$_bf_min_iter" ] 2>/dev/null; then
        local _capped_estimate="$_cpa_iter_estimate"
        if [ "$_capped_estimate" -gt "$_scaled_cap" ]; then
            log "  BrownfieldEffortFloor: CPA iterationEstimate (${_cpa_iter_estimate}) exceeds cap (${_scaled_cap}) — capping."
            _capped_estimate="$_scaled_cap"
        fi
        log "  BrownfieldEffortFloor: CPA iterationEstimate raises floor ${_bf_min_iter} -> ${_capped_estimate}"
        _bf_min_iter="$_capped_estimate"
    fi

    local _raised=0
    if [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "$_bf_min_out" ]; then
        STORY_MAX_OUTPUT_TOKENS="$_bf_min_out"; _raised=1
    fi
    if [ "${STORY_MAX_ITERATIONS:-0}" -lt "$_bf_min_iter" ]; then
        STORY_MAX_ITERATIONS="$_bf_min_iter"; _raised=1
    fi
    [ "$_raised" = "1" ] && log "  BrownfieldEffortFloor: reasoning-model headroom -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS} (think + write must fit one response)"
}

# _cap_brownfield_iterations_ceiling <context-label>
# The rung-based inference ladder adds +5 iterations on EVERY rung transition
# (see the ladder case statement below), independent of and AFTER whatever
# floor resolve_brownfield_effort_floor already established. A story whose
# floor is already at the EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS cap (e.g. 30)
# could still reach 45 by rung 3 (30 + 5 + 5 + 5) — the exact context-window
# risk that cap exists to prevent (found live, 2026-08-01, while reviewing
# the ceiling added to resolve_brownfield_effort_floor: that cap only bounds
# the STARTING budget, never the cumulative total after ladder escalation).
# Brownfield-only, same env var, same discipline: log when the cap actually
# trims something so this stays visible, never silent.
_cap_brownfield_iterations_ceiling() {
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _ceiling="${EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS:-30}"
    if [ "${STORY_MAX_ITERATIONS:-0}" -gt "$_ceiling" ]; then
        log "  BrownfieldEffortFloor[$1]: ladder escalation pushed iterations to ${STORY_MAX_ITERATIONS}, exceeding cap (${_ceiling}) — capping."
        STORY_MAX_ITERATIONS="$_ceiling"
    fi
}

# _brownfield_rung_bump <story_id>
# The ladder's rung-transition bump used to be a flat +5 regardless of the
# story's actual complexity — a trivial retry and a genuinely complex one
# got the same increment. CPA's brownfield-only iterationEstimate
# (1-500, an ABSOLUTE turn count — cpa-system.md "Iteration Estimate")
# already estimates exactly this per story. Scale the bump as 10% of that
# estimate, floored at 5 (the unchanged default when CPA never ran, or
# estimated something small): estimate 1 -> +5, estimate 200 -> +20. A story
# CPA judges as needing 200 turns overall should not still get the SAME +5
# nudge per rung as a 1-turn story — that was the multiplier design's own
# blind spot, carried over. Greenfield (EPAM_BROWNFIELD unset) keeps the
# flat +5 — this signal doesn't exist for greenfield stories.
# _iteration_exhaustion_bump <story_id>
# CPA's cpaIterationEstimate is the ladder's only iteration-scaling signal
# (_brownfield_rung_bump above) — when CPA never populates it
# (cpaIterationEstimate: null, confirmed live 2026-08-01 on AMSD-2041: a real
# CMS live-preview integration story sat at the effort-tier default of 10-15
# iterations and hit "capability failure (max iterations)" 11 times in one
# run), that scaling produces almost nothing and the story is starved
# regardless of its real complexity. This bump responds to the OBSERVED
# symptom instead of trusting a single static estimate: every time
# classify_failure_class() logs a capability failure (max iterations) for
# THIS story, it appends an event to iteration-exhaustion.jsonl. Each prior
# occurrence adds EPAM_ITERATION_EXHAUSTION_BUMP (default 30) on top of
# whatever _brownfield_rung_bump already computed, capped at
# EPAM_ITERATION_EXHAUSTION_MAX_BUMP (default 200) so a story failing for
# OTHER reasons doesn't get an unbounded iteration budget.
_iteration_exhaustion_bump() {
    local story_id="$1"
    local _log_file="${LOG_DIR}/iteration-exhaustion.jsonl"
    [ -f "$_log_file" ] || { echo 0; return 0; }
    local _count
    _count=$(jq -s --arg id "$story_id" '[.[] | select(.story_id == $id)] | length' "$_log_file" 2>/dev/null || echo 0)
    local _per_bump="${EPAM_ITERATION_EXHAUSTION_BUMP:-30}"
    local _max_bump="${EPAM_ITERATION_EXHAUSTION_MAX_BUMP:-200}"
    awk -v c="${_count:-0}" -v per="$_per_bump" -v maxb="$_max_bump" \
        'BEGIN { bump = c * per; if (bump > maxb) bump = maxb; printf "%d", bump }'
}

# _selective_worktree_reset <story_id>
# Rung escalations had zero git checkout/reset/clean between them — a failed
# rung's half-applied edits, stray broken writes, or any other incidental
# corruption sat on disk untouched and the next (usually stronger, costlier)
# model inherited it silently.
#
# A per-file preserve-list (an earlier version of this function, keyed off
# the story's DECLARED technicalNotes.files) turned out unsafe: a half-broken
# write and a genuinely correct but UNDECLARED file are both indistinguishable
# "has a diff from baseline" — restricting preservation to the declared set
# risked silently destroying real work outside it. Restricting to "any file
# with a diff" instead makes the reset a no-op (a broken file also has a
# diff), which defeats the point.
#
# That was once answered by a compiler signal (LAST_ATTEMPT_TSC_PASSED, set after
# run_tsc_verification): preserve the whole diff if the tree type-checked, reset it if not. That
# design is GONE, and the paragraphs below say why — a partially-complete multi-file change is
# correct progress and a compile error at the same time, so it preserved only work that was already
# coherent. The signal is no longer computed; the predicate is the spec's changeRequired.
#
# The third case is `unknown`: an earlier gate rejected the attempt before the
# tsc gate could run, so nothing is known either way. Treating that as failure
# (which it was until 2026-08-09) means a story rejected for being INCOMPLETE
# has its correct partial work deleted, and the next attempt re-derives the
# same files from an empty tree — observed live on AMSD-2041 for four
# consecutive attempts. Since the wanted evidence simply was not computed, this
# function computes it: run the check, then decide. Either way,
# LAST_VERIFIED_TOUCHED_FILES/
# LAST_VERIFIED_UNCHANGED_FILES are cleared on a real reset so the NEXT
# attempt's work-carryover prompt note (#112, above) never claims a file is
# "already done" after this function just erased it.
#
# Brownfield-only (mirrors every other baseline-diff mechanism in this file);
# no-ops silently when there's no git repo or no resolvable baseline ref, same
# safe-fallback posture as verify_story_deliverables' own baseline check.
_selective_worktree_reset() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0

    # `unknown` means the evidence this function wants was never computed: an earlier gate
    # rejected the attempt before it was complete. That is not a reason to delete the diff.
    #
    # The keep/discard question is a SPEC question: did this attempt move a file the spec
    # VERIFIED as a fix site? A compiler cannot answer it — for a multi-file feature a
    # partially-complete change is correct progress AND a compile error, so a build result
    # preserves only work that was already coherent. Live 2026-08-10: 25 writes destroyed.
    # KEEP/DISCARD IS A SPEC QUESTION, NOT A COMPILER QUESTION.
    #
    # This used to run the project's compiler and keep the work only if the WHOLE TREE compiled.
    # For any multi-file feature that is the inverse signal: a context provider written before
    # its consumer, or a changed function signature before its callers are updated, is correct
    # progress AND a compile error. So the branch could only preserve work that was already
    # coherent — precisely the work that never needed preserving. Live 2026-08-10: 25 file writes
    # across five invocations, zero survivors, on a story with 13 interdependent fix sites.
    #
    # The right question is whether the writer moved a file the spec says MUST CHANGE. The spec
    # already says which files matter; git already says which changed. No compiler required, and
    # nothing stack-specific in the engine.
    #
    # THE PREDICATE IS changeRequired, NOT fixVerified — corrected 2026-08-11.
    #
    # `fixVerified` means "the detective's PRESCRIPTION for this file was verified". "This file
    # must be edited" is `changeRequired`. Reading the first to answer the second inverted this
    # guard against its own stated intent. Measured on the live AMSD-2041/gotransit PRD:
    #
    #   changeRequired  fixVerified  file                                 was protected?
    #   true            true         src/context/ContentstackContext.tsx   yes
    #   true            FALSE        src/pages/_app.tsx                    NO
    #   true            NULL         .env.local.sample                     NO
    #   false           true         src/services/contentstack.ts          yes
    #   false           true         src/hooks/useContent.ts               yes
    #
    # Two of the THREE files the story must edit were not evidence of progress, so an attempt
    # that correctly edited _app.tsx and .env.local.sample and nothing else was DELETED as
    # "changed no VERIFIED fix site". Both files the detective said to LEAVE ALONE did count, so
    # an attempt that wrongly rewrote useContent.ts was PRESERVED — rewarding the exact failure
    # mode that killed three runs.
    #
    # ABSENT MEANS PROTECT, matching the enforcement gate's own `!= false` reading: a site with
    # no verdict has not been investigated, and "we do not know yet" is not grounds for deleting
    # work. Only an explicit boolean false — the detective saying this file needs no edit —
    # exempts a site from counting as progress.
    local _touched_fix_site=0
    if [ -n "${MAIN_PRD_FILE:-$PRD_FILE}" ]; then
        local _fs
        while IFS= read -r _fs; do
            [ -n "$_fs" ] || continue
            if ! git -C "$PROJECT_ROOT" diff --quiet "$_baseline_ref" -- "$_fs" 2>/dev/null; then
                _touched_fix_site=1; break
            fi
        done < <(jq -r --arg id "$story_id" '
            .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
            | map(select((.changeRequired | type == "boolean" and . == false) | not))
            | .[].file // empty' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
    fi
    if [ "$_touched_fix_site" -eq 1 ]; then
        log "  WorktreeReset[$story_id]: skipped — the attempt changed at least one file the spec says MUST change; partial work preserved"
        return 0
    fi

    # No positive evidence the tree is good — reset tracked files to baseline
    # content, drop untracked/ignored cruft. Same "predictable teardown"
    # primitive brownfield-preflight-reset.sh already applies between RUNS,
    # applied here between RUNGS of one run.
    # THE CHECKOUT MUST SUCCEED BEFORE THE CLEAN RUNS.
    #
    # Both ended in `2>/dev/null || true`, so an unresolvable baseline ref failed silently and the
    # `git clean -fd` still executed — deleting every untracked file WITHOUT the checkout having
    # restored the tracked ones. That is the worst possible half of this operation: destructive,
    # silent, and it leaves the tree in a state neither the attempt nor the baseline produced.
    #
    # A ref that resolves to nothing is the reachable case. _resolved_baseline_ref prints nothing
    # for a detached HEAD with no declared branch, and this is the reset between RUNGS of a live
    # run — the point at which an agent's partial work is discarded on purpose.
    if [ -z "$_baseline_ref" ]; then
        error "  WorktreeReset[$story_id]: no baseline ref resolved — refusing to clean the working tree with nothing to restore it from."
        return 1
    fi
    if ! git -C "$PROJECT_ROOT" checkout "$_baseline_ref" -- . 2>/dev/null; then
        error "  WorktreeReset[$story_id]: could not restore tracked files from ${_baseline_ref} — NOT running git clean, because that would delete untracked work without restoring anything."
        return 1
    fi
    git -C "$PROJECT_ROOT" clean -fd -- . 2>/dev/null || true
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    log "  WorktreeReset[$story_id]: reset to $_baseline_ref — the attempt changed no VERIFIED fix site"

    # Re-provision plugin config wiped by the git clean above (.epam/ is
    # untracked, same as every other pipeline-written manifest). Found live
    # 2026-08-02: a lane's first hard reset silently made the codeline-context
    # plugin unavailable for every subsequent attempt on that lane — nothing
    # re-provisioned it after the initial per-run setup. Shared with
    # ensure_story_branch()'s own working-tree reset (lib/git-ops.sh) — one
    # function instead of two independently drifting copies.
    _provision_epam_plugin_config "$PROJECT_ROOT"
}

# _rung_snapshot_path <story_id>
# One shared helper so the snapshot and attribution functions below always
# agree on where the reference file lives.
_rung_snapshot_path() {
    echo "${LOG_DIR}/.rung-snapshot-${1//[^A-Za-z0-9_-]/_}"
}

# _rung_snapshot_hashes <story_id>
# Records a content-hash of every file currently different from baseline
# (tracked-modified + untracked-new) — the "start of the next rung" reference
# _rung_attribute_changes compares against later to see what changed DURING
# that rung. Brownfield-only, same safe-fallback posture as the other
# baseline-diff mechanisms in this file.
_rung_snapshot_hashes() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0
    local _snap_file
    _snap_file=$(_rung_snapshot_path "$story_id")
    {
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u | while IFS= read -r _f; do
        [ -n "$_f" ] && [ -f "$PROJECT_ROOT/$_f" ] || continue
        local _hash
        _hash=$(git -C "$PROJECT_ROOT" hash-object "$PROJECT_ROOT/$_f" 2>/dev/null) || continue
        [ -n "$_hash" ] && printf '%s %s\n' "$_f" "$_hash"
    done > "$_snap_file"
}

# _rung_attribute_changes <story_id> <rung> <model>
# Compares the CURRENT tree against the snapshot taken at the start of the
# rung that just finished (rung/model passed in — the ones active during
# that rung, captured by the caller BEFORE it moved on). Any file whose hash
# differs from the snapshot (or is new since it) gets logged as this rung's
# contribution. A file whose hash is UNCHANGED since the snapshot is left
# alone — it keeps whatever an EARLIER rung already logged for it, so credit
# is never falsely reassigned to whichever rung happens to finish the story.
# No snapshot yet (first-ever rung, nothing to compare against) is a silent
# no-op — there's nothing prior to attribute against.
_rung_attribute_changes() {
    local story_id="$1" rung="$2" model="$3"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _snap_file
    _snap_file=$(_rung_snapshot_path "$story_id")
    [ -f "$_snap_file" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0
    local _contribution_file="${LOG_DIR}/rung-contribution.jsonl"
    {
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u | while IFS= read -r _f; do
        [ -n "$_f" ] && [ -f "$PROJECT_ROOT/$_f" ] || continue
        local _hash
        _hash=$(git -C "$PROJECT_ROOT" hash-object "$PROJECT_ROOT/$_f" 2>/dev/null) || continue
        [ -z "$_hash" ] && continue
        local _prev_hash
        _prev_hash=$(awk -v f="$_f" '$1==f{print $2}' "$_snap_file" 2>/dev/null)
        if [ "$_prev_hash" != "$_hash" ]; then
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn --arg sid "$story_id" --arg file "$_f" --arg rung "$rung" \
                    --arg model "$model" --arg ts "$(date -Iseconds)" \
                    '{story_id:$sid, file:$file, rung:$rung, model:$model, timestamp:$ts}' \
                    >> "$_contribution_file"
            ) 300>>"${_contribution_file}.lock"
        fi
    done
}

# _generate_rung_contribution_report <story_id>
# Cross-references the story's FINAL committed diff against rung-contribution.jsonl
# to answer "which rungs/models actually contributed surviving work" — a
# file's attribution is only reported if it's genuinely present in the
# current diff (a file whose rung got reset away by a later failed rung
# correctly disappears from this report, even though it was legitimately
# touched once — it did not survive to the final commit). Uses the LATEST
# attribution record per file: a file touched by rung 1 and left unchanged by
# rung 2 still credits rung 1, never silently reassigned to whichever rung
# happened to finish the story.
_generate_rung_contribution_report() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0
    local _contribution_file="${LOG_DIR}/rung-contribution.jsonl"
    [ -f "$_contribution_file" ] || return 0
    local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1 || return 0

    # Same tracked-modified + untracked-new enumeration as
    # _rung_snapshot_hashes/_rung_attribute_changes — git diff --name-only
    # alone misses brand-new files that were never `git add`ed, which would
    # silently drop e.g. a final rung's new file from this report entirely.
    local _final_files
    _final_files=$({
        git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" -- . 2>/dev/null
        git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- . 2>/dev/null
    } | sort -u)
    [ -n "$_final_files" ] || return 0

    local _report_file="${LOG_DIR}/rung-contribution-report-${story_id//[^A-Za-z0-9_-]/_}.json"
    jq -s --arg sid "$story_id" --arg files "$_final_files" '
        ($files | split("\n") | map(select(length > 0))) as $finalFiles
        | map(select(.story_id == $sid))
        | group_by(.file)
        | map(max_by(.timestamp))
        | map(select(.file as $f | $finalFiles | index($f) != null))
        | group_by(.rung)
        | map({rung: .[0].rung, model: .[0].model, files: (map(.file) | sort)})
        | sort_by(.rung | tonumber? // .rung)
    ' "$_contribution_file" > "$_report_file" 2>/dev/null

    if [ -s "$_report_file" ] && [ "$(jq 'length' "$_report_file" 2>/dev/null || echo 0)" != "0" ]; then
        local _rung_count
        _rung_count=$(jq 'length' "$_report_file" 2>/dev/null || echo 0)
        log "  RungContribution[$story_id]: $_rung_count rung(s) contributed to the final diff:"
        while IFS= read -r _line; do
            log "    $_line"
        done < <(jq -r '.[] | "Rung \(.rung) (\(.model)): \(.files | join(", "))"' "$_report_file" 2>/dev/null)
    fi
}

# _coupled_pair_gate_for_story <story_id> <output_file>
# ONE AUTHOR PER COUPLED FILE PAIR. Runs the moment the rung-contribution report
# exists — that report is the only artifact that knows WHICH RUNG wrote which file,
# and a split pair is invisible to every other gate in the run: the live case
# (AMSD-2041, run 20260814T213253Z) passed `npm run test` AND `tsc`, because neither
# installs from the lockfile. It reached the reviewer, which rejected it at an
# already-exhausted ladder, and the retry hard-reset away work that had passed.
#
# Catching it HERE means the writer gets it back as a normal verification failure with
# rungs still available, instead of the reviewer catching it with none left.
#
# The pairs are the project's declaration (.epam/dependency-check.json
# `coupledFilePairs`), never this engine's knowledge — see lib/coupled-pair-gate.sh.
_coupled_pair_gate_for_story() {
    local story_id="$1" output_file="${2:-/dev/null}"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate_lib="${SCRIPT_DIR}/lib/coupled-pair-gate.sh"
    [ -f "$_gate_lib" ] || return 0
    # shellcheck source=lib/coupled-pair-gate.sh
    . "$_gate_lib"
    command -v coupled_pair_check >/dev/null 2>&1 || return 0

    local _report_file="${LOG_DIR}/rung-contribution-report-${story_id//[^A-Za-z0-9_-]/_}.json"
    # THE MANIFEST IS RESOLVED THE WAY EVERY OTHER CONSUMER RESOLVES IT.
    #
    # This read only ${PROJECT_ROOT}/.epam/dependency-check.json — a path nothing
    # provisions. A codeline's .epam/ holds codeline-facts.json, settings.json and
    # verification.json, never that file. So on 2026-08-15 the live run reported
    # "no manifest at '.../.epam/dependency-check.json' — coupledFilePairs undeclared,
    # checked nothing", while the declaration sat in EPAM_PROJECT_CONFIG_DIR, which is
    # where dependency-scan-plugin.js:72-73 and claude.sh:3875/5638 all look FIRST.
    # The gate had therefore never once run.
    #
    # Two candidates, same order as the plugin: project config, then the codeline copy.
    local _manifest="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_manifest" ] || _manifest="${PROJECT_ROOT}/.epam/dependency-check.json"
    [ -f "$_report_file" ] || return 0

    local _gate_out _gate_rc=0
    _gate_out=$(coupled_pair_check "$_report_file" "$_manifest" 2>&1) || _gate_rc=$?
    if [ "$_gate_rc" -eq 0 ]; then
        [ -n "$_gate_out" ] && log "  $_gate_out"
        return 0
    fi

    error "  [coupled-pair] $story_id: a coupled file pair had more than one author — feeding into retry loop"
    while IFS= read -r _line; do [ -n "$_line" ] && log "  $_line"; done <<< "$_gate_out"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nFiles that are only correct RELATIVE TO EACH OTHER were written by different attempts, so they now disagree:\n\n```\n%s\n```\n\nRewrite every member of the pair together, in this one attempt, so they are consistent. Do not change one and leave the other as a previous attempt left it.\n' \
        "$_gate_out")
    {
        echo ""
        echo "=== a coupled file pair had more than one author ==="
        echo "$_gate_out"
    } >> "$output_file"
    return 1
}

# _plan_fidelity_gate_for_story <story_id> <output_file>
# SCOPE IS ARITHMETIC AGAINST THE PLAN, NOT AN OPINION.
#
# lib/plan-fidelity-gate.sh was written for run 20260814T213253Z (AMSD-2041): the plan named
# FIVE sites, the implementer changed exactly those five, and the reviewer rejected it for
# modifying "6 files when the prescribed minimal fix requires only 2" — a number appearing
# nowhere in the plan it was handed. Obeying the plan was the thing being rejected, so no
# attempt could pass; four review cycles later the ladder was exhausted and the retry
# hard-reset the branch, destroying work that had passed the suite and tsc.
#
# The library shipped and NOTHING CALLED IT. This is that call site. Placed beside the
# coupled-pair gate for the same reason that one is here: the writer gets the finding back as
# an ordinary verification failure with rungs still available, instead of the reviewer forming
# an opinion about scope with none left.
#
# The gate returns 0 for a story with no prescription — UNCHECKED is not a failure — so this
# is inert on any story nobody planned.
_plan_fidelity_gate_for_story() {
    local story_id="$1" output_file="${2:-/dev/null}"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    local _gate_lib="${SCRIPT_DIR}/lib/plan-fidelity-gate.sh"
    [ -f "$_gate_lib" ] || return 0
    # shellcheck source=lib/plan-fidelity-gate.sh
    . "$_gate_lib"
    command -v plan_fidelity_check >/dev/null 2>&1 || return 0
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0

    # THE COMMIT IS THE ARTIFACT, and the baseline is resolved the way every other consumer
    # in this file resolves it — the phase baseline if one was recorded, else the run's.
    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] && \
        _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    local _changed_list
    _changed_list=$(mktemp)
    git -C "$PROJECT_ROOT" diff --name-only "$_ref" HEAD > "$_changed_list" 2>/dev/null
    if [ ! -s "$_changed_list" ]; then rm -f "$_changed_list"; return 0; fi

    # Two candidates, same order as the dependency plugin and the coupled-pair gate.
    local _manifest="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_manifest" ] || _manifest="${PROJECT_ROOT}/.epam/dependency-check.json"

    local _gate_out _gate_rc=0
    _gate_out=$(plan_fidelity_check "${MAIN_PRD_FILE:-$PRD_FILE}" "$story_id" "$_changed_list" "$_manifest" 2>&1) \
        || _gate_rc=$?
    rm -f "$_changed_list"

    if [ "$_gate_rc" -eq 0 ]; then
        [ -n "$_gate_out" ] && log "  $_gate_out"
        return 0
    fi

    # ADVISORY. IT MUST NOT REJECT WORKING CODE.
    #
    # This returned 1 and fed the retry loop. Two things disprove that, both from this repo's
    # own record rather than from reasoning:
    #
    #   1. gotransit SHIPPED AMSD-2041 as e780a8b7 — NINE files, +379. The prescription names
    #      six sites, three of them changeRequired:false. The real, working, merged fix was
    #      therefore out of plan, and a blocking gate would have rejected it on every attempt
    #      until the ladder exhausted — the exact outcome this gate exists to prevent, inverted.
    #
    #   2. The writer is TOLD the list is not binding. prompts/templates/story-implementation
    #      .json: "The list is a STARTING POINT, not a fence ... If your change genuinely
    #      requires another file in this repository, write it." A gate that blocks what the
    #      prompt instructs is unwinnable by construction — the writer cannot satisfy both.
    #
    # The same file already carries this lesson twice: the helper-ABSENCE veto rejected working
    # code at 7.3M tokens and $2.25 per false rejection before it was narrowed to duplication.
    # A false-positive gate is worse than the silence it replaced.
    #
    # So the finding is RECORDED, in the log and in the attempt output where the reviewer and
    # the operator both see it, and the story proceeds. Making it blocking is a decision for
    # after a run has shown what it actually flags — not before.
    error "  [plan-fidelity] $story_id: the change went outside the plan of record (advisory — not blocking)"
    while IFS= read -r _line; do [ -n "$_line" ] && log "  $_line"; done <<< "$_gate_out"
    {
        echo ""
        echo "=== ADVISORY: the change went outside the plan of record ==="
        echo "$_gate_out"
        echo "This is recorded, not enforced. The prescribed file list is a starting point, not a fence."
    } >> "$output_file"
    return 0
}

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

# _helper_module_separators <repo> <helper> — separator-like literals declared by the module that
# defines <helper>. Empty when the helper owns no format, which is why a feature helper like
# ContentstackFactory (zero such literals) can never trigger a rejection.
_helper_module_separators() {
    local _repo="$1" _helper="$2" _mod
    _mod=$(grep -rlE "(export +)?(function|const|class|let) +${_helper}\b" "$_repo/src" 2>/dev/null | head -1)
    [ -n "$_mod" ] || return 0
    grep -oE "(const|let|var) +[A-Za-z_][A-Za-z0-9_]* *= *'[^a-zA-Z0-9 ]{1,3}'|(const|let|var) +[A-Za-z_][A-Za-z0-9_]* *= *\"[^a-zA-Z0-9 ]{1,3}\"" "$_mod" 2>/dev/null \
        | grep -oE "'[^']{1,3}'|\"[^\"]{1,3}\"" | tr -d "\"'" | sort -u
}

# _change_duplicates_owned_format <repo> <helper> <diff>
# 1 when the change invents its own separator for a format the helper owns. 0 otherwise.
_change_duplicates_owned_format() {
    local _repo="$1" _helper="$2" _diff="$3"
    # Already uses the helper — nothing is being re-created.
    printf '%s' "$_diff" | grep -q -- "$_helper" && return 0
    local _owned; _owned=$(_helper_module_separators "$_repo" "$_helper")
    [ -n "$_owned" ] || return 0          # the helper owns no format: absence proves nothing
    # Separator-like literals the ADDED lines introduce inside format surgery: concatenation, or a
    # prefix/suffix/split/replace comparison. A literal in an import or a message is not surgery.
    local _used
    _used=$(printf '%s\n' "$_diff" | grep '^+' | grep -v '^+++' \
        | grep -oE "(\+ *'[^a-zA-Z0-9 ]{1,3}'|\+ *\"[^a-zA-Z0-9 ]{1,3}\"|(startsWith|endsWith|split|replace|includes)\( *'[^a-zA-Z0-9 ]{1,3}'|(startsWith|endsWith|split|replace|includes)\( *\"[^a-zA-Z0-9 ]{1,3}\")" \
        | grep -oE "'[^']{1,3}'|\"[^\"]{1,3}\"" | tr -d "\"'" | sort -u)
    [ -n "$_used" ] || return 0
    local _u _o
    while IFS= read -r _u; do
        [ -n "$_u" ] || continue
        while IFS= read -r _o; do
            [ -n "$_o" ] || continue
            [ "$_u" = "$_o" ] && continue           # same separator: not a duplication
            return 1
        done <<< "$_owned"
    done <<< "$_used"
    return 0
}

_committed_change_uses_helpers() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    [ -d "${PROJECT_ROOT:-}/.git" ] || return 0

    local _helpers
    _helpers=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
        | map(select((.fixVerified == true) and ((.helper // "") != "")))
        | map(.helper) | unique | .[]' "$prd_target" 2>/dev/null)
    [ -n "$_helpers" ] || return 0

    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] && \
        _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    # baseline..HEAD — committed only. Not the tree.
    local _diff
    _diff=$(git -C "$PROJECT_ROOT" diff "$_ref" HEAD 2>/dev/null)
    [ -n "$_diff" ] || return 0

    local _missing=() _h
    while IFS= read -r _h; do
        [ -n "$_h" ] || continue
        # ABSENCE IS NOT THE SIGNAL — DUPLICATION IS. This demanded every fixVerified helper
        # appear in the committed diff. That premise holds only for a DEFECT, where the helper
        # sits on the changed line by construction (mock3 MOCK3-1: the fix IS `age >= 65` on the
        # line returning CONCESSION_FARE_CENTS). For a FEATURE it is a design choice and it
        # rejects working code: gotransit SHIPPED AMSD-2041 (e780a8b7, 9 files, +379) with
        # ContentstackFactory and getSinglePageEntry absent. Live 2026-08-19 this failed a story
        # whose commit succeeded and whose type check passed, and halted the codeline.
        #
        # The 2026-07-26 defect was never absence: it hand-rolled a format the repo already
        # parses — startsWith(id + '-') while dispatch-line-item-key.ts declares DIVIDER='#'.
        # A helper whose module owns no format can never trigger a rejection.
        _change_duplicates_owned_format "$PROJECT_ROOT" "$_h" "$_diff" || _missing+=("$_h")
    done <<< "$_helpers"
    [ ${#_missing[@]} -eq 0 ] && return 0

    local _missing_list
    _missing_list=$(printf '%s, ' "${_missing[@]}"); _missing_list="${_missing_list%, }"
    # EVERY missing one, not the first: reporting one at a time spends the retry ladder on
    # information this check already has.
    error "  [committed-change] $story_id: the COMMITTED change does not use ${#_missing[@]} verified helper(s): ${_missing_list}"
    error "  [committed-change]   The work that ships is missing part of the prescribed fix — an earlier attempt may have had it."
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe change you COMMITTED does not use %d prescribed helper(s) that the spec verified: %s\n\nEach owns part of this fix. Import and use every one of them in the files the plan names, then make the change again. A change that uses only some of them leaves the story incomplete even when the type check and the tests pass.\n' \
        "${#_missing[@]}" "$_missing_list")
    return 1
}

_brownfield_rung_bump() {
    local story_id="$1"
    if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
        echo 5
        return 0
    fi
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _estimate
    _estimate=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | (.cpaIterationEstimate // 1)' "$_prd_target" 2>/dev/null || echo 1)
    awk -v est="$_estimate" 'BEGIN { if (est !~ /^[0-9.]+$/) est = 1; if (est < 1) est = 1; if (est > 500) est = 500; bump = int(est * 0.1 + 0.5); if (bump < 5) bump = 5; printf "%d", bump }'
}

# resolve_model_from_story <story_id>
# a .model field directly.  If set, it overrides the effort-based STORY_MODEL.
# _tc_writer_phase — which phase the TC writer is generating for.
#
# CURRENT_PHASE is a claude.sh-internal global: declared empty at the top of this file and assigned
# in exactly ONE place, the phase-filter path. PHASE is what run-agent-orchestration.sh exports and
# passes per invocation. Reading only CURRENT_PHASE and falling back to the literal 'unknown' meant
# that on every ordinary run the writer was asked for a phase no story is in — live metrolinx
# AMSD-2041, 2026-08-18:
#   [tc-writer] Generating TCs for phase 'unknown' (post-impl, pre-test)...
#   [tc-writer] No test stories need TCs in phase 'unknown' — skipping
#   [tc-writer] TC generation complete — test stories have testCriteria
# and the story's testCriteria stayed empty while the log reported completion.
#
# Emits EMPTY when neither is set, never a literal that looks like an answer: the caller can detect
# an absent phase, but 'unknown' is indistinguishable from a phase that simply has no test stories.
_tc_writer_phase() {
    printf '%s' "${CURRENT_PHASE:-${PHASE:-}}"
}

resolve_model_from_story() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    # A ladder position restored for THIS story outranks the PRD's base model: the PRD says where
    # the story STARTS, the persisted rung says where it got to. Matched by VALUE, so a stale
    # marker from a previous story cannot suppress this story's own PRD model.
    if [ -n "${STORY_MODEL_LADDER_RESUMED:-}" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_LADDER_RESUMED}" ]; then
        log "  Model[prd.json] -> keeping resumed ladder position $STORY_MODEL (PRD declares ${story_model:-none})"
        return 0
    fi
    if [ -n "$story_model" ]; then
        STORY_MODEL="$story_model"
        log "  Model[prd.json] -> $STORY_MODEL (overrides effort default)"
        # ── Novel brownfield code starts at the top of the ladder ─────────────
        # LAD-2 forces ladderTier=high for a novel brownfield story, but the
        # MODEL is a separate field the coordinator has already written from
        # CPA's effort estimate — so live AMSD-2041 2026-07-29 still logged
        # "Effort[low] ... Model[prd.json] -> MiniMax-M3" and produced nothing
        # four times. Setting the tier without setting the model fixed half the
        # problem: the story could climb, but it still started at the bottom.
        #
        # The reason CPA's estimate cannot be trusted here is the same one
        # recorded for LAD-2: an underspecified story looks CHEAP, and
        # underspecification is exactly what makes novel work expensive.
        # Configured, not constant: the model comes from the project's own
        # high-tier setting.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            local _rmfs_kind _rmfs_high
            _rmfs_kind=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .storyKind // ""' \
                "$prd_target" 2>/dev/null || echo "")
            _rmfs_high="${ESCALATION_MODEL_HIGH:-${EPAM_MODEL:-}}"
            if [ "$_rmfs_kind" = "novel" ] && [ -n "$_rmfs_high" ] && [ "$_rmfs_high" != "$STORY_MODEL" ]; then
                log "  Model[novel-brownfield] -> $_rmfs_high (was $STORY_MODEL; novel code does not start on the cheapest rung)"
                STORY_MODEL="$_rmfs_high"
                # The provider must move with the model. STORY_PROVIDER was
                # resolved from the story's aiProvider, which the coordinator
                # paired with the CHEAP model CPA sized — so swapping in the
                # high-tier model leaves it pointing at the vendor that hosted
                # the model we just discarded. Live AMSD-2041 2026-07-30: all
                # three lanes sent z-ai/glm-5.1 (OpenRouter) to MiniMax and got
                # 400 "unknown model" in under a second, zero tokens, $0, eight
                # times each. Every ladder site already does this; this one did
                # not. Empty means the map has no entry — keep the existing
                # provider, which is resolve_model_provider's documented contract.
                local _rmfs_provider
                _rmfs_provider=$(resolve_model_provider "$_rmfs_high")
                if [ -n "$_rmfs_provider" ] && [ "$_rmfs_provider" != "${STORY_PROVIDER:-}" ]; then
                    log "  Provider[novel-brownfield] -> $_rmfs_provider (was ${STORY_PROVIDER:-unset}; follows the model)"
                    STORY_PROVIDER="$_rmfs_provider"
                fi
            fi
        fi
    else
        # Always log the model that will actually be used, even when it's
        # just the effort-tier default falling through unchanged -- without
        # this, no line ever named the real model for a story with no
        # prd.json override, since resolve_effort_settings() no longer logs
        # it either (see that function's own comment for why).
        log "  Model[effort-default] -> $STORY_MODEL"
        # Same pairing rule as the override above. resolve_effort_settings picks
        # this model from the effort tier BEFORE resolve_provider_settings reads
        # the story's aiProvider, so its choice cannot re-route the provider —
        # anything it set would be clobbered moments later. Here, after both have
        # run, is the first point where the pair can be made consistent. A story
        # whose configured effort model belongs to a different vendor than its
        # aiProvider would otherwise reach the API as the same impossible pairing
        # that killed AMSD-2041 (2026-07-30), just via a different route in.
        local _rmfs_eff_provider
        _rmfs_eff_provider=$(resolve_model_provider "${STORY_MODEL:-}")
        if [ -n "$_rmfs_eff_provider" ] && [ "$_rmfs_eff_provider" != "${STORY_PROVIDER:-}" ]; then
            log "  Provider[effort-default] -> $_rmfs_eff_provider (was ${STORY_PROVIDER:-unset}; follows the model)"
            STORY_PROVIDER="$_rmfs_eff_provider"
        fi
    fi
}

# resolve_reasoning_effort_from_story <story_id>
# The prd-model-coordinator agent writes a .reasoningEffort field onto every
# story before execution begins. If present, it overrides the hardcoded
# "low" reset at story start. Absent field leaves the "low" default in place.
resolve_reasoning_effort_from_story() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_effort
    story_effort=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .reasoningEffort // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_effort" ]; then
        # Brownfield correctness floor: a defect's reasoning effort is derived from Jira
        # story points (pointsToEffort), so a ticket with no/low points runs at LOW —
        # even though a brownfield fix's correctness has nothing to do with story points.
        # LOW effort gave inconsistent/wrong results (live 2026-07-24, AMSD-1820). Floor
        # brownfield at MEDIUM (env-overridable); an explicit higher effort is preserved.
        # Less guessing on the brownfield ladder. Greenfield is unchanged.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$story_effort" = "low" ]; then
            story_effort="${EPAM_BROWNFIELD_MIN_REASONING_EFFORT:-medium}"
            log "  BrownfieldEffortFloor(reasoning): low -> ${story_effort} (story-point-derived LOW is not enough for a brownfield fix)"
        fi
        export EPAM_REASONING_EFFORT="$story_effort"
        log "  ReasoningEffort[prd.json] -> $EPAM_REASONING_EFFORT"
    fi
}

# compute_token_cost <model> <tokens_in> <tokens_out>
# Returns USD cost using model-pricing.json. Outputs "0" if model unknown or tokens are zero.
# Handles "standard-tier" / "mini-tier" labels by falling back to STORY_MODEL.
compute_token_cost() {
    local model="$1"
    local tin="${2:-0}"
    local tout="${3:-0}"
    local pricing_file
    pricing_file="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/model-pricing.json"
    [ -f "$pricing_file" ] || { echo "0"; return; }
    # Resolve tier labels to the actual model
    case "$model" in
        standard-tier|mini-tier|"") model="${STORY_MODEL:-}" ;;
    esac
    [ -z "$model" ] && { echo "0"; return; }
    python3 "$SCRIPT_DIR/lib/handlers/token-cost.py" "$pricing_file" "$model" "$tin" "$tout"
}

resolve_codex_model_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_model runtime_model
    story_model=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .model // ""' \
        "$prd_target" 2>/dev/null || echo "")
    runtime_model=$(jq -r '.configuration.aiRuntime.defaultModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    STORY_MODEL="${story_model:-${runtime_model:-}}"
    # OPERATOR RULE: only ladder models. The old fallback ended at a hardcoded gpt-5-codex,
    # which is in no ladder and therefore cannot escalate. Refuse rather than substitute.
    if ! assert_ladder_model "${STORY_MODEL:-}" "Model[codex]"; then
        error "  Story ${story_id}: refusing to run on a non-ladder model."
        return 1
    fi
    log "  Model[codex] -> $STORY_MODEL"
}

# resolve_planner_settings <story_id>
# Reads optional plannerModel from story spec and sets STORY_PLANNER_MODEL global.
# When set, the first invocation uses STORY_PLANNER_MODEL to produce a structured
# execution plan; subsequent (execution) invocations use STORY_MODEL.
# When absent, falls back to a COMPLEXITY-ADAPTIVE auto-trigger: the classify_ladder_tier
# function (the same signal CPA's cpaGate/effort fields already feed into the model-
# escalation ladder — see its own docstring) is reused here to decide EXECUTION
# SHAPE, not just escalation tier. A story classified "high" gets a plan-turn before its
# very first execution attempt (not just after failures) — the whole point is avoiding
# retries for genuinely complex stories, not reacting to them after the fact. "medium"
# (the default) keeps today's single-shot behavior unchanged, so simple stories pay no
# planning-turn overhead.
# Opt-out: SKIP_PLAN_THEN_EXECUTE=true disables the auto-trigger entirely (explicit
# per-story .plannerModel still works either way — it's a manual override, not part of
# the auto-trigger this flag controls).
# Model used for the auto-triggered plan turn: EPAM_PLANNER_MODEL_HIGH_TIER if set,
# else falls back to ORCH_GATE_MODEL (the same gate model already used for reviews/
# assessments) — no vendor/model name hardcoded here, consistent with the
# config-driven pattern used by the model-provider and model-ladder-step helpers.
resolve_planner_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PLANNER_MODEL=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .plannerModel // ""' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$STORY_PLANNER_MODEL" ]; then
        log "  PlannerModel[$STORY_PLANNER_MODEL] -> planning turn, then execution on $STORY_MODEL"
        return
    fi

    is_truthy "${SKIP_PLAN_THEN_EXECUTE:-}" && return

    local _tier
    _tier=$(classify_ladder_tier "$story_id")
    # Which tiers get an automatic planner is CONFIG. Hardcoding "high" meant adding the
    # highest tier silently removed its planning turn — the strongest chain, planning the least.
    local _auto_ok=0 _pt
    local IFS='|'
    for _pt in ${EPAM_AUTO_PLANNER_TIERS:-high}; do
        [ "$_pt" = "$_tier" ] && _auto_ok=1
    done
    unset IFS
    if [ "$_auto_ok" = "1" ]; then
        local _auto_planner="${EPAM_PLANNER_MODEL_HIGH_TIER:-${EPAM_MODEL:-}}"
        if [ -n "$_auto_planner" ]; then
            STORY_PLANNER_MODEL="$_auto_planner"
            log "  PlannerModel[auto/high-tier: $STORY_PLANNER_MODEL] -> planning turn, then execution on $STORY_MODEL"
        fi
    fi
}

# resolve_dynamic_constitution <story_id>
# Reads .epam/constitution-rules.json in PROJECT_ROOT and appends any rules
# whose match criteria overlap the story's requiredSkills or agentRole to the
# DYNAMIC_CONSTITUTION global. Resets the global on every call so rules from a
# previous story never bleed into the next one.
# When the rules file is absent, DYNAMIC_CONSTITUTION is empty (P8 behaviour).
resolve_dynamic_constitution() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    DYNAMIC_CONSTITUTION=""

    local rules_file="${PROJECT_ROOT}/.epam/constitution-rules.json"
    [ -f "$rules_file" ] || return 0

    # Extract story metadata used for matching
    local story_skills story_role
    story_skills=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.requiredSkills // [] | .[]' \
        "$prd_target" 2>/dev/null | tr '\n' ' ' | xargs)
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # Match each rule entry against skills and role; collect matched rules
    local rule_count matched_rules
    rule_count=$(jq 'length' "$rules_file" 2>/dev/null || echo "0")
    matched_rules=""

    local i=0
    while [ "$i" -lt "$rule_count" ]; do
        local match_skills match_role
        match_skills=$(jq -r --argjson idx "$i" '.[$idx].match.skills // [] | .[]' \
            "$rules_file" 2>/dev/null | tr '\n' ' ' | xargs)
        match_role=$(jq -r --argjson idx "$i" '.[$idx].match.agentRole // ""' \
            "$rules_file" 2>/dev/null || echo "")

        local hit=false
        # Skill overlap: any match skill present in story skills
        for ms in $match_skills; do
            if echo " $story_skills " | grep -qi " $ms "; then
                hit=true; break
            fi
        done
        # Role match: agentRole in rule matches story role
        if [ -n "$match_role" ] && [ "$match_role" = "$story_role" ]; then
            hit=true
        fi

        if [ "$hit" = true ]; then
            local rules_text
            rules_text=$(jq -r --argjson idx "$i" '.[$idx].rules | .[]' \
                "$rules_file" 2>/dev/null | while IFS= read -r rule; do
                    echo "- $rule"
                done)
            matched_rules="${matched_rules}${rules_text}"$'\n'
        fi
        i=$((i + 1))
    done

    if [ -n "$matched_rules" ]; then
        DYNAMIC_CONSTITUTION=$'\n'"ADDITIONAL BEHAVIORAL RULES FOR THIS STORY:"$'\n'"$matched_rules"
        log "  DynamicConstitution: matched rules injected for story $story_id"
    fi
}

# resolve_provider_settings <story_id>
# Reads aiProvider from the story and sets STORY_PROVIDER global.
# Values: opencode | codex | epam | provider aliases (default: whatever the active set can route)
#
# THE ROSTER'S CHOICE IS VALIDATED, NOT JUST DEFAULTED. This is the exact incident
# ladder-providers.js's own comment records: "the prd-model-coordinator writes an aiProvider into
# every story, and until 2026-08-28 its persona named {minimax, openrouter} in prose. On the
# claude stack that is a provider nothing can route." resolve_primary_provider() is what catches
# that — an assigned-but-unroutable value is replaced by one the active set CAN route, announced,
# never silently. An unassigned story used to default to "codex" unconditionally: a vendor no
# provider set can select, and whose binary does not exist on a claude-only machine.
resolve_provider_settings() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    STORY_PROVIDER=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .aiProvider // empty' \
        "$prd_target" 2>/dev/null | head -1)
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    log "  Provider[$STORY_PROVIDER] -> CLI=$(provider_to_cli "$STORY_PROVIDER")"
}

# provider_to_cli <provider>
# Returns the CLI binary name for a given aiProvider value.
# Exits with an error for unknown providers — no silent Claude fallback.
provider_to_cli() {
    case "$1" in
        opencode)                    echo "opencode" ;;
        codex)                       echo "codex" ;;
        codemie-claude)              echo "codemie-claude" ;;
        # Plain Claude Code. Added 2026-08-25 for the mockserver set, which runs it
        # redirected at MockServer via ANTHROPIC_BASE_URL. It was previously listed in
        # providers.json with NO case arm — a PRD could name it, pass the gate, and die
        # here at runtime. Now it is genuinely accepted, so the gate and the engine agree.
        claude)                      echo "claude" ;;
        copilot|openai|openrouter|cursor|minimax)  echo "$EPAM_CLI" ;;
        epam)                        echo "$EPAM_CLI" ;;
        *)
            error "Unknown aiProvider '$1' — set aiProvider in prd.json to one of: opencode|codex|copilot|openai|openrouter|cursor|minimax|codemie-claude|claude"
            return 1
            ;;
    esac
}

# normalize_provider_json <provider> <raw_jsonl_file> <out_json_file>
# Converts provider-specific JSONL output into a normalized JSON object
# matching Claude's format: {result, total_cost_usd, usage.{input_tokens,output_tokens}}
normalize_provider_json() {
    local provider="$1"
    local raw_file="$2"
    local out_file="$3"
    case "$provider" in
        opencode)
            # OpenCode emits JSONL stream; try step_finish first, then fall back to any cost/usage field
            local sf_line
            sf_line=$(grep '"type":"step_finish"' "$raw_file" 2>/dev/null | tail -1)
            if [ -z "$sf_line" ]; then
                sf_line=$(grep -E '"cost"|"total_cost"' "$raw_file" 2>/dev/null | tail -1 || echo '{}')
            fi
            sf_line="${sf_line:-{\}}"
            # Extract text parts for result summary
            local result_text
            result_text=$(grep '"type":"text"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].part.text // .[].text // ""] | join("")' 2>/dev/null || echo "opencode run completed")
            # --rawfile: a full model turn can exceed ARG_MAX, and argv would fail with 126
            # ("Argument list too long") leaving an empty result that reads as "no output".
            local _rt_file; _rt_file=$(mktemp "${TMPDIR:-/tmp}/rt-XXXXXX")
            printf '%s' "$result_text" > "$_rt_file"
            jq -n \
                --rawfile rt "$_rt_file" \
                --argjson sf "$sf_line" \
                '{result: $rt,
                  total_cost_usd: ($sf.cost // $sf.part.cost // $sf.total_cost // 0),
                  usage: {
                      input_tokens:  ($sf.tokens.input  // $sf.part.tokens.input  // $sf.usage.input_tokens  // 0),
                      output_tokens: ($sf.tokens.output // $sf.part.tokens.output // $sf.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codex)
            # Codex emits JSONL stream; turn.completed has usage (no cost field)
            local tc_line
            tc_line=$(grep '"type":"turn.completed"' "$raw_file" 2>/dev/null | tail -1)
            tc_line="${tc_line:-{\}}"
            local result_text
            result_text=$(grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                | jq -rs '[.[].item.text // ""] | join("")' 2>/dev/null || echo "codex exec completed")
            # --rawfile: a full model turn can exceed ARG_MAX, and argv would fail with 126
            # ("Argument list too long") leaving an empty result that reads as "no output".
            local _rt_file; _rt_file=$(mktemp "${TMPDIR:-/tmp}/rt-XXXXXX")
            printf '%s' "$result_text" > "$_rt_file"
            jq -n \
                --rawfile rt "$_rt_file" \
                --argjson tc "$tc_line" \
                '{result: $rt,
                  total_cost_usd: 0,
                  usage: {
                      input_tokens:  ($tc.usage.input_tokens  // 0),
                      output_tokens: ($tc.usage.output_tokens // 0)
                  }}' > "$out_file" 2>/dev/null
            ;;
        codemie-claude)
            # codemie-claude: same output format as Claude — nothing to normalize
            ;;
        epam)
            # epam: same output format as Claude — nothing to normalize
            ;;
        epam-run)
            # epam run --json output: {result, cost_usd, usage:{inputTokens,outputTokens}}
            # Pick the last JSON object that has a "result" field (guards against pino log lines,
            # which never carry a "result" key). Do NOT filter on result != "" — agents that only
            # write files produce result:"" legitimately, and excluding them drops real cost data.
            jq -s '[.[] | select(has("result"))] | last // {result:"",cost_usd:0,usage:{inputTokens:0,outputTokens:0}} | {
                result:          (.result // ""),
                total_cost_usd:  (.cost_usd // 0),
                usage: ({
                    input_tokens:  (.usage.inputTokens  // 0),
                    output_tokens: (.usage.outputTokens // 0)
                }
                # Carry the cached subset THROUGH. Rebuilding usage from scratch discarded it, so
                # the cost ledger recorded cache_read_tokens: 0 and the cost line printed
                # "cached 0 = 0.0%" for an attempt the per-turn trace measured at 98.9% cached
                # (live 2026-08-10). Caching is the largest efficiency change made to this
                # pipeline and every cost figure was blind to it.
                #
                # `if has` rather than `// 0`: a provider that reports nothing about caching has
                # not reported ZERO caching, and an unmeasured value recorded as a measured zero
                # is the defect this pipeline keeps reproducing. Absent stays absent; the display
                # side is what chooses how to render it.
                + (if (.usage | has("cached_input_tokens"))
                   then {cached_input_tokens: .usage.cached_input_tokens} else {} end))
            }' "$raw_file" > "$out_file" 2>/dev/null || true
            ;;
        *)
            # Claude: already emits normalized JSON; nothing to do
            ;;
    esac
}

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
# These allow Claude to read/write files and execute commands without prompting
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

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" >&2
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    echo "[ERROR] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
    echo "[SUCCESS] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" >&2
    echo "[WARNING] [$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$PROGRESS_LOG"
}

info() {
    echo -e "${CYAN}[INFO]${NC} $1" >&2
}

# Initialize directories and logs
initialize() {
    mkdir -p "$(dirname "$PROGRESS_LOG")"
    mkdir -p "$CLAUDE_OUTPUT_DIR"

    if [ ! -f "$PROGRESS_LOG" ]; then
        cat > "$PROGRESS_LOG" << EOF
=== EPAM CLI Orchestration Progress Log ===
Started: $(date)
Project: $(jq -r '.project.name // "Unknown"' "$PRD_FILE" 2>/dev/null || echo "Unknown")
==========================================

EOF
    fi
}

# Check prerequisites
check_prerequisites() {
    # Check for jq
    if ! command -v jq &> /dev/null; then
        error "jq is required but not installed. Install with: sudo apt install jq"
        exit 1
    fi

    # Check for Claude CLI only when actually needed (provider=claude or codemie-claude)
    if command -v "$CLAUDE_CMD" &> /dev/null; then
        : # claude is available — all paths work
    else
        # TWO INDEPENDENT WAYS A STORY CAN NEED CLAUDE, both checked — this used to check only
        # the second and assumed "codex" for the first, so a PRD where every story leaves
        # aiProvider unset (the normal case) short-circuited straight to "OK, no story needs
        # claude" on the SAME machine where every unassigned story is about to resolve to claude.
        #
        # 1. THE ACTIVE SET'S OWN DEFAULT. What resolve_provider_settings() gives an UNASSIGNED
        #    story is exactly what resolve_primary_provider resolves with no candidate — if that
        #    is claude-family, every unassigned story needs the CLI, full stop.
        _default_needs_claude=0
        case "$(resolve_primary_provider)" in
            claude|codemie-claude) _default_needs_claude=1 ;;
        esac
        # 2. AN EXPLICIT PER-STORY OVERRIDE. A story can name claude/codemie-claude even when the
        #    set's own default is something else, as long as the active set can route it — the
        #    same routability question resolve_primary_provider answers for the DEFAULT case, but
        #    jq cannot call a bash function, so this stays a direct field check. `// empty`, not
        #    `// "codex"`: an unset field is genuinely unset, not a second, competing default.
        if [ "$_default_needs_claude" = "1" ] || \
           { grep -q '"aiProvider"' "${PRD_FILE:-/dev/null}" 2>/dev/null && \
             jq -e '.stories[].aiProvider // empty | select(. == "claude" or . == "codemie-claude")' \
                 "${PRD_FILE:-/dev/null}" >/dev/null 2>&1; }; then
            error "Claude CLI not found. Expected command: $CLAUDE_CMD"
            error "Install Claude Code CLI or set CLAUDE_CMD environment variable"
            exit 1
        fi
        log "Claude CLI not found — OK since no stories use the claude provider"
    fi

    # Check PRD file
    if [ ! -f "$PRD_FILE" ]; then
        error "PRD file not found at $PRD_FILE"
        exit 1
    fi

    # Validate PRD JSON
    if ! jq empty "$PRD_FILE" 2>/dev/null; then
        error "PRD file is not valid JSON"
        exit 1
    fi

    success "Prerequisites check passed"
}

# Get story details from PRD
get_story_details() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id)' "$PRD_FILE"
}

# Get story title
get_story_title() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title' "$PRD_FILE"
}

# Get story priority (high=1, medium=2, low=3)
# Check if story exists
story_exists() {
    local story_id=$1
    local exists
    exists=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .id' "$PRD_FILE")
    [ -n "$exists" ]
}

# Check if story is completed — looks in $PRD_FILE first, then $CROSS_CODELINE_PRD
# (a separate PRD from another codeline, e.g. the BE PRD when running the FE codeline).
# This allows FE stories to declare dependencies on BE stories without blocking.
is_story_completed() {
    local story_id=$1
    local completed
    completed=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .completed' "$PRD_FILE" 2>/dev/null)
    if [ "$completed" = "true" ]; then
        return 0
    fi
    # Not found or not completed in primary PRD — check cross-codeline PRD if set
    if [ -n "${CROSS_CODELINE_PRD:-}" ] && [ -f "${CROSS_CODELINE_PRD}" ]; then
        completed=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .completed' "$CROSS_CODELINE_PRD" 2>/dev/null)
        [ "$completed" = "true" ] && return 0
    fi
    return 1
}

# Get story dependencies
get_story_dependencies() {
    local story_id=$1
    jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .dependencies // [] | .[]' "$PRD_FILE"
}

# Check if all dependencies are satisfied (completed)
are_dependencies_satisfied() {
    local story_id=$1
    local deps
    deps=$(get_story_dependencies "$story_id")

    if [ -z "$deps" ]; then
        return 0  # No dependencies
    fi

    while IFS= read -r dep; do
        if [ -n "$dep" ] && ! is_story_completed "$dep"; then
            return 1  # Dependency not satisfied
        fi
    done <<< "$deps"

    return 0  # All dependencies satisfied
}

# ──────────────────────────────────────────────
# check_plan_mode_required <story_id>
# Returns 0 (true) when the story's complexity triggers plan mode.
# Triggers: estimatedHours >= 6, OR deps >= 2, OR planModeRequired flag.
# Bypass: SKIP_PLAN_MODE=true env var.
# ──────────────────────────────────────────────
check_plan_mode_required() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    is_truthy "${SKIP_PLAN_MODE:-}" && return 1

    local estimated_hours dep_count plan_flag
    estimated_hours=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target" 2>/dev/null || echo 0)
    dep_count=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | (.dependencies // []) | length' "$prd_target" 2>/dev/null || echo 0)
    plan_flag=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.planModeRequired // false' "$prd_target" 2>/dev/null || echo false)

    [ "$plan_flag" = "true" ] && return 0
    # Use awk for float comparison (avoids bc dependency for this check)
    awk -v h="$estimated_hours" 'BEGIN{exit !(h >= 6)}' && return 0
    [ "${dep_count:-0}" -ge 2 ] && return 0
    return 1
}

# ──────────────────────────────────────────────
# run_plan_mode <story_id>
# Invokes Claude in planning mode to produce execution-ready artifacts.
# Posts a plan_summary message to agent-messages.jsonl when complete.
# ──────────────────────────────────────────────
run_plan_mode() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local plan_log
    plan_log="$CLAUDE_OUTPUT_DIR/${story_id}_plan_$(date +'%Y%m%d_%H%M%S').log"
    local plan_json="${plan_log%.log}_result.json"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"

    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local plan_prompt
    # RENDERED FROM THE TEMPLATE LAYER. Both provider scripts render the same document —
    # they carried separate copies that had already drifted, and the copy here had the
    # messages path written into the prompt text rather than passed as data.
    _pp_vals=$(mktemp "${TMPDIR:-/tmp}/story-plan-agent-vals-XXXXXX.json")
    jq_vals --arg story_id "$story_id" \
          --arg messages_jsonl "$messages_jsonl" \
          --arg agent_role "$agent_role" \
          --arg current_phase "${CURRENT_PHASE:-unknown}" \
          '{"__STORY_ID__":$story_id,"__MESSAGES_JSONL__":$messages_jsonl,"__AGENT_ROLE__":$agent_role,"__CURRENT_PHASE__":$current_phase}' > "$_pp_vals"
    plan_prompt="$(render_engine_prompt story-plan-agent "$_pp_vals")"
    rm -f "$_pp_vals"

    log "Plan mode: generating execution plan for $story_id..."
    touch "$messages_jsonl"
    cd "$PROJECT_ROOT"

    local plan_ok=false
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        # SDK path: extended thinking enabled for plan mode (high-complexity reasoning)
        if echo "$plan_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                --cache-system \
                --model "$STORY_MODEL" \
                --thinking-budget 8000 \
                --output "$plan_json" 2>/dev/null; then
            plan_ok=true
        fi
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model
        _orch_model="$(seam_model_or_fail "phase-assessment" 2>/dev/null || true)"
        if [ -z "$_orch_provider" ]; then
            warning "Plan mode: EPAM_ORCHESTRATION_PROVIDER not set — skipping plan"
        # AI_GATE_ALLOW_TOOLS=1: the plan_prompt below explicitly instructs the
        # agent to "Read orchestrations/prd.json for story ${story_id}" — without
        # this, ai-run.sh's epam-umbrella branch defaults to --no-tools and the
        # agent has no way to actually read anything, so the plan gets
        # fabricated from whatever it happens to guess (found live 2026-07-08).
        elif echo "$plan_prompt" | \
                AI_GATE_ALLOW_TOOLS=1 \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                > "$plan_json" 2>>"$plan_log"; then
            # Wrap plain text output into the expected {result:...} shape
            plan_text_raw=$(cat "$plan_json")
            printf '{"result":%s}' "$(echo "$plan_text_raw" | jq -Rs .)" > "$plan_json"
            plan_ok=true
        fi
    fi

    if [ "$plan_ok" = true ]; then
        jq -r '.result // empty' "$plan_json" 2>/dev/null >> "$plan_log" || true
        success "Plan mode completed for $story_id — see $plan_log"
    else
        warning "Plan mode failed for $story_id — continuing with direct implementation"
    fi
}

# ──────────────────────────────────────────────
# post_completion_message <story_id> <status>
# Appends a status message to agent-messages.jsonl after each story run.
# Only writes when ORCH_MODE=hybrid OR the bus file already exists.
# ──────────────────────────────────────────────
post_completion_message() {
    local story_id="$1"
    local status="$2"   # "completed" | "failed"
    local messages_jsonl="${MESSAGES_JSONL:-$LOG_DIR/agent-messages.jsonl}"
    local lock_file="${messages_jsonl}.lock"

    # Always write — file is created by orchestration init for both bash and hybrid modes
    touch "$messages_jsonl"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_role
    agent_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target" 2>/dev/null || echo "unknown")

    local phase_id="${CURRENT_PHASE:-unknown}"
    local timestamp
    timestamp=$(date -Iseconds)
    local epoch
    epoch=$(date +%s)
    local msg_id="status_${story_id}_${epoch}"

    local message
    message=$(jq -cn \
        --arg id      "$msg_id" \
        --arg ts      "$timestamp" \
        --arg from    "$agent_role" \
        --arg to      "orchestrator" \
        --arg sid     "$story_id" \
        --arg pid     "$phase_id" \
        --arg subj    "Story $story_id $status" \
        --arg body    "Story $story_id finished with status: $status" \
        --arg sstatus "$status" \
        '{
            id: $id, timestamp: $ts,
            from_agent: $from, to_agent: $to,
            story_id: $sid, phase_id: $pid,
            message_type: "status",
            priority: "normal",
            subject: $subj, body: $body,
            story_status: $sstatus,
            status: "new"
        }')

    touch "$messages_jsonl"
    (
        flock -w 10 200 || return 0
        echo "$message" | jq -c '.' >> "$messages_jsonl"
    ) 200>"$lock_file"
}

# Log event to agent-status.json if running in orchestration mode
log_to_monitor() {
    local event_type=$1
    local story_id=$2
    local message=$3
    local monitor_file="${MONITOR_FILE:-$LOG_DIR/agent-status.json}"

    # Only log if monitor file exists (orchestration mode)
    if [ ! -f "$monitor_file" ]; then
        return 0
    fi

    local lane="${WORKTREE_MODE:-main}"
    local role
    role=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local timestamp
    timestamp=$(date -Iseconds)

    # Use flock to prevent race conditions
    (
        flock -w 5 200 || return 1

        # Add event to events array
        local tmp_file="${monitor_file}.tmp.$$"
        jq --arg type "$event_type" \
           --arg story "$story_id" \
           --arg lane "$lane" \
           --arg role "$role" \
           --arg msg "$message" \
           --arg ts "$timestamp" \
           '.events += [{"type": $type, "story": $story, "lane": $lane, "role": $role, "message": $msg, "timestamp": $ts}]' \
           "$monitor_file" > "$tmp_file" && mv "$tmp_file" "$monitor_file"
    ) 200>"${monitor_file}.lock"
}

# Get list of available phases
get_phases() {
    jq -r '.implementationOrder | keys[]' "$PRD_FILE" 2>/dev/null
}

# Get stories for a specific phase
get_phase_stories() {
    local phase=$1
    jq -r --arg phase "$phase" '.implementationOrder[$phase] // [] | .[]' "$PRD_FILE"
}

# Get the phase a story belongs to
get_story_phase() {
    local story_id=$1
    jq -r --arg id "$story_id" '.implementationOrder | to_entries[] | select(.value | contains([$id])) | .key' "$PRD_FILE" | head -1
}

# Get list of incomplete stories
get_incomplete_stories() {
    jq -r '.stories[] | select((.completed // false) == false) | .id' "$PRD_FILE"
}

# Get prioritized list of incomplete stories (respects phases, dependencies, priority)
get_prioritized_stories() {
    local result=()

    # Get phases in order
    local phases
    phases=$(get_phases)

    if [ -z "$phases" ]; then
        # No phases defined, fall back to all incomplete stories sorted by priority
        jq -r '.stories[] | select((.completed // false) == false) | "\(.priority // "medium")|\(.id)"' "$PRD_FILE" | \
            sort -t'|' -k1,1 | cut -d'|' -f2
        return
    fi

    # Process each phase in order
    while IFS= read -r phase; do
        [ -z "$phase" ] && continue

        # Get stories in this phase
        local phase_stories
        phase_stories=$(get_phase_stories "$phase")

        # For each story in the phase, check if it's incomplete and dependencies are met
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue

            if ! is_story_completed "$story_id" && are_dependencies_satisfied "$story_id"; then
                echo "$story_id"
            fi
        done <<< "$phase_stories"
    done <<< "$phases"
}

# Get next story to implement (first incomplete with satisfied dependencies)
get_next_story() {
    get_prioritized_stories | head -1
}

# List available phases with status
list_phases() {
    echo ""
    echo -e "${MAGENTA}=== Implementation Phases ===${NC}"
    echo ""

    local phases
    phases=$(get_phases)

    if [ -z "$phases" ]; then
        echo -e "${YELLOW}No phases defined in implementationOrder${NC}"
        return
    fi

    while IFS= read -r phase; do
        [ -z "$phase" ] && continue

        local total=0
        local completed=0
        local stories
        stories=$(get_phase_stories "$phase")

        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            total=$((total + 1))
            if is_story_completed "$story_id"; then
                completed=$((completed + 1))
            fi
        done <<< "$stories"

        local status_color=$YELLOW
        local status_icon="o"
        if [ $completed -eq $total ] && [ $total -gt 0 ]; then
            status_color=$GREEN
            status_icon="+"
        elif [ $completed -gt 0 ]; then
            status_color=$CYAN
            status_icon="~"
        fi

        echo -e "${status_color}${status_icon}${NC} ${WHITE}$phase${NC} ($completed/$total completed)"

        # Show stories in phase
        while IFS= read -r story_id; do
            [ -z "$story_id" ] && continue
            local title
            title=$(get_story_title "$story_id")
            if is_story_completed "$story_id"; then
                echo -e "    ${GREEN}+${NC} $story_id: $title"
            else
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                local deps_info=""
                if [ -n "$deps" ]; then
                    if are_dependencies_satisfied "$story_id"; then
                        deps_info=" ${CYAN}(deps: $deps)${NC}"
                    else
                        deps_info=" ${RED}(blocked by: $deps)${NC}"
                    fi
                fi
                echo -e "    ${YELLOW}o${NC} $story_id: $title$deps_info"
            fi
        done <<< "$stories"
        echo ""
    done <<< "$phases"
}

# Get project context for Claude
get_project_context() {
    local stack
    stack=$(jq -r '.project.stack | to_entries | map("\(.key): \(.value)") | join(", ")' "$PRD_FILE" 2>/dev/null || echo "")
    # Project-level criteria are optional. When absent this used to emit the
    # heading followed by a bare "- ", which reads to the agent as "there is a
    # criterion here" while carrying none — observed live 2026-07-29, where the
    # story ALSO had no acceptance criteria of its own, so the prompt asserted
    # constraints twice and supplied none. An absent section is honest; an empty
    # one is misleading.
    local criteria
    criteria=$(jq -r '(.acceptanceCriteria // []) | join("\n- ")' "$PRD_FILE" 2>/dev/null || echo "")

    cat << EOF
Project: $(jq -r '.project.name' "$PRD_FILE")
Description: $(jq -r '.project.description' "$PRD_FILE")
Tech Stack: $stack

$([ -n "${criteria//[[:space:]]/}" ] && printf 'Global Acceptance Criteria:\n- %s' "$criteria" || true)
EOF
}

# Build prompt for Claude to implement a story
# WHICH LANE AM I? A story may SPAN codelines, and _filtered_prd() copies such a story
# WHOLE into every lane's PRD — .codeline/.codelines are left untouched — so the story
# itself cannot say which lane is executing it. The only per-lane signal the orchestrator
# writes is project.outputDir (set to that lane's checkout), so the lane name is recovered
# by matching it back against project.outputDirs[]. Single-codeline PRDs carry no
# outputDirs: the result is empty and every caller degrades to its previous behaviour.
_current_lane() {
    local _story_json="${1:-}"
    local _l="${CODELINE_NAME:-}"
    if [ -z "$_l" ] && [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _l=$(jq -r '.project as $p | (($p.outputDirs // []) | map(select(.path == $p.outputDir)) | .[0].codeline) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    [ -n "$_l" ] || _l=$(echo "$_story_json" | jq -r '.codeline // empty' 2>/dev/null)
    printf '%s' "$_l"
}

# Render technicalNotes for ONE lane.
#
# technicalNotes is rendered by dumping every key, so ANY per-codeline structure stored
# there reaches the agent in full — every lane's paths, and the fact that they diverge.
# Live 2026-08-03: the per-codeline manifest stored here handed a gotransit-scoped writer
# the maps for all three repos; it went cross-repo and one call billed in=1,916,632
# out=40,859 ($0.624, 11.58 min) producing nothing, ending "Let me confirm the scope with
# the user before proceeding" — in a non-interactive loop, a dead end.
#
# The projection is SHAPE-based, never keyed to a field name: any object that has the
# current lane as a key collapses to that lane's entry. Excluding one known field by name
# would leave the next per-codeline field leaking, in a different file, forever.
_render_technical_notes() {
    local _notes="${1:-}" _cl="${2:-}"
    if [ -z "$_notes" ]; then echo "None specified"; return 0; fi
    # THIS LANE'S ENTRY SUPERSEDES THE UNION.
    #
    # technicalNotes carries a flat `files` (the union across every codeline) beside a
    # `perCodeline` map holding the correct per-lane lists. The object-scoping below narrows
    # per-codeline OBJECTS, but `files` is an ARRAY and sailed straight through, so the prompt
    # stated the union AND the lane's own list. Live 2026-08-09 gotransit's writer prompt named a
    # component that exists only in next.metrolinx.com, twice, and the writer duly created it.
    #
    # perCodeline[$cl] is merged OVER the top level key-by-key, so a key it defines wins and a key
    # it does not mention is preserved — dropping unrelated guidance would be its own defect. The
    # map itself is then never rendered raw, which also stops the other lanes' paths reaching the
    # prompt by that second route. Nothing here names a specific key; whatever the spec pass
    # produces is scoped the same way.
    echo "$_notes" | jq -r --arg cl "$_cl" '
        (if type == "object" then . else {} end) as $all
        | (($all.perCodeline // {})[$cl] // {}) as $scoped
        | (($all | del(.perCodeline)) * $scoped)
        # Coercing a non-object to {} above removed the jq ERROR that used to trigger the
        # "None specified" fallback, so an empty or malformed notes value rendered as a blank
        # line instead. Say it explicitly: a prompt section that silently renders nothing reads
        # as "no constraints" to the writer.
        | if (. | length) == 0 then "None specified" else (
          to_entries
        | map(if (.value | type) == "object" and ($cl | length) > 0 and (.value | has($cl))
              then {key: .key, value: (.value[$cl])}
              else . end)
        | map("- \(.key): \(.value)")
        | join("\n")) end' 2>/dev/null || echo "None specified"
}

# story_declared_files — this story's declared files, RESOLVED FOR THE LANE THAT IS RUNNING.
#
# One definition, because there were eight. The flat technicalNotes.files array is the union across
# every codeline in the story's DECLARED spelling; spec-mode-runner resolves each path against each
# codeline's real checkout and persists technicalNotes.perCodeline.<codeline>.files. Only one of
# the eight derivations read the resolved list, so the prompt rendered the same set twice from two
# sources that disagreed — one carrying a path absent from this checkout, one carrying a path whose
# case was wrong, listed twice. Feeding that wrong-case path through _resolve_deliverable_path is
# also what produced the warning that used to be captured into the prompt body.
#
# Falls back to the flat array when this lane has no entry (a PRD written before perCodeline
# existed, or a lane added later). Never falls back to NOTHING: handing the writer an empty file
# list is worse than handing it an imperfect one.
#
# De-duplicated, because a declaration repeated in the PRD renders repeatedly in the prompt.
# Emits one path per line; callers join as they need.
story_declared_files() {
    local _story_json="$1"
    local _lane _out
    _lane=$(_current_lane "$_story_json" 2>/dev/null || printf '')
    if [ -n "$_lane" ]; then
        _out=$(printf '%s' "$_story_json" | jq -r --arg cl "$_lane" \
            '(.technicalNotes.perCodeline[$cl].files // []) | .[]' 2>/dev/null)
    fi
    [ -n "${_out:-}" ] || _out=$(printf '%s' "$_story_json" | jq -r \
        '(.technicalNotes.files // []) | .[]' 2>/dev/null)
    printf '%s\n' "$_out" | awk 'NF && !seen[$0]++'
}

build_implementation_prompt() {
    local story_id=$1
    local story_json
    story_json=$(get_story_details "$story_id")

    local title
    title=$(echo "$story_json" | jq -r '.title')
    local description
    description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria
    acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes
    technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    # Prefer THIS lane's resolved paths. The flat technicalNotes.files array is shared
    # by every codeline, but separate repositories spell the same file differently —
    # live 2026-08-03 the detective's root-cause fix site resolved on one lane of three,
    # and the two writers handed a non-existent path could not do the work they were
    # then blocked for. spec-mode-runner resolves each declared path against each
    # codeline's own checkout and persists technicalNotes.perCodeline.<codeline>.files;
    # falling back to the flat array keeps older PRDs working unchanged.
    local _cl_name
    _cl_name=$(_current_lane "$story_json")
    local _lane="$_cl_name"
    # Lane-resolved, de-duplicated, one definition — see story_declared_files.
    local files
    files=$(story_declared_files "$story_json" | paste -sd', ' -)

    local dependencies
    dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # In worktree mode, rewrite ALL occurrences of the main repo absolute path in the
    # prompt text. The canonical PRD embeds absolute paths in acceptanceCriteria,
    # technicalNotes, and files — agents read these and write to those exact paths,
    # bypassing any write-first directive. Replace every reference so the agent only
    # ever sees the worktree path and writes files to the correct directory.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    # Root-cause analysis from the code-graph-detective (brownfield). The
    # detective already traced the CAUSAL fix site and WHY it's wrong (often a
    # cross-file bug — e.g. an ID transformed in one function that a match in
    # another function doesn't account for). Injecting its reason strings here
    # means the coding agent starts WITH the answer instead of re-reading files
    # to re-discover it — which is exactly what bloats a "bad" retry's token
    # count (found live 2026-07-23: attempt read 143k tokens tracing the bug,
    # wrote nothing). Each entry: the file, the function, and the root cause.
    # DOES THE STORY HAVE A PLAN? A PRESENCE question, not a rendering one — the two decisions
    # below turn on whether an investigation produced anything, never on how it reads. Asked of
    # the published store rather than of the detective's fields, so this stays true for any
    # producer of the kind.
    local _has_fix_plan=""
    if "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/agent-io.js" present "$story_id" fix-plan; then
        _has_fix_plan="yes"
    fi
    # RENDERED BY THE PRODUCER. The detective is the only actor that knows what its own fields
    # mean, so it is the only one that turns them into words — see lib/producers/fix-plan.js for
    # what two copies of this rendering had already cost. A failure to render is NOT an empty
    # plan: a writer prompted without the root-cause analysis re-traces it from scratch, which is
    # the 143k-token retry this block exists to prevent.
    # THE WRITER RECEIVES WHAT ITS ARCHETYPE DECLARED IT CONSUMES — see lib/agent-inputs.js.
    # Not "the engine decides what to show the writer": the archetype lists the kinds, producers
    # publish them, and each arrives under the authority the writer own prompt document gives it.
    # A kind nobody published contributes nothing, which is why no conditional guards this.
    # A REQUIRED kind nobody published is a hard failure: a prompt missing the root-cause analysis
    # looks exactly like one that has it, and costs a whole retry to discover.
    local agent_inputs
    # NOTE (2026-08-14): the default below names an archetype, which is engine code choosing a
    # role. Removing it and refusing instead was tried and REVERTED the same day: stories
    # legitimately omit agentRole, and the refusal failed every one of them at prompt-build.
    # Making agentRole mandatory is a deliberate PRD change with a migration, not a one-line edit
    # here — see the sweep notes.
    agent_inputs=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/agent-inputs.js" \
        "$(echo "$story_json" | jq -r '.agentRole // "story-writer"')" "$story_id") || {
        error "  [prompt] declared inputs did not render for $story_id — refusing to build a writer prompt without them"
        return 1
    }

    # Verification Criteria (VC) — the observable checks openspec-brownfield
    # produced (mechanism-free, from AC ∪ description). The impl agent must make
    # the change satisfy these; the ACs above are the intent, the VCs are what a
    # tester will actually confirm. Persisted on the story → PRD.
    local verification_criteria
    verification_criteria=$(echo "$story_json" | jq -r '(.verificationCriteria // []) | map("- " + .) | join("\n")' 2>/dev/null || echo "")

    # Codeline facts (real, project-operator-curated gotchas — see the
    # Metrolinx codeline-context plugin's own docs) — injected DIRECTLY into
    # the prompt rather than left as an optional tool call. Built 2026-08-02:
    # the codeline_facts plugin tool existed and was correct, but
    # across a full Writer Retest run the model called it exactly once
    # (git_state) and never codeline_facts — the facts
    # that would have told it the right token key never reached the model
    # that needed them. Relying on the model to spontaneously discover an
    # optional tool isn't working; injecting the same facts directly here
    # means every invocation sees them regardless of tool-calling behavior.
    # Advertise whatever plugin tools THIS codeline registered (runtime discovery — no
    # client tool name lives in this engine). Without this the tools are loaded and
    # callable but the model is never shown them, so it never calls them.
    local project_tools_block
    project_tools_block=$(build_project_tools_block "$PROJECT_ROOT")

    local codeline_facts_block=""
    local _codeline_facts_file="${PROJECT_ROOT}/.epam/codeline-facts.json"
    if [ -f "$_codeline_facts_file" ]; then
        local _codeline_facts
        _codeline_facts=$(jq -r '
          (if type == "array" then . else (.facts // []) end)
          | map(if type == "object" then (.text // "") else . end)
          | map(select(length > 0))
          | map("- " + .) | join("\n")
        ' "$_codeline_facts_file" 2>/dev/null || echo "")
        [ -n "$_codeline_facts" ] && codeline_facts_block=$(printf '\n## Codeline-Specific Facts (real, curated gotchas for THIS codeline — read before assuming local tooling behaves like a fully-configured environment)\n%s\n' "$_codeline_facts")
    fi

    # REQUIRED bug-reproducing test (brownfield defect). The repro-gate (Step 3.55)
    # HARD-BLOCKS any brownfield change that ships no test which FAILS on the pre-fix
    # baseline and PASSES with the fix. For a single-agent defect story NOTHING else
    # writes that test — the TC-writer only serves separate test-engineer stories —
    # so the impl agent MUST write it here. Found live 2026-07-24 (AMSD-1820): with
    # only a weak "your accompanying test should assert them", the agent shipped a
    # garbage file literally named `test` (a copy of the SOURCE) and no real test.
    # Make the requirement explicit, concrete (a real co-located path the repro-gate
    # recognises: *.test.*), and unambiguous. Fires for brownfield defects (fix site
    # known); novel brownfield still gets the VC "your test asserts these" guidance.
    # B1 (2026-07-24) — impl writes ONLY the fix. The reproducing test belongs to
    # brownfield-repro-test-writer.sh, which gets its own agent turn AFTER the fix
    # commits, and (since 2026-07-24) VALIDATES the test parses and runs before
    # committing it, with retry + ladder + self-heal on failure.
    #
    # This block used to MANDATE that impl ship a co-located *.test.* file. That was
    # a hedge taken when the test-writer produced nothing at all. Measured cost of
    # keeping it: the 15:36 run was killed at 7 impl attempts / $1.11, having
    # committed apply-report-discounts.service.test.ts, with the failure-analyst's
    # own diagnosis pointing AT that file ("Test file accesses possibly-undefined
    # variables without null narrowing under strict mode"). Six consecutive quality
    # failures were spent fighting a test impl should never have written.
    #
    # Enforcement is unchanged — the repro-gate still BLOCKS a fix that ships
    # without a reproducing test. Only authorship moved.
    # CONDITION WIDENED 2026-08-08. This used to require a non-empty fix_site_analysis, so a
    # story reaching the writer WITHOUT one was never told that tests belong to the dedicated
    # repro-test-writer turn — and the agent's own roster brief was then the only instruction
    # in play. On AMSD-2041 that brief said "You write Jest tests... colocated alongside the
    # modules you edit", the exact opposite. DET-1 makes "investigated, found nothing" a
    # legitimate state, so the no-fix-site path gets MORE traffic, not less.
    #
    # Authorship is a brownfield property, not a fix-site property: brownfield-repro-test-writer
    # takes its own turn either way. Enforcement is untouched — the repro-gate still blocks a
    # fix that ships without a reproducing test.
    # ONE POLICY, RENDERED FROM THE PROMPT LAYER, READ BY BOTH AGENTS.
    #
    # This was a heredoc HERE and nowhere else, so team-lead-review.sh had never heard of it and
    # was told "Check: ... test coverage". It raised a blocker for missing tests; 33ee47b then
    # hardened this side — "a BLOCKER is a required deliverable ... the only way to resolve it is
    # to CREATE it" — leaving the writer ORDERED TO CREATE WHAT IT IS FORBIDDEN TO CREATE. Both
    # halves now come from prompts/test-ownership.json, so the rule cannot be changed for one
    # agent and not the other.
    local test_ownership_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _to_vals; _to_vals=$(mktemp)
        printf '{}' > "$_to_vals"
        test_ownership_block=$(printf '\n%s\n' "$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
            render test-ownership "${EPAM_PROJECT_CONFIG_DIR:-}" "$_to_vals" writer 2>/dev/null)")
        rm -f "$_to_vals"
        # A policy that failed to render is not an empty policy: the writer would silently regain
        # permission to write tests, which is the failure this whole change removes.
        if [ -z "$(printf '%s' "$test_ownership_block" | tr -d '[:space:]')" ]; then
            error "  [prompt] test-ownership policy failed to render — refusing to build a writer prompt without it"
            return 1
        fi
    fi

    # Reviewer feedback (review→re-implement loop): if a prior team-lead review
    # requested changes, its issues are written to review-feedback-<id>.json.
    # Inject them so THIS re-implementation directly addresses what the reviewer
    # flagged (e.g. "over-engineered — a more concise change would do; reuse the
    # existing helper"). This is the reviewer telling the impl agent what to fix.
    local review_feedback="" _review_feedback_file="${LOG_DIR:-$(dirname "$SCRIPT_DIR")/logs}/review-feedback-${story_id}.json"
    if [ -f "$_review_feedback_file" ]; then
        # BLOCKERS FIRST, AND SEPARATELY. Rendering every finding into one flat list let a
        # blocker-severity requirement ("no tests were added") sit beside advisory notes about
        # over-engineering, under a preamble ending "do not add more code". The writer averaged
        # them and produced nothing three cycles running, and the story was still marked
        # complete. A required deliverable and a suggestion must not look alike.
        review_feedback=$(jq -r '
          def render: map(
            "- [" + (.severity // "issue") + "] " + (.description // "")
            + (if (.file // "") != "" then " (" + .file + (if (.line // 0) > 0 then ":" + (.line|tostring) else "" end) + ")" else "" end)
            + (if (.suggestedFix // "") != "" then "\n  - Suggested fix: " + .suggestedFix else "" end)
          ) | join("\n");
          (.issues // []) as $all
          | ($all | map(select((.severity // "") == "blocker"))) as $blockers
          | ($all | map(select((.severity // "") != "blocker"))) as $rest
          | (if ($blockers | length) > 0 then "### BLOCKERS — this attempt is REJECTED until every one is resolved\n" + ($blockers | render) + "\n" else "" end)
          + (if ($rest | length) > 0 then "### Advisory — apply where it makes the change smaller or clearer\n" + ($rest | render) else "" end)
          ' "$_review_feedback_file" 2>/dev/null || echo "")
    fi

    # Persisted skill notes (cross-run learning — found live 2026-08-02):
    # profiles.json's [Self-Heal] notes (both FailureAnalyst's tsc/test-failure
    # diagnoses and Step 3.6's review-rejection lessons, see
    # _persist_skill_note_simple() in lib/story-guards.sh) were being WRITTEN
    # correctly but never READ back into this prompt — the only functions that
    # ever consulted profiles.json's role text were the REVIEWER's own persona,
    # FailureAnalyst's own diagnostic context (a different prompt, not this
    # one), and duplicate-check gates before appending a NEW note. A brand new
    # run's first attempt at a story never saw a single word of what a PRIOR
    # run had already learned about it. Confirmed live: upexpress's writer
    # reproduced the IDENTICAL dead-code live_preview-forwarding defect on a
    # fresh relaunch despite two prior review rejections and a correctly
    # persisted, file/line-precise note — this is the fix. review_feedback
    # (above) covers the SAME-run retry loop; this covers what a prior, now-
    # finished run already learned. Scoped to [Self-Heal] lines only — the
    # rest of a role's profile text is its base persona/instructions, already
    # a much larger, separate concern.
    local skill_note_block=""
    local story_role
    story_role=$(echo "$story_json" | jq -r '.agentRole // ""' 2>/dev/null || echo "")
    if [ -n "$story_role" ] && [ -f "$AGENT_PROFILES_FILE" ]; then
        local _persisted_skill_notes
        # Notes are persisted as \n\n-separated paragraphs (see
        # _persist_skill_note_simple(), lib/story-guards.sh), each starting
        # with "[Self-Heal] " — a plain-line grep only keeps the FIRST line of
        # a multi-line note, silently truncating the actual diagnosis
        # (e.g. the specific functions/ACs a real persisted note names).
        # Paragraph-mode awk (RS="") keeps each whole note intact.
        # Notes are appended into the agent's persona, so they come from wherever the persona
        # does — the roster. `|| true`: an agent with no notes is the normal case, and this is
        # context for the writer rather than a gate, so absence must not stop a story.
        _persisted_skill_notes=$(roster_persona "$story_role" 2>/dev/null | \
            awk -v RS='' -v ORS='\n\n' '/\[Self-Heal\]/' || true)
        if [ -n "$_persisted_skill_notes" ]; then
            skill_note_block=$(printf '\n## Lessons From Prior Runs (persisted — a previous attempt at this or a similar story already hit these problems)\n%s\n' "$_persisted_skill_notes")
        fi
    fi

    # testCriteria — written by TC writer from actual source; ground truth for test stories.
    # Extracted after worktree path rewriting (TC fields don't contain absolute paths).
    local tc_facts tc_mock_strategy tc_banned
    tc_facts=$(echo "$story_json" | jq -r '.testCriteria.facts // [] | map("- " + .) | join("\n")' 2>/dev/null || echo "")
    tc_mock_strategy=$(echo "$story_json" | jq -r '.testCriteria.mockStrategy // ""' 2>/dev/null || echo "")
    tc_banned=$(echo "$story_json" | jq -r '.testCriteria.bannedPatterns // [] | join(", ")' 2>/dev/null || echo "")

    # Exact String Invariant guardrail (found live, 2026-07-06): SKY-002-impl
    # failed 8 times with 8 DIFFERENT bugs, several of them a slightly-wrong
    # paraphrase of an AC's literal error-message string (e.g. "via the
    # constructor" instead of "via the constructor options.apiKey"). A quoted
    # substring in an AC is a literal test assertion, not a summary the model
    # is free to reword — extract every quoted string and tell it explicitly
    # not to paraphrase them. Deterministic (no LLM judgment about which
    # strings matter); fully generic (works for any story's ACs, not just
    # SKY-002's).
    local string_invariants string_invariants_block=""
    string_invariants=$(printf '%s' "$acceptance_criteria" | grep -oE '"[^"]{3,}"' | sort -u)
    if [ -n "$string_invariants" ]; then
        _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-string-invariants-vals-XXXXXX.json")
        jq_vals \
              --arg string_list "$(printf '%s\n' "$string_invariants" | sed 's/^/- /')" \
              '{"__STRING_LIST__":$string_list}' > "$_cp_vals"
        string_invariants_block="$(render_engine_prompt writer-string-invariants "$_cp_vals")"
        rm -f "$_cp_vals"
    fi

    # Build a write-first directive listing each file with its exact absolute path
    local write_first_lines=""
    # Brownfield: inject each existing file's REAL content directly into the
    # prompt (deterministic, one bash `cat`/`head` per file) instead of just
    # instructing "ReadFile these first". Same established pattern as
    # dependency_contracts below ("Inject it directly so it's guaranteed, not
    # requested") — applied here because telling the agent to read via tool
    # calls, while it fixed hallucination, traded it for a NEW problem: each
    # ReadFile result accumulates in conversation history, and every
    # subsequent turn in the same ReAct loop resends that whole growing
    # transcript. Found live 2026-07-23 (AMSD-1820, post-fix): the static
    # prompt itself measured ~3,000 tokens, but attempts were reporting
    # ~240,000 input tokens and then failing with 0 output bytes — a real
    # multi-file service investigation ballooned the accumulated transcript
    # far past what a single static injection would ever cost. Injecting
    # content ONCE, deterministically, in bash gives the same real grounding
    # at a small, fixed, one-time cost instead of a cost that multiplies with
    # every tool-call turn the agent takes.
    local existing_file_contents=""
    # From orchestrations/config/spec-mode-defaults.json (existingFileInjection.maxLinesPerFile),
    # not a literal: this is the largest single term in writer prompt size — 34,510 of 86,809
    # chars live on AMSD-2041, re-paid on every attempt — and the guidance trim cannot touch it.
    local _EXISTING_FILE_MAX_LINES
    # `|| return 1`, matching prompt_trim_threshold rather than falling back to a silent
    # default: an unreadable budget means the config is wrong, and a hidden 400 would hide that
    # while quietly re-introducing the literal this moved out of the code.
    _EXISTING_FILE_MAX_LINES="$(existing_file_max_lines)" || return 1
    # Inject FULL content ONLY for the detective's fix-site file(s). Injecting every
    # declared file (5 for AMSD-1820) ballooned the impl prompt to 137-189K input tokens,
    # and the agent burned its whole output budget exploring before ever calling WriteFile
    # (live 2026-07-24: in=137K out=1707, zero writes → deliverable gate failed → 8 retries).
    # Non-fix-site declared files are listed as paths (agent ReadFiles on demand). When there
    # is no fixSiteAnalysis (novel work / no detective result), inject all files (fallback).
    local _fixsite_rel
    _fixsite_rel=$(echo "$story_json" | jq -r '[.fixSiteAnalysis[]?.file] | map(select(. != null and . != "")) | .[]' 2>/dev/null)
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        # Resolve to absolute path; in worktree mode, rewrite main-repo absolute paths
        # to the worktree so the agent writes files in the correct directory.
        local abs_f
        if [[ "$f" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$f" = "${MAIN_PROJECT_ROOT}"* ]]; then
                abs_f="${PROJECT_ROOT}${f#${MAIN_PROJECT_ROOT}}"
            else
                abs_f="$f"
            fi
        else
            abs_f="$PROJECT_ROOT/$f"
        fi
        # A declared path may be wrong in extension or case while the real file
        # genuinely exists (live 2026-07-30: declared ContentstackContext.tsx,
        # repo holds contentstackContext.tsx — the model's conventional
        # PascalCase guess for a React Context, not what the repo actually
        # contains). A bare `[ -f "$abs_f" ]` here failed on that mismatch, so
        # this loop told the agent the file did NOT exist and to WRITE it,
        # which it did — leaving a duplicate file under the wrong name/case
        # and the real one untouched, 7 identical attempts before this existed.
        # Resolve through the SAME function verify_story_deliverables uses, so
        # the prompt and the post-hoc check can never disagree about whether a
        # declared file is real.
        local _resolved_abs_f
        if _resolved_abs_f="$(_resolve_deliverable_path "$abs_f")"; then
            [ "$_resolved_abs_f" != "$abs_f" ] && \
                log "  Deliverable '$f' resolved to '${_resolved_abs_f#"$PROJECT_ROOT"/}' for prompt injection (declaration's case/extension did not match the repository)"
            abs_f="$_resolved_abs_f"
        fi
        # Inject CONTENT only for a fix-site file (or all, when no fixSiteAnalysis exists).
        local _rel_f _inject_content
        _rel_f="${abs_f#"$PROJECT_ROOT"/}"
        if [ -z "$_fixsite_rel" ] || printf '%s\n' "$_fixsite_rel" | grep -qxF "$_rel_f"; then _inject_content=1; else _inject_content=0; fi
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            if [ "$_inject_content" = "1" ] && [ -f "$abs_f" ]; then
                write_first_lines="${write_first_lines}   - ${abs_f} (content already injected below — do not ReadFile it unless you need lines beyond what's shown)\n"
                local _total_lines
                _total_lines=$(wc -l < "$abs_f" 2>/dev/null || echo 0)
                local _body
                _body=$(head -n "$_EXISTING_FILE_MAX_LINES" "$abs_f" 2>/dev/null)
                existing_file_contents="${existing_file_contents}
### ${abs_f}
\`\`\`
${_body}
\`\`\`
"
                if [ "${_total_lines:-0}" -gt "$_EXISTING_FILE_MAX_LINES" ]; then
                    existing_file_contents="${existing_file_contents}(truncated at ${_EXISTING_FILE_MAX_LINES} of ${_total_lines} lines — ReadFile this path yourself if you need the rest)
"
                fi
            else
                write_first_lines="${write_first_lines}   - ${abs_f} (ReadFile this only if you need it — not a fix site; content omitted to keep the prompt small)\n"
            fi
        else
            write_first_lines="${write_first_lines}   - WRITE ${abs_f} first, before any other action\n"
        fi
    done < <(story_declared_files "$story_json")

    # Brownfield testing policy — the "no wild tests" gate. Greenfield writes
    # new code + its own new tests. Brownfield MODIFIES existing code: the
    # existing suite already runs (Step 5 regression guard + Step 4.5 unit
    # gate), so a modified file that already has covering tests needs NO new
    # test. Only a modified file with ZERO covering tests warrants ONE targeted
    # test. We compute exactly that set deterministically here (CodeGraph's
    # `affected`) and tell the agent — so it never generates speculative tests
    # for already-covered code just because an AC says "add tests".
    local brownfield_test_policy=""
    # For a DEFECT (fix site known), the repro-gate REQUIRES a new bug-reproducing
    # test EVEN IF the file already has coverage — the bug escaped that coverage by
    # definition. The dedicated repro-test-writer now authors it (impl is told the
    # test is NOT its job — see test_ownership_block above). Skip the
    # coverage-based "don't write unnecessary tests / already covered → out of scope"
    # policy for defects: it DIRECTLY CONTRADICTED the repro-gate and was the live
    # cause of the missing test (AMSD-1820, 2026-07-24 — the agent was told the file
    # "ALREADY has covering tests. Do NOT write any new test file", so it shipped
    # none). The coverage policy still applies to non-defect brownfield changes.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -z "$_has_fix_plan" ]; then
        local _story_rel_files=()
        while IFS= read -r _sf; do
            [ -z "$_sf" ] && continue
            # Gate wants repo-relative paths; strip any absolute PROJECT_ROOT prefix.
            _story_rel_files+=("${_sf#"$PROJECT_ROOT"/}")
        done < <(story_declared_files "$story_json")
        if [ "${#_story_rel_files[@]}" -gt 0 ]; then
            local _uncovered _gate_rc=0
            _uncovered=$(PROJECT_ROOT="$PROJECT_ROOT" NODE_BIN="${NODE_BIN:-node}" \
                bash "$SCRIPT_DIR/brownfield-coverage-gate.sh" "${_story_rel_files[@]}" 2>/dev/null) || _gate_rc=$?
            if [ "$_gate_rc" -eq 3 ]; then
                # Gate couldn't determine coverage (no index) — do not claim
                # anything; fall back to the default AC-driven behavior.
                brownfield_test_policy=""
            elif [ -n "$_uncovered" ]; then
                brownfield_test_policy=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
                    "$SCRIPT_DIR/../config/agent-contract.json" "brownfieldTestPolicy.someUncovered" \
                    "uncovered=$(printf '%s\n' "$_uncovered" | sed 's/^/  - /')" 2>/dev/null || echo "")
            else
                brownfield_test_policy=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
                    "$SCRIPT_DIR/../config/agent-contract.json" "brownfieldTestPolicy.allCovered" \
                    "uncovered=$(printf '%s\n' "$_uncovered" | sed 's/^/  - /')" 2>/dev/null || echo "")
            fi
        fi
    fi

    # "Do NOT investigate" is right for greenfield (nothing exists yet to
    # read — the failure mode this directive originally fixed was agents
    # describing a plan in prose and never calling WriteFile at all). It is
    # actively wrong for brownfield: forbidding the agent from reading an
    # EXISTING file before modifying it guarantees it can't see the file's
    # real exports/utilities, and it will hallucinate plausible-sounding ones
    # instead. Found live 2026-07-23 (AMSD-1820): agent invented a
    # non-existent `@eps/utils` import and wrong export names across 8
    # attempts, at every model tier including the ladder's highest, because
    # it was told "do NOT read files, do NOT investigate" on every attempt.
    local write_first_directive
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        write_first_directive="CRITICAL — these files already exist. Their real content is injected below (## Existing File Contents) — you do NOT need to ReadFile them to see what's already there.
Do NOT import or reference anything that doesn't appear in the injected content below — a plausible-sounding module name is not a real one.
Only call ReadFile yourself if you need to see MORE of a file than what's shown (e.g. it was truncated), or a file not listed below."
    else
        write_first_directive="CRITICAL — WRITE FILES FIRST. Your FIRST tool call MUST be WriteFile.
Do NOT output any text before calling WriteFile. Do NOT plan or say \"I will...\".
Call WriteFile NOW for the EXACT ABSOLUTE PATHS listed below:"
    fi

    # CodeGraph tool (brownfield only): the agent can query the existing codebase
    # to CONFIRM an existing helper before writing new logic. The prescribed fix
    # (Root Cause Analysis, above) may name a helper to reuse; this lets the agent
    # verify its exact symbol + import path rather than hallucinate one. Reusing
    # an existing function instead of hand-rolling a new one is the whole point —
    # fewer lines, no duplicated logic (found live 2026-07-23, AMSD-1820: the
    # agent invented split-discount logic and a phantom field instead of reusing
    # the existing key parser the one-line fix needed).
    local codegraph_tool_block=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && command -v codegraph >/dev/null 2>&1; then
        # When the detective already prescribed the exact helper to reuse
        # (fixSiteAnalysis[].helper), do NOT push CodeGraph exploration — it drives the
        # agent to burn ReAct turns re-finding a helper it was already handed, and the
        # re-sent conversation balloons input to 137-189K tokens so it never reaches
        # WriteFile (live 2026-07-24, AMSD-1820). Give a minimal "apply directly" note.
        # Full exploration block only when NO helper is prescribed (genuine novel work).
        # EVERY HELPER THE GUARD ENFORCES, NOT JUST THE FIRST ONE.
        #
        # This read `.[0]` while the ReuseGuard (~line 9881) enforces the WHOLE set, with
        # the same filter the guard uses:
        #     map(select(.fixVerified == true and .helper != "")) | map(.helper) | unique
        #
        # So the writer was told about ONE symbol and rejected for the others — and the
        # note built from this value also tells it "Do NOT run CodeGraph or explore the
        # codebase", so it could not discover the rest either.
        #
        # Live, run of 2026-08-15 13:24 (metrolinx, AMSD-2041), killed at attempt 5 of 12:
        #     prompt: reuse `Stack`
        #     guard:  ReuseGuard: 'ContentstackContext:Stack:getContentByKey:useContent'
        #     [HealingBroken] CRITICAL: '...without importing or calling the prescribed
        #     getContentByKey helper...' has recurred 2+ times — self-healing is NOT working.
        #
        # The loop could not converge: the corrective symbol never entered the prompt, so
        # every retry repeated the omission and the ladder escalated to no purpose. One
        # list, one source — "reuse these" and "you must reuse these" are now the same set.
        local _prescribed_helper _prescribed_helper_list
        _prescribed_helper_list=$(echo "$story_json" | jq -r '
            (.fixSiteAnalysis // [])
            | map(select((.fixVerified == true) and ((.helper // "") != "")))
            | map(.helper) | unique | join(", ")' 2>/dev/null)
        # Kept for the single-helper phrasing below; empty when nothing is prescribed.
        _prescribed_helper="$_prescribed_helper_list"
        # This suppression must NOT fire blind to fixSiteAnalysisCoverage
        # (checkFixSiteCoverage, spec-mode-runner.js). "A helper is named" only
        # means SOME site is minimal — it says nothing about verification
        # criteria the detective's findings never touched. Telling the model
        # "do NOT explore... apply the prescribed fix... and stop" with only a
        # soft escape hatch ("only search if you hit something the fix
        # genuinely does not cover") relies on the model noticing a gap on its
        # own — the exact judgment failure the coverage check exists to catch
        # deterministically instead of hoping for.
        local _cov_incomplete _uncovered_list
        _cov_incomplete=$(echo "$story_json" | jq -r '(if .fixSiteAnalysisCoverage.complete == null then "false" elif .fixSiteAnalysisCoverage.complete == false then "true" else "false" end)' 2>/dev/null)
        _uncovered_list=$(echo "$story_json" | jq -r '(.fixSiteAnalysisCoverage.uncoveredVerificationCriteria // []) | map("- " + .) | join("\n")' 2>/dev/null)
        if [ -n "$_prescribed_helper" ] && [ "$_cov_incomplete" != "true" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq_vals \
                  --arg prescribed_helper "${_prescribed_helper}" \
                  '{"__PRESCRIBED_HELPER__":$prescribed_helper}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" helper_identified)"
            rm -f "$_cp_vals"
        elif [ -n "$_prescribed_helper" ] && [ "$_cov_incomplete" = "true" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq_vals \
                  --arg prescribed_helper "${_prescribed_helper}" \
                  --arg uncovered_list "${_uncovered_list}" \
                  '{"__PRESCRIBED_HELPER__":$prescribed_helper,"__UNCOVERED_LIST__":$uncovered_list}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" fix_incomplete)"
            rm -f "$_cp_vals"
        else
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-codegraph-block-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            codegraph_tool_block="$(render_engine_prompt writer-codegraph-block "$_cp_vals" tool_available)"
            rm -f "$_cp_vals"
        fi
    fi

    # CRITERIA A PREVIOUS ATTEMPT LEFT UNTESTED.
    #
    # vc-coverage-check.sh (Step 3.56) compares every verification criterion against the tests a
    # story produced and writes $LOG_DIR/vc-coverage-<story>.json. Nothing read it until now.
    #
    # TIMING, STATED PLAINLY: that check runs AFTER the writer, so on the first attempt of a
    # fresh run no artifact exists and this block is empty. It carries a previous attempt's or a
    # previous run's findings into a RESUME or a RETRY — which is exactly when the writer has
    # already produced tests that missed something and can still act on it. It is advisory here;
    # the REVIEWER is where an uncovered criterion is judged, because deciding that a criterion
    # is genuinely untestable in this environment is a judgement, not an engine rule.
    _uncovered_vc_block=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/vc-coverage-findings.js" \
        "${LOG_DIR:-}" "$story_id" "$SCRIPT_DIR/../config/agent-contract.json" 2>/dev/null || echo "")

    # New-dependency directive. Live metrolinx 2026-07-30/31: the model's own
    # output, at every tier including the top of the model ladder, was the
    # identical stall — it correctly diagnosed that the fix needed a package
    # not yet in the project, said "let me check if X can be installed," and
    # then took no action. The sentence repeated verbatim and the turn ended,
    # burning the full watchdog timeout each time. Every model hit the same
    # wall, which rules out "not smart enough" — nothing had ever told it
    # that adding an import for a missing package is a normal, already-
    # automated step; it stalled asking permission for something the
    # pipeline had already solved.
    #
    # Fires ONLY when a dependency-check manifest actually exists for this
    # project — that manifest's presence is what makes the claim true. A
    # project with no manifest gets no directive, not a false promise.
    # Generic on purpose: no package name, language, or install command
    # appears here, the same way dependency-check.json's own installCommand
    # is config-supplied rather than hardcoded to npm/pip/cargo.
    #
    # THE DIRECTIVE IS A TEMPLATE, and its three facts come from the codeline. The prose used to
    # live here as a shell string that promised the install happened by itself; AMSD-2041 followed
    # it, and the lockfile never moved. See prompts/templates/new-dependency-directive.json.
    # GATED ON WHAT IT NEEDS, which is a known ecosystem — not on .epam/dependency-check.json.
    #
    # That file gated the ORIGINAL text, correctly: it promised "missing imports are detected and
    # installed automatically", true only where the project declares autoInstall. The replacement
    # promises nothing and tells the writer to run the add-command itself, so what it requires is a
    # manifest, a lockfile and an add-command — all from lib/ecosystem-registry.js.
    #
    # Live metrolinx AMSD-2041, 2026-08-19: that file was absent from the codeline, so lockfile-sync
    # blocked four times while the one instruction that makes the block actionable was switched off.
    # The writer was told what was wrong and never how to fix it.
    local new_dependency_directive=""
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _nd_facts _nd_install _nd_manifest _nd_lock
        _nd_facts=$("${NODE_CMD:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$PROJECT_ROOT" 2>/dev/null || echo '{}')
        # The PROJECT's own per-package install command wins when it declares one; the ecosystem
        # answers otherwise. `{package}` is the placeholder both use.
        _nd_install="$(_project_install_command 2>/dev/null || true)"
        [ -n "$_nd_install" ] || _nd_install=$(printf '%s' "$_nd_facts" | jq -r '.addCommand // ""')
        _nd_install="${_nd_install//\{package\}/<package>}"
        _nd_manifest=$(printf '%s' "$_nd_facts" | jq -r '.manifest // ""')
        _nd_lock=$(printf '%s' "$_nd_facts" | jq -r '.lockfile // ""')
        # THE INSTALL COMMAND IS THE ONLY HARD REQUIREMENT. A directive that tells an agent to run
        # "" is worse than none. The lockfile half is separate and conditional: a codeline with no
        # lockfile still needs the half that stops it stalling, which is why this directive exists.
        if [ -n "$_nd_install" ]; then
            local _nd_note=""
            if [ -n "$_nd_manifest" ] && [ -n "$_nd_lock" ]; then
                local _nd_nvals; _nd_nvals=$(mktemp "${TMPDIR:-/tmp}/new-dep-note-XXXXXX")
                jq_vals --arg manifest "$_nd_manifest" --arg lock "$_nd_lock" \
                  '{"__MANIFEST_FILE__":$manifest,"__LOCKFILE__":$lock}' > "$_nd_nvals"
                # The library's contract: non-zero means NOTHING was rendered. `|| true` turned
                # that into an empty note, and 2>/dev/null hid the reason — "a template value
                # no producer supplies" is a real, recurring live failure, and this made it
                # silent. The note is genuinely optional, so a failure is not fatal, but it is
                # never invisible.
                if ! _nd_note="$(render_engine_prompt new-dependency-lockfile-note "$_nd_nvals")"; then
                    warning "  [prompt] new-dependency-lockfile-note did not render — the writer gets no lockfile note"
                    _nd_note=""
                fi
                rm -f "$_nd_nvals"
            fi
            local _nd_vals; _nd_vals=$(mktemp "${TMPDIR:-/tmp}/new-dep-vals-XXXXXX")
            jq_vals --arg install "$_nd_install" --arg note "$_nd_note" \
              '{"__INSTALL_COMMAND__":$install,"__LOCKFILE_NOTE__":$note}' > "$_nd_vals"
            # NOT OPTIONAL. This directive is how the writer is told to install a new
            # dependency at all; empty, the agent is invoked knowing nothing about it and
            # invents an install step or skips one. Rendered or refused, never blank.
            if ! new_dependency_directive="$(render_engine_prompt new-dependency-directive "$_nd_vals")"; then
                error "  [prompt] new-dependency-directive did not render — refusing to invoke the writer without it"
                rm -f "$_nd_vals"
                return 1
            fi
            rm -f "$_nd_vals"
        fi
    fi

    # Deterministic contract injection — root cause of a recurring live-run
    # failure (validated live: baseline model call guessed the wrong import
    # path './skyscanner-client'; with the dependency's contract injected,
    # it used the correct './skyscanner/client' every time). The typescript-
    # engineer profile already instructs agents to WRITE a contract file
    # after finishing (.contracts/<storyId>.md — exact exports, constructor
    # signature, ready-to-paste import/mock pattern) — but nothing ever READ
    # it back for a dependent story. Reading was 100% dependent on the
    # dependent story's agent choosing to open the file itself, which it
    # unreliably did. Inject it directly so it's guaranteed, not requested.
    local dependency_contracts=""
    local _dep_ids_json="[]"
    if [ -n "$dependencies" ]; then
        _dep_ids_json=$(echo "$story_json" | jq -c '[(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]')
        local _dep_id
        while IFS= read -r _dep_id; do
            [ -z "$_dep_id" ] && continue
            local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
            if [ -f "$_contract_file" ]; then
                dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
            fi
        done < <(echo "$_dep_ids_json" | jq -r '.[]?')
    fi

    # Third-party package grounding (found live 2026-07-30, AMSD-2041): the
    # loop above ground-truths INTERNAL dependencies only. A story writing
    # config for a third-party SDK had nothing but training memory to go on —
    # the same "Config object doesn't match the SDK's Config type" defect
    # recurred 3 times because nobody, implementer or self-heal, ever saw the
    # real type. Reuses .epam/dependency-check.json's importPattern/vendorDirs
    # (already proven by run_dependency_check) purely to DISCOVER what the
    # story's own declared files import; generates .contracts/vendor-<pkg>.md
    # from the installed package's own source the same way generate_story_
    # contract() already does for the story's own code. No manifest = no-op.
    local _vendor_files_json _vendor_file _vendor_pkg
    # Lane-resolved, same as every other consumer of this story's file list.
    _vendor_files_json=$(story_declared_files "$story_json" | jq -R . | jq -sc .)
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        _vendor_files_json="${_vendor_files_json//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi
    while IFS= read -r _vendor_file; do
        [ -z "$_vendor_file" ] && continue
        local _vendor_abs
        [[ "$_vendor_file" = /* ]] && _vendor_abs="$_vendor_file" || _vendor_abs="$PROJECT_ROOT/$_vendor_file"
        _vendor_abs="$(_resolve_deliverable_path "$_vendor_abs" 2>/dev/null || echo "$_vendor_abs")"
        [ -f "$_vendor_abs" ] || continue
        while IFS= read -r _vendor_pkg; do
            [ -z "$_vendor_pkg" ] && continue
            local _vendor_contract="$PROJECT_ROOT/.contracts/vendor-${_vendor_pkg}.md"
            [ -f "$_vendor_contract" ] || _generate_vendor_contract "$PROJECT_ROOT" "$_vendor_pkg" 2>/dev/null
            if [ -f "$_vendor_contract" ]; then
                dependency_contracts="${dependency_contracts}
### Vendor package: ${_vendor_pkg}
$(cat "$_vendor_contract")
"
            fi
        done < <(_discover_vendor_packages "$_vendor_abs" 2>/dev/null)
    done < <(echo "$_vendor_files_json" | jq -r '.[]?')

    # Spec-reality cross-check (added 2026-07-06 — see project_backlog memory
    # "Spec-reality cross-check"). Root cause this catches: the PRD itself is
    # an LLM-authored/elaborated artifact, just as hallucination-prone as
    # agent-generated code — a live defect had SKY-003's own description
    # assert "Instantiate SkyscannerClient from `src/skyscanner-client.ts`"
    # when the real file SKY-002 built was at `src/skyscanner/client.ts`. The
    # model faithfully followed a WRONG instruction baked into its own task
    # description — hooks (session-time, per-WriteFile) would NOT catch this,
    # since the bug is in what the agent was TOLD, not in what it produced.
    # Deterministically extracts backtick-quoted path-like strings from this
    # story's own description/ACs and checks each against a dependency's REAL
    # technicalNotes.files (ground truth, not model-transcribed) — flagging a
    # mismatch instead of silently injecting the correct contract ALONGSIDE
    # an uncorrected wrong claim (which is what happened live: the agent saw
    # both the correct contract and the wrong prose path and still guessed
    # wrong on early attempts).
    local spec_reality_warning=""
    if [ "$_dep_ids_json" != "[]" ]; then
        local _dep_files_json
        _dep_files_json=$(jq -c --argjson ids "$_dep_ids_json" \
            '[.stories[] | select(.id as $sid | $ids | index($sid)) | .technicalNotes.files[]? // empty]' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        spec_reality_warning=$(python3 "$SCRIPT_DIR/lib/handlers/spec-reality-warning.py" "$description" "$acceptance_criteria" "$_dep_files_json"
)
    fi

    _sw_vals=$(mktemp "${TMPDIR:-/tmp}/story-writer-main-vals-XXXXXX.json")
    jq -n \
          --arg spec_reality_warning "$([ -n "$spec_reality_warning" ] && printf '%s\n\n' "$spec_reality_warning" || true)" \
          --arg write_first_lines "$(printf '%b' "$write_first_lines")" \
          --arg string_invariants_block "$([ -n "$string_invariants_block" ] && printf '%s\n' "$string_invariants_block" || true)" \
          --arg review_feedback "$([ -n "$review_feedback" ] && printf '\n## Reviewer Feedback — ADDRESS THESE (a prior code review requested changes)\nThe team-lead reviewer examined your previous attempt and requested the changes below. This is the highest priority.\n\nA BLOCKER is a required deliverable, not advice. If a blocker says something is MISSING — a test, a file, a case — the only way to resolve it is to CREATE it; leaving it out repeats the rejection. Minimality governs HOW MUCH you write, never WHETHER you write it.\n\nFor advisory points: make the smallest edits that resolve each one, and where a point says the change is over-engineered or an existing helper would do, REMOVE the excess rather than adding more.\n\nIf you genuinely cannot satisfy a blocker — no seam exists to test against, the behaviour lives entirely in a third-party package — say so explicitly in your final message, naming the blocker and why. An unexplained omission reads as a refusal and will be rejected again.\n%s\n' "$review_feedback" || true)" \
          --arg skill_note_block "$([ -n "$skill_note_block" ] && printf '%s\n' "$skill_note_block" || true)" \
          --arg verification_criteria "$([ -n "$verification_criteria" ] && printf '\n## Verification Criteria (what a tester will CONFIRM — your change must satisfy every one)\nThese are observable checks, derived from the acceptance criteria and description. They describe WHAT is observed, not how to build it. Make the minimal change that makes all of these true; your accompanying test should assert them:\n%s\n' "$verification_criteria" || true)" \
          --arg codeline_facts_block "$([ -n "$codeline_facts_block" ] && printf '%s\n' "$codeline_facts_block" || true)" \
          --arg project_tools_block "$([ -n "$project_tools_block" ] && printf '%s\n' "$project_tools_block" || true)" \
          --arg test_ownership_block "$([ -n "$test_ownership_block" ] && printf '%s\n' "$test_ownership_block" || true)" \
          --arg codegraph_tool_block "$([ -n "$codegraph_tool_block" ] && printf '\n%s\n' "$codegraph_tool_block" || true)" \
          --arg uncovered_vc_block "$([ -n "$_uncovered_vc_block" ] && printf '\n%s\n' "$_uncovered_vc_block" || true)" \
          --arg brownfield_test_policy "$([ -n "$brownfield_test_policy" ] && printf '\n%s\n' "$brownfield_test_policy" || true)" \
          --arg new_dependency_directive "$([ -n "$new_dependency_directive" ] && printf '\n%s\n' "$new_dependency_directive" || true)" \
          --arg tc_facts "$([ -n "$tc_facts" ] && printf '\n## Test Criteria (ground truth — written from actual source; overrides any conflicting AC)\n%s\n' "$tc_facts" || true)" \
          --arg tc_mock_strategy "$([ -n "$tc_mock_strategy" ] && printf '\n## Mock Strategy\n%s\n' "$tc_mock_strategy" || true)" \
          --arg tc_banned "$([ -n "$tc_banned" ] && printf '\n## Banned Patterns (must NOT appear in your file)\n%s\n' "$tc_banned" || true)" \
          --arg technical_notes "$(_render_technical_notes "$technical_notes" "$_lane")" \
          --arg existing_file_contents "$([ -n "$existing_file_contents" ] && printf '\n## Existing File Contents (injected once, deterministically — do NOT ReadFile these unless you need more than shown)\n%s\n' "$existing_file_contents" || true)" \
          --arg dependency_contracts "$([ -n "$dependency_contracts" ] && printf '\n## Dependency Contracts (EXACT import paths and signatures — use these verbatim, do NOT guess a different path)\n%s\n' "$dependency_contracts" || true)" \
          --arg module_resolution "$(_module_resolution_context "$PROJECT_ROOT" 2>/dev/null || true)" \
          --arg cross_codeline_contract "$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)" \
          --arg write_first_lines_2 "$(printf '%b' "$write_first_lines")" \
          --arg conditional_section "$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "**The content of every file listed above is already shown in ## Existing File Contents — use that, do not spend a tool call re-reading them. Use Edit for targeted changes to existing files — do NOT overwrite an existing file wholesale with WriteFile.**"
else
  echo "**You MUST write every file listed above to its EXACT absolute path. Do NOT write to a different path, do NOT write to the current directory unless it matches the path above. Use your WriteFile or Edit tools with the full absolute path shown.**"
fi)" \
          --arg conditional_section_2 "$(if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
  echo "1. Use the injected ## Existing File Contents above to verify what actually exists (exports, types, existing utilities) before writing any code — do not guess, and do not re-read a file already shown in full"
else
  echo "1. Write each required file to its exact absolute path listed above — do this FIRST before anything else"
fi)" \
          --arg tc_facts_2 "$([ -n "$tc_facts" ] && echo "3. Test Criteria facts above are ground truth — your test assertions MUST match them exactly" || echo "3. Follow the project's existing code patterns and conventions")" \
          --arg write_first_directive "$write_first_directive" \
          --arg dependencies "${dependencies:-None}" \
          --arg acceptance_criteria "$acceptance_criteria" \
          --arg agent_inputs "$agent_inputs" \
          --arg description "$description" \
          --arg story_id "$story_id" \
          --arg title "$title" \
          --arg files "$files" \
          '{"__SPEC_REALITY_WARNING__":$spec_reality_warning,"__WRITE_FIRST_LINES__":$write_first_lines,"__STRING_INVARIANTS_BLOCK__":$string_invariants_block,"__REVIEW_FEEDBACK__":$review_feedback,"__SKILL_NOTE_BLOCK__":$skill_note_block,"__VERIFICATION_CRITERIA__":$verification_criteria,"__CODELINE_FACTS_BLOCK__":$codeline_facts_block,"__PROJECT_TOOLS_BLOCK__":$project_tools_block,"__TEST_OWNERSHIP_BLOCK__":$test_ownership_block,"__CODEGRAPH_TOOL_BLOCK__":$codegraph_tool_block,"__UNCOVERED_VC_BLOCK__":$uncovered_vc_block,"__BROWNFIELD_TEST_POLICY__":$brownfield_test_policy,"__NEW_DEPENDENCY_DIRECTIVE__":$new_dependency_directive,"__TC_FACTS__":$tc_facts,"__TC_MOCK_STRATEGY__":$tc_mock_strategy,"__TC_BANNED__":$tc_banned,"__TECHNICAL_NOTES__":$technical_notes,"__EXISTING_FILE_CONTENTS__":$existing_file_contents,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__MODULE_RESOLUTION__":$module_resolution,"__CROSS_CODELINE_CONTRACT__":$cross_codeline_contract,"__WRITE_FIRST_LINES_2__":$write_first_lines_2,"__CONDITIONAL_SECTION__":$conditional_section,"__CONDITIONAL_SECTION_2__":$conditional_section_2,"__TC_FACTS_2__":$tc_facts_2,"__WRITE_FIRST_DIRECTIVE__":$write_first_directive,"__DEPENDENCIES__":$dependencies,"__AGENT_INPUTS__":$agent_inputs,"__DESCRIPTION__":$description,"__STORY_ID__":$story_id,"__TITLE__":$title,"__FILES__":$files}' > "$_sw_vals"
    render_engine_prompt story-writer-main "$_sw_vals"
    rm -f "$_sw_vals"
}

build_generator_prompt() {
    local story_id=$1
    local story_json
    story_json=$(get_story_details "$story_id")
    local _lane
    _lane=$(_current_lane "$story_json")

    local title
    title=$(echo "$story_json" | jq -r '.title')
    local description
    description=$(echo "$story_json" | jq -r '.description')
    local acceptance_criteria
    acceptance_criteria=$(echo "$story_json" | jq -r '.acceptanceCriteria | join("\n- ")')
    local technical_notes
    technical_notes=$(echo "$story_json" | jq -r '.technicalNotes // empty')
    local files
    files=$(echo "$story_json" | jq -r '.technicalNotes.files // [] | join(", ")')
    local dependencies
    dependencies=$(echo "$story_json" | jq -r \
        '(.dependencies // .technicalNotes.dependsOn // []) | join(", ")')

    # Rewrite main-repo absolute paths to worktree path in all prompt fields
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        acceptance_criteria="${acceptance_criteria//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        technical_notes="${technical_notes//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        files="${files//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
        description="${description//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi

    _hd_vals=$(mktemp "${TMPDIR:-/tmp}/story-file-generation-vals-XXXXXX.json")
    jq_vals \
          --arg technical_notes "$(_render_technical_notes "$technical_notes" "$_lane")" \
          --arg dependencies "${dependencies:-None}" \
          --arg acceptance_criteria "$acceptance_criteria" \
          --arg description "$description" \
          --arg story_id "$story_id" \
          --arg title "$title" \
          --arg files "$files" \
          '{"__TECHNICAL_NOTES__":$technical_notes,"__DEPENDENCIES__":$dependencies,"__ACCEPTANCE_CRITERIA__":$acceptance_criteria,"__DESCRIPTION__":$description,"__STORY_ID__":$story_id,"__TITLE__":$title,"__FILES__":$files}' > "$_hd_vals"
    render_engine_prompt story-file-generation "$_hd_vals"
    rm -f "$_hd_vals"
}

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

record_story_outputs() {
    local story_id="$1"
    [ -n "${LOG_DIR:-}" ] || return 0
    local _so_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/story-outputs.sh"
    [ -f "$_so_lib" ] || return 0
    # shellcheck disable=SC1090
    . "$_so_lib"
    story_outputs_record "${PROJECT_ROOT:-}" "$LOG_DIR"
}

# verify_prescribed_helper_used <story_id>
# When the pipeline prescribes an EXISTING helper, the change must use it.
#
# Live metrolinx 2026-07-26, run 5. The detective was right — real fix site, real
# quoted line, real helper (getDispatchLineItemKey, fixVerified: true) — and the
# implementer wrote this instead:
#
#   - (lineItem) => lineItem.id === discount.lineItemId,
#   + (lineItem) => lineItem.id === discount.lineItemId
#                   || lineItem.id.startsWith(discount.lineItemId + '-'),
#
# The separator in that repo is '#', declared as `const DIVIDER = '#'`. So
# "ORDER123#return".startsWith("ORDER123-") is false, the clause never matches,
# and the bug was entirely unfixed by a change that looked plausible. The helper
# appeared ZERO times in the diff.
#
# An agent hand-rolled string surgery against a format it GUESSED, when the repo
# already contained a parser for that format and the pipeline had already named
# it. Reusing the helper makes the separator impossible to get wrong, because the
# helper owns it.
#
# Only fires when the helper was named AND verified to exist (fixVerified). If the
# detective may have hallucinated it, demanding its use would force the agent to
# import something imaginary. Brownfield only; per-attempt WARNING, so the retry
# ladder owns the outcome.
# verify_client_env_boundary <story_id>
#
# A CONFIG VALUE READ WHERE THE BUILD NEVER SUBSTITUTES IT IS DEAD CODE THAT TYPE-CHECKS.
#
# Live 2026-08-14, AMSD-2041 on next.metrolinx.com:
#
#     if (process.env.CONTENTSTACK_LIVE_PREVIEW_ENABLED === "true") { initLivePreview(...) }
#
# in a useEffect — the browser. That framework substitutes only prefixed names into the client
# bundle, the codeline's config exposes no others, so the value is undefined and the branch never
# runs. tsc passed. eslint passed. The reviewer APPROVED it across two cycles and raised six other
# issues without this one, because seeing it needs a bundler rule and the project's own config,
# not the diff.
#
# THE ENGINE KNOWS NONE OF THAT. plugins/client-env-boundary-plugin.js holds the framework facts
# behind adapters selected by what the codeline's own manifest declares, and reads the exposed set
# from that codeline's config — so gotransit, upexpress and metrolinx are the same call, and a new
# stack is an adapter, never an engine change.
#
# Absent is absent: a codeline whose stack no adapter recognises reports nothing and this returns 0.
# A check that cannot identify the rule must not invent findings, and must not claim a clean bill
# of health either — the plugin distinguishes the two and only the first reaches here.
verify_client_env_boundary() {
    local story_id="$1"
    local _plugin="${AUTOMATION_DIR:-$(dirname "$SCRIPT_DIR")}/plugins/client-env-boundary-plugin.js"
    [ -f "$_plugin" ] || return 0
    [ -n "${PROJECT_ROOT:-}" ] && [ -d "$PROJECT_ROOT" ] || return 0

    # The files THIS story changed, from the writer's own output manifest — never a tree scan.
    local _changed
    _changed=$(git -C "$PROJECT_ROOT" diff --name-only "${PHASE_BASELINE_SHA:-HEAD~1}" HEAD 2>/dev/null; \
               git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | sed 's/^...//')
    [ -n "$_changed" ] || return 0

    local _out
    _out=$(printf '%s\n' "$_changed" | "${NODE_BIN:-node}" -e '
      const p = require(process.argv[1]);
      let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
        const files = [...new Set(raw.split("\n").map(s => s.trim()).filter(Boolean))];
        const r = p.scanClientEnvBoundary(process.argv[2], files);
        if (!r.exposureDeclared || !r.findings.length) return;
        for (const f of r.findings) console.log(f.file + ":" + f.line + "\t" + f.variable + "\t" + f.detail);
      });
    ' "$_plugin" "$PROJECT_ROOT" 2>/dev/null || echo "")

    [ -n "$_out" ] || return 0

    local _count _first_var
    _count=$(printf '%s\n' "$_out" | grep -c .)
    _first_var=$(head -1 <<< "$_out" | cut -f2)

    # Same rejection-key discipline as the reuse guard: an identical rejection twice advances the
    # ladder rather than re-asking the same model the same question.
    STORY_REJECTION_KEY="client-env:${_first_var}"
    # THE FLAG IS WHAT DELIVERS IT — see verify_prescribed_helper_used. VERIFICATION_FAILURE
    # without DETERMINISTIC_CHECK_FAILURE is assigned and dropped.
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\n%d configuration value(s) are read where the build does not substitute them, so at runtime each is undefined and the branch it guards silently does nothing:\n\n%s\n\nRead the value where it IS substituted and pass the result through, as this codeline already does elsewhere, or expose it deliberately.\n' \
        "$_count" "$(printf '%s\n' "$_out" | sed 's/^/  - /')")
    warning "Story $story_id: ${_count} value(s) read where the build never substitutes them — first: ${_first_var}. The guarded branch cannot execute; tsc and lint cannot see this."
    return 1
}

verify_prescribed_helper_used() {
    local story_id="$1"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] || return 0
    [ -n "${PROJECT_ROOT:-}" ] && [ -d "$PROJECT_ROOT/.git" ] || return 0
    local prd_target="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -f "$prd_target" ] || return 0

    # EVERY VERIFIED HELPER, not the first one.
    #
    # This selected `.[0].helper` and checked that alone. Live 2026-08-09 the spec verified FOUR
    # fix sites for one codeline — options, useContentstackContext, getEntry, getValue — the
    # writer used `options`, the guard fell silent, and the other three were never asked about.
    # The story shipped 1 of 4 verified sites and was reported complete, unable to satisfy its own
    # criterion ("the rendered page displays the DRAFT content values") because the fetch path
    # and context were never touched.
    #
    # fixVerified:true is a strong claim — the spec CONFIRMED the site and named the helper that
    # owns it. Unverified sites stay optional, since those are guesses and demanding them would
    # fail stories over a candidate the agent correctly ignored.
    local _helpers
    _helpers=$(jq -r --arg id "$story_id" '
        .stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
        | map(select((.fixVerified == true) and ((.helper // "") != "")))
        | map(.helper) | unique | .[]' "$prd_target" 2>/dev/null)
    [ -n "$_helpers" ] || return 0

    local _ref=""
    [ -f "${LOG_DIR:-}/phase-baseline-sha.txt" ] &&         _ref=$(tr -d '[:space:]' < "$LOG_DIR/phase-baseline-sha.txt" 2>/dev/null)
    [ -n "$_ref" ] || _ref="$(_resolved_baseline_ref)"
    git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1 || return 0

    local _diff
    _diff=$(git -C "$PROJECT_ROOT" diff "$_ref" 2>/dev/null)
    [ -n "$_diff" ] || return 0

    # Collect every verified helper the change does NOT use. Reporting only the first would
    # make the writer fix them one attempt at a time, which is the retry ladder spent on
    # information the guard already had.
    # Duplication, not absence — see _change_duplicates_owned_format. A helper whose module owns
    # no format can never trigger a rejection, so a feature that legitimately does not need it
    # passes, while a change that re-creates a format the helper owns is still caught.
    local _missing=() _h
    while IFS= read -r _h; do
        [ -n "$_h" ] || continue
        _change_duplicates_owned_format "$PROJECT_ROOT" "$_h" "$_diff" || _missing+=("$_h")
    done <<< "$_helpers"
    [ ${#_missing[@]} -eq 0 ] && return 0
    local _helper="${_missing[0]}"
    local _missing_list
    _missing_list=$(printf '%s, ' "${_missing[@]}"); _missing_list="${_missing_list%, }"

    local _note=""
    if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
        if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
            _note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
        else
            _note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
        fi
    fi
    # IT BLOCKS AGAIN, ON A SIGNAL THAT CANNOT REJECT WORKING CODE.
    #
    # It used to veto on helper ABSENCE. Proven against run artefacts: gotransit shipped
    # AMSD-2041 (e780a8b7, 9 files, +379) with two of metrolinx's fixVerified helpers absent, so
    # absence rejects working code — and each false rejection cost a whole writer attempt
    # (7.3M tokens, $2.25) before escalating the ladder to ask for something worse.
    #
    # The 2026-07-26 defect it exists for was DUPLICATION: startsWith(id + '-') while
    # dispatch-line-item-key.ts declares DIVIDER='#', so the fix could never match. That is what
    # is checked now. mock3's defect fixes still pass (the helper is on the changed line by
    # construction); gotransit's feature still passes (its helper module owns no format).
    STORY_REJECTION_KEY="helper-duplication:${_helper}"
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\n%d prescribed helper(s) OWN a format your change re-creates with its own literal: %s\n\nThe repository already parses this format. Hand-rolling it is how a fix comes to match on the wrong separator and silently never work. Import and use the helper instead of inventing the format.\n' "${#_missing[@]}" "$_missing_list")
    # WARNING, not ERROR: this is a RETRYABLE verdict and the writer gets another attempt. An
    # existing test asserts this, because an ERROR line reads as a dead run to anyone watching.
    warning "Story $story_id: the change re-creates a format owned by ${_missing_list} — import the helper rather than inventing the separator (${_helper} owns it; hand-rolling is how a fix matches on the wrong separator and silently never works)"
    return 1
}

# Resolve a DECLARED deliverable to a real file.
#
# A declaration is often a module specifier, not a filename: a model reasoning
# about `from '@/hooks/useContent'` writes "src/hooks/useContent", and no such
# file exists — the file is useContent.ts. Live metrolinx 2026-07-29 failed all
# three lanes on exactly this, retrying until the watchdog killed each one
# (600s then 900s) to prove a filename wrong. The two lanes even disagreed on
# the prefix (src/hooks/... vs hooks/...), which is the tell that the string is
# generated rather than observed.
#
# Extensions are DISCOVERED from the repository, never hardcoded: globbing
# "<path>.*" asks the project what it actually uses, so this works unchanged on
# a .tsx, .py or .go codeline. A directory module resolves through its index.*.
#
# Ambiguity is a failure, not a coin toss: if two candidates match, the
# declaration cannot identify one file and the operator must see that rather
# than have the gate's verdict depend on glob order.
#
# Echoes the resolved path relative to PROJECT_ROOT and returns 0; returns 1 if
# nothing or more than one thing matches.
_resolve_deliverable_path() {
    # Takes the ABSOLUTE candidate path the caller already derived (which has
    # handled absolute declarations and worktree rewriting) and refines it.
    # Deriving it again from PROJECT_ROOT here would discard both.
    local _abs="$1"
    # -f as well as -s: a DIRECTORY is non-empty by -s, so "src/hooks/useContent"
    # naming a directory would short-circuit here and never reach the index.*
    # lookup below.
    if [ -f "$_abs" ] && [ -s "$_abs" ]; then printf '%s\n' "$_abs"; return 0; fi

    local _cands=() _c
    # A declaration may carry the WRONG extension, not merely a missing one:
    # observed live 2026-07-29, a story declared ContentstackContext.tsx while
    # the repository holds ContentstackContext.ts. Globbing "<path>.*" only
    # helps an extensionless declaration, so strip a trailing extension and try
    # that stem too. Determined, not assumed — the alternatives come from what
    # the repository actually contains.
    local _stem="${_abs%.*}"
    if [ "$_stem" != "$_abs" ]; then
        for _c in "$_stem".*; do
            [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
        done
    fi
    for _c in "$_abs".*; do
        [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
    done
    for _c in "$_abs"/index.*; do
        [ -f "$_c" ] && [ -s "$_c" ] && _cands+=("$_c")
    done

    if [ "${#_cands[@]}" -eq 1 ]; then
        printf '%s\n' "${_cands[0]}"
        return 0
    fi
    if [ "${#_cands[@]}" -gt 1 ]; then
        warning "Declared deliverable '$_abs' is ambiguous — ${#_cands[@]} files match: ${_cands[*]}"
        warning "  The declaration cannot identify one file; it needs an extension."
        return 1
    fi

    # A declaration may carry the WRONG CASE, not merely the wrong extension.
    # Live 2026-07-30: a story declared ContentstackContext.tsx (the
    # conventional PascalCase a model defaults to for a React Context) while
    # the repository's real file is contentstackContext.tsx (lowercase c). On
    # this case-SENSITIVE filesystem `[ -f ]` failed, so the implementation
    # prompt told the agent the file did not exist and to WRITE it — which it
    # did, leaving one file added under the wrong case and the real one reading
    # as deleted. 7 identical attempts, real spend each time, before this
    # existed. Scoped to the SAME DIRECTORY only: matching anywhere in the repo
    # would silently redirect a genuinely wrong path to an unrelated file that
    # happens to share a name.
    local _dir _base _lower_target _e
    _dir="$(dirname "$_abs")"
    [ -d "$_dir" ] || return 1
    _base="$(basename "$_abs")"
    _lower_target=$(printf '%s' "$_base" | tr '[:upper:]' '[:lower:]')
    _cands=()
    for _e in "$_dir"/*; do
        [ -f "$_e" ] && [ -s "$_e" ] || continue
        [ "$(printf '%s' "$(basename "$_e")" | tr '[:upper:]' '[:lower:]')" = "$_lower_target" ] && _cands+=("$_e")
    done
    # Also try the extensionless/stem form case-insensitively, so a declaration
    # that is wrong in BOTH case and extension still resolves (e.g. the repo
    # holds contentstackContext.ts against a declared ContentstackContext.tsx).
    if [ "${#_cands[@]}" -eq 0 ] && [ "$_stem" != "$_abs" ]; then
        local _stem_base _lower_stem
        _stem_base="$(basename "$_stem")"
        _lower_stem=$(printf '%s' "$_stem_base" | tr '[:upper:]' '[:lower:]')
        for _e in "$_dir"/*; do
            [ -f "$_e" ] && [ -s "$_e" ] || continue
            local _e_base_noext="${_e%.*}"
            [ "$(printf '%s' "$(basename "$_e_base_noext")" | tr '[:upper:]' '[:lower:]')" = "$_lower_stem" ] && _cands+=("$_e")
        done
    fi

    if [ "${#_cands[@]}" -eq 1 ]; then
        warning "Deliverable '$_abs' resolved case-insensitively to '${_cands[0]}' — the declared casing does not match the repository."
        printf '%s\n' "${_cands[0]}"
        return 0
    fi
    if [ "${#_cands[@]}" -gt 1 ]; then
        warning "Declared deliverable '$_abs' is ambiguous by case — ${#_cands[@]} files match: ${_cands[*]}"
        return 1
    fi
    return 1
}

# _rejection_repeat_check <story_id> <key>
# Returns 0 when this exact rejection was ALSO the previous attempt's rejection.
#
# An identical rejection twice is evidence about the model, not the prompt.
# Live AMSD-2041 2026-07-30: metrolinx produced the same prescribed-helper
# rejection on attempts 2, 3 and 4 while the corrective sat in the prompt 21
# times over. Nothing about the next attempt differed, so nothing about its
# outcome could — $2.29 across three lanes, none delivered.
#
# Keyed on a STABLE key rather than the warning text, which carries the attempt
# number ("[attempt 2/8]") and so would never match itself. State lives in a
# file because the caller sits several scopes below the story loop; an empty key
# is never a repeat, so an attempt that failed for some other reason cannot
# inherit the last rejection and trigger a spurious escalation.
_rejection_repeat_check() {
    local _story_id="$1" _key="${2:-}"
    [ -z "$_key" ] && return 1
    local _state_dir="${LOG_DIR:-/tmp}"
    local _state_file="${_state_dir}/.rejection-${_story_id//[^A-Za-z0-9_-]/_}"
    local _prev=""
    [ -f "$_state_file" ] && _prev=$(cat "$_state_file" 2>/dev/null || echo "")
    printf '%s' "$_key" > "$_state_file" 2>/dev/null || true
    [ "$_key" = "$_prev" ] && return 0
    return 1
}

verify_story_deliverables() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local missing=()
    local declared=0
    local file

    # Vendor/build-output directories (node_modules for npm, vendor for Go,
    # venv/site-packages for Python, etc.) are provisioned by dependency
    # install (run_dependency_check), never authored by the agent -- but a
    # spec-pass elaboration can still declare one in technicalNotes.files
    # (found live, 2026-07-12: SKY-001B declared node_modules/ before it
    # existed yet, costing one wasted retry). Reuse the SAME generic,
    # project-supplied vendorDirs config _get_vendor_dirs() reads for
    # run_dependency_check/_vendor_lock -- no new hardcoded directory list
    # in this engine. NOTE: cannot reuse _get_vendor_dirs() itself here --
    # it deliberately filters to dirs that ALREADY exist (right, for its own
    # lock/integrity-check callers), but this check specifically needs to
    # match a vendor dir that does NOT exist yet (that's the exact bug being
    # fixed), so read the same config key directly without that filter.
    local _vendor_dirs=""
    local _vendor_config="${PROJECT_ROOT}/.epam/dependency-check.json"
    if [ -f "$_vendor_config" ]; then
        _vendor_dirs=$(jq -r '.vendorDirs[]? // empty' "$_vendor_config" 2>/dev/null | \
            while IFS= read -r _d; do
                [ -n "$_d" ] && echo "${PROJECT_ROOT}/${_d}"
            done)
    fi

    local unchanged=()
    # Declared paths the spec VERIFIED (fixVerified:true). Read once so the per-file loop below
    # can separate a CONFIRMED fix site from a speculative candidate — a distinction the PRD
    # already carries and this gate previously discarded.
    # VERIFIED-SITE SELECTION
    #
    # "The spec CONFIRMED this site" and "this file must be MODIFIED" are different claims, and
    # conflating them made a story unwinnable. The detective marks a site verified when it is
    # IMPLICATED. Live AMSD-2041, the prescription for one verified site reads "No code change
    # required in <helper> itself — it already reads from <context>. Verify that ...", so the
    # writer correctly changed nothing and the gate failed the story for it. The same file was
    # verified on ALL THREE codelines, so the story could not complete anywhere; three runs and
    # roughly nine attempts died on it.
    #
    # changeRequired separates the two. It is STRUCTURAL on purpose: a gate that read the
    # prescription looking for phrases like "no code change" would hardcode English into the
    # engine, break on any rewording, and be untestable in another language. The detective emits
    # the boolean; this reads it.
    #
    # ABSENT MEANS REQUIRED — `!= false` rather than `== true`. A PRD written before this field
    # existed, a detective not yet updated, or a hand-written spec all keep today's behaviour.
    # The permissive default would silently disable the check this gate exists to perform, which
    # is the exact failure it was added to prevent (four sites verified, one changed, story
    # reported complete). Only an explicit boolean false exempts a site; null, "false", 0 and ""
    # are all absent.
    local _declared_files=()
    while IFS= read -r file; do
        [ -n "$file" ] || continue
        declared=$((declared + 1))
        _declared_files+=("$file")
        # Support both absolute paths and paths relative to PROJECT_ROOT.
        # In worktree mode, absolute paths in technicalNotes.files point to the main
        # repo (e.g. /skyscanner-app/src/foo.ts). Rewrite them to the worktree path
        # so the deliverable check and agent prompt target the correct directory.
        local check_path
        if [[ "$file" = /* ]]; then
            if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ] && [[ "$file" = "${MAIN_PROJECT_ROOT}"* ]]; then
                check_path="${PROJECT_ROOT}${file#${MAIN_PROJECT_ROOT}}"
            else
                check_path="$file"
            fi
        else
            check_path="$PROJECT_ROOT/$file"
        fi
        local _is_vendor_path=false
        if [ -n "$_vendor_dirs" ]; then
            while IFS= read -r _vendor_dir; do
                [ -z "$_vendor_dir" ] && continue
                case "$check_path" in
                    "$_vendor_dir"|"$_vendor_dir"/*) _is_vendor_path=true; break ;;
                esac
            done <<< "$_vendor_dirs"
        fi
        [ "$_is_vendor_path" = true ] && continue
        local _resolved
        if _resolved="$(_resolve_deliverable_path "$check_path")"; then
            [ "$_resolved" != "$check_path" ] && \
                log "  Deliverable '$file' resolved to '${_resolved#"$PROJECT_ROOT"/}' (declaration omitted the extension)"
            check_path="$_resolved"
        else
            missing+=("$file")
            continue
        fi
        # Brownfield: "exists and is non-empty" is a real signal for a file
        # the agent was supposed to CREATE, but it is trivially true — and
        # proves nothing — for a file that already existed before this story
        # started, which is the normal case for a bugfix in an existing
        # codebase. Live bug (2026-07-22): three separate story attempts ran
        # out of turn budget mid-exploration, called WriteFile/Edit on
        # nothing, and this check still passed every time because the
        # declared files (pre-existing application code) were obviously
        # already there — the pipeline then marked the story "completed" and
        # committed whatever incidental pipeline noise (CodeGraph index,
        # .epam manifests) happened to be dirty instead. For a file that
        # already existed at the story's own baseline (the commit its branch
        # was created from — see ensure_story_branch), require a REAL
        # content diff, not just presence. A genuinely NEW file (didn't
        # exist at baseline) is already fully proven by the exists+non-empty
        # check above — no diff is possible or required for it.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -d "$PROJECT_ROOT/.git" ]; then
            local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
            if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
                local _rel_path="$check_path"
                case "$_rel_path" in
                    "$PROJECT_ROOT"/*) _rel_path="${_rel_path#"$PROJECT_ROOT"/}" ;;
                esac
                # A GITIGNORED FILE CAN NEVER BE AT BASELINE, so its absence there proves
                # nothing. The rule below treats "absent at baseline" as "a genuinely NEW file,
                # fully proven by exists + non-empty" — correct for a tracked file the story
                # created, and wrong for one git will never track.
                #
                # Live 2026-08-09, twice: `.env.local` was declared, exists on disk, is
                # gitignored. It counted as satisfied work, which moved the tally from
                # 12/12-unchanged to 11/12 — one below the threshold — so the hard
                # "all declared deliverables UNCHANGED, no real work done" failure never fired.
                # The writer produced a paragraph of prose, called WriteFile zero times, changed
                # nothing, and the run reported "Implemented: 1, Failed: 0". One such path in a
                # declared list disables that gate for every story, on every run.
                #
                # Treated as unchanged rather than missing: the file is genuinely there, it is
                # simply not evidence that this story did anything.
                if git -C "$PROJECT_ROOT" check-ignore -q "$_rel_path" 2>/dev/null; then
                    unchanged+=("$file")
                elif git -C "$PROJECT_ROOT" cat-file -e "${_baseline_ref}:${_rel_path}" 2>/dev/null; then
                    if git -C "$PROJECT_ROOT" diff --quiet "$_baseline_ref" -- "$_rel_path" 2>/dev/null; then
                        # Soft signal, NOT added to missing[] — declared files
                        # that pre-existed at baseline (the normal case for a
                        # bugfix) can legitimately include several CANDIDATE
                        # fix sites (e.g. locationHint's 2-3 file guesses from
                        # spec-mode-runner.js), only some of which the agent
                        # may genuinely need to touch. Requiring EVERY
                        # candidate to change is over-strict and produces a
                        # false failure the moment a real fix only needs a
                        # subset — found live (2026-07-23, AMSD-1820): openspec
                        # correctly identified 3 candidate files, the agent
                        # correctly edited 2 of them, and this check failed
                        # the whole story over the 1 unedited candidate.
                        # A file the story explicitly says to CREATE (didn't
                        # exist at baseline) has no such ambiguity — that one
                        # stays a hard requirement via missing[] above.
                        unchanged+=("$file")
                    fi
                fi
            fi
        fi
    # A LANE IS JUDGED BY ITS OWN CODELINE'S FILES.
    #
    # .technicalNotes.files is the UNION across every codeline; .technicalNotes.perCodeline holds
    # the correct per-lane lists. Reading the union asked a question scoped to one lane and
    # answered it with data scoped to all three: live 2026-08-09 the union carried
    # ContentstackQuote.tsx, which exists only in next.metrolinx.com, so gotransit's writer was
    # required to produce a component that does not belong in its repository. It could not, and no
    # retry could — an unwinnable loop that would have failed upexpress the same way.
    #
    # .codeline is authoritative here: _filtered_prd stamps each lane PRD with its own codeline so
    # consumers need not know lanes exist. Falls back to the flat list when there is no
    # per-codeline entry (single-codeline runs, or a lane the spec pass produced no list for) —
    # never to "nothing", which would pass the gate for a story that did no work. An explicitly
    # EMPTY per-codeline list is honoured as "this lane declares nothing", which is not the same
    # as having no entry at all.
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) as $s
         | ($s.technicalNotes // {}) as $tn
         | ((($tn.perCodeline // {})[$s.codeline // ""]) | if . == null then null else (.files // .) end) as $scoped
         | (if $scoped == null then ($tn.files // []) else $scoped end)[]? // empty' \
        "$prd_target" 2>/dev/null)

    if [ ${#missing[@]} -gt 0 ]; then
        STORY_REJECTION_KEY="missing:$(printf '%s,' "${missing[@]}")"
        # Told to the WRITER, not only to the log: a rejection the next attempt cannot read is
        # a rejection it cannot act on. See every-gate-tells-the-writer-why.test.ts.
        # Same routing requirement as above — a missing declared file is a deterministic fact,
        # and without the flag the writer is rejected without ever being told which file.
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe story declares deliverable(s) that do not exist. Create each one at the exact path listed, or correct the declaration if the path is wrong:\n\n%s\n' "$(printf '  - %s\n' "${missing[@]}")")
        error "Story $story_id is missing ${#missing[@]} declared deliverable(s) in $PROJECT_ROOT:"
        for file in "${missing[@]}"; do
            error "  $file"
        done
        return 1
    fi

    # Persist which declared files got real work vs which sat untouched, so a
    # RETRY (whatever the reason — tsc failure, review rejection, this
    # function's own "all unchanged" verdict below) can tell the next attempt
    # explicitly what's already done and what still needs it, instead of
    # leaving that distinction to be re-derived from "## Existing File
    # Contents" prose alone. Globals (not local), same pattern as
    # STORY_REJECTION_KEY above — read by the retry loop after this function
    # returns, from a different scope.
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    if [ "$declared" -gt 0 ]; then
        local _touched=()
        local _f
        for _f in "${_declared_files[@]}"; do
            local _is_unchanged=false _is_missing=false
            for file in "${unchanged[@]}"; do [ "$file" = "$_f" ] && _is_unchanged=true && break; done
            for file in "${missing[@]}"; do [ "$file" = "$_f" ] && _is_missing=true && break; done
            [ "$_is_unchanged" = false ] && [ "$_is_missing" = false ] && _touched+=("$_f")
        done
        LAST_VERIFIED_TOUCHED_FILES=$(printf '%s\n' "${_touched[@]}")
        LAST_VERIFIED_UNCHANGED_FILES=$(printf '%s\n' "${unchanged[@]}")
    fi

    # Fail only when EVERY declared, pre-existing file is unchanged — that's
    # the "nothing real happened" signal this whole function exists to catch.
    # If at least one declared file shows a real diff, the story did genuine
    # work; the rest were legitimate candidates that turned out unnecessary.
    if [ "$declared" -gt 0 ] && [ ${#unchanged[@]} -eq "$declared" ]; then
        # PER-ATTEMPT verdict, exactly like the zero-declared fallback below:
        # returning 1 sends the story back through the retry ladder and a later
        # attempt routinely succeeds. d2a7c1b fixed the severity of that sibling
        # and left this one terminal-sounding, so live metrolinx 2026-07-26
        # printed this as [ERROR] on attempts 3 and 4 of 8, carrying no attempt
        # number, for a story that then succeeded. That is the same reading trap
        # that once got a healthy run killed by hand, one branch over. Severity
        # is a contract with the reader the way exit status is a contract with
        # the caller: warn per attempt, and leave the terminal error to the
        # loop's own exhaustion path.
        local _unchanged_note=""
        if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
            if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                _unchanged_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
            else
                _unchanged_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
            fi
        fi
        STORY_REJECTION_KEY="unchanged-all:$(printf '%s,' "${unchanged[@]}")"
        warning "Story $story_id: all $declared declared deliverable(s) exist but are UNCHANGED since baseline — no real work done anywhere in the declared set${_unchanged_note}:"
        for file in "${unchanged[@]}"; do
            warning "  $file"
        done
        return 1
    # THE VERIFIED-FIX-SITE GATE WAS DELETED HERE (2026-08-12, operator decision).
    #
    # It demanded a real diff in EVERY site the spec marked fixVerified. That is conformance to
    # the plan — and the plan is GUIDANCE. The detective points the writer at the right region
    # of a real codebase; the writer READS THE CODE and fills the gaps. Gating on "did every
    # prescribed file change" makes a story unwinnable the moment the plan is imperfect, which
    # by design it is expected to be.
    #
    # Record: ONE true catch (2026-08-09, four verified sites, one changed, story reported
    # complete) against at least three false failures. Its own comment recorded "three runs and
    # roughly nine attempts died on it", and on 2026-08-12 it blocked AMSD-2041 by demanding a
    # diff in a file whose own prescription reads "No code change required in useContent
    # itself".
    #
    # No weaker setting works either: relaxed to "at least one verified site changed", the very
    # incident it was built for PASSES, because the writer did change one. It substituted a
    # structural proxy (file diffs) for a question about behaviour (can this satisfy its
    # criterion), and a structural proxy over a guidance artefact gives exactly what was seen:
    # false rejections of correct work, silence on incorrect work.
    #
    # What holds instead: the tests and the verification criteria — what a user observes, which
    # cannot be satisfied by over-reach or under-delivery. The VC coverage check is weak today
    # (word overlap; it scored a working and a broken prescription alike as "complete"), and
    # strengthening it is the replacement for this gate rather than another proxy.

    elif [ ${#unchanged[@]} -gt 0 ]; then
        warning "Story $story_id: ${#unchanged[@]}/$declared declared candidate file(s) were unchanged (real work landed in the others) — informational, not a failure:"
        for file in "${unchanged[@]}"; do
            warning "  $file"
        done
    fi

    # Brownfield, zero declared files: the per-file loop above has nothing to
    # check, so it trivially passes — but that proves nothing about whether
    # the agent actually did any real work. Live bug (2026-07-22, run14):
    # locationHint propagation into technicalNotes.files (see spec-mode-
    # runner.js) is itself non-deterministic — the same spec-pass prompt can
    # return it populated on one attempt and empty on the next. When it's
    # empty, this function had NOTHING to verify and silently passed a story
    # whose agent turn produced no real change at all (confirmed: the only
    # file that had changed was CodeGraph's own incidental index write).
    # Fallback: if brownfield declared zero files, require the WHOLE tree to
    # show some real change relative to baseline, excluding known-incidental
    # pipeline paths (.codegraph/, .epam/) that are never genuine story
    # output. This is a coarser check than the per-file diff above (it can't
    # say WHICH file should have changed, since none were declared), but it
    # still catches "nothing real happened" — the actual failure pattern
    # behind three separate false-completion incidents today.
    if [ "$declared" -eq 0 ] && [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -d "$PROJECT_ROOT/.git" ]; then
        local _baseline_ref; _baseline_ref="$(_resolved_baseline_ref)"
        if git -C "$PROJECT_ROOT" rev-parse --verify "$_baseline_ref" >/dev/null 2>&1; then
            local _real_changes
            _real_changes=$(git -C "$PROJECT_ROOT" diff --name-only "$_baseline_ref" 2>/dev/null | \
                grep -v -E '^(\.codegraph/|\.epam/)' || true)
            if [ -z "$_real_changes" ]; then
                # This is a PER-ATTEMPT verdict, not a terminal one: returning 1
                # sends the story back through the retry ladder, and a later
                # attempt routinely succeeds. Live metrolinx 2026-07-25 —
                # MiniMax-M3 returned success on attempt 1 having written
                # nothing; this check caught it, attempt 2 produced the correct
                # fix. But it was logged via error() with no attempt number, so
                # a healthy run read as a dead one and was killed by hand
                # mid-QA. Severity is a contract with the reader the same way
                # exit status is a contract with the caller: warn per attempt,
                # and let the loop's own exhaustion path own the terminal error.
                local _attempt_note=""
                if [ -n "${retry_count:-}" ] && [ -n "${MAX_RETRIES:-}" ]; then
                    if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                        _attempt_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — will retry]"
                    else
                        _attempt_note=" [attempt $((retry_count + 1))/$((MAX_RETRIES + 1)) — no retries remain]"
                    fi
                fi
                STORY_REJECTION_KEY="no-tree-change"
                warning "Story $story_id declared NO technicalNotes.files, and no real change exists anywhere in $PROJECT_ROOT relative to ${_baseline_ref} (only incidental pipeline paths, if anything, changed) — treating this attempt as incomplete rather than trusting an empty deliverable list.${_attempt_note}"
                return 1
            fi
        fi
    fi

    if [ "$declared" -gt 0 ]; then
        success "Verified $declared declared deliverable(s) for $story_id"
    fi
    # A prescribed, existing helper that the change never uses means the agent
    # re-implemented it — and guessed. Retryable.
    verify_prescribed_helper_used "$story_id" || return 1

    # A build-time value read where the build never substitutes it. Same class: mechanical,
    # checkable, and invisible to every other gate. Retryable.
    #
    # PRESENCE-GUARDED, like every other optional collaborator here. Fourteen test harnesses
    # extract this function and run it in isolation; an unguarded call to a sibling they do not
    # extract fails them all with "command not found", which reads as a production defect and is
    # not one. In a real run the function is always defined a few lines above, so the guard costs
    # nothing and never silently skips anything that exists.
    if command -v verify_client_env_boundary >/dev/null 2>&1; then
        verify_client_env_boundary "$story_id" || return 1
    fi

    # The story produced real, verified work — tell the phase gates what it was
    # so they can judge this run's output instead of the whole codebase.
    record_story_outputs "$story_id"
    return 0
}

# _scope_lock <story_id>
# Makes every .ts file in PROJECT_ROOT/src that is NOT in the story's declared
# technicalNotes.files read-only (chmod 444) before the agent runs, PLUS every
# file (any extension, any location under PROJECT_ROOT) declared by a DIFFERENT
# story — i.e. a file that already belongs to a prior (or sibling) story's own
# scope. This is an OS-level pre-emptive guard: Bash, WriteFile, or any other
# mechanism that tries to write an out-of-scope file will get EACCES — no
# tool-layer workaround exists.
#
# Root cause the second part fixes (found live, 2026-07-06): the original
# version only ever locked .ts files under src/ — tsconfig.json, package.json,
# vitest.config.ts (root-level, non-.ts scaffold artifacts) were completely
# unprotected. SKY-002 rewrote tsconfig.json — a file it never declared and
# had no business touching — changing a VALID moduleResolution SKY-001 had
# correctly scaffolded into an INVALID one, then regenerated the same wrong
# value on every retry attempt, exhausting the entire retry/escalation ladder
# on a self-inflicted regression in a file outside its own scope. Generic: not
# hardcoded to config-file names — protects whatever any OTHER story declared,
# whatever its extension or location.
_scope_lock() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    local -A _decl
    while IFS= read -r _f; do
        [ -n "$_f" ] && _decl["$_f"]=1
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null)

    local _locked=0

    if [ ${#_decl[@]} -gt 0 ]; then
        while IFS= read -r _f; do
            [ -n "${_decl[$_f]+x}" ] && continue
            chmod 444 "$_f" 2>/dev/null && ((_locked++))
        done < <(find "$PROJECT_ROOT/src" -name "*.ts" -type f 2>/dev/null)
    fi

    local _other_locked=0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        [ -n "${_decl[$_f]+x}" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] || continue
        chmod 444 "$_abs_f" 2>/dev/null && ((_other_locked++))
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)

    [ "$_locked" -gt 0 ] && log "  [scope-guard] Locked $_locked out-of-scope .ts file(s) (read-only) for $story_id"
    [ "$_other_locked" -gt 0 ] && log "  [scope-guard] Locked $_other_locked file(s) owned by other stories (read-only) for $story_id"
}

# _scope_unlock <story_id>
# Restores write permissions on all .ts files in PROJECT_ROOT/src, plus every
# file owned by a different story that _scope_lock locked above.
_scope_unlock() {
    local story_id="${1:-}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    find "$PROJECT_ROOT/src" -name "*.ts" -type f -exec chmod 644 {} + 2>/dev/null || true

    [ -z "$story_id" ] && return 0
    while IFS= read -r _f; do
        [ -z "$_f" ] && continue
        local _abs_f="$_f"
        [[ "$_f" != /* ]] && _abs_f="$PROJECT_ROOT/$_f"
        [ -f "$_abs_f" ] && chmod 644 "$_abs_f" 2>/dev/null || true
    done < <(jq -r --arg id "$story_id" \
        '.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty' \
        "$prd_target" 2>/dev/null | sort -u)
}

# _get_vendor_dirs <project_root>
# Reads the generic, project-supplied list of vendored-dependency directories
# from .epam/dependency-check.json's "vendorDirs" key (e.g. ["node_modules"]
# for an npm project, ["venv", "site-packages"] for Python, ["vendor"] for Go
# — never hardcoded in this engine, since a future project may not use npm at
# all). Opt-in: no config file or no "vendorDirs" key = no output, callers
# no-op. Echoes one absolute path per line for directories that actually exist.
_get_vendor_dirs() {
    local project_root="$1"
    local config_file="${project_root}/.epam/dependency-check.json"
    [ -f "$config_file" ] || return 0
    jq -r '.vendorDirs[]? // empty' "$config_file" 2>/dev/null | while IFS= read -r _d; do
        [ -z "$_d" ] && continue
        local _abs="$project_root/$_d"
        [ -d "$_abs" ] && echo "$_abs"
    done
}

# _vendor_lock <project_root>
# Root cause this addresses (found live, 2026-07-07): a story's agent,
# repeatedly failing to get its real test tool working, OVERWROTE the actual
# installed package's own entry point file (node_modules/vitest/vitest.mjs)
# with a fake stub that unconditionally echoed "passed" — the agent faking
# verification success rather than fixing the underlying problem. HealingBroken
# eventually caught the recurring failure and the story was correctly marked
# failed, not falsely passed, but the tampering itself should never have been
# possible in the first place.
#
# chmod -R a-w on every configured vendor dir, same OS-level pre-emptive
# guard already proven for _scope_lock's per-story file protection — applied
# once per story attempt (before invoking the agent), not per-file, since
# vendor dirs are NEVER a legitimate write target for any story, unlike
# src/ files which rotate ownership between stories.
# Note (same limitation _scope_lock already documents): this deters, it does
# not cryptographically prevent — the file owner can still `chmod +w` via
# Bash and bypass it. See run_vendor_integrity_check() below for the backstop
# that catches tampering even when the lock itself is bypassed.
_vendor_lock() {
    local project_root="$1"
    local _locked=0
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R a-w "$_vendor_dir" 2>/dev/null && ((_locked++))
    done < <(_get_vendor_dirs "$project_root")
    if [ "$_locked" -gt 0 ]; then
        mkdir -p "$project_root/.epam" 2>/dev/null || true
        touch "$project_root/.epam/.vendor-lock-marker" 2>/dev/null || true
        log "  [vendor-guard] Locked $_locked vendor director(y/ies) read-only"
    fi
}

# _vendor_unlock <project_root>
# Restores write permissions on configured vendor dirs — called after the
# agent's own turn ends, before run_dependency_check's own LEGITIMATE
# installs (which do need to write there) and the deterministic checks/test
# run. The integrity check itself (run_vendor_integrity_check) runs BEFORE
# this unlock and before run_dependency_check, so it only ever sees changes
# from the agent's own turn, never dependency-check's sanctioned writes.
_vendor_unlock() {
    local project_root="$1"
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R u+w "$_vendor_dir" 2>/dev/null || true
    done < <(_get_vendor_dirs "$project_root")
}

# run_dynamic_tools_in_unlocked_window <project_root> <output_file>
# Deterministically executes every dynamic tool the self-healing loop has
# written for this project, in the SANCTIONED unlocked window (right after
# _vendor_unlock, before the test command runs) — not left to the agent to
# invoke via Bash sometime during its own turn.
#
# Root cause this fixes (found live, 2026-07-09, tier3-travel-app run):
# _vendor_lock() chmods vendor dirs (e.g. node_modules) read-only for the
# WHOLE story turn, before the agent runs. When the failure-analyst diagnoses
# a missing dependency and writes a dynamic tool that runs `npm install X`,
# the agent's own invocation of that tool happens DURING the same locked
# turn — the install either fails outright (permission denied, surfacing as
# the exact same "X not found" diagnosis on every retry) or partially writes
# just enough to trip run_vendor_integrity_check's tamper detector, hard-
# failing the story before the fix ever had a chance to land. A dependency-
# installing dynamic tool could NEVER succeed under the old lock ordering —
# confirmed live: SKY-002-test/SKY-002-test-1 each burned all 8 retries on
# "vitest not found" without the repeatedly-rewritten install-vitest.sh tool
# ever actually installing vitest.
#
# Tools are already required to be idempotent (enforced by the tool_creation
# reviewer's own rules), so running them here — unconditionally, every retry,
# in a genuinely unlocked window — is safe even if the agent ALSO tries to
# invoke the same tool itself during its turn.
#
# Safety floor: each tool is syntax-checked (bash -n) before being trusted to
# execute. The orchestrator (not just the agent) now runs these
# unconditionally every retry, so a tool that's merely syntactically broken
# must not be blindly executed — skip and log rather than let a malformed
# script corrupt state or hang the pipeline.
run_dynamic_tools_in_unlocked_window() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local tools_dir="$project_root/.epam/dynamic-tools"
    [ -d "$tools_dir" ] || return 0
    [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ] || return 0

    local _tool_file _tool_base
    for _tool_file in "$tools_dir"/*.sh; do
        [ -f "$_tool_file" ] || continue
        _tool_base="${_tool_file##*/}"
        # Only reviewed tools are ever used by downstream agents or the
        # orchestrator itself — an explicit, checkable marker, not an
        # assumption that the directory only ever contains reviewed scripts.
        if [ ! -f "${_tool_file}.reviewed" ]; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — no .reviewed marker (not approved by the reviewer gate)"
            continue
        fi
        if ! bash -n "$_tool_file" 2>>"$output_file"; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — fails bash syntax check"
            continue
        fi
        log "  [dynamic-tools] Running ${_tool_base} in sanctioned unlocked window..."
        if ! (cd "$project_root" && bash "$_tool_file") >> "$output_file" 2>&1; then
            warning "  [dynamic-tools] ${_tool_base} exited non-zero (continuing)"
        fi
    done
}

# run_vendor_integrity_check <project_root> <output_file>
# Deterministic backstop (found live, 2026-07-07 — see _vendor_lock's
# docstring for the exact live defect this catches): detects any file under a
# configured vendor dir modified since the lock marker was touched at story-
# attempt start, regardless of whether the chmod lock itself was bypassed.
# A legitimate story NEVER needs to modify an already-installed vendored
# package's own files — only add NEW dependencies via the manifest, which
# run_dependency_check's sanctioned install step handles AFTER this check
# runs. Any hit here is treated as a hard, deterministic failure — no LLM
# diagnosis needed, the fact itself is certain.
#
# Excludes tool-generated cache/output paths, config-supplied via
# .epam/dependency-check.json's "vendorCacheExcludePatterns" (bash glob
# patterns matched against each file's path relative to the vendor dir — e.g.
# ".vite/*" for Vitest's own results cache). No test-runner/tool name is
# hardcoded in this engine, same "manifest supplies stack knowledge" pattern
# as vendorDirs/requiredDevDependencies above. Root cause this fixes (found
# live, 2026-07-13, SKY-004 and SKY-003-b): a story's agent legitimately runs
# its own tests to self-verify — completely normal, encouraged behavior — and
# vitest rewrites its OWN result cache (node_modules/.vite/vitest/results.json)
# as a side effect. That's the tool's own transient output, not a rewrite of
# its actual entry-point/source code (the exploit this check exists to catch,
# e.g. node_modules/vitest/vitest.mjs) — but the check couldn't tell them
# apart, hard-failing 4 separate legitimate test runs across two stories in a
# single run.
# Returns 0 if clean (or no vendor dirs configured / no marker yet). Returns 1
# and sets VERIFICATION_FAILURE otherwise.
run_vendor_integrity_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local marker="$project_root/.epam/.vendor-lock-marker"
    [ -f "$marker" ] || return 0

    local -a exclude_patterns=()
    local _config_file="$project_root/.epam/dependency-check.json"
    if [ -f "$_config_file" ]; then
        while IFS= read -r _pat; do
            [ -n "$_pat" ] && exclude_patterns+=("$_pat")
        done < <(jq -r '.vendorCacheExcludePatterns[]? // empty' "$_config_file" 2>/dev/null)
    fi

    local tampered=()
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        while IFS= read -r _f; do
            [ -z "$_f" ] && continue
            local _rel="${_f#"$_vendor_dir"/}"
            local _excluded=false
            local _pat
            for _pat in "${exclude_patterns[@]}"; do
                # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
                case "$_rel" in
                    $_pat) _excluded=true; break ;;
                esac
            done
            [ "$_excluded" = true ] || tampered+=("$_f")
        done < <(find "$_vendor_dir" -type f -newer "$marker" 2>/dev/null)
    done < <(_get_vendor_dirs "$project_root")

    [ "${#tampered[@]}" -eq 0 ] && return 0

    local details
    details=$(head -n "$(evidence_window tamperedFileLines)" <<< "$(printf '%s\n' "${tampered[@]}")")
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nFile(s) inside a vendored/third-party dependency directory were modified — this is never legitimate (only NEW dependencies should be added via the manifest, never an existing installed package edited directly). Revert this change and fix the ACTUAL problem (e.g. wrong package.json config, missing devDependency) instead:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Vendor directory integrity check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_dependency_check <project_root>
# Deterministic (non-LLM) replacement for "hope the agent remembers to
# install what it imports" — the exact recurring failure class this session
# kept hitting (supertest imported but never added to devDependencies,
# burning full retry cycles on the same mechanical mistake every time).
#
# Fully generic: reads a dependency-check.json for the manifest file, its
# dependency keys, the import-statement regex, and the install command
# template — all data, no npm/pip/cargo/language assumption anywhere in this
# function. Different orchestrations (Python, Rust, etc.) supply their own
# manifest; this function is identical for all of them.
#
# Config location: for a brownfield codeline, this config is NEVER stored
# inside the client's own repo (a client codeline is not epam-cli's to write
# into, even for our own tooling — see feedback_no_client_repo_writes_or_
# hardcoding memory). EPAM_PROJECT_CONFIG_DIR (set by the project's own
# tier3-*-run.sh, e.g. orchestrations/projects/metrolinx) is checked first;
# only a project WITHOUT that var set (greenfield, scaffolding its own new
# repo from scratch — a repo the pipeline itself owns) falls back to
# <project_root>/.epam/dependency-check.json, which is legitimate there
# since the pipeline authored that repo in the first place.
# No manifest present = no-op (opt-in feature, old projects unaffected).
# Describe how THIS codeline resolves bare imports, for the agent's prompt.
#
# The scanner already answers this question deterministically (see
# _resolves_inside_repo in run_dependency_check): a bare specifier naming a file
# under one of the repo's own top-level directories is internal code, not a
# package. The agent was never told, so on live metrolinx 2026-07-29 it wrote
# imports the scanner then tried to npm-install — 346/553/506 attempts per lane,
# which consumed the story budget.
#
# Derived from the same manifest and the same root-discovery rule the scanner
# uses. It must never become hand-written prose in a prompt: if the agent is
# told one convention and the scanner applies another, the result is a subtler
# version of the original bug — "correct" imports the scanner still rejects.
#
# Silent when the codeline has no manifest: we do not know its conventions then,
# and inventing them is worse than saying nothing.
_module_resolution_context() {
    local _repo="${1:-$PROJECT_ROOT}"
    local _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_cfg" ] || _cfg="$_repo/.epam/dependency-check.json"
    [ -f "$_cfg" ] || return 0

    "${PYTHON_BIN:-python3}" "$SCRIPT_DIR/lib/handlers/module-resolution-context.py" "$_repo" "$_cfg"
}

# _discover_vendor_packages <resolved_abs_file>
# Prints one third-party package name per line, imported by the given real
# file — deduplicated, excluding relative/internal imports and anything in
# ignorePackages.
#
# Reuses .epam/dependency-check.json's importPattern/vendorDirs/ignorePackages
# VERBATIM — the same config already trusted by the dependency-check step. No
# new manifest field, no project/package/language assumption in this function: a
# project with no dependency-check.json gets an empty result (opt-in, same
# convention as every other manifest-gated feature here).
#
# Ground-truthing a THIRD-PARTY API's shape (found live, 2026-07-30, AMSD-2041):
# dependency_contracts already ground-truths a story's declared INTERNAL
# dependencies, but a third-party package gets none of it, so every attempt —
# implementation and self-heal alike — reconstructs the package's real shape
# from training memory. The failure-analyst diagnosed the identical Contentstack
# Config-type mismatch 3 times running with patches_applied:0, because nothing
# in the pipeline ever showed either agent the SDK's actual type.
_discover_vendor_packages() {
    local _file="$1"
    [ -f "$_file" ] || return 0
    local _config="${PROJECT_ROOT}/.epam/dependency-check.json"
    [ -f "$_config" ] || return 0

    local _import_pattern _vendor_dirs_json _ignore_json
    _import_pattern=$(jq -r '.importPattern // empty' "$_config" 2>/dev/null)
    [ -z "$_import_pattern" ] && return 0
    _vendor_dirs_json=$(jq -c '.vendorDirs // []' "$_config" 2>/dev/null)
    _ignore_json=$(jq -c '.ignorePackages // []' "$_config" 2>/dev/null)

    python3 "$SCRIPT_DIR/lib/handlers/vendor-packages.py" "$_file" "$_import_pattern" "$_ignore_json"
}

# _generate_vendor_contract <project_root> <package_name>
# Deterministically writes .contracts/vendor-<package>.md by extracting
# exported interfaces/classes directly from the PACKAGE'S OWN installed
# source — not by asking a model to recall them. Identical extraction
# approach to generate_story_contract() (same interfacePattern/classPattern/
# sourceExtensions from .epam/contract-generation.json), pointed at a vendored
# package directory instead of the story's own files. A project with no
# contract-generation.json, or a package that isn't actually installed under
# any declared vendorDir, gets a silent no-op — this is additive grounding,
# never a requirement.
_generate_vendor_contract() {
    local _root="$1"
    local _package="$2"
    local _config="${_root}/.epam/contract-generation.json"
    [ -f "$_config" ] || return 0
    local _dep_config="${_root}/.epam/dependency-check.json"
    [ -f "$_dep_config" ] || return 0

    local _vendor_dirs_json _vendor_dir _package_dir=""
    _vendor_dirs_json=$(jq -r '.vendorDirs[]? // empty' "$_dep_config" 2>/dev/null)
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        [ -d "${_root}/${_vendor_dir}/${_package}" ] && { _package_dir="${_root}/${_vendor_dir}/${_package}"; break; }
    done <<< "$_vendor_dirs_json"
    [ -z "$_package_dir" ] && return 0

    local _exts_json
    _exts_json=$(jq -c '.sourceExtensions // []' "$_config" 2>/dev/null)
    local _files_json
    _files_json=$(python3 "$SCRIPT_DIR/lib/handlers/vendor-contract.py" "$_package_dir" "$_exts_json"
)
    [ "$_files_json" = "[]" ] && return 0

    mkdir -p "${_root}/.contracts" 2>/dev/null
    local _contract_file="${_root}/.contracts/vendor-${_package}.md"
    _generate_contract_from_files "$_root" "$_contract_file" "$_files_json" "vendor:${_package}" "$_config"
}

# run_dependency_check <project_root>
#
# SCANNING IS A PLUGIN. This was 371 lines of Python embedded in a heredoc here, which scanned
# source for imports, classified each specifier, and AUTO-INSTALLED whatever it called missing.
# Import scanning and module resolution are language facts, so they moved to
# orchestrations/plugins/dependency-scan-plugin.js. This is now a reporter.
#
# WHY IT MOVED. Live 2026-08-11 (AMSD-2041/gotransit) the old code installed
# "components": "^0.1.0" — an unrelated 2013 public npm package — into a transit operator's
# production manifest. `components` is that repository's OWN directory. It happened because the
# scanner hardcoded ecosystem facts the project already declares (vendorDirs was DECLARED while
# 'node_modules' was written literally four times in the same function), so when the declaration
# was absent the literals kept it running and it produced a confident wrong answer instead of
# stopping.
#
# THE ENGINE NO LONGER DECIDES. An unresolvable import is a FINDING. Installing happens only
# when the PROJECT declares autoInstall, using the installCommand the project declares — never
# on this script's own verdict.
# run_lockfile_sync_check <project_root>
#
# THE MANIFEST AND THE LOCKFILE DRIFTED APART AND EVERY CHECK PASSED ANYWAY.
#
# Live metrolinx AMSD-2041, approved commit af1d6b99. package.json gained
# "@contentstack/live-preview-utils" and package-lock.json -- tracked, not ignored, clean in the
# worktree -- was never touched; the package is absent from it entirely. tsc, ESLint and the build
# passed and the reviewer APPROVED, because node_modules already held the package from a run five
# days earlier that survived the codeline reset. `npm install` appears zero times in the run log.
# `npm ci` on that branch fails outright.
#
# run_dependency_check answers the neighbouring question -- does the manifest declare what the code
# imports -- and cannot see this one, because the manifest DID declare it. Only the lockfile
# records what a clean checkout installs.
#
# IT DOES NOT BLOCK ON DRIFT THE STORY DID NOT CAUSE. That is 665f1a5's lesson: pre-existing desync
# is repository debt, and hard-stopping on debt no writer output can repair burns the story budget
# in a loop with no exit. The discriminator is EPAM_STORY_INTRODUCED_DEPS, the same manifest-delta
# the SAST gate uses.
run_lockfile_sync_check() {
    local project_root="$1"
    local _handler="${SCRIPT_DIR}/lib/handlers/lockfile-sync.js"
    local _node="${NODE_CMD:-node}"

    [ -n "$project_root" ] && [ -d "$project_root" ] || return 0
    [ -f "$_handler" ] || { warning "  [lockfile-sync] handler missing — cannot prove the lockfile is in sync"; return 0; }

    local _out
    _out=$("$_node" "$_handler" "$project_root" 2>/dev/null) || {
        warning "  [lockfile-sync] check did not run — cannot prove the lockfile is in sync"
        return 0
    }

    local _unprovable
    _unprovable=$(printf '%s\n' "$_out" | awk -F'\t' '$1=="unprovable"{print $2}')
    if [ -n "$_unprovable" ]; then
        # NOT a pass. Said out loud, because a check reporting success from absent evidence is the
        # class of defect this gate exists to remove.
        info "  [lockfile-sync] cannot prove: ${_unprovable}"
        return 0
    fi

    local _missing=()
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        case "$_line" in missing*) ;; *) continue ;; esac
        _missing+=("$_line")
    done <<< "$_out"
    [ ${#_missing[@]} -gt 0 ] || return 0

    # Which of them did THIS story introduce? Everything else is pre-existing debt.
    #
    # The producer may have exported the answer already (the SAST gate needs the same one). An
    # EMPTY export is a real answer -- "this story added nothing" -- so only an UNSET variable
    # sends us to compute it.
    local _intro_list="${EPAM_STORY_INTRODUCED_DEPS-}"
    if [ -z "${EPAM_STORY_INTRODUCED_DEPS+x}" ] && command -v story_introduced_deps >/dev/null 2>&1; then
        _intro_list="$(story_introduced_deps "$project_root")"
    fi
    local _introduced=",${_intro_list},"
    local _blocking=() _preexisting=() _pkg _lock
    for _line in "${_missing[@]}"; do
        _pkg=$(printf '%s' "$_line" | cut -f2)
        _lock=$(printf '%s' "$_line" | cut -f3)
        case "$_introduced" in
            *",${_pkg},"*) _blocking+=("$_pkg") ;;
            *) _preexisting+=("$_pkg") ;;
        esac
    done

    if [ ${#_preexisting[@]} -gt 0 ]; then
        warning "  [lockfile-sync] ${#_preexisting[@]} pre-existing dependency(ies) absent from ${_lock} — advisory, not introduced by this story: $(printf '%s ' "${_preexisting[@]}")"
    fi

    [ ${#_blocking[@]} -gt 0 ] || return 0

    local _specs
    _specs=$(printf '  - %s\n' "${_blocking[@]}")
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    STORY_REJECTION_KEY="lockfile:${_blocking[0]}"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nYour change added dependency(ies) to the manifest that %s does not resolve:\n\n%s\nA lockfile is the only record of what a clean checkout installs. They resolve here because a vendor directory happens to already contain them, so the type check, the tests and the build all pass on this machine and the branch is BROKEN for anyone installing from the lockfile.\n\nInstall each one with this project'"'"'s package manager so the manifest and %s are written together. Do not hand-edit %s, and do not remove the dependency.\n' \
        "$_lock" "$_specs" "$_lock" "$_lock")
    error "  [lockfile-sync] ${#_blocking[@]} dependency(ies) this story added are absent from ${_lock} — the change cannot be installed from a clean checkout"
    return 1
}

run_dependency_check() {
    local project_root="$1"
    local _plugin="${AUTOMATION_DIR}/plugins/dependency-scan-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || { warning "  [dependency-scan] plugin missing at $_plugin — no scan performed"; return 0; }

    # PRE-SCAN HOOK — the project's own reconciliation, before anything is inspected.
    #
    # Some estates need a full package-manager reconciliation before an agent touches code: e.g.
    # stripping a private-registry dependency, running a full install, restoring the manifest.
    # Live 2026-07-21: a codeline with a GitHub-Packages dependency 401'd on every per-package
    # install, and copy workarounds left truncated files. A single project-declared full install
    # fixed it. Non-fatal by design — a hook that fails must not stop the agent working.
    local _hook _hook_timeout
    _hook=$(_project_dep_config_value "$project_root" preInstallHook)
    if [ -n "$_hook" ]; then
        info "  [dependency-check] Running preInstallHook..."
        _hook_timeout="${EPAM_DEP_HOOK_TIMEOUT_SECS:-300}"
        if ( cd "$project_root" && timeout "$_hook_timeout" bash -c "$_hook" ); then
            info "  [dependency-check] preInstallHook complete"
        else
            _hook_rc=$?
            if [ "$_hook_rc" -eq 124 ]; then
                info "  [dependency-check] preInstallHook TIMED OUT after ${_hook_timeout}s (non-fatal — continuing)"
            else
                info "  [dependency-check] preInstallHook exited ${_hook_rc} (non-fatal — continuing)"
            fi
        fi
    fi

    # WHAT THIS STORY TOUCHED — the signal that separates a new problem from estate condition.
    #
    # A package present in a vendor directory but absent from the manifest builds locally and
    # breaks for anyone installing from the manifest. It is also the steady state of many
    # brownfield repos: reporting every instance on every run buries the one that matters. So it
    # is reported only when the importing file is one this story changed.
    #
    # Derived from the repo's own status, not from a story manifest: an agent can import from a
    # file it never declared, and that is exactly the case worth catching.
    local _changed
    _changed=$(git -C "$project_root" status --porcelain 2>/dev/null \
        | sed 's/^...//' | sed 's/^.* -> //' | tr '\n' '\036')

    # THE LINES THIS CHANGE ADDED — raw, never parsed here.
    #
    # An undeclared import is the story's only when the change INTRODUCED it; a file merely touched
    # may have carried one since before the run. The plugin decides which specifiers those lines
    # contain, using the importPattern the project declares — a second copy of that pattern here
    # would be a project fact living outside config or a plugin, and the two would drift.
    #
    # Untracked files count whole: every line of a file this change created is an added line.
    local _added
    _added=$( { git -C "$project_root" diff --unified=0 2>/dev/null
                git -C "$project_root" diff --cached --unified=0 2>/dev/null; } \
              | grep '^+' | grep -v '^+++' | sed 's/^+//'
              git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null \
              | while IFS= read -r _uf; do [ -f "$project_root/$_uf" ] && cat "$project_root/$_uf" 2>/dev/null; done )

    local _out
    _out=$(EPAM_SCAN_CHANGED_FILES="$_changed" EPAM_SCAN_ADDED_LINES="$_added" "$_node" -e '
      const p = require(process.argv[1]);
      const changed = String(process.env.EPAM_SCAN_CHANGED_FILES || "")
        .split("").map((s) => s.trim()).filter(Boolean);
      const r = p.scanImports(process.argv[2], process.env, { changedFiles: changed, introducedLines: String(process.env.EPAM_SCAN_ADDED_LINES || "").split("\n") });
      if (r.status === "unknown") { console.log("UNKNOWN\t" + r.reason); process.exit(0); }
      for (const f of r.findings) console.log(f.verdict + "\t" + f.specifier + "\t" + f.file);
      // Only when it could have changed the answer. A clean scan stays silent — a note on every
      // run is noise, and noise is what stops anyone reading the line that matters.
      if (r.findings.length && !r.moduleRootsDeclared) console.log("NOTE\tmodule roots were discovered, not declared — an unresolvable import may be internal");
    ' "$_plugin" "$project_root" 2>&1) || true

    [ -z "$_out" ] && return 0

    local _line _kind _rest
    local _undeclared=()
    while IFS= read -r _line; do
        [ -z "$_line" ] && continue
        _kind="${_line%%	*}"; _rest="${_line#*	}"
        case "$_kind" in
            UNKNOWN)
                # Absent declaration is not "no problems found". Said out loud so a project that
                # has not declared how it scans is visibly unscanned rather than silently clean.
                warning "  [dependency-scan] not performed: ${_rest}"
                ;;
            malformed)
                warning "  [dependency-scan] malformed import capture (NOT a package): ${_rest}"
                ;;
            unknown_external)
                _undeclared+=("${_rest}")
                warning "  [dependency-scan] undeclared import: ${_rest}"
                ;;
            installed_undeclared)
                _undeclared+=("${_rest}")
                # Present in a vendor directory, absent from the manifest, and imported by a file
                # THIS story changed. It builds here and breaks from a clean checkout — live
                # 2026-08-09 the first story ever committed to a client codeline was undeliverable
                # for exactly this reason, and every gate passed because tsc validates against
                # node_modules, never against what the manifest can reproduce.
                warning "  [dependency-scan] imported but NOT DECLARED (present in a vendor dir only): ${_rest}"
                ;;
            NOTE)
                info "  [dependency-scan] ${_rest}"
                ;;
        esac
    done <<< "$_out"

    # Only when the PROJECT asks for it, and only with the command the PROJECT declares.
    local _auto _install_tpl
    _auto=$(_project_dep_config_value "$project_root" autoInstall)

    # AN IMPORT THE MANIFEST CANNOT REPRODUCE FAILS THE ATTEMPT, AND THE WRITER IS TOLD.
    #
    # This scan warned and returned 0. Live metrolinx AMSD-2041, 2026-08-18: the writer imported
    # @contentstack/live-preview-utils in src/pages/_app.tsx without declaring it. The package sat
    # in node_modules from an earlier run, so the import RESOLVED -- tsc passed, every gate passed,
    # and the branch would have been broken for anyone running a clean install. The scan caught it
    # on all six attempts and package.json was never touched, because the finding went to the
    # terminal and nowhere else: no VERIFICATION_FAILURE for the retry prompt, and no
    # STORY_REJECTION_KEY for the ladder's repeat detector. Same defect as repo-lint, and as the
    # 2026-08-09 incident this file already documents.
    #
    # Deterministic by definition -- the specifier is either in the manifest or it is not.
    #
    # Only when autoInstall will NOT resolve it: a project that installs the package itself is
    # already fixing the problem, and failing it would reject work that is about to become correct.
    if [ ${#_undeclared[@]} -gt 0 ] && [ "$_auto" != "true" ]; then
        local _manifest _specs _first
        _manifest=$(_project_dep_config_value "$project_root" manifestFile)
        [ -n "$_manifest" ] || _manifest="the project manifest"
        _specs=$(printf '  - %s\n' "${_undeclared[@]}")
        _first="${_undeclared[0]%%	*}"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        STORY_REJECTION_KEY="dependency:${_first}"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nYour change imports package(s) that %s does not declare. They resolve here only because a vendor directory happens to contain them, so this builds on this machine and is BROKEN from a clean checkout -- and every type check and test passes either way, which is why nothing else will catch it.\n\n%s\nAdd each one to %s with a version, in the same section its siblings use. Do not remove the import and do not work around it.\n' \
            "$_manifest" "$_specs" "$_manifest")
        error "  [dependency-scan] ${#_undeclared[@]} import(s) not declared in ${_manifest} — the change cannot be reproduced from a clean checkout"
        return 1
    fi

    [ "$_auto" = "true" ] || return 0
    _install_tpl=$(_project_install_command "$project_root")
    [ -n "$_install_tpl" ] || { warning "  [dependency-scan] autoInstall declared but no installCommand — nothing installed"; return 0; }

    local _spec _pkg _cmd _timeout="${EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS:-120}"
    while IFS= read -r _line; do
        case "$_line" in unknown_external*|installed_undeclared*) ;; *) continue ;; esac
        _rest="${_line#*	}"; _spec="${_rest%%	*}"
        _pkg=$("$_node" -e '
          const s = process.argv[1];
          const parts = s.split("/");
          console.log(s.startsWith("@") ? parts.slice(0,2).join("/") : parts[0]);
        ' "$_spec" 2>/dev/null)
        [ -n "$_pkg" ] || continue
        _cmd="${_install_tpl//\{package\}/$_pkg}"
        info "  [dependency-scan] autoInstall declared — installing ${_pkg} (from '${_spec}')"
        # The installer's OWN output is surfaced, not swallowed. Redirecting it to /dev/null
        # hides a failing install behind a one-line summary — the same "a green tick is the only
        # visible outcome" shape this conversion exists to remove.
        #
        # A TIMEOUT IS NOT A FAILURE, and must not read as one. Live: an install against an
        # unreachable registry hung with no timeout at all and consumed a whole story budget.
        # `timeout` reports 124; collapsing that into a generic failure loses the one detail that
        # tells an operator the registry is unreachable rather than the package wrong.
        local _install_rc=0
        ( cd "$project_root" && timeout "$_timeout" bash -c "$_cmd" 2>&1 ) || _install_rc=$?
        if [ "$_install_rc" -eq 124 ]; then
            warning "  [dependency-scan] install of '${_pkg}' TIMED OUT after ${_timeout}s"
        elif [ "$_install_rc" -ne 0 ]; then
            warning "  [dependency-scan] install of '${_pkg}' failed (exit ${_install_rc})"
        fi
    done <<< "$_out"
}

# run_mock_completeness_check <project_root> <output_file>
# Deterministic pre-test gate for the recurring "incomplete vi.mock() factory"
# failure class (live-diagnosed repeatedly for SKY-004: "vi.mock factory for
# SkyscannerClient omits `search` method", "vi.mock factory is incomplete;
# unmocked methods are undefined, handlers throw"). The corresponding
# [Self-Heal] skill note ("mock ALL exported methods or spread real ones via
# vi.importActual") was already present in the system prompt from attempt 1
# and was still violated — prompt-based compliance for this rule is
# effectively zero. This check makes the fact deterministic instead: for
# every `vi.mock('<path>', () => ({ ClassName: vi.fn().mockImplementation(()
# => ({ ...methods... })) }))` factory found in a test file, resolve <path>
# to its real source file, parse the REAL class's public method names (same
# regex as generate_story_contract), and fail fast — before the slow test
# run — if any real method is missing from the mock's method list.
# Returns 0 if every mock factory found is complete (or none found). Returns
# 1 and sets VERIFICATION_FAILURE naming the missing method(s) otherwise.
run_mock_completeness_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local config_file="${project_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/mock-completeness-check.py" "$project_root" "$config_file"
)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA vi.mock() factory is missing method(s) that the real class exports — any test calling a missing method will throw "X is not a function". Add the missing method(s) to the mock before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Mock completeness check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_relative_import_check <project_root> <output_file> [story_id]
# Option D — deterministic detection of a relative import that does not
# resolve to a real file. Root cause this targets: an agent guessing the
# wrong path for a sibling module it can't directly see (recurring live
# failure: './skyscanner-client' guessed, real file at
# './skyscanner/client') — previously only discoverable after a full,
# often multi-minute test run, then re-diagnosed from scratch by the
# failure analyst every single retry. This runs in milliseconds, for free,
# right after the agent's files are written, and suggests the likely
# correct path via filename-token overlap — fully generic, no project- or
# language-specific knowledge (works for .ts/.js relative imports; the
# token-matching heuristic makes no npm/TypeScript-specific assumption).
#
# Auto-apply (added 2026-07-07, opt-in via EPAM_AUTO_FIX_RELATIVE_IMPORTS=true,
# default OFF — preserves the original "detection, not silent rewrite" design
# below unless explicitly enabled): originally this check only ever suggested
# a fix in the retry prompt, on the stated reasoning that auto-rewriting
# "risks breaking a valid but unusual import." That reasoning holds for LOW-
# confidence matches, but a live run showed the SAME violation surviving
# THREE full ladder escalations (base model through the strongest configured
# model) because it's a mechanical habit (appending a redundant .js extension
# in a CommonJS project), not a reasoning-capability gap — no amount of model
# escalation fixes a training-data habit. When enabled, auto-apply is scoped
# conservatively to address the original safety concern: (1) only fires on
# HIGH-confidence matches (token-overlap score >= 2, stricter than the >0
# threshold used for merely suggesting), (2) only rewrites files the CURRENT
# story actually owns (technicalNotes.files, the same boundary scope-guard
# already enforces) — never a file outside this attempt's own scope, (3) only
# replaces the exact broken specifier text, preserving original quote style.
# run_anti_pattern_check <project_root> <output_file> [story_id]
# ─────────────────────────────────────────────────────────────────────────────
# Deterministic, PROJECT-CONFIGURED check for a writer regressing to a
# documented-wrong pattern — no pattern is ever hardcoded here. Rules come
# from ${EPAM_PROJECT_CONFIG_DIR:-}/anti-patterns.json, a JSON array of
# {id, matchPattern, message} objects (matchPattern: a Python regex, DOTALL
# not needed since a negated character class already spans newlines). Absent
# file = silent no-op — most projects configure nothing.
#
# Built 2026-08-02 after a live Writer Retest run, to catch a KNOWN wrong
# pattern deterministically on attempt 1 rather than paying for a downstream
# LLM review to notice it (same shape as run_relative_import_check above).
#
# WHAT THAT ORIGINAL RULE GOT WRONG, recorded so it is not rebuilt: it encoded
# a VENDOR API FACT asserted from memory — that one SDK config key was correct
# and another wrong. Discovery against the INSTALLED package (the
# dependency_contract plugin) later contradicted it: the "wrong" key is the one
# the runtime actually reads, and the "prescribed" key appears nowhere in the
# package, so a writer obeying the rule would have shipped a key that silently
# does nothing. The rule would have blocked the correct implementation on every
# run. See test/unit/orchestration/no-hand-authored-vendor-rules.test.ts.
#
# So: this mechanism is for rules that could have been written BEFORE any
# failure was observed, from the project's standing setup. A claim about what a
# third-party package consumes is DETERMINABLE — discover it, never transcribe
# it here or into a project's anti-patterns.json.
#
# Scoped to the story's OWN declared files (technicalNotes.files) only — same
# scoping lesson as run_relative_import_check's fix, 2026-08-02: a pattern
# that pre-exists in a file this story doesn't own is not this story's to fix
# and must never block it.
#
# Returns 0 if no configured rule matches (or no rules are configured).
# Returns 1 and sets VERIFICATION_FAILURE naming the exact rule violated.
run_anti_pattern_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local rules_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/anti-patterns.json}"
    [ -f "$rules_file" ] || return 0

    local owned_files_json="[]"
    if [ -n "$story_id" ]; then
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/anti-pattern-check.py" "$project_root" "$rules_file" "$owned_files_json"
)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA known, previously-diagnosed wrong pattern was detected — fix this before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Anti-pattern check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# Returns 0 if all relative imports resolve (or all were auto-fixed). Returns
# 1 and sets VERIFICATION_FAILURE with a suggestion for any that remain broken.
run_relative_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_RELATIVE_IMPORTS:-false}"

    # owned_files/has_story_context now resolved UNCONDITIONALLY when a story_id
    # is given (previously gated behind auto_fix=true, so it was only ever
    # computed for auto-fix ELIGIBILITY, never for scoping which findings BLOCK
    # the current story) — same fix already applied to run_named_import_check
    # below, ported here 2026-08-02 after a live Writer Retest run: this check
    # walks the ENTIRE project tree with no scope boundary, so a pre-existing,
    # totally unrelated broken import (src/context/uniformContext.ts importing
    # a nonexistent uniformManifest.json — nothing to do with the story being
    # implemented) blocked AMSD-2041 for 3 straight attempts on a genuinely
    # correct fix (verified: 19/19 tests passing, zero type errors) that this
    # story was structurally incapable of ever "fixing", since it doesn't own
    # that file. The sibling-escalation path below still fires when an owning
    # story can be found, but previously STILL fell through to `return 1`
    # regardless — out-of-scope findings must never block THIS story's turn.
    local owned_files_json="[]"
    local has_story_context="false"
    if [ -n "$story_id" ]; then
        has_story_context="true"
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        # jq exits 0 with EMPTY output (not "[]") when story_id matches no
        # story in the PRD — the `||` above only fires on a non-zero exit, so
        # that case fell straight through as an empty string, which crashes
        # Python's json.loads() downstream. Found live 2026-08-02 testing the
        # relative-import-check port of this same pattern.
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/relative-import-check.py" "$project_root" "$auto_fix" "$owned_files_json" "$has_story_context"
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [relative-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    # Findings in files this story doesn't own are surfaced (visibility) but
    # never block this story's own turn — same pattern as run_named_import_check.
    # A sibling-owning story, if one exists, still gets a REAL escalation file
    # written (resolve_escalation() already knows how to consume it) — that
    # part of the original design has real value — but writing it no longer
    # gates whether THIS story's turn blocks. Previously, EVEN a successfully
    # registered escalation still fell through to `return 1` below regardless,
    # so out-of-scope breakage blocked the current story either way. Root
    # cause this fixes (found live, 2026-08-02, Writer Retest run): a
    # single-story PRD has no sibling to attribute an out-of-scope broken
    # import to, so a totally unrelated, pre-existing broken import
    # (uniformContext.ts -> a nonexistent uniformManifest.json) blocked a
    # genuinely correct AMSD-2041 fix for 3 straight attempts — the ladder was
    # burned on a bug the story could never have fixed, exactly the SAME
    # failure shape the original sibling-escalation code was meant to solve
    # but didn't, because it still blocked regardless of outcome.
    local out_of_scope_lines
    out_of_scope_lines=$(echo "$result" | grep "^OUT_OF_SCOPE:" || true)
    if [ -n "$out_of_scope_lines" ]; then
        while IFS= read -r _oos_line; do
            [ -z "$_oos_line" ] && continue
            warning "  [relative-import-check] Broken import outside this story's scope (not blocking): ${_oos_line#OUT_OF_SCOPE:}"
        done <<< "$out_of_scope_lines"

        if [ -n "$story_id" ]; then
            local _first_oos_file
            _first_oos_file=$(head -1 <<< "$out_of_scope_lines" | sed -E 's/^OUT_OF_SCOPE:([^:]+):.*/\1/')
            if [ -n "$_first_oos_file" ]; then
                # BUG B FIX (found live, 2026-07-12, tier3-travel-app run): this
                # lookup used to scan ALL stories with no deprecated-status
                # filter and take the FIRST array match — a split PARENT marked
                # deprecated (but still carrying its ORIGINAL pre-split combined
                # technicalNotes.files, e.g. SKY-003 listing both cli.ts AND
                # cli.test.ts) commonly appears BEFORE its active child
                # (SKY-003-impl) in the stories array, so the escalation got
                # misattributed to the dead parent instead of the real,
                # already-completed active owner. Exclude deprecated stories,
                # and prefer a same-split sibling (same specification.createdFrom
                # as the current story) over any other match — mirroring the
                # SAME two-tier preference resolve_escalation() already uses
                # when it later consumes this escalation.
                local _self_parent
                _self_parent=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .specification.createdFrom // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                local _owner_id
                _owner_id=$(jq -r --arg self "$story_id" --arg f "$_first_oos_file" --arg parent "$_self_parent" \
                    '[.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any) | select(($parent != "") and .specification.createdFrom == $parent)][0].id
                     // [.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any)][0].id
                     // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                if [ -n "$_owner_id" ]; then
                    local _first_oos_detail
                    _first_oos_detail=$(head -1 <<< "$out_of_scope_lines" | sed 's/^OUT_OF_SCOPE://')
                    mkdir -p "${PROJECT_ROOT}/.epam/escalations"
                    jq -n --arg tf "$_first_oos_file" \
                        --arg diag "Relative import in ${_first_oos_file} does not resolve to a real file (detected by deterministic check while implementing ${story_id})." \
                        --arg fix "$_first_oos_detail" \
                        '{targetFile: $tf, diagnosis: $diag, requiredFix: $fix}' \
                        > "${PROJECT_ROOT}/.epam/escalations/${story_id}.json"
                    log "  [relative-import-check] Broken import lives in ${_first_oos_file}, owned by ${_owner_id} (not ${story_id}) — registered sibling escalation (informational; this story's turn is not blocked by it)"
                fi
            fi
        fi
    fi
    result=$(echo "$result" | grep -v "^OUT_OF_SCOPE:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)

    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA relative import does not resolve to a real file — this will fail immediately when the test suite runs. Fix the import path before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Relative import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_named_import_check <project_root> <output_file> [story_id]
# Deterministic detection (same shape as run_relative_import_check above) of a
# named import whose identifier doesn't actually exist among the target
# file's exports — even though the FILE PATH itself resolves correctly.
#
# Root cause this targets: a live run burned a story's ENTIRE ladder
# escalation (8 attempts, ending on the strongest configured model, $0.25)
# on `import { SkyScannerClient } from './client'` when the real export is
# `SkyscannerClient` (one-character casing difference) — and never converged
# because the failure-analyst MISDIAGNOSED it as a default-vs-named export
# mismatch (it wasn't; the class is correctly a named export, just spelled
# differently). Every retry, including the strongest model, "fixed" the
# wrong thing because the diagnosis guiding it was wrong. A deterministic
# check that names the exact real export (case-insensitive match) removes
# the misdiagnosis risk entirely — no model judgment involved.
#
# Fully generic — no hardcoded class/identifier names, no project-specific
# knowledge. Parses exports via regex (export class/function/const/let/var/
# interface/type/enum Name, and export { A, B as C } lists) and named imports
# via the same import-statement regex as run_relative_import_check, then
# checks each imported identifier is actually in the target's export set.
# Suggests the closest case-insensitive match when one exists (the exact bug
# shape found live), consistent with relative-import-check's "Did you mean
# X?" pattern.
#
# Auto-apply (opt-in via EPAM_AUTO_FIX_NAMED_IMPORTS=true, default OFF, same
# conservative design as relative-import-check's auto-fix): only fires when
# there is EXACTLY ONE case-insensitive match among the target's real
# exports (unambiguous), and only rewrites files the current story owns.
#
# Returns 0 if all named imports resolve to a real export (or none found).
# Returns 1 and sets VERIFICATION_FAILURE with a suggestion otherwise.
run_named_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_NAMED_IMPORTS:-false}"

    # owned_files is now always resolved when a story_id is given (previously
    # gated behind auto_fix=true, so it was only ever computed for auto-fix
    # ELIGIBILITY, never for scoping which findings BLOCK the current story).
    # Root cause this fixes (found live, 2026-07-09/10, tier3-travel-app run):
    # this check walks the ENTIRE project tree, so a pre-existing broken
    # import in a file the CURRENT story doesn't own (e.g. SKY-003-impl's
    # cli.ts importing a type SKY-002-impl's client.ts never exported)
    # permanently blocked an unrelated story (SKY-002-test, which owns only
    # client.test.ts and is scope-guarded from ever touching cli.ts) —
    # exhausting all 8 retries on a bug it was structurally incapable of
    # fixing. has_story_context distinguishes "we know what this story owns,
    # scope blocking to that" from "no story_id given, preserve old global
    # behavior" (e.g. a caller with no per-story context at all).
    local owned_files_json="[]"
    local has_story_context="false"
    if [ -n "$story_id" ]; then
        has_story_context="true"
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        # jq exits 0 with EMPTY output (not "[]") when story_id matches no
        # story in the PRD — the `||` above only fires on a non-zero exit, so
        # that case fell straight through as an empty string, which crashes
        # Python's json.loads() downstream. Found live 2026-08-02 testing the
        # relative-import-check port of this same pattern.
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/named-import-check.py" "$project_root" "$auto_fix" "$owned_files_json" "$has_story_context"
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [named-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    # Findings in files this story doesn't own are surfaced (visibility) but
    # never block this story's own turn — see the Python block's own comment
    # for the live defect this fixes (an unrelated story permanently blocked
    # by a bug it was structurally incapable of fixing).
    local out_of_scope_lines
    out_of_scope_lines=$(echo "$result" | grep "^OUT_OF_SCOPE:" || true)
    if [ -n "$out_of_scope_lines" ]; then
        while IFS= read -r _oos_line; do
            [ -z "$_oos_line" ] && continue
            warning "  [named-import-check] Broken import outside this story's scope (not blocking): ${_oos_line#OUT_OF_SCOPE:}"
        done <<< "$out_of_scope_lines"
    fi
    result=$(echo "$result" | grep -v "^OUT_OF_SCOPE:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA named import does not exist as an export in its target file — this will fail immediately when the test suite runs (the model likely misspelled/mis-cased an identifier, not a default-vs-named export issue). Fix the identifier name before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Named import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

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
run_external_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    VERIFICATION_FAILURE=""
    DETERMINISTIC_CHECK_FAILURE=0

    # Vendor-dir integrity check runs FIRST, before anything else in this
    # function (including run_dependency_check's own sanctioned writes to the
    # same directories) — so it only ever attributes a change to THIS story's
    # own agent turn, never to a later legitimate install. Runs regardless of
    # whether a test command is configured (tampering here could poison a
    # LATER story sharing the same vendor dirs even if this story has no
    # tests of its own). No-op when no vendorDirs are configured.
    #
    # BUG (caught before ever shipping live, 2026-07-07 — found by re-reading
    # the code under scrutiny, not by a live run): the original version
    # returned 1 on tampering BEFORE calling _vendor_unlock, meaning the vendor
    # dirs would stay chmod -R a-w'd (read-only) PERMANENTLY the very first
    # time tampering was ever caught — breaking every subsequent retry's own
    # legitimate run_dependency_check installs, and every later story in the
    # whole run, since nothing else ever unlocks it. Fixed: unlock ALWAYS runs
    # regardless of the check's result; only the return code differs.
    local _vendor_check_rc=0
    if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
        run_vendor_integrity_check "$PROJECT_ROOT" "$output_file" || _vendor_check_rc=1
    fi
    _vendor_unlock "$PROJECT_ROOT"
    if [ "$_vendor_check_rc" -ne 0 ]; then
        warning "  [vendor-guard] Vendor directory tampering detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Run any reviewed dynamic tools now, in this genuinely unlocked window —
    # see run_dynamic_tools_in_unlocked_window()'s own docstring for the
    # live defect this fixes (a dependency-installing dynamic tool could
    # never succeed while the agent's own turn held vendor dirs locked).
    run_dynamic_tools_in_unlocked_window "$PROJECT_ROOT" "$output_file"

    # Read optional testCommand from PRD story.technicalNotes
    local test_cmd
    test_cmd=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.testCommand // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # THE PROJECT DECLARES HOW IT RUNS ITS SUITE. The engine asks; it does not know.
    #
    # This block used to hardcode four ecosystem facts — a manifest filename, a key inside it,
    # a command, and a test-file naming convention — in engine code, where hardcoding is not
    # permitted. They now live in the project's own .epam/verification.json `test` section and
    # are read by orchestrations/plugins/verification-plugin.js.
    #
    # THE GUARD THAT USED TO LIVE HERE ASKED THE WRONG QUESTION. It required the STORY to own a
    # test file. It was added 2026-07-08 for SKY-001A, a scaffold story whose only job was
    # writing a manifest: running the suite then failed because no test files existed ANYWHERE
    # yet, the analyst misdiagnosed "missing test files", tried to create one, and the
    # scope-guard blocked the write — a guaranteed infinite loop. That state is real and is
    # still skipped, via repoHasTests.
    #
    # But a BROWNFIELD story modifying existing code declares source files, never test files,
    # so `_owns_test_file` was 0 by definition. Live 2026-08-11 (AMSD-2041/gotransit): the
    # command stayed empty, the function returned 0 = PASS, and the writer was told its change
    # passed the tests. Nothing had run. It had added an import of a package shipping
    # untranspiled sources, and ten previously-green suites failed at import time — invisible to
    # all 8 retry attempts. "This repo has no tests" and "this story declares no test file" are
    # different states; only the first justifies skipping.
    if [ -z "$test_cmd" ]; then
        local _repo_has_tests
        _repo_has_tests=$(_project_repo_has_tests "$PROJECT_ROOT")
        # unknown (no declared convention) is NOT "no tests" — it must not silently skip.
        if [ "$_repo_has_tests" = "false" ]; then
            info "  [test-gate] the project declares a suite but this repo contains no test files — skipping"
            return 0
        fi
        if [ "$_repo_has_tests" = "unknown" ]; then
            warning "  [test-gate] this project declares no test-file convention in .epam/verification.json — the suite cannot be scoped or skipped safely"
        fi
        local _declared_test_cmd
        _declared_test_cmd=$(_project_test_command "$PROJECT_ROOT")
        if [ -n "$_declared_test_cmd" ]; then
            test_cmd="$_declared_test_cmd"
        fi
    fi
    # SCOPE THE RUN TO THIS STORY'S OWN TEST FILES, when the project says how.
    #
    # A broken test file belonging to ANOTHER story used to fail this story's verification (live:
    # a broken cli.test.ts failed the server story while server.test.ts passed 15/15). Running
    # only the files this story owns removes that contamination.
    #
    # Both halves are project declarations now: which paths ARE test files (test.testFilePattern)
    # and how this runner accepts a file list (test.scopedCommand, e.g. "npm test -- {files}").
    # A project that declares neither runs its whole suite, which is correct and never silent.
    if [ -n "$test_cmd" ]; then
        local _owned_test_files
        _owned_test_files=$(_project_owned_test_files "$PROJECT_ROOT" "$story_id" "$prd_target")
        if [ -n "$_owned_test_files" ]; then
            local _scoped
            _scoped=$(_project_scoped_test_command "$PROJECT_ROOT" "$_owned_test_files")
            [ -n "$_scoped" ] && test_cmd="$_scoped"
        fi
    fi

    [ -z "$test_cmd" ] && return 0  # no test command configured — skip

    # Exposed for run_failure_analyst's tool_creation gate (added 2026-07-12):
    # a dynamic tool that independently re-invokes this SAME test command is a
    # duplicate-verification risk, not a mechanical fixup — see that check for
    # the live incident this closes.
    LAST_TEST_CMD="$test_cmd"
    export LAST_TEST_CMD

    # Sanitize the child-process environment for npm install/test (added
    # 2026-07-11, after a live test failure no amount of model escalation
    # could ever fix): claude.sh inherits the orchestrator's OWN .env
    # (Anthropic/OpenRouter/MiniMax keys, etc — sourced by
    # run-agent-orchestration.sh) all the way down to whatever test command
    # runs INSIDE the generated app. Root cause found live: epam-cli's own
    # .env happens to define RAPIDAPI_KEY (a real credential) — the exact
    # env var name a generated SkyscannerClient story checked as a
    # constructor fallback. Every retry of its "should throw when no API key
    # provided" test failed identically because the constructor legitimately
    # found a REAL key in the inherited environment and didn't throw — the
    # generated app's code was correct the entire time; the test's
    # environment was contaminated by a secret that belongs to the
    # ORCHESTRATOR, not the app under test. No model escalation or skill
    # guidance can ever fix a test that's structurally unwinnable this way.
    # Strip every var name defined in the orchestrator's own .env from the
    # install/test subprocess environment so the generated app is tested in
    # real isolation.
    #
    # Deliberately uses bash's own `unset` builtin, NOT `env -u` — this
    # environment's PATH shadows the real GNU coreutils `env` with an
    # unrelated PATH-setup shell shim at ~/.local/bin/env that doesn't
    # implement `-u` (confirmed live: `env -u FOO bash -c '...'` silently
    # produced none of the command's effects). A prefixed `unset` string has
    # no dependency on any external binary and can't be shadowed this way.
    local _orch_env_file
    _orch_env_file="$(dirname "$AUTOMATION_DIR")/.env"
    local _orch_env_unset_prefix=""
    if [ -f "$_orch_env_file" ]; then
        while IFS='=' read -r _envkey _envval; do
            [[ "$_envkey" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
            _orch_env_unset_prefix="${_orch_env_unset_prefix}unset ${_envkey}; "
        done < <(grep -v '^[[:space:]]*#' "$_orch_env_file" | grep -v '^[[:space:]]*$')
    fi

    # Scope guard: restore .ts files outside this story's declared scope from
    # the pre-run snapshot. Agents frequently use Bash (not WriteFile) to write
    # files, bypassing tool-level guards. This restores them before npm test so
    # a story's verification only reflects the files it actually owns.
    local _sg_backup="${SCOPE_GUARD_BACKUP_DIR:-}"
    if [ -n "$_sg_backup" ] && [ -d "$_sg_backup" ]; then
        # Build declared set (absolute paths)
        local -A _sg_decl
        while IFS= read -r _f; do
            [ -n "$_f" ] && _sg_decl["$_f"]=1
        done < <(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
            "$prd_target" 2>/dev/null)

        if [ ${#_sg_decl[@]} -gt 0 ]; then
            local _sg_restored=0
            while IFS= read -r _rel; do
                local _abs="$PROJECT_ROOT/$_rel"
                # Skip if this file is in the story's declared scope
                [ -n "${_sg_decl[$_abs]+x}" ] && continue
                local _bak="$_sg_backup/$_rel"
                if [ -f "$_bak" ]; then
                    cp "$_bak" "$_abs" 2>/dev/null && ((_sg_restored++))
                fi
            done < <(find "$_sg_backup" -type f | sed "s|^$_sg_backup/||")
            if [ "$_sg_restored" -gt 0 ]; then
                warning "  [scope-guard] Restored $_sg_restored out-of-scope .ts file(s) before verification (agent wrote outside ${story_id}'s declared scope)"
            fi
        fi
    fi

    # Ensure node_modules exist in the worktree — git worktrees don't inherit gitignored dirs.
    # Without this, npm test fails with exit 127 (vitest binary not found).
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the entire claude.sh subprocess with the LAST log line
    # being "Installing dependencies..." — the actual agent call had already
    # finished in 11s (confirmed via the per-story result.json timestamp),
    # but this npm install (registry/network dependent, no timeout) silently
    # consumed the rest of the 600s budget with zero further signal. Same
    # class of bug as the npm test / git-operation hangs fixed earlier this
    # session — this was the third unbounded external command, missed then.
    # WHICH manifest, WHICH vendor directory, and WHICH install command are PROJECT facts.
    # They were three ecosystem literals in engine code; the project already declares all three
    # in .epam/dependency-check.json (manifestFile / vendorDirs / installCommand), which is the
    # same file _get_vendor_dirs() and the dependency plugin read. A project that declares none
    # of them provisions nothing here rather than having an ecosystem guessed for it.
    local _dep_manifest _dep_vendor _dep_install
    _dep_manifest=$(_project_manifest_file "$PROJECT_ROOT")
    _dep_vendor=$(_get_vendor_dirs "$PROJECT_ROOT" 2>/dev/null | head -1)
    _dep_install=$(_project_install_command "$PROJECT_ROOT")
    if [ -n "$_dep_manifest" ] && [ -n "$_dep_vendor" ] && [ -n "$_dep_install" ] \
       && [ -f "$PROJECT_ROOT/$_dep_manifest" ] && [ ! -d "$PROJECT_ROOT/$_dep_vendor" ]; then
        log "  Installing dependencies ($_dep_vendor missing in worktree)..."
        local _install_timeout="${EPAM_INSTALL_TIMEOUT_SECS:-180}"
        # Capture $? directly from the command substitution — NOT via
        # `if ! (cmd); then`, which collapses any non-zero exit code (124
        # included) into a plain boolean 1 through the `!` negation, making
        # exit 124 indistinguishable from a normal failure (this exact bug
        # shipped in the first version of this fix and was caught by its own
        # test suite: the TIMED OUT branch never fired).
        local _install_output
        # {package} is the placeholder the project's own installCommand uses for a single
        # package; a bare provisioning install substitutes it away.
        local _dep_install_all="${_dep_install//\{package\}/}"
        _install_output=$(cd "$PROJECT_ROOT" && timeout "$_install_timeout" bash -c "${_orch_env_unset_prefix}${_dep_install_all}" 2>&1)
        local _install_rc=$?
        if [ "$_install_rc" -eq 124 ]; then
            warning "  dependency install TIMED OUT after ${_install_timeout}s — test may still fail"
        elif [ "$_install_rc" -ne 0 ]; then
            warning "  dependency install failed — test may still fail"
        fi
    fi

    # THE VERDICT IS READ. Both of these were called bare until 2026-08-19, so their `return 1`
    # was discarded: they set VERIFICATION_FAILURE and DETERMINISTIC_CHECK_FAILURE (which is why
    # their findings still reached the retry prompt) and then verification carried on to the test
    # suite and could return 0. Live AMSD-2041: lockfile-sync blocked FOUR times and the story
    # completed anyway, with a manifest the lockfile does not resolve. The four sibling checks
    # below have always been guarded; these two were the exception.
    #
    # Each check sets the failure text and the flag itself, so the caller only reads the verdict.
    if ! run_dependency_check "$PROJECT_ROOT"; then
        return 1
    fi
    if ! run_lockfile_sync_check "$PROJECT_ROOT"; then
        return 1
    fi

    # Fail fast on a broken relative import BEFORE running the (often
    # multi-minute) test command — this recurring failure class was
    # previously only discoverable by waiting for a full test run, then
    # having the failure analyst re-diagnose the same "wrong import path"
    # pattern from scratch every retry (validated live: baseline model call
    # guessed './skyscanner-client' when the real file was
    # './skyscanner/client'). Skip test execution entirely if found.
    if ! run_relative_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [relative-import-check] Broken import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on a named import whose identifier doesn't exist in its
    # target's exports — same rationale as relative-import-check above, but
    # for a different failure shape (file path resolves fine, the imported
    # NAME is wrong/mis-cased). Root cause: a live run burned a story's
    # entire ladder escalation on this exact bug because the failure-analyst
    # misdiagnosed it as a default-vs-named export mismatch.
    if ! run_named_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [named-import-check] Non-existent named import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on a project-configured anti-pattern (e.g. a documented-wrong
    # value a prior review already caught) — see run_anti_pattern_check's own
    # docstring. Silent no-op for any project with no anti-patterns.json.
    if ! run_anti_pattern_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [anti-pattern-check] Known wrong pattern detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on an incomplete vi.mock() factory BEFORE running the test
    # command — same rationale as relative-import-check above, targeting the
    # other recurring live failure class (mock factory missing a real method,
    # e.g. SKY-004's SkyscannerClient mock omitting `search`).
    if ! run_mock_completeness_check "$PROJECT_ROOT" "$output_file"; then
        warning "  [mock-completeness-check] Incomplete vi.mock() factory detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    log "  Running external verification: $test_cmd"
    local test_output
    local test_exit=0
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the ENTIRE claude.sh subprocess with zero diagnostic
    # output after this exact command hung — the story's own implementation
    # had already succeeded; `npm test` (vitest) itself never returned. The
    # classic cause for a server story: a test calls app.listen() without a
    # matching server.close() in afterAll, so Node's event loop never drains
    # and the test process hangs forever. Without a bound here, that failure
    # mode silently consumes the entire watchdog budget with no signal at all
    # about which command was actually stuck. EPAM_TEST_TIMEOUT_SECS default
    # (300s) is comfortably under the lowest story-level watchdog ceiling
    # (600s for low-effort stories) so this always fires first and gives a
    # clear, actionable diagnosis instead of a generic outer timeout.
    local _test_timeout="${EPAM_TEST_TIMEOUT_SECS:-300}"
    test_output=$(cd "$PROJECT_ROOT" && timeout "$_test_timeout" bash -c "${_orch_env_unset_prefix}${test_cmd}" 2>&1) || test_exit=$?

    if [ "$test_exit" -eq 124 ]; then
        warning "External verification TIMED OUT for $story_id after ${_test_timeout}s (test command: $test_cmd)"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure — TIMEOUT\n\nThe orchestrator ran `%s` after your files were written and it did NOT complete within %ds — it hung. The most common cause for a server story: a test calls app.listen() (or an equivalent server-start call) without closing it (server.close()) in an afterAll/afterEach hook, so the test process never exits. Check every test that starts a server or opens a long-lived resource (timers, sockets, watchers) and ensure it is torn down.\n\n```\n%s\n```\n' \
            "$test_cmd" "$_test_timeout" "$test_output")
        {
            echo ""
            echo "=== External verification TIMED OUT after ${_test_timeout}s ==="
            echo "$test_output" | head -n "$(evidence_window testOutputLines)"
        } >> "$output_file"
        return 1
    fi

    if [ "$test_exit" -ne 0 ]; then
        warning "External verification failed for $story_id (exit $test_exit)"

        # A BROWNFIELD STORY CANNOT BE FAILED FOR TESTS IT DID NOT BREAK.
        #
        # Operator policy: "For brownfield we can inherit existing test failures, but we
        # cannot be expected to fix them." The type-check path has implemented that for a
        # while — run the check, run it again at the baseline SHA, subtract by IDENTITY, pass
        # when everything left is pre-existing. This path did not: a raw non-zero exit failed
        # the story, so ONE pre-existing failing test failed it on every attempt, forever,
        # while the message below told the writer to "fix the code so the tests pass".
        # An unwinnable gate, the same shape as the changeRequired one that cost three runs.
        #
        # Live 2026-08-12, the analyst diagnosed it in plain text and the story failed anyway:
        # "Failing tests are pre-existing — schedules.spec.tsx fails identically with and
        # without agent changes."
        #
        # The already-captured output is handed in rather than re-run: this executes per
        # ATTEMPT, up to 8 times a story, and the suite is the most expensive gate in the run.
        local _new_test_failures="$test_output"
        if command -v baseline_new_failures >/dev/null 2>&1; then
            local _test_out_file _tdelta_rc=0 _tdelta_out
            _test_out_file=$(mktemp)
            printf '%s' "$test_output" > "$_test_out_file"
            _tdelta_out=$(baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                "$LOG_DIR" test "$_test_out_file") || _tdelta_rc=$?
            rm -f "$_test_out_file"
            [ "$_tdelta_rc" -eq 0 ] && _new_test_failures="" || _new_test_failures="$_tdelta_out"
        fi

        # EVERY FAILURE WAS PRE-EXISTING — the story passes. That is the whole purpose of the
        # baseline diff, and the policy it implements: inherit what the codeline already had,
        # never add to it. The tsc path lost precisely this guard once and an empty delta fell
        # through to the failure branch, reporting errors with an EMPTY error list.
        if [ -z "$(echo "$_new_test_failures" | tr -d '[:space:]')" ]; then
            success "External verification for $story_id: only pre-existing baseline test failures — none introduced by this story"
            return 0
        fi

        # Include both the head AND tail of test output so errors that appear at
        # the end (e.g. "Unhandled Rejection" summaries emitted after per-test
        # results) reach the failure analyst — a head-only truncation causes
        # misdiagnosis when the real root cause is in the final lines
        # (found live: analyst diagnosed "missing env var" from truncated head
        # while the real cause — async main() rejection — was in the tail).
        # The writer is shown the NEW failures, not the whole suite. Handing it every
        # pre-existing failure as if it were its own is how an attempt gets sent chasing
        # breakage it did not cause — and the instruction below now says so explicitly.
        # WHOLE, never head+tail. The middle of a failure dump is where the first
        # error usually is; cutting it out and printing "[... output truncated ...]"
        # told the writer something was missing without telling it what.
        # BOUND WHAT THE ANALYST IS HANDED, ON ENTRY BOUNDARIES.
        #
        # This text is embedded whole into the FailureAnalyst prompt. It is the new-failure delta,
        # which is small when the baseline builds — and the ENTIRE suite output when it does not.
        # Live 2026-09-02 (AMSD-1919) it reached ~1,092,054 tokens against a 1,000,000 limit, so
        # every analyst call failed on SIZE and the ladder escalated claude-sonnet-5 ->
        # claude-opus-4-8 -> claude-opus-5 against an input no model could accept.
        #
        # The window is declared (config/evidence-windows.json: failureExcerptLines) and entries are
        # dropped WHOLE, per the project's own failurePattern. A half-failure tells the analyst
        # something is wrong without telling it what.
        local _test_head
        _test_head=$(printf '%s' "$_new_test_failures" \
            | "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/bound-failures.js" "$PROJECT_ROOT" test 2>/dev/null) \
            || _test_head="$_new_test_failures"
        [ -n "$_test_head" ] || _test_head="$_new_test_failures"
        local _test_tail=""
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran `%s` after your files were written and it failed (exit code %d). The failures below are the ones YOUR CHANGES INTRODUCED — failures the codeline already had have been subtracted and are not your responsibility. Fix these.\n\n```\n%s%s\n```\n' \
            "$test_cmd" "$test_exit" "$_test_head" "$_test_tail")
        {
            echo ""
            echo "=== External verification failed (exit $test_exit) ==="
            echo "$test_output" | head -n "$(evidence_window testOutputLines)"
        } >> "$output_file"
        return 1
    fi

    success "External verification passed for $story_id"
    return 0
}

# _attempt_change_summary <story_id> [baseline_ref]
#
# WHAT THE LAST ATTEMPT ACTUALLY DID — the one piece of evidence neither the writer nor the
# failure analyst has ever been given.
#
# The writer is told what is WRONG (reviewer blockers, verification failures, prior-run lessons)
# and never what it DID, so it cannot tell "I tried this and it was rejected" from "I have not
# tried anything", and re-derives an approach it has already been told is wrong. The analyst is
# asked why an implementation failed while being shown no implementation — live 2026-08-12 it
# answered "Target=none — Transient import slip", a fair reading of the text it had and useless
# as guidance, and its answer escalates the model.
#
# COMPUTED, NOT ASKED FOR. Plain git against the story's own baseline. No agent, no judgement,
# no summarisation: a model between a machine fact and the agent acting on it destroys
# provenance, and this reviewer has already approved a change while misstating the diff.
#
# ONE SOURCE, TWO CONSUMERS — the writer's retry prompt and the analyst's evidence read the same
# text. Two pipelines is how they drifted into being fed differently in the first place.
_attempt_change_summary() {
    local _story_id="${1:-}"
    local _ref="${2:-$(_resolved_baseline_ref)}"
    local _stat=""

    if [ -d "$PROJECT_ROOT/.git" ] && git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1; then
        # Committed work on the branch plus anything still in the tree: an attempt that
        # committed and an attempt that did not are both "what it did".
        # Untracked files are NOT in `diff --stat`, and a brand-new file is the most common
        # shape of "what the attempt did" — omitting them reports a real attempt as empty.
        local _untracked
        _untracked=$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null | head -40)
        _stat=$( { git -C "$PROJECT_ROOT" diff --stat "$_ref" 2>/dev/null
                   git -C "$PROJECT_ROOT" diff --stat --cached 2>/dev/null
                   if [ -n "$_untracked" ]; then
                       printf '%s\n' "$_untracked" | while IFS= read -r _u; do
                           [ -n "$_u" ] || continue
                           printf ' %s | new file\n' "$_u"
                       done
                   fi; } | grep -vE '^[[:space:]]*$' | head -n "$(evidence_window changedFileLines)" )
    fi

    if [ -z "$(printf '%s' "$_stat" | tr -d '[:space:]')" ]; then
        # THE MOST IMPORTANT CASE. An empty summary reads as "no information", and the next
        # attempt then behaves as though it were the first. Say it plainly instead.
        printf 'The previous attempt changed NO files — nothing was written. Treat this as an attempt that produced nothing, not as a fresh start.\n'
        return 0
    fi

    printf 'The previous attempt changed these files (diffstat against %s):\n\n%s\n' "$_ref" "$_stat"
    return 0
}

# run_repo_lint_verification <story_id> <output_file>
#
# THE REPO'S OWN LINT, RUN BEFORE THE COMMIT INSTEAD OF AFTER IT.
#
# Live 2026-08-09, AMSD-2041 on gotransit: the writer produced correct code, the project type check passed,
# and then the commit fired the repo's husky pre-commit hook. eslint reported ONE unused constant.
# lint-staged reverts the working tree when a task fails, so that single violation destroyed the
# whole attempt; the loop reset the worktree to origin/develop ("no validated state to preserve")
# and started over, and would have hit the identical wall on all 8 attempts because nothing ever
# told the writer the rule existed.
#
# We already run eslint — at Step 20, AFTER the per-story commit at Step 8/9. So it only ever
# examines work that committed successfully, and never runs for the story that cannot commit.
# Here the failure is feedback the retry loop can act on rather than a destructive commit failure.
#
# SCOPE IS THE CHANGED FILES. That is exactly what lint-staged lints, so this reproduces the
# hook's verdict. Linting the whole tree would fail every story in any brownfield repo carrying
# pre-existing violations in files no story touched — the trap run_tsc_verification had to escape
# with baseline diffing.
#
# Runs only where the repo ENFORCES lint at commit time. A repo with no pre-commit hook is held
# to its own standard, not ours.
# THE DECLARED-LINT PATH -- for a codeline whose linter is not eslint.
#
# Separate from run_repo_lint_verification on purpose: the eslint path below it resolves its files
# through lint-staged routing and an eslint --print-config probe, both of which are questions only
# eslint can answer. This one asks the codeline which of its changed files are source, runs the
# command the codeline declares, and reads the exit status.
#
# 127 -- the declared command cannot be run here -- is a FAILURE of a project that lints, never the
# same thing as a project that does not lint. The old probe could not express that difference.
_run_declared_lint_gate() {
    local story_id="$1" output_file="${2:-/dev/null}" _cmd="$3"
    local _dl_changed _dl_testable="" _dl_files=() _dl_f

    _dl_changed=$( { git -C "$PROJECT_ROOT" diff --name-only --diff-filter=d 2>/dev/null
                     git -C "$PROJECT_ROOT" diff --cached --name-only --diff-filter=d 2>/dev/null
                     git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null; } \
                   | sort -u | engine_paths_filter)
    if [ -n "$_dl_changed" ]; then
        # shellcheck disable=SC2086
        _dl_testable=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/testable-source.js" \
            "$PROJECT_ROOT" $_dl_changed 2>/dev/null || echo "")
    fi
    while IFS= read -r _dl_f; do
        [ -n "$_dl_f" ] || continue
        [ -f "$PROJECT_ROOT/$_dl_f" ] || continue
        _dl_files+=("$_dl_f")
    done <<< "$_dl_testable"

    if [ ${#_dl_files[@]} -eq 0 ]; then
        log "  [repo-lint] $story_id: no changed file is source this codeline declares — nothing was linted"
        return 0
    fi

    local _dl_out _dl_rc=0
    # The project DECLARES its command as a string, so running it means eval. The file list after it
    # is a quoted array, which is the part that must not be re-split.
    # shellcheck disable=SC2294
    _dl_out=$(cd "$PROJECT_ROOT" && eval "$_cmd" "${_dl_files[@]}" 2>&1) || _dl_rc=$?

    if [ "$_dl_rc" -eq 127 ]; then
        error "  [repo-lint] $story_id: this codeline declares [$_cmd] and it could not be run — lint NOT PERFORMED"
        printf '%s\n' "$_dl_out" | head -10 >&2
        return 1
    fi
    if [ "$_dl_rc" -eq 0 ]; then
        success "  [repo-lint] $story_id: the repository lint [$_cmd] accepts ${#_dl_files[@]} changed file(s)"
        return 0
    fi

    error "  [repo-lint] $story_id: the repository lint [$_cmd] rejects ${#_dl_files[@]} changed file(s) —"
    error "  [repo-lint]   the pre-commit hook will refuse this commit and may REVERT the work."
    printf '%s\n' "$_dl_out" | head -40 >&2

    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    STORY_REJECTION_KEY="lint:${story_id}"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe repository lints with `%s` and it rejects your change:\n\n```\n%s\n```\n\nFix these before the change can be committed.\n' \
        "$_cmd" "$(printf '%s' "$_dl_out" | head -n "$(evidence_window lintOutputLines)")")
    export VERIFICATION_FAILURE
    printf '%s\n' "$_dl_out" >> "$output_file" 2>/dev/null || true
    return 1
}

run_repo_lint_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    is_truthy "${SKIP_STORY_LINT_GATE:-}" && return 0
    [ -d "$PROJECT_ROOT/.git" ] || return 0

    # Does this repo check anything at commit time? Honour core.hooksPath (husky v9 sets it),
    # then the husky default, then the stock hook location.
    local _hook="" _hooks_path
    _hooks_path=$(git -C "$PROJECT_ROOT" config --get core.hooksPath 2>/dev/null)
    for _candidate in \
        ${_hooks_path:+"$PROJECT_ROOT/$_hooks_path/pre-commit"} \
        "$PROJECT_ROOT/.husky/pre-commit" \
        "$PROJECT_ROOT/.git/hooks/pre-commit"; do
        [ -f "$_candidate" ] && { _hook="$_candidate"; break; }
    done
    # AN ABSENT CHECK IS NOT A PASS. These three exits used to be silent `return 0`s, so
    # "lint could not run" was indistinguishable from "lint found nothing" — the same fail-open
    # shape as every other defect in this pipeline. The story is not failed for them (the writer
    # cannot install a hook or a linter), but the run says so out loud.
    if [ -z "$_hook" ]; then
        warning "  [repo-lint] $story_id: no pre-commit hook in $PROJECT_ROOT — lint was NOT run; nothing here proves the change is clean"
        return 0
    fi

    # WHAT THIS CODELINE LINTS WITH, ASKED OF THE CODELINE FIRST.
    #
    # This probed for eslint and nothing else. On a codeline that lints with biome, oxlint, ruff or
    # a Makefile target it found none, said in its own words that nothing proved the change clean,
    # and returned 0 -- the only one of this engine's seventeen delivery-contract gates that was
    # coupled to a stack.
    #
    # .epam/verification.json already declares typecheck and test; lint is the third of the same
    # shape, detected by the plugin that owns detection. The eslint probe below is KEPT as the
    # fallback, so every repo that lints with eslint behaves exactly as before -- including the
    # lint-staged routing and the --print-config coverage probe, which are questions only eslint
    # can answer.
    local _declared_lint=""
    _declared_lint=$("${NODE_BIN:-node}" -e '
      const fs = require("fs"), path = require("path");
      let cmd = "";
      try {
        const j = JSON.parse(fs.readFileSync(path.join(process.argv[2], ".epam", "verification.json"), "utf8"));
        cmd = ((j.lint || {}).command) || "";
      } catch (e) { /* not declared on disk */ }
      if (!cmd) {
        try {
          const p = require(process.argv[1]);
          cmd = (((p.detectLint(process.argv[2]) || {}).lint) || {}).command || "";
        } catch (e) { cmd = ""; }
      }
      process.stdout.write(cmd);
    ' "${AUTOMATION_DIR:-$(dirname "$SCRIPT_DIR")}/plugins/verification-plugin.js" "$PROJECT_ROOT" 2>/dev/null || echo "")

    local _eslint_bin=""
    for _candidate in "$PROJECT_ROOT/node_modules/.bin/eslint" "$(command -v eslint 2>/dev/null)"; do
        [ -x "$_candidate" ] && { _eslint_bin="$_candidate"; break; }
    done
    if [ -z "$_eslint_bin" ] && [ -n "$_declared_lint" ]; then
        _run_declared_lint_gate "$story_id" "$output_file" "$_declared_lint"
        return $?
    fi
    if [ -z "$_eslint_bin" ]; then
        warning "  [repo-lint] $story_id: no eslint binary in $PROJECT_ROOT or on PATH — lint was NOT run; nothing here proves the change is clean"
        return 0
    fi

    # Changed = modified/added tracked files plus untracked ones, which is the set that will be
    # staged — minus anything the ENGINE owns. Live next.gotransit.com carries untracked
    # .epam/settings.json and .epam/codeline-facts.json which are NOT gitignored and which
    # eslint's flat config happily accepts, so without this filter the gate fails stories over
    # the engine's own state — work the writer neither produced nor can fix. engine_paths_filter
    # is the same single definition the commit seam uses (lib/engine-paths.sh); the list is not
    # restated here, because restating it is how this rule already drifted three ways. Extensions come from what the repo's own eslint will accept, probed below, so no
    # list is baked in here.
    local _changed
    _changed=$( { git -C "$PROJECT_ROOT" diff --name-only --diff-filter=d 2>/dev/null
                  git -C "$PROJECT_ROOT" diff --cached --name-only --diff-filter=d 2>/dev/null
                  git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null; } \
                | sort -u | engine_paths_filter)
    if [ -z "$_changed" ]; then
        # Genuinely nothing to lint. Distinct from the two above: the check RAN and had no
        # subject, rather than being unable to run.
        log "  [repo-lint] $story_id: no changed files to lint"
        return 0
    fi

    # WHICH of the changed files does the hook actually send to this linter?
    #
    # This used to ask the linter `--print-config <file>`: "do you have a configuration for this
    # path". Under a flat config the answer is yes for ANY path, including data files. Live
    # 2026-08-10 that fed package.json and package-lock.json to eslint, which parsed them as
    # source and produced `1:1 Expected an assignment or function call`, and the gate failed the
    # story claiming the pre-commit hook would revert the work. The repository's own routing sends
    # those files to a formatter and never to the linter, so the hook would have passed them.
    # A gate stricter than the hook it claims to reproduce blocks work nobody can fix.
    #
    # The routing is a REPOSITORY fact, so it is read from the repository — including with the
    # repository's own matcher, so glob semantics are identical to the hook's by construction.
    # No extension, language or tool name is named here; the linter's own basename is passed in.
    local _scoped _scope_rc=0
    _scoped=$(printf '%s\n' "$_changed" | "${NODE_BIN:-node}" \
        "$SCRIPT_DIR/lib/lint-staged-scope.js" "$PROJECT_ROOT" "$(basename "$_eslint_bin")" 2>/dev/null) || _scope_rc=$?

    local _files=() _f
    if [ "$_scope_rc" -eq 0 ]; then
        # The repo answered. An EMPTY answer is a real answer — "the hook lints none of these" —
        # and must not fall through to linting everything, which is the defect being fixed.
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            [ -f "$PROJECT_ROOT/$_f" ] || continue
            _files+=("$_f")
        done <<< "$_scoped"
    else
        # UNKNOWN: no declaration, unreadable declaration, or no matcher. Fall back to the previous
        # selection rather than to "lint nothing" — a repo that routes by some other mechanism is
        # still held to its own standard, and silently disabling the gate would be a worse failure
        # than the over-inclusion it replaces.
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            [ -f "$PROJECT_ROOT/$_f" ] || continue
            (cd "$PROJECT_ROOT" && "$_eslint_bin" --print-config "$_f" >/dev/null 2>&1) || continue
            _files+=("$_f")
        done <<< "$_changed"
    fi
    # Same principle as the pass below: a run that examined NOTHING must not read as a clean lint.
    # Changed files existed, but none survived the project's own `eslint --print-config` filter.
    if [ ${#_files[@]} -eq 0 ]; then
        log "  [repo-lint] $story_id: no changed file is covered by this project's eslint config — nothing was linted"
        return 0
    fi

    local _lint_output _lint_exit=0
    _lint_output=$(cd "$PROJECT_ROOT" && "$_eslint_bin" "${_files[@]}" 2>&1) || _lint_exit=$?
    # A PASS SAYS SO. The three absent-check exits above were made loud under the comment "AN
    # ABSENT CHECK IS NOT A PASS" — and this, the PASS itself, was left silent. So of the gate's
    # outcomes only two of three were legible: failure loud, absence loud, success mute. A run
    # where lint passed produced ZERO repo-lint lines and was therefore indistinguishable from a
    # run where the gate never executed.
    #
    # Live 2026-08-19: a whole metrolinx writer run emitted no repo-lint output. It was read as
    # "the gate never ran", which produced a false suppression hypothesis, hours of investigation,
    # and an open defect reported to the operator that did not exist. Lint had run and passed.
    if [ "$_lint_exit" -eq 0 ]; then
        success "  [repo-lint] $story_id: the repository's own lint accepts ${#_files[@]} changed file(s)"
        return 0
    fi

    error "  [repo-lint] $story_id: the repository's own eslint rejects ${#_files[@]} changed file(s) —"
    error "  [repo-lint]   the pre-commit hook will refuse this commit and lint-staged will REVERT the work."
    printf '%s\n' "$_lint_output" | head -n "$(evidence_window lintOutputLines)" >&2

    # THE CHANNEL THE WRITER ACTUALLY READS.
    #
    # VERIFICATION_FAILURE is what the failure analyst consumes and turns into
    # COORDINATOR_PROMPT_AMENDMENT — the text the next attempt sees. Every other gate in this
    # file sets it. This one only appended to $output_file, the agent's OUTPUT log, which
    # nothing reads back, so the gate fired correctly and the writer never learned why:
    #
    #   [repo-lint] AMSD-2041: the repository's own eslint rejects 5 changed file(s)
    #
    # and the next attempt produced the same rejected code. Worse, the analyst still ran, and
    # with no failure text of its own it diagnosed from stale evidence — 'tsc incremental cache
    # is stale' about the very constant lint was rejecting — twice, which is what tripped
    # [HealingBroken]. The self-heal detector was right that healing was broken; it was broken
    # because this gate fed it nothing.
    #
    # THE FLAG IS WHAT DELIVERS IT.
    #
    # This gate set VERIFICATION_FAILURE and returned 1 WITHOUT the flag, so the retry loop never
    # routed the text into COORDINATOR_PROMPT_AMENDMENT -- the text the next attempt actually
    # reads. Delivery fell to the failure-analyst's discretionary target, and live on 2026-08-18
    # (AMSD-2041) it chose "kb": the knowledge base, which later runs inherit and THIS retry never
    # sees. Attempt 6 was launched on the top model of the ladder with no idea which lint errors
    # to fix, ran 22 minutes, and was killed. Exactly the failure the prescribed-helper check
    # documents from 2026-08-09 -- "the finding was assigned and dropped, and the writer was never
    # told" -- recurring at this site.
    #
    # Lint belongs in the deterministic class by this file's own definition: eslint either passes
    # or it does not, and its message already names the rule and the line, so a gate-model call to
    # restate it is waste.
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    # Keyed so an identical lint rejection twice escalates the ladder instead of looking novel on
    # every attempt. Keyed on the RULE IDS (eslint prints them as the last field), which are the
    # stable part: the file list changes as the writer works, so keying on it would make every
    # attempt look like a brand new problem.
    local _lint_rules _lint_sorted
    # HERESTRING, NOT A PIPE. In this shape it is SORT that takes SIGPIPE, not printf: sort buffers
    # everything and only then writes, so when `head -5` exits after five lines sort dies 141,
    # pipefail promotes it, and set -e ends the run on a lint output that was merely large.
    _lint_sorted=$(awk 'NF{print $NF}' <<< "$_lint_output" | grep -E '^[a-z@]' | sort -u)
    _lint_rules=$(head -5 <<< "$_lint_sorted" | tr '\n' ',')
    STORY_REJECTION_KEY="lint:${_lint_rules}"

    # Same '## Verification Failure' heading as the others so the analyst parses it identically.
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe repository'"'"'s own lint rejects file(s) THIS story changed. This is not advisory: the pre-commit hook runs these checks, refuses the commit, and lint-staged then REVERTS your work — the story cannot be delivered until every one is fixed. Fix these before anything else:\n\n%s\n' "$_lint_output")

    # Also written to the story log, where a human reading the run afterwards will look.
    {
        echo ""
        echo "## Repository Lint Failure — the commit WILL be rejected until these are fixed"
        echo ""
        echo "This repository runs its own checks in a pre-commit hook ($_hook)."
        echo "These violations are in files THIS story changed. They are not optional:"
        echo "the hook rejects the commit and lint-staged then reverts your work away."
        echo ""
        printf '%s\n' "$_lint_output" | head -n "$(evidence_window lintOutputLines)"
    } >> "$output_file" 2>/dev/null || true
    return 1
}

# run_tsc_verification <story_id> <output_file>
# Runs `tsc --noEmit` inside the retry loop (not after it) so a TypeScript
# compile failure re-enters the same failure-analyst/InferenceLadder path as
# any other verification failure, instead of silently exiting the phase with
# zero retries. The one-and-done exit at the outer story_tsc_gate() in
# run-agent-orchestration.sh remains only as a defensive last-resort check —
# this function is what actually gives tsc failures a chance to self-heal.
# Returns 0 (pass or skipped) or 1 (tsc errors found).
# _run_project_verification <project_root>
# Runs whatever the project declared in .epam/verification.json, via the verification plugin.
# Prints the checker's own output; exit status is the checker's. An undeclared project exits
# non-zero with a clear reason — never a silent pass, which is what the old
# `[ ! -f tsconfig.json ] && return 0` did for every non-TypeScript stack.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then
        echo "verification plugin missing at $_plugin"; return 2
    fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}

# ── The project's SUITE declaration, read through the plugin ──────────────────
#
# Four ecosystem facts used to live in run_external_verification: a manifest filename, a key
# inside it, a command, and a test-file naming convention. Hardcoding is permitted in plugins
# and nowhere else, so all four moved to .epam/verification.json's `test` section, read by
# orchestrations/plugins/verification-plugin.js. These wrappers carry no stack knowledge — they
# print what the project declared, or nothing.

_verification_plugin_call() {
    # $1 = exported function name, $2.. = JSON-encodable string args
    local _fn="$1"; shift
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || { printf ''; return 1; }
    "$_node" -e '
      const p = require(process.argv[1]);
      const fn = p[process.argv[2]];
      if (typeof fn !== "function") { process.exit(3); }
      const out = fn.apply(null, process.argv.slice(3));
      if (out === null || out === undefined) { console.log("unknown"); }
      else if (typeof out === "object") { console.log(JSON.stringify(out)); }
      else { console.log(String(out)); }
    ' "$_plugin" "$_fn" "$@" 2>/dev/null
}

# The project's declared manifest filename / install command, from .epam/dependency-check.json —
# the same file _get_vendor_dirs() reads. Empty when undeclared, so a caller provisions nothing
# rather than having an ecosystem guessed for it.
_project_dep_config_value() {
    local _root="${1:-$PROJECT_ROOT}" _key="$2"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_cfg" ] || return 0
    jq -r --arg k "$_key" '.[$k] // empty' "$_cfg" 2>/dev/null
}
_project_manifest_file()  { _project_dep_config_value "${1:-$PROJECT_ROOT}" manifestFile; }
_project_install_command() { _project_dep_config_value "${1:-$PROJECT_ROOT}" installCommand; }

# "true" | "false" | "unknown" — unknown when the project declared no test-file convention.
_project_repo_has_tests() {
    local _out
    _out=$(_verification_plugin_call repoHasTests "${1:-$PROJECT_ROOT}")
    case "$_out" in true|false) printf '%s' "$_out" ;; *) printf 'unknown' ;; esac
}

# The declared suite command, or empty when the project declared none.
_project_test_command() {
    local _root="${1:-$PROJECT_ROOT}"
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || return 0
    "$_node" -e '
      const p = require(process.argv[1]);
      const m = p.readTestManifest(process.argv[2]);
      if (m && m.ok) console.log(m.command);
    ' "$_plugin" "$_root" 2>/dev/null
}

# This story's declared files that the PROJECT recognises as test files, space separated.
_project_owned_test_files() {
    # THE PLUGIN ANSWERS THIS. Both of these used to be node programs written inside bash
    # single-quoted strings — unrunnable on their own, untestable, with stderr sent to /dev/null.
    # The first one destructured its arguments one position too far, so it read the STORY ID as the
    # repo root and got undefined for the PRD; readFileSync(undefined) threw, the catch exited 0,
    # and it printed nothing for every story of every project since it was written. Nothing failed
    # visibly: claude.sh scopes verification only when this returns files, so external verification
    # always ran the whole suite (live 2026-09-02: 746 suites / 3,385 tests and 10,731MB to validate
    # one line).
    #
    # _verification_plugin_call is the ONE generic invoker. Adding a capability is a function in the
    # plugin and a call here — never another program embedded in a string.
    local _out
    _out=$(_verification_plugin_call ownedTestFiles "$1" "$2" "$3") || return 0
    [ "$_out" = "unknown" ] && return 0      # no declared convention: cannot answer, so scope nothing
    printf '%s' "$_out"
}

_project_scoped_test_command() {
    # The template is the project's own declaration (.epam/verification.json test.scopedCommand);
    # the plugin substitutes the file list. Empty when undeclared, so the caller runs the full
    # suite — correct, and never silent.
    local _out
    _out=$(_verification_plugin_call scopedTestCommand "$1" "$2") || return 0
    [ "$_out" = "unknown" ] && return 0
    printf '%s' "$_out"
}

run_tsc_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    is_truthy "${SKIP_STORY_TSC_GATE:-}" && return 0
    # No stack precondition. runVerification reports UNKNOWN for a project that has declared
    # no check, and every caller treats non-zero as failure — so an undeclared repo is
    # refused rather than skipped. Counting a language's files here meant "skip", which
    # callers read as PASS: the fail-open the verification plugin exists to remove, moved
    # from the invocation to the condition.

    # NOTE: this gate used to skip test-engineer-role stories entirely ("they
    # extend existing files, not create TS modules"). That reasoning doesn't
    # hold: a .test.ts file is compiled/type-checked by tsc exactly like any
    # other .ts file, and a syntax error inside one is exactly what `tsc
    # --noEmit` catches. Removed 2026-07-12 after a live run showed EVERY
    # syntax-class error observed (unterminated strings, mismatched parens, a
    # stray-token typo) was in a .test.ts file written by a test-engineer
    # story — precisely the case this skip disabled the check for, forcing
    # each one through a full external `npm test` run + FailureAnalyst LLM
    # call + model-tier escalation to catch what tsc would have caught for
    # free in the same turn.

    local _node_cmd="${NODE_CMD:-${HOME}/.nvm/versions/node/v20.20.0/bin/node}"
    [ ! -x "$_node_cmd" ] && _node_cmd="$(command -v node 2>/dev/null || echo 'node')"

    local _tsc_output _tsc_exit=0
    # The PROJECT's declared check, not a tool this engine names. Metrolinx's repos define
    # `check-types` as `tsc --noEmit --incremental` (gotransit) and plain `tsc` (metrolinx, which
    # EMITS) — so the hardcoded `./node_modules/.bin/tsc --noEmit` was running a different check
    # than the project's own, on every repo, for the life of this pipeline.
    _tsc_output=$(_run_project_verification "$PROJECT_ROOT" 2>&1) || _tsc_exit=$?

    # NOT DECLARED IS NOT FAILED. _run_project_verification exits 2 when the project declares no
    # typecheck command, and every non-zero exit used to become "TypeScript errors — fix them so
    # tsc exits 0". There are none to fix: live 2026-08-18, mock-a's `npx tsc --noEmit` exited 0
    # while the plugin's own verdict was "verification manifest declares no typecheck command".
    # The writer spent its attempts hunting errors that did not exist, HealingBroken fired on the
    # repeated diagnosis, and the analyst eventually said so outright. The sibling lane proves the
    # remedy: mock-b's writer added the block and its verification returns pass.
    #
    # Refusing an undeclared check stays — an undeclared repo must never silently pass. Only what
    # the writer is TOLD changes: declare the command, do not chase type errors.
    if [ "$_tsc_exit" -eq 2 ]; then
        warning "  [tsc-verify] $story_id: the project declares no typecheck command — the check could not run"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator could not run this project'"'"'s type check because the verification manifest does not declare one. This is NOT a type error in your code — nothing was checked.\n\nDeclare the command in `.epam/verification.json` alongside the existing `test` entry, taking it from the project'"'"'s own manifest — read it and use whatever this project already declares — in this shape:\n\n```json\n"typecheck": { "command": "<the project'"'"'s own type-check command>" }\n```\n\nThe orchestrator reported:\n\n```\n%s\n```\n' \
            "$_tsc_output")
        return 1
    fi

    if [ "$_tsc_exit" -ne 0 ]; then
        # Brownfield: a large existing repo can have pre-existing tsc errors in
        # files no story ever touches (live, 2026-07-22 — Redis/Stripe/OTel type
        # declarations, a jsonwebtoken signature mismatch, unrelated to AMSD-1820's
        # Mozio/promo-discount work). Whole-project `tsc --noEmit` fails identically
        # for every story regardless of what it changed, and no amount of model
        # escalation can fix errors in files the story never touches — confirmed by
        # HealingBroken firing 4+ times on the exact same unrelated diagnosis before
        # exhausting all 8 retries. Fix: diff against a baseline error set captured
        # from JIRA_BASELINE_BRANCH (the same baseline review-ranger/mutant-hunter
        # already use) — only fail on errors NEW relative to that baseline, i.e.
        # errors this story's own changes actually introduced.
        # ONE IMPLEMENTATION, in lib/tsc-baseline-gate.sh. This block was one of four copies of
        # the same baseline-delta logic, each with its own tsc error regex and its own
        # node_modules literal. On a repo whose checker speaks a different dialect the regex
        # matched nothing, the baseline set came back empty, there was nothing to subtract, and
        # the gate reported PASS having verified nothing — four independent fail-open paths.
        #
        # The already-captured output is handed in: this runs per ATTEMPT, up to 8 times a story,
        # and re-running the check here would multiply the most expensive gate in the run.
        local _new_errors="$_tsc_output"
        if command -v baseline_new_failures >/dev/null 2>&1; then
            local _tsc_out_file _delta_rc=0 _delta_out
            _tsc_out_file=$(mktemp)
            printf '%s' "$_tsc_output" > "$_tsc_out_file"
            _delta_out=$(baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                "$LOG_DIR" typecheck "$_tsc_out_file") || _delta_rc=$?
            rm -f "$_tsc_out_file"
            [ "$_delta_rc" -eq 0 ] && _new_errors="" || _new_errors="$_delta_out"
        fi

        # EVERY FAILURE WAS PRE-EXISTING. The check is red, but nothing here is this story's
        # doing, so the story passes — that is the entire purpose of the baseline diff, and the
        # operator policy it implements: inherit what the codeline already had, never add to it.
        #
        # This guard was lost when the inline baseline block was replaced by the shared library,
        # and an empty delta fell straight through to the failure branch below — reporting
        # "TypeScript errors" with an EMPTY error list, which is how it was caught.
        if [ -z "$(echo "$_new_errors" | tr -d '[:space:]')" ]; then
            success "  [tsc-verify] $story_id: the type check has only pre-existing baseline errors — none introduced by this story"
            return 0
        fi

        warning "  [tsc-verify] $story_id: TypeScript errors — feeding into retry loop"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran the project type check after your files were written and it failed (exit code %d). Fix the type errors so tsc exits 0.\n\n```\n%s\n```\n' \
            "$_tsc_exit" "$_new_errors")
        {
            echo ""
            echo "=== the project type check failed (exit $_tsc_exit) — new errors introduced by this story ==="
            echo "$_new_errors" | head -n "$(evidence_window typecheckErrorLines)"
        } >> "$output_file"
        return 1
    fi

    success "  [tsc-verify] $story_id: the project type check passed"
    return 0
}


update_monitor_status() {
    local event="$1"   # "start" | "complete" | "fail"
    local story_id="$2"
    local message="${3:-}"
    local lane="${WORKTREE_MODE:-main}"
    local title
    title=$(get_story_title "$story_id" 2>/dev/null || echo "$story_id")
    local role
    role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "$PRD_FILE" 2>/dev/null || echo "")
    local update_script="$SCRIPT_DIR/update-monitor.sh"
    [ ! -x "$update_script" ] && return 0
    case "$event" in
        start)
            # Orchestration already emitted story_start with the correct model when it
            # launched this subprocess via run_story_with_watchdog. Skip the duplicate.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_start "$story_id" "$lane" "$role" "$title" \
                    "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
            fi
            ;;
        complete)
            # Orchestration emits story_complete after the TSC gate (the authoritative
            # "story is done and types pass" signal). Skip the duplicate from claude.sh
            # for main-lane stories managed by orchestration.
            if [ "${ORCH_STORY_START_EMITTED:-0}" != "1" ]; then
                "$update_script" story_complete "$story_id" "$lane" "$title" \
                    "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
            fi
            ;;
        fail)
            "$update_script" story_fail "$story_id" "$lane" "$message" 2>/dev/null || true
            ;;
    esac
}
# _classify_declared_paths <newline-separated-paths>
#
# Splits the story's declared output paths into those that ALREADY EXIST and those that do not,
# and reports the size of each existing one.
#
# WHY THIS EXISTS. The planner was given a bare list under the heading "Files to Create/Modify"
# and nothing else. It cannot know that pageService.ts already holds 537 lines, so "Create
# src/services/pageService.ts" is the reasonable output — and that is exactly what it produced
# live on 2026-08-09, ten steps of it, while build_implementation_prompt simultaneously told the
# writer "these files already exist, their content is injected below". The writer got both halves
# of the contradiction and wrote nothing.
#
# FACTUAL, NOT LEXICAL. An earlier draft scanned plan steps for create-ish verbs.
# lib/guard-vocabulary.js forbids that in terms this project has already paid to learn: a
# deterministic guard may be deterministic in enforcement, but its CONTENT may never be a
# hardcoded list — "not in engine code, not in config, not as a 'generic' list somebody promises
# to maintain". So nothing here matches words. The filesystem is asked; existence is a fact,
# derived per story, naming no domain and no vocabulary.
#
# Creation stays expressible: a path that genuinely does not exist is listed as creatable, so a
# greenfield story is unaffected.
_classify_declared_paths() {
    local _paths="${1:-}"
    local _existing="" _new="" _p _abs _lines
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        case "$_p" in /*) _abs="$_p" ;; *) _abs="${PROJECT_ROOT}/${_p}" ;; esac
        if [ -f "$_abs" ]; then
            _lines=$(wc -l < "$_abs" 2>/dev/null | tr -d " ")
            _existing="${_existing}  - ${_p} (${_lines:-0} lines, already implemented)
"
        else
            _new="${_new}  - ${_p}
"
        fi
    done <<< "$_paths"

    # No line may begin with `}` — several extractors in this repo (and its tests) isolate a
    # function with /^}/, and a multi-line parameter default whose closing brace lands in column
    # zero truncates the function silently. That is how the first version of this helper broke
    # its own test.
    [ -n "$_existing" ] || _existing="  (none)"
    [ -n "$_new" ] || _new="  (none)"
    printf '## Files that ALREADY EXIST — your steps MODIFY these; they are already written\n%s\n' "$_existing"
    printf '## Files that DO NOT EXIST YET — only these may be created\n%s\n' "$_new"
}


# run_planning_phase <story_id> <planner_model>
# Invokes the planner model with a focused planning prompt.
# Outputs a structured step-by-step execution plan as plain text on stdout.
# Uses the same SDK/CLI path as execution invocations.
run_planning_phase() {
    local story_id="$1"
    local planner_model="$2"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(get_story_title "$story_id")
    local ac
    ac=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/- /' || echo "")
    # Extract the exact output paths from technicalNotes.files — the planner must
    # use these verbatim. Without them, the planner invents paths based on convention
    # (e.g. tests/ instead of src/skyscanner/), which the executor faithfully follows
    # to the wrong location and exhausts all turns trying to recover (151K token bloat).
    local declared_files declared_files_raw
    declared_files_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null || echo "")
    # These are forwarded to the child process invoked below. shellcheck cannot see the consumer,
    # so it reports them unused; removing them would take the values away from the child.
    # shellcheck disable=SC2034
    declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")
    # Inject dependency contracts so the planner also uses the correct READ paths.
    local plan_dep_contracts=""
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '[.stories[] | select(.id == $id) | (.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _cf="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        [ -f "$_cf" ] && plan_dep_contracts="${plan_dep_contracts}
### Contract: ${_dep_id}
$(cat "$_cf")
"
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-producer-vals-XXXXXX.json")
    jq_vals \
          --arg declared_paths "$(_classify_declared_paths "${declared_files_raw}")" \
          --arg dependency_contracts "$([ -n "$plan_dep_contracts" ] && printf '\n## Dependency Contracts (ground-truth import paths and signatures — use these verbatim in read/import steps)\n%s\n' "$plan_dep_contracts" || true)" \
          --arg cross_codeline_contract "$([ -n "${CROSS_CODELINE_CONTRACT:-}" ] && [ -f "${CROSS_CODELINE_CONTRACT}" ] && printf '\n## Cross-Codeline API Contract (upstream codeline exports — use these types and endpoints verbatim when integrating)\n%s\n' "$(cat "${CROSS_CODELINE_CONTRACT}")" || true)" \
          --arg story_id "${story_id}" \
          --arg title "${title}" \
          --arg ac "${ac}" \
          '{"__DECLARED_PATHS__":$declared_paths,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__CROSS_CODELINE_CONTRACT__":$cross_codeline_contract,"__STORY_ID__":$story_id,"__TITLE__":$title,"__AC__":$ac}' > "$_cp_vals"
    local planning_prompt
    planning_prompt="$(render_engine_prompt plan-producer "$_cp_vals")"
    rm -f "$_cp_vals"

    local plan_result_file
    plan_result_file=$(mktemp /tmp/plan-${story_id}-XXXXXX.json)
    local plan_text=""

    local plan_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}"
    if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        echo "$planning_prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
            --cache-system \
            --model "$planner_model" \
            --system-prompt "$plan_constitution" \
            --output "$plan_result_file" 2>/dev/null || true
        plan_text=$(jq -r '.result // empty' "$plan_result_file" 2>/dev/null || cat "$plan_result_file" 2>/dev/null || echo "")
    else
        # Route through ai-run.sh with the configured orchestration provider
        local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
        local _orch_model="${planner_model:-${EPAM_MODEL:-}}"
        if [ -n "$_orch_provider" ]; then
            # PLANNING SAMPLING, not the writer's. The planning turn wants determinism and
            # structure; execution sampling is per-model and, for some models, the opposite
            # (GLM-5.2 wants HIGH temperature to execute). Sharing one setting made the
            # per-model execution profiles meaningless for the plan. Config: planning.*
            # Applied inside the command substitution's SUBSHELL, so the planning values cannot
            # leak into the writer that follows. Two constructs were tried and rejected:
            #   ${VAR:+FOO=bar} as an assignment prefix — assignments are recognised at PARSE
            #     time, so a word produced by EXPANSION becomes the command name instead. It
            #     silently broke the invocation whether the var was set or not.
            #   env ${VAR:+FOO=bar} — this environment's PATH shadows GNU env with a shell shim
            #     at ~/.local/bin/env (same trap already documented above for `env -u`).
            plan_text=$(
                [ -n "${EPAM_PLANNING_TEMPERATURE:-}" ] && export EPAM_TEMPERATURE="$EPAM_PLANNING_TEMPERATURE"
                [ -n "${EPAM_PLANNING_TOP_P:-}" ] && export EPAM_TOP_P="$EPAM_PLANNING_TOP_P"
                [ -n "${EPAM_PLANNING_EFFORT:-}" ] && export EPAM_REASONING_EFFORT="$EPAM_PLANNING_EFFORT"
                echo "$planning_prompt" | \
                AI_PROVIDER="$_orch_provider" \
                AI_MODEL="$_orch_model" \
                EPAM_CLI="$EPAM_CLI" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
                ${_orch_model:+--model "$_orch_model"} \
                2>/dev/null || echo "")
        fi
    fi

    rm -f "$plan_result_file"
    echo "$plan_text"
}

# review_and_correct_plan <story_id> <plan_text>
# Gate between the plan-turn and the execute-turn: catches a hallucinated file
# path/API in the plan BEFORE any code is written, using the same ground-truth
# dependency contracts (.contracts/<dep_id>.md) already proven to fix this class
# of bug for implementation prompts (see the "Spec-reality cross-check" comment
# in build_implementation_prompt()). Without this gate, run_planning_phase()'s
# output was previously injected as fixed context completely unreviewed — a
# wrong plan would be followed just as faithfully as a right one.
# Bounded to exactly ONE corrective re-plan (same "one bounded retry" pattern as
# the split-mandate gate and escalation-resolution elsewhere in this file) —
# never an unbounded loop.
# Echoes the final plan text (corrected if a fix was applied, original otherwise).
review_and_correct_plan() {
    local story_id="$1"
    local plan_text="$2"
    [ -z "$plan_text" ] && { echo "$plan_text"; return; }

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _dep_ids_json
    _dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")

    # Extract declared output files — needed to catch output-path hallucinations
    # even when there are no dependency contracts to check against.
    local _review_declared_files
    _review_declared_files=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // [] | .[]' \
        "$prd_target" 2>/dev/null | sed 's/^/  - /' || echo "")

    local dependency_contracts=""
    local _dep_id
    while IFS= read -r _dep_id; do
        [ -z "$_dep_id" ] && continue
        local _contract_file="$PROJECT_ROOT/.contracts/${_dep_id}.md"
        if [ -f "$_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_dep_id}
$(cat "$_contract_file")
"
        fi
    done < <(echo "$_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    # Skip the LLM review if there are no dependency contracts AND no declared
    # output files — nothing ground-truth to check the plan against.
    if [ -z "$dependency_contracts" ] && [ -z "$_review_declared_files" ]; then
        echo "$plan_text"
        return
    fi

    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    [ -z "$_orch_provider" ] && { echo "$plan_text"; return; }

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-reviewer-vals-XXXXXX.json")
    jq_vals \
          --arg declared_output_files "$([ -n "$_review_declared_files" ] && printf '\n## Declared Output Files (EXACT paths the plan MUST write to)\n%s\n' "$_review_declared_files" || true)" \
          --arg dependency_contracts "${dependency_contracts}" \
          --arg plan_text "${plan_text}" \
          --arg story_id "${story_id}" \
          '{"__DECLARED_OUTPUT_FILES__":$declared_output_files,"__DEPENDENCY_CONTRACTS__":$dependency_contracts,"__PLAN_TEXT__":$plan_text,"__STORY_ID__":$story_id}' > "$_cp_vals"
    local review_prompt
    review_prompt="$(render_engine_prompt plan-reviewer "$_cp_vals")"
    rm -f "$_cp_vals"

    # Tool access (HEAL-BLIND, 2026-07-31): this gate exists specifically to
    # catch a plan that CONTRADICTS reality, but until now had no way to check
    # anything beyond what dependency_contracts happens to cover (a story's
    # declared internal dependencies) — the identical gap that let the
    # failure-analyst confidently misdiagnose a fully-installed package as
    # missing. Reuses ORCH_GATE_ALLOWED_TOOLS verbatim, same shared allowlist
    # every other gate agent draws from. Bounded: this runs before EVERY
    # story's implementation, not just on retry.
    local review_output
    # Tool budgets below are 24, raised from 6 on 2026-08-09: codegraph_query states in its own
    # description that "5-10 times is normal", so a budget of 6 was exhausted by one tool's
    # documented usage with nothing read afterwards, leaving the one-shot grep as the only
    # affordable option. These bound TOOL calls, not model turns — a read is cheap next to the
    # wrong answer it prevents.
    #
    # NOT inside the continuation chain below: a `\` followed by a comment TERMINATES the
    # command. Placing it there silently split the pipeline, and the invocation ran with
    # nothing on stdin — which is exactly how the writer burned 8 attempts at $0 cost.
    review_output=$(echo "$review_prompt" | \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${EPAM_MODEL:-}" \
        EPAM_CLI="$EPAM_CLI" \
        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
        EPAM_MAX_TOOL_CALLS="${PLAN_REVIEW_MAX_TOOL_CALLS:-24}" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${EPAM_MODEL:+--model "$EPAM_MODEL"} \
        2>/dev/null || echo "")

    # Robust JSON extraction (not a flat-object regex — see the identical bug
    # fixed live in team-lead-review.sh/code-review-cycle.sh, 2026-07-07: a
    # pretty-printed or otherwise non-single-line response silently fails a
    # naive '{.*"verdict".*}' grep). raw_decode correctly parses regardless of
    # formatting/whitespace.
    local review_json
    review_json=$(echo "$review_output" | python3 "$SCRIPT_DIR/lib/handlers/plan-review-json.py" 2>/dev/null || echo "")
    [ -z "$review_json" ] && { echo "$plan_text"; return; }

    local verdict corrections
    verdict=$(echo "$review_json" | jq -r '.verdict // "ok"' 2>/dev/null || echo "ok")
    if [ "$verdict" != "mismatch" ]; then
        echo "$plan_text"
        return
    fi

    corrections=$(echo "$review_json" | jq -r '.corrections // ""' 2>/dev/null || echo "")
    warning "  PlanReview: mismatch detected for $story_id against dependency contracts — one corrective re-plan"

    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/plan-corrective-vals-XXXXXX.json")
    jq_vals \
          --arg corrections "${corrections}" \
          --arg plan_text "${plan_text}" \
          --arg story_id "${story_id}" \
          '{"__CORRECTIONS__":$corrections,"__PLAN_TEXT__":$plan_text,"__STORY_ID__":$story_id}' > "$_cp_vals"
    local corrective_prompt
    corrective_prompt="$(render_engine_prompt plan-corrective "$_cp_vals")"
    rm -f "$_cp_vals"

    local corrected_plan
    corrected_plan=$(echo "$corrective_prompt" | \
        AI_PROVIDER="$_orch_provider" \
        AI_MODEL="${STORY_PLANNER_MODEL:-${EPAM_MODEL:-}}" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
        ${STORY_PLANNER_MODEL:+--model "$STORY_PLANNER_MODEL"} \
        2>/dev/null || echo "")

    if [ -n "$corrected_plan" ]; then
        echo "$corrected_plan"
    else
        echo "$plan_text"
    fi
}

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

# classify_invocation_refusal <attempt-output-file> <exit-code>
#
# TRUE when the CLI refused its own command line -- an argument it will refuse identically forever.
#
# 2026-08-28: every writer attempt died in milliseconds on
#   error: option '--autocompact <auto|tokens>' argument '80000' is invalid.
# The coordinator called all twelve "unknown", escalated haiku -> sonnet-5 and reset the worktree
# between each, because no raw output file existed and absent was read as "no evidence". The
# evidence was in the attempt's own output log the whole time, identical every time.
#
# Retrying is for conditions that might differ next time. This is not one of them: report the
# offending option and stop, so the operator fixes the flag instead of paying for eleven repeats.
# require_profile <persona-key> <profiles-file>
#
# THE BRIEF, OR NOTHING — never prose written here.
#
# Three call sites carried `[ -z "$x" ] && x="You are a ..."`, so a missing roster entry silently
# substituted a persona that no prompt file holds, no review ever saw, and no project can
# specialise. All three keys exist in both roster sources, which means the fallback could only fire
# when the roster was BROKEN — exactly when running anyway is worst, and the resulting verdict is
# one nobody can audit or reproduce.
#
# The pipeline already knows the right answer: runtime-boundary refuses "with no instructions", and
# team-lead-review refuses rather than review on an empty brief. A gate that declines is
# recoverable. A gate that invents its own instructions is not.
require_profile() {
    local _key="${1:-}" _file="${2:-}"
    local _brief=""
    [ -n "$_key" ] || { error "  [profile] no persona key given — refusing to invent one"; return 1; }
    if [ -n "$_file" ] && [ -f "$_file" ]; then
        _brief=$(jq -r --arg k "$_key" '.[$k] // ""' "$_file" 2>/dev/null || echo "")
    fi
    if [ -z "$_brief" ] || [ "$_brief" = "null" ]; then
        error "  [profile] '${_key}' has no brief in ${_file:-<no profiles file>} — refusing to run it on"
        error "  [profile] prose written in this script. Mint the roster, or restore profiles.json."
        return 1
    fi
    printf '%s' "$_brief"
}

classify_invocation_refusal() {
    local _out="${1:-}" _exit="${2:-1}"
    [ "$_exit" -ne 0 ] || return 1
    [ -n "$_out" ] && [ -f "$_out" ] || return 1

    # The CLI's own argument-parser wording. Anchored on "option ... argument ... invalid" rather
    # than on any one flag: the next flag to move its accepted range must land here too.
    local _line
    _line=$(grep -m1 -aE "^error: (option|unknown option|required option)" "$_out" 2>/dev/null || true)
    [ -n "$_line" ] || return 1

    local _opt
    # NO `| head -1`: under pipefail head closes the pipe, grep dies of SIGPIPE and the assignment
    # fails on a line that matched perfectly well. grep -m1 already stops at the first match, so the
    # head was redundant as well as harmful. Caught by sigpipe-under-pipefail.bats — a suite that had
    # never executed until the day this line was written.
    _opt=$(printf '%s' "$_line" | grep -oE -m1 -- "--[a-z0-9-]+" || true)
    warning "  Coordinator[L1]: the CLI REFUSED its own command line -- ${_opt:-<option>} is not"
    warning "    acceptable to the installed binary, so every retry fails identically before any"
    warning "    token is sent. Not retryable. Fix the flag, then re-run."
    warning "    ${_line}"
    return 0
}

# classify_failure_class <raw_file> <result_json> <exit_code>
# Layer 1: rule-based triage. Sets COORDINATOR_FAILURE_CLASS and COORDINATOR_ESCALATE.
# resolve_model_override <model> <provider> <settings-file>...
#
# THE FIRST FILE THAT DECLARES THIS MODEL WINS -- per MODEL, not per FILE.
#
# Overrides live in the active stack, and a project may override for its own reasons, so the caller
# passes project first and stack second. The precedence used to be applied to the FILE: if the
# project declared any modelOverrides at all, the stack's were never read. mock3 declares overrides
# for the models of the stack it was written against; run on claude, none matched, and the stack's
# own claude entries were skipped, so the value fell through to defaultAutoCompressAt: 80000 and the
# CLI rejected the argument outright -- twelve attempts, no tokens, a whole writer leg (2026-08-28).
#
# A project's silence about THIS model is not an instruction to ignore the stack's answer for it.
#
# Emits the matching override object as compact JSON, or nothing.
resolve_model_override() {
    local _model="${1:-}" _provider="${2:-}"
    shift 2 || true
    local _f _json
    for _f in "$@"; do
        [ -n "$_f" ] && [ -f "$_f" ] || continue
        # A "$"-prefixed key is a documentation note, not an override. Indexing .value.matchOn on a
        # string aborts the whole query, and a swallowed error reads as "no overrides on this file".
        _json=$(jq -c --arg provider "$_provider" --arg model "$_model" '
            (.modelOverrides // {}) | to_entries
            | map(select(.value | type == "object"))
            | map(select(
                (.value.matchOn == "provider" and .value.matchValue == $provider)
                or (.value.matchOn == "model" and (.value.matchSubstring // null) != null
                    and (.value.matchSubstring as $sub | $model | contains($sub)))
              ))
            | (.[0].value // empty)
        ' "$_f" 2>/dev/null)
        if [ -n "$_json" ] && [ "$_json" != "null" ]; then
            printf '%s' "$_json"
            return 0
        fi
    done
    return 0
}

classify_failure_class() {
    local raw_file="${1:-}"
    local result_json="${2:-}"
    local exit_code="${3:-1}"
    local story_id="${4:-}"

    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"

    # Class A: environment crash — raw output is EMPTY and exit code != 0.
    #
    # ABSENT IS NOT EMPTY. This measured emptiness as `raw_size=0` with a default of 0, so a file
    # that was never written — or an empty path, which is exactly what the caller passes when its
    # fallbacks miss — scored identically to a file the CLI wrote nothing into. On 2026-08-18 no
    # _result_raw.json existed for either story, so ten attempts were diagnosed "environment
    # crash", the coordinator confirmed a healthy binary and key, and the real cause (a provider
    # that did not follow its escalated model) was never considered. A conclusion drawn from
    # absent evidence is worse than no conclusion: it sends the next step somewhere confident and
    # wrong. Missing stays UNKNOWN, and says so.
    if [ "$exit_code" -ne 0 ] && { [ -z "$raw_file" ] || [ ! -f "$raw_file" ]; }; then
        COORDINATOR_FAILURE_CLASS="unknown"
        COORDINATOR_ESCALATE="yes"
        warning "  Coordinator[L1]: no raw output file to read (${raw_file:-<no path>}) — the attempt's output was never written, so the failure class is UNKNOWN, not diagnosed"
        return 0
    fi
    local raw_size=0
    [ -f "$raw_file" ] && raw_size=$(wc -c < "$raw_file" 2>/dev/null || echo 0)
    if [ "$raw_size" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
        COORDINATOR_FAILURE_CLASS="env"
        COORDINATOR_ESCALATE="no"
        warning "  Coordinator[L1]: environment failure detected (raw=0 bytes, exit=$exit_code) — diagnosing before escalation decision"
        # Active crash diagnosis: check API key and binary health
        local _diag_ok=true
        # 1. Check epam binary is executable
        if ! command -v "${EPAM_CLI:-epam}" >/dev/null 2>&1; then
            warning "  Coordinator[Diag]: epam binary not found on PATH — check EPAM_CLI or PATH"
            _diag_ok=false
        fi
        # 2. Check the stack's credential, IF this stack has one to check.
        #
        # This curled a vendor auth endpoint unconditionally and, finding no key for that
        # vendor, declared "provider will fail on any API call" — on a codemie or mockserver
        # run, where that vendor is not used at all. A diagnostic that reports a healthy run as
        # broken is worse than none. The set declares whether it has a checkable credential
        # endpoint (provider-sets.json spendProbe); a set declaring none is skipped, not failed.
        local _or_key=""
        if [ -n "$(spend_probe_read)" ]; then
            _or_key="${OPENROUTER_API_KEY:-${EPAM_API_KEY_OPENROUTER:-}}"
        else
            log "  Coordinator[Diag]: this provider set declares no credential endpoint — skipping the vendor key check"
        fi
        if [ -n "$_or_key" ]; then
            local _key_status
            _key_status=$(curl -s --max-time 5 \
                "https://openrouter.ai/api/v1/auth/key" \
                -H "Authorization: Bearer $_or_key" 2>/dev/null \
                | jq -r '.data.label // "invalid"' 2>/dev/null || echo "unreachable")
            if [ "$_key_status" = "invalid" ] || [ "$_key_status" = "unreachable" ]; then
                warning "  Coordinator[Diag]: OPENROUTER_API_KEY check returned '$_key_status' — key may be expired or network is down"
                _diag_ok=false
            else
                log "  Coordinator[Diag]: OpenRouter key OK (label=$_key_status)"
            fi
        else
            warning "  Coordinator[Diag]: OPENROUTER_API_KEY is empty — provider will fail on any API call"
            _diag_ok=false
        fi
        if [ "$_diag_ok" = true ]; then
            log "  Coordinator[Diag]: binary and key are healthy — model/timeout issue; allowing escalation to retryModel"
            COORDINATOR_ESCALATE="yes"
        fi
        return
    fi

    # Class B: capability failure — "reached maximum iterations" in result
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    if echo "$result_text" | grep -qi "maximum iterations\|max.*iter"; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        # Inject a directive so the escalated model doesn't repeat the same
        # exhaustion pattern. This is a SEPARATE occurrence of the same
        # write-first-vs-read-first distinction fixed in
        # build_implementation_prompt() (found live 2026-07-23, AMSD-1820) —
        # missed here because it's a different code path (the max-iterations
        # failure classifier, not the initial prompt builder). Without this
        # brownfield branch, a story that hits this classifier gets the OLD
        # "do NOT investigate" text re-injected via ## Coordinator Guidance,
        # silently contradicting and undoing the "READ BEFORE YOU WRITE"
        # directive already shown earlier in the SAME prompt.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" turns_exhausted_files_exist)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
            rm -f "$_cp_vals"
        else
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" turns_exhausted_nothing_written)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
            rm -f "$_cp_vals"
        fi
        log "  Coordinator[L1]: capability failure (max iterations) — escalation approved, write-first amendment injected"
        if [ -n "$story_id" ] && [ -n "${LOG_DIR:-}" ]; then
            (
                flock -w 5 200 || true
                jq -cn --arg id "$story_id" --arg ts "$(date -Iseconds)" \
                    '{story_id:$id, timestamp:$ts}' >> "${LOG_DIR}/iteration-exhaustion.jsonl"
            ) 200>"${LOG_DIR}/iteration-exhaustion.jsonl.lock"
        fi
        return
    fi

    # Class B variant: ran with tokens but no deliverables
    local tokens_out=0
    [ -f "$result_json" ] && tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$result_json" 2>/dev/null || echo 0)
    if [ "${tokens_out:-0}" -gt 100 ] && [ -z "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: capability failure (tokens consumed, no result) — escalation approved"
        return
    fi

    # Class C: quality failure — result exists, deliverables may exist, but tests failed
    # This is identified by the caller (verify_story_deliverables or run_external_verification failing)
    # If we reach here with non-empty result, it's likely quality
    if [ -n "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="quality"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: quality failure (agent ran, result produced) — escalation tentatively approved"
        return
    fi

    # Unknown: default to escalate (safe fallback)
    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"
    log "  Coordinator[L1]: unknown failure class — escalation approved (safe default)"

    # Cross-run memory check: read story-failures.jsonl for repeated patterns.
    # After 2+ consecutive env failures on the same story, suppress escalation and
    # flag it as a persistent environment problem requiring operator intervention.
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _prior_env_count
        _prior_env_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "env") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_env_count:-0}" -ge 2 ]; then
            COORDINATOR_FAILURE_CLASS="env"
            COORDINATOR_ESCALATE="no"
            warning "  Coordinator[L1]: story $story_id has ${_prior_env_count} prior env failures across runs — suppressing escalation, flagging for operator review"
        fi
        local _prior_cap_count
        _prior_cap_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "capability") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_cap_count:-0}" -ge 3 ]; then
            log "  Coordinator[L1]: story $story_id has ${_prior_cap_count} prior capability failures — story may need decomposition (too many ACs for any single invocation)"
            # Cross-run KB synthesis: emit a pattern entry after 3+ capability failures
            # so future runs benefit from the accumulated failure pattern.
            #
            # OFF BY DEFAULT (2026-08-04). This is cross-run GROWTH by design, and the KB
            # is injected into writer prompts — so an entry written here teaches every
            # later agent. Until the pipeline is stable the KB starts fresh every run
            # (lib/kb-canonical.sh restores it from KB.md.original), which would discard
            # this entry anyway; writing it while claiming "future runs benefit" would be
            # a false claim in the log. Re-enable deliberately with
            # EPAM_KB_CROSS_RUN_SYNTHESIS=1 once cross-run learning is wanted again.
            if [ "${EPAM_KB_CROSS_RUN_SYNTHESIS:-0}" = "1" ]; then
            local _kb_file="$AUTOMATION_DIR/agents/KB.md"
            local _today; _today=$(date +'%Y-%m-%d')
            local _kb_entry_marker="KB-PERSIST-${story_id}"
            if [ -f "$_kb_file" ] && ! grep -q "$_kb_entry_marker" "$_kb_file" 2>/dev/null; then
                local _ac_count
                _ac_count=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | length' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "unknown")
                {
                    printf '\n## %s -- %s\n\n' "$_kb_entry_marker" "$_today"
                    printf '**Category:** orchestration\n'
                    printf '**AgentRole:** any\n'
                    printf '**Tags:** inference-ladder, story-decomposition, capability-failure\n'
                    printf '**Trigger:** cross-run-synthesis\n'
                    printf '**StoryRef:** %s\n\n' "$story_id"
                    printf 'Story %s has failed %s times with capability class (max iterations / empty output). ' "$story_id" "$_prior_cap_count"
                    printf 'It has %s ACs. Model escalation alone has not resolved this — the story likely needs to be ' "$_ac_count"
                    printf 'decomposed into smaller children (≤8 ACs each) before the next run. '
                    printf 'OpenSpec/SpecKit should split this story at Step 0 in the next pipeline run.\n'
                } > /dev/null
                # NOT PERSISTED. This wrote a "cross-run" KB entry that nothing ever cleared, so
                # a conclusion drawn about one run's code was injected as current fact into every
                # later run. Operator 2026-08-12: no lingering anything may skew a run.
                log "  Coordinator[L1]: capability pattern noted for $story_id (${_prior_cap_count} failures) — this run only, not persisted"
            fi
            else
                log "  Coordinator[L1]: cross-run KB synthesis disabled (EPAM_KB_CROSS_RUN_SYNTHESIS=0) — $story_id has ${_prior_cap_count} capability failures, not persisted to the KB"
            fi
        fi
    fi
}

# classify_ladder_tier <story_id>
# Dynamically decides whether a story's Rung 2/3 escalation should use the
# "medium" or "high" ladder — NOT hardcoded per story ID. Reads the story's
# own recorded failure history (story-failures.jsonl, cross-run, written by
# every retry attempt) and classifies "high" only when the evidence shows
# this story has already exhausted a full retry cycle before (a real,
# measured signal — not a guess): either a prior attempt reached MAX_RETRIES,
# or the story has failed across 2+ separate watchdog/run cycles.
# Echoes "medium" or "high". No model names appear in this function.
# effort_rank <low|medium|high> -> 0..2 ; unknown ranks lowest so it can never win a max().
effort_rank() {
    local want="${1:-}" i=0 lvl
    local IFS='|'
    for lvl in ${EPAM_EFFORT_LADDER:-low|medium|high|max}; do
        [ "$lvl" = "$want" ] && { echo "$i"; return; }
        i=$((i+1))
    done
    echo -1
}

# max_effort <a> <b> — the HIGHER of two effort levels.
#
# A model override used to be applied as a final overwrite:
#     [ -n "$_ov_effort" ] && export EPAM_REASONING_EFFORT="$_ov_effort"
# which ran AFTER the rung had set its own value, so every rung's escalation was discarded for
# any model carrying an override — and every model in every live chain carries one. Measured
# 2026-08-10: effort was 'high' on attempt 1 and on attempt 8 alike; the rungs[] escalation
# ladder was dead configuration.
#
# Treating the override as a FLOOR keeps its purpose (a model that needs more effort than the
# rung asks for still gets it) while letting a retry raise effort, which is the operator rule:
# a retry must always escalate effort when the model is not escalating.
max_effort() {
    local a="${1:-}" b="${2:-}" ra rb
    ra=$(effort_rank "$a"); rb=$(effort_rank "$b")
    if [ "$rb" -gt "$ra" ]; then echo "$b"; else echo "$a"; fi
}

# effort_is_higher <candidate> <current> — true when the PROJECT declares candidate above current.
#
# Ranked by effort_rank, which reads the declared effortLadder, so the four hand-written case
# statements this replaces are gone and a project that declares a fourth level gets it honoured
# instead of silently ranked mid.
#
# UNDECLARED NEVER WINS. effort_rank returns -1 for a level the project does not declare, so a
# typo, a renamed level or a stale PRD value cannot raise or lower a story's budget by accident.
# Note -1, not 0: the FIRST declared level ranks 0, and treating 0 as "unknown" would make every
# upgrade off the lowest level impossible.
effort_is_higher() {
    local _new _cur
    _new=$(effort_rank "${1:-}")
    _cur=$(effort_rank "${2:-}")
    [ "$_new" -ge 0 ] 2>/dev/null || return 1
    [ "$_cur" -ge 0 ] 2>/dev/null || return 1
    [ "$_new" -gt "$_cur" ]
}

# next_effort <current> — one notch up, saturating at high.
next_effort() {
    # One notch up the CONFIGURED ladder, saturating at its top. The level names live in
    # config (effortLadder), so a vendor adding a level is a config change, not a code change.
    # Set for the child process invoked below, or read by a script that sources this file.
    # ShellCheck cannot see the consumer, so it reports these unused; removing them takes the value away.
    # shellcheck disable=SC2034
    local cur="${1:-}" prev="" lvl found=0 first=""
    local IFS='|'
    for lvl in ${EPAM_EFFORT_LADDER:-low|medium|high|max}; do
        [ -z "$first" ] && first="$lvl"
        if [ "$found" = 1 ]; then echo "$lvl"; return; fi
        [ "$lvl" = "$cur" ] && found=1
    done
    # at the top, or unrecognised: saturate at the top / start at the second level
    if [ "$found" = 1 ]; then echo "$cur"; else echo "$first"; fi
}

# next_ladder_step <rung> <current_model> <current_effort> <tier>
# -> "<model>|<effort>|<temperature>"
#
# THE LADDER'S DECISION, AS A FUNCTION.
#
# This logic used to live inlined across four `case` arms, tangled with logging, rung snapshots,
# monitor updates and budget checks, reading ~20 variables from the enclosing scope. It could
# only be exercised by reconstructing the whole retry loop — so every ladder defect this week
# (effort de-escalating, rung 1 holding the model fixed, the bump and model not surviving
# re-invocation) was found by paying for a live run instead of by a test.
#
# Pure: no logging, no side effects, no globals beyond the ladder/effort config it reads. Given
# the same inputs it returns the same tuple, which is what makes it assertable.
#
# Invariants it enforces, all of which were violated in production:
#   - EVERY rung steps the model while the chain has a next link (a ladder that does not step
#     is not a ladder)
#   - effort NEVER decreases; a rung's configured effort is a FLOOR, not an assignment
#   - at the top of the chain the model stays put and effort becomes the remaining lever
next_ladder_step() {
    local _rung="${1:-0}" _model="${2:-}" _effort="${3:-}" _tier="${4:-high}"
    local _next_model="$_model" _next_effort="$_effort" _temp

    # Model: step while the configured chain offers a next link.
    local _step
    _step=$(get_model_ladder_step "$_model" "$_tier")
    if [ -n "$_step" ] && [ "$_step" != "$_model" ]; then
        _next_model="$_step"
    fi

    # Effort: the rung's configured level is a floor, never a downgrade.
    local _rung_effort
    case "$_rung" in
        0) _rung_effort="${EPAM_RUNG0_REASONING_EFFORT:-medium}" ;;
        1) _rung_effort="${EPAM_RUNG1_REASONING_EFFORT:-medium}" ;;
        2) _rung_effort="${EPAM_RUNG2_REASONING_EFFORT:-high}" ;;
        *) _rung_effort="${EPAM_RUNG3_REASONING_EFFORT:-high}" ;;
    esac
    # THE RUNG DECIDES. This was max_effort("$_effort", "$_rung_effort") — the rung's level was a
    # FLOOR, so whatever effort arrived could only ever be raised. What arrived was the SEAM's flat
    # declaration, and 33 of 41 seams declare "high", so the ladder's rung-0 "medium" never applied
    # anywhere. The cheap entry rung was never cheap.
    #
    # Measured 2026-09-01 on metrolinx: prompt-builder enters on claude-haiku-4-5 and each call took
    # ~68s to emit ~2000 tokens of what its own registry entry calls "largely RESTATEMENT". Not
    # haiku being slow — haiku reasoning hard, because the seam had overridden the rung. Across 39
    # generated prompts at 2-3 calls each, that is the stage's ~1.5 hours.
    #
    # Operator decision 2026-09-01: a seam is ASSIGNED to a ladder and does not renegotiate what
    # that ladder costs — the rule already settled for iterations, now applied to effort.
    _next_effort="$_rung_effort"

    # When the model cannot move, effort is the only lever left — so it must rise.
    if [ "$_next_model" = "$_model" ] && [ "$_rung" -gt 0 ]; then
        _next_effort=$(max_effort "$_next_effort" "$(next_effort "$_effort")")
    fi

    case "$_rung" in
        0) _temp="${EPAM_RUNG0_TEMPERATURE:-0}" ;;
        1) _temp="${EPAM_RUNG1_TEMPERATURE:-0.2}" ;;
        2) _temp="${EPAM_RUNG2_TEMPERATURE:-0.5}" ;;
        *) _temp="${EPAM_RUNG3_TEMPERATURE:-0.7}" ;;
    esac

    printf '%s|%s|%s' "$_next_model" "$_next_effort" "$_temp"
}

# ladder_models [tier...]
# Every model named anywhere in the configured ladders — the ONLY models permitted to run.
ladder_models() {
    local _t _pair _out="" _var _chain
    # IFS at FUNCTION scope, covering BOTH loops. Set only on the inner loop, the outer one
    # word-split "high|medium|highest" on whitespace — i.e. not at all — producing the single
    # token "high|medium|highest", hence the variable name EPAM_MODEL_LADDER_HIGH|MEDIUM|HIGHEST,
    # hence an empty chain and an empty permitted set. Every pipe-delimited env var in this file
    # needs this at every consumption site; forgetting it does not error, it silently yields one
    # wrong word.
    local IFS='|'
    for _t in ${EPAM_LADDER_TIERS:-high|medium}; do
        _var="EPAM_MODEL_LADDER_$(printf '%s' "$_t" | tr '[:lower:]' '[:upper:]')"
        _chain="${!_var:-}"
        for _pair in $_chain; do
            [ -n "$_pair" ] || continue
            _out="${_out}${_pair%%=*}"$'\n'"${_pair#*=}"$'\n'
        done
    done
    unset IFS
    printf '%s' "$_out" | sed '/^$/d' | sort -u
}

# assert_ladder_model <model> <context>
# OPERATOR RULE: only ladder models are permitted. No exceptions.
#
# The fallback chain used to end at a hardcoded default (gpt-5-codex) that appears in NO ladder,
# so a story whose model failed to resolve ran on a model nobody configured — and the escalation
# chain could not step from it, because it is not a link in any chain. Observed live 2026-08-10:
# "PRD model is 'gpt-5-codex'" while the PRD plainly declared MiniMax-M3. It was masked only
# because the persisted-model resume happened to restore the right one.
#
# Refuses loudly rather than substituting: a silent substitution is how the wrong model ran for
# an entire run without anyone seeing it.
assert_ladder_model() {
    local _model="${1:-}" _ctx="${2:-model resolution}"
    local _permitted; _permitted=$(ladder_models)
    # FAIL CLOSED on a parse failure. "No ladder configured" and "I could not parse the ladder"
    # must never share a branch: the first is a project without a ladder, the second is a bug —
    # and collapsing them turned an IFS slip into blanket permission, with the guard reporting
    # success while enforcing nothing. If tiers ARE configured, an empty permitted set is a bug.
    if [ -z "$_permitted" ]; then
        if [ -n "${EPAM_LADDER_TIERS:-}" ]; then
            error "[$_ctx] ladder tiers are configured (${EPAM_LADDER_TIERS}) but no models could be"
            error "  read from them — the ladder failed to parse. Refusing rather than permitting all."
            return 1
        fi
        return 0                            # genuinely no ladder configured: nothing to enforce
    fi
    if [ -z "$_model" ] || ! printf '%s\n' "$_permitted" | grep -qxF "$_model"; then
        error "[$_ctx] model '${_model:-<empty>}' is not in any configured ladder."
        error "  Permitted: $(printf '%s' "$_permitted" | tr '\n' ' ')"
        error "  Only ladder models are permitted — a model outside the chain cannot escalate,"
        error "  because it is not a link in any chain. Fix the PRD's .model or the ladder config."
        return 1
    fi
    return 0
}

classify_ladder_tier() {
    local story_id="$1"

    # PRD-level explicit override — a story can pin its own tier ("medium" or
    # "high") when the author already knows it's hard, bypassing the
    # historical-signal classifier below. Same override pattern as
    # .retryModel / .model / .aiProvider elsewhere in this file.
    local _prd_tier
    _prd_tier=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .ladderTier // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    # Accept ANY tier the project configures a ladder for. This was `medium|high`, a hardcoded
    # pair, so `ladderTier: "highest"` in a PRD fell through to the historical classifier and the
    # operator's explicit choice was silently discarded — the story then escalated along a ladder
    # it never asked for. Tier names are config (ladders.*), so adding one is a config change.
    if [ -n "$_prd_tier" ]; then
        local _t
        local IFS='|'
        for _t in ${EPAM_LADDER_TIERS:-medium|high}; do
            if [ "$_t" = "$_prd_tier" ]; then echo "$_prd_tier"; return; fi
        done
        unset IFS
        warning "  [InferenceLadder] PRD tier '$_prd_tier' has no configured ladder (available: ${EPAM_LADDER_TIERS:-medium|high}) — falling back to the historical classifier"
    fi

    # ── Novel brownfield code is always the high ladder ───────────────────────
    # User rule, 2026-07-29. Deterministic, not a judgement: the spec pass
    # already sets storyKind (spec-mode-runner.js:2162).
    #
    # CPA cannot decide this, because an underspecified story looks CHEAP and
    # underspecification is exactly what makes a novel feature expensive. Live
    # AMSD-2041 — an empty ticket, no acceptance criteria — was rated
    # effort:"low", estimatedAiMinutes:5.4214, for a novel capability across
    # three repositories attaching to a hook with 236 callers. Every plan in
    # every lane called it novel; CPA still priced it at five minutes, so it
    # started on the cheapest rung and reached a capable model only by burning
    # two timeouts.
    #
    # A defect is different in kind — the fix site is known and bounded, so
    # medium is reasonable and CPA keeps that call. An explicit ladderTier above
    # still wins: a deliberately pinned tier is not overridden.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        local _story_kind
        _story_kind=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .storyKind // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ "$_story_kind" = "novel" ]; then
            echo "high"
            return
        fi
    fi

    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _max_attempt _cycle_count
        _max_attempt=$(jq -s -r --arg sid "$story_id" \
            '[.[] | select(.storyId == $sid) | .attempt] | max // -1' \
            "$_failures_file" 2>/dev/null || echo -1)
        # A prior cycle reaching MAX_RETRIES means it was fully exhausted once
        # already — the next cycle should not repeat the same cheap-first ramp.
        if [ "${_max_attempt:-0}" -ge "${MAX_RETRIES:-7}" ]; then
            echo "high"
            return
        fi

        # Distinct failure timestamps far apart (different watchdog/run
        # cycles) also indicate a genuinely hard story, even if no single
        # cycle hit MAX_RETRIES (e.g. it kept timing out before exhausting
        # attempts).
        _cycle_count=$(jq -r --arg sid "$story_id" \
            'select(.storyId == $sid) | .attempt' \
            "$_failures_file" 2>/dev/null | sort -u | wc -l | tr -d ' ')
        if [ "${_cycle_count:-0}" -ge 6 ]; then
            echo "high"
            return
        fi
    fi

    # Low average diagnosis groundedness is a third, purely measured signal:
    # it means the FailureAnalyst itself keeps having to guess rather than
    # cite verifiable evidence for this story's failures -- a language- and
    # bug-content-agnostic proxy for "this is a genuinely hard story",
    # computed identically for any stack from the DiagnosisGroundedness step
    # every project already runs. Threshold and minimum sample size are both
    # configurable so a low-sample-count story isn't misclassified on noise.
    local _groundedness_file="${LOG_DIR}/failure-diagnosis-groundedness.jsonl"
    if [ -f "$_groundedness_file" ]; then
        local _min_samples="${EPAM_LADDER_GROUNDEDNESS_MIN_SAMPLES:-2}"
        local _threshold="${EPAM_LADDER_GROUNDEDNESS_ESCALATION_THRESHOLD:-0.6}"
        local _avg_and_count
        _avg_and_count=$(jq -s -r --arg sid "$story_id" '
            [.[] | select(.storyId == $sid) | select(.score != null) | .score] as $scores
            | if ($scores | length) > 0
              then "\(($scores | add) / ($scores | length)) \($scores | length)"
              else "1 0"
              end
        ' "$_groundedness_file" 2>/dev/null || echo "1 0")
        local _avg_score _sample_count
        _avg_score=$(echo "$_avg_and_count" | awk '{print $1}')
        _sample_count=$(echo "$_avg_and_count" | awk '{print $2}')
        if [ "${_sample_count:-0}" -ge "$_min_samples" ] 2>/dev/null; then
            if python3 -c "exit(0 if float('${_avg_score:-1}') < float('${_threshold}') else 1)" 2>/dev/null; then
                echo "high"
                return
            fi
        fi
    fi
    echo "medium"
}

# get_model_ladder_step <current_model> [tier]
# Reads EPAM_MODEL_LADDER_<TIER> (pipe-separated "from=to" pairs) and returns
# the next model. Fully configurable — no hardcoded model names in this
# function. tier defaults to "medium"; pass "high" for the stronger ladder.
# EPAM_MODEL_LADDER (no suffix), if explicitly set, overrides BOTH tiers to
# the same ladder — an explicit opt-out of the medium/high split.
# Example:
#   export EPAM_MODEL_LADDER_MEDIUM="MiniMax-M3=zhipuai/glm-z1-32b"
#   export EPAM_MODEL_LADDER_HIGH="MiniMax-M3=deepseek/deepseek-r1"
# Returns empty string when current model is not in the ladder or no ladder is configured.
get_model_ladder_step() {
    local current_model="$1"
    local tier="${2:-medium}"
    local ladder="${EPAM_MODEL_LADDER:-}"
    if [ -z "$ladder" ]; then
        case "$tier" in
            # A tier with no ladder of its own must NOT quietly inherit medium's. Until
            # 2026-08-10 'highest' fell through the catch-all and a story asking for the
            # strongest chain silently escalated along the WEAKEST one — the failure is
            # invisible because a ladder was found and the run looks normal.
            highest) ladder="${EPAM_MODEL_LADDER_HIGHEST:-}"
                     if [ -z "$ladder" ]; then
                         warning "  [InferenceLadder] tier 'highest' has no ladder configured — falling back to high"
                         ladder="${EPAM_MODEL_LADDER_HIGH:-}"
                     fi ;;
            high)    ladder="${EPAM_MODEL_LADDER_HIGH:-}" ;;
            medium)  ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
            *)       warning "  [InferenceLadder] unknown effort tier '$tier' — using medium"
                     ladder="${EPAM_MODEL_LADDER_MEDIUM:-}" ;;
        esac
    fi
    [ -z "$ladder" ] && { echo ""; return; }
    local pair from to IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$ladder"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"
        to="${pair#*=}"
        if [ "$from" = "$current_model" ]; then
            echo "$to"
            return
        fi
    done
    echo ""
}

# resolve_model_provider <model>
# Reads EPAM_MODEL_PROVIDER_MAP (pipe-separated "glob-pattern=provider" pairs)
# and returns the provider for a model name, matched via bash glob patterns —
# no hardcoded vendor/model names in this function. Per-project tier scripts
# supply their own map (e.g. tier3-travel-app-run.sh sets
# "zhipuai/*=openrouter|moonshotai/*=openrouter|z-ai/*=openrouter|glm-*=openrouter|kimi-*=openrouter|deepseek/*=openrouter|MiniMax-*=minimax"
# because this project routes all OpenRouter-hosted vendors through the
# "openrouter" provider umbrella and MiniMax direct-API models through "minimax").
# Root cause this replaces: the escalation-ladder code used to hardcode this
# exact vendor-name case statement twice inline (found live, 2026-07-06) —
# a project using different model vendors/providers would get silently wrong
# (or no) provider routing after a model-ladder step. Returns empty string
# when no map is configured or no pattern matches (caller keeps STORY_PROVIDER
# unchanged in that case, same as before).
resolve_model_provider() {
    local model="$1"
    local map="${EPAM_MODEL_PROVIDER_MAP:-}"
    [ -z "$map" ] && { echo ""; return; }
    local pair pattern provider IFS_SAVE="$IFS"
    IFS='|'
    read -ra pairs <<< "$map"
    IFS="$IFS_SAVE"
    for pair in "${pairs[@]}"; do
        pattern="${pair%%=*}"
        provider="${pair#*=}"
        # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
        case "$model" in
            $pattern) echo "$provider"; return ;;
        esac
    done
    echo ""
}

# sync_provider_to_model
#
# MODEL AND PROVIDER ARE ONE DECISION. Several escalation arms re-resolve the provider after
# changing the model; the invocation trusted that every arm did. On 2026-08-18 one did not, and
# ten of twelve writer attempts asked the minimax provider for z-ai/glm-5.2:
#
#   minimax + MiniMax-M3    exit=0  413 bytes
#   openrouter    + z-ai/glm-5.2  exit=0  410 bytes
#   minimax + z-ai/glm-5.2  exit=1  0 bytes   "All providers exhausted"
#
# Zero bytes and a non-zero exit read as an environment crash, so the coordinator spent the rest
# of the story diagnosing a healthy binary and a healthy key. Both writer stories were already
# correct on disk when the loop gave up.
#
# Resolving at the point of USE means no arm can forget, including one written later. It never
# guesses: a model the map does not know leaves the provider exactly as it was.
sync_provider_to_model() {
    [ -n "${STORY_MODEL:-}" ] || return 0
    local _p
    _p=$(resolve_model_provider "${STORY_MODEL}")
    [ -n "$_p" ] || return 0
    if [ "$_p" != "${STORY_PROVIDER:-}" ]; then
        log "  Provider[follows-model] -> $_p (was ${STORY_PROVIDER:-unset}; model is ${STORY_MODEL})"
        STORY_PROVIDER="$_p"
    fi
    return 0
}

# assess_model_escalation <story_id> <raw_file> <result_json> <log_file>
# Layer 2 (opt-in): LLM coordinator gate for Class B/C failures.
# Sets COORDINATOR_ESCALATE and COORDINATOR_PROMPT_AMENDMENT.
# Only called when EPAM_MODEL_COORDINATOR_ENABLED=1.
assess_model_escalation() {
    local story_id="$1"
    local raw_file="${2:-}"
    local result_json="${3:-}"
    local log_file="${4:-}"
    local target_model="${5:-}"  # the model we're about to escalate to

    [ "${EPAM_MODEL_COORDINATOR_ENABLED:-0}" != "1" ] && return

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${EPAM_MODEL:-}"
    # A capability that silently does not run is indistinguishable from one that ran and found
    # nothing. Say which happened.
    if [ -z "$gate_provider" ]; then
        log "  [ModelEscalation] no gate provider configured — SKIPPING escalation assessment; this run performs none"
        return
    fi

    # Read failure evidence (cap at 3000 chars to stay within gate model budget)
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    local log_tail=""
    [ -f "$log_file" ] && log_tail=$(tail -30 "$log_file" 2>/dev/null || echo "")
    # Include specific test failure output when available (Quality class failures)
    local test_failure_snippet="$VERIFICATION_FAILURE"
    # Cross-run memory: include prior failure pattern count for context
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    local prior_failure_summary=""
    if [ -f "$_failures_file" ]; then
        local _pf_count
        _pf_count=$(jq -r --arg sid "$story_id" 'select(.storyId == $sid) | .failureClass' \
            "$_failures_file" 2>/dev/null | sort | uniq -c | sort -rn | head -5 || echo "")
        [ -n "$_pf_count" ] && prior_failure_summary="Prior failure pattern (this story across runs): ${_pf_count}"
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_title
    story_title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // ""' "$prd_target" 2>/dev/null || echo "")
    local current_model="${STORY_MODEL:-unknown}"

    local coordinator_prompt
    # The four evidence blocks, through files: an agent result and a log tail are unbounded and
    # argv is capped at ARG_MAX. Each carries the fallback the prompt used to hold inline.
    local _ilc_result_file _ilc_log_file _ilc_tf_file _ilc_prior_file
    _ilc_result_file=$(mktemp "${TMPDIR:-/tmp}/ilc-result-XXXXXX.txt")
    _ilc_log_file=$(mktemp "${TMPDIR:-/tmp}/ilc-log-XXXXXX.txt")
    _ilc_tf_file=$(mktemp "${TMPDIR:-/tmp}/ilc-tf-XXXXXX.txt")
    _ilc_prior_file=$(mktemp "${TMPDIR:-/tmp}/ilc-prior-XXXXXX.txt")
    printf '%s' "${result_text:-"(empty — agent produced no result)"}" > "$_ilc_result_file"
    printf '%s' "${log_tail:-"(no log available)"}" > "$_ilc_log_file"
    printf '%s' "${test_failure_snippet:-"(no test failure output)"}" > "$_ilc_tf_file"
    printf '%s' "${prior_failure_summary:-"(no prior failures recorded for this story)"}" > "$_ilc_prior_file"
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/inference-ladder-coordinator-vals-XXXXXX.json")
    jq_vals \
          --rawfile result_text "$_ilc_result_file" \
          --rawfile log_tail "$_ilc_log_file" \
          --rawfile test_failure_snippet "$_ilc_tf_file" \
          --rawfile prior_failure_summary "$_ilc_prior_file" \
      --arg story_id "$story_id" \
      --arg story_title "$story_title" \
      --arg current_model "$current_model" \
      --arg target_model "$target_model" \
      --arg coordinator_failure_class "$COORDINATOR_FAILURE_CLASS" \
          '{"__RESULT_TEXT__":$result_text,"__LOG_TAIL__":$log_tail,"__TEST_FAILURE_SNIPPET__":$test_failure_snippet,"__PRIOR_FAILURE_SUMMARY__":$prior_failure_summary,"__STORY_ID__":$story_id,"__STORY_TITLE__":$story_title,"__CURRENT_MODEL__":$current_model,"__TARGET_MODEL__":$target_model,"__COORDINATOR_FAILURE_CLASS__":$coordinator_failure_class}' > "$_cp_vals"
    coordinator_prompt="$(render_engine_prompt inference-ladder-coordinator "$_cp_vals")"
    rm -f "$_cp_vals"
    rm -f "$_ilc_result_file" "$_ilc_log_file" "$_ilc_tf_file" "$_ilc_prior_file"

    local coord_result_file
    coord_result_file=$(mktemp /tmp/coord-${story_id}-XXXXXX.json)

    local coord_raw=""
    if coord_raw=$(echo "$coordinator_prompt" | \
            AI_PROVIDER="$gate_provider" \
            AI_MODEL="$gate_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
            ${gate_model:+--model "$gate_model"} \
            2>/dev/null); then
        # Parse coordinator response
        local coord_json=""
        # Extract JSON object from response (strip any preamble)
        coord_json=$(echo "$coord_raw" | grep -o '{[^}]*}' | head -1 || echo "")
        if [ -n "$coord_json" ] && echo "$coord_json" | jq empty 2>/dev/null; then
            local coord_escalate
            coord_escalate=$(echo "$coord_json" | jq -r '.escalate // "yes"' 2>/dev/null || echo "yes")
            local coord_class
            coord_class=$(echo "$coord_json" | jq -r '.failure_class // "unknown"' 2>/dev/null || echo "unknown")
            local coord_amendment
            coord_amendment=$(echo "$coord_json" | jq -r '.prompt_amendment // ""' 2>/dev/null || echo "")
            local coord_rationale
            coord_rationale=$(echo "$coord_json" | jq -r '.rationale // ""' 2>/dev/null || echo "")

            COORDINATOR_ESCALATE="$coord_escalate"
            COORDINATOR_FAILURE_CLASS="$coord_class"
            COORDINATOR_PROMPT_AMENDMENT="$coord_amendment"
            log "  Coordinator[L2]: escalate=$coord_escalate class=$coord_class rationale='$coord_rationale'"
            [ -n "$coord_amendment" ] && log "  Coordinator[L2]: prompt_amendment injected (${#coord_amendment} chars)"
        else
            warning "  Coordinator[L2]: could not parse coordinator response — keeping L1 decision"
        fi
    else
        warning "  Coordinator[L2]: coordinator call failed — keeping L1 decision"
    fi

    rm -f "$coord_result_file"
}

# run_prd_change_reviewer <story_id> <change_type> <before_json> <after_json>
# Validates a proposed PRD AC/TC or profiles.json change using the gate model.
# change_type: ac_patch | tc_patch | skill_note | profile_addendum
# Echoes "pass" or "fail"; caller decides whether to revert on fail.
# Silently returns "pass" if gate model is not configured (non-blocking).
run_prd_change_reviewer() {
    local story_id="$1"
    local change_type="$2"
    local before_json="$3"
    local after_json="$4"

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    if [ -z "$gate_provider" ]; then
        # A GATE THAT CANNOT JUDGE DOES NOT PASS. This emitted a literal "pass", so with no gate
        # provider configured every KB/PRD/profile write was AUTO-APPROVED and the caller read a
        # manufactured verdict as a real one — indistinguishable from a review that ran and found
        # nothing wrong.
        #
        # 'unreviewed' is the honest answer and callers already understand it:
        # reviewOutcomeKeepsChange() accepts only an explicit pass, so the change reverts rather
        # than standing on a judgement nobody made.
        error "  [PRD-ChangeReviewer] no gate provider configured — NOT reviewing; returning 'unreviewed' so the change is not kept on an unmade judgement" >&2
        echo "unreviewed"
        return 0
    fi
    # KB/PRD/profile writes are persistent and must be reviewed by the highest-quality
    # model available, not the cheap gate model. Use ESCALATION_MODEL_HIGH with high
    # reasoning so every persisted write is agentic-quality-reviewed.
    # THE REVIEWER'S OWN SEAM. This was a run-wide "high" model behind a run-wide pin behind a
    # vendor literal — three sources, none of them the ladder, and the literal always answered so
    # the ladder never had to.
    local gate_model
    gate_model=$(seam_model_or_fail "prd-change-reviewer" 2>/dev/null || printf '')

    # Select profile based on change type — KB entries use the stricter kb-change-reviewer
    local _profile_key="prd-change-reviewer"
    [ "$change_type" = "kb_entry" ] && _profile_key="kb-change-reviewer"
    local reviewer_profile=""
    if [ -f "$profiles_file" ]; then
        reviewer_profile=$(require_profile "$_profile_key" "$profiles_file" || true)
    fi

    local review_prompt
    # RENDERED FROM THE TEMPLATE LAYER. Values go via a FILE, never argv: before/after carry
    # whole PRD fragments, and a value past ARG_MAX exits 126 with an empty result — which is
    # how the FailureAnalyst died silently earlier today.
    local _rv_vals; _rv_vals=$(mktemp "${TMPDIR:-/tmp}/prd-review-vals-XXXXXX.json")
    jq_vals --arg profile "$reviewer_profile" --arg story "$story_id" --arg ct "$change_type" \
          --rawfile before <(printf '%s' "$before_json") --rawfile after <(printf '%s' "$after_json") \
          '{"__REVIEWER_PROFILE__":$profile,"__STORY_ID__":$story,"__CHANGE_TYPE__":$ct,"__BEFORE__":$before,"__AFTER__":$after}' \
          > "$_rv_vals" 2>/dev/null
    if ! review_prompt=$(render_engine_prompt prd-change-reviewer "$_rv_vals"); then
        # >&2 REQUIRED: this function returns its verdict on STDOUT, so any log written to
        # stdout is read as part of the verdict. There is a test for exactly this.
        error "  [PRD-Reviewer] cannot render its prompt — refusing to review with no instructions" >&2
        rm -f "$_rv_vals"; return 1
    fi
    rm -f "$_rv_vals"

    local review_raw=""
    # Full agent audit, 2026-07-31 (same class as HEAL-BLIND): several of this
    # reviewer's own rejection rules require checking a claim against the real
    # codebase (stack/tech usage, TC-fact verifiability), but this call had no
    # tool access at all — a live incident already occurred (rejected correct
    # Contentstack advice for Metrolinx with no way to check the real stack).
    # Reuses the same shared, read-only allowlist every other gate agent draws
    # from, bounded the same way.
    review_raw=$(echo "$review_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        AI_GATE_ALLOW_TOOLS=1 \
        EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
        EPAM_MAX_TOOL_CALLS="${PRD_CHANGE_REVIEWER_MAX_TOOL_CALLS:-24}" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"verdict":"fail","issues":["the reviewer could not be reached — the change was NOT reviewed"],"reason":"reviewer unavailable"}')

    # ASKED AND GOT NO ANSWER IS NOT APPROVAL.
    #
    # These defaulted to 'pass' in four places, including an explicit
    # {"verdict":"pass","reason":"reviewer unavailable"} above — a reviewer that could not be
    # reached approved the change and said so in the reason field. This gate covers ac_patch and
    # tc_patch, so that silently accepted edits to acceptance criteria, which are supposed to be
    # immutable. code-review-cycle.sh settled the same question on 2026-07-23: 'SAFE default =
    # BLOCK, never silently approve an unreviewed change'.
    #
    # The documented opt-out above is untouched: with NO gate model configured the reviewer is
    # disabled and returns pass, because it was never asked. That is a different state from
    # asking and getting nothing back.
    local verdict=""
    verdict=$(echo "$review_raw" | python3 "$SCRIPT_DIR/lib/handlers/prd-change-verdict.py" 2>/dev/null || echo "fail")

    local issues=""
    issues=$(echo "$review_raw" | python3 "$SCRIPT_DIR/lib/handlers/prd-change-issues.py" 2>/dev/null || echo "")

    # CRITICAL: this function's return value is captured via command substitution
    # ($(run_prd_change_reviewer ...)). warning()/log() write to stdout as well as
    # the progress log, so any call to them here would pollute the captured verdict
    # with extra lines — making `[ "$verdict" = "fail" ]` at every call site always
    # false (the string would be "warning text\nfail", not "fail"), silently treating
    # every rejection as an approval. Redirect to stderr so only the final echo
    # reaches the caller.
    # Exposes the rejection reason to callers (e.g. run_change_with_reviewer_retry).
    # Every caller invokes this function via $(...) command substitution, which
    # forks a subshell — a plain variable assignment here (PRD_REVIEW_ISSUES=...)
    # would never be visible to the caller's shell. A file survives the subshell
    # exit, so use that instead. $$ scopes the file to this process (worktree
    # primary/independent run as separate PIDs, so no cross-process collision).
    printf '%s' "$issues" > "${TMPDIR:-/tmp}/.prd-review-issues-$$" 2>/dev/null || true

    if [ "$verdict" = "fail" ]; then
        warning "  [PRD-Reviewer] REJECTED ${change_type} for ${story_id}: ${issues:-no details}" >&2
        echo "fail"
    else
        log "  [PRD-Reviewer] APPROVED ${change_type} for ${story_id}" >&2
        echo "pass"
    fi
}

# run_prd_change_summarizer <story_id> <change_type> <issues> <rejected_text>
# Rewrites rejected self-heal text to address the reviewer's stated issues instead
# of discarding it outright. Most kb_entry/skill_note rejections are FORMAT problems
# (over 200 chars, wrong verb tense, references a specific story ID, truncated
# mid-sentence) — the underlying lesson is usually sound, only its shape is wrong.
# Prints the reformatted text to stdout (falls back to the original text if the
# gate model is unavailable or returns nothing usable).
run_prd_change_summarizer() {
    local story_id="$1"
    local change_type="$2"
    local issues="$3"
    local rejected_text="$4"

    # THE SAME CHAIN ITS FAMILY USES. ac-gate.js, codeline-discovery.js and cpa-inference.js all
    # consult EPAM_ORCHESTRATION_PROVIDER before giving up; this one read ORCH_GATE_PROVIDER alone,
    # so a run that set the orchestration provider and not the gate provider lost EVERY rewrite.
    local gate_provider="${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
    if [ -z "$gate_provider" ]; then
        # DEGRADING IS FINE; DEGRADING IN SILENCE IS NOT. This returned the rejected text with no
        # diagnostic and exit 0, and the caller assigns the result as the rewritten value
        # (current=$(run_prd_change_summarizer ...)) — so the content a reviewer had just rejected
        # flowed onward as though it had been fixed. The text is still returned, because the caller
        # must not be left with nothing; what changes is that the skip is now visible.
        error "  [PRD-Summarizer] no provider resolved (ORCH_GATE_PROVIDER and EPAM_ORCHESTRATION_PROVIDER are both unset) — skipping the rewrite; the REJECTED text is being returned unchanged" >&2
        printf '%s' "$rejected_text"
        return 0
    fi
    # Summarizer rewrites rejected KB/PRD/profile writes — must use the same
    # high-quality model as the reviewer so the rewrite is meaningfully better.
    # THE REVIEWER'S OWN SEAM. This was a run-wide "high" model behind a run-wide pin behind a
    # vendor literal — three sources, none of them the ladder, and the literal always answered so
    # the ladder never had to.
    local gate_model
    gate_model=$(seam_model_or_fail "prd-change-reviewer" 2>/dev/null || printf '')

    # tool_creation rewrites a bash script, not a short prose rule — the
    # kb_entry/skill_note constraints (single line, under 200 chars, imperative
    # verb) would corrupt working code. Branch the prompt AND the post-processing
    # (no `tr -d '\n'` — a script needs its newlines) by change type.
    local summarize_prompt output_cap _sum_template
    if [ "$change_type" = "tool_creation" ]; then
        _sum_template="prd-change-summarizer-tool"
        output_cap=4000
    else
        _sum_template="prd-change-summarizer-text"
        output_cap=400
    fi

    # One renderer for both variants; the branch above chose WHICH prompt, not its text.
    local _sum_vals; _sum_vals=$(mktemp "${TMPDIR:-/tmp}/prd-sum-vals-XXXXXX.json")
    # Each variant gets exactly the values ITS template uses. The renderer rejects a value
    # nobody uses, deliberately: an extra value means the caller believes it supplied something
    # the prompt never mentions, which is the same defect as a missing one seen from the other
    # side. The tool variant carries no change type — a bash script is a bash script.
    if [ "$_sum_template" = "prd-change-summarizer-tool" ]; then
        jq_vals --arg story "$story_id" \
              --rawfile issues <(printf '%s' "${issues:-no details}") \
              --rawfile rejected <(printf '%s' "$rejected_text") \
              '{"__STORY_ID__":$story,"__ISSUES__":$issues,"__REJECTED_TEXT__":$rejected}' \
              > "$_sum_vals" 2>/dev/null
    else
        jq_vals --arg story "$story_id" --arg ct "$change_type" \
              --rawfile issues <(printf '%s' "${issues:-no details}") \
              --rawfile rejected <(printf '%s' "$rejected_text") \
              '{"__STORY_ID__":$story,"__CHANGE_TYPE__":$ct,"__ISSUES__":$issues,"__REJECTED_TEXT__":$rejected}' \
              > "$_sum_vals" 2>/dev/null
    fi
    if ! summarize_prompt=$(render_engine_prompt "$_sum_template" "$_sum_vals"); then
        # >&2 REQUIRED: the caller captures this function with command substitution
        # (current=$(run_prd_change_summarizer ...)), so a log on stdout becomes the rewritten
        # text. Same hazard as the reviewer above.
        error "  [PRD-Summarizer] cannot render '$_sum_template' — refusing to rewrite with no instructions" >&2
        rm -f "$_sum_vals"; return 1
    fi
    rm -f "$_sum_vals"

    local summarized=""
    summarized=$(echo "$summarize_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        EPAM_REASONING_EFFORT="high" \
        EPAM_TEMPERATURE="0.7" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null | head -c "$output_cap" || echo "")
    if [ "$change_type" = "tool_creation" ]; then
        summarized="$(echo "$summarized" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    else
        summarized="$(echo "$summarized" | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    fi

    if [ -n "$summarized" ]; then
        printf '%s' "$summarized"
    else
        printf '%s' "$rejected_text"
    fi
}

# _skill_note_format_ok <note> <story_id> <existing_profile_text>
# Deterministic pre-check for the OBJECTIVELY verifiable skill_note/kb_entry
# format rules already stated in profiles.json's prd-change-reviewer /
# kb-change-reviewer profiles: length cap, imperative opener, no story-ID
# reference, not a verbatim duplicate of an existing line in the same
# profile. These are checkable facts, not subjective judgment calls -- yet a
# live run (2026-07-07) observed the LLM reviewer reject notes that already
# satisfied every one of these rules (e.g. "Always end TypeScript statements
# with semicolons...", well under 200 chars, no story ID), 3/3 times, purely
# on flaky format judgment. That burns a gate round-trip per rejection for
# zero benefit. When a candidate passes this check, skip the LLM review
# entirely for format -- genuinely subjective calls (does this CONTRADICT an
# existing rule, is the underlying lesson actually sound) are out of scope
# here and still need a real reviewer, so this only short-circuits the
# specific failure mode that was observed wasting cost.
# The declared skill-note length limit. One source (config/self-heal.json), read by the checker
# here and handed to the failure analyst so it writes within it in the first place.
_skill_note_max_chars() {
    local _cfg="${AUTOMATION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/config/self-heal.json"
    local _v=""
    [ -f "$_cfg" ] && _v=$(jq -r '.skillNote.maxChars // empty' "$_cfg" 2>/dev/null)
    case "$_v" in (''|*[!0-9]*) 
        echo "[skill-note] config/self-heal.json declares no numeric skillNote.maxChars — refusing to guess a limit" >&2
        return 1 ;;
    esac
    printf '%s' "$_v"
}

_skill_note_format_ok() {
    local note="$1"
    local story_id="$2"
    local existing_profile_text="${3:-}"
    [ -z "$note" ] && return 1
    # THE DECLARED LIMIT, NOT A NUMBER WRITTEN HERE. See config/self-heal.json: the producer is
    # told the same value, so a note no longer has to be rejected and rewritten to discover it.
    local _max; _max=$(_skill_note_max_chars)
    [ "${#note}" -le "$_max" ] || return 1
    echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b" || return 1
    if [ -n "$story_id" ] && echo "$note" | grep -qi "$story_id"; then
        return 1
    fi
    if [ -n "$existing_profile_text" ] && echo "$existing_profile_text" | grep -qF "$note"; then
        return 1
    fi
    return 0
}

# _ensure_imperative_opener <note>
# Deterministically normalizes a skill_note/kb_entry candidate to satisfy
# _skill_note_format_ok's imperative-opener check, WITHOUT ever needing an
# LLM rewrite round-trip. Closes a live gap (2026-07-12, tier3-travel-app
# run): SKY-002-impl's FailureAnalyst produced a genuinely correct, specific
# note -- "When converting an interface to Record<string, unknown>, ensure
# the interface has an index signature or use 'unknown' first to avoid
# TS2352 error." -- but it opens with a subordinate "When X, ..." clause,
# not an imperative, so it correctly failed the deterministic format check
# and went through the full LLM reviewer 3 times on this SAME fixable
# wording issue, then was persisted UNREVIEWED as a fallback. The lesson
# itself was fine; only the opening word was wrong -- a mechanically
# fixable defect, not a judgment call. Prepending
# SKILL_NOTE_NORMALIZATION_OPENER (a configurable var, checked against the
# SAME SKILL_NOTE_IMPERATIVE_OPENERS list _skill_note_format_ok uses -- no
# word list duplicated or hardcoded independently in either function) is a
# generic, content-preserving transform (not a rewrite) that reliably
# satisfies the imperative check for ANY note shape, so apply it BEFORE the
# note is ever handed to run_change_with_reviewer_retry, letting an
# otherwise-sound note skip the LLM reviewer entirely on the very first
# attempt.
_ensure_imperative_opener() {
    local note="$1"
    [ -z "$note" ] && { printf ''; return 0; }
    if echo "$note" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    # Sanity-check the configured normalization opener is itself an accepted
    # word (not assumed) -- if misconfigured, fall through without
    # normalizing rather than prepend something that wouldn't pass the check
    # anyway.
    if ! echo "$SKILL_NOTE_NORMALIZATION_OPENER" | grep -Eiq "^(${SKILL_NOTE_IMPERATIVE_OPENERS})\\b"; then
        printf '%s' "$note"
        return 0
    fi
    # NO TRUNCATION. This function PREPENDS an opener, which makes the string LONGER;
    # cutting the tail to compensate destroys the END of the instruction — where the fix
    # lives. Live 2026-08-11, AMSD-2041/gotransit: the analyst correctly diagnosed a Jest
    # ESM failure and this line delivered "...change the pattern to
    # '/node_modules/(?!swiper|@azure|uu" to the writer. Told to change a regex, never told
    # to what. Eight attempts, three ladder rungs, the run lost, on a one-line config fix.
    # A severed instruction is not shorter guidance, it is confidently wrong guidance.
    printf '%s' "${SKILL_NOTE_NORMALIZATION_OPENER}: ${note}"
}

# _tool_recipe_reinvokes_test_cmd <recipe> <test_cmd>
# Deterministic pre-check for a dynamic-tool recipe re-running the project's
# OWN configured test command (e.g. "npm test") as part of its own recipe.
#
# Root cause this closes (found live, 2026-07-11/12, tier3-travel-app run,
# SKY-004-test): a dynamic tool (build-before-test.sh) whose stated purpose
# was "ensure the build runs before tests" wrote a recipe of
# `npm run build && npx vitest run` — independently re-invoking the FULL test
# suite a second time, outside the orchestrator's own dedicated, captured
# `run_external_verification()` test run. That duplicate, uncaptured
# invocation is a real risk: any stray output it produces (or any process it
# leaves running) is NOT isolated from the orchestrator's own subsequent
# capture of $test_output, which is fed directly into the failure-analyst's
# next diagnosis as trusted ground truth. A tool's job is the ONE mechanical
# step it was written for (installing a dependency, running a build) — never
# a second, uncoordinated run of the test suite itself.
#
# Generic/config-driven, not hardcoded to any test runner: compares the
# recipe against THIS project's own resolved test command (passed in from
# run_external_verification's LAST_TEST_CMD), not a fixed "vitest"/"jest"
# pattern list.
_tool_recipe_reinvokes_test_cmd() {
    local recipe="$1"
    local test_cmd="${2:-}"
    [ -z "$test_cmd" ] && return 1
    echo "$recipe" | grep -qF -- "$test_cmd" && return 0
    return 1
}

# run_change_with_reviewer_retry <story_id> <change_type> <before> <candidate> [max_retries=3]
# Wraps run_prd_change_reviewer with a summarize-and-resubmit loop instead of discarding
# a rejected self-heal change immediately. On rejection, run_prd_change_summarizer
# rewrites the candidate to address the reviewer's stated issues, then resubmits — up
# to <max_retries> total review attempts. This exists because kb_entry/skill_note
# writes were being rejected (and discarded) near-100% of the time on fixable FORMAT
# issues, silently defeating the entire self-heal-persistence mechanism.
# Prints "pass" or "fail" to stdout (same contract as run_prd_change_reviewer).
# Sets REVIEWER_RETRY_TEXT to the final (possibly reformatted) candidate either way.

run_change_with_reviewer_retry() {
    local story_id="$1"
    local change_type="$2"
    local before="$3"
    local candidate="$4"
    local max_retries="${5:-3}"

    # Same subshell-scope issue as PRD_REVIEW_ISSUES: this whole function is also
    # invoked via $(...) by its callers, so a plain REVIEWER_RETRY_TEXT=... here
    # would never reach them. File-based side channel again; callers read it
    # right after the command substitution (see kb)/skill) cases in
    # run_failure_analyst).
    local _issues_file="${TMPDIR:-/tmp}/.prd-review-issues-$$"
    local _retry_text_file="${TMPDIR:-/tmp}/.reviewer-retry-text-$$"

    if { [ "$change_type" = "skill_note" ] || [ "$change_type" = "kb_entry" ]; } \
        && _skill_note_format_ok "$candidate" "$story_id" "$before"; then
        printf '%s' "$candidate" > "$_retry_text_file" 2>/dev/null || true
        log "  [PRD-Reviewer] Skipped LLM review for ${change_type} (${story_id}) -- deterministic format check passed" >&2
        echo "pass"
        return 0
    fi

    local attempt=1
    local current="$candidate"
    local verdict="" review_issues=""
    while [ "$attempt" -le "$max_retries" ]; do
        verdict=$(run_prd_change_reviewer "$story_id" "$change_type" "$before" "$current")
        if [ "$verdict" != "fail" ]; then
            printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
            echo "pass"
            return 0
        fi
        review_issues=$(cat "$_issues_file" 2>/dev/null || echo "")
        if [ "$attempt" -lt "$max_retries" ]; then
            log "  [PRD-Summarizer] Rewriting rejected ${change_type} for ${story_id} (attempt ${attempt}/${max_retries}): ${review_issues:-no details}" >&2
            current=$(run_prd_change_summarizer "$story_id" "$change_type" "$review_issues" "$current")
        fi
        attempt=$((attempt + 1))
    done
    printf '%s' "$current" > "$_retry_text_file" 2>/dev/null || true
    echo "fail"
    return 1
}

# run_diagnosis_groundedness_check <story_id> <diagnosis>
# Advisory-only (2026-07-12): scores the FailureAnalyst's own diagnosis
# against the real failure log (VERIFICATION_FAILURE) using DeepEval's
# GEval metric as an LLM judge over OpenRouter -- see
# orchestrations/scripts/tools/diagnosis-groundedness-check.py for the full
# rationale (a live incident already on record for this pipeline: the
# analyst confidently asserted a root cause that was flatly wrong, and every
# retry then "fixed" the wrong thing because the diagnosis guiding it was
# false). Logs to orchestrations/logs/failure-diagnosis-groundedness.jsonl
# so a future decision to make this blocking is backed by measurement, not
# guesswork -- it NEVER alters target/patch handling, and the call site
# deliberately does not capture this function's return value.
# Silently no-ops (no warning spam) if the venv/script/API key isn't
# available, so this optional tooling can never break the retry loop.
run_diagnosis_groundedness_check() {
    local story_id="$1"
    local diagnosis="$2"
    is_truthy "${SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK:-}" && return 0

    local _dgc_script="${SCRIPT_DIR}/tools/diagnosis-groundedness-check.py"
    local _dgc_venv_python="${SCRIPT_DIR}/tools/.venv-deepeval/bin/python"
    [ -x "$_dgc_venv_python" ] || return 0
    [ -f "$_dgc_script" ] || return 0

    local _dgc_input
    # --rawfile, not --arg: VERIFICATION_FAILURE carries a whole suite dump since the input
    # caps were removed, and argv tops out at ARG_MAX. With --arg, jq exited 126 and the
    # empty result was read as "nothing to diagnose" one line below — a gate that fails OPEN
    # precisely when the evidence is largest.
    local _dgc_dir; _dgc_dir=$(mktemp -d "${TMPDIR:-/tmp}/dgc-XXXXXX")
    printf '%s' "${VERIFICATION_FAILURE:-}" > "$_dgc_dir/log"
    local _dgc_err="$_dgc_dir/err"
    if ! _dgc_input=$(jq -n --arg diag "$diagnosis" --rawfile log "$_dgc_dir/log" \
        '{diagnosis: $diag, log_excerpt: $log}' 2>"$_dgc_err"); then
        warning "  [DiagnosisGate] could not build input (jq failed): $(cat "$_dgc_err" 2>/dev/null)"
        rm -rf "$_dgc_dir"
        return 0
    fi
    rm -rf "$_dgc_dir"
    [ -z "$_dgc_input" ] && return 0

    local _dgc_result
    _dgc_result=$(echo "$_dgc_input" | timeout 30 "$_dgc_venv_python" "$_dgc_script" 2>/dev/null)
    [ -z "$_dgc_result" ] && return 0
    echo "$_dgc_result" | jq empty 2>/dev/null || return 0

    # NOTE: `.skipped // true` would be wrong here -- jq's `//` alternative
    # operator treats a literal `false` value as falsy too (not just null/
    # absent), so it would silently collapse a genuine {"skipped": false}
    # result into "true" and this check would NEVER accept a real
    # evaluation. `has("skipped")` distinguishes "field present and false"
    # from "field absent" correctly.
    local _dgc_skipped
    _dgc_skipped=$(echo "$_dgc_result" | jq -r 'if has("skipped") then .skipped else true end' 2>/dev/null)
    [ "$_dgc_skipped" = "true" ] && return 0

    local _dgc_verdict _dgc_score
    _dgc_verdict=$(echo "$_dgc_result" | jq -r '.verdict // "unknown"' 2>/dev/null)
    _dgc_score=$(echo "$_dgc_result" | jq -r '.score // 0' 2>/dev/null)
    if [ "$_dgc_verdict" = "ungrounded" ]; then
        warning "  [DiagnosisGroundedness] $story_id: diagnosis may be ungrounded (score=$_dgc_score) — advisory only, not blocking"
    else
        log "  [DiagnosisGroundedness] $story_id: diagnosis grounded (score=$_dgc_score)"
    fi

    mkdir -p "${LOG_DIR}" 2>/dev/null
    # -c (compact) is required here, not cosmetic: without it jq pretty-
    # prints each object across multiple lines, breaking the "one JSON
    # object per line" contract every JSONL consumer (line-based tailing,
    # wc -l counting, streaming parsers) depends on -- found live 2026-07-12
    # while building a report script against this exact file.
    jq -nc --arg story "$story_id" --arg diag "$diagnosis" --argjson result "$_dgc_result" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, diagnosis: $diag, timestamp: $ts} + $result' \
        >> "${LOG_DIR}/failure-diagnosis-groundedness.jsonl" 2>/dev/null || true
    return 0
}

# run_failure_analyst <story_id> <output_file> <retry_num>
# Layer 3 (self-heal): AI reads the test failure, diagnoses root cause, then patches
# PRD ACs (for ambiguous specs) or injects skill guidance into the coordinator
# amendment (for bad coding patterns) — before the next retry.
# Only meaningful when VERIFICATION_FAILURE is set (external test suite failed).
# Uses ORCH_GATE_PROVIDER/ORCH_GATE_MODEL (same gate as assess_model_escalation).
run_failure_analyst() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local retry_num="${3:-0}"

    # WHICH SEAM THIS IS — declared ONCE, and it must match a key in the profiles registry or the
    # ladder resolves no tier and the agent silently never escalates.
    #
    # Live defect, same day it was written: two call sites in this function passed
    # "failure-analyst", which the registry does not contain. _agent_ladder_tier returned empty,
    # agent_ladder_model handed back the current model unchanged, and the analyst's ladder — the
    # whole point of the change — did nothing. The harness that "verified" it passed the real
    # archetype name, so it never saw what production actually sent.
    local _ANALYST_SEAM="impl-failure-analyst"

    # Only analyze test-suite failures; missing-deliverable failures lack useful output
    [ -z "${VERIFICATION_FAILURE:-}" ] && return 0

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    # Failure analyst uses ESCALATION_MODEL (z-ai/glm-5.2) when set — never openrouter chat models;
    # falls back to ORCH_GATE_MODEL only when no escalation model is configured.
    # THE SEAM'S LADDER, not a run-wide pin. ORCH_GATE_MODEL reached every seam that could
    # not resolve one itself; .env set it to z-ai/glm-5.2, so a mockserver run asked for an
    # OpenRouter model. An unresolvable seam yields empty and the caller refuses, as before.
    local gate_model="${ESCALATION_MODEL:-$(seam_model_or_fail "agent-failure-analyst" 2>/dev/null || true)}"
    if [ -z "$gate_provider" ]; then
        log "  [FailureAnalyst] No gate provider configured — skipping self-heal analysis"
        return 0
    fi

    log "  [FailureAnalyst] Analyzing test failure for $story_id (gate=$gate_model)..."
    "$SCRIPT_DIR/update-monitor.sh" story_start "failure-analyst" "main" "failure-analyst" "Failure Analyst: $story_id" \
        "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
    "$SCRIPT_DIR/update-monitor.sh" event "self_heal_start" \
        "Self-heal started for $story_id (attempt $retry_num, gate=$gate_model)" \
        "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Build spec context: prefer testCriteria.facts (ground truth from TC writer) over ACs
    local story_acs story_role skill_addendum profiles_file
    local tc_facts_raw
    tc_facts_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .testCriteria.facts // [] | to_entries | map("TC\(.key+1): \(.value)") | join("\n")' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$tc_facts_raw" ]; then
        story_acs="$tc_facts_raw"
    else
        story_acs=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .acceptanceCriteria // [] | to_entries | map("AC\(.key+1): \(.value)") | join("\n")' \
            "$prd_target" 2>/dev/null || echo "(no ACs found)")
    fi
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    skill_addendum=""
    if [ -f "$profiles_file" ]; then
        # profiles.json is flat {role: "prompt string"} — extract [Self-Heal] lines only
        skill_addendum=$(jq -r --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null | \
            grep '\[Self-Heal\]' || echo "")
    fi

    # Load failure-analyst profile from profiles.json (role-level instructions)
    local analyst_profile=""
    if [ -f "$profiles_file" ]; then
        analyst_profile=$(require_profile "failure-analyst" "$profiles_file" || true)
    fi

    # Dependency contract injection (added 2026-07-07): same ground-truth
    # mechanism already proven for build_implementation_prompt() — the
    # failure-analyst was previously diagnosing failures with NO visibility
    # into a dependency's REAL exports/signatures, and got it wrong on a live
    # run: it called a casing-typo'd import ("SkyScannerClient" vs the real
    # "SkyscannerClient") a "default vs named export mismatch," which is
    # simply false — the class IS correctly a named export, just mis-cased.
    # Every retry (including the strongest configured model) then "fixed" the
    # wrong thing because the diagnosis GUIDING it was wrong. A stronger model
    # can't out-reason a false premise it's been handed as ground truth.
    local dependency_contracts=""
    local _fa_dep_ids_json
    _fa_dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _fa_dep_id
    while IFS= read -r _fa_dep_id; do
        [ -z "$_fa_dep_id" ] && continue
        local _fa_contract_file="$PROJECT_ROOT/.contracts/${_fa_dep_id}.md"
        if [ -f "$_fa_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_fa_dep_id}
$(cat "$_fa_contract_file")
"
        fi
    done < <(echo "$_fa_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    # Third-party package grounding — the SAME defect this call exists to catch
    # was itself caused by an ungrounded diagnosis: the analyst classified
    # "Config object doesn't match the SDK's Config type" as target=none
    # ("transient — retry with a stronger model") three times running, because
    # it had no more ability to see the SDK's real shape than the implementer
    # did. Ground it here too, from the same declared files, using the same
    # discovery this function's caller (build_implementation_prompt) already
    # runs — reuses .epam/dependency-check.json + .epam/contract-generation.json,
    # no manifest = no-op.
    local _fa_vendor_files_json _fa_vendor_file _fa_vendor_pkg
    _fa_vendor_files_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
        "$prd_target" 2>/dev/null || echo "[]")
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        _fa_vendor_files_json="${_fa_vendor_files_json//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi
    while IFS= read -r _fa_vendor_file; do
        [ -z "$_fa_vendor_file" ] && continue
        local _fa_vendor_abs
        [[ "$_fa_vendor_file" = /* ]] && _fa_vendor_abs="$_fa_vendor_file" || _fa_vendor_abs="$PROJECT_ROOT/$_fa_vendor_file"
        _fa_vendor_abs="$(_resolve_deliverable_path "$_fa_vendor_abs" 2>/dev/null || echo "$_fa_vendor_abs")"
        [ -f "$_fa_vendor_abs" ] || continue
        while IFS= read -r _fa_vendor_pkg; do
            [ -z "$_fa_vendor_pkg" ] && continue
            local _fa_vendor_contract="$PROJECT_ROOT/.contracts/vendor-${_fa_vendor_pkg}.md"
            [ -f "$_fa_vendor_contract" ] || _generate_vendor_contract "$PROJECT_ROOT" "$_fa_vendor_pkg" 2>/dev/null
            if [ -f "$_fa_vendor_contract" ]; then
                dependency_contracts="${dependency_contracts}
### Vendor package: ${_fa_vendor_pkg}
$(cat "$_fa_vendor_contract")
"
            fi
        done < <(_discover_vendor_packages "$_fa_vendor_abs" 2>/dev/null)
    done < <(echo "$_fa_vendor_files_json" | jq -r '.[]?' 2>/dev/null)

    [ -z "$dependency_contracts" ] && dependency_contracts="(no dependency contracts available)"

    local analyst_prompt
    # THE ANALYST PROMPT IS A PROJECT-AUTHORITY FILE, never a heredoc in this engine.
    # orchestrations/prompts/templates/failure-analyst.json is the immutable generic source
    # it was minted from and is NEVER executed. A missing project prompt is a HARD FAILURE:
    # there is deliberately nothing to fall back to, because a silent degrade to a generic
    # template is how an engine-embedded prompt runs for a whole campaign unnoticed.
    #
    # Values go via a JSON file, not argv: they routinely carry newlines, quotes and
    # megabytes of test output. The renderer substitutes with a replacer FUNCTION, so a \$&
    # or \$1 inside a diff or a log is inserted literally instead of being read as a
    # replacement pattern.
    local _analyst_values _analyst_values_err
    _analyst_values=$(mktemp "${TMPDIR:-/tmp}/analyst-values-XXXXXX.json")
    _analyst_values_err="${_analyst_values}.err"

    # VIA --rawfile, NEVER argv.
    #
    # These values used to be passed with `jq --arg`, which puts every byte on the command
    # line. ARG_MAX is 2 MiB; a real suite failure dump exceeds it, so jq exited 126
    # ("Argument list too long"), the redirect wrote a 0-byte file, and `2>/dev/null` threw
    # the reason away. prompt-library then reported only "Unexpected end of JSON input" and
    # the analyst died — live, run 20260815T195931Z, on every retry of AMSD-2041.
    #
    # The caps that used to hide this (VERIFICATION_FAILURE:0:1000 and friends) were removed
    # deliberately: no agent input is cut mid-meaning. So the transport has to carry the
    # whole thing. --rawfile reads each value from a file and never touches argv.
    local _av_dir; _av_dir=$(mktemp -d "${TMPDIR:-/tmp}/analyst-args-XXXXXX")
    printf '%s' "${analyst_profile:-}"                  > "$_av_dir/profile"
    printf '%s' "${story_acs:-}"                        > "$_av_dir/acs"
    printf '%s' "${skill_addendum:-}"                   > "$_av_dir/addendum"
    printf '%s' "${dependency_contracts:-}"             > "$_av_dir/contracts"
    printf '%s' "${VERIFICATION_FAILURE:-}"             > "$_av_dir/vf"
    _attempt_change_summary "$story_id"                 > "$_av_dir/changes" 2>/dev/null || : > "$_av_dir/changes"

    # THE TEMPLATE DECLARES __MANIFEST_FILE__ AND NOTHING SUPPLIED IT.
    #
    # Live 2026-08-18: the analyst could not build its prompt on any of the twelve writer attempts
    # — "missing values for: __MANIFEST_FILE__" — so the one component whose job is to diagnose a
    # failing writer was blind for the whole story, on both lanes, in the run where it was needed
    # most. The value is the codeline's manifest name, read from the project's own dependency
    # declaration rather than named here, so a project on another stack answers for itself.
    local _analyst_manifest_file=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
        _analyst_manifest_file=$(jq -r '.manifestFile // ""' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null || echo "")
    fi
    [ -n "$_analyst_manifest_file" ] || _analyst_manifest_file="the codeline's dependency manifest"

    # The same declaration the checker enforces (config/self-heal.json), so the analyst writes
    # within the limit rather than discovering it as a rejection.
    local _analyst_skill_note_max; _analyst_skill_note_max=$(_skill_note_max_chars) || return 1

    if ! jq -n \
        --rawfile profile "$_av_dir/profile" \
        --arg story_id "$story_id" \
        --arg story_role "$story_role" \
        --rawfile story_acs "$_av_dir/acs" \
        --rawfile skill_addendum "$_av_dir/addendum" \
        --rawfile dependency_contracts "$_av_dir/contracts" \
        --rawfile verification_failure "$_av_dir/vf" \
        --rawfile attempt_changes "$_av_dir/changes" \
        --arg manifest_file "$_analyst_manifest_file" \
        --arg skill_note_max "$_analyst_skill_note_max" \
        '{"__ANALYST_PROFILE__":$profile,
          "__MANIFEST_FILE__":$manifest_file,
          "__SKILL_NOTE_MAX__":$skill_note_max,
          "__STORY_ID__":$story_id,
          "__STORY_ROLE__":$story_role,
          "__SKILL_ADDENDUM__":$skill_addendum,
          "__DEPENDENCY_CONTRACTS__":$dependency_contracts,
          "__VERIFICATION_FAILURE__":$verification_failure,
          "__ATTEMPT_CHANGES__":$attempt_changes}' > "$_analyst_values" 2>"$_analyst_values_err"; then
        # NOT SILENT. An unbuildable values file is a defect to report, not an empty file to
        # hand downstream so it can fail with a parse error that names nothing.
        error "  [FailureAnalyst] cannot BUILD values file (jq failed): $(cat "$_analyst_values_err" 2>/dev/null)"
        rm -rf "$_av_dir"; rm -f "$_analyst_values" "$_analyst_values_err"
        return 1
    fi
    rm -rf "$_av_dir"

    if ! analyst_prompt=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
            render failure-analyst "${EPAM_PROJECT_CONFIG_DIR:-}" "$_analyst_values" 2>"$_analyst_values_err"); then
        error "  [FailureAnalyst] cannot build prompt: $(cat "$_analyst_values_err" 2>/dev/null | head -c 500)"
        rm -f "$_analyst_values" "$_analyst_values_err"
        return 1
    fi
    rm -f "$_analyst_values" "$_analyst_values_err"

    local analyst_raw="" analyst_json="" _analyst_call_ok="false"
    # Which attempt the unusable-answer branch already recorded a rung for, so the call-failure
    # branch below does not record a second one for the same failure.
    local _analyst_stepped_attempt=""
    local _analyst_max_attempts=3 _analyst_attempt=1
    local _analyst_json_result
    _analyst_json_result=$(mktemp /tmp/analyst-result-XXXXXX.json)
    while [ "$_analyst_attempt" -le "$_analyst_max_attempts" ]; do
        # Tool access (found live, 2026-07-31): the analyst was the ONLY gate
        # agent in this file with no way to verify a claim against reality —
        # AI_GATE_ALLOW_TOOLS=1 is set at exactly two OTHER call sites
        # (run_plan_mode, run_pre_phase_assessment); this one hand-rolled its
        # own invocation and never got it. It diagnosed a fully-installed,
        # correctly-imported internal package (@metrolinx/cx-shared) as "not
        # installed" three times, HEALING_BROKEN fired — a guess stated with
        # full confidence from three pre-injected text blocks and nothing
        # else. Reuses ORCH_GATE_ALLOWED_TOOLS VERBATIM — the same shared,
        # config-driven, read-only-by-default allowlist (bash,read_file,
        # list_files,search; no write_file) every other gate agent already
        # draws from. No analyst-specific tool list.
        #
        # Bounded like the post-phase assessment (same night, same reasoning):
        # this runs on the critical path of EVERY retry, so an unbounded grant
        # repeats the 184k-token-review mistake at a worse multiplier. 6
        # mirrors that fix's own measured number — enough to check one
        # file/directory, not enough to re-explore the codebase.
        if analyst_raw=$(echo "$analyst_prompt" | \
                AI_PROVIDER="$gate_provider" \
                AI_MODEL="$gate_model" \
                EPAM_CLI="$EPAM_CLI" \
                ORCH_JSON_RESULT="$_analyst_json_result" \
                EPAM_REASONING_EFFORT="high" \
                EPAM_TEMPERATURE="0.7" \
                AI_GATE_ALLOW_TOOLS=1 \
                EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
                EPAM_MAX_TOOL_CALLS="${FAILURE_ANALYST_MAX_TOOL_CALLS:-24}" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
                ${gate_model:+--model "$gate_model"} \
                2>>"$output_file"); then
            _analyst_call_ok="true"

            # Extract first valid JSON object (handles nested structures via Python)
            analyst_json=$(echo "$analyst_raw" | python3 "$SCRIPT_DIR/lib/handlers/failure-analyst-json.py" 2>/dev/null || echo "")

            if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
                break
            fi
            analyst_json=""
            # AN EMPTY RESPONSE IS NOT A MALFORMED ONE, AND BOTH USED TO SAY "could not parse".
            #
            # Live 2026-08-12: the analyst failed on roughly half its first calls and the
            # result files on disk were 0 BYTES — the model returned nothing at all. From the
            # log that was indistinguishable from prose or a truncated object, so diagnosing it
            # meant going to /tmp and measuring file sizes. The parser is not at fault: it tries
            # a whole-text parse and then brace-matches for the first balanced object, so if it
            # finds nothing there was nothing to find. Name which of the two happened, and show
            # what came back when there was something.
            local _analyst_snippet
            _analyst_snippet=$(printf '%s' "${analyst_raw:-}" | tr -d '\r' | tr '\n' ' ')
            if [ "$_analyst_attempt" -lt "$_analyst_max_attempts" ]; then
                # AN ANSWER THIS UNUSABLE IS EVIDENCE ABOUT THE MODEL. Re-asking the same one buys
                # a copy of the same non-answer — the reasoning the story ladder already applies,
                # which gate agents had no way to reach. The analyst now climbs the ladder its own
                # archetype declares; lib/agent-ladder.sh explains why nothing here names a model.
                agent_ladder_record_failure "$_ANALYST_SEAM" "$story_id"
                # ONE RUNG PER FAILED ATTEMPT. The call-failure block further down escalates on
                # exactly the condition this branch guarantees -- analyst_json is set to "" three
                # lines above -- so both fired on every unusable answer and the analyst climbed
                # two rungs for one failure, exhausting its ladder in half the attempts it was
                # given. Saying which attempt already stepped is what keeps them exclusive; the
                # other block is still needed on its own path, where the CALL failed and this
                # branch never runs.
                _analyst_stepped_attempt="$_analyst_attempt"
                local _analyst_next
                _analyst_next=$(agent_ladder_model "$_ANALYST_SEAM" "$story_id" "${gate_model:-}")
                if [ -n "$_analyst_next" ] && [ "$_analyst_next" != "${gate_model:-}" ]; then
                    warning "  [FailureAnalyst] escalating the ANALYST: ${gate_model:-unknown} → ${_analyst_next} (its answer was unusable, so the next attempt asks a different model)"
                    gate_model="$_analyst_next"
                elif agent_ladder_exhausted "$_ANALYST_SEAM" "$story_id" "${gate_model:-}"; then
                    warning "  [FailureAnalyst] the analyst is at the top of its declared ladder (${gate_model:-unknown}) — retrying the same model, which is the last one available to it"
                fi
                if [ -z "$(printf '%s' "${analyst_raw:-}" | tr -d '[:space:]')" ]; then
                    warning "  [FailureAnalyst] Analyst returned an EMPTY response (0 bytes) from ${gate_model:-unknown} — retrying gate call (attempt $((_analyst_attempt + 1))/${_analyst_max_attempts})"
                else
                    warning "  [FailureAnalyst] Analyst response contained no JSON object — retrying gate call (attempt $((_analyst_attempt + 1))/${_analyst_max_attempts}). It began: ${_analyst_snippet:0:200}"
                fi
            fi
        else
            # NEVER SILENT. This branch set _analyst_call_ok=false and logged nothing, so an
            # unreachable or erroring gate model left NO trace in the run log — the operator
            # saw a story retry with no guidance and no reason given.
            _analyst_call_ok="false"
            warning "  [FailureAnalyst] Gate invocation FAILED for ${gate_model:-unknown} (attempt ${_analyst_attempt}/${_analyst_max_attempts}) — no response to parse"
        fi

        # RETRYING A MODEL THAT SAID NOTHING IS NOT A RECOVERY STRATEGY.
        #
        # gate_model was chosen once and never reconsidered, so a model returning 0 bytes got
        # called three times and the story then retried with NO diagnosis. Live 2026-08-12:
        # z-ai/glm-5.2 returned empty on roughly half its first calls and burned one whole
        # analyst cycle that way. Three identical calls to a silent endpoint is exactly the
        # gamble the ladder exists to avoid.
        #
        # Nothing new is built: get_model_ladder_step already resolves the next rung from
        # EPAM_MODEL_LADDER_<TIER>, this file's own loader exports those from llm-settings.json,
        # and the high ladder already carries z-ai/glm-5.2 -> moonshotai/kimi-k3. The tier comes
        # from THIS SEAM'S declared profile, not from a literal here.
        #
        # The ANALYST's model moves; the writer's does not. The writer is not what failed, and
        # spending the story's escalation budget on a diagnostic problem is the category error
        # that HealingBroken already makes.
        # THE SHARED HANDLER, ONCE. This block used to re-implement the escalation that
        # lib/agent-ladder.sh already performs a few lines above — reading the tier itself with the
        # agent's name and a literal tier as the fallback, both spelled out twice. Two copies of an
        # escalation is one defect waiting: they drift, and the one that runs is whichever the
        # control flow reaches first.
        #
        # agent_ladder_model resolves the tier from the agent's ARCHETYPE through the seam, so no
        # agent name and no tier name is needed here at all.
        if [ -z "$analyst_json" ] && [ "$_analyst_attempt" -lt "$_analyst_max_attempts" ] \
           && [ "${_analyst_stepped_attempt:-}" != "$_analyst_attempt" ]; then
            local _next_gate_model
            agent_ladder_record_failure "$_ANALYST_SEAM" "$story_id"
            _next_gate_model=$(agent_ladder_model "$_ANALYST_SEAM" "$story_id" "${gate_model:-}")
            if [ -n "$_next_gate_model" ] && [ "$_next_gate_model" != "${gate_model:-}" ]; then
                warning "  [FailureAnalyst] escalating analyst model '${gate_model}' → '${_next_gate_model}' — the previous rung produced nothing usable"
                gate_model="$_next_gate_model"
            else
                warning "  [FailureAnalyst] analyst ladder exhausted at '${gate_model}' — retrying the same rung"
            fi
        fi
        _analyst_attempt=$((_analyst_attempt + 1))
    done

    if [ "$_analyst_call_ok" = "true" ]; then
        if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
            local diagnosis target skill_note reason patch_count _profile_updated
            diagnosis=$(echo "$analyst_json" | jq -r '.diagnosis // "unknown"' 2>/dev/null || echo "unknown")
            target=$(echo "$analyst_json" | jq -r '.target // "none"' 2>/dev/null || echo "none")
            skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""' 2>/dev/null || echo "")
            [ -n "$skill_note" ] && skill_note=$(_ensure_imperative_opener "$skill_note")
            reason=$(echo "$analyst_json" | jq -r '.reason // ""' 2>/dev/null || echo "")
            local tool_name tool_purpose tool_recipe
            tool_name=$(echo "$analyst_json" | jq -r '.tool_spec.name // ""' 2>/dev/null || echo "")
            tool_purpose=$(echo "$analyst_json" | jq -r '.tool_spec.purpose // ""' 2>/dev/null || echo "")
            tool_recipe=$(echo "$analyst_json" | jq -r '.tool_spec.recipe // ""' 2>/dev/null || echo "")
            patch_count=0
            _profile_updated="false"

            log "  [FailureAnalyst] Diagnosis: $diagnosis"
            log "  [FailureAnalyst] Target=$target — $reason"

            run_diagnosis_groundedness_check "$story_id" "$diagnosis"

            case "$target" in
                prd)
                    local patches_json
                    patches_json=$(echo "$analyst_json" | jq -c '.ac_patches // []' 2>/dev/null || echo "[]")
                    if [ "$patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching PRD ACs for $story_id..."
                        # Snapshot ACs before patching so reviewer can compare and we can revert
                        local _ac_before _ac_after
                        _ac_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local idx new_text
                            idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$idx" ] && [ -n "$new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            old = acs[idx]
            acs[idx] = new_text
            print(f'AC{idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'AC index {idx} out of range (story has {len(acs)} ACs)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$patches_json" | jq -c '.[]' 2>/dev/null)
                        _ac_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent corrupt ACs reaching agent
                        local _review_verdict
                        _review_verdict=$(run_prd_change_reviewer "$story_id" "ac_patch" "$_ac_before" "$_ac_after")
                        if [ "$_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] AC patch rejected by reviewer — reverting to original ACs"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_ac_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
acs = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s['acceptanceCriteria'] = acs
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count AC patch(es) — retry will use updated spec"
                        fi
                    else
                        log "  [FailureAnalyst] target=prd but no ac_patches provided — no change made"
                    fi
                    ;;
                tc)
                    local tc_patches_json
                    tc_patches_json=$(echo "$analyst_json" | jq -c '.tc_patches // []' 2>/dev/null || echo "[]")
                    if [ "$tc_patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching testCriteria facts for $story_id..."
                        # Snapshot TC facts before patching for reviewer and revert
                        local _tc_before _tc_after
                        _tc_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local tc_idx tc_new_text
                            tc_idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            tc_new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$tc_idx" ] && [ -n "$tc_new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$tc_new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $tc_idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        tc = s.setdefault('testCriteria', {})
        facts = tc.setdefault('facts', [])
        if 0 <= idx < len(facts):
            old = facts[idx]
            facts[idx] = new_text
            print(f'TC fact {idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'TC index {idx} out of range (story has {len(facts)} facts)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$tc_patches_json" | jq -c '.[]' 2>/dev/null)
                        _tc_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent bad TCs reaching test agent
                        local _tc_review_verdict
                        _tc_review_verdict=$(run_prd_change_reviewer "$story_id" "tc_patch" "$_tc_before" "$_tc_after")
                        if [ "$_tc_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] TC patch rejected by reviewer — reverting to original facts"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_tc_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
facts = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s.setdefault('testCriteria', {})['facts'] = facts
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count TC patch(es) — retry will use updated testCriteria"
                        fi
                    else
                        log "  [FailureAnalyst] target=tc but no tc_patches provided — TC writer will regenerate on next deliverable pass"
                    fi
                    ;;
                skill)
                    if [ -n "$skill_note" ]; then
                        log "  [FailureAnalyst] Injected skill guidance into retry prompt (${#skill_note} chars)"
                        # Persist skill note to the codeline KB so later runs inherit this learning
                        if [ -f "$profiles_file" ]; then
                            # Deterministic anti-pattern gate (found live, 2026-08-02): a skill
                            # note can be a 100%-correct reading of a WRONG ground truth (e.g. a
                            # stale SDK .d.ts file) — FailureAnalyst has no way to know that, and
                            # neither does the LLM reviewer just below, since the same blind spot
                            # applies to both. This project's own anti-patterns.json already
                            # encodes the known-correct answer from a real prior review; a note
                            # that contradicts it is refused here, before either LLM ever sees it,
                            # so the same wrong belief can never be re-argued back into the
                            # profile no matter how many times a model re-derives it.
                            local _skill_anti_pattern_msg
                            _skill_anti_pattern_msg=$(_text_violates_anti_pattern "$skill_note")
                            if [ -n "$_skill_anti_pattern_msg" ]; then
                                warning "  [FailureAnalyst] Skill note contradicts a known anti-pattern — refusing to persist: $_skill_anti_pattern_msg"
                            else
                            # DEDUP SOURCE CORRECTED 2026-08-07 (ARCH-5). This read the role's
                            # text out of profiles.json, which was where skill notes used to be
                            # persisted. They are now appended to the codeline KB, and
                            # profiles.json is wiped by pre-run-reset at the start of every run.
                            # Left pointing at profiles.json, both uses below silently degraded:
                            # the exact-duplicate check could never match (so every duplicate
                            # paid for a reviewer call before being caught by the KB check
                            # further down), and the reviewer was handed empty dedup context, so
                            # its near-duplicate judgment had nothing to compare against. Both
                            # must read the file the note actually lands in.
                            local _existing_notes _dedup_kb_dir _dedup_kb_file
                            _dedup_kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                            _dedup_kb_file=$(_kb_file_for_story "$story_id" "$_dedup_kb_dir")
                            _existing_notes=$([ -f "$_dedup_kb_file" ] && cat "$_dedup_kb_file" 2>/dev/null || echo "")
                            # Duplicate guard (fixed 2026-07-11, after a live run persisted an
                            # exact duplicate note): the reviewer call below already correctly
                            # rejects an exact-duplicate skill note as a "fail" verdict (same
                            # dedup mechanism the 2026-07-10 fix restored) -- but the
                            # unreviewed-fallback path just below was designed to rescue a
                            # genuinely NEW lesson that failed 3 review rounds on WORDING
                            # alone, and didn't distinguish that from "rejected because it's a
                            # verbatim duplicate." It persisted the duplicate anyway,
                            # defeating the entire dedup mechanism it sits next to. Check for
                            # an exact duplicate FIRST and skip the whole reviewer+persist
                            # flow when found -- there is nothing to review or fall back to.
                            if echo "$_existing_notes" | grep -qF -- "$skill_note"; then
                                log "  [FailureAnalyst] Skill note is an exact duplicate of an existing note in $(basename "$_dedup_kb_file") — discarding, not persisting again"
                            else
                            # Reviewer validates skill note before persisting. Rejections
                            # get up to 3 summarize-and-resubmit rounds (same mechanism as
                            # kb_entry) before being discarded.
                            local _skill_review_verdict
                            # Root cause fix (found live, 2026-07-10, tier3-travel-app run):
                            # this used to `head -c 500` the existing profile text before
                            # handing it to the duplicate check inside
                            # run_change_with_reviewer_retry/_skill_note_format_ok. New notes
                            # are appended to the END of the profile string, so once a
                            # profile grows past 500 chars (typescript-engineer reached
                            # 12K+), the dedup check was structurally blind to every note
                            # already there — guaranteeing duplicates for any profile past
                            # that length. Observed: the same self-contradictory "don't use
                            # 'as'... use 'value as Type'" note persisted twice verbatim in
                            # one story's retry loop. Pass the FULL profile text so the
                            # exact-duplicate check (grep -qF) can actually see prior notes.
                            _skill_review_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                                "$_existing_notes" \
                                "$skill_note" 3)
                            # run_change_with_reviewer_retry ran inside the $(...) above, so its
                            # REVIEWER_RETRY_TEXT assignment was scoped to that subshell — read
                            # the file-based side channel it left behind instead.
                            REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$skill_note")
                            local _skill_note_to_persist="$REVIEWER_RETRY_TEXT"
                            if [ "$_skill_review_verdict" = "fail" ]; then
                                # Same fallback as kb_entry above (2026-07-06): don't discard a
                                # genuinely useful lesson just because its WORDING failed review
                                # 3 times — persist a length-safe, tagged-unreviewed fallback
                                # instead of losing the knowledge outright.
                                warning "  [FailureAnalyst] Skill note rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) instead of discarding"
                                # Persist the note WHOLE. An unreviewed-but-complete rule is
                                # usable; an unreviewed-and-severed one is worse than none.
                                _skill_note_to_persist="[unreviewed-fallback] ${skill_note}"
                            fi
                            REVIEWER_RETRY_TEXT="$_skill_note_to_persist"
                            # THE ROSTER IS SET AFTER THE MINT. Nothing writes it afterwards.
                            #
                            # This appended the note into profiles.json, claiming in its own
                            # comment that "future runs inherit this learning". They could not:
                            # pre-run-reset restores profiles.json from its original at the
                            # start of every run, so the note lived exactly as long as the run
                            # that produced it. Meanwhile the roster became mutable while three
                            # lanes read it in parallel, and drifted from its original, which
                            # broke the same invariant test repeatedly.
                            #
                            # The note goes where knowledge actually survives — the codeline KB,
                            # the same store the kb target uses and that every implementation
                            # prompt already reads. Duplicate suppression comes free: the file
                            # is checked before appending.
                            # NO CROSS-RUN WRITE. A skill note used to be APPENDED to
                            # agents/KB-<codeline>.md and logged as "survives into later runs".
                            # Nothing cleared it, so guidance derived from one run's code was
                            # injected into every later run's prompts as current fact. Operator,
                            # 2026-08-12: "there can be no lingering anything to skew runs. That
                            # is strictly forbidden."
                            #
                            # The note still reaches THIS run's retry through the in-run
                            # amendment above; only the persistence is removed.
                            log "  [FailureAnalyst] Skill note applied to this run only — not persisted across runs"
                            _profile_updated="true"
                            fi
                            fi
                        fi
                    else
                        log "  [FailureAnalyst] target=skill but skill_note empty — falling back to diagnosis only"
                    fi
                    ;;
                kb)
                    if [ -n "$skill_note" ]; then
                        # Agent-specific KB: KB-{agentRole}.md — keeps context injection small.
                        # Shared rules go to KB-shared.md; agent-specific rules go to role file.
                        local kb_dir
                        kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                        local kb_file; kb_file=$(_kb_file_for_story "$story_id" "$kb_dir")
                        # NO TRUNCATION — entries are single actionable rules, and a rule
                        # carrying a regex, path or command is destroyed by a character cut.
                        # Length is a REJECTION criterion upstream (the note goes back for
                        # rewrite), never a mutilation silently applied here.
                        local short_note="${skill_note}"
                        # Exact-duplicate check against the FULL kb_file BEFORE ever calling
                        # the reviewer (found live, 2026-07-12): unlike the skill_note case
                        # above (which does exactly this grep against the full profile text),
                        # this path only ever fed the reviewer the LAST 6 LINES of the KB file
                        # as dedup context, relying entirely on the LLM's subjective judgment
                        # for everything older than that. Live evidence:
                        # KB-typescript-engineer.md accumulated 4 reworded variants of the
                        # exact same "verify test-file imports are in package.json
                        # devDependencies before writing tests" rule, all appended within one
                        # 5-minute window — the LLM reviewer approved each as "not a duplicate"
                        # since the wording differed each time. This catches the EXACT-repeat
                        # case deterministically; genuine near-duplicate rewording is still the
                        # reviewer's call, same scope boundary the skill_note fix drew.
                        if [ -f "$kb_file" ] && grep -qF -- "$short_note" "$kb_file"; then
                            log "  [FailureAnalyst] KB note is an exact duplicate of an existing entry in $(basename "$kb_file") — discarding, not persisting again"
                        else
                        # Read last 3 existing KB entries to give reviewer dedup context
                        local _kb_last3=""
                        _kb_last3=$(tail -6 "$kb_file" 2>/dev/null || echo "")
                        # Full agent audit, 2026-07-31: kb-change-reviewer's own rule
                        # ("Entry contradicts the agentRole's profile in profiles.json")
                        # was unenforceable — unlike the skill_note call site (whose
                        # "before" IS the target profile text, since notes are appended
                        # to it directly), this call only ever passed KB-file tail
                        # lines, never the target role's actual profile.json text. Fetch
                        # it the same way the skill_note branch does, so the reviewer
                        # can actually check the rule instead of guessing or ignoring it.
                        local _kb_target_role_profile=""
                        if [ -f "$profiles_file" ]; then
                            _kb_target_role_profile=$(jq -c --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null)
                        fi
                        local _kb_review_before="KB entries so far:
${_kb_last3}

Target agentRole (${story_role}) profile, for the 'contradicts the agentRole's profile' rule:
${_kb_target_role_profile}"
                        # KB reviewer gate — permanent entries must pass strict validation.
                        # Rejections get up to 3 summarize-and-resubmit rounds before being
                        # discarded (see run_change_with_reviewer_retry).
                        local _kb_review_verdict
                        _kb_review_verdict=$(run_change_with_reviewer_retry \
                            "$story_id" "kb_entry" \
                            "$_kb_review_before" \
                            "$short_note" 3)
                        # See the skill_note call site above for why this file read is needed.
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$short_note")
                        if [ "$_kb_review_verdict" = "fail" ]; then
                            # Root cause this replaces (found live, 2026-07-06):
                            # a genuinely correct, useful rule ("must export
                            # main(argv)") got REJECTED 3 times purely for
                            # WORDING issues (over the char limit, wrong verb,
                            # "not generalizable") and then silently dropped —
                            # the actual lesson was lost forever, not just its
                            # phrasing. $short_note is already a mechanically
                            # safe, length-compliant truncation of the raw
                            # content computed BEFORE the reviewer ever ran, so
                            # persist THAT as a last-resort fallback (tagged as
                            # unreviewed) instead of discarding the knowledge
                            # outright. A future reviewer/human pass can still
                            # clean up the wording; nothing is lost meanwhile.
                            warning "  [FailureAnalyst] KB entry rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) instead of discarding"
                            # Not persisted across runs — see the note on the skill-note path above.
                            _profile_updated="true"
                        else
                            # Compact 2-line format: timestamp + rule only (no verbose headers)
                            # Not persisted across runs. The entry still reaches THIS run's retry
                            # through the in-run amendment; only the cross-run write is removed.
                            log "  [FailureAnalyst] KB entry applied to this run only (${#REVIEWER_RETRY_TEXT} chars) — not persisted"
                            _profile_updated="true"
                        fi
                        fi
                    else
                        log "  [FailureAnalyst] target=kb but skill_note empty — no KB entry written"
                    fi
                    ;;
                tool)
                    if [ -n "$tool_name" ] && [ -n "$tool_recipe" ] && \
                       _tool_recipe_reinvokes_test_cmd "$tool_recipe" "${LAST_TEST_CMD:-}"; then
                        warning "  [FailureAnalyst] Dynamic tool '${tool_name}' recipe re-invokes this project's own test command ('${LAST_TEST_CMD}') — a tool's job is the ONE mechanical step it automates, never a second independent test run; NOT written"
                    elif [ -n "$tool_name" ] && [ -n "$tool_recipe" ]; then
                        local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
                        mkdir -p "$tools_dir" 2>/dev/null
                        local tool_path="${tools_dir}/${tool_name}.sh"
                        local _tool_before=""
                        [ -f "$tool_path" ] && _tool_before=$(cat "$tool_path")

                        # Build the candidate script: header comment (purpose, used for
                        # prompt injection) + the recipe as the executable body.
                        local _tool_candidate
                        _tool_candidate=$(printf '#!/usr/bin/env bash\n# %s\nset -e\n%s\n' "$tool_purpose" "$tool_recipe")

                        # Reviewer gate — validates the script before it's trusted for
                        # future runs. Same snapshot/revert pattern as every other
                        # self-heal write. Rejections get up to 3 summarize-and-resubmit
                        # rounds (same mechanism as kb_entry/skill_note) before being
                        # discarded — a rejected tool used to be a dead end even when the
                        # rejection was a fixable bash bug (e.g. subshell variable scoping).
                        local _tool_review_verdict
                        _tool_review_verdict=$(run_change_with_reviewer_retry "$story_id" "tool_creation" \
                            "$_tool_before" "$_tool_candidate" 3)
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_tool_candidate")
                        if [ "$_tool_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] Dynamic tool '${tool_name}' rejected by reviewer after 3 attempts — NOT written"
                        else
                            printf '%s' "$REVIEWER_RETRY_TEXT" > "$tool_path"
                            chmod +x "$tool_path" 2>/dev/null
                            # Explicit, auditable "this exact tool was reviewed and
                            # approved" marker — a sidecar file, not a marker embedded
                            # in the script itself, so it never collides with the
                            # `sed -n '2p'` purpose-line extraction used elsewhere.
                            # Both run_dynamic_tools_in_unlocked_window() (the
                            # orchestrator's own deterministic execution) and the
                            # agent-prompt tool listing check for this marker before
                            # trusting/surfacing a tool — today's only write path
                            # already requires review, but this makes "only reviewed
                            # tools are ever used" an explicit, checkable invariant
                            # rather than an implicit assumption about there being no
                            # other writer.
                            printf 'reviewed_at=%s\nstory_id=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$story_id" > "${tool_path}.reviewed"
                            log "  [FailureAnalyst] Dynamic tool written: .epam/dynamic-tools/${tool_name}.sh — ${tool_purpose}"
                            _profile_updated="true"
                        fi
                    else
                        log "  [FailureAnalyst] target=tool but tool_spec incomplete — falling back to diagnosis only"
                    fi
                    ;;
                none)
                    log "  [FailureAnalyst] No structural fix needed — model escalation ladder handles retry"
                    ;;
                *)
                    log "  [FailureAnalyst] Unknown target '$target' — injecting diagnosis only"
                    ;;
            esac
            # Record the healing event for observability and post-run audit
            run_healing_recorder "$story_id" "$retry_num" "$target" "$diagnosis" "$patch_count" "$_profile_updated"
            # Emit self_heal_result so agent-activity dashboard shows target, diagnosis, and outcome
            "$SCRIPT_DIR/update-monitor.sh" event "self_heal_result" \
                "Self-heal result for $story_id: target=$target patches=$patch_count profile=$_profile_updated — $diagnosis" \
                "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true
            # A pure syntax error escalates immediately (see check_syntax_class_error's
            # docstring) — check this BEFORE the repeat-based check below, which would
            # otherwise wait for the same syntax error to recur once more first.
            check_syntax_class_error "$story_id" "$diagnosis"
            # Detect repeat failures — same diagnosis 2+ times means healing is broken
            check_healing_effectiveness "$story_id" "$diagnosis" "$retry_num"
            # Detect diverse failures — a DIFFERENT diagnosis each attempt while still
            # on the base model means the model can't converge on this story at all
            check_failure_diversity "$story_id" "$retry_num" "$diagnosis"
            # Always inject the failure summary into the coordinator amendment so the
            # downstream retry agent knows EXACTLY what went wrong and how to avoid it.
            local _analyst_guidance="Root cause: ${diagnosis}"
            [ -n "$skill_note" ] && _analyst_guidance="${_analyst_guidance}
Fix: ${skill_note}"
            [ "$target" = "prd" ] && _analyst_guidance="${_analyst_guidance}
The acceptance criteria for this story have been updated — re-read them carefully before writing code."
            [ "$target" = "tc" ] && _analyst_guidance="${_analyst_guidance}
The testCriteria facts for this story have been updated — re-read the Test Criteria section carefully before writing tests."
            [ "$target" = "none" ] && _analyst_guidance="${_analyst_guidance}
The spec is correct — the model made a code-level mistake. Write correct code this time."
            local _existing="${COORDINATOR_PROMPT_AMENDMENT:-}"
            COORDINATOR_PROMPT_AMENDMENT="${_existing}
## Self-Heal: Failure Analyst Summary
${_analyst_guidance}"
        else
            warning "  [FailureAnalyst] Could not parse JSON from analyst response after ${_analyst_max_attempts} attempts — proceeding with retry as-is"
        fi
    else
        warning "  [FailureAnalyst] Gate model call failed — proceeding with retry as-is"
    fi
    # Emit cost_snapshot for failure-analyst (accumulated across its retry loop)
    if [ -f "$_analyst_json_result" ] && [ -s "$_analyst_json_result" ]; then
        local _fa_cost _fa_tin _fa_tout _fa_turns _fa_phase
        _fa_cost=$(jq -r '.total_cost_usd // .cost_usd // 0'                       "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tin=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0'            "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tout=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0'         "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_turns=$(jq -r '.num_turns // .turns // .iterations // 1'                "$_analyst_json_result" 2>/dev/null || echo 1)
        _fa_phase="${CURRENT_PHASE:-}"
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg story "$story_id" \
            --arg phase "${_fa_phase:-}" \
            --arg model "${gate_model:-}" \
            --arg provider "${gate_provider:-}" \
            --argjson cost "${_fa_cost:-0}" \
            --argjson tin "${_fa_tin:-0}" \
            --argjson tout "${_fa_tout:-0}" \
            --argjson turns "${_fa_turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
              timestamp: $ts,
              agent: "failure-analyst",
              story_id: (if $story == "" then null else $story end),
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: (if $model == "" then null else $model end),
              provider: (if $provider == "" then null else $provider end),
              detail: {costUsd: $cost, tokensIn: $tin, tokensOut: $tout, turns: $turns, source: "run_failure_analyst"}
            }' >> "${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$_analyst_json_result"
    fi
    "$SCRIPT_DIR/update-monitor.sh" story_complete "failure-analyst" "main" "Analysis complete: $story_id" 2>/dev/null || true
}

# run_healing_recorder <story_id> <retry_num> <target> <diagnosis> <patches_applied> <profile_updated>
# Appends a JSONL record to $OUTPUT_DIR/healing-events.jsonl after each analyst cycle.
# Each record is independently parseable so the log survives partial runs.
run_healing_recorder() {
    local story_id="$1"
    local retry_num="${2:-0}"
    local target="${3:-none}"
    local diagnosis="${4:-unknown}"
    local patches_applied="${5:-0}"
    local profile_updated="${6:-false}"
    local rung
    rung=$(( retry_num / 2 ))
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
    # Always write to LOG_DIR (orchestrations/logs) — healing-events is pipeline
    # monitoring data, not project output. Writing to OUTPUT_DIR breaks the dashboard
    # which reads from logs/healing-events.jsonl via nginx /logs-dir mount.
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    mkdir -p "$(dirname "$heal_log")"
    # Safe JSON serialisation — escape quotes and backslashes in diagnosis
    local safe_diagnosis
    safe_diagnosis=$(printf '%s' "$diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"%s","diagnosis":"%s","patches_applied":%s,"profile_updated":%s}\n' \
        "$ts" "$story_id" "$retry_num" "$rung" "$target" "$safe_diagnosis" \
        "$patches_applied" "$profile_updated" \
        >> "$heal_log"
    log "  [HealingRecorder] Event written (story=$story_id retry=$retry_num rung=$rung target=$target)"

    # ── Self-heal KB (pillar 1: episodic tier) ───────────────────────────────
    # Additive and flag-guarded. The legacy line above still feeds the dashboard;
    # this second write is keyed by a signature derived from the TOOL OUTPUT
    # ($VERIFICATION_FAILURE), never from the diagnosis prose above — a replay of
    # 118 real episodes found only 4 diagnoses carried a compiler code, so prose
    # cannot serve as a stable lookup key. Never fails the run: losing an episode
    # must not lose a story.
    if true; then   # self-heal always on (switch removed 2026-07-25)
        local _kb_apply_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_apply_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_apply_lib"
            # Here-string, NOT a pipe: a pipeline runs kb_record_episode in a
            # subshell and KB_LAST_SIGNATURE — the key kb_maybe_synthesize needs —
            # is lost when it exits, leaving synthesis unable to build anything.
            kb_record_episode "$story_id" "${STORY_ROLE:-}" "$diagnosis" \
                <<< "${VERIFICATION_FAILURE:-}" || true
            # Close the loop: episodes alone build nothing. Synthesis turns a
            # REPEATED signature into one arbitrated, schema-valid constraint that
            # the next attempt gets as enforcement — never as prompt prose.
            kb_maybe_synthesize "${STORY_ROLE:-}" || true
        fi
    fi
}

# apply_known_fix <project_root> <diagnosis>
# Deterministic second-line safety net for recurring self-heal failures.
#
# Root cause this fixes (found live, 2026-07-06): the FailureAnalyst's fix-routing
# has exactly 5 targets (prd, tc, tool, skill, kb), and NONE of them means "directly
# patch the content of a file the agent already wrote." For a known, mechanical,
# single-line config gap (e.g. vitest.config.ts missing `passWithNoTests: true`,
# so `vitest run` exits 1 with zero test files even though the AC explicitly
# allows that), the analyst correctly diagnosed the exact fix needed at TWO
# different model tiers, but both times picked the nearest-available-but-wrong
# target (`tool` = writes an unrelated helper script; `tc` = patches documentation
# text) — neither can touch the actual file content, so the diagnosis recurred
# and the story exhausted its entire retry ladder on a fix that was correctly
# identified but could never be mechanically applied.
#
# Deliberately NOT a 6th LLM-facing target: growing the analyst's enum gives it
# one more way to be wrong, not a better chance of being right — the gap isn't
# "not enough categories," it's "no category exists that means what's needed."
# Instead, this is a separate, deterministic, non-LLM layer that only engages
# AFTER check_healing_effectiveness has already detected 2+ repeats of the same
# diagnosis — the LLM stays the fast first responder for everything else, and
# this is a safety net for the narrow class of "correctly diagnosed, wrongly
# routed" mechanical fixes. All stack-specific knowledge (which file, which
# snippet, which symptom pattern) lives in the project's own
# .epam/known-fixes.json — same "config supplies stack knowledge, engine has
# none" convention as .epam/dependency-check.json and .epam/contract-generation.json.
#
# Returns 0 (and logs) if a fix was found and applied; returns 1 otherwise —
# callers must treat 1 as "no known fix, fall through to existing behavior."
apply_known_fix() {
    local project_root="$1"
    local diagnosis="$2"
    local config_file="${project_root}/.epam/known-fixes.json"
    [ -f "$config_file" ] || return 1

    local applied_id
    applied_id=$(python3 - "$project_root" "$config_file" "$diagnosis" << 'PYEOF' 2>/dev/null
import json, re, sys, os

project_root, config_file, diagnosis = sys.argv[1], sys.argv[2], sys.argv[3]

with open(config_file) as f:
    fixes = json.load(f)

for fix in fixes:
    try:
        if not re.search(fix['symptomPattern'], diagnosis, re.IGNORECASE):
            continue
        target_path = os.path.join(project_root, fix['targetFile'])
        if not os.path.exists(target_path):
            continue
        with open(target_path) as tf:
            content = tf.read()
        # Already present — this symptom must have a different cause; don't
        # falsely claim success, let the caller fall through to normal handling.
        if fix['checkPattern'] in content:
            continue
        m = re.search(fix['insertAfterPattern'], content)
        if not m:
            continue
        new_content = content[:m.end()] + fix['insertText'] + content[m.end():]
        with open(target_path, 'w') as tf:
            tf.write(new_content)
        print(fix['id'])
        sys.exit(0)
    except (KeyError, re.error):
        continue

sys.exit(1)
PYEOF
)
    local rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$applied_id" ]; then
        log "  [KnownFix] Applied deterministic fix '${applied_id}' for recurring diagnosis (see .epam/known-fixes.json)"
        return 0
    fi
    return 1
}

# resolve_escalation <escalating_story_id>
# Checks for a pending .epam/escalations/<story_id>.json filed by the
# escalate_defect_to_sibling_story tool (src/tools/builtin/EscalateDefect.ts).
#
# Root cause this fixes (found live, 2026-07-06): a split story pair (e.g.
# SKY-002-impl / SKY-002-test) can end up with the test child's tests failing
# because the impl child's code is missing something (e.g. constructor
# validation) — the test child's own FailureAnalyst correctly diagnoses this
# every retry, but is structurally unable to fix it (the fix lives in a file
# outside its own declared scope, correctly locked by the scope guard), so it
# just burns its entire retry ladder re-diagnosing a true root cause it can
# never act on.
#
# Resolution: find the sibling story that actually owns the target file
# (same split parent via specification.createdFrom, or — for non-split
# cross-story dependencies — any other story that declares the file), and
# reuse the implement_story function itself (all provider branches, JSON
# handling, tsc verification already correct and tested) to apply ONE narrow,
# targeted fix
# there, via the existing COORDINATOR_PROMPT_AMENDMENT injection mechanism.
# Bounded to a small retry budget (ESCALATION_FIX_MAX_RETRIES, default 1) —
# this is meant to be a single scoped patch, not a full re-implementation.
#
# Returns 0 if a fix was resolved (caller should grant a free retry); returns
# 1 if there was no escalation, or if it could not be resolved (caller falls
# through to normal retry handling — the diagnosis will surface again and be
# caught by check_healing_effectiveness like any other repeat).
resolve_escalation() {
    local escalating_story_id="$1"
    local escalation_file="${PROJECT_ROOT}/.epam/escalations/${escalating_story_id}.json"
    [ -f "$escalation_file" ] || return 1

    local target_file diagnosis required_fix
    target_file=$(jq -r '.targetFile // empty' "$escalation_file" 2>/dev/null)
    diagnosis=$(jq -r '.diagnosis // empty' "$escalation_file" 2>/dev/null)
    required_fix=$(jq -r '.requiredFix // empty' "$escalation_file" 2>/dev/null)
    if [ -z "$target_file" ] || [ -z "$required_fix" ]; then
        warning "  [Escalation] Malformed escalation file for $escalating_story_id — ignoring"
        rm -f "$escalation_file"
        return 1
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local parent_id
    parent_id=$(jq -r --arg id "$escalating_story_id" \
        '.stories[] | select(.id == $id) | .specification.createdFrom // empty' \
        "$prd_target" 2>/dev/null)

    # Prefer a split-sibling match (same parent) so a genuinely unrelated story
    # that happens to also touch the file isn't picked by mistake; fall back to
    # a project-wide owner search for non-split cross-story dependencies.
    #
    # BUG A FIX (found live, 2026-07-11/12, tier3-travel-app runs): targetFile
    # comes from run_relative_import_check()'s escalation write, which stores
    # a RELATIVE path (Python's os.path.relpath, e.g. "src/cli.ts") — but the
    # PRD's technicalNotes.files ALWAYS stores ABSOLUTE paths (e.g.
    # "/home/.../skyscanner-app/src/cli.ts"). An exact `== $file` match can
    # NEVER succeed for any escalation this codebase actually writes, so this
    # resolution step failed 100% of the time since the mechanism was built —
    # confirmed live: SKY-003-test burned its full 8-attempt retry ladder
    # twice (2026-07-11 and again 2026-07-12) on the exact defect this
    # mechanism exists to solve, because the escalation it wrote for itself
    # was silently unresolvable on the very next retry. Match the SAME
    # flexible pattern the write side (run_relative_import_check) already
    # uses for its OWN "do I own this file" check: exact match OR the
    # candidate path ending in "/" + the (possibly relative) target file.
    local sibling_id
    sibling_id=$(jq -r --arg parent "$parent_id" --arg file "$target_file" --arg self "$escalating_story_id" \
        '.stories[] | select(($parent != "") and .specification.createdFrom == $parent and .id != $self) | select((.technicalNotes.files // []) | map(. == $file or endswith("/" + $file)) | any) | .id' \
        "$prd_target" 2>/dev/null | head -1)
    if [ -z "$sibling_id" ]; then
        sibling_id=$(jq -r --arg file "$target_file" --arg self "$escalating_story_id" \
            '.stories[] | select(.id != $self) | select((.technicalNotes.files // []) | map(. == $file or endswith("/" + $file)) | any) | .id' \
            "$prd_target" 2>/dev/null | head -1)
    fi

    if [ -z "$sibling_id" ]; then
        warning "  [Escalation] Could not resolve an owning story for $target_file — no story declares it in technicalNotes.files"
        rm -f "$escalation_file"
        return 1
    fi

    log "  [Escalation] $escalating_story_id escalated a defect in $target_file (owned by $sibling_id): $diagnosis"

    local _saved_amendment="${COORDINATOR_PROMPT_AMENDMENT:-}"
    local _saved_max_retries="$MAX_RETRIES"
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
    jq_vals \
          --arg escalating_story_id "${escalating_story_id}" \
          --arg required_fix "${required_fix}" \
          --arg target_file "${target_file}" \
          --arg diagnosis "${diagnosis}" \
          '{"__ESCALATING_STORY_ID__":$escalating_story_id,"__REQUIRED_FIX__":$required_fix,"__TARGET_FILE__":$target_file,"__DIAGNOSIS__":$diagnosis}' > "$_cp_vals"
    _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" sibling_escalation)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
    rm -f "$_cp_vals"
    export COORDINATOR_PROMPT_AMENDMENT
    MAX_RETRIES="${ESCALATION_FIX_MAX_RETRIES:-1}"

    implement_story "$sibling_id"
    local fix_result=$?

    COORDINATOR_PROMPT_AMENDMENT="$_saved_amendment"
    export COORDINATOR_PROMPT_AMENDMENT
    MAX_RETRIES="$_saved_max_retries"

    rm -f "$escalation_file"

    if [ "$fix_result" -eq 0 ]; then
        success "  [Escalation] Scoped fix resolved for $sibling_id — resuming $escalating_story_id"
        return 0
    else
        warning "  [Escalation] Scoped fix for $sibling_id did not converge within ${ESCALATION_FIX_MAX_RETRIES:-1} retr(y/ies) — $escalating_story_id will re-diagnose on its next attempt"
        return 1
    fi
}

# check_syntax_class_error <story_id> <current_diagnosis>
# A pure syntax error (unbalanced brace, missing semicolon, unterminated string,
# invalid type assertion, TS10xx/TS11xx parser diagnostics) is never a subtle
# logic mistake that benefits from a same-tier retry with a text hint — the
# model either can/can't produce syntactically valid TypeScript, and repeating
# the SAME model tier just burns attempts waiting for check_healing_effectiveness's
# 2-repeat threshold to fire. Escalate to the next rung on the FIRST occurrence
# instead of waiting for a repeat.
#
# Root cause this fixes (observed live, 2026-07-10, tier3-travel-app run):
# SKY-003-impl hit "Missing closing brace in cli.ts at line 375" and retried at
# the SAME model tier twice before HealingBroken's repeat-of-2 threshold finally
# forced an escalation to z-ai/glm-5.2, which then converged immediately. The
# same class of syntax error (unterminated strings, invalid 'as' syntax, missing
# semicolons) recurred across multiple DIFFERENT stories this session, always
# eventually fixed only after burning 2+ same-tier attempts first.
#
# Second root cause fixed 2026-07-14 (SKY-003-b, tier3-travel-app run): the
# pattern list above never matched "malformed template literal"/"malformed
# array or bracket"/"invalid computed property" -- diagnosis phrasings that
# ARE syntax errors but don't use this list's exact vocabulary -- so this
# function silently never fired for 6 straight retries on the same corrupted
# line, leaving check_healing_effectiveness's slower repeat-of-2 path to do
# all the work instead of the immediate escalation this function exists for.
# Added "malformed" as a fourth generic keyword rather than enumerating every
# specific phrasing (unbounded and language-agnostic, same idiom as the
# existing alternation).
#
# Also root-caused WHY 6 retries never converged even after escalating:
# reading the actual corrupted file (cli.test.ts:260) showed a dropped
# array-closing token merging the tail of one test into the `it(...)` header
# of the next -- a full-file-regeneration boundary glitch. Every retry
# rewrote the ENTIRE file from scratch, so the model kept re-hitting the same
# failure MODE (a long-file generation boundary slip) even as the exact
# corrupted bytes shifted attempt to attempt, which is also why
# failure-analyst's own diagnosis text kept changing without ever
# converging. Persist a generic, role-scoped, permanent skill note the first
# time this fires for a story so this run (or the very next test-writing
# story) tries a different strategy: patch the broken region, don't
# regenerate the whole file. Reuses the same reviewer-gated persist pattern
# already used for failure-analyst's target=skill/kb notes -- deterministic
# exact-duplicate guard, format validated by _skill_note_format_ok, so this
# is written exactly once per role, not once per retry.
check_syntax_class_error() {
    local story_id="$1"
    local diagnosis="$2"
    [ "${HEALING_BROKEN:-0}" = "1" ] && return 0
    if echo "$diagnosis" | grep -qiE \
        'missing (closing|opening) (brace|paren(thesis)?|bracket)|unterminated (string|template)|missing semicolon|invalid type assertion|unexpected token|malformed|\bTS1[01][0-9]{2}\b|syntax error'; then
        log "  [SyntaxClassEscalation] '$diagnosis' matches a syntax-error pattern — escalating immediately instead of waiting for a repeat"
        HEALING_BROKEN=1
        export HEALING_BROKEN

        local _syntax_story_role
        _syntax_story_role=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .agentRole // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ -n "$_syntax_story_role" ] && [ -f "$AGENT_PROFILES_FILE" ]; then
            # Kept under 200 chars deliberately: _skill_note_format_ok's
            # length check (mirrors prd-change-reviewer's own skill_note
            # rule) then short-circuits run_change_with_reviewer_retry
            # straight to "pass" via its deterministic fast path -- no live
            # LLM gate-model call needed for a note this mechanical, and no
            # dependency on ORCH_GATE_PROVIDER being configured at all.
            local _syntax_note="Always patch only the broken line range on a repeated syntax-error retry -- never regenerate the whole file, since a full rewrite tends to reproduce the same corruption elsewhere."
            # DEDUP SOURCE CORRECTED 2026-08-07 (ARCH-5): same defect as the skill branch in
            # run_failure_analyst. The note is appended to the codeline KB below, so reading
            # prior notes out of profiles.json meant the "already learned this" check could
            # never fire and the reviewer got empty dedup context — this note would be
            # re-proposed and re-reviewed on every syntax escalation of every run.
            local _syntax_role_profile _syntax_dedup_dir _syntax_dedup_file
            _syntax_dedup_dir="$(dirname "$SCRIPT_DIR")/agents"
            _syntax_dedup_file=$(_kb_file_for_story "$story_id" "$_syntax_dedup_dir")
            _syntax_role_profile=$([ -f "$_syntax_dedup_file" ] && cat "$_syntax_dedup_file" 2>/dev/null || echo "")
            if ! echo "$_syntax_role_profile" | grep -qF -- "$_syntax_note"; then
                local _syntax_verdict
                _syntax_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                    "$_syntax_role_profile" "$_syntax_note" 3)
                # Fail-closed: only persist on an actual "pass" verdict --
                # a rejected note must never be written, matching every
                # other reviewer-gated write site in this file.
                if [ "$_syntax_verdict" = "pass" ]; then
                    local _syntax_note_final
                    _syntax_note_final=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_syntax_note")
                    # Same store as every other durable lesson. This was an UNLOCKED
                    # read-modify-write on profiles.json — jq to a temp file, then mv — while
                    # the neighbouring skill-note path was properly flocked. Two writers to one
                    # mutable file, one of them unguarded, makes the other one's guarantee void
                    # the moment they interleave, and three lanes run in parallel.
                    #
                    # Retired rather than locked: the roster is set after the mint, and this
                    # note belongs where it survives the per-run restore.
                    # CROSS-RUN WRITE REMOVED (2026-08-12). This was the FIFTH and last one,
                    # and it survived the first sweep because that sweep grepped for the two
                    # variable names already known ($kb_file, $_skill_kb_file) instead of the
                    # pattern. Scoped check, general claim — the same mistake the KB itself
                    # kept teaching agents.
                    #
                    # Operator: "agent kb files = remove all after every run - there can be no
                    # lingering anything to skew runs. That is strictly forbidden."
                    #
                    # The note still reaches THIS run's agents through the profile skill notes.
                    # Nothing carries it into the next one.
                    log "  [SyntaxClassEscalation] Skill note applied to this run only — not persisted across runs"
                else
                    log "  [SyntaxClassEscalation] Skill note rejected by reviewer — not persisting"
                fi
            fi
        fi
    fi
}

# check_healing_effectiveness <story_id> <current_diagnosis> [retry_num]
# Reads healing-events.jsonl and checks if the same diagnosis has appeared 2+ times
# for this story without a different diagnosis in between. If so, self-healing is
# not working — log a CRITICAL alert and set HEALING_BROKEN=1 to abort retries.
check_healing_effectiveness() {
    local story_id="$1"
    local current_diagnosis="$2"
    local retry_num="${3:-0}"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0
    # Count consecutive same-root-cause events for this story (most recent N events).
    # A naive 20-char exact-prefix match was live-confirmed to miss real repeats: the
    # gate model rarely phrases the same root cause identically twice (e.g. "Code uses
    # '../public/index.html'..." vs "Agent referenced src/public/index.html but didn't
    # create the file..." — same bug, zero shared 20-char prefix). Token-overlap
    # matching catches paraphrased repeats: extract significant words (len>=4, minus
    # stopwords) from each diagnosis and compare against the current one; treat as the
    # same root cause when at least 3 significant words overlap AND that overlap is a
    # sizeable share (>=40%) of the smaller diagnosis's vocabulary. Both thresholds are
    # needed together — overlap-count alone lets short diagnoses false-positive on one
    # shared word; ratio alone lets two long, mostly-unrelated diagnoses match on a
    # handful of incidental shared words (e.g. both mentioning "file" and "server").
    local repeat_count
    repeat_count=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo 0
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    # min(3, ...) scales the absolute-overlap floor down for short diagnoses — a
    # diagnosis with only 2 significant words (e.g. "exact repeats") could never
    # reach a flat floor of 3 even when identical to itself.
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

count = 0
for d in reversed(events):
    if same_root_cause(d, current):
        count += 1
    else:
        break
print(count)
PYEOF
)
    if [ "${repeat_count:-0}" -ge 2 ]; then
        # Deterministic safety net before giving up: a known, mechanical fix may
        # exist for this exact recurring symptom even though the LLM analyst
        # couldn't apply it through its 5-target routing. If found and applied,
        # skip the HEALING_BROKEN escalation entirely and let the next retry use
        # the now-patched file.
        if apply_known_fix "${PROJECT_ROOT:-}" "$current_diagnosis"; then
            log "  [HealingBroken] Deterministic known-fix applied — not counting this as a broken-healing cycle"
            return 0
        fi
        error "  [HealingBroken] CRITICAL: '${current_diagnosis}' has recurred ${repeat_count}+ times for $story_id without a different fix — self-healing is NOT working."
        error "  [HealingBroken] Check: (1) gate model is reachable (2) failure analyst is diagnosing correctly (3) patches are being applied"
        # Write a HEALING_BROKEN sentinel record so the run summary captures this.
        # Include all standard healing-events fields so the dashboard renders it
        # correctly (retry, rung, target, diagnosis must be non-null).
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
        local safe_diag
        safe_diag=$(printf '%s' "$current_diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
        local _broken_rung
        _broken_rung=$(( retry_num / 2 ))
        printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"none","diagnosis":"%s","patches_applied":0,"profile_updated":false,"event":"HEALING_BROKEN","repeated_diagnosis":"%s","count":%s}\n' \
            "$ts" "$story_id" "$retry_num" "$_broken_rung" "$safe_diag" "$safe_diag" "$repeat_count" >> "$heal_log"
        HEALING_BROKEN=1
        export HEALING_BROKEN
    fi
}

# check_failure_diversity <story_id> <retry_num> <current_diagnosis>
# Mirror of check_healing_effectiveness, inverted: that function detects the SAME
# diagnosis repeating (healing is broken, skip ahead). This detects consecutive
# DIFFERENT diagnoses while still on the un-escalated base model (Rung 0-1,
# retries 0-3) — evidence of a genuine capability gap, not a transient mistake
# "one more attempt" will fix. Root cause addressed: SKY-004 spent 4 of 8
# attempts (half its budget) on MiniMax-M3 despite 4 DIFFERENT failures
# surfacing in that window (wrong import path -> incomplete mock factory ->
# missing test import/mock export -> ...), only reaching model escalation at
# attempt 5. Sets EARLY_ESCALATION_NEEDED=1 so the retry loop can jump straight
# to Rung 2 instead of exhausting the rest of the base-model budget on a model
# that's visibly not converging. No-op once the model has already escalated
# (rung >= 2) — this signal only matters before that point.
check_failure_diversity() {
    local story_id="$1"
    local retry_num="$2"
    local current_diagnosis="$3"

    local _rung=$(( retry_num / 2 ))
    [ "$_rung" -ge 2 ] && return 0

    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0

    local is_different
    is_different=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo "false"
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

# events[-1] is the diagnosis just written for THIS attempt (run_healing_recorder
# runs before this check, same ordering as check_healing_effectiveness). Compare
# it against the immediately preceding attempt's diagnosis.
if len(events) < 2:
    print("false")
else:
    prev, cur = events[-2], events[-1]
    print("false" if same_root_cause(prev, cur) else "true")
PYEOF
)

    if [ "$is_different" = "true" ]; then
        warning "  [FailureDiversity] Different failure class than the previous attempt while still on the base model — likely a capability gap, not a transient mistake"
        EARLY_ESCALATION_NEEDED=1
        export EARLY_ESCALATION_NEEDED
    fi
}

# same_root_cause_diagnoses <diagnosis_a> <diagnosis_b>
# Standalone version of the token-overlap comparison embedded in
# check_healing_effectiveness/check_failure_diversity — extracted here because a
# THIRD caller needs it (deterministic-check repeat detection, added live during
# run #15) that already has both text strings in hand and has no reason to read
# or write healing-events.jsonl for this comparison. Echoes "true" or "false".
same_root_cause_diagnoses() {
    local a="$1"
    local b="$2"
    python3 - "$a" "$b" 2>/dev/null << 'PYEOF' || echo "false"
import re, sys

a, b = sys.argv[1], sys.argv[2]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

ta, tb = tokens(a), tokens(b)
if not ta or not tb:
    print("true" if a[:20] == b[:20] else "false")
else:
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    print("true" if len(overlap) >= min_overlap and ratio >= 0.4 else "false")
PYEOF
}

# compute_retry_extension_evidence <story_id>
# Deterministic (no LLM cost) evidence gathering for the retry-extension
# coordinator, computed purely from two JSONL logs that already exist:
#   healing-events.jsonl              (run_healing_recorder, self-heal events
#                                       + the HEALING_BROKEN sentinel record)
#   failure-diagnosis-groundedness.jsonl (run_diagnosis_groundedness_check)
# Prints a single JSON object to stdout:
#   {"total_heal_events":N,"distinct_diagnoses":N,"healing_broken_ever":bool,
#    "avg_groundedness":N,"groundedness_sample_count":N}
compute_retry_extension_evidence() {
    local story_id="$1"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    local grounded_log="${LOG_DIR}/failure-diagnosis-groundedness.jsonl"

    local total_heal_events=0 distinct_diagnoses=0 healing_broken_ever="false"
    if [ -f "$heal_log" ]; then
        total_heal_events=$(jq -r --arg s "$story_id" 'select(.story_id == $s and .event != "HEALING_BROKEN")' "$heal_log" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
        # NOTE: `grep -c .` exits 1 (even though it correctly PRINTS "0")
        # when zero lines match -- under this script's `set -e`, a bare
        # `local var=$(pipeline-ending-in-grep-c)` with no matches SILENTLY
        # ABORTS THE WHOLE FUNCTION (and, being under set -e, potentially
        # the whole claude.sh process) the moment any story has zero heal
        # events -- the common/healthy case. Confirmed via direct
        # `set -e` reproduction while building this. `wc -l` exits 0
        # unconditionally and prints "0" for empty input just as correctly
        # -- use that instead, never grep -c, for any count-of-lines-that-
        # might-be-zero computation under this file's set -e.
        distinct_diagnoses=$(jq -r --arg s "$story_id" 'select(.story_id == $s and .event != "HEALING_BROKEN") | .diagnosis' "$heal_log" 2>/dev/null | sort -u | wc -l | tr -d ' ')
        if jq -e --arg s "$story_id" 'select(.story_id == $s and .event == "HEALING_BROKEN")' "$heal_log" >/dev/null 2>&1; then
            healing_broken_ever="true"
        fi
    fi

    local avg_groundedness=0 groundedness_sample_count=0
    if [ -f "$grounded_log" ]; then
        groundedness_sample_count=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false)' "$grounded_log" 2>/dev/null | jq -s 'length' 2>/dev/null || echo 0)
        if [ "${groundedness_sample_count:-0}" -gt 0 ] 2>/dev/null; then
            avg_groundedness=$(jq -r --arg s "$story_id" 'select(.storyId == $s and .skipped == false) | .score' "$grounded_log" 2>/dev/null | \
                python3 "$SCRIPT_DIR/lib/handlers/compute-retry-extension-evidence.py" 2>/dev/null || echo 0)
        fi
    fi

    jq -nc --argjson total "${total_heal_events:-0}" --argjson distinct "${distinct_diagnoses:-0}" \
        --argjson broken "$healing_broken_ever" --argjson avg "${avg_groundedness:-0}" \
        --argjson samples "${groundedness_sample_count:-0}" \
        '{total_heal_events:$total, distinct_diagnoses:$distinct, healing_broken_ever:$broken, avg_groundedness:$avg, groundedness_sample_count:$samples}'
}

# resolve_role_retry_extension_max <story_id>
# Reads EPAM_ROLE_RETRY_EXTENSION_MAP (pipe-separated "agentRole=max" pairs,
# same convention as EPAM_MODEL_LADDER_*/EPAM_MODEL_PROVIDER_MAP) and returns
# the extension cap for the story's agentRole, falling back to
# EPAM_RETRY_EXTENSION_MAX (default 2) when the role has no entry. agentRole
# is whatever the pipeline itself assigned in prd.json (Step 0.5/0.9) --
# never a hardcoded project-specific value here.
resolve_role_retry_extension_max() {
    local story_id="$1"
    local default_max="${EPAM_RETRY_EXTENSION_MAX:-2}"
    local role
    role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
    [ -z "$role" ] && { echo "$default_max"; return 0; }
    local map pair from to ifs_save="$IFS"
    map="${EPAM_ROLE_RETRY_EXTENSION_MAP:-test-engineer=4}"
    IFS='|'; read -ra pairs <<< "$map"; IFS="$ifs_save"
    for pair in "${pairs[@]}"; do
        from="${pair%%=*}"; to="${pair#*=}"
        if [ "$role" = "$from" ]; then
            echo "$to"
            return 0
        fi
    done
    echo "$default_max"
}

# run_retry_extension_coordinator <story_id>
# Dynamic self-heal augmentation (2026-07-12, user request): a story that
# exhausted MAX_RETRIES with genuine, converging progress (each failure a
# DIFFERENT diagnosed bug, not a repeat) shouldn't necessarily be abandoned
# at a fixed, one-size-fits-all ceiling. This is a bounded, evidence-gated
# extension of that ceiling — NOT free-form LLM re-judgment of the hardcoded
# limit: deterministic evidence is computed first, and the LLM is only
# consulted when that evidence is genuinely ambiguous (see the pre-gate
# below), mirroring the "trust the deterministic oracle over an LLM opinion"
# principle already used elsewhere in this pipeline (e.g. SAST/spec-
# validator's blockerCount-over-self-reported-verdict trust).
#
# Prints the number of EXTRA retries granted (0 if not extending) to stdout.
# Fails closed (prints 0) on any error, disabled state, or malformed gate
# response -- this must never be able to grant an extension it can't justify
# with real evidence.
run_retry_extension_coordinator() {
    local story_id="$1"
    if [ "${EPAM_RETRY_EXTENSION_ENABLED:-0}" != "1" ]; then
        echo 0
        return 0
    fi

    local evidence
    evidence=$(compute_retry_extension_evidence "$story_id")
    if [ -z "$evidence" ] || ! echo "$evidence" | jq empty 2>/dev/null; then
        # UNREADABLE EVIDENCE IS NOT "NO EXTENSION WARRANTED". Both answer 0, and the caller
        # cannot tell them apart — the same defect fixed two branches below, where a missing
        # provider also returned a believable 0. Say which happened; the value is unchanged so
        # no run behaves differently, but a 0 that nobody decided is now visible.
        log "  [RetryExtension] retry-extension evidence for ${story_id} is missing or not valid JSON — returning 0 because it could not be READ, not because none was warranted"
        echo 0
        return 0
    fi

    local total_heal_events distinct_diagnoses healing_broken_ever
    total_heal_events=$(echo "$evidence" | jq -r '.total_heal_events')
    distinct_diagnoses=$(echo "$evidence" | jq -r '.distinct_diagnoses')
    healing_broken_ever=$(echo "$evidence" | jq -r '.healing_broken_ever')

    # Deterministic pre-gate: skip the LLM call entirely when the evidence
    # already answers the question. A repeated (non-distinct) diagnosis, or
    # a HEALING_BROKEN sentinel, is direct proof of non-convergence -- no
    # amount of LLM judgment changes that, so don't spend a gate-model call
    # asking.
    if [ "$healing_broken_ever" = "true" ] || [ "${distinct_diagnoses:-0}" -lt "${total_heal_events:-0}" ] 2>/dev/null; then
        # >&2: this function's return value is captured by the caller via
        # $(...) -- log() writes to STDOUT (see its own definition), so
        # without this redirect the log line gets mixed INTO the captured
        # "0" below, corrupting it into a multi-line non-numeric string.
        # Found live (2026-07-13, SKY-003): the caller's numeric
        # `[ "$_granted_extra_retries" -gt 0 ]` check silently failed on the
        # corrupted capture, so a genuinely GRANTED extension (proven by
        # retry-extension-decisions.jsonl showing extraRetriesGranted:2) was
        # never actually applied -- the story was still marked failed.
        log "  [RetryExtension] $story_id: evidence shows non-convergence (healing_broken=$healing_broken_ever distinct=$distinct_diagnoses/$total_heal_events) — not extending, no gate call made" >&2
        echo 0
        return 0
    fi

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    local gate_model="${EPAM_MODEL:-}"
    if [ -z "$gate_provider" ]; then
        # 0 is a plausible answer — "no extension is warranted" — and was returned without any
        # coordination happening. Same shape as the fabricated "pass" above: a value nobody
        # decided, arriving where a decision is expected.
        log "  [RetryExtension] no gate provider configured — SKIPPING coordination; returning 0 because none was DECIDED, not because none was warranted"
        echo 0
        return 0
    fi

    local profiles_file
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    local coordinator_profile=""
    if [ -f "$profiles_file" ]; then
        coordinator_profile=$(require_profile "retry-extension-coordinator" "$profiles_file" || true)
    fi

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local ac_count
    ac_count=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | ((.acceptanceCriteria // []) | length)' "$prd_target" 2>/dev/null || echo 0)

    local coord_prompt
    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/retry-extension-coordinator-vals-XXXXXX.json")
    jq_vals \
          --arg retry_count "${retry_count:-unknown}" \
          --arg max_retries "${MAX_RETRIES:-unknown}" \
          --arg coordinator_profile "${coordinator_profile}" \
          --arg story_id "${story_id}" \
          --arg ac_count "${ac_count}" \
          --arg evidence "${evidence}" \
          '{"__RETRY_COUNT__":$retry_count,"__MAX_RETRIES__":$max_retries,"__COORDINATOR_PROFILE__":$coordinator_profile,"__STORY_ID__":$story_id,"__AC_COUNT__":$ac_count,"__EVIDENCE__":$evidence}' > "$_cp_vals"
    coord_prompt="$(render_engine_prompt retry-extension-coordinator "$_cp_vals")"
    rm -f "$_cp_vals"

    local coord_raw=""
    coord_raw=$(echo "$coord_prompt" | \
        AI_PROVIDER="$gate_provider" \
        AI_MODEL="$gate_model" \
        EPAM_CLI="$EPAM_CLI" \
        bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
        ${gate_model:+--model "$gate_model"} \
        2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"coordinator unavailable"}')

    local extend="false" extra_retries=0 reason=""
    local parsed
    parsed=$(echo "$coord_raw" | python3 "$SCRIPT_DIR/lib/handlers/retry-extension-parsed.py" 2>/dev/null || echo '{"extend":false,"extraRetries":0,"reason":"unparseable"}')

    extend=$(echo "$parsed" | jq -r '.extend // false' 2>/dev/null || echo "false")
    extra_retries=$(echo "$parsed" | jq -r '.extraRetries // 0' 2>/dev/null || echo 0)
    reason=$(echo "$parsed" | jq -r '.reason // ""' 2>/dev/null || echo "")

    local granted=0
    if [ "$extend" = "true" ]; then
        local _max
        _max=$(resolve_role_retry_extension_max "$story_id")
        granted="$extra_retries"
        [ "$granted" -gt "$_max" ] 2>/dev/null && granted="$_max"
        [ "$granted" -lt 0 ] 2>/dev/null && granted=0
        # Re-validate is an int; a malformed extraRetries (non-numeric) fails closed.
        case "$granted" in
            ''|*[!0-9]*) granted=0 ;;
        esac
    fi

    mkdir -p "${OUTPUT_DIR:-$LOG_DIR}" 2>/dev/null
    jq -nc --arg story "$story_id" --argjson evidence "$evidence" --arg extend "$extend" \
        --argjson granted "${granted:-0}" --arg reason "$reason" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, evidence: $evidence, extend: ($extend == "true"), extraRetriesGranted: $granted, reason: $reason, timestamp: $ts}' \
        >> "${OUTPUT_DIR:-$LOG_DIR}/retry-extension-decisions.jsonl" 2>/dev/null || true

    if [ "${granted:-0}" -gt 0 ] 2>/dev/null; then
        # >&2 -- see the identical rationale at this function's other log
        # call above (the pre-gate decline path). This was the exact site
        # where a genuinely granted extension got silently dropped live.
        log "  [RetryExtension] $story_id: extending by $granted retr(y/ies) — $reason" >&2
    fi
    echo "${granted:-0}"
    return 0
}

# Invoke Claude CLI to implement a story
implement_story() {
    local story_id=$1

    # WHO MAY AUTHOR CODE — checked before any work, not after.
    #
    # Capability comes from the seam: anything running here holds write_file and bash, which
    # is correct for an agent whose job is to author code. So the boundary that matters is
    # WHICH agent reaches this seam. Until now that was guarded in exactly one place —
    # assignment offering only registered implementers — and perimeter_role_may_write, which
    # exists and is tested, was called by nothing in production.
    #
    # Single-layer protection is thin now that the roster is GENERATED rather than curated.
    # A hand-edited PRD at the roster pause, a resume carrying a stale assignment, or any
    # future path that bypasses candidateRoles would put a read-only investigator at the
    # writer seam with full writer tools, and nothing would object: the chmod perimeter
    # decides by branch and worktree, never by who.
    #
    # Fails CLOSED and LOUD. A story whose role may not write stops here rather than
    # producing changes nobody sanctioned.
    if command -v perimeter_role_may_write >/dev/null 2>&1; then
        local _iw_role
        # PER CODELINE. A story spanning three repositories carries one role per codeline in
        # agentRoles; agentRole is only the primary. Reading the primary in every lane is how a
        # role briefed for one codeline ends up working in another.
        _iw_role=$(jq -r --arg id "$story_id" --arg cl "${EPAM_CODELINE:-}" \
            '.stories[] | select(.id == $id)
             | (.agentRoles[$cl] // .agentRole // "")' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ -n "$_iw_role" ] && ! perimeter_role_may_write "$_iw_role"; then
            error "Story ${story_id} is assigned to '${_iw_role}', which is not permitted to author code."
            error "  Implementers are registered in project-roles.json; investigators are read-only by design."
            error "  Refusing to run the writer — an agent that may not write must not reach the writer seam."
            return 1
        fi
    fi
    # Seeded from persisted state, NOT hardcoded 0 — a Step 3.6 review
    # rejection re-invokes this whole script as a brand-new process, and
    # without this the ladder silently restarted at rung 0 every review
    # cycle (see lib/story-retry-state.sh's docstring for the live incident
    # this fixes). Cleared for free by teardown at the start of every run,
    # since the state file lives under LOG_DIR.
    local retry_count
    retry_count="$(read_story_retry_count "$LOG_DIR" "$story_id")"
    if [ "$retry_count" -gt 0 ] 2>/dev/null; then
        log "  [InferenceLadder] $story_id resuming at retry_count=$retry_count (persisted from an earlier invocation)"
    fi
    # Shadows the script-global MAX_RETRIES for the duration of THIS story
    # only. run_retry_extension_coordinator() (below) can bump this local
    # copy when it grants a bounded extension -- shadowing it here (rather
    # than mutating and manually restoring the global) means bash itself
    # guarantees the original value comes back on EVERY exit path from this
    # function (success mid-loop return, or the failure path at the bottom),
    # with no risk of a granted extension leaking into the NEXT story's
    # budget in the same claude.sh process.
    local MAX_RETRIES="$MAX_RETRIES"
    local _retry_extension_used=0
    local _budget_warned=0
    # Set by _rejection_repeat_check below when the SAME rejection fires twice
    # in a row — same input, same wrong output is exactly what temperature
    # exists to break out of. Read once, right after the rung case statement
    # sets its own baseline temperature, so the bump applies on top regardless
    # of which rung fired.
    local _repeat_rejection_detected=false
    # These are GLOBALS (set by verify_story_deliverables, no `local` there —
    # same pattern as STORY_REJECTION_KEY), so a fresh story must not inherit
    # whatever the PREVIOUS story's last verification call left behind before
    # this story has ever called verify_story_deliverables itself.
    LAST_VERIFIED_TOUCHED_FILES=""
    LAST_VERIFIED_UNCHANGED_FILES=""
    # Which rung's contribution the NEXT attribution call should credit
    # changes to (backlog #113) — updated every rung transition, read at the
    # NEXT one and again at the story's own success path.
    local _last_attributed_rung=0
    # Caps free retries granted for deterministic-check failures (see
    # DETERMINISTIC_CHECK_FAILURE) — these don't count against retry_count/the
    # ladder, but an unbounded free-retry loop is still a real risk if a check
    # keeps finding a violation the agent can't seem to fix. After this many
    # free retries, fall through to a normal counted retry instead.
    local _free_retry_count=0
    # Counts every actual invocation (unlike retry_count, which free retries
    # deliberately do NOT advance) — used to gate COORDINATOR_PROMPT_AMENDMENT
    # injection below ("is this the first attempt of THIS story or not").
    local _total_attempts=0
    # Tracks the last deterministic-check violation message for this story, so a
    # repeat can be detected WITHOUT going through run_failure_analyst (which
    # deterministic-check failures deliberately skip). Confirmed live (run #15,
    # 2026-07-05): without this, the SAME relative-import-check violation
    # repeated 5 times across free AND counted retries with no escalation at
    # all, because check_healing_effectiveness's repeat detector only runs
    # inside run_failure_analyst.
    local _prev_deterministic_violation=""
    # run_implementation() processes multiple stories in one claude.sh
    # invocation; COORDINATOR_PROMPT_AMENDMENT is a script-global set by the
    # previous story's failure-analyst/deterministic-check path and was never
    # reset between stories, so a stale amendment from story A could otherwise
    # leak into story B's first attempt.
    COORDINATOR_PROMPT_AMENDMENT=""
    local output_file
    output_file="$CLAUDE_OUTPUT_DIR/${story_id}_$(date +'%Y%m%d_%H%M%S').log"
    local story_started_at
    story_started_at=$(date -Iseconds)

    local title
    title=$(get_story_title "$story_id")
    log "Implementing story: $story_id - $title"
    update_monitor_status "start" "$story_id"

    # Check dependencies first
    if ! are_dependencies_satisfied "$story_id"; then
        local deps
        deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
        error "Cannot implement $story_id - dependencies not satisfied: $deps"
        return 1
    fi

    # Plan mode check: run planning agent before implementation if complexity thresholds met
    if check_plan_mode_required "$story_id"; then
        log "Plan mode required for $story_id (estimatedHours>=6, deps>=2, or flag set)"
        run_plan_mode "$story_id"
    fi

    # Resolve effort -> model + max-turns for this story (stable across retries)
    resolve_effort_settings "$story_id"
    # Resolve generator mode — overrides effort settings when agentRole=generator
    resolve_generator_settings "$story_id"
    # Bump the iteration/token budget one tier for test-engineer stories —
    # see resolve_test_engineer_effort_floor's own docstring for why.
    resolve_test_engineer_effort_floor "$story_id"
    # Floor the output/iteration budget for brownfield reasoning-model runs so
    # the <think> block + the actual edit both fit in one response — see
    # resolve_brownfield_effort_floor's docstring (found live: reasoning
    # truncated mid-think before writing → "deliverables UNCHANGED").
    resolve_brownfield_effort_floor "$story_id"
    log "  Effort[final] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS}"

    # ── Self-heal KB (pillar 3: enforcement) ─────────────────────────────────
    # Applied AFTER effort resolution and BEFORE the invocation, so a learned
    # constraint overrides the computed default rather than being overwritten by
    # it. Arrives as parameters, never as prompt text. Flag-guarded and inert by
    # Always on — self-heal is not optional (switch removed 2026-07-25).
    if true; then
        local _kb_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_lib"
            kb_apply_constraints "${STORY_ROLE:-}" "story:${story_id:-}" || true
            # Pillar 2: rules that fired stay alive, rules that did not age toward
            # their TTL and are archived for re-validation instead of trusted forever.
            kb_tick "${KB_LAST_FIRED:-}" || true
            [ -n "${KB_LAST_FIRED:-}" ] && \
                log "  Effort[KB] -> maxIter=${STORY_MAX_ITERATIONS} maxOutTok=${STORY_MAX_OUTPUT_TOKENS} (${KB_LAST_FIRED})"
        fi
    fi
    # Resolve aiProvider -> which CLI binary to use
    resolve_provider_settings "$story_id"
    # Resume the MODEL the ladder had climbed to, not just the counter.
    #
    # MUST sit AFTER resolve_provider_settings: that function re-derives STORY_MODEL from the
    # PRD, so seeding before it had the persisted model silently overwritten and the ladder
    # restarted its climb on every re-invocation. Observed live 2026-08-10 — the .model file
    # was written correctly and the 'resuming on' line never appeared once.
    STORY_ITERATION_BUMP_TOTAL="$(read_story_iteration_bump "$LOG_DIR" "$story_id")"
    export STORY_ITERATION_BUMP_TOTAL
    local _persisted_model
    _persisted_model="$(read_story_retry_model "$LOG_DIR" "$story_id")"
    if [ -n "$_persisted_model" ] && [ "$_persisted_model" != "${STORY_MODEL:-}" ]; then
        log "  [InferenceLadder] $story_id resuming on '$_persisted_model' (escalated in an earlier invocation; PRD model is '${STORY_MODEL:-}')"
        STORY_MODEL="$_persisted_model"
        # A RESTORED RUNG IS NOT A DEFAULT TO BE RE-DERIVED.
        #
        # resolve_model_from_story() runs further down this same function and assigns STORY_MODEL
        # straight from prd.json whenever the story declares one — it cannot know a ladder position
        # was just restored. Live 2026-08-19 (AMSD-2041): the ladder reached moonshotai/kimi-k3,
        # produced the story's best attempt and committed it; the next re-implementation cycle
        # resumed on kimi-k3, was silently re-derived back to MiniMax-M3, and escalated from THERE
        # to z-ai/glm-5.2 — a step DOWN, immediately after reaching the top. Every re-implementation
        # crosses an invocation boundary, so the ladder could climb within an invocation and never
        # hold ground across one.
        #
        # This is the same defect the comment above already fixed for resolve_provider_settings,
        # recurring at the SECOND re-derivation below it.
        STORY_MODEL_LADDER_RESUMED="$_persisted_model"
        export STORY_MODEL_LADDER_RESUMED
        local _resumed_provider
        _resumed_provider=$(resolve_model_provider "$_persisted_model")
        [ -n "$_resumed_provider" ] && STORY_PROVIDER="$_resumed_provider"
    fi

    # Capture original model so phase R3 can detect whether R2 escalated it
    STORY_MODEL_ORIGINAL="${STORY_MODEL:-}"
    # Reset reasoning effort to default at story start (previous story's setting must not leak)
    export EPAM_REASONING_EFFORT="${EPAM_RUNG0_REASONING_EFFORT:-medium}"
    # Reset temperature override at story start (previous story's FailureDiversity
    # or escalation-triggered override must not leak into an unrelated story) —
    # but restore the launcher-provided floor (_claude_temperature_floor, captured
    # once at process start) rather than unsetting to nothing. Without this, a
    # project-wide pin (e.g. tier3-travel-app-run.sh's EPAM_TEMPERATURE=0 for GLM
    # models) would be wiped before the very first model call of every story.
    if [ -n "$_claude_temperature_floor" ]; then
        export EPAM_TEMPERATURE="$_claude_temperature_floor"
    else
        unset EPAM_TEMPERATURE
    fi
    # For epam-run providers, prd.json .model field overrides effort-based model
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    case "$STORY_PROVIDER" in
        codex) resolve_codex_model_settings "$story_id" ;;
        copilot|openai|openrouter|cursor|minimax) resolve_model_from_story "$story_id" ;;
    esac
    # prd-model-coordinator's .reasoningEffort field overrides the "low" reset above
    resolve_reasoning_effort_from_story "$story_id"
    # Resolve optional plannerModel — runs a planning pass before execution
    resolve_planner_settings "$story_id"
    # Resolve dynamic constitution rules for this story (appends to AGENT_CONSTITUTION)
    resolve_dynamic_constitution "$story_id"
    # Brownfield surgeon preamble — injected when EPAM_BROWNFIELD=1; never active in greenfield.
    # Rules numbered from 6 to extend the five already in AGENT_CONSTITUTION without overlap.
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        # Rules 6-9 branch on storyKind — same lookup already used above for reasoning
        # effort (line ~5402), same story, reused rather than a second query. Found live
        # 2026-08-05 on AMSD-2041 (storyKind: novel, description is its own title
        # repeated): rule 6 as written asked the writer to "locate the existing code path
        # that handles the behavior" for a capability that does not exist yet, and rule 8
        # required the description to literally contain the word "create"/"add new"/
        # "build new" before permitting a new file — a trigger AMSD-2041's bare-title
        # description could never contain. A defect DOES have a known, bounded fix site;
        # a novel story does not, and forcing the same "find it, fix minimally, no new
        # files" framing onto both is the same defect-only-prompt blind spot already fixed
        # in the code-graph-detective (spec-mode-runner.js) and SPEC_AGENT prompts.
        _bfw_story_kind=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .storyKind // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        # Surgeon-mode rules come from orchestrations/config/agent-contract.json, rendered by
        # lib/render-prompt-section.js — a real file, not `node -e`, because the inline form
        # broke this script three times: the JS carries braces and quotes that must survive a
        # double-quoted shell string inside a command substitution.
        #
        # The two rules shared by both modes are defined ONCE in the catalog. They were
        # copy-pasted into each arm of this branch, byte-identical, nine lines apart, and each
        # copy then had to be maintained separately.
        _bfw_section="brownfieldExisting"
        [ "$_bfw_story_kind" = "novel" ] && _bfw_section="brownfieldNovel"
        _bfw_rules=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/render-prompt-section.js" \
            "$SCRIPT_DIR/../config/agent-contract.json" "$_bfw_section" "_startIndex=6" 2>/dev/null || echo "")
        if [ -n "$_bfw_rules" ]; then
            DYNAMIC_CONSTITUTION="${DYNAMIC_CONSTITUTION}"$'\n\n'"${_bfw_rules}"
        fi
    fi
    # GAP-P17: inject outputSchema instruction when story defines one
    local schema_block=""
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local story_output_schema
    story_output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")
    if [ -n "$story_output_schema" ]; then
        schema_block=$'\n\nOUTPUT SCHEMA REQUIREMENT:\nYou MUST conclude your response with a JSON object that conforms to the following JSON Schema. Wrap it in a ```json code block.\n```json\n'"$story_output_schema"$'\n```'
        log "  OutputSchema: structured output required for $story_id"
    fi
    # Build effective constitution = static base + dynamic rules + optional schema block.
    # Mirrors CLAUDE_PERMISSIONS: empty in interactive mode (no skip-permissions).
    local effective_constitution="${AGENT_CONSTITUTION}${DYNAMIC_CONSTITUTION}${schema_block}"
    local effective_permissions=()
    if [ ${#CLAUDE_PERMISSIONS[@]} -gt 0 ]; then
        effective_permissions=(
            "--dangerously-skip-permissions"
            "--append-system-prompt"
            "$effective_constitution"
        )
    fi
    local model_flag=()
    [ -n "${STORY_MODEL:-}" ] && model_flag=(--model "$STORY_MODEL")

    # THE CAPS THIS PATH NEVER HAD. `--max-turns` was built here from STORY_MAX_TURNS, and
    # BOTH halves were dead: the flag no longer exists in Claude Code (the env var
    # CLAUDE_CODE_MAX_TURNS replaced it), and STORY_MAX_TURNS was hardcoded "" in every effort
    # branch so it was never emitted. A flag that cannot fire is not a cap — which is how one
    # seam ran 1,486 generations in 44 minutes with nothing able to stop it.
    #
    # What replaces it names no knob: the runner's DECLARATION says which env vars and flags it
    # takes, and apply_runner_settings passes exactly those. A runner that declares nothing
    # gets nothing, so every other path behaves exactly as before.
    RUNNER_FLAGS=()
    apply_runner_settings "$(basename "${CLAUDE_CMD:-}")" "${EPAM_PROJECT_CONFIG_DIR:-}" || true
    local story_cli
    STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
    story_cli=$(provider_to_cli "$STORY_PROVIDER")

    # Planning phase: when plannerModel is set, run one planning invocation first.
    # The returned plan is injected into every execution attempt as fixed context.
    local story_plan=""
    if [ -n "${STORY_PLANNER_MODEL:-}" ]; then
        log "  Running planning phase with $STORY_PLANNER_MODEL..."
        story_plan=$(run_planning_phase "$story_id" "$STORY_PLANNER_MODEL")
        story_plan=$(review_and_correct_plan "$story_id" "$story_plan")
        local plan_words
        plan_words=$(echo "$story_plan" | wc -w)
        log "  Planning phase complete ($plan_words words, reviewed)"
    fi

    while true; do
    while [ $retry_count -le $MAX_RETRIES ]; do
        _total_attempts=$((_total_attempts + 1))
        # Inference ladder: on retry, escalate to a stronger model + increase reasoning effort.
        # Priority: PRD retryModel > EPAM_RETRY_MODEL env var > built-in get_model_ladder_step().
        # Principle: NEVER retry with the same model — every failure steps up. Logged visibly.
        if [ "$retry_count" -gt 0 ]; then
            # ── Rung-based inference ladder ────────────────────────────────────────
            # 2 attempts per rung: attempt 1 (cold), self-healing fires, attempt 2
            # (informed). Escalate only when entering a new rung.
            #
            # Rung 0 (retries 0-1): base model, base effort
            # Rung 1 (retries 2-3): same model, reasoning effort → medium
            # Rung 2 (retries 4-5): escalated model, reasoning effort → medium
            # Rung 3 (retries 6-7): escalated model, reasoning effort → high
            # ──────────────────────────────────────────────────────────────────────
            local _rung=$(( retry_count / 2 ))
            local _entering_rung=$(( retry_count % 2 == 0 ))   # 1 = first attempt of rung

            # A rung normally gets two attempts: the model's answer, then a
            # re-ask with self-heal guidance. That second attempt is only worth
            # paying for if something about it can differ. When the LAST attempt
            # was rejected for the exact same reason as the one before it, the
            # model has already read the corrective and declined it — live
            # AMSD-2041 2026-07-30 produced byte-identical prescribed-helper
            # rejections on attempts 2, 3 and 4 while the prompt named the helper
            # 21 times. Re-asking buys a copy of the last answer, so step the
            # ladder instead and put a different model on it.
            #
            # This does not make any model comply — that requires the requirement
            # to be structural rather than advisory (IMPL-PROSE). It stops paying
            # for the same refusal twice.
            if _rejection_repeat_check "$story_id" "${STORY_REJECTION_KEY:-}"; then
                _repeat_rejection_detected=true
                if [ "$_entering_rung" -ne 1 ]; then
                    log "  InferenceLadder[R${retry_count}]: identical rejection twice (${STORY_REJECTION_KEY}) — advancing the rung early rather than re-asking a model that already refused"
                    _entering_rung=1
                fi
            fi

            # skipLadder: set by spec-mode-runner.js (veryHighComplexity AC-count)
            # or lib/tc-writer-gate.sh (TC-fact-density). Both pre-assign the
            # ceiling model before the first attempt. skipLadder=true means
            # DOWNGRADE PREVENTION ONLY — if a higher ladder step exists above the
            # current model, escalation proceeds normally. Only when the ladder has
            # no higher step (get_model_ladder_step returns same or empty) does the
            # story stay at its current ceiling. Effort/iteration-budget escalation
            # always applies regardless of skipLadder.
            local _skip_ladder
            _skip_ladder=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .skipLadder // false' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo false)

            local _prev_model="${STORY_MODEL:-}"
            if [ "$_entering_rung" -eq 1 ]; then
                case "$_rung" in
                    1)
                        # Rung 1: same model, effort → medium. Temperature is
                        # env-overridable (EPAM_RUNG1_TEMPERATURE), not a fixed
                        # policy choice baked into the engine — a project may
                        # find its models need a different value here (e.g.
                        # GLM-5.1's own vendor guidance recommends 0.6-0.8 for
                        # complex multi-file work to avoid instruction drift;
                        # this project currently defaults lower). Default (0)
                        # preserves existing behavior for anything that hasn't
                        # opted in.
                        # FLOOR, not assignment. A rung transition used to overwrite effort outright, so rung 1
                        # set medium AFTER the per-retry escalation had raised it to max —
                        # de-escalating a struggling story. Operator rule: a retry never lowers
                        # effort. Rung 0 still ASSIGNS, because it is the story's starting point
                        # and must not inherit the previous story's ceiling.
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG1_REASONING_EFFORT:-medium}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG1_TEMPERATURE:-0}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung1"
                        # EVERY rung steps the model. Rung 1 used to hold the model fixed and
                        # raise effort only — so a story that failed twice retried on the SAME
                        # model, which is not a ladder. Observed live 2026-08-10: four attempts,
                        # MiniMax-M3 throughout, and the run read as "the ladder is stuck".
                        # Same resolution order as the other rungs: an explicit PRD retryModel or
                        # EPAM_RETRY_MODEL wins, otherwise the tier's configured chain.
                        local _retry_model_prd_r1 _ladder_step_r1 _escalated_r1
                        _retry_model_prd_r1=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        _escalated_r1="${_retry_model_prd_r1:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$_escalated_r1" ]; then
                            # Delegated to next_ladder_step — the ladder decision as a pure
                            # function, covered by next-ladder-step.test.ts (14 tests, three
                            # mutation-verified invariants). The arm keeps its logging and
                            # provider resolution; it no longer carries its own copy of the rules.
                            local _ladder_tier_r1 _decided_r1
                            _ladder_tier_r1=$(classify_ladder_tier "$story_id")
                            _decided_r1=$(next_ladder_step 1 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier_r1")
                            _ladder_step_r1="${_decided_r1%%|*}"
                            [ -n "$_ladder_step_r1" ] && [ "$_ladder_step_r1" != "${STORY_MODEL:-}" ] && _escalated_r1="$_ladder_step_r1"
                            local _decided_effort_r1="${_decided_r1#*|}"; _decided_effort_r1="${_decided_effort_r1%%|*}"
                            [ -n "$_decided_effort_r1" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r1"
                        fi
                        if [ -n "$_escalated_r1" ] && [ "$_escalated_r1" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung1/R${retry_count}]: model '${STORY_MODEL:-default}' → '$_escalated_r1'"
                            STORY_MODEL="$_escalated_r1"
                            local _prov_r1
                            _prov_r1=$(resolve_model_provider "$_escalated_r1")
                            [ -n "$_prov_r1" ] && STORY_PROVIDER="$_prov_r1"
                        else
                            log "  InferenceLadder[Rung1/R${retry_count}]: at the top of its chain — effort is the remaining lever"
                        fi
                        ;;
                    2)
                        # Rung 2: model escalation, effort → medium
                        # skipLadder=true means the story was pre-assigned a ceiling model by
                        # tc-writer-gate or spec-mode (very-high-complexity). We still compute the
                        # next ladder step — if one exists ABOVE the current model we apply it
                        # (upward escalation is always allowed). We only stay put when the ladder
                        # has nowhere higher to go (same model returned or no step found).
                        local retry_model_prd ladder_step_r2
                        retry_model_prd=$(jq -r --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .retryModel // ""' \
                            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                        local escalated_model_r2="${retry_model_prd:-${EPAM_RETRY_MODEL:-}}"
                        if [ -z "$escalated_model_r2" ]; then
                            # Delegated to next_ladder_step — the ladder decision as a pure
                            # function (next-ladder-step.test.ts: 14 tests, 3 mutation-verified
                            # invariants). This arm keeps its skipLadder/HealingBroken handling,
                            # its logging and its provider resolution; it no longer carries its
                            # own copy of the escalation rules.
                            local _ladder_tier _decided_r2 _decided_effort_r2
                            _ladder_tier=$(classify_ladder_tier "$story_id")
                            _decided_r2=$(next_ladder_step 2 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier")
                            ladder_step_r2="${_decided_r2%%|*}"
                            [ -n "$ladder_step_r2" ] && [ "$ladder_step_r2" != "${STORY_MODEL:-}" ] && escalated_model_r2="$ladder_step_r2"
                            _decided_effort_r2="${_decided_r2#*|}"; _decided_effort_r2="${_decided_effort_r2%%|*}"
                            [ -n "$_decided_effort_r2" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r2"
                            log "  InferenceLadder[Rung2/R${retry_count}]: tier=${_ladder_tier}"
                        fi
                        if [ -n "$escalated_model_r2" ] && [ "$escalated_model_r2" != "${STORY_MODEL:-}" ]; then
                            log "  InferenceLadder[Rung2/R${retry_count}]: model '${STORY_MODEL:-default}' → '$escalated_model_r2' — effort → medium"
                            STORY_MODEL="$escalated_model_r2"
                            local _resolved_provider_r2
                            _resolved_provider_r2=$(resolve_model_provider "$escalated_model_r2")
                            [ -n "$_resolved_provider_r2" ] && STORY_PROVIDER="$_resolved_provider_r2"
                        else
                            # Stuck at ceiling — check if HealingBroken is confirmed in
                            # healing-events.jsonl. When skipLadder=true pre-assigns the ceiling
                            # model and self-healing hasn't converged, model diversity is the only
                            # remaining lever. Force HIGH-tier escalation so a different model
                            # gets a chance — skipLadder is downgrade-prevention, not a lock
                            # against upward escalation under confirmed healing failure.
                            local _healed_count=0
                            if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                _healed_count=$(python3 "$SCRIPT_DIR/lib/handlers/healing-event-count.py" "${LOG_DIR}/healing-events.jsonl" "$story_id" 2>/dev/null || echo 0)
                            fi
                            local _high_step=""
                            if [ "${_healed_count:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ]; then
                                # Forced HIGH-tier escalation under confirmed healing failure. Routed through
                                    # next_ladder_step so it obeys the same floor and
                                    # cannot-move rules as every other escalation.
                                    _high_step=$(next_ladder_step 2 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "high")
                                    _high_step="${_high_step%%|*}"
                                    [ "$_high_step" = "${STORY_MODEL:-}" ] && _high_step=""
                                if [ -n "$_high_step" ] && [ "$_high_step" != "${STORY_MODEL:-}" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step' for model diversity"
                                    STORY_MODEL="$_high_step"
                                    local _resolved_provider_r2h
                                    _resolved_provider_r2h=$(resolve_model_provider "$_high_step")
                                    [ -n "$_resolved_provider_r2h" ] && STORY_PROVIDER="$_resolved_provider_r2h"
                                fi
                            fi
                            if [ -z "$_high_step" ] || [ "$_high_step" = "${STORY_MODEL:-}" ]; then
                                if [ "$_skip_ladder" = "true" ]; then
                                    log "  InferenceLadder[Rung2/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → medium"
                                else
                                    log "  InferenceLadder[Rung2/R${retry_count}]: no ladder step — keeping model, effort → medium"
                                fi
                            fi
                        fi
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG2_REASONING_EFFORT:-high}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG2_TEMPERATURE:-0.3}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung2"
                        # Rung 2: bump output tokens to 8192 — a story that needed
                        # escalation is likely generating larger outputs than the
                        # baseline budget assumed; truncation at the original ceiling
                        # causes the same syntax error on every retry regardless of
                        # model capability (confirmed live: SKY-003-test-tc2 2026-07-18).
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "${EPAM_OUTPUT_FLOOR_PLANNING}" ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_OUTPUT_FLOOR_PLANNING}"
                        ;;
                    *)
                        # Rung 3+: escalate to the strongest configured model, effort → high (maximum).
                        #
                        # BUG (found live, 2026-07-04): this branch only ever escalated the model
                        # when the story had had ZERO prior escalation (STORY_MODEL == the
                        # original). But every story that reaches Rung 3 already escalated once at
                        # Rung 2 by construction — so that condition was always false here, and
                        # Rung 3 silently kept Rung 2's model, only bumping the reasoning-effort
                        # flag. Confirmed on SKY-004: attempts 5-8 all ran on z-ai/glm-5.2 (the
                        # MEDIUM-tier target); z-ai/glm-5.1 (the HIGH-tier target, configured
                        # specifically for hard stories) was never invoked in the entire 8-attempt
                        # cycle. Fix: if the story already escalated once, step it again — from
                        # whatever model Rung 2 landed on.
                        #
                        # BUG 2 (found live, 2026-07-05): this branch originally passed a hardcoded
                        # literal "high" to get_model_ladder_step, instead of the story's ACTUAL
                        # classified tier — silently pushing a "medium"-complexity story onto the
                        # HIGH ladder anyway, overriding what classify_ladder_tier() (now populated
                        # from real CPA complexity signals: cpaGate/effort, see
                        # contextualize-stories.sh) says this story needs. Fixed: call
                        # classify_ladder_tier() here too, same as Rung 2 — the PRD's classified
                        # tier is the ceiling all the way through the ladder, not just at Rung 2.
                        # skipLadder=true: same as Rung 2 — only prevents downgrade,
                        # upward escalation still applies if a higher step exists.
                        local _ffm="${EPAM_FINAL_FALLBACK_MODEL:-}" _ffp="${EPAM_FINAL_FALLBACK_PROVIDER:-}"
                        if [ -n "$_ffm" ] && [ "${STORY_MODEL:-}" = "${STORY_MODEL_ORIGINAL:-}" ]; then
                            log "  InferenceLadder[Rung3/R${retry_count}]: no prior escalation — routing to fallback '$_ffm'"
                            STORY_MODEL="$_ffm"
                            [ -n "$_ffp" ] && STORY_PROVIDER="$_ffp"
                        else
                            local _ladder_tier_r3
                            _ladder_tier_r3=$(classify_ladder_tier "$story_id")
                            log "  InferenceLadder[Rung3/R${retry_count}]: tier=${_ladder_tier_r3}"
                            local ladder_step_r3
                            # Delegated to next_ladder_step — see next-ladder-step.test.ts.
                            local _decided_r3 _decided_effort_r3
                            _decided_r3=$(next_ladder_step 3 "${STORY_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$_ladder_tier_r3")
                            ladder_step_r3="${_decided_r3%%|*}"
                            [ "$ladder_step_r3" = "${STORY_MODEL:-}" ] && ladder_step_r3=""
                            _decided_effort_r3="${_decided_r3#*|}"; _decided_effort_r3="${_decided_effort_r3%%|*}"
                            [ -n "$_decided_effort_r3" ] && export EPAM_REASONING_EFFORT="$_decided_effort_r3"
                            if [ -n "$ladder_step_r3" ] && [ "$ladder_step_r3" != "${STORY_MODEL:-}" ]; then
                                log "  InferenceLadder[Rung3/R${retry_count}]: model '${STORY_MODEL:-default}' → '$ladder_step_r3' (${_ladder_tier_r3} tier)"
                                STORY_MODEL="$ladder_step_r3"
                                local _resolved_provider_r3
                                _resolved_provider_r3=$(resolve_model_provider "$ladder_step_r3")
                                [ -n "$_resolved_provider_r3" ] && STORY_PROVIDER="$_resolved_provider_r3"
                            else
                                # Same HealingBroken+skipLadder override as Rung 2: when stuck
                                # at ceiling and self-healing is confirmed broken, force HIGH tier.
                                local _healed_count_r3=0
                                if [ -f "${LOG_DIR}/healing-events.jsonl" ]; then
                                    _healed_count_r3=$(python3 "$SCRIPT_DIR/lib/handlers/healing-event-count.py" "${LOG_DIR}/healing-events.jsonl" "$story_id" 2>/dev/null || echo 0)
                                fi
                                local _high_step_r3=""
                                if [ "${_healed_count_r3:-0}" -ge 1 ] && [ "$_skip_ladder" = "true" ] && [ "$_ladder_tier_r3" != "high" ]; then
                                    _high_step_r3=$(get_model_ladder_step "${STORY_MODEL:-}" "high")
                                    if [ -n "$_high_step_r3" ] && [ "$_high_step_r3" != "${STORY_MODEL:-}" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: HealingBroken+skipLadder — forcing HIGH-tier escalation '${STORY_MODEL:-default}' → '$_high_step_r3'"
                                        STORY_MODEL="$_high_step_r3"
                                        local _resolved_provider_r3h
                                        _resolved_provider_r3h=$(resolve_model_provider "$_high_step_r3")
                                        [ -n "$_resolved_provider_r3h" ] && STORY_PROVIDER="$_resolved_provider_r3h"
                                    fi
                                fi
                                if [ -z "$_high_step_r3" ] || [ "$_high_step_r3" = "${STORY_MODEL:-}" ]; then
                                    if [ "$_skip_ladder" = "true" ]; then
                                        log "  InferenceLadder[Rung3/R${retry_count}]: skipLadder=true, already at ceiling '${STORY_MODEL:-default}' — effort → high (maximum)"
                                    fi
                                fi
                            fi
                        fi
                        EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "${EPAM_RUNG3_REASONING_EFFORT:-high}")"
                        export EPAM_REASONING_EFFORT
                        export EPAM_TEMPERATURE="${EPAM_RUNG3_TEMPERATURE:-0.7}"
                        _rung_iter_bump=$(( $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))
                        STORY_ITERATION_BUMP_TOTAL=$(( ${STORY_ITERATION_BUMP_TOTAL:-0} + _rung_iter_bump ))
                        export STORY_ITERATION_BUMP_TOTAL
                        STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + _rung_iter_bump ))
                        _cap_brownfield_iterations_ceiling "Rung3"
                        # Rung 3: bump output tokens to 12288 — at the strongest
                        # configured model, full file rewrites are expected; any
                        # prior token ceiling that caused truncation must be lifted.
                        [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt "${EPAM_OUTPUT_FLOOR_REVIEW}" ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_OUTPUT_FLOOR_REVIEW}"
                        log "  InferenceLadder[Rung3/R${retry_count}]: model='${STORY_MODEL:-default}' — effort → high"
                        ;;
                esac
                # Repeat-rejection temperature bump: the SAME model producing the
                # SAME rejection twice (_rejection_repeat_check above) is direct
                # evidence this exact input/temperature combination is stuck, not
                # just "this is a new rung now" — applied on top of whatever the
                # rung case above already set, additive and capped so it can't run
                # away across many repeats of the same story. EPAM_REASONING_EFFORT
                # is untouched: this targets sampling variance specifically, not effort.
                if [ "$_repeat_rejection_detected" = true ]; then
                    local _repeat_temp_bump="${EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP:-0.2}"
                    local _repeat_temp_max="${EPAM_REPEAT_REJECTION_TEMPERATURE_MAX:-1.0}"
                    local _bumped_temp
                    _bumped_temp=$(awk -v t="${EPAM_TEMPERATURE:-0}" -v b="$_repeat_temp_bump" -v m="$_repeat_temp_max" \
                        'BEGIN { r = t + b; if (r > m) r = m; printf "%.2f", r }')
                    log "  RepeatRejectionTempBump: ${EPAM_TEMPERATURE:-0} -> ${_bumped_temp} (identical rejection twice, model/temperature combination is stuck)"
                    export EPAM_TEMPERATURE="$_bumped_temp"
                fi
                # Rung/model contribution attribution (backlog #113): BEFORE
                # the reset decision below changes anything on disk,
                # attribute whatever changed since the LAST snapshot to the
                # rung/model that was JUST active — skipped on the story's
                # very first rung entry (retry_count 0), since there's no
                # PRIOR rung yet to attribute anything to.
                if [ "$retry_count" -gt 0 ]; then
                    _rung_attribute_changes "$story_id" "$_last_attributed_rung" "$_prev_model"
                fi

                # Selective worktree reset — only on a REAL rung transition
                # after at least one real attempt (retry_count 0 is the
                # story's very first attempt; there's nothing on disk yet to
                # reset FROM, and no valid LAST_VERIFIED_TOUCHED_FILES for
                # THIS story until verify_story_deliverables has run at least
                # once). See _selective_worktree_reset's own docstring.
                if [ "$retry_count" -gt 0 ]; then
                    _selective_worktree_reset "$story_id"
                fi

                # Snapshot the state THIS rung is starting from (post-reset-
                # decision) — the reference the NEXT transition's attribution
                # call compares against to see what THIS rung contributed.
                _rung_snapshot_hashes "$story_id"
                _last_attributed_rung="$_rung"
                # Emit ladder_rung event so agent-activity dashboard shows every escalation,
                # including prev→new model transition for observability.
                local _ladder_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_ladder_event_script" ]; then
                    local _ladder_role
                    _ladder_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_ladder_event_script" event "ladder_rung" \
                        "InferenceLadder Rung${_rung}/R${retry_count}: ${_prev_model:-default}→${STORY_MODEL:-default} effort=${EPAM_REASONING_EFFORT:-low}" \
                        "$story_id" "main" "${_ladder_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" "${_prev_model:-}" 2>/dev/null || true
                fi
            else
                log "  InferenceLadder[Rung${_rung}/R${retry_count}]: same rung — no escalation, self-heal guidance active"
                local _retry_event_script="$SCRIPT_DIR/update-monitor.sh"
                if [ -x "$_retry_event_script" ]; then
                    local _retry_role
                    _retry_role=$(jq -r --arg id "$story_id" '.stories[] | select(.id==$id) | .agentRole // ""' "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                    "$_retry_event_script" event "retry" \
                        "Retry R${retry_count} Rung${_rung}: model=${STORY_MODEL:-default} (self-heal active)" \
                        "$story_id" "main" "${_retry_role:-}" "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" 2>/dev/null || true
                fi
            fi
        fi

        # ── PERSIST THE RUNG THE WRITER IS ABOUT TO RUN ──────────────────────
        # Here, and not on a success path, because this is the point the rung is SETTLED:
        # the escalation block above has just finished moving model/provider/effort/temperature
        # for this attempt, and the invocation is below. Every attempt overwrites, so the record
        # always describes the setup that produced the newest output — which is the one the
        # reviewer is about to judge.
        #
        # The writer is a child process per story; the reviewer is a separate process. This file
        # is how the rung crosses, and it is the ONLY thing the reviewer consults.
        story_rung_record "$LOG_DIR" "$story_id"

        # Rebuild prompt each attempt: retry_count and KB ID must reflect current state
        local next_kb_id
        next_kb_id=$(get_next_kb_id)
        local prompt
        if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
            _impl_section="$(build_generator_prompt "$story_id")" || {
                error "  [prompt] build_generator_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # Same shape, same reason as the implementation branch below: a joined assignment takes
            # its status from the LAST substitution, so a refusal in the first is lost. This branch
            # has no refusal today, which is exactly when the hazard is cheap to remove.
            prompt="$_impl_section
$_kb_section"
        else
            _impl_section="$(build_implementation_prompt "$story_id")" || {
                error "  [prompt] build_implementation_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # SEPARATE ASSIGNMENTS, DELIBERATELY. Joined as
            #   prompt="$(build_implementation_prompt ...)\n$(build_kb_prompt_section ...)"
            # the assignment takes its status from the LAST substitution, so every `return 1` in
            # the builder was swallowed and `set -e` never fired. The writer was then invoked with
            # the empty first line plus the KB section — no story, no criteria, no plan — and
            # produced something confident that got committed. A blank that looks ordinary is the
            # worst failure this pipeline can have.
            prompt="$_impl_section
$_kb_section"
        fi
        # Inject execution plan when planner/executor split is active
        if [ -n "${story_plan:-}" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
            jq_vals \
                  --arg story_plan "$story_plan" \
                  --arg prompt "$prompt" \
                  '{"__STORY_PLAN__":$story_plan,"__PROMPT__":$prompt}' > "$_cp_vals"
            _render_out="$(render_or_keep writer-plan-section "$_cp_vals" execution_plan)" && prompt="$_render_out"
            rm -f "$_cp_vals"
        fi

        # Inject coordinator prompt amendment when available (retry attempts only).
        # Uses _total_attempts, not retry_count — a free retry (deterministic-check
        # failure) doesn't advance retry_count, but it IS a real subsequent attempt
        # and must still see the guidance from what just failed.
        # WHAT THE LAST ATTEMPT DID — facts, before anyone's opinion about them.
        #
        # The writer was told what was WRONG and never what it DID, so it could not tell "I tried
        # this and it was rejected" from "I have not tried anything" and re-derived approaches it
        # had already been told were wrong. Placed BEFORE the coordinator's one-line inference so
        # the evidence is read first and the judgement second.
        # PUBLISHED, NOT APPENDED — and not gated on an attempt counter.
        #
        # This used to be `if [ "$_total_attempts" -gt 1 ]`, a variable local to this function.
        # The review cycle re-invokes the writer as a NEW PROCESS, where that counter starts at
        # zero, so the writer being asked to fix its own work was never told what its own work
        # was. Recorded as TF-1 in TESTING-FAILURES.md.
        #
        # What is on disk does not depend on which process asks. The engine publishes it; every
        # agent that DECLARES attempt-evidence receives it — the writer and both failure analysts
        # today, the reviewer the moment it declares it. Empty publishes nothing, so a first
        # attempt carries no section.
        # WAS THERE A PREVIOUS ATTEMPT? Asked of DURABLE state, not a process-local counter.
        # read_story_retry_count persists in story-retry-state/ and is cleared by the pre-run
        # reset, so it answers the same question across a re-invocation — which is precisely
        # where _total_attempts failed.
        #
        # It matters because _attempt_change_summary never returns empty: when nothing changed it
        # says so in words, and that sentence is the important one (a previous attempt that wrote
        # NOTHING must be reported, not silently omitted). Published unconditionally it would tell
        # a FIRST attempt that a previous attempt changed no files, which is a lie the writer has
        # no way to check.
        local _prior_attempts
        _prior_attempts=$(read_story_retry_count "$LOG_DIR" "$story_id" 2>/dev/null || echo 0)
        if [ "${_prior_attempts:-0}" -gt 0 ] || [ "$_total_attempts" -gt 1 ]; then
            publish_agent_output engine attempt-evidence "$story_id" "$(_attempt_change_summary "$story_id")"
        fi

        if [ "$_total_attempts" -gt 1 ] && [ -n "${COORDINATOR_PROMPT_AMENDMENT:-}" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
            jq_vals \
                  --arg coordinator_prompt_amendment "${COORDINATOR_PROMPT_AMENDMENT}" \
                  --arg retry_count "${retry_count}" \
                  --arg prompt "$prompt" \
                  '{"__COORDINATOR_PROMPT_AMENDMENT__":$coordinator_prompt_amendment,"__RETRY_COUNT__":$retry_count,"__PROMPT__":$prompt}' > "$_cp_vals"
            _render_out="$(render_or_keep writer-plan-section "$_cp_vals" coordinator_guidance_full)" && prompt="$_render_out"
            rm -f "$_cp_vals"
        fi

        # Prompt-size scratchpad summarization (found live, 2026-07-07): each retry
        # PREPENDS a new "## Self-Heal: Failure Analyst Summary"/coordinator-guidance
        # block onto COORDINATOR_PROMPT_AMENDMENT without ever dropping older ones —
        # by attempt 4-5 within a single claude.sh invocation the cumulative prompt
        # is measurably larger than attempt 1's, and a model reasoning over a bigger
        # prompt can legitimately take long enough to blow the watchdog's timeout
        # budget for that story. Root cause was misread at first as model/API
        # instability (see the hot-swap mechanism above) — a live process
        # inspection confirmed a genuine, still-connected, in-flight API call, not a
        # stuck/crashed one; the real issue is unbounded prompt growth.
        # Fix: once the prompt exceeds a configurable size, persist the FULL prompt
        # (with complete retry history) to a scratchpad file for audit/debugging,
        # then trim the in-prompt coordinator guidance down to only the MOST
        # RECENT "## "-headed section — the model still gets the latest, most
        # relevant guidance; it just isn't re-reading every prior attempt's guidance
        # every single retry. Opt-out: EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS=0
        # disables trimming entirely.
        # Both trim budgets come from orchestrations/config/spec-mode-defaults.json — see
        # lib/prompt-budget.sh. They were literals here; live 2026-08-09 a writer's prompt hit
        # 53366 chars against the threshold and ran with most of its coordinator guidance
        # discarded, which is exactly the value an operator needs to reach without editing code.
        local _scratchpad_threshold _keep_sections
        _scratchpad_threshold="$(prompt_trim_threshold)" || return 1
        _keep_sections="$(prompt_trim_keep_sections)" || return 1
        if [ "$_scratchpad_threshold" -gt 0 ] && [ "${#prompt}" -gt "$_scratchpad_threshold" ]; then
            local _scratchpad_dir="${LOG_DIR}/kb-scratchpad"
            mkdir -p "$_scratchpad_dir" 2>/dev/null || true
            local _scratchpad_file="${_scratchpad_dir}/${story_id}-attempt-$((retry_count + 1)).md"
            printf '%s' "$prompt" > "$_scratchpad_file" 2>/dev/null || true

            local _trimmed_amendment
            # Keep the last 3 headings, not just 1 (fixed 2026-07-11, after a live
            # run repeated an identical mistake 5 retries after already being told
            # not to): retry-0's diagnosed fix ("don't reuse validation logic
            # across flags") became invisible to retry 5's prompt the moment a
            # NEWER heading (e.g. a missing-export fix) pushed the trim window past
            # it -- the guidance was still archived in COORDINATOR_PROMPT_AMENDMENT
            # and the scratchpad file, but never shown to the model again, so it
            # repeated the exact mistake it had already been corrected on. Keeping
            # the last 3 distinct headings instead of 1 still bounds prompt growth
            # (the original purpose of this trim) while giving recent-but-not-
            # newest guidance a real chance to stay visible for a few more retries.
            _trimmed_amendment=$(printf '%s' "$COORDINATOR_PROMPT_AMENDMENT" | EPAM_PROMPT_TRIM_KEEP="$_keep_sections" python3 "$SCRIPT_DIR/lib/handlers/trim-coordinator-amendment.py" 2>/dev/null || echo "$COORDINATOR_PROMPT_AMENDMENT")

            if [ -n "$_trimmed_amendment" ] && [ "${#_trimmed_amendment}" -lt "${#COORDINATOR_PROMPT_AMENDMENT}" ]; then
                warning "  [PromptScratchpad] Prompt exceeded ${_scratchpad_threshold} chars ($(( ${#prompt} )) actual) — full history written to $_scratchpad_file, trimming to most recent guidance (up to 3)"
                if [ "${STORY_GENERATOR_MODE:-}" = "true" ]; then
                    _impl_section="$(build_generator_prompt "$story_id")" || {
                error "  [prompt] build_generator_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # Same shape, same reason as the implementation branch below: a joined assignment takes
            # its status from the LAST substitution, so a refusal in the first is lost. This branch
            # has no refusal today, which is exactly when the hazard is cheap to remove.
            prompt="$_impl_section
$_kb_section"
                else
                    _impl_section="$(build_implementation_prompt "$story_id")" || {
                error "  [prompt] build_implementation_prompt REFUSED for $story_id — not invoking the writer"
                return 1
            }
            _kb_section="$(build_kb_prompt_section "$story_id" "$retry_count" "$next_kb_id")" || {
                error "  [prompt] build_kb_prompt_section REFUSED for $story_id — not invoking the writer"
                return 1
            }
            # SEPARATE ASSIGNMENTS, DELIBERATELY. Joined as
            #   prompt="$(build_implementation_prompt ...)\n$(build_kb_prompt_section ...)"
            # the assignment takes its status from the LAST substitution, so every `return 1` in
            # the builder was swallowed and `set -e` never fired. The writer was then invoked with
            # the empty first line plus the KB section — no story, no criteria, no plan — and
            # produced something confident that got committed. A blank that looks ordinary is the
            # worst failure this pipeline can have.
            prompt="$_impl_section
$_kb_section"
                fi
                if [ -n "${story_plan:-}" ]; then
                    _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
                    jq_vals \
                          --arg story_plan "$story_plan" \
                          --arg prompt "$prompt" \
                          '{"__STORY_PLAN__":$story_plan,"__PROMPT__":$prompt}' > "$_cp_vals"
                    _render_out="$(render_or_keep writer-plan-section "$_cp_vals" execution_plan)" && prompt="$_render_out"
                    rm -f "$_cp_vals"
                fi
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/writer-plan-section-vals-XXXXXX.json")
                jq_vals \
                      --arg trimmed_amendment "${_trimmed_amendment}" \
                      --arg scratchpad_file "${_scratchpad_file}" \
                      --arg retry_count "${retry_count}" \
                      --arg prompt "$prompt" \
                      '{"__TRIMMED_AMENDMENT__":$trimmed_amendment,"__SCRATCHPAD_FILE__":$scratchpad_file,"__RETRY_COUNT__":$retry_count,"__PROMPT__":$prompt}' > "$_cp_vals"
                _render_out="$(render_or_keep writer-plan-section "$_cp_vals" coordinator_guidance_trimmed)" && prompt="$_render_out"
                rm -f "$_cp_vals"
            fi
        fi

        # Log the prompt
        echo "=== Prompt for $story_id (attempt $((retry_count + 1))) ===" >> "$output_file"
        echo "$prompt" >> "$output_file"
        echo "=== End Prompt ===" >> "$output_file"
        echo "" >> "$output_file"

        log "Invoking $story_cli (attempt $((retry_count + 1))/$((MAX_RETRIES + 1)))..."

        # Proactive dependency install, BEFORE the vendor lock is applied for
        # this attempt (found live, 2026-07-13, SKY-004-test): a source/test
        # file written by an EARLIER attempt can already import a package
        # missing from package.json. Without this, the agent discovers the
        # gap itself mid-turn and — despite the skill addendum warning it not
        # to — tries to `chmod` node_modules writable and `npm install` the
        # package directly, which touches many UNRELATED transitive
        # dependency files (npm's own hoisting/dedup side effects) and trips
        # run_vendor_integrity_check's tamper detector post-turn. That check
        # then hard-fails BEFORE the existing post-turn run_dependency_check
        # call (further below in run_external_verification) ever runs — so
        # the one mechanism that would have installed the dependency safely
        # never got the chance. Running it here, before the lock, means the
        # dependency is already satisfied by the time the agent's turn
        # starts, so there's nothing left for the agent to (mis)fix itself.
        run_dependency_check "$PROJECT_ROOT"
        run_lockfile_sync_check "$PROJECT_ROOT"

        # Vendor-dir guard: lock configured vendored-dependency directories
        # (e.g. node_modules) read-only — no story ever legitimately writes
        # inside an already-installed third-party package. No-op if
        # .epam/dependency-check.json has no vendorDirs configured.
        # EPAM_VENDOR_GUARD_ENABLED defaults to 0 (off): on a local machine the
        # risk of fake-test injection is low and the lock blocks legitimate
        # dependency installs (e.g. cors) causing unnecessary story failures.
        # Set EPAM_VENDOR_GUARD_ENABLED=1 in CI/multi-tenant environments.
        if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
            _vendor_lock "$PROJECT_ROOT"
        fi

        # Change to project root for the CLI to have correct context
        cd "$PROJECT_ROOT"

        # The provider must match the model this attempt will actually use — the ladder may have
        # escalated the model since the provider was resolved for this story.
        sync_provider_to_model
        # BOTH, EVERY ATTEMPT. The model was logged per attempt and the provider once per story,
        # so three very different failures — right pair, wrong pair, missing key — left identical
        # records. The run that cost this diagnosis could not say which provider it had used.
        log "  Attempt[$((retry_count + 1))] provider=${STORY_PROVIDER:-unset} model=${STORY_MODEL:-default}"
        echo "=== $story_cli Output (attempt $((retry_count + 1))) ===" >> "$output_file"

        local json_result_file="${output_file%.log}_result.json"
        local invoke_success=false
        # Track the raw output file across all provider branches for coordinator triage
        local attempt_raw_file="${json_result_file%.json}_raw.json"
        local attempt_started_at
        attempt_started_at=$(date -Iseconds)

        # Optional per-story wall-clock timeout — set EPAM_STORY_TIMEOUT_SECS in the tier script.
        # No default: if unset, no timeout is applied (behaviour is unchanged).
        local _timeout_prefix=()
        [ -n "${EPAM_STORY_TIMEOUT_SECS:-}" ] && _timeout_prefix=(timeout "$EPAM_STORY_TIMEOUT_SECS")

        STORY_PROVIDER="$(resolve_primary_provider "${STORY_PROVIDER:-}")"
        case "$STORY_PROVIDER" in
            opencode)
                # OpenCode: pass prompt via temp file (prompts can exceed arg limits)
                # --format json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local prompt_file="${json_result_file%.json}_prompt.txt"
                echo "$prompt" > "$prompt_file"
                if "${_timeout_prefix[@]}" opencode run --format json "$(cat "$prompt_file")" \
                        > "$raw_file" 2>/dev/null; then
                    normalize_provider_json "opencode" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"text"' "$raw_file" 2>/dev/null \
                        | jq -r '.part.text // .text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                rm -f "$prompt_file"
                ;;
            codex)
                # Codex: reads prompt from stdin when '-' is passed
                # --json emits JSONL stream; we normalize it after
                local raw_file="${json_result_file%.json}_raw.jsonl"
                local codex_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && codex_model_flag=(--model "$STORY_MODEL")
                if echo "$prompt" | "${_timeout_prefix[@]}" codex exec \
                        --ephemeral \
                        --skip-git-repo-check \
                        --dangerously-bypass-approvals-and-sandbox \
                        "${codex_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>>"$output_file"; then
                    normalize_provider_json "codex" "$raw_file" "$json_result_file"
                    # Append text output to log
                    grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
                        | jq -r '.item.text // empty' 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            codemie-claude)
                # codemie-claude: same invocation pattern as claude — --print --output-format json
                if echo "$prompt" | "${_timeout_prefix[@]}" codemie-claude --print --output-format json \
                        "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                        2>>"$output_file" > "$json_result_file"; then
                    invoke_success=true
                fi
                ;;
            copilot|openai|openrouter|cursor|minimax)
                # epam-run providers: invoke via `epam run --provider X --model M --json`
                # EPAM_CLI can be overridden with a mock for zero-token testing.
                # Explicitly forward API keys so subshells that didn't inherit them still work.
                local raw_file="${json_result_file%.json}_raw.json"
                local epam_model_flag=()
                [ -n "${STORY_MODEL:-}" ] && epam_model_flag=(--model "$STORY_MODEL")
                # When EPAM_SANDBOX is active (EPAM_SANDBOX_IMAGE is set by
                # run-agent-orchestration.sh's sandbox bootstrap), route
                # through $CLAUDE_CMD (the sandbox wrapper) instead of
                # calling $EPAM_CLI directly — this is what makes vendor-dir
                # tampering structurally impossible for THIS provider branch
                # too (previously only the claude/epam default branches
                # respected --sandbox at all). EPAM_SANDBOX_TARGET_CMD tells
                # sandbox-invoke.sh to run epam-cli's own bind-mounted CLI
                # (see that script's docstring) instead of its `claude`
                # default; left empty (harmless) when not sandboxed.
                local _epam_run_binary="$EPAM_CLI"
                local _epam_sandbox_target=""
                if [ -n "${EPAM_SANDBOX_IMAGE:-}" ]; then
                    _epam_run_binary="$CLAUDE_CMD"
                    _epam_sandbox_target="node /opt/epam-cli/dist/epam.js"
                fi
                # Agent identity for WriteFile.ts's settings-guard (llm-settings.json may
                # only be written by EPAM_LLM_SETTINGS_GUARDIAN_ROLE) and for the audit
                # log/traces to attribute a change to the story that made it.
                local _story_agent_role
                _story_agent_role=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .agentRole // ""' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")

                # Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story's declared files.
                # WriteFile.ts uses this to block TS writes outside the story's scope.
                local _allowed_write_paths
                _allowed_write_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                # Files OTHER stories declare. The scope guard refuses a write that would take
                # one of these, and permits (and records) a file no story owns — because the
                # guard exists to stop stories overwriting each other, not to stop work. See the
                # unowned-file branch in WriteFile.ts for the incident.
                #
                # OWNERSHIP IS TRI-STATE. An empty list is a real answer — a single-story PRD is
                # the normal case here — and it is not the same as "nobody computed this". The
                # marker below says the lookup RAN; without it the guard keeps refusing, so a
                # caller that never computes ownership cannot switch the guard off by omission.
                # Reading empty as unknown would have left this inert on exactly the PRD it was
                # written for, which carries one story.
                local _other_story_paths _story_ownership_known=0
                _other_story_paths=$(jq -r --arg id "$story_id" \
                    '[.stories[] | select(.id != $id) | .technicalNotes.files[]? // empty] | unique | .[]' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null \
                    | while IFS= read -r _osp; do [ -n "$_osp" ] && printf '%s:' "${PROJECT_ROOT}/${_osp}"; done)
                _other_story_paths="${_other_story_paths%:}"
                # jq exits non-zero only when the PRD is unreadable; a readable PRD with one story
                # legitimately yields nothing. Gate the marker on the PRD being readable at all.
                if jq -e '.stories' "${MAIN_PRD_FILE:-$PRD_FILE}" >/dev/null 2>&1; then
                    _story_ownership_known=1
                fi

                # Rewrite allowed paths to worktree when in worktree mode.
                # Without this, WriteFile.ts blocks writes to the worktree path and reports
                # "Permitted paths: /main-repo/src/foo.ts" — the model reads that error and
                # writes to the main repo instead of the worktree.
                if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
                    _allowed_write_paths="${_allowed_write_paths//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
                fi
                # Also permit the detective's CAUSAL fix-site file(s). The spec-pass
                # detective traces the real fix location, which often differs from the
                # ticket's declared technicalNotes.files; the locationHint→technicalNotes.files
                # propagation is non-deterministic (run14, 2026-07-22), so the scope-guard
                # could otherwise BLOCK the agent from writing the very file it was told to
                # fix. These are repo-relative and resolve against the agent's cwd
                # (=PROJECT_ROOT/worktree) exactly as WriteFile.ts's path.resolve() expects,
                # so no worktree rewrite is needed.
                local _fixsite_paths
                _fixsite_paths=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .fixSiteAnalysis[]?.file // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | tr '\n' ':' | sed 's/:$//')
                if [ -n "$_fixsite_paths" ]; then
                    _allowed_write_paths="${_allowed_write_paths:+${_allowed_write_paths}:}${_fixsite_paths}"
                fi
                # Reuse guard (IMPL-PROSE): the prescribed helper and the file it
                # belongs in, taken from the SAME verified fixSiteAnalysis entry the
                # post-hoc verifier reads. Handing the tool the symbol makes reuse
                # structural at the write instead of advice in the prompt, which the
                # model demonstrably ignored three attempts running (AMSD-2041,
                # 2026-07-30). Empty when nothing is prescribed — the guard is inert.
                local _req_symbols _req_scope
                _req_symbols=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
                     | map(select((.fixVerified == true) and ((.helper // "") != "")))
                     | map(.helper) | unique | join(":")' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
                _req_scope=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.fixSiteAnalysis // [])
                     | map(select((.fixVerified == true) and ((.helper // "") != "")))
                     | map(.file // empty) | unique | .[]' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null | \
                    while IFS= read -r _f; do
                        [ -n "$_f" ] || continue
                        case "$_f" in /*) printf '%s:' "$_f" ;; *) printf '%s:' "$PROJECT_ROOT/$_f" ;; esac
                    done)
                _req_scope="${_req_scope%:}"
                if [ -n "$_req_symbols" ] && [ -n "$_req_scope" ]; then
                    log "  ReuseGuard: '${_req_symbols}' enforced at write time on ${_req_scope}"
                fi
                # Model-specific overrides: reasoning effort, temperature,
                # iteration cap, custom compaction — read directly from
                # llm-settings.json's modelOverrides (schema:
                # orchestrations/config/llm-settings.schema.json), keyed by an
                # arbitrary label but MATCHED against the FINAL resolved
                # $STORY_PROVIDER/$STORY_MODEL for THIS attempt (novel-brownfield
                # routing and ladder escalation both reassign these earlier —
                # checked here, not earlier, so a story that escalated AWAY
                # from a match correctly does NOT get these). Entries are
                # checked in declaration order; the FIRST match wins, so e.g.
                # MiniMax-M2.5 and MiniMax-M3 can carry different budgets
                # despite sharing one provider. Unconditionally overrides the
                # rung's own effort/temperature default, by design — that's
                # the whole point of a model-specific override.
                local _effective_max_iterations="${STORY_MAX_ITERATIONS:-6}"
                local _effective_compress_at="${EPAM_AUTO_COMPRESS_AT:-}"
                local _effective_compress_every_n="${EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS:-}"
                # THE OVERRIDES LIVE WITH THE MODELS — in the active STACK, not the project.
                #
                # This read only the project's llm-settings.json. The 2026-08-25 migration moved
                # modelOverrides out of project files into config/llm-defaults.<set>.json, because
                # a per-model setting belongs to the model and a model belongs to a stack. The
                # reader was left behind, so effort, temperature and compaction overrides reached
                # NOTHING on any run — the same defect seam-invocation.js had for iteration
                # budgets, in a second reader.
                #
                # The project file is still preferred when it declares overrides: a project may
                # legitimately override for its own reasons, and that is the layer where such a
                # decision belongs.
                  # BOTH LAYERS, IN ORDER -- the project first, then the active stack. Asking which
                  # FILE to read skipped the stack whenever the project declared any override at
                  # all; resolve_model_override asks which file declares THIS MODEL.
                  local _proj_override_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/llm-settings.json}"
                  local _stack_override_file
                  _stack_override_file="$("${NODE_BIN:-node}" -e '
                      try {
                        const { activeSetFile } = require(process.argv[1] + "/lib/llm-settings-resolve.js");
                        process.stdout.write(activeSetFile() || "");
                      } catch (_) { process.stdout.write(""); }
                  ' "$SCRIPT_DIR" 2>/dev/null || printf '')"
                  local _override_json
                  _override_json=$(resolve_model_override "${STORY_MODEL:-}" "${STORY_PROVIDER:-}" \
                      "$_proj_override_file" "$_stack_override_file")
                  if [ -n "$_override_json" ] && [ "$_override_json" != "null" ]; then
                        local _ov_effort _ov_temp _ov_iter _ov_compress_at _ov_compress_n _ov_top_p _ov_temp_locked _ov_provider_order
                        _ov_effort=$(jq -r '.reasoningEffort // empty' <<<"$_override_json")
                        _ov_top_p=$(jq -r '.topP // empty' <<<"$_override_json")
                        _ov_provider_order=$(jq -r '[.providerOrder[]?] | join(",")' <<<"$_override_json")
                        _ov_temp_locked=$(jq -r '.temperatureLocked // false' <<<"$_override_json")
                        _ov_temp=$(jq -r '.temperature // empty' <<<"$_override_json")
                        _ov_iter=$(jq -r '.maxIterations // empty' <<<"$_override_json")
                        _ov_compress_at=$(jq -r '.autoCompressAt // empty' <<<"$_override_json")
                        _ov_compress_n=$(jq -r '.autoCompressEveryNIterations // empty' <<<"$_override_json")
                        # FLOOR, not overwrite — see max_effort(). The rung's escalation must survive.
                        [ -n "$_ov_effort" ] && EPAM_REASONING_EFFORT="$(max_effort "${EPAM_REASONING_EFFORT:-}" "$_ov_effort")"

                        # OPERATOR RULE (2026-08-10): a retry must ALWAYS raise reasoning effort
                        # when the model is NOT escalating. A rung spans two attempts, so the
                        # second attempt of a rung previously re-ran the identical model at the
                        # identical effort — the same input, expecting a different answer. Effort
                        # is the only lever left when the model cannot move (mid-rung, or at the
                        # top of the chain where get_model_ladder_step returns nothing).
                        if [ "${_total_attempts:-1}" -gt 1 ] \
                           && [ "${STORY_MODEL:-}" = "${LAST_ATTEMPT_MODEL:-}" ]; then
                            _escalated_effort=$(next_effort "${EPAM_REASONING_EFFORT:-}")
                            if [ "$_escalated_effort" != "${EPAM_REASONING_EFFORT:-}" ]; then
                                log "  [EffortEscalation] model unchanged (${STORY_MODEL:-}) — effort ${EPAM_REASONING_EFFORT:-} → ${_escalated_effort}"
                                export EPAM_REASONING_EFFORT="$_escalated_effort"
                            else
                                log "  [EffortEscalation] model unchanged (${STORY_MODEL:-}) — effort already at ceiling (high)"
                            fi
                        fi
                        # HARD INVARIANT (operator rule, 2026-08-10): two back-to-back
                        # invocations must never run with an IDENTICAL settings tuple. Bumping
                        # effort covers most cases, but at the 'high' ceiling with the model at
                        # the top of its chain there is nothing left to move — and the attempt
                        # becomes a byte-for-byte repeat of the one that just failed. That is
                        # pure waste: same model, same effort, same temperature, same prompt.
                        # Temperature is the remaining lever (sampling variance), so it moves.
                        _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                        if [ "${_total_attempts:-1}" -gt 1 ] \
                           && [ "$_settings_fingerprint" = "${LAST_ATTEMPT_SETTINGS:-}" ]; then
                            # Effort first: it is the one lever every model in the ladder honours.
                            # Temperature is model-specific and Kimi K3 fixes it at 1.0 on Moonshot's
                            # platform, so a temperature bump there changes nothing and the identical
                            # attempt runs anyway — the precise violation this invariant exists to stop.
                            _inv_effort=$(next_effort "${EPAM_REASONING_EFFORT:-}")
                            if [ "$_inv_effort" != "${EPAM_REASONING_EFFORT:-}" ]; then
                                warning "  [SettingsInvariant] identical settings (${_settings_fingerprint}) — effort ${EPAM_REASONING_EFFORT:-} → ${_inv_effort}"
                                export EPAM_REASONING_EFFORT="$_inv_effort"
                                _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                                LAST_ATTEMPT_SETTINGS="$_settings_fingerprint"
                                export LAST_ATTEMPT_SETTINGS
                                LAST_ATTEMPT_MODEL="${STORY_MODEL:-}"
                                export LAST_ATTEMPT_MODEL
                                continue
                            fi
                            if [ "${_ov_temp_locked:-false}" = "true" ]; then
                                error "  [SettingsInvariant] ${STORY_MODEL:-} fixes its temperature and effort is at ceiling (${EPAM_REASONING_EFFORT:-}) — no lever remains; abandoning rather than repeating the attempt"
                                break
                            fi
                            _inv_temp=$(awk -v t="${EPAM_TEMPERATURE:-0}" \
                                -v b="${EPAM_REPEAT_REJECTION_TEMPERATURE_BUMP:-0.2}" \
                                -v m="${EPAM_REPEAT_REJECTION_TEMPERATURE_MAX:-1.0}" \
                                'BEGIN { r = t + b; if (r > m) r = m; printf "%.2f", r }')
                            if [ "$_inv_temp" != "${EPAM_TEMPERATURE:-0}" ]; then
                                warning "  [SettingsInvariant] identical settings to the previous attempt (${_settings_fingerprint}) — temperature ${EPAM_TEMPERATURE:-0} → ${_inv_temp}"
                                export EPAM_TEMPERATURE="$_inv_temp"
                                _settings_fingerprint="${STORY_MODEL:-}|${EPAM_REASONING_EFFORT:-}|${EPAM_TEMPERATURE:-0}"
                            else
                                error "  [SettingsInvariant] every lever is exhausted (${_settings_fingerprint}) — repeating this attempt cannot differ from the last; abandoning the story rather than burning the budget"
                                break
                            fi
                        fi
                        LAST_ATTEMPT_SETTINGS="$_settings_fingerprint"
                        export LAST_ATTEMPT_SETTINGS
                        LAST_ATTEMPT_MODEL="${STORY_MODEL:-}"
                        export LAST_ATTEMPT_MODEL
                        [ -n "$_ov_temp" ] && export EPAM_TEMPERATURE="$_ov_temp"
                        [ -n "$_ov_top_p" ] && export EPAM_TOP_P="$_ov_top_p"
                        [ -n "$_ov_provider_order" ] && export EPAM_PROVIDER_ORDER="$_ov_provider_order"
                        # A model override is the model's own HEADROOM, not the final answer.
                        # Applied as a replacement it discarded every rung's iterationBump, so
                        # the iteration budget did not escalate across rungs at all — the same
                        # overwrite-instead-of-combine bug found in reasoning effort and
                        # temperature on 2026-08-10. The rung escalation is added on top, and
                        # the larger of the two bases wins so neither lever is silently lost.
                        if [ -n "$_ov_iter" ]; then
                            _effective_max_iterations=$(awk \
                                -v a="${_effective_max_iterations:-0}" \
                                -v b="$_ov_iter" -v bump="${STORY_ITERATION_BUMP_TOTAL:-0}" \
                                'BEGIN { base = (b + bump > a ? b + bump : a); printf "%d", base }')
                        fi
                        [ -n "$_ov_compress_at" ] && _effective_compress_at="$_ov_compress_at"
                        [ -n "$_ov_compress_n" ] && _effective_compress_every_n="$_ov_compress_n"
                        log "  ModelOverride[${STORY_MODEL:-$STORY_PROVIDER}]: effort=${_ov_effort:-unchanged} temp=${_ov_temp:-unchanged} maxIter=${_effective_max_iterations} compaction=$([ -n "$_effective_compress_every_n" ] && echo "every ${_effective_compress_every_n} iter" || echo "token-threshold") (tokenThreshold=${_effective_compress_at:-none})"
                    fi
                # TELL THE WATCHDOG WHAT WE ACTUALLY GRANTED.
                #
                # The parent sizes the story's wall from iterations x secondsPerIteration, but
                # this number is decided HERE — per model, per attempt, minutes after the parent
                # already fixed that wall — so its derivation branch never ran and the wall
                # silently stayed at the floor. Persisting it is the only way the value travels
                # upward. See lib/story-retry-state.sh for the measured cost.
                write_story_effective_iterations "$LOG_DIR" "$story_id" "$_effective_max_iterations"
                # Every line here forwards a value to the child process, and each expansion deliberately reads
                # the OUTER value — which IS the value being forwarded. shellcheck is right about the shape and
                # wrong about the intent; rewriting it risks silently dropping a credential the child needs.
                # shellcheck disable=SC2097,SC2098
                if echo "$prompt" | \
                        EPAM_DANGEROUS_SKIP_APPROVAL=1 \
                        EPAM_AGENT_ROLE="${_story_agent_role}" \
                        EPAM_STORY_ID="${story_id}" \
                        EPAM_ACTIVITY_LOG_DIR="${LOG_DIR}" \
                        EPAM_USAGE_PROGRESS_FILE="${LOG_DIR}/usage-progress-${story_id}.json" \
                        EPAM_USAGE_TRACE_FILE="${LOG_DIR}/usage-trace-${story_id}.jsonl" \
                        EPAM_SESSION_ID="${ORCH_RUN_ID:-run}-${story_id}-${retry_count:-0}" \
                        EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-$_tool_policy_read_dedupe}" \
                        EPAM_BASH_EXPLORATION_REDIRECT="${_tool_policy_redirect}" \
                        EPAM_REQUIRED_SYMBOLS="${_req_symbols}" \
                        EPAM_REQUIRED_SYMBOL_SCOPE="${_req_scope}" \
                        EPAM_ALLOWED_WRITE_PATHS="${_allowed_write_paths}" \
                        EPAM_OTHER_STORY_PATHS="${_other_story_paths}" \
                        EPAM_STORY_OWNERSHIP_KNOWN="${_story_ownership_known}" \
                        EPAM_SCOPE_WIDENING_LOG="${LOG_DIR}/scope-widenings.jsonl" \
                        EPAM_AGENT_MESSAGE_CATALOG="${EPAM_AGENT_MESSAGE_CATALOG:-${AUTOMATION_DIR}/config/agent-messages.json}" \
                        EPAM_MAX_ITERATIONS="${_effective_max_iterations}" \
                        EPAM_AUTO_COMPRESS_AT="${_effective_compress_at}" \
                        EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS="${_effective_compress_every_n}" \
                        EPAM_MAX_OUTPUT_TOKENS="${STORY_MAX_OUTPUT_TOKENS:-3072}" \
                        EPAM_MAX_TOOL_CALLS="${EPAM_STORY_MAX_TOOL_CALLS:-}" \
                        OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-}" \
                        EPAM_OPENROUTER_MODEL_OVERRIDE="${EPAM_OPENROUTER_MODEL_OVERRIDE:-}" \
                        DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}" \
                        EPAM_API_KEY_OPENROUTER="${EPAM_API_KEY_OPENROUTER:-}" \
                        MINIMAX_API_KEY="${MINIMAX_API_KEY:-}" \
                        EPAM_API_KEY_MINIMAX="${EPAM_API_KEY_MINIMAX:-}" \
                        MINIMAX_BASE_URL="${MINIMAX_BASE_URL:-}" \
                        EPAM_MINIMAX_MODEL_OVERRIDE="${EPAM_MINIMAX_MODEL_OVERRIDE:-}" \
                        EPAM_FINAL_FALLBACK_MODEL="${EPAM_FINAL_FALLBACK_MODEL:-}" \
                        EPAM_FINAL_FALLBACK_PROVIDER="${EPAM_FINAL_FALLBACK_PROVIDER:-}" \
                        OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
                        EPAM_API_KEY_OPENAI="${EPAM_API_KEY_OPENAI:-}" \
                        EPAM_RALPH_WIGGUM_ENABLED="${EPAM_RALPH_WIGGUM_ENABLED:-}" \
                        EPAM_RALPH_WIGGUM_AGENTS="${EPAM_RALPH_WIGGUM_AGENTS:-}" \
                        EPAM_RALPH_WIGGUM_TIMEOUT_MS="${EPAM_RALPH_WIGGUM_TIMEOUT_MS:-}" \
                        EPAM_SANDBOX_TARGET_CMD="${_epam_sandbox_target}" \
                        "${_timeout_prefix[@]}" "$_epam_run_binary" run \
                        --provider "$STORY_PROVIDER" \
                        "${epam_model_flag[@]}" \
                        --json - \
                        > "$raw_file" 2>> "$output_file"; then
                    normalize_provider_json "epam-run" "$raw_file" "$json_result_file"
                    jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || true
                    invoke_success=true
                fi
                ;;
            epam)
                # epam: treat same as claude — same CLI, same output format
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    local sdk_think_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            --cache-system \
                            "${sdk_model_arg[@]}" "${sdk_think_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
            *)
                # Claude-compatible providers use the Claude CLI JSON output shape.
                # SDK path: invoke.py via Anthropic Python SDK (EPAM_SDK_INVOKE=1)
                # CLI path: claude --print --output-format json (default)
                if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
                    local sdk_model_arg=()
                    [ -n "${STORY_MODEL:-}" ] && sdk_model_arg=(--model "$STORY_MODEL")
                    # Token pre-count (first attempt only — near-zero cost, no generation)
                    if [ "$retry_count" -eq 0 ]; then
                        local precount
                        precount=$(echo "$prompt" | "$INVOKE_PYTHON" "$INVOKE_PY" \
                            "${sdk_model_arg[@]}" --count-tokens-only --output /dev/null 2>/dev/null || echo "")
                        [ -n "$precount" ] && log "  Token pre-count: ${precount} input tokens"
                        STORY_PRECOUNT_TOKENS="${precount:-0}"
                    fi
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$INVOKE_PYTHON" "$INVOKE_PY" \
                            --cache-system \
                            "${sdk_model_arg[@]}" \
                            --system-prompt "$effective_constitution" \
                            --output "$json_result_file" 2>>"$output_file"; then
                        invoke_success=true
                    fi
                else
                    if echo "$prompt" | "${_timeout_prefix[@]}" "$CLAUDE_CMD" --print --output-format json \
                            "${model_flag[@]}" "${RUNNER_FLAGS[@]}" "${effective_permissions[@]}" \
                            2>>"$output_file" > "$json_result_file"; then
                        invoke_success=true
                    fi
                fi
                ;;
        esac

        # Log THIS attempt's real token/cost usage unconditionally (success or
        # failure) — previously only the FINAL attempt's json_result_file
        # ever reached phase-cost.jsonl (append_cost_record was only called
        # once, at the story's terminal completed/failed state), so every
        # earlier retry's real, billed tokens were silently invisible to any
        # dashboard or report. Found live 2026-07-23 (AMSD-1820): an 8-attempt
        # failure with ~200-240k input tokens on EACH attempt would have shown
        # only the last one — hiding roughly 7/8 of the real cost. Distinct
        # status ("attempt", not "completed"/"failed") so existing consumers
        # that filter on terminal status are unaffected; the attempt number
        # lets a per-story total be summed independently of that filter.
        append_cost_record "$story_id" "attempt" "$attempt_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file" "$((retry_count + 1))"

        # Cost controls. Sums this story's own real cost across every attempt
        # recorded so far, since retries/ladder escalation on one story are
        # exactly where spend can run away unnoticed.
        if [ -n "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] || [ -n "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ]; then
            local _cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
            if [ -f "$_cost_file" ]; then
                local _story_cost_so_far
                # Filtered by RUN, not just story. phase-cost.jsonl is appended across runs and
                # is not reset by pre-run-reset, so summing by story_id alone charged this run
                # for every previous run's attempts on the same ticket — metrolinx had already
                # accumulated $11.20 of history against AMSD-2041. A limit that counts spend the
                # operator never authorised this run is not a limit, it is a lottery.
                # Records predating run stamping carry no run_id and are correctly excluded.
                _story_cost_so_far=$(jq -s --arg id "$story_id" --arg rid "${ORCH_RUN_ID:-}" \
                    '[.[] | select(.story_id == $id)
                          | select(($rid == "") or (.run_id == $rid))
                          | (.task_cost_usd // 0)] | add // 0' \
                    "$_cost_file" 2>/dev/null || echo 0)
                # Warning: advisory only, logged once per story per run.
                if [ "$_budget_warned" != "1" ] && [ -n "${EPAM_STORY_BUDGET_WARNING_USD:-}" ] \
                   && awk -v c="$_story_cost_so_far" -v w="$EPAM_STORY_BUDGET_WARNING_USD" 'BEGIN{exit !(c > w)}'; then
                    warning "Story $story_id has spent \$${_story_cost_so_far} so far, over its \$${EPAM_STORY_BUDGET_WARNING_USD} warning threshold"
                    _budget_warned=1
                fi
                # Hard limit: stop granting this story further retries. The
                # CURRENT attempt (already paid for) is allowed to finish
                # normally — deliverables/TC-writer/external verification
                # below still run, so a success already in flight isn't
                # thrown away. _retry_extension_used=1 is set BEFORE forcing
                # the loop past MAX_RETRIES specifically so
                # run_retry_extension_coordinator() (which can GRANT MORE
                # retries on the self-heal path right after this loop exits)
                # is never consulted — without that, a budget-triggered stop
                # could still be overridden into more spend by self-heal.
                if [ -n "${EPAM_STORY_BUDGET_HARD_LIMIT_USD:-}" ] \
                   && awk -v c="$_story_cost_so_far" -v w="$EPAM_STORY_BUDGET_HARD_LIMIT_USD" 'BEGIN{exit !(c >= w)}'; then
                    error "Story $story_id has spent \$${_story_cost_so_far}, at or over its \$${EPAM_STORY_BUDGET_HARD_LIMIT_USD} hard limit — no further retries will be granted (self-heal extension skipped)"
                    _retry_extension_used=1
                    retry_count=$((MAX_RETRIES + 1))
                fi
            fi
        fi

        # Vendor-dir guard: NOT unlocked here — run_vendor_integrity_check()
        # (called at the very start of run_external_verification, before
        # run_dependency_check's own sanctioned writes) needs the lock marker
        # and current permissions intact to correctly attribute any tamper to
        # this attempt. _vendor_unlock() is called from inside
        # run_external_verification itself, right after that check passes.

        if [ "$invoke_success" = true ] && ! verify_story_deliverables "$story_id"; then
            warning "$story_cli returned success but story deliverables are incomplete"
            invoke_success=false
        fi

        # Inline TC writer — fires after impl deliverables are verified, before
        # external test. Generates testCriteria in the PRD for sibling test
        # stories so the test agent has precise facts, not just abstract ACs.
        # Skipped for test stories themselves (they don't generate TCs).
        if [ "$invoke_success" = true ] && ! is_truthy "${SKIP_TC_WRITER:-}"; then
            local _story_files_are_tests
            # grep -c ALREADY prints "0" on zero matches (its own count) while
            # also exiting 1 — combining that with `|| echo 0` double-prints
            # ("0\n0"), which then fails the `-eq` numeric test below with
            # "integer expression expected" (found live, 2026-07-06, blocking
            # external verification for every non-test story with exit 127).
            # `|| true` only suppresses the exit code (needed since this
            # script runs under `set -e`), without adding extra output.
            _story_files_are_tests=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null \
                | { grep -cE '(\.|_)(spec|test)\.[A-Za-z0-9]+$|/__tests__/|(^|/)test_[^/]+$' || true; })
            if [ "${_story_files_are_tests:-0}" -eq 0 ]; then
                local _tcw_phase; _tcw_phase="$(_tc_writer_phase)"
                if [ -z "$_tcw_phase" ]; then
                    warning "  [tc-writer] no phase is set (CURRENT_PHASE and PHASE both empty) — TCs NOT generated"
                fi
                log "  [tc-writer] Generating TCs for phase '${_tcw_phase:-<unset>}' (post-impl, pre-test)..."
                # `if CMD | tee ...; then` TESTS TEE, which exits 0 essentially always — so this
                # reported "TC generation complete" whatever the writer did, including refusing to
                # run at all. No pipefail here; PIPESTATUS[0] is the writer's own code.
                if { bash "$SCRIPT_DIR/post-impl-tc-writer.sh" \
                    --prd "${MAIN_PRD_FILE:-$PRD_FILE}" \
                    --phase "$_tcw_phase" \
                    --output-dir "$PROJECT_ROOT" \
                    2>&1 | tee -a "$output_file"; [ "${PIPESTATUS[0]}" -eq 0 ]; }; then
                    log "  [tc-writer] TC generation complete — test stories have testCriteria"
                else
                    warning "  [tc-writer] TC generation failed — test stories will run without TCs (non-fatal)"
                fi
            fi
        fi

        # TypeScript compile check — runs BEFORE external verification
        # (reordered 2026-07-12; see run_tsc_verification()'s own comment for
        # the live incident this fixes). A syntax/type error is a cheap,
        # near-instant deterministic check; the (often multi-minute) external
        # test command below should never run against code that can't even
        # compile. Still inside the retry loop so a tsc failure gets the same
        # self-healing treatment (failure analyst, InferenceLadder escalation)
        # as any other verification failure, rather than exiting the phase
        # with zero retries.
        # LAST_ATTEMPT_TSC_PASSED is the "validated work" signal
        # _selective_worktree_reset (below, next rung transition) uses to
        # decide whether the CURRENT diff is safe to preserve wholesale —
        # real, already-computed evidence (not a heuristic) that the tree is
        # at least type/syntax-correct, not the specific-broken-half-write
        # state the reset exists to protect against. Only true when tsc
        # actually ran AND passed; false if it failed OR never ran (an
        # earlier stage already failed first) — "no evidence it's good" and
        # "evidence it's bad" are both reasons to not trust the diff.
        #
        # Captured via _invoke_success_before_tsc rather than restructuring
        # the check below into its own if/else — that literal
        # `[ "$invoke_success" = true ] && ! run_tsc_verification ...; then`
        # shape (unchanged since 2026-07-12) is asserted on directly by
        # tsc-retry-in-loop.test.ts and tsc-gate-test-engineer-blindspot.test.ts.
        local _invoke_success_before_tsc="$invoke_success"
        if [ "$invoke_success" = true ] && ! run_tsc_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but the project type check failed"
            invoke_success=false
        fi
        # Three outcomes, not two. Recording "never ran" as `false` conflates "this tree does
        # not type-check" with "nothing is known about this tree", and _selective_worktree_reset
        # deletes the whole diff on the strength of that. Found live 2026-08-09 (AMSD-2041): a
        # story rejected by verify_story_deliverables for being INCOMPLETE never reaches the tsc
        # gate above, so its two correct fix sites were recorded as type-failures and erased at
        # the next rung transition — four attempts re-deriving the same files from an empty tree.
        # THE COMPILER SIGNAL IS GONE ON PURPOSE — DO NOT PUT IT BACK.
        #
        # A tri-state LAST_ATTEMPT_TSC_PASSED was computed here for _selective_worktree_reset, to
        # decide whether the current diff was safe to preserve. That function no longer asks the
        # question: keep/discard is a SPEC question, not a compiler one. For any multi-file change a
        # partially-complete edit is correct progress AND a compile error at once, so the compiler
        # could only preserve work that was already coherent — precisely the work that never needed
        # preserving. Live 2026-08-10: 25 file writes across five invocations, zero survivors, on a
        # story with 13 interdependent fix sites. The predicate is now the spec's changeRequired.
        #
        # The variable outlived its consumer: assigned in three places, read in none, while the
        # comments here still called it the deciding signal. Removed rather than rewired — rewiring
        # it would restore the behaviour that destroyed those 25 writes.

        # The repository's OWN lint, before the commit rather than at Step 20. A violation here
        # is fatal at commit time (husky rejects, lint-staged reverts the work), so it has to be
        # feedback inside the loop. Placed after tsc so the writer fixes type errors first, and
        # before the test run so it does not spend a full external verification on a change that
        # cannot commit.
        if [ "$invoke_success" = true ] && ! run_repo_lint_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but the repository's own lint rejects them"
            invoke_success=false
        fi

        # External test verification — runs tests outside the agent loop so the
        # agent only needs to write files (keeping iterations low).
        if [ "$invoke_success" = true ] && ! run_external_verification "$story_id" "$output_file"; then
            warning "$story_cli deliverables written but external tests failed"
            invoke_success=false
        fi

        if [ "$invoke_success" = true ]; then
            # Extract human-readable result text and append to output log
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== End $story_cli Output ===" >> "$output_file"
            success "$story_cli completed implementation for $story_id"
            update_monitor_status "complete" "$story_id" "Implementation succeeded"
            append_cost_record "$story_id" "completed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
            # Attribute this FINAL rung's contribution (backlog #113) — no
            # further rung transition will happen to trigger this otherwise,
            # since the story just succeeded.
            _rung_attribute_changes "$story_id" "$_rung" "${STORY_MODEL:-}"
            _generate_rung_contribution_report "$story_id"
            # ONE AUTHOR PER COUPLED FILE PAIR. The retry bookkeeping below is
            # duplicated into this branch deliberately: a story that fails here has
            # still BURNED this rung, and dropping out without persisting the count
            # and model is what makes a ladder restart its climb from rung 0.
            # ADVISORY, so no retry branch: it records a scope finding and always returns 0.
            # A `if ! ...; then <retry>` here would be a branch that can never be taken, which
            # reads to the next person as enforcement that exists. See the function's header
            # for why blocking on this signal rejects working code.
            _plan_fidelity_gate_for_story "$story_id" "$output_file"
            if ! _coupled_pair_gate_for_story "$story_id" "$output_file"; then
                write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
                write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
                write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
                rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
                update_monitor_status "retry" "$story_id" "Coupled file pair had more than one author"
                return 1
            fi
            rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
            # Persisted even on success: a technically-successful attempt can
            # still be REJECTED by Step 3.6's review — the next
            # re-implementation must resume from here, not rung 0.
            write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
            # The model belongs with the count: the count is only a proxy for the rung, and the
            # rung is only a proxy for WHICH MODEL RUNS. Persisting one without the other is
            # what made the ladder restart its climb on every re-invocation.
            write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
            write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
            post_completion_message "$story_id" "completed"
            return 0
        else
            local exit_code=$?
            # Still capture any partial JSON output
            if [ -f "$json_result_file" ]; then
                jq -r '.result // empty' "$json_result_file" 2>/dev/null >> "$output_file" || cat "$json_result_file" >> "$output_file"
            fi
            echo "" >> "$output_file"
            echo "=== $story_cli exited with code $exit_code ===" >> "$output_file"

            # ── Coordinator pre-assessment before next retry ──────────────────
            # Resolve the actual raw file path (may differ by provider).
            local _raw_for_coord="$attempt_raw_file"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord="${json_result_file%.json}_raw.jsonl"
            [ ! -f "$_raw_for_coord" ] && _raw_for_coord=""

            # Layer 1: rule-based triage (always runs)
            # A REFUSED COMMAND LINE ENDS THE STORY -- it cannot differ on the next attempt.
            # Checked before the coordinator, whose evidence is the raw output file that a refused
            # invocation never produces; the attempt log always exists and carries the error.
            if classify_invocation_refusal "$output_file" "$exit_code"; then
                COORDINATOR_FAILURE_CLASS="invocation"
                COORDINATOR_ESCALATE="no"
                return 1
            fi
            classify_failure_class "$_raw_for_coord" "$json_result_file" "$exit_code" "$story_id"

            # Work carryover: verify_story_deliverables() (called above, on
            # whichever attempt last actually ran the agent) already knows
            # which declared files got REAL work vs which still show no diff
            # from baseline. Surfacing that split explicitly to the NEXT
            # attempt — rather than leaving it to be re-derived from
            # "## Existing File Contents" prose alone — means a rung
            # escalation builds on what's already correct instead of risking
            # a full rewrite of files that didn't need one. Appended, not
            # overwritten: classify_failure_class above may have already set
            # its own amendment for this failure class.
            if [ -n "${LAST_VERIFIED_TOUCHED_FILES:-}" ] || [ -n "${LAST_VERIFIED_UNCHANGED_FILES:-}" ]; then
                local _carryover_note="

## Work Already Done (previous attempt)"
                if [ -n "${LAST_VERIFIED_TOUCHED_FILES:-}" ]; then
                    _carryover_note="${_carryover_note}
These files already have real changes from the previous attempt — build on them, do NOT rewrite from scratch unless the review/test feedback specifically says one of them is wrong:
$(echo "$LAST_VERIFIED_TOUCHED_FILES" | sed 's/^/- /')"
                fi
                if [ -n "${LAST_VERIFIED_UNCHANGED_FILES:-}" ]; then
                    _carryover_note="${_carryover_note}
These declared files still show NO changes since baseline — if the story needs them, you must actually write to them:
$(echo "$LAST_VERIFIED_UNCHANGED_FILES" | sed 's/^/- /')"
                fi
                COORDINATOR_PROMPT_AMENDMENT="${COORDINATOR_PROMPT_AMENDMENT:-}${_carryover_note}"
            fi

            # Layer 2: LLM gate (only for capability/quality failures, only when enabled)
            local _next_model
            _next_model=$(jq -r --arg id "$story_id" \
                '.stories[] | select(.id == $id) | .retryModel // ""' \
                "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
            _next_model="${_next_model:-${EPAM_RETRY_MODEL:-}}"
            if [ "$COORDINATOR_ESCALATE" = "yes" ] && \
               [ "$COORDINATOR_FAILURE_CLASS" != "env" ] && \
               [ -n "$_next_model" ]; then
                assess_model_escalation "$story_id" "$_raw_for_coord" "$json_result_file" "$output_file" "$_next_model"
            fi

            # Cross-run memory: persist failure evidence so future runs and the
            # coordinator can detect repeated failure patterns across multiple runs.
            local _failures_file="${LOG_DIR}/story-failures.jsonl"
            local _raw_sz=0
            [ -f "$_raw_for_coord" ] && _raw_sz=$(wc -c < "$_raw_for_coord" 2>/dev/null || echo 0)
            local _tokens_out_mem=0
            [ -f "$json_result_file" ] && _tokens_out_mem=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$json_result_file" 2>/dev/null || echo 0)
            (
                flock -w 5 300 2>/dev/null || true
                jq -cn \
                    --arg sid "$story_id" \
                    --arg fc "$COORDINATOR_FAILURE_CLASS" \
                    --arg model "${STORY_MODEL:-unknown}" \
                    --argjson attempt "$retry_count" \
                    --argjson exit_c "$exit_code" \
                    --argjson raw_sz "${_raw_sz:-0}" \
                    --argjson toks "${_tokens_out_mem:-0}" \
                    --argjson iters "${STORY_MAX_ITERATIONS:-0}" \
                    '{storyId:$sid, failureClass:$fc, model:$model,
                      attempt:$attempt, exitCode:$exit_c, rawBytes:$raw_sz,
                      outputTokens:$toks, maxIterations:$iters,
                      timestamp:(now|todate)}' >> "$_failures_file"
            ) 300>>"${_failures_file}.lock"

            # Layer 3: failure analyst — diagnose test failure and patch PRD or inject
            # skill guidance before the next retry. Only runs when more retries remain.
            # Skipped for deterministic-check failures (relative-import-check,
            # mock-completeness-check): the check's own message already names the
            # exact violation precisely — spending a gate-model call to "diagnose"
            # something already known is pure waste. Inject the check's message
            # directly as retry guidance instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ]; then
                log "  [DeterministicCheck] Skipping failure-analyst — violation already precisely known"
                local _existing_amendment="${COORDINATOR_PROMPT_AMENDMENT:-}"
                # Re-inject the last failure-analyst diagnosis for this story from
                # healing-events.jsonl. DeterministicCheck skips the analyst (saving
                # a gate-model call) but that means the agent loses the actionable
                # "use this pattern instead" guidance the analyst wrote on earlier
                # retries. Without re-injection, subsequent retries only see the
                # pre-check's terse error message — not the richer fix guidance.
                local _last_fa_diagnosis=""
                local _heal_log="${LOG_DIR}/healing-events.jsonl"
                if [ -f "$_heal_log" ]; then
                    _last_fa_diagnosis=$(python3 "$SCRIPT_DIR/lib/handlers/last-fa-diagnosis.py" "$_heal_log" "$story_id" 2>/dev/null || echo "")
                fi
                _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
                jq_vals \
                      --arg prior_diagnosis_section "${_last_fa_diagnosis:+

## Prior failure-analyst diagnosis (re-injected for context)
$_last_fa_diagnosis
Apply the above diagnosis AND fix the deterministic check violation — both must be resolved.}" \
                      --arg verification_failure "${VERIFICATION_FAILURE}" \
                      --arg existing_amendment "${_existing_amendment}" \
                      '{"__PRIOR_DIAGNOSIS_SECTION__":$prior_diagnosis_section,"__VERIFICATION_FAILURE__":$verification_failure,"__EXISTING_AMENDMENT__":$existing_amendment}' > "$_cp_vals"
                _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" deterministic_check)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
                rm -f "$_cp_vals"

                # A deterministic-check violation repeating IDENTICALLY across attempts
                # is just as strong an escalation signal as an LLM-diagnosed repeat, but
                # check_healing_effectiveness never sees it (it only runs inside
                # run_failure_analyst, deliberately skipped above). Confirmed live
                # (run #15, 2026-07-05): SKY-003 repeated the SAME relative-import-check
                # violation 5 times across free AND counted retries with zero
                # escalation, because the only repeat-detector was being bypassed.
                # Reuse the existing HEALING_BROKEN flag/skip-to-next-rung consumer
                # logic below instead of building a separate signal.
                #
                # BUG (found live, 2026-07-05): comparing the RAW VERIFICATION_FAILURE
                # text false-triggered a repeat between two GENUINELY DIFFERENT
                # violations (a relative-import-check failure, then a totally
                # unrelated mock-completeness-check failure on the retry) — every
                # deterministic check's message shares the same templated preamble
                # ("## Verification Failure\n\n<intro sentence>... anything else:\n\n")
                # plus the same recurring file/class names for this story, so generic
                # boilerplate words alone crossed the token-overlap threshold (11
                # shared tokens, ratio 0.52) even though the actual problem was
                # unrelated. Fix: strip the templated intro (everything through the
                # first ":\n\n") before comparing — only the check-specific detail
                # lines that follow are meaningful signal.
                local _prev_violation_detail _cur_violation_detail
                _prev_violation_detail="${_prev_deterministic_violation#*:$'\n'$'\n'}"
                _cur_violation_detail="${VERIFICATION_FAILURE#*:$'\n'$'\n'}"
                if [ -n "$_prev_deterministic_violation" ]; then
                    local _same_violation
                    _same_violation=$(same_root_cause_diagnoses "$_prev_violation_detail" "$_cur_violation_detail")
                    if [ "$_same_violation" = "true" ]; then
                        error "  [DeterministicCheck] CRITICAL: same violation repeated for $story_id without resolution — treating as HealingBroken"
                        HEALING_BROKEN=1
                        export HEALING_BROKEN

                        # THE SKIP ABOVE IS CORRECT ONCE, AND ONLY ONCE.
                        #
                        # Skipping the analyst is right while the violation is NEW: the check names
                        # it precisely and a gate-model call to restate it is waste. That premise is
                        # falsified here. The remedy has been injected and applied and the SAME
                        # violation came back, so the open question is no longer WHAT is wrong — it
                        # is why the known remedy keeps failing, which is the analyst's only job.
                        #
                        # Live 2026-08-14 (AMSD-2041): the story climbed rung 0 -> 1 -> 2, declared
                        # HealingBroken three times, aborted at max rung, and the analyst was
                        # invoked ZERO times. Its ladder was unreachable code on this whole class.
                        if [ "$retry_count" -lt "$MAX_RETRIES" ]; then
                            log "  [DeterministicCheck] the remedy was applied and the same violation returned — invoking the failure analyst to diagnose WHY"
                            run_failure_analyst "$story_id" "$output_file" "$retry_count"
                        fi
                    fi
                fi
                _prev_deterministic_violation="$VERIFICATION_FAILURE"
            elif [ $retry_count -lt $MAX_RETRIES ]; then
                run_failure_analyst "$story_id" "$output_file" "$retry_count"
            fi

            # An escalated defect (see escalate_defect_to_sibling_story) takes
            # priority over normal retry handling — if the escalating story's
            # agent correctly diagnosed a defect in a sibling's file it cannot
            # touch, resolve it now rather than letting the story burn its own
            # retry ladder re-diagnosing something it structurally cannot fix.
            if resolve_escalation "$story_id"; then
                success "  [Escalation] Resolved — free retry for $story_id (not counted against the ladder)"
                continue
            fi

            # Deterministic-check failures get up to 3 FREE retries — they don't
            # advance retry_count (so they don't consume ladder/model-escalation
            # budget), since a mechanical "you missed a spot" violation is not
            # evidence of a capability gap the way a real test failure is. After 3
            # free retries without resolution, fall through to a normal counted
            # retry to bound the loop. Skipped entirely when the violation just
            # repeated identically (HEALING_BROKEN set above) — granting another
            # free retry on a KNOWN-non-converging violation just wastes an attempt;
            # fall straight through to the counted/rung-skip path instead.
            if [ "${DETERMINISTIC_CHECK_FAILURE:-0}" -eq 1 ] && [ "${HEALING_BROKEN:-0}" -ne 1 ] && [ "$_free_retry_count" -lt 3 ]; then
                _free_retry_count=$((_free_retry_count + 1))
                DETERMINISTIC_CHECK_FAILURE=0
                export DETERMINISTIC_CHECK_FAILURE
                warning "  [DeterministicCheck] Free retry ${_free_retry_count}/3 for $story_id — not counted against the model-escalation ladder"
                continue
            fi
            DETERMINISTIC_CHECK_FAILURE=0
            export DETERMINISTIC_CHECK_FAILURE

            retry_count=$((retry_count + 1))
            # If self-healing is confirmed broken, skip to the start of the next rung
            # rather than burning the second attempt. At the last rung (3), abort instead.
            if [ "${HEALING_BROKEN:-0}" -eq 1 ]; then
                local _cur_rung=$(( (retry_count - 1) / 2 ))
                local _next_rung_start=$(( (_cur_rung + 1) * 2 ))
                HEALING_BROKEN=0
                export HEALING_BROKEN
                if [ "$_cur_rung" -ge 3 ] || [ "$_next_rung_start" -gt "$MAX_RETRIES" ]; then
                    error "  [HealingBroken] At max rung — aborting $story_id"
                    break
                else
                    warning "  [HealingBroken] Skipping to rung $((_cur_rung + 1)) (retry $_next_rung_start) for $story_id"
                    retry_count=$_next_rung_start
                fi
            fi
            # Early escalation: the model made a DIFFERENT mistake on back-to-back
            # attempts while still un-escalated (Rung 0-1) — jump straight to Rung 2
            # (model escalation) instead of exhausting the rest of the base-model
            # budget. Mutually exclusive with HEALING_BROKEN by construction (a pair
            # of diagnoses can't be both the same root cause and different root
            # causes), so no ordering conflict between the two blocks.
            if [ "${EARLY_ESCALATION_NEEDED:-0}" -eq 1 ]; then
                EARLY_ESCALATION_NEEDED=0
                export EARLY_ESCALATION_NEEDED
                if [ "$retry_count" -lt 4 ] && [ 4 -le "$MAX_RETRIES" ]; then
                    warning "  [FailureDiversity] Jumping to Rung 2 (retry 4) for $story_id — base model isn't converging"
                    retry_count=4
                fi
                # Different failure classes across attempts (not the same bug
                # recurring) is the signature of token-selection variance, not a
                # capability gap — the model is making a DIFFERENT plausible
                # mistake each time rather than converging on the fix. Pin
                # temperature to near-zero for the remainder of this story so it
                # stops exploring alternative (and equally wrong) approaches and
                # sticks to its single most likely path, making exact-string ACs
                # (e.g. a literal error-message substring) reachable.
                warning "  [FailureDiversity] Pinning temperature to 0 for the remainder of $story_id — non-repeating failures indicate token-variance, not a capability gap"
                export EPAM_TEMPERATURE="0"
            fi
            # Persist BEFORE the sleep, not after — a killed/timed-out process
            # must not lose the rung it already reached.
            write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"
            # The model belongs with the count: the count is only a proxy for the rung, and the
            # rung is only a proxy for WHICH MODEL RUNS. Persisting one without the other is
            # what made the ladder restart its climb on every re-invocation.
            write_story_retry_model "$LOG_DIR" "$story_id" "${STORY_MODEL:-}"
            write_story_iteration_bump "$LOG_DIR" "$story_id" "${STORY_ITERATION_BUMP_TOTAL:-0}"
            if [ $retry_count -le $MAX_RETRIES ]; then
                warning "$story_cli failed, retrying in ${RETRY_DELAY}s..."
                sleep $RETRY_DELAY
            fi
        fi
    done

    # Retry-extension coordinator (2026-07-12): the inner loop just exhausted
    # MAX_RETRIES. Before giving up, ask (at most once per story) whether the
    # evidence justifies a bounded extension -- see
    # run_retry_extension_coordinator()'s own docstring for the full design.
    if [ "$_retry_extension_used" -eq 0 ]; then
        _retry_extension_used=1
        local _granted_extra_retries
        _granted_extra_retries=$(run_retry_extension_coordinator "$story_id")
        if [ -n "$_granted_extra_retries" ] && [ "$_granted_extra_retries" -gt 0 ] 2>/dev/null; then
            MAX_RETRIES=$((MAX_RETRIES + _granted_extra_retries))
            # Retry extension (kimi-k3 territory): open the output token ceiling
            # to generator-level (16384) — at this point the story has exhausted
            # the standard ladder and is receiving the strongest available model;
            # any remaining token budget constraint must not be the failure mode.
            [ "${STORY_MAX_OUTPUT_TOKENS:-0}" -lt 16384 ] && STORY_MAX_OUTPUT_TOKENS="${EPAM_ROLE_GENERATOR_MAX_OUTPUT_TOKENS}"
            continue
        fi
    fi
    break
    done

    error "Failed to implement $story_id after $((MAX_RETRIES + 1)) attempts"
    update_monitor_status "fail" "$story_id" "Failed after $((MAX_RETRIES + 1)) attempts"
    append_cost_record "$story_id" "failed" "$story_started_at" "$(date -Iseconds)" "$output_file" "$json_result_file"
    rm -f "$(_rung_snapshot_path "$story_id")" 2>/dev/null || true
    post_completion_message "$story_id" "failed"
    return 1
}

# Update story status in PRD
update_story_status() {
    local story_id=$1
    local status=$2  # "completed" or "failed"
    local timestamp
    timestamp=$(date -Iseconds)
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local lock_file="${prd_target}.lock"

    local tmp_file="${prd_target}.tmp.$$"

    (
        flock -w 10 200 || { error "Could not acquire lock on $prd_target"; return 1; }

        if [ "$status" = "completed" ]; then
            jq --arg id "$story_id" --arg ts "$timestamp" \
                '(.stories[] | select(.id == $id)) |= . + {completed: true, status: "completed", completedAt: $ts}' \
                "$prd_target" > "$tmp_file" && mv "$tmp_file" "$prd_target"
            success "Story $story_id marked as completed"
            update_agents_file "$story_id" "completed"
        else
            jq --arg id "$story_id" --arg ts "$timestamp" \
                '(.stories[] | select(.id == $id)) |= . + {status: "failed", lastAttempt: $ts}' \
                "$prd_target" > "$tmp_file" && mv "$tmp_file" "$prd_target"
            warning "Story $story_id marked as failed"
            update_agents_file "$story_id" "failed"
        fi
        # Sync live PRD to dashboard prd.json so viewers update in real-time
        if [ -n "${OUTPUT_DIR:-}" ] && [ -f "$prd_target" ]; then
            cp "$prd_target" "$OUTPUT_DIR/../prd.json" 2>/dev/null || true
        fi
    ) 200>"$lock_file"
}

# Append a cost/time record to phase-cost.jsonl
# Called after each story completes (success or failure) for phase-aware
# tracking, AND after every individual retry attempt (status="attempt",
# attempt_num set) so real per-attempt token/cost usage is never invisible —
# see the call site right after the provider-invocation case block above.
# result_is_from_this_attempt <json_result_file> <started_at>
#
# WHOSE RESULT IS THIS? append_cost_record reads usage out of $json_result_file, and an attempt
# that fails before writing one leaves the PREVIOUS attempt's file in place. The ledger then
# records those numbers again for a call that never happened.
#
# Live 2026-08-18, MOCK3-1: attempts 3-12 asked a provider for a model it does not serve, came
# back in about a second with nothing, and each recorded in=15812 out=1860 cost=$0.007 — attempt
# 2's numbers, ten more times, on the measurement the story budget guard sums to enforce a limit.
#
# The attempt's start time is already a parameter. A result file older than the attempt did not
# come from it. Absent file, absent path or absent start time all answer "not mine" rather than
# guessing — an over-report here is invented spend, and an under-report is merely a gap.
result_is_from_this_attempt() {
    local _f="${1:-}" _started="${2:-}"
    [ -n "$_f" ] && [ -f "$_f" ] || return 1
    [ -n "$_started" ] || return 1
    local _fm _sm
    _fm=$(stat -c %Y "$_f" 2>/dev/null) || return 1
    _sm=$(date -d "$_started" +%s 2>/dev/null) || return 1
    [ -n "$_fm" ] && [ -n "$_sm" ] || return 1
    [ "$_fm" -ge "$_sm" ]
}

append_cost_record() {
    local story_id=$1 status=$2 started_at=$3 ended_at=$4 output_file=$5 json_result_file=${6:-} attempt_num=${7:-}
    local cost_file="${PHASE_COST_FILE:-$LOG_DIR/phase-cost.jsonl}"
    local lock_file="${cost_file}.lock"

    # Read story metadata from prd.json
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local title
    title=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .title // "unknown"' "$prd_target")
    local agent_id
    agent_id=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // "unknown"' "$prd_target")
    local forecast_hours
    forecast_hours=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedHours // 0' "$prd_target")
    local forecast_cost
    forecast_cost=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .estimatedCost // 0' "$prd_target" 2>/dev/null || echo 0)
    local story_effort
    story_effort=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .effort // "medium"' "$prd_target")
    local story_type
    story_type=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .storyType // "implementation"' "$prd_target")
    # A result file that predates this attempt belongs to the previous one; reading it would
    # bill this attempt for a call it never made. See result_is_from_this_attempt.
    if [ -n "$json_result_file" ] && ! result_is_from_this_attempt "$json_result_file" "$started_at"; then
        log "  Cost[$story_id] no result from this attempt — recording zero usage rather than repeating the previous attempt's"
        json_result_file=""
    fi
    local resolved_model="${STORY_MODEL:-}"
    local planner_model="${STORY_PLANNER_MODEL:-}"
    local prompt_tokens_measured="${STORY_PRECOUNT_TOKENS:-0}"
    local invoke_mode="cli"
    [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && invoke_mode="sdk"
    local phase_id="${CURRENT_PHASE:-}"
    if [ -z "$phase_id" ]; then
        # Look up phase from implementationOrder when not set by --phase flag
        phase_id=$(jq -r --arg id "$story_id" \
            '.implementationOrder | to_entries[] | select(.value | contains([$id])) | .key' \
            "$prd_target" | head -1)
        [ -z "$phase_id" ] && phase_id="unknown"
    fi

    # Compute elapsed minutes
    local start_epoch
    start_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo 0)
    local end_epoch
    end_epoch=$(date -d "$ended_at" +%s 2>/dev/null || echo 0)
    local elapsed_minutes=0
    if [ "$start_epoch" -gt 0 ] && [ "$end_epoch" -gt 0 ]; then
        elapsed_minutes=$(echo "scale=2; ($end_epoch - $start_epoch) / 60" | bc 2>/dev/null || echo "0")
    fi

    # Parse cost/token/turn usage from JSON result file.
    # Handles two output shapes:
    #   Claude CLI (--output-format json): total_cost_usd, usage.input_tokens, usage.output_tokens
    #   epam run --json (AgentRunner):     cost_usd,        usage.inputTokens,  usage.outputTokens,
    #                                      cost_is_estimate (explicit real-vs-estimate flag)
    local tokens_in=0 tokens_out=0 cost_usd=0 task_turns=0 cost_is_estimate=""
    if [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        cost_usd=$(jq -r '.total_cost_usd // .cost_usd // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Claude CLI's total_cost_usd has no equivalent flag (it's always
        # real, Anthropic bills it directly) — cost_is_estimate only exists
        # on epam run --json output. Empty here means "not applicable" for
        # Claude CLI, resolved to a concrete true/false below.
        cost_is_estimate=$(jq -r 'if has("cost_is_estimate") then (.cost_is_estimate | tostring) else "" end' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo "")
        tokens_in=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_out=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Turn count: Claude CLI reports num_turns/turns; AgentRunner reports iterations
        task_turns=$(jq -r '.num_turns // .turns // .usage.turns // .iterations // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        # Cache tokens (Claude CLI only; no-op for epam output)
        local cache_create
        cache_create=$(jq -r '.usage.cache_creation_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        local cache_read
        cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        tokens_in=$(( ${tokens_in:-0} + ${cache_create:-0} + ${cache_read:-0} ))
        # epam's own providers are OpenAI-shaped: prompt_tokens ALREADY INCLUDES the cached
        # portion, so this one is recorded and never added — adding it would double-count every
        # cached token into both the spend record and the budget guard that reads it. Emitted
        # under a distinct key for exactly that reason (see buildRunResultJson in run.ts).
        # Measured 2026-08-10: MiniMax-M3 serves 99.2% of an identical prefix from cache, so
        # this is the difference between a real utilisation number and a permanent zero.
        local cached_subset
        cached_subset=$(jq -r '.usage.cached_input_tokens // 0' "$json_result_file" 2>/dev/null | tr -d '[:space:]' || echo 0)
        if [ "${cached_subset:-0}" -gt 0 ]; then
            cache_read="$cached_subset"
        fi
    fi
    [ -z "$tokens_in" ] && tokens_in=0
    [ -z "$tokens_out" ] && tokens_out=0
    [ -z "$cost_usd" ] && cost_usd=0
    [ -z "$task_turns" ] && task_turns=0

    # If the JSON result explicitly said this cost is real (cost_is_estimate
    # = "false"), trust it even if it happens to be a genuine $0 call — don't
    # run it through the local pricing-table fallback below. Otherwise
    # (cost_is_estimate missing/true, or cost_usd is 0/empty), compute from
    # the pricing table as a last-resort ESTIMATE, and record that fact.
    if [ "$cost_is_estimate" != "false" ] && { [ "${cost_usd}" = "0" ] || [ "${cost_usd}" = "0.0" ] || [ -z "${cost_usd}" ]; }; then
        if [ "${tokens_in:-0}" -gt 0 ] || [ "${tokens_out:-0}" -gt 0 ]; then
            local computed_cost
            computed_cost=$(compute_token_cost "${resolved_model:-}" "$tokens_in" "$tokens_out")
            if [ -n "$computed_cost" ] && [ "$computed_cost" != "0" ]; then
                cost_usd="$computed_cost"
                cost_is_estimate="true"
            fi
        fi
    fi
    [ -z "$cost_is_estimate" ] && cost_is_estimate="false"

    # Atomic JSONL append with flock
    (
        flock -w 10 200 || { error "Could not acquire lock on $cost_file"; return 1; }
        jq -cn \
            --arg pid "$phase_id" --arg pn "$phase_id" \
            --arg rid "${ORCH_RUN_ID:-}" \
            --arg sid "$story_id" --arg st "$title" \
            --arg aid "$agent_id" --arg an "$agent_id" \
            --argjson fh "${forecast_hours:-0}" --argjson fc "${forecast_cost:-0}" \
            --arg sa "$started_at" --arg ea "$ended_at" \
            --argjson em "${elapsed_minutes:-0}" --argjson cu "$cost_usd" \
            --argjson ti "${tokens_in:-0}" --argjson to "${tokens_out:-0}" \
            --argjson tt "${task_turns:-0}" \
            --argjson cr "${cache_read:-0}" --argjson cc "${cache_create:-0}" \
            --arg s "$status" --arg n "" \
            --arg ef "${story_effort:-medium}" --arg stype "${story_type:-implementation}" \
            --arg rm "${resolved_model:-}" \
            --arg pm "${planner_model:-}" \
            --argjson ptm "${prompt_tokens_measured:-0}" \
            --arg im "${invoke_mode}" \
            --argjson cie "$cost_is_estimate" \
            --argjson an2 "${attempt_num:-null}" \
            '{run_id:$rid, phase_id:$pid, phase_name:$pn, story_id:$sid, story_title:$st,
              agent_id:$aid, agent_name:$an, forecast_hours:$fh, forecast_cost_usd:$fc,
              started_at:$sa, ended_at:$ea, elapsed_minutes:$em,
              task_cost_usd:$cu, task_tokens_in:$ti, task_tokens_out:$to,
              task_turns:$tt, cache_read_tokens:$cr, cache_create_tokens:$cc,
              status:$s, notes:$n,
              effort:$ef, storyType:$stype, resolvedModel:$rm,
              plannerModel:$pm,
              prompt_tokens_measured:$ptm, invokeMode:$im,
              costIsEstimate:$cie, attempt:$an2}' >> "$cost_file"
    ) 200>"$lock_file"

    # Emit human-readable cost summary to the run log so it appears in pipeline output.
    #
    # CACHED TOKENS ARE SHOWN BECAUSE THE COST FIGURE CANNOT SEE THEM.
    #
    # src/billing/pricing.ts charges every input token at inputPerMillion; ModelPricing has only
    # inputPerMillion and outputPerMillion, so there is nowhere to express a cache-read rate for
    # any model. Measured 2026-08-10: an attempt reporting in=7,502,302 cost=$2.2861 reconciles
    # EXACTLY to 7,502,302 x $0.30/M + 29,508 x $1.20/M — full rate on 96.2%-cached traffic.
    # The real bill is lower by whatever the vendor discounts cache reads, which is not yet
    # verified against MiniMax billing and is deliberately NOT guessed at here.
    #
    # Until the rate is known and wired, the honest thing is to show the utilisation next to the
    # figure it is missing from, so nobody optimises against a number that is blind to the single
    # largest efficiency win in the pipeline. A percentage is not a price and is not presented as
    # one; the cost stays flagged by costIsEstimate in the ledger.
    local _cache_pct="n/a"
    if [ "${tokens_in:-0}" -gt 0 ]; then
        _cache_pct="$(awk -v c="${cache_read:-0}" -v t="${tokens_in:-0}" 'BEGIN{printf "%.1f", (100*c)/t}')%"
    fi
    log "  Cost[$story_id] model=${resolved_model:-unknown} in=${tokens_in} (cached ${cache_read:-0} = ${_cache_pct}) out=${tokens_out} cost=\$${cost_usd}[full-rate est] elapsed=${elapsed_minutes}min status=${status}"

    # Emit cost_snapshot event so agent-activity dashboard shows tokens/cost/model per story
    jq -cn \
        --arg ts "$(date -Iseconds)" \
        --arg agent "${agent_id:-orchestrator}" \
        --arg story "$story_id" \
        --arg phase "$phase_id" \
        --arg model "${resolved_model:-}" \
        --arg provider "${STORY_PROVIDER:-}" \
        --argjson cost "${cost_usd:-0}" \
        --argjson tin "${tokens_in:-0}" \
        --argjson tout "${tokens_out:-0}" \
        --argjson turns "${task_turns:-1}" \
        '{
          event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
          timestamp: $ts,
          agent: $agent,
          story_id: (if $story == "" then null else $story end),
          phase: (if $phase == "" then null else $phase end),
          type: "cost_snapshot",
          model: (if $model == "" then null else $model end),
          provider: (if $provider == "" then null else $provider end),
          detail: {
            costUsd: $cost,
            tokensIn: $tin,
            tokensOut: $tout,
            turns: $turns,
            source: "append_cost_record"
          }
        }' >> "${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" 2>/dev/null || true

    # GAP-P17: emit StoryArtifact record to story-artifacts.jsonl
    emit_story_artifact "$story_id" "$status" "$phase_id" "$elapsed_minutes" "$cost_usd" "$task_turns" "$json_result_file"
}

# GAP-P17 — Emit a StoryArtifact record to logs/story-artifacts.jsonl.
# When the story has an outputSchema field in the PRD, the agent result text
# is validated against it and the parsed object is included in the artifact.
emit_story_artifact() {
    local story_id=$1 status=$2 phase_id=$3 elapsed_minutes=$4 cost_usd=$5 task_turns=$6 json_result_file=${7:-}
    local artifact_file="${LOG_DIR}/story-artifacts.jsonl"
    local lock_file="${artifact_file}.lock"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Read outputSchema if defined for this story
    local output_schema
    output_schema=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .outputSchema // empty' \
        "$prd_target" 2>/dev/null || echo "")

    # Try to parse structured output from the result file when schema is present
    local structured_output="null"
    if [ -n "$output_schema" ] && [ -n "$json_result_file" ] && [ -f "$json_result_file" ]; then
        local result_text
        result_text=$(jq -r '.result // ""' "$json_result_file" 2>/dev/null || echo "")
        # Extract first JSON object/array from result text
        local extracted
        extracted=$(echo "$result_text" | node "$SCRIPT_DIR/lib/handlers/story-artifact-extract.js" 2>/dev/null || echo "null")
        [ -n "$extracted" ] && structured_output="$extracted"
    fi

    (
        flock -w 5 200 2>/dev/null || true
        jq -cn \
            --arg sid "$story_id" \
            --arg phase "$phase_id" \
            --arg status "$status" \
            --argjson elapsed "${elapsed_minutes:-0}" \
            --argjson cost "${cost_usd:-0}" \
            --argjson turns "${task_turns:-0}" \
            --argjson schema "${output_schema:-null}" \
            --argjson structured "$structured_output" \
            '{storyId:$sid, phase:$phase, status:$status,
              elapsedMinutes:$elapsed, costUsd:$cost, turns:$turns,
              outputSchema:$schema, structuredOutput:$structured,
              timestamp:(now|todate)}' >> "$artifact_file"
    ) 200>"$lock_file"
}

# Return the next sequential KB entry ID (KB-001, KB-002, ...) by reading orchestrations/agents/KB.md
get_next_kb_id() {
    local kb_file="$AUTOMATION_DIR/agents/KB.md"
    if [ ! -f "$kb_file" ]; then
        echo "KB-001"
        return
    fi
    local last_num
    last_num=$(grep -oP '(?<=^## KB-)\d+' "$kb_file" | sort -n | tail -1)
    if [ -z "$last_num" ]; then
        echo "KB-001"
    else
        printf "KB-%03d" $(( 10#${last_num} + 1 ))
    fi
}

# Return KB entries relevant to a story's agent role.
# Reads from KB-{agentProfile}.md (role-specific) and KB-shared.md.
# Returns at most 10 entries total to bound context injection size.
get_relevant_kb_entries() {
    local story_id=$1
    local kb_dir="$AUTOMATION_DIR/agents"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_profile
    agent_profile=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' "$prd_target" 2>/dev/null || echo "")
    [ -z "$agent_profile" ] && return

    # Collect last 10 lines from role-specific KB + shared KB (shared is a fallback)
    local role_kb; role_kb=$(_kb_file_for_story "$story_id" "$kb_dir")
    local shared_kb="${kb_dir}/KB-shared.md"
    local combined=""
    [ -f "$role_kb"   ] && combined="${combined}$(cat "$role_kb" 2>/dev/null)"$'\n'
    [ -f "$shared_kb" ] && combined="${combined}$(cat "$shared_kb" 2>/dev/null)"$'\n'

    # Strip blank lines and return at most 10 bullet entries
    printf '%s' "$combined" | grep -v '^[[:space:]]*$' | tail -n 10
}

# Build the KB section appended to every implementation prompt
build_kb_prompt_section() {
    local story_id=$1
    local retry_count=${2:-0}
    local next_kb_id=${3:-KB-001}

    local kb_entries
    kb_entries=$(get_relevant_kb_entries "$story_id")

    local retry_note=""
    # These are forwarded to the child process invoked below. shellcheck cannot see the consumer,
    # so it reports them unused; removing them would take the values away from the child.
    # shellcheck disable=SC2034
    [ "$retry_count" -gt 0 ] && \
        retry_note="**This is retry attempt ${retry_count}** — a previous attempt failed. You MUST write a KB entry documenting what went wrong and what you changed."

    # Inject external test failure context when available
    if [ -n "${VERIFICATION_FAILURE:-}" ]; then
        printf '%s\n' "$VERIFICATION_FAILURE"
    fi

    printf '\n## Relevant Knowledge Base Entries\n'
    if [ -n "$kb_entries" ]; then
        printf 'The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:\n\n'
        printf '%s\n' "$kb_entries"
    else
        printf 'No prior KB entries match your agent role yet.\n'
    fi

    # The anti-read protection SURVIVES the removal below. Issue 2b: M3 burned every
    # iteration reading KB.md instead of writing code. The relevant entries are injected
    # above, so there is never a reason to open the file.
    printf 'Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.\n\n'

    # KB CONTRIBUTION REMOVED (2026-08-04). The agent was told to "append one entry to
    # `orchestrations/agents/KB.md`" — a RELATIVE path — while its cwd is the CLIENT
    # codeline, so it created the engine's KB inside the customer's repository. Live
    # metrolinx 20260804T225443Z: that file entered the upexpress lane's writer-output
    # manifest as though the writer had produced it, and Step 9's bare `git add -A`
    # staged it for commit.
    #
    # Agents do not write the KB. Self-heal does, engine-side, against an absolute path.
    # WriteFileTool now refuses engine paths outright (src/config/enginePaths.ts), so this
    # instruction could only ask the agent to do something it will be blocked from doing.

    # Surface any dynamic tools the self-heal loop has written for this project.
    # These are small shell scripts synthesized by the failure analyst (target=tool)
    # to automate a mechanical step that kept getting skipped by hand (e.g. adding a
    # package to package.json before importing it). Invoke them via the bash tool.
    local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
    if [ -d "$tools_dir" ] && [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ]; then
        printf '\n## Available Dynamic Tools\n'
        printf 'This project has the following helper scripts, written by prior self-healing runs. Use them via the bash tool instead of repeating the equivalent steps by hand:\n\n'
        local _tool_file _tool_purpose_line
        for _tool_file in "$tools_dir"/*.sh; do
            [ -f "$_tool_file" ] || continue
            # Only reviewed tools are ever surfaced to an agent — same
            # explicit .reviewed marker check as
            # run_dynamic_tools_in_unlocked_window(), so an unreviewed or
            # stale script (however it got there) is never offered as if
            # trusted.
            [ -f "${_tool_file}.reviewed" ] || continue
            _tool_purpose_line=$(sed -n '2p' "$_tool_file" | sed 's/^# //')
            printf -- '- `bash %s <args>` — %s\n' "$_tool_file" "$_tool_purpose_line"
        done
    fi
}

# Update AGENTS.md with implementation record
update_agents_file() {
    local story_id=$1
    local status=$2
    local title
    title=$(get_story_title "$story_id")
    local phase
    phase=$(get_story_phase "$story_id")

    if [ ! -f "$AGENTS_FILE" ]; then
        mkdir -p "$(dirname "$AGENTS_FILE")"
        cat > "$AGENTS_FILE" << EOF
# EPAM CLI Agent Learned Patterns

This file tracks implementation history and patterns discovered during autonomous development.

---

EOF
    fi

    cat >> "$AGENTS_FILE" << EOF
## $story_id: $title
- **Date**: $(date +'%Y-%m-%d %H:%M:%S')
- **Phase**: ${phase:-unassigned}
- **Status**: $status
- **Log**: logs/claude_outputs/${story_id}_*.log

EOF
}

# Increment iteration counter
increment_iteration() {
    local current
    current=$(jq -r '.currentIteration' "$PRD_FILE")
    local next=$((current + 1))
    jq ".currentIteration = $next" "$PRD_FILE" > "$PRD_FILE.tmp" && mv "$PRD_FILE.tmp" "$PRD_FILE"
}

# Show PRD status with phase information
show_status() {
    echo ""
    echo -e "${MAGENTA}=== PRD Status ===${NC}"
    echo ""

    local total
    total=$(jq '.stories | length' "$PRD_FILE")
    local completed
    completed=$(jq '[.stories[] | select(.completed == true)] | length' "$PRD_FILE")
    local pending=$((total - completed))

    echo -e "Project: ${CYAN}$(jq -r '.project.name' "$PRD_FILE")${NC}"
    echo -e "Total Stories: $total"
    echo -e "Completed: ${GREEN}$completed${NC}"
    echo -e "Pending: ${YELLOW}$pending${NC}"
    echo ""

    # Show next recommended story
    local next
    next=$(get_next_story)
    if [ -n "$next" ]; then
        echo -e "Next recommended: ${WHITE}$next${NC} - $(get_story_title "$next")"
        local phase
        phase=$(get_story_phase "$next")
        [ -n "$phase" ] && echo -e "                 Phase: ${CYAN}$phase${NC}"
    fi
    echo ""

    echo -e "${CYAN}Stories by Phase:${NC}"

    local phases
    phases=$(get_phases)
    if [ -n "$phases" ]; then
        while IFS= read -r phase; do
            [ -z "$phase" ] && continue
            echo -e "\n  ${WHITE}$phase:${NC}"

            local stories
            stories=$(get_phase_stories "$phase")
            while IFS= read -r story_id; do
                [ -z "$story_id" ] && continue
                local title
                title=$(get_story_title "$story_id")
                local priority
                priority=$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .priority // "medium"' "$PRD_FILE")
                local priority_badge=""
                case $priority in
                    high) priority_badge=" ${RED}[H]${NC}" ;;
                    low) priority_badge=" ${BLUE}[L]${NC}" ;;
                esac

                if is_story_completed "$story_id"; then
                    echo -e "    ${GREEN}+${NC} $story_id: $title$priority_badge"
                elif are_dependencies_satisfied "$story_id"; then
                    echo -e "    ${YELLOW}o${NC} $story_id: $title$priority_badge ${CYAN}(ready)${NC}"
                else
                    local deps
                    deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                    echo -e "    ${RED}x${NC} $story_id: $title$priority_badge ${RED}(blocked: $deps)${NC}"
                fi
            done <<< "$stories"
        done <<< "$phases"
    else
        # No phases, show flat list
        jq -r '.stories[] | "\(.id): \(.title) [\(if .completed then "DONE" else "PENDING" end)]"' "$PRD_FILE" | while read line; do
            if [[ "$line" == *"[DONE]"* ]]; then
                echo -e "  ${GREEN}+${NC} $line"
            else
                echo -e "  ${YELLOW}o${NC} $line"
            fi
        done
    fi
    echo ""
}

# Dry run - show what would be implemented
dry_run() {
    local stories=("$@")
    local phase_filter=""

    echo ""
    echo -e "${MAGENTA}=== Dry Run ===${NC}"
    echo ""

    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        echo -e "${GREEN}All stories are already completed (or blocked by dependencies)!${NC}"
        return
    fi

    echo "The following stories would be implemented (in order):"
    echo ""

    local order=1
    for story_id in "${stories[@]}"; do
        if ! story_exists "$story_id"; then
            echo -e "  ${RED}x${NC} $story_id - NOT FOUND"
            continue
        fi

        local phase
        phase=$(get_story_phase "$story_id")
        local phase_info=""
        [ -n "$phase" ] && phase_info=" ${CYAN}[$phase]${NC}"

        if is_story_completed "$story_id"; then
            echo -e "  ${YELLOW}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [ALREADY COMPLETED]"
        elif ! are_dependencies_satisfied "$story_id"; then
            local deps
            deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
            echo -e "  ${RED}x${NC} $story_id - $(get_story_title "$story_id")$phase_info [BLOCKED: $deps]"
        else
            echo -e "  ${CYAN}$order.${NC} $story_id - $(get_story_title "$story_id")$phase_info"
            order=$((order + 1))
        fi
    done
    echo ""
}

# Main implementation loop
# commit_completed_story <story_id>
# Stages and commits whatever a completed story wrote, scoped to the current
# GIT_WORK_ROOT (the worktree checkout when running --worktree, the main repo
# otherwise). Best-effort: a commit failure here must not fail the story itself,
# since the retry/health-check machinery downstream still has its own commit gates.
# generate_story_contract <story_id>
# Deterministically writes .contracts/<story_id>.md by extracting exported
# interfaces/classes/methods directly from the story's own source files —
# NOT by asking the model to transcribe them. The typescript-engineer profile
# has a "CONTRACT SCRATCHPAD — MANDATORY LAST STEP" instruction telling the
# agent to hand-write this file, but that step was observed live to have near-
# 0% compliance: SKY-002 never produced .contracts/SKY-002.md across multiple
# runs, so build_implementation_prompt()'s contract injection (which only
# activates `if [ -f "$_contract_file" ]`) had nothing to inject — dependent
# stories (SKY-003/SKY-004) guessed import paths and mock shapes from scratch,
# reproducing exactly the bug class contract injection was built to prevent.
# A regex-based extractor is not as complete as a real TS parser, but it is
# ALWAYS produced (no model compliance required) and always matches the
# actual source, so it can never be wrong the way an LLM transcription could.
#
# Fully generic (2026-07-05): all regex patterns and mock-rendering templates
# are read from <project_root>/.epam/contract-generation.json — this function
# has no TypeScript/Vitest-specific knowledge. Each project's tier script
# supplies its own manifest (see tier3-travel-app-run.sh for the current
# skyscanner-app one); a Python/pytest or Go project would supply a manifest
# with different regexes and mock templates, and this function would not
# change. No manifest present = no-op (opt-in feature, same pattern as
# run_dependency_check()'s .epam/dependency-check.json).
# _generate_contract_from_files <project_root> <contract_file> <files_json> <id_label> <config_file>
# Shared extraction core behind generate_story_contract() (a story's own files) and
# _generate_vendor_contract() (a vendored third-party package's files) — same
# config-driven interfacePattern/classPattern/sourceExtensions, same output
# format, one parser instead of two copies that could drift. files_json entries
# may be relative to project_root OR already absolute — os.path.join() returns
# an absolute second argument unchanged, so both callers work unmodified.
_generate_contract_from_files() {
    local project_root="$1" contract_file="$2" files_json="$3" id_label="$4" config_file="$5"
    python3 "$SCRIPT_DIR/lib/handlers/contract-from-files.py" "$project_root" "$contract_file" "$files_json" "$id_label" "$config_file"
}

generate_story_contract() {
    local story_id="$1"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _commit_root="${GIT_WORK_ROOT:-$PROJECT_ROOT}"
    local config_file="${_commit_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local files_json
    files_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
        "$prd_target" 2>/dev/null || echo "[]")
    [ "$files_json" = "[]" ] && return 0

    # technicalNotes.files stores ABSOLUTE paths rooted at MAIN_PROJECT_ROOT (the
    # non-worktree checkout) — same rewrite already applied to ACs/technicalNotes/
    # description elsewhere in this file (see the WORKTREE_MODE substitution near
    # line 960). Without this, resolving files against $_commit_root (the worktree)
    # silently misses every file (they don't exist under the main root yet — the
    # story hasn't merged), so no interfaces/classes are ever found and no contract
    # is written, with no visible error. Confirmed live: run #15's .contracts/
    # directory existed but was empty after SKY-002 completed.
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        files_json="${files_json//${MAIN_PROJECT_ROOT}/${_commit_root}}"
    fi

    local contracts_dir="${_commit_root}/.contracts"
    mkdir -p "$contracts_dir" 2>/dev/null
    local contract_file="${contracts_dir}/${story_id}.md"

    _generate_contract_from_files "$_commit_root" "$contract_file" "$files_json" "$story_id" "$config_file"
}


run_implementation() {
    local stories=("$@")
    local implemented=0
    local failed=0
    local skipped=0

    # If no specific stories provided, get prioritized list
    if [ ${#stories[@]} -eq 0 ]; then
        mapfile -t stories < <(get_prioritized_stories)
    fi

    if [ ${#stories[@]} -eq 0 ]; then
        success "All stories are already completed (or blocked by dependencies)!"
        return 0
    fi

    log "======================================"
    log "EPAM CLI Orchestration Loop Starting"
    log "Stories to implement: ${stories[*]}"
    log "======================================"

    echo ""
    get_project_context
    echo ""

    for story_id in "${stories[@]}"; do
        log "--------------------------------------"

        # Validate story exists
        if ! story_exists "$story_id"; then
            error "Story $story_id not found in PRD"
            failed=$((failed + 1))
            continue
        fi

        # Skip if already completed
        if is_story_completed "$story_id"; then
            warning "Story $story_id is already completed, skipping"
            skipped=$((skipped + 1))
            continue
        fi

        # Same live-status re-check the main lane's Step 1 loop already does
        # (run-agent-orchestration.sh) — a worktree-lane story can be
        # deprecated by a mid-execution split rejection, or blocked by the
        # inline TC writer gate below, after this loop's own story list was
        # built. Parity required: "all lanes must have the same flow no
        # deviations."
        local _wt_story_status
        _wt_story_status=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .status // "pending"' \
            "$PRD_FILE" 2>/dev/null || echo "pending")
        if [ "$_wt_story_status" = "deprecated" ]; then
            info "Skipping $story_id — deprecated after being enqueued (mid-execution split rejected this story)"
            skipped=$((skipped + 1))
            continue
        fi
        if [ "$_wt_story_status" = "blocked" ]; then
            info "Skipping $story_id — blocked (no valid testCriteria after 3 attempts, see blocked-stories.jsonl)"
            skipped=$((skipped + 1))
            continue
        fi

        # Check dependencies using check-dependencies.sh if available
        local dep_checker="$SCRIPT_DIR/check-dependencies.sh"
        if [ -x "$dep_checker" ]; then
            # Use dedicated dependency checker for better validation and output
            if ! PRD_FILE="$PRD_FILE" "$dep_checker" "$story_id" 2>&1; then
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        else
            # Fallback to inline dependency check
            if ! are_dependencies_satisfied "$story_id"; then
                local deps
                deps=$(get_story_dependencies "$story_id" | tr '\n' ',' | sed 's/,$//')
                warning "Story $story_id blocked by dependencies: $deps - skipping"
                log_to_monitor "dependency_blocked" "$story_id" "Blocked by dependencies: $deps"
                skipped=$((skipped + 1))
                continue
            fi
        fi

        # Inline TC writer gate — same shared check the main lane runs
        # (lib/tc-writer-gate.sh), now also applied to worktree lanes (this
        # was the gap: worktree-lane pure-test stories used to run their
        # entire first execution with testCriteria.facts=[] since the only
        # other TC mechanism, the batch Step 1.6 gate, runs after Step 3.2 —
        # i.e. after this loop has already finished).
        local _wt_tc_phase
        _wt_tc_phase="${phase_filter:-$(get_story_phase "$story_id")}"
        if ! run_inline_tc_writer_gate "$story_id" "$_wt_tc_phase"; then
            skipped=$((skipped + 1))
            continue
        fi

        # Remaining per-story guards the main lane's Step 1 loop already runs
        # (run-agent-orchestration.sh), now shared via lib/story-guards.sh so
        # worktree lanes get the identical cost-budget circuit breaker,
        # pause/resume support, and operator redirects a main-lane story
        # already has. PHASE is set as a plain global (not `local`) because
        # these guards read $PHASE directly — same convention
        # run-agent-orchestration.sh itself already uses.
        PHASE="$_wt_tc_phase"
        check_cost_budget
        wait_if_paused
        apply_redirect_if_any "$story_id"

        # Implement the story
        if implement_story "$story_id"; then
            update_story_status "$story_id" "completed"
            implemented=$((implemented + 1))
            # Deterministically regenerate the dependency contract from the actual
            # source this story just wrote — before committing, so the contract file
            # itself is included in the same commit and visible to dependent stories.
            # Diagnostic timestamps (added 2026-07-06): a live run's watchdog killed
            # a story's claude.sh subprocess after 600s even though the story itself
            # had already succeeded in 15s — neither generate_story_contract() nor
            # commit_completed_story() logged anything before/after, so it was
            # impossible to tell which one (if either) actually hung. These log
            # lines make the next occurrence immediately diagnosable instead of
            # another blind guess.
            log "  [post-story] Generating dependency contract for $story_id..."
            generate_story_contract "$story_id"
            log "  [post-story] Contract generation complete for $story_id"
            # Commit this story's work immediately. Stories in the same worktree run
            # sequentially (chained by dependency), and if a LATER story in this loop
            # exhausts its retries and fails, the whole worktree process returns non-zero
            # — which makes the orchestrator skip Step 3.1/3.2 (auto-commit + merge)
            # entirely and force-remove the worktree, permanently destroying every
            # earlier story's uncommitted work. Committing per-story means that work
            # survives on the wt-* branch (worktree removal deletes the checkout, not
            # the branch/commits) even when a downstream story in the chain fails.
            log "  [post-story] Committing completed work for $story_id..."
            # `|| true` (found live, 2026-07-14, same incident as the two
            # set -e fixes inside commit_completed_story() itself): this
            # whole script runs under `set -e`. commit_completed_story()
            # legitimately returns 1 on a git-add failure or a secret-scan
            # rejection (both already logged via `warning` before it
            # returns) — a bare, unguarded call to a function that returns
            # non-zero is ITSELF a set -e trigger at the call site, so even
            # after fixing the function's own internals to fail gracefully,
            # this call would still have silently killed the whole worktree
            # lane (every remaining story in it) over one story's commit
            # being correctly skipped. The failure is already fully logged
            # inside the function; there is nothing more to do here.
            # THE GUARD STAYS, THE OUTCOME IS ACTED ON.
            #
            # `|| true` is correct: this script runs under `set -e`, and a bare failure here
            # would kill the whole lane over one story's commit. But the return code used to be
            # DISCARDED, and that is a different thing. Live 2026-08-09 the credential scan
            # unstaged a story's work, `git add` then failed, and the run reported
            # "Implemented: 1, Failed: 0" with 43 lines sitting uncommitted in the working
            # tree — every downstream reader told the story was delivered.
            local _commit_rc=0
            commit_completed_story "$story_id" || _commit_rc=$?
            log "  [post-story] Commit step complete for $story_id"
            if [ "$_commit_rc" -ne 0 ]; then
                error "  [post-story] $story_id: work is UNCOMMITTED (commit step exit ${_commit_rc}) — the story is not delivered; demoting from implemented"
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            elif ! _committed_change_uses_helpers "$story_id"; then
                # THE ARTIFACT IS JUDGED, NOT THE TREE IT CAME FROM.
                #
                # The write-time guard rejects an attempt while it is still running, against
                # the working tree. This asks the only question that survives the attempt:
                # does what SHIPPED use every helper the spec verified? On 2026-08-15 a story
                # committed 1 of 4 and was reported complete — tsc green, tests green, because
                # the tests assert the SDK was configured, never that content re-renders.
                error "  [post-story] $story_id: committed work is incomplete against the plan — demoting from implemented"
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            fi

            # Same post-story guards the main lane's Step 1 loop runs after a
            # successful story (run-agent-orchestration.sh) — parity per
            # "all lanes must have the same flow no deviations": TypeScript
            # compile gate, actualCost written back to prd.json (falls back
            # to phase-cost.jsonl since there's no per-story log file to grep
            # in-process — see record_story_actual_cost's docstring), and
            # mid-execution split validation before the NEXT story in this
            # lane runs.
            if ! story_tsc_gate "$story_id"; then
                update_story_status "$story_id" "failed"
                failed=$((failed + 1))
                implemented=$((implemented - 1))
            fi
            record_story_actual_cost "$story_id"
            validate_mid_execution_splits "$PHASE"
        else
            update_story_status "$story_id" "failed"
            failed=$((failed + 1))
        fi

        increment_iteration
    done

    log "======================================"
    log "EPAM CLI Orchestration Loop Complete"
    log "Implemented: $implemented, Failed: $failed, Skipped: $skipped"
    log "======================================"

    if [ $failed -gt 0 ]; then
        return 1
    fi
    return 0
}


# Print usage
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [STORY_IDS...]

EPAM CLI Orchestration script for implementing PRD stories.

Options:
  --status              Show current PRD status with phase information
  --list-phases         Show all implementation phases and their stories
  --phase NAME          Implement all incomplete stories in a specific phase
  --worktree NAME       Run in worktree mode (primary|independent)
  --setup-worktrees     Create git worktrees for parallel execution
  --cleanup-worktrees   Remove git worktrees
  --dry-run             Show what would be implemented without running
  --interactive         Run with permission prompts (safer, requires approval)
  --help                Show this help message

Arguments:
  STORY_IDS       Specific story IDs to implement (e.g., US-001 US-002)
                  If not provided, implements stories in priority order

Story Prioritization:
  Stories are implemented based on:
  1. Phase order (from implementationOrder in prd.json)
  2. Dependency satisfaction (blocked stories are skipped)
  3. Priority field (high > medium > low)

Environment Variables:
  CLAUDE_CMD      Path to Claude CLI (default: claude)

Permissions:
  By default, the script runs with --dangerously-bypass-approvals-and-sandbox to allow
  autonomous file read/write operations. Use --interactive if you want to
  manually approve each operation.

Examples:
  $(basename "$0")                      # Implement next stories (priority order)
  $(basename "$0") --phase phase1       # Implement phase1 stories only
  $(basename "$0") --list-phases        # Show all phases and progress
  $(basename "$0") US-001 US-002        # Implement specific stories
  $(basename "$0") --dry-run            # Preview implementation order
  $(basename "$0") --status             # Show PRD status
  $(basename "$0") --interactive        # Run with manual approval prompts

EOF
}

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

run_pre_phase_assessment() {
    local phase_id=$1
    local profiles_file="$AGENT_PROFILES_FILE"
    # A SNAPSHOT OF NOW, NOT THE PRE-RUN CANONICAL FILE.
    #
    # This pointed at profiles.json.original — which pre-run-reset.sh and orchestrate.sh use as the
    # canonical BASE state for a whole run. Restoring it after a corrupted assessment threw away
    # every skill note, augmentation and mint result the run had accumulated up to that point, not
    # just the corruption, while reporting only "restoring backup".
    local profiles_backup="${LOG_DIR:-/tmp}/profiles-preassessment-${phase_id}.json"
    cp "$profiles_file" "$profiles_backup" 2>/dev/null || profiles_backup=""
    local profiles_audit="$LOG_DIR/profiles-audit.jsonl"
    local assessment_log="$LOG_DIR/pre-assessment-${phase_id}.log"

    touch "$profiles_audit"

    if [ ! -f "$profiles_backup" ]; then
        cp "$profiles_file" "$profiles_backup"
        info "Backed up original profiles to $profiles_backup"
    fi

    info "Running pre-phase skill assessment for '$phase_id'..."

    local prd_rel
    prd_rel=$(realpath --relative-to="$PROJECT_ROOT" "$PRD_FILE" 2>/dev/null || echo "orchestrations/prd.json")

    local assessment_prompt
    _ap_vals=$(mktemp "${TMPDIR:-/tmp}/skill-assessment-prephase-vals-XXXXXX.json")
    # WHAT THIS PROJECT ACTUALLY IS — the template's own words. lib/handlers/agent-skills.js
    # derives it from the codeline's ecosystem and the KB the pipeline wrote while working on it
    # ("DERIVED, NEVER TYPED"). It existed with NO CALLERS, so this placeholder was never supplied
    # and the render threw. Absent is absent: an unresolvable project reports that, never a guess.
    local _ap_skills_file; _ap_skills_file=$(mktemp "${TMPDIR:-/tmp}/project-skills-XXXXXX.json")
    "${NODE_CMD:-node}" "$SCRIPT_DIR/lib/handlers/agent-skills.js" "${PROJECT_ROOT:-}" \
        "$AUTOMATION_DIR/agents" > "$_ap_skills_file" 2>/dev/null \
        || printf '%s' '(this project could not be resolved — do not infer skills from role names)' > "$_ap_skills_file"
    jq_vals \
          --arg phase_id "$phase_id" \
          --arg prd_rel "$prd_rel" \
          --rawfile project_skills "$_ap_skills_file" \
          '{"__PHASE_ID__":$phase_id,"__PRD_REL__":$prd_rel,"__PROJECT_SKILLS__":$project_skills}' > "$_ap_vals"
    rm -f "$_ap_skills_file"
    # The codeline's own facts — this template declares them and nothing supplied them.
    # Stack facts are the RENDERER's job — engine-prompt.js adds exactly the stack
    # placeholders this template DECLARES. Pre-merging all seven here made the
    # renderer throw "was given values it does not use" on every template that
    # declares fewer, and the caller reported "cannot render its prompt". Four
    # seams could not run at all, the fuzz-weaver among them.
    assessment_prompt="$(render_engine_prompt skill-assessment-prephase "$_ap_vals" with_prd_structure)"
    rm -f "$_ap_vals"

    cd "$PROJECT_ROOT"
    local _orch_provider="${EPAM_ORCHESTRATION_PROVIDER:-}"
    local _orch_model
    _orch_model="$(seam_model_or_fail "phase-assessment" 2>/dev/null || true)"
    if [ -z "$_orch_provider" ]; then
        warning "Pre-phase assessment: EPAM_ORCHESTRATION_PROVIDER not set — skipping (non-critical)"
    # AI_GATE_ALLOW_TOOLS=1: the prompt above instructs the agent to run real
    # jq commands against the PRD and read/write orchestrations/agents/profiles.json
    # directly — without this, ai-run.sh's epam-umbrella branch defaults to
    # --no-tools, so the agent can't actually run jq or touch any file; it can
    # only print a JSON description of what it WOULD do, and no real profile
    # augmentation or role-fix ever happens (found live 2026-07-08 — a run's
    # assessment step logged a fabricated "content" diff for profiles.json that
    # was never actually written to disk).
    # SAME DEFECT AS THE TC WRITER: `elif CMD | tee ...; then` tested tee, so "Pre-phase
    # assessment completed" was printed whether the agent ran, failed or timed out — and the
    # profiles.json validity check below only runs on that branch, so a failed agent skipped it.
    # THREE pipeline elements here (echo, ai-run, tee), so the agent's status is PIPESTATUS[1].
    elif { echo "$assessment_prompt" | \
            AI_GATE_ALLOW_TOOLS=1 \
            AI_PROVIDER="$_orch_provider" \
            AI_MODEL="$_orch_model" \
            EPAM_CLI="$EPAM_CLI" \
            bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \
            ${_orch_model:+--model "$_orch_model"} \
            2>&1 | tee "$assessment_log"; [ "${PIPESTATUS[1]}" -eq 0 ]; }; then
        success "Pre-phase assessment completed for '$phase_id'"
        if ! jq empty "$profiles_file" 2>/dev/null; then
            # A SNAPSHOT THAT FAILED IS NOT A SNAPSHOT — the same guard Steps 11 and 12 needed.
            # If the pre-call copy did not happen there is nothing to restore, and overwriting a
            # corrupted profiles.json with nothing is worse than leaving it for a human.
            if [ -n "$profiles_backup" ] && [ -s "$profiles_backup" ]; then
                warning "Pre-phase assessment may have corrupted profiles.json! Restoring the pre-assessment snapshot."
                cp "$profiles_backup" "$profiles_file"
            else
                error "Pre-phase assessment may have corrupted profiles.json AND no pre-assessment snapshot exists — leaving the file as-is. Restore it before the next phase."
            fi
        fi
    else
        warning "Pre-phase assessment failed for '$phase_id' (non-critical, continuing)"
    fi
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
