#!/usr/bin/env bash
# resolve-primary-provider.sh — THE SET DECIDES, not whatever a file left in the environment.
#
# Extracted verbatim from llm-handler.sh (2026-09-03), where it was defined inline and therefore
# unreachable by any other seam. change-log/SEAM-CONSISTENCY-ANALYSIS.md found 17 other seams each
# re-inventing a WEAKER version of this same idea — a hardcoded vendor default with no awareness
# of the active set at all. This is the one that already survived a real incident; the fix is to
# share it, not to write a second, simpler one beside it.
#
# On 2026-08-29 a metrolinx run launched with EPAM_PROVIDER_SET=claude resolved the claude ladder —
# "at the top of its declared chain (claude-opus-5)" — and then asked provider 'openrouter' for it,
# because the repo's .env still carried EPAM_ORCHESTRATION_PROVIDER=openrouter from another stack.
# Three attempts, no completion record, and the run died AFTER the roster had been minted and
# reviewed against real client code. The repo already had this incident on record once. Twice is a
# design fault, not an accident.
#
# The set is the deliberate per-launch choice; an env var (or a candidate value a caller passes in)
# is whatever was left behind or assigned upstream. So a provider the active set cannot route is
# replaced by one it can — and the substitution is ANNOUNCED, because an operator who really meant
# a specific vendor has to see that they did not get it.
#
# A run that declares no set has expressed no preference this can contradict, and is left alone.

# THE ONLY SAFE POINT TO CAPTURE "WHERE IS THIS FILE" is here, at source time, as a top-level
# constant — not inside the function. BASH_SOURCE[0] read INSIDE a sourced function resolves to
# the file the function was DEFINED in (verified empirically: a function sourced from lib.sh into
# caller.sh reports lib.sh, not caller.sh) — so re-deriving it on every call would silently point
# at wherever this file happens to live, which changes the moment the file is ever moved again.
# Capturing it once, by name, makes the derivation an explicit, auditable fact instead of a
# coincidence of file layout.
_RESOLVE_PRIMARY_PROVIDER_SCRIPTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# resolve_primary_provider [candidate] — print the provider to use.
#
# [candidate], if given and non-empty, is used exactly where llm-handler.sh's own call used
# ${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}} — i.e. it takes that same slot. Calling with NO
# argument preserves llm-handler.sh's original behaviour byte-for-byte: this is an additive
# capability, not a change to the existing call site.
resolve_primary_provider() {
    local _env_provider="${1:-${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}}"
    local _set="${EPAM_PROVIDER_SET:-}"
    if [ -z "$_set" ]; then
        printf '%s' "$_env_provider"
        return 0
    fi

    local _routable
    _routable=$("${NODE_BIN:-node}" "${SCRIPT_DIR:-$_RESOLVE_PRIMARY_PROVIDER_SCRIPTS_ROOT}/lib/handlers/ladder-providers.js" 2>/dev/null || echo "")
    if [ -z "$_routable" ] || [ "$_routable" = "[]" ]; then
        printf '%s' "$_env_provider"
        return 0
    fi

    if [ -n "$_env_provider" ] \
       && printf '%s' "$_routable" | jq -e --arg p "$_env_provider" 'index($p) != null' >/dev/null 2>&1; then
        printf '%s' "$_env_provider"
        return 0
    fi

    local _first
    _first=$(printf '%s' "$_routable" | jq -r '.[0] // empty')
    [ -n "$_first" ] || { printf '%s' "$_env_provider"; return 0; }
    if [ -n "$_env_provider" ]; then
        # STDERR DIRECTLY, not warning(): under `set -euo pipefail` a command-not-found aborts the
        # whole substitution — which left the provider as whatever the environment said and failed
        # the metrolinx run of 2026-08-29 a SECOND time, with this very fix in place. A diagnostic
        # must not be able to break the thing it is diagnosing.
        printf '%s\n' "  [provider] '${_env_provider}' is not routable by the '${_set}' set — using '${_first}'." >&2
        printf '%s\n' "  [provider] The set is the launch's own choice; the env value was left by something else." >&2
    fi
    printf '%s' "$_first"
}
