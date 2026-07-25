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
# ALWAYS ON. The feature switch was removed 2026-07-25 by explicit instruction:
# self-heal is not optional. A permanent off-switch on a feature that is supposed
# to be running is indistinguishable from the feature being broken — the exact
# failure mode this pipeline keeps hitting. These functions stay non-fatal (a KB
# problem must never fail a story) but they are never inert.
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
KB_LAST_SIGNATURE=""

kb_apply_constraints() {
    local _role="${1:-}" _sigs="${2:-}"
    KB_LAST_FIRED=""; KB_LAST_GATES=""

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
    if [ ! -f "$_cli" ] || ! command -v "$_node" >/dev/null 2>&1; then
        cat >/dev/null 2>&1 || true
        return 0
    fi
    # Keep the signature: it is the lookup key synthesis needs. Discarding it (the
    # previous `>/dev/null`) is why nothing could ever build a rule.
    KB_LAST_SIGNATURE="$("$_node" "$_cli" record \
        --story "$_story" --agent-role "$_role" --diagnosis "$_diag" \
        --phase "${PHASE:-}" --model "${STORY_MODEL:-}" 2>/dev/null || true)"
    return 0
}

# kb_verify_state — PILLAR 3. Confirm the enforced KB surface still matches what
# `apply` compiled. Between apply and execution a wrapper can re-export a default,
# a subshell can be spawned with a scrubbed env, or a later export can overwrite a
# knob — and the agent then runs UNCONSTRAINED while a healed rule is believed in
# force. Scoped to KB_STATE_VARS only; a no-op when nothing was applied.
# Returns non-zero on drift so the caller can refuse to invoke.
kb_verify_state() {
    local _cli="$_KB_APPLY_DIR/kb-cli.js"
    local _node="${NODE_BIN:-node}"
    [ -n "${KB_STATE_DIGEST:-}" ] || return 0
    [ -f "$_cli" ] || return 0
    command -v "$_node" >/dev/null 2>&1 || return 0
    "$_node" "$_cli" verify-state
}

# kb_maybe_synthesize <agent_role> [signature]
#
# Turn REPEATED episodes for one signature into a single arbitrated constraint.
# Without this the loop is record -> apply-finds-nothing forever: episodes pile up,
# no rule is ever built, and the KB looks enabled while doing nothing.
#
# Never fails the caller — a synthesis failure must not fail a story — but it is
# never SILENT either: kb-synthesizer quarantines every refusal with its reason
# (no_output / declined / unparseable / unmapped_rule).
kb_maybe_synthesize() {
    local _role="${1:-}" _sig="${2:-${KB_LAST_SIGNATURE:-}}"
    [ -n "$_role" ] && [ -n "$_sig" ] || return 0

    local _cli="$_KB_APPLY_DIR/kb-cli.js"
    local _node="${NODE_BIN:-node}"
    [ -f "$_cli" ] || return 0
    command -v "$_node" >/dev/null 2>&1 || return 0

    local _id
    _id="$("$_node" "$_cli" synthesize-auto --agent-role "$_role" --signature "$_sig" 2>/dev/null || true)"
    [ -n "$_id" ] && echo "  [SelfHeal/KB] constraint synthesised for ${_role}/${_sig}: ${_id}" >&2
    return 0
}

# kb_tick [fired-ids]
#
# PILLAR 2 ageing. Rules that fired stay alive; rules that did not advance toward
# their TTL and are archived for RE-VALIDATION rather than trusted indefinitely.
# Defaults to the ids the last apply reported.
kb_tick() {
    local _fired="${1:-${KB_LAST_FIRED:-}}"

    local _cli="$_KB_APPLY_DIR/kb-cli.js"
    local _node="${NODE_BIN:-node}"
    [ -f "$_cli" ] || return 0
    command -v "$_node" >/dev/null 2>&1 || return 0

    "$_node" "$_cli" tick --fired "$_fired" >/dev/null 2>&1 || true
    return 0
}
