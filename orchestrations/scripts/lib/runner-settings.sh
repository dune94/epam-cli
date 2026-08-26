#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# runner-settings.sh — give an external CLI the budgets its declaration names.
#
# WHY THIS EXISTS. The engine has two execution paths and they were asymmetric.
# `ai-run` receives EPAM_MAX_ITERATIONS, EPAM_AUTO_COMPRESS_AT, EPAM_MAX_OUTPUT_TOKENS and
# EPAM_MAX_TOOL_CALLS as environment. The external-CLI branch received only --model, a dead
# --max-turns and permissions — so on that path EVERY cap was inert. Measured 2026-08-23: one
# seam ran 1,486 generations in 44 continuous minutes for $1.43, and nothing in the pipeline
# could stop it, because nothing in the pipeline was telling it to stop.
#
# NO KNOB NAME APPEARS HERE. A runner declares `alwaysFlags`, `env` and `flags` in the provider
# set's settings file; this reads the declaration and passes what it names. Adding a knob is a
# config edit. That is also what makes it testable against a FIXTURE runner the engine has
# never heard of — if the mechanism works for that, it works for any.
#
#   apply_runner_settings <runner-name> <project-config-dir>
#     exports each declared env var, and appends declared flags to the RUNNER_FLAGS array.
#
# An UNDECLARED runner is a no-op returning 0: a path with no declaration must behave exactly
# as it did before runners existed. That is what keeps the openrouter/minimax flow untouched.
# ─────────────────────────────────────────────────────────────────────────────

# The resolved value for a settings name. An operator override wins, as everywhere else.
apply_runner_settings() {
    local _runner="${1:-}" _projdir="${2:-}"
    [ -n "$_runner" ] || return 0

    local _libdir _resolver
    _libdir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
    _resolver="$_libdir/llm-settings-resolve.js"
    [ -f "$_resolver" ] || return 0
    { [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; } || return 0

    # The declaration, flattened to lines this shell can read without a JSON parser:
    #   E <ENV_NAME> <settingsName>
    #   F <--flag>   <settingsName>
    #   A <flag>
    # RESOLVED VALUES, not just names. runnerValues() applies the same precedence everywhere
    # else uses — operator override first, then what the stack declares — so a value the
    # settings file supplies (a mock endpoint, say) actually reaches the runner instead of
    # being silently skipped for want of an EPAM_RUNNER_VALUE_* override.
    local _decl
    _decl=$("${NODE_BIN:-node}" -e '
      const { runnerValues } = require(process.argv[1]);
      const r = runnerValues(process.argv[2], { projectConfigDir: process.argv[3] || undefined });
      if (!r) process.exit(0);
      for (const f of r.alwaysFlags) process.stdout.write("A " + f + "\n");
      for (const [k, v] of Object.entries(r.env))   process.stdout.write("E " + k + " " + v + "\n");
      for (const [k, v] of Object.entries(r.flags)) process.stdout.write("F " + k + " " + v + "\n");
    ' "$_resolver" "$_runner" "$_projdir" 2>/dev/null) || return 0
    [ -n "$_decl" ] || return 0

    local _kind _a _b _val
    while read -r _kind _a _b; do
        case "$_kind" in
            A)  RUNNER_FLAGS+=("$_a") ;;
            E)  _val="$_b"
                # A SETTING WITH NO VALUE IS SKIPPED, NEVER EXPORTED EMPTY. A tool reading ""
                # may treat it as zero or as invalid; either way the operator sees a cap that
                # looks set and is not. Absent is honest; empty is a lie.
                [ -n "$_val" ] && export "${_a}=${_val}"
                ;;
            F)  _val="$_b"
                [ -n "$_val" ] && RUNNER_FLAGS+=("$_a" "$_val")
                ;;
        esac
    done <<< "$_decl"
    return 0
}
