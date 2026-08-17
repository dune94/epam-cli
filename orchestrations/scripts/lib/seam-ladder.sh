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
      const { seamInvocationEnv } = require(process.argv[1]);
      const reg = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
      const declared = (reg.profiles || {})[process.argv[2]] || (reg.agentSeams || {})[process.argv[2]];
      // EXIT 3 = "the registry has no declaration for this agent", which is distinguishable from
      // "there was nothing to do". Every other outcome here is 0, so the caller could not tell an
      // unconfigured agent from a configured one and reported neither.
      if (!declared) process.exit(3);
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
