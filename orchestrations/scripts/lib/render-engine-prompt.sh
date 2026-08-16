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
    local _id="$1" _values_file="$2"

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
        process.stdout.write(renderEngineTemplate(process.argv[2], values));
    ' "$_REP_LIB_DIR/engine-prompt.js" "$_id" "$_values_file" 2>"$_err")
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
