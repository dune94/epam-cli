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
        [ -n "${!_var:-}" ] && continue
        _chain=$(jq -r --arg t "$_tier" \
            '[.ladders[$t].modelLadder[]? | "\(.from)=\(.to)"] | join("|")' "$_settings" 2>/dev/null)
        [ -n "$_chain" ] && export "$_var=$_chain"
    done
    return 0
}
