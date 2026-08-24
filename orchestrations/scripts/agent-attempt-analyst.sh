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
#
# Exit contract (B30, 2026-07-25) — deliberately three-valued, because "produced
# no corrective" is a LEGITIMATE outcome for provider/infra/timeout and must stay
# distinguishable from a BROKEN analyst:
#   0 + output    -> corrective prescribed
#   0 + no output -> deliberate skip (provider/infra/timeout: no behaviour to fix)
#   2             -> the analyst itself failed; the caller must RECORD that the
#                    next attempt is running with no corrective guidance
#
# This is still best-effort and still must not block the caller. Previously it
# was `exit 0` unconditionally, swallowed its runner's stderr, and emitted
# self_heal_complete before checking anything had been produced — so a dead
# analyst was indistinguishable from a working one in both logs and dashboard,
# and every retry silently re-ran the identical prompt. Not blocking the caller
# is not the same as not telling anyone.
set -uo pipefail

FAILURE_CLASS="${1:-}"
FAILED_OUTPUT_FILE="${2:-/dev/null}"
CONTEXT_FILE="${3:-/dev/null}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# jq_vals — prompt values files whose content never becomes an argv entry.
# Placed with the other library sources, NOT beside SCRIPT_DIR: the path-resolution
# block is lifted verbatim by tests that build a minimal script tree, and a source
# line inside it makes those probes fail on a library they have no reason to carry.
source "$SCRIPT_DIR/lib/jq-vals.sh"

# THIS SEAM ASKS FOR ITS LADDER.
#
# Until 2026-08-12 only team-lead-review.sh called this, so sixteen of seventeen seams kept
# whatever fixed model their script hardcoded while the registry looked authoritative. The
# EVERY ENTRY POINT READS THE LADDER DECLARATION ITSELF.
#
# lib/model-ladders.sh exists so that "what a tier contains" is declared once and read the same
# way everywhere. Only claude.sh, run-agent-orchestration.sh and detective-rerun.sh ever called
# it, so this script resolved its model ONLY from environment its parent happened to export. Run
# standalone — a replay, a retest, a test harness — nothing set EPAM_MODEL_LADDER_<TIER>,
# seam_ladder_export set no EPAM_MODEL, and this seam skipped its work while exiting 0.
#
# export_model_ladders leaves an already-set value alone, so calling it here changes nothing when
# the orchestrator has already exported the chain, and supplies it when nobody has.
_ml_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/model-ladders.sh"
if [ -f "$_ml_lib" ]; then
    # shellcheck source=lib/model-ladders.sh
    . "$_ml_lib" || true
    command -v export_model_ladders >/dev/null 2>&1 \
        && export_model_ladders "${EPAM_LLM_SETTINGS_FILE:-${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json}" || true
fi
# ask must come BEFORE any model is resolved below: seam_ladder_export sets EPAM_MODEL, and
# a later assignment that wins makes the whole thing decorative.
#
# Guarded: these run mid-pipeline, and a packaging error must degrade to the previous fixed
# model rather than kill a run.
# shellcheck source=lib/seam-ladder.sh
. "$SCRIPT_DIR/lib/seam-ladder.sh" 2>/dev/null || true
# WHICH AGENT THIS IS — declared ONCE, and exported so ai-run.sh keys this agent's ladder rung
# state to it. Without it every agent shared one counter ("agent__<story>"): one agent escalating
# advanced the ladder for all of them, and team-lead-review's cross-process resume read a key
# nothing ever wrote.
_SEAM_NAME="agent-failure-analyst"
export EPAM_AGENT_NAME="$_SEAM_NAME"
command -v seam_ladder_export >/dev/null 2>&1 && seam_ladder_export "$_SEAM_NAME"

AI_RUNNER_CMD="${AI_RUNNER_CMD:-$SCRIPT_DIR/ai-run.sh}"
# shellcheck source=lib/agent-invoke.sh
source "$SCRIPT_DIR/lib/agent-invoke.sh"

log() { echo "[agent-attempt-analyst] $*" >&2; }

# Provider/infra failures carry no agent behaviour to correct — skip (caller just retries).
case "$FAILURE_CLASS" in
    provider|infra|timeout) exit 0 ;;
esac

# THE SEAM DECIDES. seam_ladder_export (above) sets EPAM_MODEL to the first rung of the chain this
# seam's ARCHETYPE declares, which is the whole point of declaring a ladder. The literal that stood
# last in this chain overrode that silently: the seam asked for its tier and the answer was
# discarded, so editing the declaration moved no model. Operator overrides still win; what is gone
# is the hardcoded final fallback, which no configuration could remove.
# HEAL ON THE RUNG THAT FAILED — the whole rung, not its model.
#
# Operator, 2026-08-22: "if analyst is used in a retry the self-heal ladder rung must be
# inherited by the analyst."
#
# Diagnosing a stronger rung's attempt from a weaker one is guesswork about reasoning the
# analyst cannot reproduce, and the diagnosis reads as authoritative anyway. Model alone is not
# enough: claude.sh's ladder moves provider, reasoning effort and temperature with it, so an
# analyst on the right model at the wrong effort is still analysing a setup that never ran.
#
# The rung is persisted by the writer on every attempt (lib/story-outputs.sh). No guard and no
# fallback: for a story that has been attempted it EXISTS, and defending against its absence
# would restore the silent seam-default diagnosis this replaces. An operator override still
# wins — a deliberate cross-rung diagnosis stays possible.
# shellcheck source=lib/story-outputs.sh
. "$SCRIPT_DIR/lib/story-outputs.sh"
_rung_model=$(story_rung_get "${LOG_DIR:-}" "${AGENT_ANALYST_STORY_ID:-}" model)
_rung_provider=$(story_rung_get "${LOG_DIR:-}" "${AGENT_ANALYST_STORY_ID:-}" provider)
_rung_effort=$(story_rung_get "${LOG_DIR:-}" "${AGENT_ANALYST_STORY_ID:-}" reasoningEffort)
_rung_temperature=$(story_rung_get "${LOG_DIR:-}" "${AGENT_ANALYST_STORY_ID:-}" temperature)
if [ -n "$_rung_model" ]; then
    export EPAM_REASONING_EFFORT="$_rung_effort"
    export EPAM_TEMPERATURE="$_rung_temperature"
    warning "analyst inherits the failing rung: model=$_rung_model provider=$_rung_provider effort=${_rung_effort:-unset} temp=${_rung_temperature:-unset}"
fi
_model="${AGENT_ANALYST_MODEL:-${_rung_model:-${ESCALATION_MODEL:-${ORCH_GATE_MODEL:-${EPAM_MODEL:-}}}}}"
_provider="${AGENT_ANALYST_PROVIDER:-${_rung_provider:-${ORCH_GATE_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}}}"
if [ -z "$_model" ]; then
    # A diagnosis produced by a guessed model is worse than an honest absence: it reads as
    # authoritative and nothing downstream can tell it was never grounded in a declared tier.
    warning "no model resolved for this seam — its archetype declares no ladder, or the tier's chain is unset. Not analysing rather than guessing a model."
    exit 0
fi

# Reuse the failure-analyst profile (the crown-jewel role instructions) when present.
_profile=""
_profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
[ -f "$_profiles_file" ] && _profile=$(jq -r '."failure-analyst" // ""' "$_profiles_file" 2>/dev/null || echo "")
# THE PROMPT, AND THE FIVE CLASS HINTS, FROM THE TEMPLATE LAYER.
#
# All of it used to sit here: the fallback role line, a five-arm case statement whose every arm
# was a sentence addressed to the analyst, and the prompt heredoc. The engine still chooses
# WHICH hint by failure class -- that is a decision, not wording -- but it no longer holds the
# wording of any of them.
. "$SCRIPT_DIR/lib/render-engine-prompt.sh"

_tpl="$(dirname "$SCRIPT_DIR")/prompts/templates/agent-failure-analyst.json"
_body() { "${NODE_BIN:-node}" -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String((d.bodies || {})[process.argv[2]] || ""));
' "$_tpl" "$1"; }

[ -z "$_profile" ] && _profile="$(_body role_fallback)"

_failed_output=$(cat "$FAILED_OUTPUT_FILE" 2>/dev/null || echo "")
_context=$(cat "$CONTEXT_FILE" 2>/dev/null || echo "")

# Class-specific framing so the analyst targets the right behaviour.
case "$FAILURE_CLASS" in
    max_iterations)    _class_hint="$(_body hint_max_iterations)" ;;
    no_file)           _class_hint="$(_body hint_no_file)" ;;
    no_json|malformed) _class_hint="$(_body hint_no_json)" ;;
    invalid_test)      _class_hint="$(_body hint_invalid_test)" ;;
    *)                 _class_hint="$(_body hint_default)" ;;
esac

# Values via a FILE, never argv: a failed agent's output is routinely megabytes and argv is
# capped at ARG_MAX. This is the same crash that took out the failure analyst on 2026-08-15.
_aa_vals=$(mktemp "${TMPDIR:-/tmp}/agent-failure-analyst-vals-XXXXXX.json")
jq_vals --arg profile "$_profile" \
      --arg class_hint "$_class_hint" \
      --arg failure_class "$FAILURE_CLASS" \
      --arg failed_output "${_failed_output:-(empty — it produced nothing)}" \
      --arg context "${_context:-(not provided)}" \
      '{"__PROFILE__":$profile,"__CLASS_HINT__":$class_hint,"__FAILURE_CLASS__":$failure_class,"__FAILED_OUTPUT__":$failed_output,"__CONTEXT__":$context}' \
      > "$_aa_vals"
if ! _prompt=$(render_engine_prompt agent-failure-analyst "$_aa_vals" prompt); then
    rm -f "$_aa_vals"
    warning "cannot render the analyst prompt — not analysing rather than asking with no instructions"
    exit 0
fi
rm -f "$_aa_vals"

# Activity emit — the failure-agent is a first-class agent and MUST be visible in
# agent-activity.html like every other agent (2026-07-24). storyId comes from the caller.
_fa_sid="${AGENT_ANALYST_STORY_ID:-}"
_emit_fa() { bash "$SCRIPT_DIR/update-monitor.sh" event "$1" "$2" "$_fa_sid" "main" "failure-analyst" 2>/dev/null || true; }
_emit_fa "self_heal_start" "failure-analyst diagnosing ${FAILURE_CLASS}${_fa_sid:+ for ${_fa_sid}}"

log "diagnosing ${FAILURE_CLASS} via ${_model}"
# Keep the runner's stderr: it is the only evidence of WHY self-heal failed, and
# both call sites used to discard it along with everything else.
_analyst_err="$(mktemp 2>/dev/null || echo /tmp/agent-analyst-err.$$)"
# THROUGH THE ONE DOOR -- AND THE ANALYST CAN FINALLY LOOK AT SOMETHING.
#
# This granted NO TOOLS. Not a restricted set: none. EPAM_ALLOWED_TOOLS was never set and the tool
# gate was never opened, so the agent asked to work out WHY an attempt failed could not read the
# file that failed, search for the symbol, or run the check that reported it. It diagnosed from a
# description of the evidence.
#
# Its profile has declared "toolGrant": "execute" the whole time. Nothing read it, because nothing
# went through lib/agent-invoke.sh -- so the declaration and the invocation disagreed and the
# invocation won silently.
#
# The budget was the same story one field over: three ${VAR:-default} literals duplicating a
# profile that already states them.
_note=$(echo "$_prompt" | invoke_agent agent-failure-analyst \
    --model "$_model" --provider "$_provider" \
    --codeline "${PROJECT_ROOT:-}" \
    2>"$_analyst_err")
_analyst_rc=$?

# Trim to a bounded directive; never emit a huge blob.
_trimmed="$(printf '%s' "$_note" | head -c 800)"

if [ "$_analyst_rc" -ne 0 ] || [ -z "${_trimmed//[[:space:]]/}" ]; then
    log "FAILED — no corrective produced for ${FAILURE_CLASS} (exit=${_analyst_rc}, model=${_model})"
    [ -s "$_analyst_err" ] && log "  runner stderr: $(head -c 400 "$_analyst_err" | tr '\n' ' ')"
    log "  the next attempt will retry WITHOUT corrective guidance"
    _emit_fa "self_heal_failed" "failure-analyst FAILED (${FAILURE_CLASS}, exit=${_analyst_rc}) — next attempt has NO corrective guidance"
    rm -f "$_analyst_err" 2>/dev/null || true
    exit 2
else
    _emit_fa "self_heal_complete" "failure-analyst prescribed corrective directive (${FAILURE_CLASS})"
fi

rm -f "$_analyst_err" 2>/dev/null || true

# ── Feed the KB, never the prompt ────────────────────────────────────────────
# The diagnosis used to be returned as prose for the caller to prepend to the
# next attempt ("CORRECTIVE GUIDANCE FROM SELF-HEAL: ..."). That is a self-heal
# push into a prompt, which is banned: appended text is silently trimmed on long
# runs and nothing verifies the agent obeyed it.
#
# Instead the diagnosis becomes an EPISODE, and synthesis turns it into an
# enforceable constraint via the path that is already tested and schema-bounded.
# Threshold 1 because this heal is same-story: the retry happens seconds later,
# and waiting for a second identical failure would leave the very next attempt —
# the one that matters most — with nothing. Arbitration, TTL ageing and
# quarantine are all in place, so a single-episode rule is safe: if it is wrong,
# it ages out.
_kb_lib="$SCRIPT_DIR/lib/kb-apply.sh"
if [ -f "$_kb_lib" ]; then
    # shellcheck disable=SC1090
    . "$_kb_lib"
    # Here-string, NOT a pipe: `x | kb_record_episode` runs the function in a
    # subshell, so the signature it captures dies with it and synthesis has no key.
    kb_record_episode "${AGENT_ANALYST_STORY_ID:-}" "${STORY_ROLE:-}" "$_trimmed" "$FAILURE_CLASS" \
        <<< "$_failed_output" || true
    KB_SYNTHESIS_THRESHOLD=1 kb_maybe_synthesize "${STORY_ROLE:-}" || true
fi

# Deliberately no stdout: there is no prose channel back to the caller any more.
exit 0
