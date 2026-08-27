#!/usr/bin/env bash
# spend-probe.sh — THE RUN'S SPEND, FROM THE SET THAT DECLARES IT.
#
# Ten copies of a curl to a hardcoded vendor credit endpoint lived across six launchers,
# each guarded only by `[ -n "$OPENROUTER_API_KEY" ]`. That key is present in .env whatever
# stack is active, so a codemie or mockserver run called OpenRouter too — on a free run, the
# one vendor call that was supposed to be impossible. A wording fix was a ten-place edit.
#
# Which endpoint reports credit is a fact about a STACK, so provider-sets.json declares it.
# A set that declares no probe reports no spend, silently and correctly.

_spend_probe_cfg() {
    local _lib; _lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    "${NODE_BIN:-node}" -e '
      const path=require("path");
      const {activeSetFile}=require(path.join(process.argv[1],"llm-settings-resolve.js"));
      const fs=require("fs");
      const reg=JSON.parse(fs.readFileSync(path.join(process.argv[1],"..","..","config","provider-sets.json"),"utf8"));
      const name=(process.env.EPAM_PROVIDER_SET||reg.defaultSet||"");
      const p=((reg.sets||{})[name]||{}).spendProbe;
      if(!p) process.exit(0);
      process.stdout.write([p.url,p.keyEnv,p.usagePath].join("\t"));
    ' "$_lib" 2>/dev/null || true
}

# spend_probe_read — echoes the current usage figure, or nothing when the set declares no probe.
spend_probe_read() {
    local _cfg _url _keyenv _path _key
    _cfg="$(_spend_probe_cfg)"
    [ -n "$_cfg" ] || return 0
    IFS=$'\t' read -r _url _keyenv _path <<<"$_cfg"
    [ -n "$_url" ] && [ -n "$_keyenv" ] || return 0
    _key="${!_keyenv:-}"
    [ -n "$_key" ] || return 0
    curl -s "$_url" -H "Authorization: Bearer $_key" 2>/dev/null | \
      "${NODE_BIN:-node}" -e '
        let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
          try{
            let v=JSON.parse(d);
            for(const k of process.argv[1].split(".")) v=v?.[k];
            process.stdout.write(String(v??""));
          }catch{ /* an unreadable body is no figure, not a zero */ }
        });' "$_path" 2>/dev/null || true
}

# spend_probe_report <before> — prints the delta when a figure is available. Never invents a 0:
# "we could not tell" and "it cost nothing" are different answers and only one of them is safe.
spend_probe_report() {
    local _before="${1:-}" _after
    _after="$(spend_probe_read)"
    [ -n "$_after" ] || return 0
    if [ -n "$_before" ]; then
        local _spent
        _spent=$("${NODE_BIN:-node}" -e "console.log((($2)-($1)).toFixed(4))" "$_before" "$_after" 2>/dev/null || echo "?")
        echo "  usage after: \$$_after   spent this run: \$$_spent"
    else
        echo "  usage: \$$_after"
    fi
}
