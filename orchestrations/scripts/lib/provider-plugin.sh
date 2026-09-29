#!/usr/bin/env bash
# provider-plugin.sh — A PROVIDER IS A DECLARATION AND A PLUGIN.
#
# A provider whose calls need vendor facts (a CLI's flags, an SDK's layout, a service's protocol)
# is a plugin: config/providers.json `runnerPlugin` names its directory (relative to orchestrations/),
# and that directory's runner.sh defines
#
#   provider_call <prompt_file> <result_json>   one call. stdout: the answer; result_json: the call in
#                                               the claude runner's result shape; 0 answered, 1 not.
#   provider_stop                               optional: release whatever the plugin started. The run's
#                                               exit handler calls it for every declared plugin.
#
# The call's inputs are the environment every model call already carries: AI_MODEL,
# EPAM_REASONING_EFFORT, EPAM_AGENT_NAME, EPAM_STORY_ID, EPAM_CODELINE, PROJECT_NAME, PROJECT_ROOT,
# JIRA_CODELINE_ROOT, AI_GATE_ALLOW_TOOLS + EPAM_ALLOWED_TOOLS (the seam's grant — absent means the
# runner's full set, as on the claude runner), EPAM_RESPONSE_SCHEMA, LOG_DIR, and EPAM_READ_ROOTS
# (directories the PRD declares readable, one per line).
#
# The engine names no provider here or at any call site: which providers are plugins is read from
# the declaration, so adding one is a config line and a directory (review of 2026-09-29).

_provider_plugin_orch="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# provider_plugin_dir <provider> — the plugin's directory, or nothing (the provider is not a plugin).
provider_plugin_dir() {
    local _p="${1:-}" _rel
    [ -n "$_p" ] || return 1
    _rel="$("${NODE_BIN:-node}" -e '
      try {
        const j = require(process.argv[1]);
        const r = (j.runnerPlugin || {})[process.argv[2]];
        if (typeof r === "string" && r) process.stdout.write(r);
      } catch { /* no declaration: not a plugin */ }
    ' "$_provider_plugin_orch/config/providers.json" "$_p" 2>/dev/null)"
    [ -n "$_rel" ] && [ -f "$_provider_plugin_orch/$_rel/runner.sh" ] || return 1
    printf '%s' "$_provider_plugin_orch/$_rel"
}

# provider_plugin_call <provider> <prompt_file> <result_json> — one call through the provider's plugin,
# in a subshell so nothing the plugin defines leaks into the caller. Callers reach it only after
# provider_plugin_dir answered, so it refuses nothing of its own (no gates — operator, 2026-09-29).
provider_plugin_call() {
    local _p="${1:?provider}" _prompt="${2:?prompt file}" _result="${3:?result json}"
    ( . "$(provider_plugin_dir "$_p")/runner.sh" && provider_call "$_prompt" "$_result" )
}

# provider_plugins_stop — the run's exit handler: every declared plugin that can stop, stops.
provider_plugins_stop() {
    local _p _dir
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        _dir="$(provider_plugin_dir "$_p")" || continue
        ( . "$_dir/runner.sh" && declare -F provider_stop >/dev/null && provider_stop ) || true
    done < <("${NODE_BIN:-node}" -e '
      try { for (const k of Object.keys(require(process.argv[1]).runnerPlugin || {})) console.log(k); } catch { /* none */ }
    ' "$_provider_plugin_orch/config/providers.json" 2>/dev/null)
    return 0
}
