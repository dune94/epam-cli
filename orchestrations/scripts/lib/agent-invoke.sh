#!/usr/bin/env bash
# agent-invoke.sh — the ONE door for every LLM agent invocation in the pipeline.
# ─────────────────────────────────────────────────────────────────────────────
# PATTERN: Parameter Object + Registry behind a Gateway, with fail-fast validation.
#
# Call sites do NOT set execution env vars any more. They name a ROLE:
#
#     source "$SCRIPT_DIR/lib/agent-invoke.sh"
#     out=$(printf '%s' "$prompt" | invoke_agent team-lead-review \
#             --model "$_model" --provider "$_provider" \
#             --json-result "$_review_json_result")
#
# The role is resolved from orchestrations/agents/invocation-profiles.json, which
# carries the full execution budget (output tokens, iterations, reasoning effort,
# temperature, allowed tools, timeout, cost capture). A caller cannot omit a
# parameter it never supplies — which is the entire point. See that file's _doc
# for the six live incidents this replaced.
#
# Routing (model/provider, ladder escalation) stays with the CALLER: it is genuinely
# per-site and dynamic. Only the execution budget is centralized.
#
# Fail-fast: an unknown role, or a profile missing a required key, ABORTS loudly.
# Silently falling back to a default is what let a reviewer run at 4096 tokens for
# months without anyone noticing.
# ─────────────────────────────────────────────────────────────────────────────

_AGENT_INVOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_PROFILES_REGISTRY="${AGENT_PROFILES_REGISTRY:-$(cd "$_AGENT_INVOKE_DIR/../.." && pwd)/agents/invocation-profiles.json}"

# Keys every resolved profile must have. Adding one here forces every profile to
# declare it — the registry test fails until they all do.
AGENT_INVOKE_REQUIRED_KEYS="maxOutputTokens maxIterations reasoningEffort timeoutSecs captureCost"

# agent_profile_get <role> <key> — resolved value (profile overrides defaults).
# Prints nothing and returns 1 if the role is unknown.
agent_profile_get() {
    local role="$1" key="$2"
    [ -f "$AGENT_PROFILES_REGISTRY" ] || return 1
    jq -er --arg r "$role" --arg k "$key" '
        if (.profiles | has($r) | not) then error("unknown-role")
        else (.profiles[$r][$k] // .defaults[$k] // empty) end
    ' "$AGENT_PROFILES_REGISTRY" 2>/dev/null
}

# agent_profile_validate <role> — abort unless the role exists and is complete.
agent_profile_validate() {
    local role="$1" k v missing=""
    if ! jq -e --arg r "$role" '.profiles | has($r)' "$AGENT_PROFILES_REGISTRY" >/dev/null 2>&1; then
        echo "[agent-invoke] FATAL: unknown agent role '$role' — add it to $AGENT_PROFILES_REGISTRY" >&2
        return 2
    fi
    for k in $AGENT_INVOKE_REQUIRED_KEYS; do
        v=$(agent_profile_get "$role" "$k") || v=""
        [ -n "$v" ] || missing="${missing:+$missing }$k"
    done
    if [ -n "$missing" ]; then
        echo "[agent-invoke] FATAL: role '$role' is missing required parameter(s): $missing" >&2
        echo "[agent-invoke]        an incomplete profile would run at provider defaults — refusing." >&2
        return 2
    fi
    return 0
}

# invoke_agent <role> [--model M] [--provider P] [--json-result FILE]
#              [--write-paths PATHS] [--runner CMD]
# Prompt on stdin, agent text on stdout. Exit code is the runner's.
invoke_agent() {
    local role="${1:?invoke_agent: role required}"; shift
    local _model="" _provider="" _json_result="" _write_paths="" _runner=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --model)       _model="${2:-}"; shift 2 ;;
            --provider)    _provider="${2:-}"; shift 2 ;;
            --json-result) _json_result="${2:-}"; shift 2 ;;
            --write-paths) _write_paths="${2:-}"; shift 2 ;;
            --runner)      _runner="${2:-}"; shift 2 ;;
            *) echo "[agent-invoke] unknown option '$1'" >&2; return 2 ;;
        esac
    done

    agent_profile_validate "$role" || return 2

    local _out_tok _max_iter _effort _timeout _capture _tools _temp
    _out_tok=$(agent_profile_get  "$role" maxOutputTokens)
    _max_iter=$(agent_profile_get "$role" maxIterations)
    _effort=$(agent_profile_get   "$role" reasoningEffort)
    _timeout=$(agent_profile_get  "$role" timeoutSecs)
    _capture=$(agent_profile_get  "$role" captureCost)
    _tools=$(agent_profile_get    "$role" allowedTools  || echo "")
    _temp=$(agent_profile_get     "$role" temperature   || echo "")

    # Per-role env override, for one-off tuning without editing the registry:
    #   AGENT_INVOKE_<ROLE>_MAX_OUTPUT_TOKENS   (role upper-cased, - → _)
    local _rk; _rk=$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')
    local _ov
    _ov="AGENT_INVOKE_${_rk}_MAX_OUTPUT_TOKENS"; [ -n "${!_ov:-}" ] && _out_tok="${!_ov}"
    _ov="AGENT_INVOKE_${_rk}_TIMEOUT_SECS";      [ -n "${!_ov:-}" ] && _timeout="${!_ov}"
    _ov="AGENT_INVOKE_${_rk}_REASONING_EFFORT";  [ -n "${!_ov:-}" ] && _effort="${!_ov}"

    local _cmd="${_runner:-${AI_RUNNER_CMD:-$_AGENT_INVOKE_DIR/../ai-run.sh}}"

    # ── Self-heal constraints (pillar 3) ────────────────────────────────────
    # Healed knowledge arrives here as ENV, never as prompt text. kb-cli apply
    # emits only `export` lines and a gate list — there is no channel by which a
    # constraint can degrade back into advice the model may ignore, which is what
    # COORDINATOR_PROMPT_AMENDMENT does today.
    #
    # Applied AFTER the profile defaults above and BEFORE dispatch, so a learned
    # constraint overrides the static default. Wholly inert unless the caller sets
    # KB_AGENT_ROLE + KB_SIGNATURES: no KB context, no behaviour change.
    local _kb_gates="" _kb_fired=""
    if [ -n "${KB_AGENT_ROLE:-}" ] && [ -n "${KB_SIGNATURES:-}" ]; then
        local _kb_cli="$_AGENT_INVOKE_DIR/kb-cli.js"
        local _kb_node="${NODE_BIN:-node}"
        if [ -f "$_kb_cli" ] && command -v "$_kb_node" >/dev/null 2>&1; then
            local _kb_out
            _kb_out=$("$_kb_node" "$_kb_cli" apply \
                        --agent-role "$KB_AGENT_ROLE" --signatures "$KB_SIGNATURES" 2>/dev/null || true)
            if [ -n "$_kb_out" ]; then
                # shellcheck disable=SC1090
                eval "$_kb_out"
                _kb_gates="${KB_GATES:-}"; _kb_fired="${KB_FIRED:-}"
                # Re-read the knobs a constraint is allowed to turn, so the learned
                # value wins over the profile default resolved above.
                [ -n "${EPAM_MAX_OUTPUT_TOKENS:-}" ] && _out_tok="$EPAM_MAX_OUTPUT_TOKENS"
                [ -n "${EPAM_MAX_ITERATIONS:-}" ]    && _max_iter="$EPAM_MAX_ITERATIONS"
                [ -n "${EPAM_REASONING_EFFORT:-}" ]  && _effort="$EPAM_REASONING_EFFORT"
                [ -n "${EPAM_ALLOWED_TOOLS:-}" ]     && _tools="$EPAM_ALLOWED_TOOLS"
                [ -n "${EPAM_ALLOWED_WRITE_PATHS:-}" ] && _write_paths="$EPAM_ALLOWED_WRITE_PATHS"
                [ -n "$_kb_fired" ] && echo "[agent-invoke] self-heal constraints applied: $_kb_fired" >&2
            fi
        fi
    fi

    # ORCH_JSON_RESULT is what the cost emitter reads. Before this gateway only 2 of
    # 15 sites set it, which is why per-agent cost was mostly blank on the dashboard.
    if [ "$_capture" = "true" ] && [ -z "$_json_result" ]; then
        _json_result="$(mktemp -t "agent-${role}-XXXXXX.json")"
    fi

    # `timeout` bounds a hung provider. No shell site had one before; a stuck call
    # simply held the pipeline open indefinitely.
    local -a _timeout_cmd=()
    command -v timeout >/dev/null 2>&1 && _timeout_cmd=(timeout --signal=TERM --kill-after=30 "$_timeout")

    # Built as an explicit `env` argument list, NOT as `VAR=v cmd` prefixes: bash only
    # treats a LITERAL `VAR=v` word as an assignment, so `${x:+VAR=v}` silently becomes
    # an argument instead — the conditional ones would never have been applied.
    local -a _env=(
        "AGENT_INVOKE_ROLE=$role"
        "AI_MODEL=${_model:-${AI_MODEL:-}}"
        "AI_PROVIDER=${_provider:-${AI_PROVIDER:-}}"
        "CLAUDE_CMD=${CLAUDE_CMD:-claude}"
        "EPAM_CLI=${EPAM_CLI:-epam}"
        "EPAM_MAX_OUTPUT_TOKENS=$_out_tok"
        "EPAM_MAX_ITERATIONS=$_max_iter"
        "EPAM_REASONING_EFFORT=$_effort"
    )
    [ -n "$_temp" ]        && _env+=("EPAM_TEMPERATURE=$_temp")
    [ -n "$_tools" ]       && _env+=("EPAM_ALLOWED_TOOLS=$_tools" "AI_GATE_ALLOW_TOOLS=1")
    [ -n "$_write_paths" ] && _env+=("EPAM_ALLOWED_WRITE_PATHS=$_write_paths" "EPAM_DANGEROUS_SKIP_APPROVAL=1")
    [ -n "$_json_result" ] && _env+=("ORCH_JSON_RESULT=$_json_result")

    local -a _args=()
    [ -n "$_provider" ] && _args+=(--provider "$_provider")
    [ -n "$_model" ]    && _args+=(--model "$_model")

    # Exported in a subshell rather than via `env`: this user's PATH carries a
    # ~/.local/bin/env that shadows coreutils and silently swallows the command
    # (exits 0, runs nothing). A gateway must not depend on PATH resolving `env`.
    (
        local _kv
        for _kv in "${_env[@]}"; do export "${_kv?}"; done
        exec "${_timeout_cmd[@]}" bash "$_cmd" ${_args[@]+"${_args[@]}"}
    )
}
