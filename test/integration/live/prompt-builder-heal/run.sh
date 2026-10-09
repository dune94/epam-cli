#!/usr/bin/env bash
# THE PROMPT BUILDER'S SELF-HEAL, ON LIVE TOKENS — the analyst the builder calls on a rejected prompt.
#
#   run.sh <work-dir> [install]
#
# Live AMSD-2974 run 3 (2026-10-09): code-review-cycle's generated prompt was rejected by the prompt reviewer and
# the analyst diagnosed "the output is the unfilled template itself — every __PLACEHOLDER__ was left verbatim".
# A project prompt's placeholders are SUPPOSED to stay: they are filled per call at run time. The builder now tells
# the analyst so (healContext). This calls the real selfHeal with the builder's real context, on a real generated
# prompt and the reviewer's real reason from that run, and prints the analyst's diagnosis.
#
# Nothing is written outside <work-dir>: the project is a copy. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${2:-${HEAL_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"
[ -f "$P/prompts/code-review-cycle.json" ] || { echo "RESULT setup=no generated code-review-cycle prompt at $P"; exit 0; }

C="$W/project"; mkdir -p "$C"
for f in config.env config.copilot.env llm-settings.json manifest.json plugins.json prompts; do [ -e "$P/$f" ] && cp -a "$P/$f" "$C/"; done
export EPAM_PROVIDER_SET=copilot
export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
mkdir -p "$LOG_DIR" "$EPAM_AGENT_REPLY_LOG_DIR"
# The prompt builder's own rung for its first attempt — the model that produced the rejected prompt.
export EPAM_MODEL="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).seamInvocationEnv("prompt-builder",undefined,{rung:0}).EPAM_MODEL||"")' "$SCRIPT_DIR/lib/seam-invocation.js")"
echo "RESULT analyst_rung_model=${EPAM_MODEL:-<none>}"

# The reviewer's reason for code-review-cycle attempt 4 in run 20261009T125903Z, verbatim from its log line.
REASON="upexpress: 'Five thin Toast.success/Toast.failure call sites (SuccessfulSignInToast, ResendTicket, AccountInformation, TicketForm, Cart, SignUp) inherit the fix without code change of their own'; gotransit: 'consumed cx-shared range is ^8.8.0'; metrolinx: imports @metrolinx/cx-shared as a dependency (stated without qualification, while the project context frames the fix as flowing from cx-shared)"

"$NODE" -e '
const path=require("path"), fs=require("fs");
const [scripts, prompt, tplDir, reason]=process.argv.slice(1);
const { selfHeal }=require(path.join(scripts,"lib/self-heal.js"));
const { healContext }=require(path.join(scripts,"lib/project-prompt-builder.js"));
const generated=JSON.parse(fs.readFileSync(prompt,"utf8"));
const template=JSON.parse(fs.readFileSync(path.join(tplDir,"code-review-cycle.json"),"utf8"));
const r=selfHeal({ agent:"prompt-builder:code-review-cycle", reason, output:String(generated.body||""), failureClass:"rejected",
  model:process.env.EPAM_MODEL||"", provider:process.env.AI_PROVIDER||"", projectConfigDir:process.env.EPAM_PROJECT_CONFIG_DIR,
  context: healContext("code-review-cycle", template) });
console.log(`RESULT heal_ran=${r.ran} rc=${r.rc} analysed=${r.analysed} declined=${r.declined}`);
' "$SCRIPT_DIR" "$P/prompts/code-review-cycle.json" "$REPO_ROOT/orchestrations/prompts/templates" "$REASON" 2> "$W/heal.stderr"

EV="$C/kb/healing-events.jsonl"
if [ -s "$EV" ]; then
  "$NODE" -e '
const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop(); const e=JSON.parse(l);
const d=String(e.diagnosis||"");
console.log("RESULT diagnosis="+d.replace(/\s+/g," ").slice(0,600));
const blamesSlots=/placeholder|__[A-Z_]+__|unfilled|left verbatim|not substituted/i.test(d) && !/placeholders? (are|is) (not|never) the (defect|problem)/i.test(d);
console.log("RESULT verdict="+(blamesSlots?"BLAMES THE PLACEHOLDERS":"diagnoses the refusal, not the slots"));' "$EV"
else
  echo "RESULT verdict=NO DIAGNOSIS RECORDED (see $W/heal.stderr)"
fi
