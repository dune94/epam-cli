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
# ABSENT IS NOT SUCCESS.
#
# Every guard below used to `return 0`. So on the orchestrate.sh path, where EPAM_PROJECT_CONFIG_DIR
# was never exported, the engine called this with "/llm-settings.json", got rc=0, and exported
# nothing:
#
#     $ export_model_ladders "/llm-settings.json"; echo $?
#     0
#     EPAM_MODEL_LADDER_TIER_ORDER=[UNSET]
#
# The engine has a loud warning for the case where this loader is missing entirely — it prints
# "seams will have no resolvable model". That branch could not fire, because the loader was present
# and reporting success about a project it had never found. The outcome is identical and the run
# said nothing: the ingest run died at discovery-vocabulary-agent with "failed" and no cause.
#
# A caller that genuinely does not care still writes `|| true`, and all eight already do. What it
# can no longer do is mistake "no project" for "no ladders declared".
export_model_ladders() {
    local _settings="${1:-${EPAM_LLM_SETTINGS_FILE:-}}"
    [ -n "$_settings" ] || {
        echo "[model-ladders] no settings file given — no ladder chains exported" >&2
        return 1
    }
    [ -f "$_settings" ] || {
        echo "[model-ladders] settings file not found: $_settings — no ladder chains exported" >&2
        return 1
    }
    command -v jq >/dev/null 2>&1 || {
        echo "[model-ladders] jq not on PATH — cannot read $_settings, no ladder chains exported" >&2
        return 1
    }
    # THE FILE THE CALLER HANDED US, VALIDATED BEFORE THE MERGE.
    #
    # There is a JSON check below, but it runs AFTER the resolver merges engine defaults in — and
    # the resolver ignores a project file it cannot parse and returns the defaults, so that check
    # only ever sees valid JSON. A malformed llm-settings.json therefore exported the engine's
    # ladders and returned 0, and the project's own chains vanished with nothing said. A run would
    # climb a ladder its project never declared.
    #
    # Checked here, on the ORIGINAL path, where a parse failure is still attributable to the caller.
    jq -e . "$_settings" >/dev/null 2>&1 || {
        echo "[model-ladders] settings file is not valid JSON: $_settings — refusing to export" >&2
        echo "[model-ladders] engine defaults would silently replace this project's ladders." >&2
        return 1
    }
    # THE ENGINE BASE, MERGED IN BEFORE ANYTHING IS READ.
    #
    # A project states only what it changes — the rule config/llm-defaults.json already applies
    # to budgets, and which ladders were left out of. Without this, the seam layer (which
    # resolves through lib/llm-settings-resolve.js) and this reader would answer the same
    # question differently, and a project inheriting a chain would get one here and none there.
    #
    # The merge is the resolver's, not a second copy of the rule: one place decides what a
    # project actually runs with. If node or the resolver is unavailable the raw project file is
    # used, which is exactly the behaviour before inheritance existed — additive, never a new
    # way to fail.
    local _merged=""
    if [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; then
        local _resolver
        _resolver="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-settings-resolve.js"
        if [ -f "$_resolver" ]; then
            _merged="$(mktemp)"
            if "${NODE_BIN:-node}" -e '
              const { resolveLlmSettings } = require(process.argv[1]);
              const path = require("path");
              const out = resolveLlmSettings({ projectConfigDir: path.dirname(process.argv[2]) });
              process.stdout.write(JSON.stringify(out));
            ' "$_resolver" "$_settings" > "$_merged" 2>/dev/null && [ -s "$_merged" ]; then
                _settings="$_merged"
            else
                rm -f "$_merged"; _merged=""
            fi
        fi
    fi

    jq -e . "$_settings" >/dev/null 2>&1 || {
        echo "[model-ladders] settings file is not valid JSON: $_settings — no ladder chains exported" >&2
        return 1
    }

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

    # THE ITERATION BUDGET IS PART OF THE LADDER TOO, and for the same reason as effort: a
    # rung is (model, effort, room to work). The project declares it per model in
    # modelOverrides; this exports it so a seam can resolve its own rung's budget without
    # re-reading the settings file or re-implementing the match.
    #
    # Until now the ONLY implementation of that match was ~20 lines of inline jq inside
    # claude.sh's per-attempt STORY path, so no seam could reach it: seam-invocation.js used a
    # per-agent literal instead — 22 profiles carried one, 16 carried none and fell through to
    # defaults.maxIterations of 1. lib/model-settings.js is now the single implementation and
    # this line is its shell edge.
    #
    # Absent means absent, as everywhere else in this loader.
    local _itermap
    _itermap=$("${NODE_BIN:-node}" -e '
        const { iterationMap } = require(process.argv[1] + "/model-settings.js");
        process.stdout.write(iterationMap(process.argv[2]) || "");
      ' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" "$_settings" 2>/dev/null || printf '')
    [ -n "$_itermap" ] && [ -z "${EPAM_MODEL_ITERATIONS:-}" ] \
        && export "EPAM_MODEL_ITERATIONS=$_itermap"

    # A READABLE FILE THAT DECLARES NO LADDER IS ALSO A FAILURE.
    #
    # Not pedantry: the seams no longer carry hardcoded model literals, so a run with no chains
    # does not run degraded, it declines seam by seam. Reporting success here would put us back
    # where we started with the file merely present instead of merely named.
    if [ -z "${EPAM_MODEL_LADDER_TIER_ORDER:-}" ]; then
        echo "[model-ladders] $_settings declares no ladderTierOrder — no positions can be resolved" >&2
        return 1
    fi
    return 0
}
