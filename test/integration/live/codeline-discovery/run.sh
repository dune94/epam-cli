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

# From the (copied) install's directory, as the live run was. DISCOVERY_SAMPLES separate real agent calls: discovery is
# a model, and one good answer proves nothing about the next (live 2026-10-09: 4, 3, then 5, 2, 5 codelines).
SAMPLES="${DISCOVERY_SAMPLES:-3}"; SETS=(); WT_TOTAL=0; DENIED=0
for i in $(seq 1 "$SAMPLES"); do
  S="$W/sample-$i"; mkdir -p "$S/logs"
  ( cd "$W/install" && LOG_DIR="$S/logs" ACTIVITY_FILE="$S/logs/agent-activity.jsonl" \
      "$NODE" "$SCRIPT_DIR/lib/codeline-discovery.js" --issues "$W/issues.json" --root "$ROOT" --out "$S/discovery.json" ) \
    > "$S/discovery.log" 2>&1
  [ -s "$S/discovery.json" ] || { echo "RESULT sample $i: NO ANSWER (see $S/discovery.log)"; SETS+=("<none>"); continue; }
  # A chosen codeline that is a git WORKTREE of another chosen codeline is that repository again, not a codeline:
  # its .git is a file naming the other's .git/worktrees/ (read from disk, no name pattern).
  read -r SET WT < <("$NODE" -e '
const fs=require("fs"), path=require("path");
const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const cls=d.codelines||[];
const gitDir=(p)=>{try{const g=path.join(p,".git");const st=fs.statSync(g);if(st.isDirectory())return path.resolve(g);
  const m=fs.readFileSync(g,"utf8").match(/gitdir:\s*(.+)/);return m?path.resolve(p,m[1].trim()):"";}catch{return ""}};
const mains=new Set(cls.map(c=>gitDir(c.path)).filter(g=>!/[\/]worktrees[\/]/.test(g)));
const wt=cls.filter(c=>{const g=gitDir(c.path);const m=g.match(/^(.*)[\/]worktrees[\/][^\/]+$/);return m&&mains.has(m[1]);});
console.log(cls.map(c=>c.name).sort().join(",")+" "+wt.length);' "$S/discovery.json")
  N=0; for f in "$S"/logs/copilot-calls/*.jsonl; do [ -f "$f" ] && N=$((N + $(grep -c 'Permission denied' "$f"))); done
  echo "RESULT sample $i: codelines=$SET worktree_chosen=$WT read_denied=$N"
  SETS+=("$SET"); WT_TOTAL=$((WT_TOTAL + WT)); DENIED=$((DENIED + N))
done
echo "RESULT install_untouched=$([ "$(md5sum "$P/codeline-facts.json" 2>/dev/null | cut -c1-32)" = "$_facts_before" ] && echo yes || echo NO)"
SAME=$(printf '%s\n' "${SETS[@]}" | sort -u | wc -l)
echo "RESULT samples=$SAMPLES distinct_sets=$SAME worktree_chosen=$WT_TOTAL"
if [ "$WT_TOTAL" -eq 0 ] && [ "$SAME" -eq 1 ] && [ "${SETS[0]}" != "<none>" ]; then
  echo "RESULT verdict=GREEN — every sample chose ${SETS[0]}, no worktree"
else
  echo "RESULT verdict=RED"
fi
