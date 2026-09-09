#!/usr/bin/env bash
# THE PIPELINE HAS TWO PROVIDER DISPATCHES, AND ONLY ONE OF THEM CAN REPLAY.
#
# lib/llm-handler.sh owns replay: EPAM_REPLAY_CASSETTE_DIR replaces every provider with the
# recording, and its own comment states the premise —
#
#   "Every model call in the pipeline, from bash and from JS alike, execs THIS script, so the
#    substitution belongs here and nowhere else."
#
# That is FALSE, and it is why rehearsal has never worked. claude.sh carries a SECOND dispatch
# inside implement_story — `case "$STORY_PROVIDER"` with its own arms invoking `"$CLAUDE_CMD"
# --print`, `codemie-claude --print` and the epam runner DIRECTLY. The writer, the single most
# expensive seam, never reaches llm-handler.sh at all.
#
# Measured 2026-09-09: a rehearsal with EPAM_REPLAY_CASSETTE_DIR correctly set in the process
# reported `provider=claude` on every attempt, printed "REHEARSAL: replaying" exactly zero times,
# and climbed the ladder to opus-5 over five failing attempts. The cassette was never opened.
#
# THIS DOES NOT REIMPLEMENT REPLAY. Duplicating the substitution in the second dispatch would give
# two implementations to keep in step, which is the defect one level up. It DELEGATES: when a
# recording is in play, the call is handed to ai-run.sh, which execs llm-handler.sh, which owns
# replay and always has.

# replay_delegate <prompt> <json_result_file> <output_file> [model]
#
# Returns 0 when it handled the call (the caller must then treat the invocation as done), and 1
# when no recording is in play, so the caller proceeds with its own dispatch exactly as before.
#
# A rehearsal that cannot delegate is a rehearsal that would silently reach a paid provider, so a
# missing runner is reported and refused rather than falling through.
replay_delegate() {
    local _prompt="${1:-}" _json_out="${2:-}" _log="${3:-/dev/null}" _model="${4:-}"

    [ -n "${EPAM_REPLAY_CASSETTE_DIR:-}" ] || return 1

    local _runner="${AI_RUNNER_CMD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../ai-run.sh}"
    if [ ! -f "$_runner" ]; then
        echo "[replay] a recording is in play but the runner is missing at $_runner —" >> "$_log"
        echo "[replay] REFUSING to fall through to a paid provider." >> "$_log"
        return 0
    fi

    echo "[replay] delegating this call to $_runner — the cassette owns it, not this dispatch" >> "$_log"

    local _args=()
    [ -n "$_model" ] && _args+=(--model "$_model")
    printf '%s' "$_prompt" | ORCH_JSON_RESULT="$_json_out" bash "$_runner" \
        ${_args[0]+"${_args[@]}"} >> "$_log" 2>&1
    return 0
}
