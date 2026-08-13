#!/usr/bin/env bash
# NAMED RUN MODES. "Resume the writer" is one word, not six variables to remember.
#
# On 2026-08-13 an operator asked for a writer resume. It was launched with three environment
# variables and needed six, so the CPA pre-pass, the pre-phase skill assessment and the regression
# guard ran anyway — each a separate default-ACTIVE step, none tied to the stated intent. The
# operator noticed four minutes in.
#
# THIS FILE KNOWS NO MODES. It reads orchestrations/config/run-modes.json. Adding a mode is a
# config edit; the engine never learns a mode's name.
#
# TWO RULES:
#   FAILS CLOSED — an unknown mode, or a declaration file that will not parse, is a hard error.
#     Silently ignoring either runs every gate the operator believed they had turned off.
#   THE OPERATOR WINS — a variable already set in the environment is never overwritten. A mode is
#     a set of defaults for an intent, not a straitjacket: writer-only WITH the regression baseline
#     is a legitimate thing to ask for.

RUN_MODES_FILE="${RUN_MODES_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../config/run-modes.json}"

# run_mode_env <mode> — print the KEY=VALUE lines a mode declares. Non-zero if unknown.
run_mode_env() {
    local _mode="${1:-}"
    [ -n "$_mode" ] || return 0
    "${NODE_BIN:-node}" -e '
      const fs = require("fs");
      const [file, mode] = process.argv.slice(1);
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        process.stderr.write(`run-modes: cannot read ${file}: ${e.message}\n`);
        process.exit(2);
      }
      const modes = doc.modes || {};
      if (!Object.prototype.hasOwnProperty.call(modes, mode)) {
        process.stderr.write(`run-modes: unknown mode "${mode}". Declared: ${Object.keys(modes).join(", ")}\n`);
        process.exit(3);
      }
      const skips = modes[mode].skips || [];
      process.stdout.write(skips.join("\n") + (skips.length ? "\n" : ""));
    ' "$RUN_MODES_FILE" "$_mode"
}

# apply_run_mode <mode> — export what the mode declares, leaving anything already set alone.
apply_run_mode() {
    local _mode="${1:-}"
    [ -n "$_mode" ] || return 0

    local _env
    _env=$(run_mode_env "$_mode") || {
        if command -v error >/dev/null 2>&1; then
            error "[run-mode] refusing to run: mode '$_mode' is not declared in $RUN_MODES_FILE"
        else
            printf '[run-mode] refusing to run: mode %s is not declared in %s\n' "$_mode" "$RUN_MODES_FILE" >&2
        fi
        return 1
    }

    local _line _key _val _already
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        _key="${_line%%=*}"
        _val="${_line#*=}"
        # Already set by the operator? Leave it. A mode supplies defaults for an intent.
        _already="$(eval printf '%s' "\${${_key}+set}")"
        if [ "$_already" = "set" ]; then
            continue
        fi
        eval "export ${_key}=\"\$_val\""
    done <<< "$_env"

    RESOLVED_RUN_MODE="$_mode"
    export RESOLVED_RUN_MODE
    return 0
}
