#!/usr/bin/env bash
# WHAT A MODEL TIER CONTAINS IS DECLARED ONCE, AND EVERY ENTRY POINT READS IT THE SAME WAY.
#
# llm-settings.json declares ladders.high / .medium / .highest. The seam machinery reads them
# from the environment as EPAM_MODEL_LADDER_<TIER>, so something has to serialise one into the
# other — and that something lived INSIDE claude.sh, where no other entry point could reach it.
#
# Both halves of the resulting defect were live on 2026-08-13:
#
#   1. config.env pinned EPAM_MODEL_LADDER_HIGHEST to a SINGLE pair. claude.sh only exported
#      "if unset", so the pin won and every seam on HIGHEST — the reviewer, the detective, the
#      roster review, the estate survey, both failure analysts — climbed a one-step ladder:
#          [FailureAnalyst] analyst ladder exhausted at 'z-ai/glm-5.2' (tier=HIGHEST)
#
#   2. Removing the pin fixed claude.sh-driven runs and broke the standalone one, which sources
#      only env-file.sh and node-bin.sh:
#          [seam-invocation] agent 'code-graph-detective' asks for ladder 'HIGHEST',
#          but EPAM_MODEL_LADDER_HIGHEST is unset
#
# One declaration, one reader, every entry point.

# export_model_ladders <llm-settings.json>
# Exports EPAM_MODEL_LADDER_<TIER> for every tier the file declares. An ALREADY-SET value is
# left alone: an operator override at launch outranks the project declaration, and that
# precedence is the same one load_env_file_safe ... preserve uses for the rest of the config.
export_model_ladders() {
    local _settings="${1:-${EPAM_LLM_SETTINGS_FILE:-}}"
    [ -n "$_settings" ] && [ -f "$_settings" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    local _tier _var _chain
    # The tiers come from the FILE, not from a list here: a project adding a tier must not have
    # to edit the engine, and a list would go stale exactly the way the pinned ladder did.
    for _tier in $(jq -r '(.ladders // {}) | keys[]' "$_settings" 2>/dev/null); do
        _var="EPAM_MODEL_LADDER_$(printf '%s' "$_tier" | tr '[:lower:]-' '[:upper:]_')"

        # THE STARTING MODEL IS DECLARED, NEVER INFERRED FROM MAP ORDER — AND IT IS EXPORTED
        # BEFORE THE OVERRIDE GUARD BELOW, WHICH IS A SEPARATE VALUE FROM THE CHAIN.
        #
        # modelLadder is a set of HOPS with several independent roots — MiniMax, zhipuai, z-ai and
        # moonshotai chains all live in one map. Taking the first pair's "from" as the start meant
        # whichever root happened to be listed first in the JSON became every seam's opening model.
        #
        # This export sat BELOW the `continue` when it was written. The orchestrator exports the
        # chain first, so every later caller hit `continue` and never exported the start — the
        # variable was unset in every seam process. seam_ladder_export then set no EPAM_MODEL, and
        # because the hardcoded model fallbacks had been removed the same afternoon, the
        # repro-test-writer REFUSED to run: "no model resolved for this seam". Step 3.55 then
        # blocked the story for shipping no reproducing test, and the run could not converge.
        # Live 2026-08-14, run 20260814T171533Z.
        #
        # It passed verification because that was run in a CLEAN shell, where the chain was not
        # yet set and the `continue` never fired — the one condition under which the bug is
        # invisible. The override guard protects an operator's CHAIN; it was never meant to gate
        # the start model.
        local _start
        _start=$(jq -r --arg t "$_tier" '.ladders[$t].startModel // ""' "$_settings" 2>/dev/null)
        [ -n "$_start" ] && [ -z "$(eval printf '%s' "\"\${${_var}_START:-}\"")" ] \
            && export "${_var}_START=$_start"

        # An ALREADY-SET chain is an operator override and outranks the declaration.
        [ -n "${!_var:-}" ] && continue
        _chain=$(jq -r --arg t "$_tier" \
            '[.ladders[$t].modelLadder[]? | "\(.from)=\(.to)"] | join("|")' "$_settings" 2>/dev/null)
        [ -n "$_chain" ] && export "$_var=$_chain"
    done
    # THE ORDER THE TIERS RANK IN, from the file that declares them. A consumer comparing two
    # tiers (is this story's tier below its archetype's floor?) needs an ordering, and ranking
    # them in engine code would embed a project's vocabulary in shared code — the same reason the
    # loop above reads tier NAMES from the file rather than listing them.
    #
    # Absent means absent: a project that declares no order gets no ranking, and every consumer
    # falls back to the behaviour it had before an order existed.
    local _order
    _order=$(jq -r '(.ladderTierOrder // []) | join(" ")' "$_settings" 2>/dev/null)
    [ -n "$_order" ] && [ -z "${EPAM_MODEL_LADDER_TIER_ORDER:-}" ] \
        && export "EPAM_MODEL_LADDER_TIER_ORDER=$_order"

    # THE EFFORT VOCABULARY — PART OF THE LADDER'S SEMANTICS, NOT A SEPARATE SYSTEM.
    #
    # A rung is (model, effort). When the model chain runs out, effort is what still climbs:
    # "at the top of its chain — effort is the remaining lever". So this is exported for the same
    # consumers that walk the model chain — effort_rank, max_effort and next_effort — and it is
    # PIPE-separated because that is what they already parse.
    #
    # ladderTierOrder above orders which CHAIN an agent gets (medium/high/highest); effortLadder
    # orders how hard it works within a rung (low/medium/high/max). Two settings of one ladder,
    # not two ladders.
    #
    # The engine ranked effort in four hand-written case statements that knew three of the four
    # declared tiers, so a story asking for the project's highest effort ranked below its second
    # highest.
    local _effort
    _effort=$(jq -r '(.effortLadder // []) | join("|")' "$_settings" 2>/dev/null)
    [ -n "$_effort" ] && [ -z "${EPAM_EFFORT_LADDER:-}" ] \
        && export "EPAM_EFFORT_LADDER=$_effort"
    return 0
}
