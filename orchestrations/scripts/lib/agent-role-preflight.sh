#!/usr/bin/env bash
# A ROLE THE MINT HAS NOT PRODUCED YET IS NOT A MISSING ROLE.
#
# Rosters are ephemeral by design. A FRESH run clears the generated registries, restores
# agents/profiles.json from profiles.json.original, and the MINT then produces this run's
# roles and assigns them to stories. A RESUME skips the mint and keeps the roster it is
# resuming with.
#
# The launcher's preflight checked every story's agentRole against profiles.json, and it
# ran BEFORE the mint (line 214 vs line 297). So on a fresh run it compared a role minted
# by a PREVIOUS run against the canonical base roster the reset had just restored — a
# comparison that cannot match, refusing the launch for a state the next step would fix:
#
#     ✗ [preflight] agentRole names a role the roster does not contain:
#                   AMSD-2041 -> contentstack-live-preview-integration-engineer
#
# The following launch minted `contentstack-live-preview-engineer` and completed. The
# check was right about the fact and wrong about the moment.
#
# It is NOT dropped: when the mint is skipped, nothing downstream will ever assign a
# role, so an unmatched one means the writer runs as the generic archetype — unbound by
# the specialist brief, including the rule that it must not author tests. That is the
# case worth refusing, and it is the only one.

# agent_roles_resolve <prd.json> <profiles.json> <mint_will_run:0|1>
# 0 when every story's agentRole will resolve by the time a writer runs; non-zero when a
# story would reach the writer with a role nothing has defined.
agent_roles_resolve() {
    local _prd="${1:-}" _profiles="${2:-}" _mint_will_run="${3:-0}"

    [ -f "$_prd" ] || { echo "agent-role: no PRD at '${_prd}' — nothing checked" >&2; return 0; }

    if [ ! -f "$_profiles" ] || ! jq -e 'type == "object"' "$_profiles" >/dev/null 2>&1; then
        echo "agent-role: cannot read the roster at '${_profiles}' — membership UNKNOWN, refusing to approve" >&2
        return 1
    fi

    # THE MINT IS ABOUT TO ASSIGN. Say so rather than passing silently: an operator
    # reading the log should see that the check ran and why it allowed a role the current
    # roster does not hold.
    if [ "$_mint_will_run" = "1" ]; then
        local _pending
        _pending=$(jq -r --slurpfile p "$_profiles" '
            [ .stories[]? | select((.agentRole // "") != "")
              | select((.agentRole) as $r | ($p[0] | has($r)) | not) | .id ] | join(", ")
        ' "$_prd" 2>/dev/null)
        if [ -n "$_pending" ]; then
            echo "agent-role: ${_pending} name a role the base roster does not hold — the mint runs next and assigns; not a failure" >&2
        fi
        return 0
    fi

    # THE MINT IS SKIPPED. Whatever the PRD names now is what a writer will get.
    local _roleless _badrole
    _roleless=$(jq -r '[ .stories[]? | select((.agentRole // "") == "" and ((.agentRoles // {}) | length) == 0) | .id ] | join(", ")' "$_prd" 2>/dev/null)
    if [ -n "$_roleless" ]; then
        echo "agent-role: FAIL — no agentRole and no mint to assign one: ${_roleless}" >&2
        echo "  The writer would run as the generic archetype, unbound by the specialist brief." >&2
        return 1
    fi

    _badrole=$(jq -r --slurpfile p "$_profiles" '
        [ .stories[]? | select((.agentRole // "") != "")
          | select((.agentRole) as $r | ($p[0] | has($r)) | not)
          | .id + " -> " + .agentRole ] | join("; ")
    ' "$_prd" 2>/dev/null)
    if [ -n "$_badrole" ]; then
        echo "agent-role: FAIL — agentRole names a role the roster does not contain: ${_badrole}" >&2
        echo "  The mint is skipped, so nothing will assign one. The perimeter refuses these at the" >&2
        echo "  writer seam: 'not permitted to author code'." >&2
        return 1
    fi
    return 0
}
