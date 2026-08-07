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
    _exports=$("$_node" -e '
      const { seamInvocationEnv } = require(process.argv[1]);
      const env = seamInvocationEnv(process.argv[2]);
      for (const [k, v] of Object.entries(env)) process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`);
    ' "${_dir}/seam-invocation.js" "$_seam" 2>/dev/null) || return 0
    [ -n "$_exports" ] && eval "$_exports"
    return 0
}
