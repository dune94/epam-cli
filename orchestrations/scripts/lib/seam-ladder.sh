# seam-ladder — export the model settings a seam is configured to run with.
#
# The shell counterpart of lib/seam-invocation.js, reading the same registry so a seam's
# configuration means the same thing whichever language invokes it. No seam, ladder or model
# name appears here: the registry names a ladder per seam, the project supplies its models as
# EPAM_MODEL_LADDER_<NAME>, and a seam with no entry is left entirely alone.
seam_ladder_export() {
    local _seam="${1:-}"
    [ -n "$_seam" ] || return 0
    local _dir _reg _node
    _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
    _reg="${AGENT_PROFILES_REGISTRY:-${_dir}/../../agents/invocation-profiles.json}"
    _node="${NODE_BIN:-${EPAM_NODE_BIN:-node}}"
    [ -f "$_reg" ] || return 0
    command -v "$_node" >/dev/null 2>&1 || return 0

    local _exports
    # EXACT MATCH ONLY.
    #
    # resolveSeam never fails: unmatched agents fall through seamPatterns to defaultSeam,
    # which is a real seam with real settings. Applied blindly that is worse than applying
    # nothing — on 2026-08-15 it silently gave lint-fixer, story_recovery, team-lead-agent and
    # four others the cpa-inference ladder and effort, and gave sast-sentinel
    # code-review-cycle's. Wrong configuration presented as resolved configuration.
    #
    # The patterns exist for MINTED agent names (-investigator, -analyst, -reviewer). An
    # engine-side caller passing its own label is not one of those, so it must name a seam the
    # registry actually declares, or get nothing at all.
    #
    # agentSeams COUNTS AS DECLARED. It was omitted here, so the check passed only for labels
    # that are literally profile keys — and skills_audit, tools_audit, story_recovery, lint-fixer
    # and team-lead-agent are not. Those five ran with no ladder, no effort and no tool grant
    # while resolveSeam threw an error the caller swallowed with 2>/dev/null. Three of them hold
    # Bash and WriteFile and rewrite engine state. An agentSeams entry is an EXACT, deliberate,
    # per-agent declaration — it is not the seamPattern/defaultSeam fallback this guard exists to
    # keep out, and that distinction is the whole reason the two live in separate keys.
    _exports=$("$_node" -e '
      const { seamInvocationEnv, resolveSeam } = require(process.argv[1]);
      // APPLY USES THE SAME RESOLUTION AS RESOLVE.
      //
      // This accepted only an exact `profiles` or `agentSeams` key. resolveSeam ALSO matches
      // seamPatterns — which exist precisely for MINTED names (-investigator, -engineer, -fixer),
      // the agents that do the actual work. So a minted agent resolved a seam on paper and got
      // NOTHING at runtime: no ladder, no reasoning effort, no output-token budget.
      //
      // That gap is why the registry carries 61 hand-written agentSeams entries: patterns did not
      // work at the apply seam, so every agent had to be enumerated to function at all. The
      // enumeration was a SYMPTOM of this defect, not a design choice. With this, a new agent type
      // is onboarded by NAMING it, and those entries become redundant wherever a pattern covers.
      //
      // EXIT 3 = "the registry has no declaration for this agent", distinguishable from "there was
      // nothing to do" — every other outcome is 0, so the caller could not otherwise tell an
      // unconfigured agent from a configured one.
      //
      // THE GUARD THAT MATTERS IS UNCHANGED: resolveSeam THROWS for a name that matches no pattern
      // and has no declared default, so an unknown agent still gets nothing rather than a guess.
      // That is the 2026-08-15 defect — seven agents silently given the wrong configuration.
      try { resolveSeam(process.argv[2]); } catch { process.exit(3); }
      const env = seamInvocationEnv(process.argv[2]);
      for (const [k, v] of Object.entries(env)) process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`);
    ' "${_dir}/seam-invocation.js" "$_seam" "$_reg" 2>&1) || {
        # 3 is the registry saying it does not know this agent — pass that up so the caller can
        # say so. Anything else is a genuine fault reading the registry, and is also worth saying.
        local _rc=$?
        [ "$_rc" -eq 3 ] && return 3
        printf '%s\n' "$_exports" >&2
        return "$_rc"
    }
    [ -n "$_exports" ] && eval "$_exports"
    return 0
}

# seam_model_or_fail <agent> [context]
#
# THE MODEL AN AGENT RUNS ON, FROM THE LADDER AND FROM NOWHERE ELSE.
#
# Every call site used to end in `${ORCH_GATE_MODEL:-<a vendor model name>}`. Three things were
# wrong with that. The literal is a vendor fact written into the engine, so a project could not
# change it without editing the engine. The run-wide variable is a SECOND source of truth that
# silently outranks the seam, so an agent declared to sit at the base of the ladder ran on whatever
# the run happened to pin. And because both were present, the ladder never had to work: two of the
# three positions resolved no model at all for months and nothing noticed, because the literal
# always answered.
#
# So: identity -> seam -> ladder position -> the project's tier -> that tier's declared startModel.
# Nothing here names a model, a provider or a tier.
#
# Exit status is the contract. A model that cannot be resolved is NOT substituted — it is reported,
# naming the agent, so the caller refuses instead of quietly running the wrong one. That is the
# opposite of the 2026-08-14 failure, where removing the literals without giving the ladder a
# startModel left seams with no model and the refusal looked like a bug in the agent.
seam_model_or_fail() {
    local _agent="${1:-}" _ctx="${2:-$1}"
    if [ -z "$_agent" ]; then
        echo "[seam-model] asked for a model with no agent identity — the ladder has nothing to resolve" >&2
        return 2
    fi

    # seam_ladder_export sets EPAM_MODEL from the seam's tier when the project declares a
    # startModel for it. Run it in a subshell so probing never mutates the caller's environment.
    # TWO CAUSES, TWO MESSAGES. "The registry does not know this agent" and "the project declares
    # no startModel for that tier" are fixed in different files by different people, and one
    # message for both sends the reader to the wrong one.
    local _model _rc
    _model=$(
        seam_ladder_export "$_agent" >/dev/null 2>&1
        printf '%s|%s' "$?" "${EPAM_MODEL:-}"
    )
    _rc="${_model%%|*}"; _model="${_model#*|}"

    if [ "$_rc" = "3" ]; then
        echo "[seam-model] '${_ctx}' is not declared in invocation-profiles.json — add it to profiles or agentSeams. Until then it has no ladder position, so no model can be resolved for it." >&2
        return 1
    fi
    if [ -z "$_model" ]; then
        echo "[seam-model] no model resolved for '${_ctx}': its seam's ladder position has no startModel in this project's llm-settings.json. Declare one for that tier — the engine will not choose a model on the project's behalf." >&2
        return 1
    fi
    printf '%s' "$_model"
}

# seam_next_model <agent> <current-model>
#
# ONE RUNG UP THIS AGENT'S OWN LADDER. Retry escalation was `${ESCALATION_MODEL_HIGH:-...}` — a
# single run-wide model that every agent escalated to regardless of where it started, which is not
# a ladder, it is a second pin. The chain the project declared for this agent's tier already says
# what comes after what; this walks exactly one hop of it.
#
# Prints the current model unchanged when the chain has nowhere further to go, so a caller can
# compare and report "this agent has run out of ladder" rather than re-asking the same model.
seam_next_model() {
    local _agent="${1:-}" _current="${2:-}"
    [ -n "$_agent" ] && [ -n "$_current" ] || { printf '%s' "$_current"; return 0; }

    local _chain
    _chain=$(
        seam_ladder_export "$_agent" >/dev/null 2>&1
        printf '%s' "${EPAM_MODEL_LADDER:-}"
    )
    [ -n "$_chain" ] || { printf '%s' "$_current"; return 0; }

    local _IFS_SAVE="$IFS" _pairs _pair _from _to
    IFS='|'; read -ra _pairs <<< "$_chain"; IFS="$_IFS_SAVE"
    for _pair in "${_pairs[@]}"; do
        _from="${_pair%%=*}"; _to="${_pair#*=}"
        if [ "$_from" = "$_current" ] && [ -n "$_to" ]; then
            printf '%s' "$_to"; return 0
        fi
    done
    printf '%s' "$_current"
}
