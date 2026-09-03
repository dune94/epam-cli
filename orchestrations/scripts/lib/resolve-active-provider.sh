# resolve-active-provider.sh — ONE function resolves the provider for a seam, and callers ask.
#
# 17 seams (change-log/SEAM-CONSISTENCY-ANALYSIS.md, 2026-09-03) each had their own copy of
# "${SOME_PROVIDER:-openrouter}", none of which consulted EPAM_PROVIDER_SET. A swap made because a
# provider ran out of tokens does not reach a hardcoded literal — the seam keeps calling the
# exhausted vendor at the exact moment the swap was meant to rescue it.
#
# THE OVERRIDE IS REAL. ORCH_GATE_PROVIDER is deliberately preserved across a .env reload in
# run-agent-orchestration.sh so a tier script can point a gate at a specific vendor on purpose.
# This function only decides the FALLBACK — what a seam does when no override was given — and that
# fallback must derive from the active set, per provider-sets.json's own $comment: "falling back
# would run a whole programme on the wrong stack while looking configured."
#
# WHY THE FALLBACK IS THE ACTIVE SET'S RUNNER, NOT AN EMPTY STRING: llm-handler.sh's
# ${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}} is correct for ITS context because something
# further down fails loudly on empty. These 17 seams have no such downstream check — an empty
# fallback here would just move the same silent-wrong-vendor defect one layer deeper. A real,
# derivable default exists (the set the operator actually chose), so seams use it.

# resolve_active_provider [override] — print the provider to use, or fail loudly.
#
# NEVER prints an empty string on success or failure: a caller that reads one goes on to call
# `epam run --provider ""`, which fails somewhere far from here with a message about nothing.
resolve_active_provider() {
    local _override="${1:-}"
    if [ -n "$_override" ]; then
        printf '%s' "$_override"
        return 0
    fi

    local _psets="${EPAM_PROVIDER_SETS_FILE:-}"
    if [ -z "$_psets" ]; then
        # Mirrors llm-settings-resolve.js's providerSetsPath(): relative to this file's own
        # directory, so relocating orchestrations/config/ moves the registry and this lookup
        # together rather than leaving one behind.
        _psets="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../config" && pwd)/provider-sets.json"
    fi
    if [ ! -f "$_psets" ]; then
        echo "[resolve-active-provider] no provider-sets.json at $_psets — cannot resolve a provider without it" >&2
        return 1
    fi

    local _declared _wanted _settings_file
    _declared=$(jq -r '.sets | keys | join(", ")' "$_psets" 2>/dev/null)
    _wanted="${EPAM_PROVIDER_SET:-}"
    if [ -z "$_wanted" ]; then
        _wanted=$(jq -r '.defaultSet // empty' "$_psets" 2>/dev/null)
    fi
    if [ -z "$_wanted" ]; then
        echo "[resolve-active-provider] no EPAM_PROVIDER_SET and no defaultSet declared in $_psets" >&2
        return 1
    fi

    # AN UNKNOWN SET THROWS — never falls through to whatever set happened to be declared first.
    # Same rule llm-settings-resolve.js's activeSet() already enforces on the JS side; this is its
    # shell-side twin, not a competing definition.
    _settings_file=$(jq -r --arg s "$_wanted" '.sets[$s].settingsFile // empty' "$_psets" 2>/dev/null)
    if [ -z "$_settings_file" ]; then
        echo "[resolve-active-provider] EPAM_PROVIDER_SET='$_wanted' is not a declared provider set — declared: $_declared (see $_psets)" >&2
        return 1
    fi

    local _settings_path _runner _runner_count
    _settings_path="$(dirname "$_psets")/$_settings_file"
    if [ ! -f "$_settings_path" ]; then
        echo "[resolve-active-provider] provider set '$_wanted' declares settingsFile '$_settings_file' but it does not exist at $_settings_path" >&2
        return 1
    fi

    _runner_count=$(jq -r '.runners | keys | length' "$_settings_path" 2>/dev/null)
    if [ "$_runner_count" != "1" ]; then
        # Every set declared today has exactly one runner. More than one is an ambiguous config no
        # caller here should silently pick a winner from; zero is the settings file failing to
        # declare what actually executes. Both are refused rather than guessed.
        echo "[resolve-active-provider] provider set '$_wanted' declares $_runner_count runners in $_settings_path — expected exactly 1" >&2
        return 1
    fi

    _runner=$(jq -r '.runners | keys[0]' "$_settings_path" 2>/dev/null)
    if [ -z "$_runner" ]; then
        echo "[resolve-active-provider] provider set '$_wanted' declares no runner in $_settings_path" >&2
        return 1
    fi

    printf '%s' "$_runner"
    return 0
}
