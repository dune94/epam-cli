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
#   PRECEDENCE IS operator environment > mode > config-file default. A mode must beat a default
#     (config.env carries SKIP_REGRESSION_GUARD=false, which silently defeated writer-only) while
#     still yielding to a deliberate choice on the launch command — writer-only WITH the regression
#     baseline is a legitimate thing to ask for. The two are only distinguishable before the config
#     files load, which is what snapshot_operator_env captures.

RUN_MODES_FILE="${RUN_MODES_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../config/run-modes.json}"

# snapshot_operator_env — record which variables the OPERATOR set, before any config file is read.
#
# A mode must override a config-file DEFAULT (config.env carries SKIP_REGRESSION_GUARD=false, which
# silently defeated writer-only on 2026-08-13) while still yielding to a deliberate choice on the
# launch command. Those two are indistinguishable once both are in the environment — unless you
# look BEFORE the config files load, which is the one moment only the operator's values exist.
#
# Launchers call this before their first load_env_file_safe. A caller that never calls it gets the
# mode applied in full, which is the safe failure: a half-applied intent is worse than none.
snapshot_operator_env() {
    EPAM_OPERATOR_SET_VARS=" $(compgen -e 2>/dev/null | tr '\n' ' ')"
    export EPAM_OPERATOR_SET_VARS
}

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
        # Set by the OPERATOR — before any config file was read — so it wins. A value that only
        # appeared once config.env loaded is a project default, and the mode is more specific than
        # a default: the operator named this intent on the command line.
        case "${EPAM_OPERATOR_SET_VARS:-}" in
            *" ${_key} "*) continue ;;
        esac
        eval "export ${_key}=\"\$_val\""
    done <<< "$_env"

    RESOLVED_RUN_MODE="$_mode"
    export RESOLVED_RUN_MODE
    return 0
}
