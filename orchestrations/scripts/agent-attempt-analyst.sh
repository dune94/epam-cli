#!/usr/bin/env bash
# agent-attempt-analyst.sh <failure_class> <failed_output_file> [context_file]
#
# Reusable AGENT-EXECUTION failure analyst — the self-heal for agents that fail by
# producing NO usable output (max-iterations, no-file, no-json, malformed). This is the
# greenfield-safe SIBLING of claude.sh's run_failure_analyst (which handles CODE/TEST
# failures and is left untouched). It shares the crown-jewel discipline: the failure-analyst
# profile, the escalation model, and GROUND-TRUTH context (the real task the agent was given),
# so it diagnoses WHY the agent failed and prescribes a SHORT corrective directive for the
# NEXT attempt — instead of a canned string.
#
# Used by: brownfield-repro-test-writer.sh (now), the code-graph-detective (next).
#
# It does NOT diagnose provider/infra failures (no agent-behaviour to correct) — for those it
# emits nothing and the caller just retries/ladders.
#
# Output: the corrective directive on stdout (empty string = nothing to add, just retry).
# Exit: always 0 (best-effort; never blocks the caller).
set -uo pipefail

FAILURE_CLASS="${1:-}"
FAILED_OUTPUT_FILE="${2:-/dev/null}"
CONTEXT_FILE="${3:-/dev/null}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"

log() { echo "[agent-attempt-analyst] $*" >&2; }

# Provider/infra failures carry no agent behaviour to correct — skip (caller just retries).
case "$FAILURE_CLASS" in
    provider|infra|timeout) exit 0 ;;
esac

_provider="${AGENT_ANALYST_PROVIDER:-${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-qwen}}}"
# Same escalation model the impl failure-analyst uses (never a plain chat model).
_model="${AGENT_ANALYST_MODEL:-${ESCALATION_MODEL:-${ORCH_GATE_MODEL:-z-ai/glm-5.2}}}"

# Reuse the failure-analyst profile (the crown-jewel role instructions) when present.
_profile=""
_profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
[ -f "$_profiles_file" ] && _profile=$(jq -r '."failure-analyst" // ""' "$_profiles_file" 2>/dev/null || echo "")
[ -z "$_profile" ] && _profile="You are a self-healing pipeline analyst. Diagnose the exact reason an agent failed and prescribe the minimum corrective directive so its NEXT attempt succeeds."

_failed_output=$(head -c 4000 "$FAILED_OUTPUT_FILE" 2>/dev/null || echo "")
_context=$(head -c 6000 "$CONTEXT_FILE" 2>/dev/null || echo "")

# Class-specific framing so the analyst targets the right behaviour.
_class_hint=""
case "$FAILURE_CLASS" in
    max_iterations) _class_hint="The agent EXHAUSTED its iteration budget exploring and NEVER produced its output. The corrective directive must make it commit output EARLY — e.g. 'you have N calls; do the minimum lookup then WRITE your file/answer as your very next action; do NOT keep exploring.'" ;;
    no_file)        _class_hint="The agent finished WITHOUT writing the required file. The directive must make writing the file its FIRST action, at the exact required path." ;;
    no_json|malformed) _class_hint="The agent produced no parseable structured output (prose, or a tool-call wrapper). The directive must make it emit ONLY the required output inline, no tool calls, no prose." ;;
    *)              _class_hint="The agent failed to produce usable output." ;;
esac

read -r -d '' _prompt <<PROMPT || true
${_profile}

An AI agent failed its task and must retry. Diagnose the SPECIFIC reason it failed from its output below, then prescribe a SHORT, CONCRETE corrective directive (1-3 sentences) to prepend to its next attempt so it SUCCEEDS this time. ${_class_hint}

Ground the directive in what the agent ACTUALLY did (below) and the REAL task — do not give generic advice. Output ONLY the corrective directive text, nothing else.

=== FAILURE CLASS ===
${FAILURE_CLASS}

=== WHAT THE AGENT PRODUCED (its output/log) ===
${_failed_output:-(empty — it produced nothing)}

=== THE TASK IT WAS GIVEN (ground truth) ===
${_context:-(not provided)}
PROMPT

# Activity emit — the failure-agent is a first-class agent and MUST be visible in
# agent-activity.html like every other agent (2026-07-24). storyId comes from the caller.
_fa_sid="${AGENT_ANALYST_STORY_ID:-}"
_emit_fa() { bash "$SCRIPT_DIR/update-monitor.sh" event "$1" "$2" "$_fa_sid" "main" "failure-analyst" 2>/dev/null || true; }
_emit_fa "self_heal_start" "failure-analyst diagnosing ${FAILURE_CLASS}${_fa_sid:+ for ${_fa_sid}}"

log "diagnosing ${FAILURE_CLASS} via ${_model}"
_note=$(echo "$_prompt" | \
    EPAM_MAX_ITERATIONS=1 \
    EPAM_REASONING_EFFORT="${AGENT_ANALYST_REASONING_EFFORT:-high}" \
    AI_MODEL="$_model" \
    bash "$AI_RUNNER_CMD" --provider "$_provider" --model "$_model" 2>/dev/null || echo "")

# Trim to a bounded directive; never emit a huge blob.
_emit_fa "self_heal_complete" "failure-analyst prescribed corrective directive (${FAILURE_CLASS})"
printf '%s' "$(printf '%s' "$_note" | head -c 800)"
exit 0
