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
#     exports each declared env var, appends declared flags to the RUNNER_FLAGS array, and
#     unsets each variable the runner declares it must not see.
#
# An UNDECLARED runner is a no-op returning 0: a path with no declaration must behave exactly
# as it did before runners existed. That is what keeps the openrouter/minimax flow untouched.
# ─────────────────────────────────────────────────────────────────────────────

# The resolved value for a settings name. An operator override wins, as everywhere else.
# clamp_flag_to_cli_range <binary> <--flag> <value>
#
# THE BINARY DECLARES WHAT IT ACCEPTS -- read it before spending.
#
# mock3 declares compaction.defaultAutoCompressAt=80000, written against a stack whose CLI took it.
# The installed claude CLI declares "--autocompact <auto|tokens>  Auto-compact window size (auto,
# or 100k-1M tokens)" and refuses 80000 outright, so every writer attempt died on argument
# validation before a token was sent (2026-08-28). The project's value is not wrong; it is wrong FOR
# THIS RUNNER, and no layer compared the two.
#
# Clamped, not refused: a window under the CLI's floor is a preference the binary cannot honour, and
# the nearest legal value keeps the run moving. Always said out loud -- a silently rewritten setting
# is its own defect.
#
# Emits the value to use. Anything it cannot read -- no help, no declared range, a non-numeric value
# such as "auto" -- passes through untouched: a guess is worse than the operator's own number.
clamp_flag_to_cli_range() {
    local _bin="${1:-}" _flag="${2:-}" _val="${3:-}"
    printf '%s' "$_val" | grep -qE '^[0-9]+$' || { printf '%s' "$_val"; return 0; }
    command -v "$_bin" >/dev/null 2>&1 || { printf '%s' "$_val"; return 0; }

    # The flag's own help entry, plus the wrapped continuation lines that carry the range.
    local _help _range
    # The CLI prints an EN DASH (U+2013), not a hyphen — normalised first, because a range that
    # does not match reads exactly like a CLI that declares none, and then nothing is checked.
    _help=$("$_bin" --help 2>&1 | grep -A2 -- "$_flag" | head -3 | sed 's/\xe2\x80\x93/-/g; s/\xe2\x80\x94/-/g') \
        || { printf '%s' "$_val"; return 0; }
    _range=$(printf '%s' "$_help" | grep -oE '[0-9]+[kKmM]?[[:space:]]*-[[:space:]]*[0-9]+[kKmM]?' | head -1)
    [ -n "$_range" ] || { printf '%s' "$_val"; return 0; }

    local _lo _hi
    _lo=$(printf '%s' "$_range" | grep -oE '^[0-9]+[kKmM]?')
    _hi=$(printf '%s' "$_range" | grep -oE '[0-9]+[kKmM]?$')
    _lo=$(_expand_magnitude "$_lo"); _hi=$(_expand_magnitude "$_hi")
    { [ -n "$_lo" ] && [ -n "$_hi" ]; } || { printf '%s' "$_val"; return 0; }

    if [ "$_val" -lt "$_lo" ]; then
        warning "  ${_flag}=${_val} is below what ${_bin} accepts (${_lo}-${_hi}) — using ${_lo}."
        printf '%s' "$_lo"; return 0
    fi
    if [ "$_val" -gt "$_hi" ]; then
        warning "  ${_flag}=${_val} is above what ${_bin} accepts (${_lo}-${_hi}) — using ${_hi}."
        printf '%s' "$_hi"; return 0
    fi
    printf '%s' "$_val"
}

# 100k -> 100000, 1M -> 1000000, 250 -> 250. The CLI writes its range in the short form.
_expand_magnitude() {
    local _n="${1:-}"
    case "$_n" in
        *k|*K) printf '%s' "$(( ${_n%[kK]} * 1000 ))" ;;
        *m|*M) printf '%s' "$(( ${_n%[mM]} * 1000000 ))" ;;
        *)     printf '%s' "$_n" ;;
    esac
}

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
      for (const n of (r.unsetEnv || [])) process.stdout.write("U " + n + "\n");
      for (const [k, v] of Object.entries(r.env))   process.stdout.write("E " + k + " " + v + "\n");
      for (const [k, v] of Object.entries(r.flags)) process.stdout.write("F " + k + " " + v + "\n");
    ' "$_resolver" "$_runner" "$_projdir" 2>/dev/null) || return 0
    [ -n "$_decl" ] || return 0

    local _kind _a _b _val
    while read -r _kind _a _b; do
        case "$_kind" in
            A)  RUNNER_FLAGS+=("$_a") ;;
            # A CREDENTIAL THE RUNNER PREFERS IS NOT REMOVED BY SETTING ANYTHING.
            # Claude Code picks ANTHROPIC_API_KEY over the OAuth credentials on disk, so with
            # the key present the subscription never pays — which is the only reason this
            # pipeline shells out to the CLI instead of calling the SDK. Seven runs billed the
            # wrong account before the credits ran dry and said so out loud.
            # Declared per runner, never global: the openrouter arm needs its key, and a MOCK
            # run needs its fake one — take that away and the run falls back to OAuth and
            # spends real money, the exact inversion this line must not cause.
            U)  unset "$_a" ;;
            E)  _val="$_b"
                # A SETTING WITH NO VALUE IS SKIPPED, NEVER EXPORTED EMPTY. A tool reading ""
                # may treat it as zero or as invalid; either way the operator sees a cap that
                # looks set and is not. Absent is honest; empty is a lie.
                [ -n "$_val" ] && export "${_a}=${_val}"
                ;;
            F)  _val="$_b"
                # THE BINARY'S OWN DECLARATION HAS THE LAST WORD. A project's value can be
                # perfectly good and still be refused by this runner — 80000 for --autocompact,
                # against a CLI whose floor is 100k, killed twelve attempts before any token was
                # sent. Costs one --help; the alternative cost a writer leg.
                [ -n "$_val" ] && _val=$(clamp_flag_to_cli_range "$_runner" "$_a" "$_val")
                [ -n "$_val" ] && RUNNER_FLAGS+=("$_a" "$_val")
                ;;
        esac
    done <<< "$_decl"
    return 0
}

# runner_name_for <provider> <claude_cmd_basename>
#
# WHICH RUNNER DECLARATION APPLIES — resolved from the CLI THAT WILL ACTUALLY BE INVOKED.
#
# Both call sites used to pass `basename "$CLAUDE_CMD"`, and CLAUDE_CMD is "claude" under every
# set: nothing assigns it from provider_to_cli, and the codemie arms invoke the literal string
# `codemie-claude` (claude.sh, llm-handler.sh) while CLAUDE_CMD stays "claude".
# llm-defaults.openrouter.json:235 already recorded the consequence —
#
#   "apply_runner_settings is called with the BASENAME of CLAUDE_CMD, which is 'claude' under every
#    set, so a set declaring no runner by that name resolves nothing and the flags, env and scrubs
#    of whatever ran before are simply carried over."
#
# claude, openrouter and mockserver each dodge it by declaring a runner literally named "claude".
# The codemie set declares "codemie-claude" — the binary it really invokes — and so resolved
# NOTHING. Its only alwaysFlags entry is `-s`, which its own declaration calls "a CORRECTNESS
# requirement, not a preference. Without it the wrapper opens an INTERACTIVE menu ... in a pipeline
# that is a HANG, not a failure: the run waits for a keypress until its timeout."
#
# FIRST HIT WINS, provider before CLAUDE_CMD. The three sets that name their runner "claude" keep
# resolving exactly as before — their provider name resolves nothing and the fallback finds them —
# and codemie starts resolving at all. Nothing is renamed, so no set has to remember a convention.
runner_name_for() {
    local _provider="${1:-}" _fallback="${2:-}"
    local _libdir _resolver
    _libdir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
    _resolver="$_libdir/llm-settings-resolve.js"

    if [ -n "$_provider" ] && [ -f "$_resolver" ] \
       && { [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; }; then
        if "${NODE_BIN:-node}" -e '
              const { resolveRunner } = require(process.argv[1]);
              process.exit(resolveRunner(process.argv[2]) ? 0 : 1);
            ' "$_resolver" "$_provider" 2>/dev/null; then
            printf '%s' "$_provider"
            return 0
        fi
    fi
    printf '%s' "$_fallback"
}

# runner_bin_for <provider> <fallback>
#
# THE BINARY THAT WILL ACTUALLY BE INVOKED, for capability probes.
#
# The probes that gate --json-schema and --max-budget-usd asked `"$CLAUDE_CMD" --help`, which is
# `claude` under every set. The codemie arm invokes `codemie-claude`, a WRAPPER whose own --help
# advertises only wrapper options and which forwards the rest to a DIFFERENT, older Claude Code
# (2.1.218 against 2.1.265 locally). So a flag was gated on one binary's help and handed to
# another — and a wrapper that does not forward it turns a cost control into a failed call.
#
# Derived from config/providers.json's own cliBinary map, so no vendor name appears here and a new
# provider needs no edit. $EPAM_CLI entries resolve to the epam runner, as provider_to_cli does.
runner_bin_for() {
    local _provider="${1:-}" _fallback="${2:-}"
    local _cfg _bin

    # AN EXPLICIT OVERRIDE WINS. CLAUDE_CMD is the documented substitution point
    # ("Allow override via environment", claude.sh) and is what a sandbox wrapper and every test
    # stub set. Deriving from the provider map would silently probe the REAL binary while the call
    # goes to the substitute — the same mistake this function exists to fix, pointed the other way.
    # Compared WHOLE, not by basename: a substitute is routinely named `claude` and merely lives
    # somewhere else (/tmp/.../claude in the budget-flag test, a sandbox wrapper on a private path).
    # Only the bare literal "claude" — the value claude.sh defaults to — means "nobody chose", and
    # only then does the provider map decide.
    if [ -n "$_fallback" ] && [ "$_fallback" != "claude" ]; then
        printf '%s' "$_fallback"; return 0
    fi
    _cfg="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../config/providers.json"
    if [ -n "$_provider" ] && [ -f "$_cfg" ] && command -v jq >/dev/null 2>&1; then
        _bin=$(jq -r --arg p "$_provider" '.cliBinary[$p] // empty' "$_cfg" 2>/dev/null)
        if [ "$_bin" = '$EPAM_CLI' ]; then
            printf '%s' "${EPAM_CLI:-epam}"; return 0
        fi
        if [ -n "$_bin" ]; then printf '%s' "$_bin"; return 0; fi
    fi
    printf '%s' "$_fallback"
}
