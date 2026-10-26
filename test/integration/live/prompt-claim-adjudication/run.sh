#!/usr/bin/env bash
# THE CLAIM ADJUDICATOR, ON LIVE TOKENS — true claims upheld against a wrong strike; lies never upheld.
#
#   run.sh <work-dir> [install] [rounds=2]
#
# When the prompt reviewer strikes the same claim twice, the adjudicator settles that one claim in the repositories
# (lib/prompt-review.js; AMSD-2974 runs 3 and 4 died when nothing could). It is only safe if BOTH hold:
#   TRUE claims, struck with a wrong or pedantic finding  → holds: true   (a correct prompt is never refused)
#   LIES, struck correctly                                → holds: false  (a lie never passes by persistence)
# Each claim was verified against the repositories when this was written (2026-10-09). The real adjudicate call
# (lib/prompt-build-calls.js) is used, with read access to the run's codelines. Nothing is written outside <work-dir>.
set -uo pipefail
W="${1:?work dir}"; INSTALL="${2:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"; ROUNDS="${3:-2}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"
C="$W/project"; mkdir -p "$C"
for f in config.env config.copilot.env llm-settings.json manifest.json plugins.json codeline-facts.json prd.json prompts; do [ -e "$P/$f" ] && cp -a "$P/$f" "$C/"; done
export EPAM_PROVIDER_SET="${LIVE_SET:-copilot}"   # LIVE_SET: the provider set under test (copilot when these harnesses were written, 2026-10-09; claude is the run set since 10-14)
[ "$EPAM_PROVIDER_SET" = copilot ] && export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
mkdir -p "$LOG_DIR" "$EPAM_AGENT_REPLY_LOG_DIR"; cp "$L/codeline-discovery.json" "$LOG_DIR/"

"$NODE" - "$SCRIPT_DIR" "$REPO_ROOT" "$C" "$ROUNDS" <<'JS' 2> "$W/adjudicate.stderr"
const path = require('path'), fs = require('fs');
const [scripts, repo, cfg, rounds] = process.argv.slice(2);
const spec = require(path.join(scripts, 'spec-mode-runner.js'));
const { promptBuildCalls } = require(path.join(scripts, 'lib/prompt-build-calls.js'));
const { buildCodelineContext } = require(path.join(scripts, 'lib/codeline-context.js'));
const { readOnlyToolGrant } = require(path.join(scripts, 'lib/agent-tools.js'));
const disc = JSON.parse(fs.readFileSync(path.join(process.env.LOG_DIR, 'codeline-discovery.json'), 'utf8'));
const codelines = disc.codelines.map((c) => ({ name: c.name, path: c.path }));
const { adjudicate } = promptBuildCalls({
  engineRoot: repo, logDir: process.env.LOG_DIR, runClaude: spec.runClaude,
  promptExec: spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(scripts, 'ai-run.sh')),
  projectConfigDir: cfg, codelineContext: buildCodelineContext({ codelines, factsFile: path.join(cfg, 'codeline-facts.json'), surveyed: [] }),
  stories: [], mintedDetail: [], toolGrant: readOnlyToolGrant(codelines.map((c) => c.path)), reviewEnabled: true,
});
const CASES = [
  { expect: true, claim: 'cx-shared keeps a StarWidgetToast component under src/components/StarWidget (its message is ToastMessage.tsx).',
    finding: 'StarWidgetToast is a folder, not a component; the exported component is ToastMessage.' },
  { expect: true, claim: "next.upexpress.com's next.config.ts throws outside tests when CLOUDINARY_DOMAIN or CLOUDINARY_CLOUDNAME is missing.",
    finding: 'next.config.ts never throws; missing variables are only logged.' },
  { expect: false, claim: 'cx-shared has a Snackbar component in src/components/Snackbar.',
    finding: 'No Snackbar component exists under src/components.' },
  { expect: false, claim: 'next.upexpress.com depends on @metrolinx/cx-shared ^9.0.0.',
    finding: 'package.json declares "@metrolinx/cx-shared": "^7.2.2".' },
];
const ONLY = (process.env.ADJ_CASES || '').split(',').filter(Boolean).map(Number);
(async () => {
  let wrong = 0, noRuling = 0;
  for (const [i, c] of CASES.entries()) {
    if (ONLY.length && !ONLY.includes(i + 1)) continue;
    for (let r = 1; r <= Number(rounds); r += 1) {
      let ruling = null;
      try { ruling = await adjudicate({ id: 'harness', claim: c.claim, finding: c.finding }); } catch (e) { ruling = null; }
      const got = ruling ? ruling.holds : 'NO RULING';
      if (!ruling) noRuling += 1; else if (ruling.holds !== c.expect) wrong += 1;
      console.log(`RESULT ${c.expect ? 'TRUE ' : 'LIE  '} r${r}: holds=${got} ${ruling && ruling.holds === c.expect ? 'ok' : 'WRONG'} — ${c.claim.slice(0, 60)} | ${String(ruling && ruling.evidence || '').replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  console.log(`RESULT wrong_rulings=${wrong} no_ruling=${noRuling}`);
  console.log(`RESULT verdict=${wrong === 0 && noRuling === 0 ? 'SOLID — every true claim upheld, every lie refused' : 'NOT SOLID'}`);
})();
JS
N=0; for f in "$W"/logs/copilot-calls/*.jsonl; do [ -f "$f" ] && N=$((N + $(grep -c 'Permission denied' "$f"))); done; echo "RESULT permission_denied=$N"
