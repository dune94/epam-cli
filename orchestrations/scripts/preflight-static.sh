#!/usr/bin/env bash
# PRE-FLIGHT — everything that can be known without spending a run.
#
# Every live failure on 2026-08-19/20 was catchable offline in under a minute. None needed a model
# call, a codeline, or a dollar. This runs the checks that would have caught them.
#
# Exit 0 = safe to launch. Non-zero = a defect that WILL surface in a run.
set -uo pipefail
ROOT="${1:-/home/bradleyjerome/projects/ai/epam-cli}"
NODE="$HOME/.nvm/versions/node/v20.20.0/bin/node"
cd "$ROOT" || exit 2
FAILED=0
report() { printf '%-34s %s\n' "$1" "$2"; }
fail()   { FAILED=$((FAILED+1)); report "$1" "FAIL  $2"; }
pass()   { report "$1" "ok    $2"; }

# ── 1. SHELL SCOPE/RUNTIME ERRORS ────────────────────────────────────────────
# bash -n is a SYNTAX check and cannot see `local` outside a function. That one word broke the only
# reviewer the pipeline runs, produced NO VERDICT eight times, and cost a whole run.
n=0
while read -r f; do
  out=$(shellcheck -S error "$f" 2>/dev/null | grep -c 'SC[0-9]* (error)' || true)
  [ "${out:-0}" -gt 0 ] && { n=$((n+out)); echo "    $f"; shellcheck -S error "$f" 2>/dev/null | grep 'SC[0-9]* (error)' | sed 's/^/      /'; }
done < <(ls orchestrations/scripts/*.sh orchestrations/scripts/lib/*.sh 2>/dev/null)
[ "$n" -eq 0 ] && pass "shell runtime errors" "0" || fail "shell runtime errors" "$n found"

# ── 2. JS / PYTHON PARSE ─────────────────────────────────────────────────────
n=0
while read -r f; do "$NODE" --check "$f" >/dev/null 2>&1 || { n=$((n+1)); echo "    $f"; }; done \
  < <(ls orchestrations/scripts/*.js orchestrations/scripts/lib/*.js orchestrations/plugins/*.js 2>/dev/null)
[ "$n" -eq 0 ] && pass "js parse" "0" || fail "js parse" "$n"
n=0
while read -r f; do python3 -c "import ast,sys;ast.parse(open(sys.argv[1]).read())" "$f" >/dev/null 2>&1 || { n=$((n+1)); echo "    $f"; }; done \
  < <(ls orchestrations/scripts/lib/handlers/*.py orchestrations/scripts/lib/*.py 2>/dev/null)
[ "$n" -eq 0 ] && pass "python parse" "0" || fail "python parse" "$n"

# ── 3. PROVISIONED PLUGINS ACTUALLY LOAD ─────────────────────────────────────
# verification-plugin.js is provisioned by the codeline and rejected at load for a missing `name`.
# A warning, so nothing ever surfaced it: the tools simply never reached the agent.
out=$("$NODE" -e '
const fs=require("fs"),path=require("path");
// THE REAL CONTRACT: src/tools/PluginLoader.ts:79-80 requires name AND execute on each TOOL.
// A first version of this check tested the MODULE for .name and flagged all six plugins — a false
// positive rate of 5/6. Verified against the loader before being trusted.
let bad=[];
for (const f of fs.readdirSync("orchestrations/plugins").filter(x=>x.endsWith(".js"))) {
  let m; try { m=require(path.resolve("orchestrations/plugins",f)); }
  catch(e){ bad.push(f+" (load error: "+e.message.slice(0,50)+")"); continue; }
  if (!Array.isArray(m.tools)) continue;                    // not a tool plugin
  m.tools.forEach((t,i)=>{
    if (!t || !t.name) bad.push(f+" tool["+i+"] missing required field: name");
    else if (typeof t.execute !== "function") bad.push(f+" tool["+i+"] ("+t.name+") missing execute");
  });
}
console.log(bad.join("\n"));' 2>&1)
[ -z "$out" ] && pass "plugins load" "all" || { fail "plugins load" "$(echo "$out"|wc -l) rejected"; echo "$out" | sed 's/^/    /'; }

# ── 4. EVERY TEMPLATE'S PLACEHOLDERS ARE SUPPLIED ────────────────────────────
# A producer that omits a declared value makes the renderer throw AT RUN TIME. Two of these fired
# live on consecutive runs (skill-assessment-postphase, plan-corrective).
out=$("$NODE" -e '
const fs=require("fs"),path=require("path");
const SH=["orchestrations/scripts","orchestrations/scripts/lib"].flatMap(d=>fs.readdirSync(d).filter(f=>f.endsWith(".sh")).map(f=>path.join(d,f)));
const T={};for(const f of fs.readdirSync("orchestrations/prompts/templates").filter(f=>f.endsWith(".json"))){const j=JSON.parse(fs.readFileSync(path.join("orchestrations/prompts/templates",f),"utf8"));T[j.id||f.replace(/\.json$/,"")]=j;}
const ph=s=>[...new Set((String(s).match(/(?<![A-Z0-9_])__[A-Z0-9][A-Z0-9_]*__(?![A-Z0-9_])/g)||[]))];
const bad=[];
for(const f of SH){const L=fs.readFileSync(f,"utf8").split("\n");
 for(let i=0;i<L.length;i++){const m=/render_(?:engine_prompt|or_keep)\s+([a-z0-9-]+)\s+"?\$?\{?([A-Za-z_]*)\}?"?\s*("?([a-z_]+)"?)?/.exec(L[i]);
  if(!m)continue;const j=T[m[1]];if(!j)continue;const key=m[4];let body;
  if(j.bodies){body=key&&j.bodies[key]!==undefined?j.bodies[key]:null;if(body===null)continue;}else body=j.body||"";
  // Values arrive two ways: named in the jq_vals block, or merged from the codeline by
  // merge_stack_facts (lib/jq-vals.sh), which supplies the stack-facts keys. A checker that
  // modelled only the first would report a site as broken while it works — silencing it by
  // "fixing" working code is worse than the miss.
  const STACK_FACT_KEYS=["__STACK__","__MANIFEST_FILE__","__TEST_COMMAND__","__TEST_FILE_CONVENTIONS__","__PROTECTED_FILES__","__IMPL_ROLE__","__TEST_ROLE__"];
  let sup=null;for(let k=i;k>=0&&k>i-30;k--){if(/jq_vals|jq -n/.test(L[k])){sup=ph(L.slice(k,i).join("\n"));
    if(/merge_stack_facts/.test(L.slice(k,i).join("\n"))) sup=sup.concat(STACK_FACT_KEYS);
    break;}}
  if(!sup)continue;const miss=ph(body).filter(p=>!sup.includes(p));
  if(miss.length)bad.push(f.replace("orchestrations/scripts/","")+":"+(i+1)+"  "+m[1]+"  MISSING "+miss.join(", "));}}
console.log(bad.join("\n"));' 2>&1)
[ -z "$out" ] && pass "template values supplied" "all" || { fail "template values supplied" "$(echo "$out"|wc -l) mismatched"; echo "$out" | sed 's/^/    /'; }

# ── 5. HANDLERS PRODUCE OUTPUT FOR THE REAL STORY ────────────────────────────
# tc-story-context.py returns EMPTY for a brownfield story, so the TC writer is invoked three times
# per run with an empty brief and writes nothing — while its gate reports PASSED.
PRD=$(ls -t orchestrations/projects/*/runs/*/work/*-prd.json 2>/dev/null | head -1)
if [ -n "$PRD" ]; then
  SID=$("$NODE" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log((j.stories&&j.stories[0]&&j.stories[0].id)||"")' "$PRD")
  OUT_DIR=$(dirname "$(dirname "$PRD")")
  ctx=$(python3 orchestrations/scripts/lib/handlers/tc-story-context.py "$OUT_DIR" "$PRD" core "$SID" 2>/dev/null | wc -c)
  [ "${ctx:-0}" -gt 20 ] && pass "tc story context ($SID)" "${ctx} bytes" \
    || fail "tc story context ($SID)" "EMPTY — the TC writer would be given nothing"
else
  report "tc story context" "skip  (no run PRD on disk)"
fi

# ── 6. DETERMINISTIC CHECKS ARE READ, NOT CALLED BARE ────────────────────────
# A check whose exit status is discarded is not a gate. lockfile-sync blocked four times live and
# the story completed anyway.
out=$("$NODE" -e '
const fs=require("fs");const s=fs.readFileSync("orchestrations/scripts/claude.sh","utf8");
const f=s.slice(s.indexOf("run_external_verification() {"));const b=f.slice(0,f.indexOf("\n}\n"));
const bare=b.split("\n").map(l=>l.trim()).filter(l=>/^run_[a-z_]+_check "/.test(l)).filter(l=>!/^if ! /.test(l)&&!/\|\||&&/.test(l));
console.log(bare.join("\n"));' 2>&1)
[ -z "$out" ] && pass "gate verdicts read" "all" || { fail "gate verdicts read" "$(echo "$out"|wc -l) bare"; echo "$out" | sed 's/^/    /'; }

echo
[ "$FAILED" -eq 0 ] && echo "PRE-FLIGHT PASS — nothing here will surface in a run" \
                    || echo "PRE-FLIGHT FAIL — $FAILED check(s); each one WILL surface in a run"
exit "$FAILED"
