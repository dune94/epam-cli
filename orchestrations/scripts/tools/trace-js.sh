#!/usr/bin/env bash
# THE JS HALF OF THE SAME FAST LOOP.
#
# trace-shell.sh made shell coverage incremental — one target, seconds, accumulated. JS had no
# equivalent: the only way to refresh lcov was `vitest run --coverage` over the whole suite, ~800s,
# so a test written at 10am did not appear in the number until a full run hours later. That is how
# writing tests stops feeling like it moves anything.
#
# This runs the named targets with coverage into a THROWAWAY directory and merges the result into an
# accumulating lcov. Merging matters: running coverage over two files alone would otherwise replace
# the whole report with those two files and delete everything measured before.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
[ "$#" -gt 0 ] || { echo "usage: trace-js.sh <test-file|dir> [more...]" >&2; exit 2; }

NODE_BIN="${NODE_BIN:-$(command -v node)}"
ACC="${JS_COVERAGE_ACC:-$ROOT/coverage/lcov.info}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

"$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run --coverage \
  --coverage.reportsDirectory="$W/cov" --maxWorkers=2 "$@" >"$W/run.log" 2>&1
_rc=$?

if [ ! -s "$W/cov/lcov.info" ]; then
    echo "[trace-js] no coverage was produced — that is the collector failing, not a coverage of zero. See $W/run.log" >&2
    exit 3
fi

# MERGE BY UNIONING COVERED LINES, NOT BY COMPARING FILE TOTALS.
#
# Comparing whole-file hit counts cannot merge anything: a run of three test files sees less of a
# 10,000-line module than the full suite did, so it always loses and every incremental run reported
# "0 improved". Coverage is a set of lines that executed, and two runs exercising different tests of
# one file each cover part of it — the union is the answer, and it is the only merge that lets a
# test written now show up now.
"$NODE_BIN" -e '
  const fs=require("fs");
  const read=(p)=>{ const m=new Map(); let t=""; try{t=fs.readFileSync(p,"utf8")}catch{return m}
    let cur=null,lines=null;
    for(const l of t.split("\n")){
      if(l.startsWith("SF:")){cur=l.slice(3).trim();lines=m.get(cur)||new Map();m.set(cur,lines)}
      else if(cur&&l.startsWith("DA:")){const [n,h]=l.slice(3).split(",").map(Number);
        lines.set(n,Math.max(lines.get(n)||0,h||0))}
      else if(l==="end_of_record") cur=null; }
    return m };
  const acc=read(process.argv[1]), fresh=read(process.argv[2]);
  let newFiles=0,newLines=0;
  for(const [f,lines] of fresh){
    if(!acc.has(f)){acc.set(f,new Map());newFiles++}
    const into=acc.get(f);
    for(const [n,h] of lines){
      const was=into.get(n)||0;
      if(h>0&&was===0) newLines++;
      into.set(n,Math.max(was,h));
    }
  }
  const out=[];
  for(const [f,lines] of acc){
    const ns=[...lines.keys()].sort((a,b)=>a-b);
    if(!ns.length) continue;
    out.push("SF:"+f);
    let hit=0;
    for(const n of ns){ const h=lines.get(n); if(h>0)hit++; out.push("DA:"+n+","+h); }
    out.push("LF:"+ns.length,"LH:"+hit,"end_of_record");
  }
  fs.writeFileSync(process.argv[1],out.join("\n")+"\n");
  process.stderr.write("[trace-js] "+acc.size+" files ("+newFiles+" new, "+newLines+" newly covered lines)\n");
' "$ACC" "$W/cov/lcov.info"
echo "[trace-js] $# target(s), exit $_rc"
