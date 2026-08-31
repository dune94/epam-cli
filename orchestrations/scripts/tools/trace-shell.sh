#!/usr/bin/env bash
# TRACE ONE TARGET, IN SECONDS, AND ACCUMULATE.
#
# The whole-suite collector was the wrong shape: one monolithic run measuring everything, taking
# minutes, and unusable in a normal edit-test loop. This traces exactly what you name — one test
# file, one directory, one bats file — and MERGES its result into the accumulated shell lcov.
#
# Coverage therefore grows the way tests are written: a file at a time, each run costing what that
# one file costs. Nothing here runs a suite.
#
#   trace-shell.sh test/unit/orchestration/pre-run-reset-without-prd.test.ts
#   trace-shell.sh test/shell/steps/the-reset-copies-a-run-before-it-deletes-it.bats
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
# MANY TARGETS, ONE PROCESS. Tracing files one at a time pays vitest's ~3s startup per file, so 43
# files cost two minutes of startup to collect thirty seconds of trace. Passed together they cost one.
[ "$#" -gt 0 ] || { echo "usage: trace-shell.sh <test-file|dir|.bats> [more...]" >&2; exit 2; }
TARGETS=("$@")
TARGET="$1"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
ACC="${SHELL_COVERAGE_ACC:-$ROOT/coverage/.shell-trace-lines}"
OUT="${SHELL_COVERAGE_OUT:-$ROOT/coverage/lcov.shell.info}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/traces" "$(dirname "$ACC")"
touch "$ACC"

cat > "$W/on.sh" <<'ENABLER'
if [ -n "${SHCOV_TRACES:-}" ]; then
  exec 9>>"$SHCOV_TRACES/$$.trace" 2>/dev/null || true
  BASH_XTRACEFD=9
  PS4='@@${BASH_SOURCE}:${LINENO}@@
'
  set -x
fi
ENABLER

export SHCOV_TRACES="$W/traces" BASH_ENV="$W/on.sh"
if [[ "$TARGET" == *.bats ]]; then
    bash "$ROOT/orchestrations/scripts/run-shell-tests.sh" "$TARGET" >"$W/run.log" 2>&1
else
    "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run --maxWorkers=2 "${TARGETS[@]}" >"$W/run.log" 2>&1
fi
_rc=$?
unset SHCOV_TRACES BASH_ENV

# Everything traced, reduced to unique file:line and merged with what previous runs found.
# EXECUTION IN A COPY IS STILL EXECUTION.
#
# 81 test files here EXTRACT a block from run-agent-orchestration.sh or claude.sh, write it to a temp
# script, and run that. bash then attributes every traced line to the temp file, so the source file
# reads as unexecuted: 2,588 traced lines landed under /tmp and 8 on the orchestrator, which made a
# heavily-tested stage report 0% and would have sent someone writing tests that already exist.
#
# So a temp-file hit is mapped back by the TEXT of the line it ran. The text is captured here, while
# the temp script still exists, and matched against the source afterwards. A line whose text appears
# exactly ONCE in a source file is attributed to it; anything ambiguous or unmatched is dropped
# rather than guessed, because a wrong attribution is worse than a missing one.
: > "$W/hits"
cat "$W/traces"/*.trace 2>/dev/null | grep -o '@@[^@]*@@' | sort -u > "$W/raw"
while IFS= read -r _hit; do
    _f="${_hit#@@}"; _f="${_f%@@}"
    _line="${_f##*:}"; _file="${_f%:*}"
    case "$_file" in
        "$ROOT"/*)  printf '%s\n' "$_hit" >> "$ACC" ;;               # already the real file
        *)  [ -f "$_file" ] || continue
            _text="$(sed -n "${_line}p" "$_file" 2>/dev/null)"
            [ -n "${_text// }" ] || continue
            printf '%s\t%s\n' "$_line" "$_text" >> "$W/hits" ;;
    esac
done < "$W/raw"

if [ -s "$W/hits" ]; then
    "$NODE_BIN" -e '
      const fs=require("fs"),path=require("path");
      const root=process.argv[1], hitsFile=process.argv[2], acc=process.argv[3];
      // Only the files blocks are extracted FROM need indexing.
      const sources=["orchestrations/scripts/run-agent-orchestration.sh","orchestrations/scripts/claude.sh",
                     "orchestrations/scripts/team-lead-review.sh","orchestrations/scripts/spec-mode-runner.js"]
        .map(p=>path.join(root,p)).filter(p=>fs.existsSync(p));
      const index=new Map();           // trimmed text -> [ {file,line} ]
      for(const f of sources){
        fs.readFileSync(f,"utf8").split("\n").forEach((l,i)=>{
          const t=l.trim(); if(!t||t.startsWith("#")) return;
          if(!index.has(t)) index.set(t,[]);
          index.get(t).push({f,line:i+1});
        });
      }
      const out=[];
      for(const row of fs.readFileSync(hitsFile,"utf8").split("\n")){
        if(!row) continue;
        const t=row.slice(row.indexOf("\t")+1).trim();
        const hits=index.get(t);
        if(!hits||hits.length!==1) continue;    // ambiguous or unknown: drop, never guess
        out.push("@@"+hits[0].f+":"+hits[0].line+"@@");
      }
      fs.appendFileSync(acc,out.join("\n")+(out.length?"\n":""));
      process.stderr.write("[trace-shell] recovered "+out.length+" lines executed through extracted copies\n");
    ' "$ROOT" "$W/hits" "$ACC"
fi
sort -u "$ACC" -o "$ACC"

"$NODE_BIN" "$ROOT/orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js" "$ACC" "$OUT" 2>&1 | tail -1
echo "[trace-shell] ${#TARGETS[@]} target(s) (exit $_rc) — accumulated $(wc -l < "$ACC") unique shell lines"
