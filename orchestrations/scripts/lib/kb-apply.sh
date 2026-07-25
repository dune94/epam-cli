#!/usr/bin/env bash
# kb-apply.sh — apply stored self-heal constraints to the CURRENT shell's knobs.
# ─────────────────────────────────────────────────────────────────────────────
# One implementation, sourced by every caller (agent-invoke.sh, claude.sh), so a
# constraint means the same thing wherever it is applied.
#
# Healed knowledge arrives as ENV and gate ids — never as prompt text. That is the
# whole point of pillar 3: the existing path ends in COORDINATOR_PROMPT_AMENDMENT,
# appended prose that is silently trimmed past ~16000 chars and that nothing
# verifies the agent obeyed. A parameter cannot be softened over a long run.
#
# GUARDED BY EPAM_KB_SELFHEAL. Default OFF — with the flag unset this function
# returns immediately and a run behaves byte-for-byte as before, matching constraint
# stored or not. That is deliberate: this touches the live retry path, and "landed
# but inert" is the only safe way to put it in front of a real run.
#
#   kb_apply_constraints <agent_role> <comma-separated signatures>
#
# On a match it exports the compiled env AND mirrors the values onto the STORY_*
# variables claude.sh actually reads at the invocation site, since that is the knob
# the story path consults rather than EPAM_* directly.
# ─────────────────────────────────────────────────────────────────────────────

_KB_APPLY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ids of the constraints that fired most recently — the caller passes these to the
# arbitration TTL tick so a rule that keeps applying stays alive and one that never
# fires ages out for re-validation.
KB_LAST_FIRED=""
KB_LAST_GATES=""

kb_apply_constraints() {
    local _role="${1:-}" _sigs="${2:-}"
    KB_LAST_FIRED=""; KB_LAST_GATES=""

    [ "${EPAM_KB_SELFHEAL:-0}" = "1" ] || return 0
    [ -n "$_role" ] && [ -n "$_sigs" ] || return 0

    local _cli="$_KB_APPLY_DIR/kb-cli.js"
    local _node="${NODE_BIN:-node}"
    [ -f "$_cli" ] || return 0
    command -v "$_node" >/dev/null 2>&1 || return 0

    local _out
    if [ "${_sigs:0:6}" = "story:" ]; then
        _out=$("$_node" "$_cli" apply --agent-role "$_role" --story "${_sigs#story:}" 2>/dev/null || true)
    else
        _out=$("$_node" "$_cli" apply --agent-role "$_role" --signatures "$_sigs" 2>/dev/null || true)
    fi
    [ -n "$_out" ] || return 0

    # kb-cli apply emits only `export` lines — there is no free-text channel, so
    # this eval cannot introduce prose into the agent's context.
    # shellcheck disable=SC1090
    eval "$_out"

    KB_LAST_FIRED="${KB_FIRED:-}"
    KB_LAST_GATES="${KB_GATES:-}"

    # Mirror onto the story-path knobs. claude.sh reads STORY_* at the invocation
    # site (`EPAM_MAX_ITERATIONS="${STORY_MAX_ITERATIONS:-6}"`), so setting only the
    # EPAM_* name would be silently ignored there.
    [ -n "${EPAM_MAX_ITERATIONS:-}" ]    && STORY_MAX_ITERATIONS="$EPAM_MAX_ITERATIONS"
    [ -n "${EPAM_MAX_OUTPUT_TOKENS:-}" ] && STORY_MAX_OUTPUT_TOKENS="$EPAM_MAX_OUTPUT_TOKENS"

    [ -n "$KB_LAST_FIRED" ] && \
        echo "  [SelfHeal/KB] constraints applied for ${_role} (${_sigs}): ${KB_LAST_FIRED}" >&2
    return 0
}

# kb_record_episode <story_id> <agent_role> <diagnosis> — tool output on stdin.
# Additive: never fails the caller, because losing an episode must not fail a run.
kb_record_episode() {
    local _story="${1:-}" _role="${2:-}" _diag="${3:-}"
    local _cli="$_KB_APPLY_DIR/kb-cli.js"
    local _node="${NODE_BIN:-node}"

    # ALWAYS drain stdin, including on every early return. Callers pipe tool output
    # in (`head -c 8000 lint.log | kb_record_episode ...`); returning without
    # reading gives the upstream `head` a SIGPIPE, which under `set -o pipefail`
    # fails the caller's pipeline — i.e. a disabled feature could break a gate.
    if [ "${EPAM_KB_SELFHEAL:-0}" != "1" ] || [ ! -f "$_cli" ] || ! command -v "$_node" >/dev/null 2>&1; then
        cat >/dev/null 2>&1 || true
        return 0
    fi
    "$_node" "$_cli" record \
        --story "$_story" --agent-role "$_role" --diagnosis "$_diag" \
        --phase "${PHASE:-}" --model "${STORY_MODEL:-}" >/dev/null 2>&1 || true
    return 0
}
