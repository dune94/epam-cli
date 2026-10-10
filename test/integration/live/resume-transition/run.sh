#!/usr/bin/env bash
# THE RELAUNCH TRANSITION, ON LIVE TOKENS — the real settle, the real mint step, the real prompt builder.
#
#   run.sh <work-dir> <scenario> [live|dry] [install]
#
# A relaunch over the codelines the previous run already worked must keep that run's agents (no mint, no roster
# review) and serve its reviewed prompts from the cache, generating only what the cache does not hold (operator,
# 2026-10-09: "roster and prompt resume from partial cache ... fully tested outside a pipeline run - using live
# tokens"). AMSD-2974 run 7 proved the settle's DECISION and then re-reviewed and replaced a kept agent: a proof that
# stood in at the mint step. Here nothing is stood in: _run_agent_mint (lib/mint-and-spec.sh) is executed, and it
# executes mint-agents-step.js, which executes the builder. Every model call goes through ai-run.sh; a wrapper only
# records which agent made it. `dry` refuses every call (£0) — it shows what `live` would pay for.
#
# Scenarios (the project is a copy of the install's, as the last run left it):
#   same       — the run's own codelines                    → kept: 0 mint, 0 roster review, prompts from the cache
#   more       — one codeline more than the agents cover    → not kept: the mint runs
#   stale      — the roster no longer derives from today's seam bases → not kept: the mint runs
#   nocache    — the run's codelines, the prompt cache gone → kept agents; every prompt is generated
#
# Writes only under <work-dir>; the install is checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; SC="${2:?scenario: same|more|stale|nocache}"; MODE="${3:-dry}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${4:-${TRANSITION_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"
rm -rf "$W"; mkdir -p "$W/logs" "$W/replies"
_before=$(find "$P" -maxdepth 2 -type f \( -name '*.json' -o -name '.complete-*' \) -not -path '*/runs/*' -exec md5sum {} + | sort | md5sum | cut -c1-32)

# ── The project as the last run left it ───────────────────────────────────────────────────────────────────────────
C="$W/project"; cp -a "$P" "$C"; rm -rf "$C/runs" "$C/kb"
cp -a "$INSTALL/orchestrations/agents" "$W/agents"
for f in codeline-discovery.json estate-survey.json; do [ -f "$L/$f" ] && cp -a "$L/$f" "$W/logs/"; done
PRD="$C/prd.json"
# What a launch leaves for the mint to settle: pre-run-reset cannot know the codelines yet, so it defers.
: > "$C/.prompt-cache/.reset-pending"
case "$SC" in
  same) ;;
  more) "$NODE" -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));
          const d=p.project.outputDirs; d.push({...d[0], codeline:"another-codeline", path:d[0].path.replace(/[^/]+$/,"another-codeline")});
          require("fs").writeFileSync(f,JSON.stringify(p,null,2))' "$PRD" ;;
  stale) "$NODE" -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));
          const k=Object.keys(r).find((x)=>/base|digest|source/i.test(x)&&typeof r[x]==="string");
          if(!k){console.log("RESULT setup=no base digest in roster.json");process.exit(1)} r[k]="0".repeat(r[k].length);
          require("fs").writeFileSync(f,JSON.stringify(r,null,2))' "$C/roster.json" || exit 0 ;;
  nocache) find "$C/.prompt-cache" -mindepth 1 -not -name '.reset-pending' -exec rm -rf {} + 2>/dev/null ;;
  *) echo "RESULT setup=unknown scenario $SC"; exit 0 ;;
esac
_names_before=$("$NODE" -e 'const r=require(process.argv[1]+"/lib/project-roster.js").mintedFromRegistries(process.argv[2]);console.log(r.map(m=>m.name+"["+m.kind+"]").sort().join(","))' "$SCRIPT_DIR" "$C")

# ── Every model call recorded, then made (live) or refused (dry) ──────────────────────────────────────────────────
CALLS="$W/calls.log"; RUNNER="$W/ai-run.sh"
{ echo '#!/usr/bin/env bash'
  echo "printf '%s\n' \"\${EPAM_AGENT_NAME:-?}\" >> $(printf %q "$CALLS")"
  if [ "$MODE" = live ]; then echo "exec bash $(printf %q "$SCRIPT_DIR/ai-run.sh") \"\$@\""
  else echo 'cat >/dev/null; echo "dry: no model call made" >&2; exit 1'; fi; } > "$RUNNER"; chmod +x "$RUNNER"
# Mint invocations recorded at the process boundary (argv only) — the call still runs.
NODEW="$W/node"; { echo '#!/usr/bin/env bash'
  echo "case \"\$*\" in *mint-agents-step.js*) printf 'mint ROSTER_ONLY=%s\n' \"\${EPAM_ROSTER_ONLY:-0}\" >> $(printf %q "$W/mints.log");; esac"
  echo "exec $(printf %q "$NODE") \"\$@\""; } > "$NODEW"; chmod +x "$NODEW"

export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}"
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC EPAM_RESUME_RUN EPAM_REGENERATE_CODELINE_ASSETS EPAM_SKIP_AGENT_MINT
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" \
  EPAM_AGENT_REPLY_LOG_DIR="$W/replies" AI_RUNNER_CMD="$RUNNER" EPAM_AGENTS_DIR="$W/agents" \
  EPAM_CONTENT_RETRY_ATTEMPTS="${EPAM_CONTENT_RETRY_ATTEMPTS:-2}"

timeout "${TRANSITION_TIMEOUT:-5400}" bash -c '
  set -uo pipefail
  log(){ printf "%s\n" "$*"; }; error(){ printf "ERR %s\n" "$*"; }; info(){ :; }; warning(){ printf "WARN %s\n" "$*"; }
  require_stage_coverage(){ return 0; }
  NODE_BIN="$1"; SCRIPT_DIR="$2"
  . "$SCRIPT_DIR/lib/prompt-variant.sh"; . "$SCRIPT_DIR/lib/mint-and-spec.sh"
  _run_agent_mint "$3" "$4"; echo "MINT_STATUS=$?"
' _ "$NODEW" "$SCRIPT_DIR" "$PRD" "$W/mint.log" > "$W/settle.out" 2>&1

O="$W/settle.out"; cnt(){ grep -c "$1" "$2" 2>/dev/null || echo 0; }
echo "RESULT scenario=$SC mode=$MODE"
echo "RESULT settle=$(grep -o 'deferred decision settled: [^—]*' "$O" | head -1)"
echo "RESULT mint_status=$(grep -o 'MINT_STATUS=[0-9]*' "$O" | cut -d= -f2)"
echo "RESULT mint_runs=$(grep -c 'ROSTER_ONLY=0' "$W/mints.log" 2>/dev/null || echo 0) roster_only_runs=$(grep -c 'ROSTER_ONLY=1' "$W/mints.log" 2>/dev/null || echo 0)"
echo "RESULT roster_reviews=$(cnt 'roster review (cycle' "$O")"
echo "RESULT prompts_reused=$(cnt '\] reused ' "$O") prompts_generated=$(cnt '\] generated ' "$O") generation_attempts=$(grep -c ' attempt [0-9]*/' "$O" 2>/dev/null || echo 0)"
echo "RESULT installed=$(ls "$C/prompts"/*.json 2>/dev/null | wc -l)"
echo "RESULT calls=$(wc -l < "$CALLS" 2>/dev/null || echo 0) by_agent=$(sort "$CALLS" 2>/dev/null | uniq -c | awk '{printf "%s:%s ",$2,$1}')"
_names_after=$("$NODE" -e 'const r=require(process.argv[1]+"/lib/project-roster.js").mintedFromRegistries(process.argv[2]);console.log(r.map(m=>m.name+"["+m.kind+"]").sort().join(","))' "$SCRIPT_DIR" "$C")
echo "RESULT agents_unchanged=$([ "$_names_before" = "$_names_after" ] && echo yes || echo "NO before=$_names_before after=$_names_after")"
echo "RESULT install_untouched=$([ "$(find "$P" -maxdepth 2 -type f \( -name '*.json' -o -name '.complete-*' \) -not -path '*/runs/*' -exec md5sum {} + | sort | md5sum | cut -c1-32)" = "$_before" ] && echo yes || echo NO)"
grep -E '^ERR|refus|FAILED' "$O" | head -5 | sed 's/^/RESULT err: /'
