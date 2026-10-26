#!/usr/bin/env bash
# PROJECT-PROMPT GENERATION, ON LIVE TOKENS — one prompt, the real generator and the real reviewer.
#
#   run.sh <work-dir> [prompt-id] [install]
#
# Live AMSD-2974 run 3 (2026-10-09) died in the Agents Phase: codeline-discovery's project prompt was rejected 5/5 by
# the prompt reviewer — correctly (it said a cx-shared change reaches all three sites, while upexpress and metrolinx
# are on the 7.x line; and "Five" call sites listing six) — because the generator was told only which claim was
# struck, never the reviewer's evidence. This runs buildProjectPrompts for ONE prompt with the very calls the mint
# makes (lib/prompt-build-calls.js), on the inputs that run handed it: its discovery artefact and its codeline facts,
# the bad ones included. It reports how many attempts the prompt took and whether it was installed.
#
# Nothing is written outside <work-dir>: the project is a copy. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; ID="${2:-codeline-discovery}"; rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
INSTALL="${3:-${GEN_INSTALL:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"
[ -f "$L/codeline-discovery.json" ] || { echo "RESULT setup=no discovery artefact at $L"; exit 0; }

C="$W/project"; mkdir -p "$C/prompts"
for f in config.env $(cd "$P" && ls config.*.env 2>/dev/null) llm-settings.json manifest.json plugins.json codeline-facts.json prd.json; do [ -e "$P/$f" ] && cp -a "$P/$f" "$C/"; done   # every set's config file: load_project_env loads config.<EPAM_PROVIDER_SET>.env
# The project's own prompts as the run had them (its reviewer prompt among them) — all but the one under test.
for f in "$P"/prompts/*.json; do [ "$(basename "$f" .json)" = "$ID" ] || cp -a "$f" "$C/prompts/"; done
# GEN_FACTS: the codeline facts to generate from (default: the install's, as the last run left them).
[ -n "${GEN_FACTS:-}" ] && cp "$GEN_FACTS" "$C/codeline-facts.json" && echo "RESULT facts_from=$GEN_FACTS"
_before=$(md5sum "$P/codeline-facts.json" "$P/prompts/$ID.json" 2>/dev/null | cut -c1-32 | tr '\n' ' ')
export EPAM_PROVIDER_SET="${LIVE_SET:-copilot}"   # LIVE_SET: the provider set under test (copilot when these harnesses were written, 2026-10-09; claude is the run set since 10-14)
[ "$EPAM_PROVIDER_SET" = copilot ] && export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
mkdir -p "$LOG_DIR" "$EPAM_AGENT_REPLY_LOG_DIR"
# The run's discovery artefact beside its logs, as the pipeline leaves it — a seam's codeline scope is read from it.
cp "$L/codeline-discovery.json" "$LOG_DIR/"

"$NODE" - "$SCRIPT_DIR" "$REPO_ROOT" "$C" "$L/codeline-discovery.json" "$ID" "$W" <<'JS' 2> "$W/build.stderr"
const path = require('path'), fs = require('fs');
const [scripts, repo, cfg, discFile, id, work] = process.argv.slice(2);
const spec = require(path.join(scripts, 'spec-mode-runner.js'));
const { buildProjectPrompts } = require(path.join(scripts, 'lib/project-prompt-builder.js'));
const { promptBuildCalls } = require(path.join(scripts, 'lib/prompt-build-calls.js'));
const { buildCodelineContext } = require(path.join(scripts, 'lib/codeline-context.js'));
const { readOnlyToolGrant } = require(path.join(scripts, 'lib/agent-tools.js'));
const promptsLib = require(path.join(scripts, 'lib/prompt-library.js'));
const disc = JSON.parse(fs.readFileSync(discFile, 'utf8'));
const codelines = (disc.codelines || []).map((c) => ({ name: c.name, path: c.path }));
const prd = JSON.parse(fs.readFileSync(path.join(cfg, 'prd.json'), 'utf8'));
const stories = prd.stories || [];
const codelineContext = buildCodelineContext({ codelines, factsFile: path.join(cfg, 'codeline-facts.json'), surveyed: [] });
// One seam: the registry holds only the profile whose template is this prompt; nothing auxiliary.
const reg = JSON.parse(fs.readFileSync(path.join(repo, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
const only = Object.fromEntries(Object.entries(reg.profiles || {}).filter(([, p]) => p && p.template === id).slice(0, 1));
fs.writeFileSync(path.join(work, 'registry.json'), JSON.stringify({ ...reg, profiles: only }));
// The real bootstrap's copied prompts (the generator's own prompt among them); no auxiliary generations.
const boot = JSON.parse(fs.readFileSync(path.join(repo, 'orchestrations/prompts/bootstrap.json'), 'utf8'));
fs.writeFileSync(path.join(work, 'bootstrap.json'), JSON.stringify({ ...boot, generated: [] }));
const lines = [];
(async () => {
  try {
    const calls = promptBuildCalls({
      engineRoot: repo, logDir: process.env.LOG_DIR, runClaude: spec.runClaude,
      promptExec: spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(scripts, 'ai-run.sh')),
      projectConfigDir: cfg, codelineContext, stories, mintedDetail: [], toolGrant: readOnlyToolGrant(codelines.map((c) => c.path)),
      reviewEnabled: true,
    });
    const built = await buildProjectPrompts({
      templatesDir: path.join(repo, promptsLib.TEMPLATE_DIR_REL), bootstrapFile: path.join(work, 'bootstrap.json'),
      registryFile: path.join(work, 'registry.json'), projectConfigDir: cfg, mode: 'generate', attempts: 5,
      projectContext: `Project: metrolinx\nTickets in scope: ${stories.map((t) => `${t.jiraKey || t.id}: ${t.title || ''}`).join(' | ')}`,
      codelineContext, mintedRoles: '(none minted this run)', ...calls, log: (m) => lines.push(m),
    });
    console.log(`RESULT installed=${(built.generated || []).includes(id) ? 'yes' : 'NO'}`);
  } catch (e) {
    console.log(`RESULT installed=NO error=${String(e && e.message).slice(0, 300)}`);
  }
  const tries = lines.filter((l) => l.includes(` ${id} attempt `));
  console.log(`RESULT attempts=${tries.length}`);
  for (const t of tries) console.log(`RESULT ${t.replace(/\s+/g, ' ').slice(0, 260)}`);
})();
JS
echo "RESULT install_untouched=$([ "$(md5sum "$P/codeline-facts.json" "$P/prompts/$ID.json" 2>/dev/null | cut -c1-32 | tr '\n' ' ')" = "$_before" ] && echo yes || echo NO)"
[ -s "$LOG_DIR/prompt-review-verdicts.jsonl" ] && echo "RESULT verdicts_kept=$(wc -l < "$LOG_DIR/prompt-review-verdicts.jsonl")"
