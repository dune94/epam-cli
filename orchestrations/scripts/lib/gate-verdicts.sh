#!/usr/bin/env bash
# HOW A GATE'S ANSWER BECOMES A DECISION — SOMEWHERE A TEST CAN SEE IT.
#
# 14 of the 40 declared seams are verdict-kind: their whole output is a judgement. The logic that
# turns one into fail/warn/pass lived inside run-agent-orchestration.sh, which cannot be sourced
# without running the pipeline, so none of it was ever executed by a test.
#
# That matters more here than anywhere: a gate that logs a block without enforcing it, or blocks
# on an ungrounded claim, looks identical in a log to one working correctly. Both have happened in
# this pipeline before.
#
# Expects its caller to provide:
#
#   SCRIPT_DIR                — for lib/handlers/findings-grounded.py and the verdict schema
#   log, error, warning       — the orchestrator's logging helpers
#   seam_model_or_fail,
#   seam_next_model           — the ladder this gate climbs between attempts
#   ORCH_GATE_ALLOWED_TOOLS   — the tool allowlist every gate invocation is restricted to
#
# ORCH_GATE_ALLOWED_TOOLS is deliberately NOT defaulted here. A default would silently widen
# the tool grant of every gate if a caller forgot to set it, and an unset variable failing
# loudly under `set -u` is the safer of the two.


# runtime_boundary_verdict <gate-log> <project-root>
#
# THE VERDICT DECIDES, NOT THE EXIT CODE.
#
# This gate's result handling read $? and nothing else: the log was written, handed to the gate and
# never read again, so a grounded report that a change cannot execute printed "Step 22g — pass"
# because the process exited 0. Its sibling two lines below has always grepped the log.
#
# Grounding, same discipline as fuzz-weaver: a `fail` blocks only when a finding names a file that
# exists. A claim about a file that does not exist is not evidence, and a gate that blocks on one
# teaches the operator to ignore it.
#
# An unparseable or empty log is a WARN, never a pass: a gate that could not produce an answer has
# not cleared the change.
#
# Echoes: fail | warn | pass
runtime_boundary_verdict() {
    local _log="${1:-}" _root="${2:-}"
    [ -n "$_log" ] && [ -s "$_log" ] || { echo warn; return 0; }

    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$_log" 2>/dev/null; then
        local _grounded
        _grounded=$(python3 "$SCRIPT_DIR/lib/handlers/findings-grounded.py" "$_log" "$_root" 2>/dev/null || echo 0)
        if [ "${_grounded:-0}" -gt 0 ]; then echo fail; else echo warn; fi
        return 0
    fi
    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$_log" 2>/dev/null; then echo warn; return 0; fi
    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"pass"' "$_log" 2>/dev/null; then echo pass; return 0; fi
    echo warn
}

# THE RETRY THAT TURNS A GATE INTO A DECISION.
#
# The other 13 verdict seams reach the operator through here: it invokes the gate, climbs the
# ladder between attempts, and decides what the run does with the answer. It lived in the
# orchestrator, so none of that had ever been executed by a test either.
#
# It calls run_orch_prompt, which is why that had to become a lib first.
_GATE_VERDICTS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=orch-prompt.sh
[ -f "$_GATE_VERDICTS_LIB_DIR/orch-prompt.sh" ] && . "$_GATE_VERDICTS_LIB_DIR/orch-prompt.sh"

_run_qa_gate_with_retry() {
    local _qg_prompt="$1" _qg_agent="$2" _qg_phase="$3" _qg_log="$4"
    local _qg_max="${QA_GATE_MAX_RETRIES:-2}"
    local _qg_attempt=0
    # Derive short agent slug for file-recovery search (strip "qa-gate:" prefix)
    local _qg_slug="${_qg_agent#qa-gate:}"
    while [ "$_qg_attempt" -lt "$_qg_max" ]; do
        rm -f "$_qg_log"
        local _qg_eff_prompt="$_qg_prompt"
        if [ "$_qg_attempt" -ge 1 ]; then
            # CLIMB THIS GATE'S OWN CHAIN. This assigned ORCH_GATE_MODEL, which run_orch_prompt
            # stopped reading when the ladder became the only source — so the retry silently
            # re-ran the SAME model and the escalation was gone. It was also one run-wide "high"
            # model every gate jumped to regardless of where it started, which is a pin.
            ORCH_AGENT_MODEL_CLIMB=$(seam_next_model "$_qg_agent" "$(seam_model_or_fail "$_qg_agent" 2>/dev/null)")
            export ORCH_AGENT_MODEL_CLIMB
            local _qg_retry_prefix
            if echo "$_qg_prompt" | grep -q "Do NOT attempt to call any shell commands"; then
                _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): The previous invocation produced no structured output. Re-analyze the pre-injected evidence already present in this prompt and emit your JSON verdict now. Do NOT call any tools. Do NOT use WriteFile — output your JSON as plain text in this message."
            else
                # Detect WriteFile-instead-of-stdout failure: log is tiny and contains
                # the tool confirmation phrase but no JSON fields.
                local _qg_log_size=0
                [ -f "$_qg_log" ] && _qg_log_size=$(wc -c < "$_qg_log" 2>/dev/null || echo 0)
                if [ "${_qg_log_size:-0}" -lt 200 ] && grep -q "has been written" "$_qg_log" 2>/dev/null; then
                    _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): CRITICAL — your previous response used WriteFile to write your output to a file. That file was NOT read by the pipeline. You MUST emit your JSON verdict as plain text in this message — do NOT use WriteFile, do NOT write to any file. Use ReadFile to read source files, then emit your findings directly here."
                else
                    _qg_retry_prefix="RETRY (attempt $(( _qg_attempt + 1 ))): Your previous answer was REJECTED because it ${_qg_schema_reason:-timed out or produced no structured output}. Use ReadFile and Bash tools to read the relevant source files now, then emit your JSON findings directly in your response — do NOT use WriteFile."
                fi
            fi
            _qg_eff_prompt="$_qg_retry_prefix

$_qg_prompt"
        fi
        # SELF-HEAL (brownfield only — greenfield flow deliberately unchanged).
        #
        # Every gate already had retry + ladder escalation, and none had this.
        # Live 2026-07-26: perf-sentinel failed IDENTICALLY twice — both attempts
        # returned only "The file has been written successfully." — because
        # nothing diagnosed attempt 1, so attempt 2 differed only by model.
        # fuzz-weaver produced a 0-byte log in the same run. Two of six quality
        # gates reviewed nothing and the phase still passed.
        #
        # The repro-test-writer hit the same failure class that day and RECOVERED
        # on attempt 2, because its failure was recorded as an episode, diagnosed
        # and compiled into an enforced constraint. That machinery is proven; the
        # gates simply never called it.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_qg_attempt" -ge 1 ] \
           && [ -f "$SCRIPT_DIR/lib/kb-apply.sh" ]; then
            # shellcheck disable=SC1090
            . "$SCRIPT_DIR/lib/kb-apply.sh" || true
            # "produced no output" carries no error string to key on, so give the
            # episode an explicit class — otherwise it can never be looked up,
            # which is exactly why the write-tool failure was never learned from.
            local _qg_class="no_structured_output"
            if [ -f "$_qg_log" ] && grep -q "has been written" "$_qg_log" 2>/dev/null; then
                _qg_class="answered_via_write_tool"
            fi
            head -c "$(evidence_window gateLogChars)" "$_qg_log" 2>/dev/null | \
                FAILURE_CLASS="$_qg_class" \
                kb_record_episode "${_qg_phase:-}" "$_qg_slug" "gate produced no verdict" "$_qg_class" || true
            kb_apply_constraints "$_qg_slug" "story:${_qg_phase:-}" || true
        fi

        # Same allowlist as run_orch_prompt_with_tools: this path calls
        # run_orch_prompt directly, so wiring only the helper would leave every
        # actual gate invocation unrestricted.
        # EPAM_AGENT_NAME/STORY_ID name the Langfuse trace. Without them every
        # trace in a run renders as `llm-stream (uuid)` with no agent and no
        # prompt — 35 identical unreadable rows, which is how a hung call went
        # unnoticed behind a generic "timed out" message.
        AI_GATE_ALLOW_TOOLS=1 EPAM_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS}" \
            EPAM_AGENT_NAME="$_qg_agent" EPAM_STORY_ID="${_qg_phase:-}" \
            run_orch_prompt "$_qg_eff_prompt" "$_qg_agent" "$_qg_phase" 2>&1 | tee "$_qg_log"
        # VALIDATE the verdict rather than grepping for the word.
        #
        # This was `grep -qE '"(verdict|findings|agent|summary)"'`, so any text
        # containing the word "verdict" counted as a completed review — a
        # truncated report, a fragment of reasoning, a verdict of "maybe".
        # Live 2026-07-26: two gates "reviewed" a change while emitting 40 bytes
        # of write-tool echo between them.
        #
        # Validated AFTER the call, not via provider-level strict json_schema:
        # these gates need tools to read source and strict schema suppresses
        # tool calling (SCHEMA-1). The reason is fed back into the retry so
        # attempt 2 is told what was wrong instead of just getting a bigger model.
        _qg_schema_reason=""
        if [ -f "$SCRIPT_DIR/lib/gate_verdict_schema.py" ]; then
            _qg_schema_reason=$(python3 "$SCRIPT_DIR/lib/gate_verdict_schema.py" \
                                  "$_qg_agent" "$_qg_log" 2>/dev/null) || true
        fi
        if [ -z "$_qg_schema_reason" ] \
           && grep -qE '"(verdict|findings|agent|summary)"' "$_qg_log" 2>/dev/null; then
            unset ORCH_AGENT_MODEL_CLIMB
            return 0
        fi
        [ -n "$_qg_schema_reason" ] && \
            warning "  [qa-gate] ${_qg_agent}: rejected — ${_qg_schema_reason}"
        # ── WriteFile recovery: model wrote JSON to a file instead of emitting it ──
        # Search project root for a recently-written JSON file containing this
        # gate's structured output. If found, append its content to the log so
        # the normal grep check picks it up on the next iteration OR after the loop.
        local _qg_recovered=""
        _qg_recovered=$(find "${OUTPUT_DIR:-${PROJECT_ROOT:-$PWD}}" \
            -maxdepth 4 -name "*.json" -newer "$_qg_log" \
            2>/dev/null | \
            xargs grep -l "\"${_qg_slug}\"\|\"verdict\"\|\"summary\"" 2>/dev/null | \
            head -1 || true)
        if [ -z "$_qg_recovered" ]; then
            # Also check current directory and /tmp for files written in last 5 min
            _qg_recovered=$(find . /tmp -maxdepth 2 -name "*.json" \
                -newer "$_qg_log" \
                2>/dev/null | \
                xargs grep -l "\"${_qg_slug}\"" 2>/dev/null | \
                head -1 || true)
        fi
        if [ -n "$_qg_recovered" ]; then
            warning "  [qa-gate] $_qg_agent wrote output to file instead of stdout — recovering from: $_qg_recovered"
            cat "$_qg_recovered" >> "$_qg_log"
            if grep -qE '"(verdict|findings|agent|summary)"' "$_qg_log" 2>/dev/null; then
                    unset ORCH_AGENT_MODEL_CLIMB
                return 0
            fi
        fi
        if [ "$(( _qg_attempt + 1 ))" -lt "$_qg_max" ]; then
            warning "  [qa-gate] $_qg_agent attempt $(( _qg_attempt + 1 )) produced no structured output — retrying with escalated model"
        else
            warning "  [qa-gate] $_qg_agent all $(( _qg_attempt + 1 )) attempt(s) exhausted with no structured output"
        fi
        _qg_attempt=$(( _qg_attempt + 1 ))
    done
    unset ORCH_AGENT_MODEL_CLIMB
    return 1
}
