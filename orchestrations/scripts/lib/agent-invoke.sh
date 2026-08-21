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
# maxIterations is NOT here: the LADDER defines it, not the profile. Operator rule,
# 2026-08-21 — a rung is (model, effort, room to work), and a stronger rung is given more
# room, which a per-agent literal freezes. It is still REQUIRED; it is required of the
# ladder instead, and checked below against the resolved value rather than the declaration.
# Dropping it from this list without that check would reinstate exactly what this file
# exists to prevent: "a reviewer running at 4096 tokens for months without anyone noticing".
AGENT_INVOKE_REQUIRED_KEYS="maxOutputTokens reasoningEffort timeoutSecs captureCost"

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
    # THE EXECUTION BUDGET IS STILL REQUIRED — of the ladder now, not the profile.
    #
    # Resolved through the same gateway the seam itself uses, so this check cannot drift from
    # what the agent will actually run with. Empty means neither the profile nor the rung
    # declares one, and the agent would fall through to the engine's own default — a number
    # nobody chose, which is the condition this whole file refuses to start on.
    #
    # Gated on a ladder actually being loaded. With no EPAM_MODEL_ITERATIONS in the process
    # there is no ladder to ask, and that is model-ladders.sh's failure to report — it already
    # refuses loudly on an unreadable or ladder-less settings file. Making it fatal a second
    # time here would refuse every caller that invokes an agent before loading a project,
    # which is a different fault with a much wider blast radius.
    if [ -n "${EPAM_MODEL_ITERATIONS:-}" ] \
       && [ -z "$(agent_profile_get "$role" maxIterations 2>/dev/null || true)" ]; then
        local _lad_iters
        _lad_iters=$("${NODE_BIN:-node}" -e '
            try {
              const { seamInvocationEnv } = require(process.argv[1] + "/seam-invocation.js");
              process.stdout.write(String((seamInvocationEnv(process.argv[2]) || {}).EPAM_MAX_ITERATIONS || ""));
            } catch (_) { process.stdout.write(""); }
          ' "$_AGENT_INVOKE_DIR" "$role" 2>/dev/null || printf '')
        [ -n "$_lad_iters" ] || missing="${missing:+$missing }maxIterations(from the ladder)"
    fi

    if [ -n "$missing" ]; then
        echo "[agent-invoke] FATAL: role '$role' is missing required parameter(s): $missing" >&2
        echo "[agent-invoke]        an incomplete profile would run at provider defaults — refusing." >&2
        return 2
    fi
    return 0
}

# invoke_agent <role> [--model M] [--provider P] [--json-result FILE]
#              [--write-paths PATHS] [--tools LIST] [--codeline PATH] [--runner CMD]
# Prompt on stdin, agent text on stdout. Exit code is the runner's.
# ladder_chain_for_position <base|mid|top> — the project's chain for that RUNG.
#
# A seam declares a POSITION, never a tier name; agents/invocation-profiles.json says so in its own
# _ladderPositions note, and it is right: metrolinx calls its tiers medium/high/highest and another
# project may call them anything. The engine must know neither vocabulary.
#
# This did a NAME lookup -- position "top" became EPAM_MODEL_LADDER_TOP -- while the project exports
# EPAM_MODEL_LADDER_HIGHEST. It never matched, so all 38 profiles that declare a ladder fell through
# to the run default and said so quietly in every log:
#
#   [agent-invoke] role 'team-lead-review' asks for ladder 'top' but EPAM_MODEL_LADDER_TOP is not
#                  set -- using the run's default ladder
#
# THE POSITION->TIER RULE IS NOT REIMPLEMENTED HERE. seam-invocation.js::resolveTierPosition already
# owns it and three other callers go through it; a second copy in bash is a second thing to keep
# right, and the copy this replaced had already drifted -- it read `mid` as len/2 where the JS reads
# floor((len-1)/2), so the two disagreed for any project declaring an even number of tiers.
#
# An empty answer stays empty: the caller reports the gap rather than guessing a chain.
ladder_chain_for_position() {
    local _pos="${1:-}"
    [ -n "$_pos" ] || return 1

    local _lib_dir _tier
    _lib_dir="${_AGENT_INVOKE_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
    _tier=$("${NODE_BIN:-node}" -e '
      try {
        const { resolveTierPosition } = require(process.argv[1]);
        process.stdout.write(resolveTierPosition(process.argv[2], process.env));
      } catch (_) { process.stdout.write(""); }
    ' "$_lib_dir/seam-invocation.js" "$_pos" 2>/dev/null || printf '')
    [ -n "$_tier" ] || return 1

    # Same sanitisation as the per-role override below, and for the same reason: '[:lower:]-'
    # leaves every other invalid character in place, and a tier name carrying one would build
    # a variable bash refuses. Assigned separately so the pipeline's status is not masked.
    local _tvar _var
    _tvar=$(printf '%s' "$_tier" | tr '[:lower:]' '[:upper:]' | tr -c '[:alnum:]\n' '_')
    _var="EPAM_MODEL_LADDER_${_tvar}"
    printf '%s' "${!_var:-}"
    [ -n "${!_var:-}" ]
}

invoke_agent() {
    local role="${1:?invoke_agent: role required}"; shift
    local _model="" _provider="" _json_result="" _write_paths="" _runner="" _tools_override=""
    local _codeline="${PROJECT_ROOT:-}"

    while [ $# -gt 0 ]; do
        case "$1" in
            --model)       _model="${2:-}"; shift 2 ;;
            --provider)    _provider="${2:-}"; shift 2 ;;
            --json-result) _json_result="${2:-}"; shift 2 ;;
            --write-paths) _write_paths="${2:-}"; shift 2 ;;
            # A TOOL GRANT COMPUTED AT THE CALL SITE. The registry cannot know which plugin tools a
            # given codeline provisioned, and team-lead-review appends exactly those. Dynamic
            # per-site values belong to the caller by design -- the same reasoning that keeps model
            # and provider here; only the execution budget is centralised.
            --tools)       _tools_override="${2:-}"; shift 2 ;;
            # WHICH CODELINE the grant is resolved against: the plugin tools a grant includes are
            # whatever THAT repository provisioned, so the answer is per-codeline.
            --codeline)    _codeline="${2:-}"; shift 2 ;;
            --runner)      _runner="${2:-}"; shift 2 ;;
            *) echo "[agent-invoke] unknown option '$1'" >&2; return 2 ;;
        esac
    done

    agent_profile_validate "$role" || return 2

    local _out_tok _max_iter _effort _timeout _capture _tools _temp _ladder
    _out_tok=$(agent_profile_get  "$role" maxOutputTokens)
    # THE LADDER DEFINES ITERATIONS. The profile is consulted first only so a project
    # mid-migration is not left with none; where it is silent — which is now every profile —
    # the budget comes from the rung this role resolves to, through the same gateway the seam
    # itself uses, so the two cannot disagree. See lib/model-settings.js.
    _max_iter=$(agent_profile_get "$role" maxIterations 2>/dev/null || true)
    if [ -z "$_max_iter" ]; then
        _max_iter=$("${NODE_BIN:-node}" -e '
            try {
              const { seamInvocationEnv } = require(process.argv[1] + "/seam-invocation.js");
              process.stdout.write(String((seamInvocationEnv(process.argv[2]) || {}).EPAM_MAX_ITERATIONS || ""));
            } catch (_) { process.stdout.write(""); }
          ' "$_AGENT_INVOKE_DIR" "$role" 2>/dev/null || printf '')
    fi
    _effort=$(agent_profile_get   "$role" reasoningEffort)
    _timeout=$(agent_profile_get  "$role" timeoutSecs)
    _capture=$(agent_profile_get  "$role" captureCost)
    _tools=$(agent_profile_get    "$role" allowedTools  || echo "")
    _temp=$(agent_profile_get     "$role" temperature   || echo "")
    # WHICH LADDER THIS SEAM CLIMBS — data, not policy in code.
    #
    # The profile names a ladder ("ladder": "<name>"); the models in it come from the
    # project's own config as EPAM_MODEL_LADDER_<NAME>. So which seams get a stronger
    # ladder is an edit to the registry, and which models that ladder contains is an edit
    # to the project — neither is a change to this script, and no seam, ladder or model
    # name appears here.
    _ladder=$(agent_profile_get   "$role" ladder        || echo "")
    # THE TOOL-CALL BUDGET IS PART OF THE EXECUTION BUDGET, and was the one piece of it still
    # written at a call site. team-lead-review.sh set EPAM_MAX_TOOL_CALLS itself, with the comment
    # that it and the iteration cap "bound different failures, so both are set" -- which is exactly
    # the argument for the registry owning both.
    local _tool_calls
    _tool_calls=$(agent_profile_get "$role" maxToolCalls || echo "")
    # THE TOOL GRANT THE PROFILE DECLARES, resolved for this codeline.
    #
    # Profiles have carried "toolGrant" all along and this read only "allowedTools", which they do
    # not set -- so the declared grant reached nothing and every call site wrote its own literal
    # list instead. lib/agent-tools.js already turns a grant kind into the read-only floor plus the
    # plugin tools that codeline provisioned plus what the kind adds, and THROWS on a kind the
    # engine does not define. An explicit --tools still wins, for a grant only the caller can know.
    local _grant
    _grant=$(agent_profile_get "$role" toolGrant || echo "")
    if [ -z "$_tools_override" ] && [ -n "$_grant" ]; then
        local _grant_tools _grant_rc=0
        _grant_tools=$("${NODE_BIN:-node}" -e '
          const { toolGrantFor } = require(process.argv[1]);
          process.stdout.write(toolGrantFor(process.argv[2], process.argv[3] || []) || "");
        ' "$_AGENT_INVOKE_DIR/agent-tools.js" "$_grant" "$_codeline" 2>&1) || _grant_rc=$?
        if [ "$_grant_rc" -ne 0 ]; then
            echo "[agent-invoke] FATAL: role '$role' declares toolGrant '$_grant' and it could not be resolved:" >&2
            printf '%s\n' "$_grant_tools" | sed 's/^/[agent-invoke]        /' >&2
            return 2
        fi
        _tools="$_grant_tools"
    fi
    [ -n "$_tools_override" ] && _tools="$_tools_override"

    # Per-role env override, for one-off tuning without editing the registry:
    #   AGENT_INVOKE_<ROLE>_MAX_OUTPUT_TOKENS   (role upper-cased, non-alphanumerics → _)
    #
    # EVERY invalid character, not just the hyphen. This mapped '[:lower:]-' only, so a role
    # with a colon in its name built the variable AGENT_INVOKE_QA_GATE:SAST_MAX_OUTPUT_TOKENS
    # and bash aborted the invocation with "invalid variable name" — which took out all seven
    # qa-gate:* seams, every one of them a QA sentinel, through this gateway. Found 2026-08-21
    # while auditing agent wiring; the seams ran only because their other call path builds no
    # such name.
    local _rk; _rk=$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]' | tr -c '[:alnum:]\n' '_')
    local _ov
    _ov="AGENT_INVOKE_${_rk}_MAX_OUTPUT_TOKENS"; [ -n "${!_ov:-}" ] && _out_tok="${!_ov}"
    _ov="AGENT_INVOKE_${_rk}_TIMEOUT_SECS";      [ -n "${!_ov:-}" ] && _timeout="${!_ov}"
    _ov="AGENT_INVOKE_${_rk}_REASONING_EFFORT";  [ -n "${!_ov:-}" ] && _effort="${!_ov}"
    _ov="AGENT_INVOKE_${_rk}_LADDER";            [ -n "${!_ov:-}" ] && _ladder="${!_ov}"

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
                # TEMPERATURE IS A KNOB A CONSTRAINT MAY TURN. It was missing from this list,
                # which went unnoticed only because no profile set a temperature — an empty
                # profile value left the constraint's own export in place. The moment a seam
                # was given a temperature, the static profile silently overrode a learned
                # constraint, which is the exact inversion this block exists to prevent.
                [ -n "${EPAM_TEMPERATURE:-}" ]       && _temp="$EPAM_TEMPERATURE"
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
    [ -n "$_tool_calls" ]  && _env+=("EPAM_MAX_TOOL_CALLS=$_tool_calls")
    # Resolve the named ladder from the project's config. Absent or unset: this seam simply
    # climbs whatever ladder the run already provides — never a silent fallback to something
    # this script chose.
    if [ -n "$_ladder" ]; then
        local _ladder_chain
        _ladder_chain=$(ladder_chain_for_position "$_ladder" 2>/dev/null || true)
        if [ -n "$_ladder_chain" ]; then
            _env+=("EPAM_MODEL_LADDER_HIGH=$_ladder_chain" "EPAM_MODEL_LADDER=$_ladder_chain")
        else
            echo "[agent-invoke] role '$role' asks for ladder position '$_ladder' but the project's ladderTierOrder does not supply it — using the run's default ladder" >&2
        fi
    fi
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
