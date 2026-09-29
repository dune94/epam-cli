#!/usr/bin/env bash
# The codemie-web provider plugin (config/providers.json runnerPlugin) — ONE pipeline call as a CodeMie
# web assistant, judged by what it said. The engine calls provider_call from the seam hub and the
# story writer alike (lib/provider-plugin.sh), so a codemie-web call is built in one place (invoke.js).
#
#   provider_call <prompt_file> <result_json>
#
#   assistant   "Pipeline <codeline> <agent>" (config/codemie-web.json): <agent> is EPAM_AGENT_NAME,
#               <codeline> is the lane's EPAM_CODELINE, or the project's name for an agent that serves
#               the whole project. Private (shared:false) in the operator's personal project.
#   model       AI_MODEL — the ladder's rung, sent per chat.
#   tools       the seam's grant (EPAM_ALLOWED_TOOLS when AI_GATE_ALLOW_TOOLS=1) picks the plugin that
#               serves it (the runner's `plugins` declaration); no grant is the runner's full set, as on
#               the claude runner. A tool budget of 0 (EPAM_MAX_TOOL_CALLS=0 — the hub's plan pass) is
#               no tools at all. Writing is rooted at the codeline (PROJECT_ROOT); reading at the run's
#               estate (JIRA_CODELINE_ROOT) when the codeline sits in it.
#   schema      EPAM_RESPONSE_SCHEMA ({name, schema}) → the chat's output_schema.
#   result_json the call in the claude runner's result shape (result.js).
#
# stdout: the answer. Returns 0 when the call answered, 1 when it did not (the reason on stderr).

_codemie_web_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

provider_call() {
    local prompt_file="${1:?prompt file}" result_json="${2:?result json}"
    local node="${NODE_BIN:-node}" model="${AI_MODEL:-}"
    local agent="${EPAM_AGENT_NAME:-}"
    [ -n "$agent" ] || { echo "[codemie-web] EPAM_AGENT_NAME is unset — refusing to name an assistant after nobody" >&2; return 1; }
    local codeline="${EPAM_CODELINE:-${PROJECT_NAME:-}}"
    [ -n "$codeline" ] || { echo "[codemie-web] neither EPAM_CODELINE nor PROJECT_NAME is set — no codeline to name the assistant for" >&2; return 1; }
    local grant="" root="${PROJECT_ROOT:-$PWD}" read_root=""
    [ "${AI_GATE_ALLOW_TOOLS:-0}" = "1" ] && grant="${EPAM_ALLOWED_TOOLS:-}"
    # A READ-ONLY PLUGIN SEES THE RUN'S WHOLE ESTATE. A claude-runner call works in the codeline but
    # its tools read any path, so a call about several codelines (the estate survey) reads them all.
    # A CodeMie plugin is confined to its root: rooted at one codeline, the survey could open only
    # that one and reported every other "failed" (AMSD-2974, 2026-09-29).
    if [ -n "${JIRA_CODELINE_ROOT:-}" ] && [ -d "$JIRA_CODELINE_ROOT" ]; then
        local _est _cl
        _est="$(cd "$JIRA_CODELINE_ROOT" && pwd -P)"; _cl="$(cd "$root" 2>/dev/null && pwd -P)"
        case "$_cl/" in "$_est"/*) read_root="$_est" ;; esac
    fi
    local schema_file=""
    if [ -n "${EPAM_RESPONSE_SCHEMA:-}" ] && command -v jq >/dev/null 2>&1; then
        schema_file="$(mktemp "${TMPDIR:-/tmp}/codemie-web-schema-XXXXXX")"
        printf '%s' "$EPAM_RESPONSE_SCHEMA" | jq -c '.schema // empty' > "$schema_file" 2>/dev/null
        [ -s "$schema_file" ] || { rm -f "$schema_file"; schema_file=""; }
    fi
    local rc=0
    "$node" "$_codemie_web_dir/invoke.js" \
        --prompt-file "$prompt_file" --model "$model" --agent "$agent" --codeline "$codeline" \
        --result "$result_json" --root "$root" ${grant:+--grant "$grant"} \
        ${EPAM_MAX_TOOL_CALLS:+--max-tool-calls "$EPAM_MAX_TOOL_CALLS"} \
        ${read_root:+--read-root "$read_root"} \
        ${schema_file:+--schema "$schema_file"} || rc=$?
    if [ -n "$schema_file" ]; then rm -f "$schema_file"; fi
    return $rc
}

# Stop every CodeMie plugin this install started. The run's exit handler calls it (through
# provider_plugins_stop), so no plugin — which can carry run-command — outlives the run. A run that
# never started one has no state file: stop-all returns at once, creating nothing, printing nothing.
provider_stop() {
    "${NODE_BIN:-node}" "$_codemie_web_dir/plugins.js" stop-all 2>&1 >&2 || true
}
