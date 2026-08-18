#!/usr/bin/env bash
# A MODEL THAT IS NOT ON A LADDER CANNOT ESCALATE, AND NOTHING SAYS SO.
#
# The successor lookup returns EMPTY for a model absent from the chain — the same value
# it returns for a model already at the top rung. Every call site reads that as "nothing
# to escalate to" and continues. So a story assigned an unladdered model burns all of
# its attempts on one model, never climbs, and produces a log indistinguishable from a
# story that legitimately reached the ceiling.
#
# Live, run 20260814T224748Z (metrolinx, AMSD-2041):
#
#     [InferenceLadder] AMSD-2041 resuming on 'MiniMax-M3'
#                       (escalated in an earlier invocation; PRD model is 'gpt-5-codex')
#
# The prd-model-coordinator had written `gpt-5-codex` into the PRD. Its deterministic
# reviewer checks STRUCTURE — which fields changed, whether stories were added or
# removed — and never asked whether the assigned model exists on a ladder. The run only
# escaped because ladder position had persisted from an earlier run and it resumed
# mid-chain; the PRD's own assignment was silently ignored.
#
# THE RUNGS ARE THE PROJECT'S DECLARATION. Everything here reads llm-settings.json. No
# model, tier, or provider name appears in this file, so a project on an entirely
# different set of models is checked identically and adding a model needs no engine edit.

# _ladder_rungs <llm-settings.json>
# Every model that appears as a rung of any declared tier — both ends of every hop, plus
# each tier's declared start model. One per line. Silent and non-zero when the file
# cannot be read: "we could not tell" is never "it is fine".
_ladder_rungs() {
    local _settings="${1:-}"
    [ -n "$_settings" ] && [ -f "$_settings" ] || return 1
    command -v jq >/dev/null 2>&1 || return 1
    jq -r '
        [ (.ladders // {})[] | ((.modelLadder // [])[] | .from, .to), (.startModel // empty) ]
        | map(select(type == "string" and . != "")) | unique | .[]
    ' "$_settings" 2>/dev/null
}

# model_is_on_ladder <model> <llm-settings.json>
# 0 when the model is a rung of some declared tier, non-zero otherwise.
model_is_on_ladder() {
    local _model="${1:-}" _settings="${2:-}"
    if [ -z "$_model" ]; then
        echo "model-ladder: no model given — an unassigned model is not a rung" >&2
        return 2
    fi
    local _rungs
    if ! _rungs="$(_ladder_rungs "$_settings")" || [ -z "$_rungs" ]; then
        echo "model-ladder: cannot read ladder declarations from '${_settings}' — membership UNKNOWN, refusing to approve" >&2
        return 3
    fi
    printf '%s\n' "$_rungs" | grep -Fxq -- "$_model" && return 0
    echo "model-ladder: '${_model}' is on no declared ladder" >&2
    return 1
}

# stories_with_unladdered_models <prd.json> <llm-settings.json>
# Checks every story that HAS a model assigned. A story with no model is not a violation
# — assignment is the coordinator's job and its absence is a different, earlier problem.
# Returns 0 when every assignment is a rung, 1 otherwise, naming each story and model.
stories_with_unladdered_models() {
    local _prd="${1:-}" _settings="${2:-}"
    [ -f "$_prd" ] || { echo "model-ladder: no PRD at '${_prd}' — nothing checked" >&2; return 0; }

    local _rungs
    if ! _rungs="$(_ladder_rungs "$_settings")" || [ -z "$_rungs" ]; then
        echo "model-ladder: cannot read ladder declarations from '${_settings}' — membership UNKNOWN, refusing to approve" >&2
        return 1
    fi

    local _bad="" _line _sid _model
    while IFS=$'\t' read -r _sid _model; do
        [ -n "$_sid" ] && [ -n "$_model" ] || continue
        printf '%s\n' "$_rungs" | grep -Fxq -- "$_model" && continue
        _bad="${_bad}    ${_sid} -> ${_model}"$'\n'
    done < <(jq -r '.stories[]? | select((.model // "") != "") | "\(.id)\t\(.model)"' "$_prd" 2>/dev/null)

    if [ -n "$_bad" ]; then
        echo "model-ladder: FAIL — stor(y/ies) assigned a model that is on no declared ladder:" >&2
        printf '%s' "$_bad" >&2
        echo "  Such a model cannot escalate: the successor lookup is empty, which every caller reads" >&2
        echo "  as 'already at the top'. The story would burn every attempt on one model." >&2
        return 1
    fi
    return 0
}
