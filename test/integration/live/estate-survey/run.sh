#!/usr/bin/env bash
# THE ESTATE SURVEY, ON LIVE TOKENS — can the agent read every codeline of the run?
#
#   run.sh <work-dir> [install]
#
# Live AMSD-2974 runs 3 and 4 (2026-10-09): on the copilot set the survey's tool calls into next.gotransit.com,
# next.upexpress.com and next.metrolinx.com were refused — "Permission denied because no interactive user response was
# available" (9 refusals in run 4) — because only PROJECT_ROOT and the project folder were readable before the lanes.
# Every later agent of the Agents Phase was as blind, and both runs died there.
#
# This calls the real spec.surveyEstate exactly as the mint step does, with the run's own discovery artefact, and
# counts what the CLI refused. Nothing is written outside <work-dir>. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${2:-${SURVEY_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"
[ -f "$L/codeline-discovery.json" ] || { echo "RESULT setup=no discovery artefact at $L"; exit 0; }

C="$W/project"; mkdir -p "$C"
for f in config.env config.copilot.env llm-settings.json manifest.json plugins.json prompts prd.json; do [ -e "$P/$f" ] && cp -a "$P/$f" "$C/"; done
mkdir -p "$W/logs"; cp "$L/codeline-discovery.json" "$W/logs/"
export EPAM_PROVIDER_SET=copilot
export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
FIRST=$("$NODE" -e 'console.log(require(process.argv[1]).codelines[0].path)' "$W/logs/codeline-discovery.json")
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
export PROJECT_ROOT="$FIRST" PRD_FILE="$C/prd.json"
mkdir -p "$EPAM_AGENT_REPLY_LOG_DIR"

( cd "$INSTALL" && "$NODE" - "$SCRIPT_DIR" "$W" <<'JS' ) 2> "$W/survey.stderr"
const path = require('path'), fs = require('fs');
const [scripts, work] = process.argv.slice(2);
process.env.EPAM_AGENT_NAME = 'estate-survey';
const spec = require(path.join(scripts, 'spec-mode-runner.js'));
const disc = JSON.parse(fs.readFileSync(path.join(process.env.LOG_DIR, 'codeline-discovery.json'), 'utf8'));
const codelines = disc.codelines.map((c) => ({ name: c.name, path: c.path }));
const prd = JSON.parse(fs.readFileSync(process.env.PRD_FILE, 'utf8'));
const toolGrant = require(path.join(scripts, 'lib/agent-tools.js')).readOnlyToolGrant(codelines.map((c) => c.path));
(async () => {
  const survey = await spec.surveyEstate({
    promptExec: spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(scripts, 'ai-run.sh')),
    tickets: prd.stories || [], referencedDocs: [], declaredDependencies: {}, codelines, toolGrant,
    logDir: process.env.LOG_DIR, repoPath: process.env.PROJECT_ROOT,
  });
  console.log(`RESULT survey_ran=${survey.ran}`);
  for (const c of survey.codelines || []) console.log(`RESULT survey ${c.codeline}: ${c.state} surfaces=${(c.surfaces || []).length}`);
})();
JS
N=0; for f in "$W"/logs/copilot-calls/*.jsonl; do [ -f "$f" ] && N=$((N + $(grep -c 'Permission denied' "$f"))); done
echo "RESULT permission_denied=$N"
for cl in $("$NODE" -e 'for (const c of require(process.argv[1]).codelines) console.log(c.path)' "$W/logs/codeline-discovery.json"); do
  n=$(cat "$W"/logs/copilot-calls/*.jsonl 2>/dev/null | "$NODE" -e '
let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{let n=0;for(const l of t.split("\n")){try{const e=JSON.parse(l);
if(e.type==="tool.execution_start"&&JSON.stringify(e.data.arguments||{}).includes(process.argv[1]))n++}catch{}}console.log(n)})' "$cl")
  echo "RESULT tool_calls_into $(basename "$cl")=$n"
done
