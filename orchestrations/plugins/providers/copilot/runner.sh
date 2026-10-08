#!/usr/bin/env bash
# The copilot provider plugin (config/providers.json runnerPlugin) — ONE call to the GitHub Copilot
# CLI, with the ladder's settings, judged by what it said. The engine calls provider_call from the
# seam hub and the story writer alike (lib/provider-plugin.sh): one place a copilot call is built.
#
#   provider_call <prompt_file> <result_json>
#
#   model / effort   AI_MODEL / EPAM_REASONING_EFFORT — the LADDER's values, in claude-set ids (the
#                    copilot set climbs the claude ladders). The model is mapped to the id Copilot serves;
#                    the effort is passed only when the catalog lists it for that model (copilot-models.js).
#   tool grant       EPAM_ALLOWED_TOOLS with AI_GATE_ALLOW_TOOLS=1, translated through the runner's
#                    declared toolNames and passed as --available-tools; no grant, the CLI's full set.
#   read roots       EPAM_READ_ROOTS (one per line): directories the PRD declares readable, as --add-dir.
#   result_json      the call in the claude runner's result shape (copilot-result.js).
#   the call's record  the raw JSONL, kept under $LOG_DIR/copilot-calls/ (beside result_json without one).
#
# stdout: the answer. Returns 0 when the call answered, 1 when it did not (the reason on stderr).
#
# Environment: COPILOT_GITHUB_TOKEN (the account, pinned by the provider set); EPAM_COPILOT_HOME (the CLI's
# state — install-local by default, so a run never reads or writes the operator's ~/.copilot);
# EPAM_COPILOT_CATALOG (the model catalog — fetched into the home when absent); COPILOT_CMD (the binary).
# The call runs under the caller's own timeout: the CLI retries a 429 by itself, for minutes.

_copilot_libdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_copilot_orch="$(cd "$_copilot_libdir/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/runner-settings.sh
declare -F apply_runner_settings >/dev/null 2>&1 || . "$_copilot_orch/scripts/lib/runner-settings.sh"

provider_call() {
    local prompt_file="${1:?prompt file}" result_json="${2:?result json}" keep="" root extra=()
    if [ -n "${LOG_DIR:-}" ]; then keep="$LOG_DIR/copilot-calls/$(date -u +%Y%m%dT%H%M%SZ)-${EPAM_AGENT_NAME:-call}-$$.jsonl"; fi
    while IFS= read -r root; do [ -n "$root" ] && extra+=(--add-dir "$root"); done <<< "${EPAM_READ_ROOTS:-}"
    # THE RUN'S OWN FILES ARE READABLE (AMSD-2974 runs 8, 10): a seam told to read the gate log or the PRD was refused
    # by the CLI — they live outside the codeline — and answered "no grounded finding". Each folder once.
    local _own _seen=" ${EPAM_READ_ROOTS:+${EPAM_READ_ROOTS//$'\n'/ }} "
    for _own in "${LOG_DIR:-}" "$( [ -n "${PRD_FILE:-}" ] && dirname "$PRD_FILE")" "$( [ -n "${MAIN_PRD_FILE:-}" ] && dirname "$MAIN_PRD_FILE")"; do
        [ -n "$_own" ] && [ -d "$_own" ] || continue
        case "$_seen" in *" $_own "*) continue ;; esac
        extra+=(--add-dir "$_own"); _seen="$_seen$_own "
    done
    copilot_invoke "$prompt_file" "${AI_MODEL:-}" "${EPAM_REASONING_EFFORT:-}" "$result_json" "${keep:---}" -- ${extra[@]+"${extra[@]}"}
}

copilot_invoke() {
    local prompt_file="${1:?prompt file}" model="${2:-}" effort="${3:-}" result_json="${4:?result json}"
    local events_keep="${5:-}"
    [ "$events_keep" = "--" ] && events_keep=""
    [ -n "$events_keep" ] || events_keep="${result_json%.json}.events.jsonl"
    local extra=()
    # SLOT 5 IS THE EVENTS-KEEP PATH, and "--" is its "none" placeholder — which is also the separator
    # that follows it. Consumed unless it IS the separator (a caller that passed no slot 5): taking
    # the placeholder for the separator sent the real "--" to the CLI, and every argument after it
    # (--add-dir, --available-tools) was read as a subcommand, whenever LOG_DIR was unset (2026-10-02).
    shift 4
    if [ $# -gt 0 ] && { [ "$1" != "--" ] || [ "${2:-}" = "--" ]; }; then shift; fi
    [ "${1:-}" = "--" ] && { shift; extra=("$@"); }
    local node="${NODE_BIN:-node}" bin="${COPILOT_CMD:-copilot}"
    local home="${EPAM_COPILOT_HOME:-$_copilot_orch/.copilot-home}"
    mkdir -p "$home" || { echo "[copilot] cannot create the CLI home $home" >&2; return 1; }
    local catalog="${EPAM_COPILOT_CATALOG:-$home/catalog.json}"

    # BYOK (COPILOT_PROVIDER_BASE_URL): the CLI sends the model name to the caller's own provider and
    # uses no GitHub catalog — so there is nothing to map through, and no catalog to say which efforts
    # the model takes (the CLI refuses every effort in this mode). The ladder's id goes as it is and no
    # effort is passed; said aloud. With a catalog declared, it is used as always.
    local byok=0
    [ -n "${COPILOT_PROVIDER_BASE_URL:-}" ] && [ -z "${EPAM_COPILOT_CATALOG:-}" ] && byok=1
    if [ "$byok" = 0 ] && [ ! -s "$catalog" ]; then
        "$node" "$_copilot_libdir/copilot-models.js" fetch "$catalog" >&2 \
            || { echo "[copilot] no model catalog at $catalog and it could not be fetched — refusing to guess a model" >&2; return 1; }
    fi

    local cmodel="" ceffort=""
    if [ "$byok" = 1 ]; then
        cmodel="$model"
        [ -n "$effort" ] && echo "[copilot] BYOK provider at $COPILOT_PROVIDER_BASE_URL: no catalog, so effort '$effort' is not passed" >&2
    elif [ -n "$model" ]; then
        cmodel="$(EPAM_COPILOT_CATALOG="$catalog" "$node" "$_copilot_libdir/copilot-models.js" map "$model")" || return 1
    fi
    if [ -n "$effort" ] && [ -n "$cmodel" ]; then
        ceffort="$(EPAM_COPILOT_CATALOG="$catalog" "$node" "$_copilot_libdir/copilot-models.js" effort "$cmodel" "$effort")"
    fi

    RUNNER_FLAGS=()
    apply_runner_settings copilot "${EPAM_PROJECT_CONFIG_DIR:-}" || true
    local args=(${RUNNER_FLAGS[@]+"${RUNNER_FLAGS[@]}"})
    [ -n "$cmodel" ] && args+=(--model "$cmodel")
    [ -n "$ceffort" ] && args+=(--reasoning-effort "$ceffort")
    [ "${#extra[@]}" -gt 0 ] && args+=("${extra[@]}")
    local tools=""
    if [ "${EPAM_MAX_TOOL_CALLS:-}" = "0" ]; then
        # A TOOL BUDGET OF 0 IS NO TOOLS — the hub's plan pass declares itself so. It was offered the
        # CLI's whole set (17 tools, bash among them) until 2026-09-29. The CLI reads an EMPTY
        # --available-tools as unset (every tool offered), so the list names a tool that does not
        # exist: nothing matches, nothing is offered (proven against the real CLI, copilot 1.0.85).
        args+=("--available-tools=__none__")
        tools="<none: budget 0>"
    elif [ "${AI_GATE_ALLOW_TOOLS:-0}" = "1" ] && [ -n "${EPAM_ALLOWED_TOOLS:-}" ] && tools="$(runner_tools_for_grant "$EPAM_ALLOWED_TOOLS")" && [ -n "$tools" ]; then
        args+=("--available-tools=${tools// /,}")
    fi
    echo "[copilot] model ${model:-<default>} -> ${cmodel:-<default>}; effort ${effort:-<none>} -> ${ceffort:-<not passed>}${tools:+; tools ${tools// /,}}" >&2

    local ev err rc
    ev="$(mktemp "${TMPDIR:-/tmp}/copilot-ev-XXXXXX")"; err="$(mktemp "${TMPDIR:-/tmp}/copilot-err-XXXXXX")"
    # PIPED, NOT REDIRECTED: the CLI reads a prompt from stdin only when stdin is a pipe. A redirected
    # file (`< prompt`) is answered "No prompt provided ... via standard in" with exit 0 (2026-09-27);
    # -p "<prompt>" would put a whole prompt on the argument list, which a large one exceeds.
    # NO COPILOT_AUTO_UPDATE=false: like --no-auto-update it pins the loader to the npm-bundled build,
    # which can be far older than the CLI the operator runs (1.0.18 vs 1.0.85, 2026-09-28) and refuses
    # current models. The build a call ran on is in the CLI's own log under $home/logs.
    # THE AGENT RUNS IN ITS OWN MEMORY SCOPE. An agent's shell tool can start anything — the AMSD-2974
    # writer ran a bare `npx jest` (a worker per core) and the run's scope was OOM-killed (2026-10-05);
    # telling it the declared command did not stop it (proven with a real call). Here a heavy command is
    # stopped at the ceiling of the agent's own scope (scripts/run-bounded.sh --high-pct 100: no throttle
    # band, which froze a command instead of failing it) and the agent sees it fail; the run carries on; the scope is bound to the run's, so killing the run stops it. Where bounding
    # is unavailable the call runs unbounded and run-bounded.sh says so.
    # NO `env` PREFIX: `env` is resolved on PATH, and a PATH entry named env that is not
    # coreutils' (uv's ~/.local/bin/env is a sourcing snippet) ran nothing and exited 0 — the call
    # "produced no answer and said nothing" (2026-10-05). The shell's own assignment prefix instead.
    if [ "${EPAM_AGENT_BOUNDED:-1}" = "1" ] && [ -x "$_copilot_orch/scripts/run-bounded.sh" ]; then
        cat "$prompt_file" | COPILOT_HOME="$home" NO_COLOR=1 EPAM_BOUNDED_ALLOW_UNBOUNDED=1 \
            "$_copilot_orch/scripts/run-bounded.sh" --share "${EPAM_AGENT_MEMORY_SHARE:-25}" --high-pct 100 --oom-policy continue -- "$bin" "${args[@]}" > "$ev" 2> "$err"
    else
        cat "$prompt_file" | COPILOT_HOME="$home" NO_COLOR=1 "$bin" "${args[@]}" > "$ev" 2> "$err"
    fi
    mkdir -p "$(dirname "$events_keep")" 2>/dev/null && cp "$ev" "$events_keep" 2>/dev/null || true
    "$node" "$_copilot_libdir/copilot-result.js" "$ev" "$err" "$result_json" "$home/session-state"
    rc=$?
    rm -f "$ev" "$err"
    return $rc
}
