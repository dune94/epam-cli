#!/usr/bin/env bash
# copilot-runner.sh — ONE call to the GitHub Copilot CLI, with the ladder's settings, judged by what it said.
#
# Called by both paths a model call takes — the seam hub (llm-handler.sh) and the story writer
# (lib/story-attempt.sh) — so there is one place where a copilot call is built and read.
#
#   copilot_invoke <prompt_file> <model> <reasoning_effort> <result_json> [<events_keep>] [-- <extra args>...]
#
#   model / effort   the LADDER's values, in claude-set ids (the copilot set climbs the claude ladders).
#                    The model is mapped to the id Copilot serves; the effort is passed only when the
#                    catalog lists it for that model (lib/copilot-models.js). An unsupported one would be
#                    an error the CLI exits 0 on.
#   tool grant       EPAM_ALLOWED_TOOLS with AI_GATE_ALLOW_TOOLS=1, translated through the runner's
#                    declared toolNames and passed as --available-tools (proven: only those reach the model).
#   result_json      the call in the claude runner's result shape (lib/copilot-result.js): cost, retry and
#                    self-heal read it like a claude result. error.class=credit marks an exhausted account.
#   events_keep      where the raw JSONL is kept (the call's own record); default: beside result_json.
#   extra args       after `--`: flags the caller owns (the story writer's --add-dir <declared read root>).
#
# stdout: the answer. Returns 0 when the call answered, 1 when it did not (the reason on stderr).
#
# Environment: COPILOT_GITHUB_TOKEN (the account, pinned by the provider set); EPAM_COPILOT_HOME (the CLI's
# state — install-local by default, so a run never reads or writes the operator's ~/.copilot);
# EPAM_COPILOT_CATALOG (the model catalog — fetched into the home when absent); COPILOT_CMD (the binary).
# The call runs under the caller's own timeout: the CLI retries a 429 by itself, for minutes.

_copilot_libdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=runner-settings.sh
declare -F apply_runner_settings >/dev/null 2>&1 || . "$_copilot_libdir/runner-settings.sh"

copilot_invoke() {
    local prompt_file="${1:?prompt file}" model="${2:-}" effort="${3:-}" result_json="${4:?result json}"
    local events_keep="${5:-}"
    [ "$events_keep" = "--" ] && events_keep=""
    [ -n "$events_keep" ] || events_keep="${result_json%.json}.events.jsonl"
    local extra=()
    shift 4; [ $# -gt 0 ] && [ "$1" != "--" ] && shift
    [ "${1:-}" = "--" ] && { shift; extra=("$@"); }
    local node="${NODE_BIN:-node}" bin="${COPILOT_CMD:-copilot}"
    local home="${EPAM_COPILOT_HOME:-$(cd "$_copilot_libdir/../.." && pwd)/.copilot-home}"
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
    if [ "${AI_GATE_ALLOW_TOOLS:-0}" = "1" ] && [ -n "${EPAM_ALLOWED_TOOLS:-}" ] && tools="$(runner_tools_for_grant "$EPAM_ALLOWED_TOOLS")" && [ -n "$tools" ]; then
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
    cat "$prompt_file" | COPILOT_HOME="$home" NO_COLOR=1 "$bin" "${args[@]}" > "$ev" 2> "$err"
    mkdir -p "$(dirname "$events_keep")" 2>/dev/null && cp "$ev" "$events_keep" 2>/dev/null || true
    "$node" "$_copilot_libdir/copilot-result.js" "$ev" "$err" "$result_json" "$home/session-state"
    rc=$?
    rm -f "$ev" "$err"
    return $rc
}
