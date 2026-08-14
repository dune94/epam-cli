#!/usr/bin/env bash
# EVERY AGENT CLIMBS A LADDER — not only the story writer.
#
# The InferenceLadder lives in the story path: it reads STORY_MODEL, consults the tier's chain and
# re-invokes. Gate agents — the failure analyst, the reviewer, the coverage check, the spec
# validator — are invoked with ORCH_GATE_MODEL, one fixed pair for the whole run. They have no
# rung, no attempt count, and nothing to escalate.
#
# The cost showed live on 2026-08-14. Self-heal declared HealingBroken — "same violation repeated
# without resolution", meaning its own remedy had been applied twice and had not worked — and the
# only actor that could diagnose WHY runs at a fixed model that never escalates. The system
# correctly identified that its remedy was broken and had nowhere to go.
#
# WHAT IS DECLARED AND WHAT IS DERIVED
#
#   which ladder an agent climbs   the `ladder` field on its ARCHETYPE (invocation-profiles.json),
#                                  reached through the seam, so a minted instance inherits it
#   the chain for that ladder      EPAM_MODEL_LADDER_<TIER>, exported by lib/model-ladders.sh from
#                                  the settings file
#   whether to climb               a recorded failure for THIS agent on THIS story
#
# No model name and no tier name appears in this file. An archetype that declares no ladder simply
# does not climb: absent is absent, never a guessed default.
#
# THE STATE DIES WITH THE RUN. Rung state lives under LOG_DIR, which the pre-run reset clears. A
# rung that outlives its run escalates a fresh attempt for a previous run's failure — the defect
# already recorded for the story retry counters, and for the rejection key.

# _agent_ladder_state_file <agent> <story> — where this agent's rung for this story is kept.
# Per AGENT and per STORY: an analyst failing on one story must not escalate every other agent.
_agent_ladder_state_file() {
    local _agent="${1:-}" _story="${2:-}" _dir
    _dir="${LOG_DIR:-/tmp}/agent-ladder"
    mkdir -p "$_dir" 2>/dev/null || true
    printf '%s/%s.%s' "$_dir" \
        "$(printf '%s' "$_agent"  | tr -c '[:alnum:]._-' '_')" \
        "$(printf '%s' "$_story" | tr -c '[:alnum:]._-' '_')"
}

# agent_ladder_record_failure <agent> <story>
# One failure = one rung. Call it where the agent's answer is judged unusable — not where the
# agent merely ran, or a slow-but-correct answer would climb until it ran out of ladder.
agent_ladder_record_failure() {
    local _agent="${1:-}" _story="${2:-}" _f _n
    [ -n "$_agent" ] && [ -n "$_story" ] || return 0
    _f=$(_agent_ladder_state_file "$_agent" "$_story")
    _n=0
    [ -f "$_f" ] && _n=$(cat "$_f" 2>/dev/null || echo 0)
    case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
    printf '%s' "$((_n + 1))" > "$_f" 2>/dev/null || true
    return 0
}

# _agent_ladder_tier <agent> — the ladder this agent's ARCHETYPE declares, lowercased.
_agent_ladder_tier() {
    local _agent="${1:-}"
    [ -n "$_agent" ] || { printf ''; return 0; }
    "${NODE_BIN:-node}" -e '
      const { resolveSeam } = require(process.argv[1]);
      try {
        const reg = process.argv[2];
        const seam = resolveSeam(process.argv[3], reg);
        const p = JSON.parse(require("fs").readFileSync(reg, "utf8")).profiles[seam] || {};
        process.stdout.write(String(p.ladder || "").toLowerCase());
      } catch (_) { process.stdout.write(""); }
    ' "${SCRIPT_DIR:-.}/lib/seam-invocation.js" \
      "${AGENT_PROFILES_REGISTRY:-${EPAM_AGENTS_DIR:-.}/invocation-profiles.json}" \
      "$_agent" 2>/dev/null || printf ''
}

# agent_ladder_model <agent> <story> <current-model>
#
# The model this agent should use for its NEXT attempt. Steps one rung per recorded failure, along
# the chain its archetype's tier declares. At the top of its chain it stays there — a caller that
# needs to know it is exhausted asks agent_ladder_exhausted.
agent_ladder_model() {
    local _agent="${1:-}" _story="${2:-}" _current="${3:-}"
    [ -n "$_current" ] || { printf ''; return 0; }

    local _f _failures=0
    _f=$(_agent_ladder_state_file "$_agent" "$_story")
    [ -f "$_f" ] && _failures=$(cat "$_f" 2>/dev/null || echo 0)
    case "$_failures" in ''|*[!0-9]*) _failures=0 ;; esac
    [ "$_failures" -gt 0 ] || { printf '%s' "$_current"; return 0; }

    local _tier _var _chain
    _tier=$(_agent_ladder_tier "$_agent")
    [ -n "$_tier" ] || { printf '%s' "$_current"; return 0; }
    _var="EPAM_MODEL_LADDER_$(printf '%s' "$_tier" | tr '[:lower:]-' '[:upper:]_')"
    _chain="${!_var:-}"
    [ -n "$_chain" ] || { printf '%s' "$_current"; return 0; }

    # Walk one rung per recorded failure. Each hop is a from=to pair; no pair for the current
    # model means the top of this chain, and the walk stops there.
    local _model="$_current" _i=0 _pair _from _to _moved _pairs _IFS_SAVE="$IFS"
    while [ "$_i" -lt "$_failures" ]; do
        _moved=0
        IFS='|'; read -ra _pairs <<< "$_chain"; IFS="$_IFS_SAVE"
        for _pair in "${_pairs[@]}"; do
            _from="${_pair%%=*}"; _to="${_pair#*=}"
            if [ "$_from" = "$_model" ] && [ -n "$_to" ]; then
                _model="$_to"; _moved=1; break
            fi
        done
        [ "$_moved" -eq 1 ] || break
        _i=$((_i + 1))
    done
    printf '%s' "$_model"
}

# agent_ladder_exhausted <agent> <story> <current-model>
# True when a failure is recorded and the chain has nowhere further to go — so a caller can report
# "this agent has run out of ladder" instead of quietly re-asking the same model forever.
agent_ladder_exhausted() {
    local _next
    _next=$(agent_ladder_model "$@")
    [ "$_next" = "${3:-}" ] || return 1
    local _f _failures=0
    _f=$(_agent_ladder_state_file "${1:-}" "${2:-}")
    [ -f "$_f" ] && _failures=$(cat "$_f" 2>/dev/null || echo 0)
    case "$_failures" in ''|*[!0-9]*) _failures=0 ;; esac
    [ "$_failures" -gt 0 ]
}
