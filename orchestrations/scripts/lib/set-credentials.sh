#!/usr/bin/env bash
# set-credentials.sh — THE CREDENTIALS OF THE STACK THAT IS RUNNING, AND NOBODY ELSE'S.
#
# orchestrate.sh exported two vendor keys unconditionally, whatever stack was active:
#
#     EPAM_API_KEY_MINIMAX="${MINIMAX_API_KEY:-}"
#     EPAM_API_KEY_OPENROUTER="${OPENROUTER_API_KEY:-}"
#
# and a project's REQUIRED_KEYS named those same two vendors, so a project pinned to the claude
# stack refused to launch without keys for a stack it never calls.
#
# Two costs, both paid already. A key present in the environment OUTRANKS the OAuth session on
# disk, so a stack meant to run on the subscription billed an API account instead. And selecting a
# set meant editing a project, which is not a swap.
#
# Which credentials a stack needs is a fact about the STACK. provider-sets.json declares them; this
# reads that declaration and nothing else. A set declaring none exports none — deliberately, and
# silently, because "this stack needs no key" is an answer.
#
# Same shape as spend-probe.sh one layer down, and for the same reason.

# _set_credentials_decl — one "env<TAB>from<TAB>required" line per declared credential.
_set_credentials_decl() {
    local _lib; _lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    "${NODE_BIN:-node}" -e '
      const path=require("path"), fs=require("fs");
      const reg=JSON.parse(fs.readFileSync(
        path.join(process.argv[1],"..","..","config","provider-sets.json"),"utf8"));
      const name=(process.env.EPAM_PROVIDER_SET||reg.defaultSet||"");
      const set=(reg.sets||{})[name];
      // An unknown set is an ERROR, never a silent fall-through onto another stack credentials.
      if(!set){
        process.stderr.write(`unknown provider set ${JSON.stringify(name)}; declared: `+
          Object.keys(reg.sets||{}).join(", ")+"\n");
        process.exit(3);
      }
      for(const c of (set.credentials||[])){
        if(!c || !c.env || !c.from) continue;
        process.stdout.write([c.env,c.from,c.required?"1":"0"].join("\t")+"\n");
      }
    ' "$_lib"
}

# export_set_credentials — exports exactly the EPAM_API_KEY_* the active set declares.
#
# A declared credential whose source variable is unset is exported EMPTY rather than skipped: a
# stale value inherited from a previous stack is worse than an absent one, because it looks usable.
export_set_credentials() {
    local _line _env _from _req
    while IFS=$'\t' read -r _env _from _req; do
        [ -n "$_env" ] || continue
        export "$_env=${!_from:-}"
    done < <(_set_credentials_decl)
}

# set_required_keys — the source variables the active set cannot launch without, comma separated.
#
# Echoes nothing when the set requires none. The caller unions this with the project's own
# REQUIRED_KEYS, which is for what is true of the project on ANY stack.
set_required_keys() {
    local _out="" _env _from _req
    while IFS=$'\t' read -r _env _from _req; do
        [ "$_req" = "1" ] || continue
        _out="${_out:+$_out,}$_from"
    done < <(_set_credentials_decl)
    printf '%s' "$_out"
}
