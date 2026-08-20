#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# render-engine-prompt.sh — render a template-layer prompt from shell.
#
# Several seams that still carry embedded prompts are shell, not JavaScript, so
# they need the same renderer the JS side uses. This is a thin wrapper over
# lib/engine-prompt.js: one renderer, one strictness, one set of rules.
#
#   render_engine_prompt <template-id> <values-json-file>
#
# VALUES ARRIVE VIA A FILE, NEVER ARGV.
# Prompt values routinely carry a whole diff, a suite dump or a PRD fragment.
# ARG_MAX is 2 MiB, and passing a value that exceeds it makes the command exit
# 126 with an empty result — which is exactly how the FailureAnalyst died on
# 2026-08-15, silently, because the failure looked like a parse error three
# steps later. A file has no such limit.
#
# Exit status is the contract: non-zero means nothing was rendered, and the
# caller must refuse to invoke an agent rather than send it an empty prompt.
# ─────────────────────────────────────────────────────────────────────────────

# shellcheck disable=SC2148
_REP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

render_engine_prompt() {
    local _id="$1" _values_file="$2" _body_key="${3:-}"

    if [ -z "$_id" ] || [ -z "$_values_file" ]; then
        echo "[render-engine-prompt] usage: render_engine_prompt <template-id> <values-json-file>" >&2
        return 2
    fi
    if [ ! -f "$_values_file" ]; then
        echo "[render-engine-prompt] values file not found: $_values_file" >&2
        return 2
    fi

    local _out _err
    _err=$(mktemp "${TMPDIR:-/tmp}/render-prompt-err-XXXXXX")
    # The values file path is the only thing on argv; the values themselves are read
    # from disk by node.
    _out=$("${NODE_BIN:-node}" -e '
        const fs = require("fs");
        const { renderEngineTemplate } = require(process.argv[1]);
        const values = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
        process.stdout.write(renderEngineTemplate(process.argv[2], values, process.argv[4] || undefined));
    ' "$_REP_LIB_DIR/engine-prompt.js" "$_id" "$_values_file" "$_body_key" 2>"$_err")
    local _rc=$?

    if [ "$_rc" -ne 0 ] || [ -z "$_out" ]; then
        # Loud, and naming the template. An agent invoked with an empty prompt answers
        # from nothing and the answer looks like every other answer.
        echo "[render-engine-prompt] FAILED to render '$_id': $(cat "$_err" 2>/dev/null)" >&2
        rm -f "$_err"
        return 1
    fi
    rm -f "$_err"
    printf '%s' "$_out"
}

# render_or_keep <template-id> <values-json-file> [<body-key>]
#
# Renders, or prints NOTHING and returns non-zero — so the caller's variable keeps whatever it
# already held instead of being blanked:
#
#     _r="$(render_or_keep writer-plan-section "$_vals" execution_plan)" && prompt="$_r"
#
# WHY. `prompt="$(render_engine_prompt ...)"` discards the exit status, so a dead render assigns
# the empty string. Live metrolinx AMSD-2041, 2026-08-19: jq hit the 128KB argv cap, both the
# writer prompt and the retry amendment silently became empty, and the run climbed the entire model
# ladder invoking agents with nothing in hand — visible as attempts returning in 0.01 min having
# consumed zero tokens. The header of this file already stated the rule the callers broke: exit
# status is the contract, and a caller must refuse rather than send an empty prompt.
#
# AN EMPTY SUCCESSFUL RENDER IS ALSO A FAILURE here. At the call site the two are the same event —
# an agent handed nothing — and only one of them was ever going to be noticed.
render_or_keep() {
    local _out _rc
    _out=$(render_engine_prompt "$@")
    _rc=$?
    if [ "$_rc" -ne 0 ] || [ -z "$_out" ]; then
        if command -v warning >/dev/null 2>&1; then
            warning "  [render] '${1:-?}' produced nothing (exit ${_rc}) — keeping the previous value rather than blanking it"
        else
            echo "[render-engine-prompt] '${1:-?}' produced nothing (exit ${_rc}) — caller keeps its previous value" >&2
        fi
        return 1
    fi
    printf '%s' "$_out"
}
