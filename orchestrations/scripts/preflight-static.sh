#!/usr/bin/env bash
# PRE-FLIGHT — everything that can be known without spending a run.
#
# Every live failure on 2026-08-19/20 was catchable offline in under a minute. None needed a model
# call, a codeline, or a dollar. This runs the checks that would have caught them.
#
# Exit 0 = safe to launch. Non-zero = a defect that WILL surface in a run.

# THE COVERAGE GATE IS NOT HERE. This file is a STATIC SOURCE AUDIT — it reads code and reports
# findings, and it is run at a desk as often as in a pipeline. Halting it on a coverage measurement
# meant it printed nothing at all whenever coverage was stale, so every check it performs vanished
# and the operator saw an empty report rather than a reason.
#
# The whole-map gate belongs where money moves: the tier3 launchers call require_all_stage_coverage
# before they spend, which is also what marks the run gated for the per-stage gates.

set -uo pipefail
# NEITHER OF THESE IS WRITTEN DOWN.
#
# This defaulted to one developer's absolute home path, and pinned node to one nvm install of
# one version. On any other machine — CI, a second checkout, a colleague — the default ROOT
# pointed at a directory that does not exist, and $NODE at an interpreter that does not exist,
# so a pre-flight whose entire purpose is "catch it before spending a run" could not run at all.
#
# The repo root is where this script lives, two levels up. The interpreter is resolved by
# lib/node-bin.sh, which reads the requirement from package.json engines.node and finds an
# interpreter that satisfies it — the library that exists for exactly this, and that ten other
# sites already use.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$_SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib/node-bin.sh
. "$_SCRIPT_DIR/lib/node-bin.sh"
NODE="$(resolve_node_bin "$ROOT")" || { echo "[preflight] no usable node interpreter" >&2; exit 2; }
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

# ── 1b. WHAT ACTUALLY RUNS IS CURRENT WITH ITS SOURCE ────────────────────────
# Every check in this file reads SOURCE. `epam` runs dist/epam.js. A change written, tested and
# never built passes everything here and reaches a run as the old behaviour — 2026-08-09 (tool-use
# logging, nine passing tests, zero events) and 2026-08-20 (plugin strictness, caught only by one
# launcher's own gate). Shared with the launchers: lib/build-freshness.sh.
# shellcheck source=lib/build-freshness.sh
source "$ROOT/orchestrations/scripts/lib/build-freshness.sh" 2>/dev/null || true
if command -v build_is_current >/dev/null 2>&1; then
  _bf=$(build_is_current "$ROOT" 2>&1) && pass "build current with src" "ok" \
    || { fail "build current with src" "stale"; echo "$_bf" | sed 's/^/    /'; }
else
  fail "build current with src" "lib/build-freshness.sh did not load"
fi

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
  // Values arrive two ways: named in the jq_vals block, or supplied by THE RENDERER. A checker
  // that modelled only the first would report a site as broken while it works — silencing it by
  // "fixing" working code is worse than the miss.
  //
  // The renderer is the supplier now, unconditionally. engine-prompt.js adds exactly the stack
  // placeholders a template DECLARES (`stackDeclared`). This used to credit merge_stack_facts
  // instead, and only when that call appeared near the jq_vals block — a second implementation
  // of the same idea that merged ALL SEVEN keys, so the renderer threw "was given values it does
  // not use" on every template declaring fewer, and four seams could not render at all.
  const STACK_FACT_KEYS=["__STACK__","__MANIFEST_FILE__","__TEST_COMMAND__","__TEST_FILE_CONVENTIONS__","__PROTECTED_FILES__","__IMPL_ROLE__","__TEST_ROLE__"];
  let sup=null;for(let k=i;k>=0&&k>i-30;k--){if(/jq_vals|jq -n/.test(L[k])){sup=ph(L.slice(k,i).join("\n"));
    sup=sup.concat(STACK_FACT_KEYS);
    break;}}
  if(!sup)continue;const miss=ph(body).filter(p=>!sup.includes(p));
  if(miss.length)bad.push(f.replace("orchestrations/scripts/","")+":"+(i+1)+"  "+m[1]+"  MISSING "+miss.join(", "));}}
console.log(bad.join("\n"));' 2>&1)
[ -z "$out" ] && pass "template values supplied" "all" || { fail "template values supplied" "$(echo "$out"|wc -l) mismatched"; echo "$out" | sed 's/^/    /'; }

# ── 5. HANDLERS PRODUCE OUTPUT FOR THE REAL STORY ────────────────────────────
# tc-story-context.py returned EMPTY for a brownfield story, so the TC writer was invoked three
# times per run with an empty brief and wrote nothing — while its gate reported PASSED.
#
# THE CHECK ITSELF HAD THE SAME DEFECT IT WAS WRITTEN TO CATCH. It took stories[0], ran the handler
# and called an empty answer a failure. But the handler SKIPS a story that already has
# testCriteria.facts — correctly, there is nothing to brief — so once AMSD-2041 had its 21 facts
# the check failed on the handler doing exactly the right thing. A check whose scope does not match
# its claim reports the wrong thing in both directions.
#
# It now asks the handler about a story that ACTUALLY needs context, and says so when none does.
# shellcheck source=lib/project-config.sh
. "$ROOT/orchestrations/scripts/lib/project-config.sh"
PRD=$(ls -t "$(projects_root "$ROOT")"/*/runs/*/work/*-prd.json 2>/dev/null | head -1)
if [ -n "$PRD" ]; then
  # The selector is a handler, not an inline program, so the same question this check asks can be
  # asked by a test — a check that can only ever be exercised by running the whole pre-flight
  # against whatever PRD happens to be on disk is a check nobody can prove.
  SID=$("$NODE" "orchestrations/scripts/lib/handlers/tc-story-needing-context.js" "$PRD" core 2>/dev/null || echo "")
  OUT_DIR=$(dirname "$(dirname "$PRD")")
  if [ -z "$SID" ]; then
    report "tc story context" "skip  (no story in this PRD needs criteria — nothing to brief)"
  else
    ctx=$(python3 orchestrations/scripts/lib/handlers/tc-story-context.py "$OUT_DIR" "$PRD" core "$SID" 2>/dev/null | wc -c)
    [ "${ctx:-0}" -gt 20 ] && pass "tc story context ($SID)" "${ctx} bytes" \
      || fail "tc story context ($SID)" "EMPTY — the TC writer would be given nothing"
  fi
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

# ── 7. RATCHETS — THE DEBT MAY ONLY SHRINK ───────────────────────────────────
# Eight of the ten defects confirmed on 2026-08-20 were hardcoding, and every one of them was
# added by a change that passed every check above. Counting is not a fix; it is the only thing
# that stops the number growing while the fixes are worked through one at a time.
#
# A count BELOW its baseline lowers the baseline in place — today's number becomes tomorrow's
# ceiling. A count ABOVE it fails. Raising a baseline by hand is an operator decision.
BASELINES="orchestrations/config/preflight-baselines.json"
ratchet() {
  local _label="$1" _key="$2" _scanner="$3"
  local _out _n _base _rc
  # An empty scan is not automatically a pass: a scanner that cannot run reports nothing, which
  # is the exact shape of every defect this file exists to catch. rc is captured on the SAME
  # logical step as the call — a check that reads $? a line later reads whatever ran in between.
  _out=$("$NODE" "orchestrations/scripts/lib/handlers/$_scanner" "$ROOT" 2>&1); _rc=$?
  if [ "$_rc" -ne 0 ]; then fail "$_label" "scanner did not run"; printf '%s\n' "$_out" | sed 's/^/    /'; return; fi
  _n=$(printf '%s' "$_out" | grep -c . || true)
  _base=$("$NODE" -e 'try{const j=require(process.argv[1]);const v=j[process.argv[2]];console.log(Number.isFinite(v)?v:"")}catch{console.log("")}' \
          "$ROOT/$BASELINES" "$_key" 2>/dev/null)
  if [ -z "$_base" ]; then fail "$_label" "no baseline for $_key in $BASELINES"; return; fi
  if [ "$_n" -gt "$_base" ]; then
    fail "$_label" "$_n > baseline $_base — $(($_n - _base)) new"
    printf '%s\n' "$_out" | sed 's/^/    /'
  elif [ "$_n" -lt "$_base" ]; then
    "$NODE" -e '
      const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));
      j[process.argv[2]]=Number(process.argv[3]);fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' \
      "$ROOT/$BASELINES" "$_key" "$_n" 2>/dev/null
    pass "$_label" "$_n (improved from $_base — baseline tightened)"
  else
    pass "$_label" "$_n (at baseline)"
  fi
}
ratchet "literal ratchet" "duplicatedLiterals" "scan-duplicated-literals.js"
ratchet "guard calibration" "uncalibratedGuards" "scan-uncalibrated-guards.js"
# THE SHELL ITSELF, READ STATICALLY. Coverage says how much of the engine a test has executed;
# this says how much of it is wrong on its face, across every .sh file, needing no test written
# first. The classes it counts have each already cost a run: an export masking a command status,
# `A && B || C` read as if-then-else, a redirection with no command, a subshell losing an assignment.
ratchet "shell defects" "shellDefects" "scan-shell-defects.js"

# ── THE HARDCODING AUDIT CAN STILL SEE ───────────────────────────────────────
# Not its count — that is a research number nobody should gate on, and the file says so itself.
# This asks the prior question: does each category still detect the defect it claims to cover?
#
# Every hardcoding defect found on 2026-08-23 was invisible to that audit — it scanned .sh/.js/.ts
# and declared config exempt, so RELOCATING a literal into orchestrations/config counted as
# repair; its numeric category needed a named knob, so topN = 8 matched nothing. And nothing ran
# it, so the blindness was never observed. --calibrate runs every pattern against a fixture of
# known-bad lines and fails on any that has gone blind. It found a real gap on its first run: the
# branch pattern required a character AFTER the branch name, so `git checkout develop` at the end
# of a line matched nothing.
_hc_out=$(bash orchestrations/scripts/hardcoding-audit.sh --calibrate 2>&1); _hc_rc=$?
if [ "$_hc_rc" -eq 0 ]; then
  pass "hardcoding audit sees" "$(printf '%s' "$_hc_out" | grep -c 'sees its example') categories"
else
  fail "hardcoding audit sees" "a category has gone BLIND"
  printf '%s\n' "$_hc_out" | grep -E 'BLIND' | sed 's/^/    /'
fi

# ── 8. THE OPERATOR'S OWN DECISIONS ──────────────────────────────────────────
# orchestrations/config/remediation-register.json is DATA the operator owns: literals that must be
# gone, and guards judged useless. Marking one enforce:true makes it fatal here — no code change,
# no negotiation with this file. An unreadable register FAILS rather than reporting nothing.
out=$("$NODE" "orchestrations/scripts/lib/handlers/check-remediation-register.js" "$ROOT" 2>&1)
rc=$?
if [ "$rc" -eq 2 ]; then
  fail "remediation register" "unreadable — decisions cannot be enforced"
  echo "$out" | sed 's/^/    /'
elif [ "$rc" -ne 0 ]; then
  fail "remediation register" "$(printf '%s' "$out" | grep -c . || true) enforced item(s) still present"
  echo "$out" | sed 's/^/    /'
else
  pass "remediation register" "no enforced violations"
fi

echo
[ "$FAILED" -eq 0 ] && echo "PRE-FLIGHT PASS — nothing here will surface in a run" \
                    || echo "PRE-FLIGHT FAIL — $FAILED check(s); each one WILL surface in a run"
exit "$FAILED"
