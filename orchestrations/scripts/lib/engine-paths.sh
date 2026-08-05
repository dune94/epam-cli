#!/usr/bin/env bash
# What the ENGINE owns — the bash half of src/config/enginePaths.ts.
#
# These directories hold epam-cli's own state: knowledge base, agent profiles, run logs,
# code indexes, telemetry, contracts. None of it is client content, none of it is writer
# output, and none of it may be committed into a client codeline.
#
# ONE definition, because this rule has already drifted three ways. lib/git-ops.sh carried
# the full list, worktree-health-check.sh excluded only orchestrations/logs/* (so
# orchestrations/agents/KB.md passed straight through), Step 9's auto-commit excluded
# nothing, and lib/story-outputs.sh had its own separate regex covering only two of the
# five. Live metrolinx 20260804T225443Z: the engine's KB.md was written into the upexpress
# client repo and recorded as writer output in that lane's manifest.
#
# The real perimeter is the WRITE seam (src/config/enginePaths.ts, enforced in
# WriteFileTool). Everything here is defence in depth.

_ENGINE_OWNED_DIRS=( 'orchestrations' '.epam' '.codegraph' '.deepeval' '.contracts' )

# engine_paths_filter — stdin: repo-relative paths. stdout: those that are NOT engine-owned.
#
# Matches whole path SEGMENTS, never a substring: `src/orchestrations-ui/App.tsx` is client
# code and must survive, while `orchestrations/agents/KB.md` and
# `packages/web/.epam/settings.json` must both be dropped.
engine_paths_filter() {
    local _line
    local _owned_list
    _owned_list=$(printf '%s\n' "${_ENGINE_OWNED_DIRS[@]}")
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        # -x -F: exact, literal, whole-segment. No pattern matching.
        if printf '%s\n' "$_line" | tr '/' '\n' | grep -qxF "$_owned_list" 2>/dev/null; then
            continue
        fi
        printf '%s\n' "$_line"
    done
}
