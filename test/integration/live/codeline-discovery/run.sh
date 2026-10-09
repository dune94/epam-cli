#!/usr/bin/env bash
# CODELINE DISCOVERY, ON LIVE TOKENS — the pipeline's own discovery agent, called exactly as ingest calls it.
#
#   run.sh <work-dir> [install]
#
# Live AMSD-2974 run 3 (2026-10-09): the discovery agent wrote run 2's working-PRD description into
# codeline-facts.json as "facts" about the repositories (source: runs/20261009T083016Z/work/upexpress-prd.json),
# the prompt builder baked them into every reusable prompt, and the prompt reviewer rejected seven attempts.
# A codeline fact is something the repository itself shows. This asks the real agent, on the real codelines,
# from the install's own directory (where a previous run's outputs are within reach, as they were live), and
# judges where every fact it reports came from.
#
# Input: the ticket as the install's PRD holds it (key, title, components, description — the fields discovery
# reads). Nothing is written outside <work-dir>. Prints RESULT lines; exit 0 always (the caller judges).
set -uo pipefail
W="${1:?work dir}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${2:-${DISCOVERY_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"
ROOT="${JIRA_CODELINE_ROOT:-$HOME/projects/tests/codelines}"
[ -f "$P/prd.json" ] || { echo "RESULT setup=no project PRD at $P"; exit 0; }

# The ticket, as discovery receives it.
"$NODE" -e '
const prd=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const seen=new Set(); const out=[];
for (const s of prd.stories||[]) { if (!s.jiraKey||seen.has(s.jiraKey)) continue; seen.add(s.jiraKey);
  out.push({jiraKey:s.jiraKey,title:s.title,components:s.components||[],labels:s.labels||[],description:s.description||""}); }
require("fs").writeFileSync(process.argv[2],JSON.stringify(out,null,2));' "$P/prd.json" "$W/issues.json"
echo "RESULT tickets=$("$NODE" -e 'console.log(require(process.argv[1]).length)' "$W/issues.json")"

export EPAM_PROVIDER_SET=copilot
export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$P" || { echo "RESULT setup=project env failed"; exit 0; }
# A COPY of the project, never the install's: discovery writes codeline-facts.json into the project config
# dir, and on 2026-10-09 this harness overwrote a live run's. The copy keeps what the live agent could reach —
# the project's config and a previous run's working PRDs (runs/<id>/work) — laid out as the install lays it out.
C="$W/install/orchestrations/projects/metrolinx"; mkdir -p "$C"
for f in config.env config.copilot.env llm-settings.json manifest.json plugins.json prompts; do [ -e "$P/$f" ] && cp -a "$P/$f" "$C/"; done
PREV=$(ls -t "$P/runs" 2>/dev/null | while read -r r; do [ -d "$P/runs/$r/work" ] && { echo "$r"; break; }; done)
[ -n "$PREV" ] && mkdir -p "$C/runs/$PREV" && cp -a "$P/runs/$PREV/work" "$C/runs/$PREV/"
echo "RESULT previous_run_outputs_reachable=${PREV:-none}"
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_BROWNFIELD=1
export EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
mkdir -p "$LOG_DIR" "$EPAM_AGENT_REPLY_LOG_DIR"
_facts_before=$(md5sum "$P/codeline-facts.json" 2>/dev/null | cut -c1-32)

# From the (copied) install's directory, as the live run was.
( cd "$W/install" && "$NODE" "$SCRIPT_DIR/lib/codeline-discovery.js" --issues "$W/issues.json" --root "$ROOT" --out "$W/discovery.json" ) \
  > "$W/discovery.log" 2>&1
echo "RESULT discovery_exit=$?"
echo "RESULT install_untouched=$([ "$(md5sum "$P/codeline-facts.json" 2>/dev/null | cut -c1-32)" = "$_facts_before" ] && echo yes || echo NO)"
[ -s "$W/discovery.json" ] || { echo "RESULT verdict=NO ANSWER (see $W/discovery.log)"; exit 0; }

# Where every fact came from: a file inside the repository it describes, or not.
"$NODE" -e '
const fs=require("fs"), path=require("path");
const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
let facts=0, inside=0; const outside=[];
for (const c of d.codelines||[]) for (const f of c.facts||[]) {
  facts++;
  const src=String(f.source||""); const file=src.split(/\s|:|,/)[0];
  const abs=path.isAbsolute(file)?file:path.join(c.path||"",file);
  const ok = !!file && fs.existsSync(abs) && path.resolve(abs).startsWith(path.resolve(c.path||"/nonexistent")+path.sep);
  if (ok) inside++; else outside.push(`${c.name}: ${src.slice(0,140)} — ${String(f.text).slice(0,90)}`);
}
console.log(`RESULT codelines=${(d.codelines||[]).map(c=>c.name).join(",")}`);
console.log(`RESULT facts=${facts} sourced_in_repo=${inside} sourced_elsewhere=${outside.length}`);
for (const o of outside) console.log(`RESULT elsewhere: ${o}`);
console.log(`RESULT verdict=${outside.length===0?"every fact is the repository speaking":"facts sourced outside the repository"}`);
' "$W/discovery.json"
