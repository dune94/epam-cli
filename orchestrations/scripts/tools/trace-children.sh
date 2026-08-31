#!/usr/bin/env bash
# COVERAGE FOR CODE THAT RUNS IN A CHILD PROCESS.
#
# Most handlers here are invoked as `node handler.js ...` — from shell, and from tests using
# spawnSync. vitest's v8 provider instruments its own WORKER, so none of that execution is seen: 19
# tests covering two handlers moved the discovery stage by 0.0%, which reads as "these tests do
# nothing" when they exercise the handler thoroughly.
#
# NODE_V8_COVERAGE makes each child write its own raw coverage. This runs the named tests with it
# set, converts what the children produced, and merges it into the accumulating lcov.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
[ "$#" -gt 0 ] || { echo "usage: trace-children.sh <test-file|dir> [more...]" >&2; exit 2; }
NODE_BIN="${NODE_BIN:-$(command -v node)}"
ACC="${JS_COVERAGE_ACC:-$ROOT/coverage/lcov.info}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/v8"

NODE_V8_COVERAGE="$W/v8" "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run \
  --maxWorkers=2 "$@" >"$W/run.log" 2>&1
_rc=$?

_files=$(ls "$W/v8" 2>/dev/null | wc -l)
if [ "$_files" -eq 0 ]; then
    echo "[trace-children] no child wrote coverage — nothing spawned node, or NODE_V8_COVERAGE did not reach it. That is the collector failing, not a coverage of zero." >&2
    exit 3
fi

"$NODE_BIN" -e '
  const fs=require("fs"),path=require("path");
  const v8dir=process.argv[1], acc=process.argv[2], root=process.argv[3];
  const {executableLineNumbers}=require(path.join(root,"orchestrations/scripts/lib/handlers/executable-lines.js"));
  // NO v8-to-istanbul HERE — it is not installed, and the conversion this needs is small: V8 gives
  // byte ranges with hit counts, and a line is covered when it falls inside a range that ran. The
  // DENOMINATOR is the shared executable-line definition, the same one the gate and the shell
  // converter use, so all three halves of the report are counted by one rule.
  const mine=(u)=>u.startsWith("file://")&&u.slice(7).startsWith(root)
    &&!u.includes("/node_modules/")&&/\.(js|cjs|mjs)$/.test(u);
  const covered=new Map();
  for (const f of fs.readdirSync(v8dir)) {
    let j; try { j=JSON.parse(fs.readFileSync(path.join(v8dir,f),"utf8")); } catch { continue; }
    for (const s of (j.result||[])) {
      if (!mine(s.url||"")) continue;
      const file=s.url.slice(7);
      let src; try { src=fs.readFileSync(file,"utf8"); } catch { continue; }
      // offset -> line, built once per file
      const lineAt=new Array(src.length+1); let ln=1;
      for(let i=0;i<src.length;i++){ lineAt[i]=ln; if(src[i]==="\n") ln++; }
      lineAt[src.length]=ln;
      if(!covered.has(file)) covered.set(file,new Set());
      const hitLines=covered.get(file);
      for (const fn of (s.functions||[])) {
        for (const r of (fn.ranges||[])) {
          if (!r.count) continue;
          const a=lineAt[Math.max(0,Math.min(r.startOffset,src.length))];
          const b=lineAt[Math.max(0,Math.min(r.endOffset,src.length))];
          for (let l=a;l<=b;l++) hitLines.add(l);
        }
      }
    }
  }
  const read=(p)=>{ const m=new Map(); let t=""; try{t=fs.readFileSync(p,"utf8")}catch{return m}
    let cur=null,ls=null;
    for(const l of t.split("\n")){
      if(l.startsWith("SF:")){cur=l.slice(3).trim();ls=m.get(cur)||new Map();m.set(cur,ls)}
      else if(cur&&l.startsWith("DA:")){const [n,h]=l.slice(3).split(",").map(Number);
        ls.set(n,Math.max(ls.get(n)||0,h||0))}
      else if(l==="end_of_record") cur=null; }
    return m };
  const a=read(acc);
  let newLines=0,newFiles=0;
  for (const [file,hitLines] of covered) {
    let src=""; try{src=fs.readFileSync(file,"utf8")}catch{continue}
    const exec=executableLineNumbers(src);
    if(!a.has(file)){a.set(file,new Map());newFiles++}
    const into=a.get(file);
    for (const n of exec) {
      const h=hitLines.has(n)?1:0;
      const was=into.get(n)||0;
      if(h&&!was) newLines++;
      into.set(n,Math.max(was,h));
    }
  }
  const out=[];
  for(const [f,ls] of a){
    const ns=[...ls.keys()].sort((x,y)=>x-y); if(!ns.length) continue;
    out.push("SF:"+f); let hit=0;
    for(const n of ns){const h=ls.get(n); if(h>0)hit++; out.push("DA:"+n+","+h);}
    out.push("LF:"+ns.length,"LH:"+hit,"end_of_record");
  }
  fs.writeFileSync(acc,out.join("\n")+"\n");
  process.stderr.write("[trace-children] "+covered.size+" child-executed files ("+newFiles+" new, "+newLines+" newly covered lines)\n");
' "$W/v8" "$ACC" "$ROOT"
echo "[trace-children] $# target(s), exit $_rc"
