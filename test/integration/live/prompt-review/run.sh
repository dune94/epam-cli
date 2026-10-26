#!/usr/bin/env bash
# THE PROMPT REVIEWER, ON LIVE TOKENS — no false positives, and lies still caught.
#
#   run.sh <work-dir> [install] [true-rounds=3] [false-rounds=2]
#
# AMSD-2974 runs 3 and 4 (2026-10-09) died in the Agents Phase when the prompt reviewer rejected a project prompt five
# times. Part of it was the reviewer itself: it called src/components/StarWidget/StarWidgetToast absent — a DIRECTORY,
# which a file glob cannot show — and a correct prompt lost attempts to it. A reviewer that blocks a correct prompt can
# end a run, so this holds it to both halves:
#   TRUE  — a real project prompt plus a block of verified-true claims written the awkward ways a generator writes them
#           (a directory named as a component, a file named without its directory, dependency ranges, a config throw):
#           every round must return ZERO findings against them.
#   FALSE — the same prompt with three planted false claims: every round must catch all three.
#
# The reviewer is the one a run uses: its project prompt is first regenerated from the current template through the
# real generator (test/integration/live/prompt-generation), then the real reviewer calls (lib/prompt-build-calls.js)
# judge the prompt, with read access to the run's codelines. Nothing is written outside <work-dir>.
# Prints RESULT lines; the last is the verdict. Exit 0 always.
set -uo pipefail
W="${1:?work dir}"; INSTALL="${2:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"
TRUE_ROUNDS="${3:-3}"; FALSE_ROUNDS="${4:-2}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"; CL="${JIRA_CODELINE_ROOT:-$HOME/projects/tests/codelines}"

# 1. The project's reviewer prompt, regenerated from the current template exactly as a run regenerates it.
bash "$REPO_ROOT/test/integration/live/prompt-generation/run.sh" "$W/gen" prompt-review "$INSTALL" | sed 's/^RESULT /RESULT reviewer-prompt: /'
[ -f "$W/gen/project/prompts/prompt-review.json" ] || { echo "RESULT verdict=NO REVIEWER PROMPT (see $W/gen)"; exit 0; }
C="$W/gen/project"

export EPAM_PROVIDER_SET="${LIVE_SET:-copilot}"   # LIVE_SET: the provider set under test (copilot when these harnesses were written, 2026-10-09; claude is the run set since 10-14)
[ "$EPAM_PROVIDER_SET" = copilot ] && export COPILOT_GITHUB_TOKEN="$("$NODE" -e 'const s=require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8").split("\n").filter(l=>!/^\s*\/\//.test(l)).join("\n");process.stdout.write(JSON.parse(s).copilotTokens["https://github.com:dune94"]||"")')"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$C" || { echo "RESULT setup=project env failed"; exit 0; }
export EPAM_PROJECT_CONFIG_DIR="$C" LOG_DIR="$W/logs" ACTIVITY_FILE="$W/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$W/replies"
mkdir -p "$LOG_DIR" "$EPAM_AGENT_REPLY_LOG_DIR"; cp "$L/codeline-discovery.json" "$LOG_DIR/"

# 2. The claims — each verified against the repositories when this harness was written (2026-10-09).
cat > "$W/claims.json" <<EOF
{ "true": [
  "cx-shared keeps a StarWidgetToast component under src/components/StarWidget (its message is ToastMessage.tsx).",
  "cx-shared's toast lives in src/components/ToastNotification.",
  "ToastMessage.tsx is the message content of the star widget's toast in cx-shared.",
  "next.gotransit.com depends on @metrolinx/cx-shared ^8.8.0.",
  "next.upexpress.com depends on @metrolinx/cx-shared ^7.2.2, and next.metrolinx.com on ^7.8.0.",
  "next.upexpress.com's next.config.ts throws outside tests when CLOUDINARY_DOMAIN or CLOUDINARY_CLOUDNAME is missing.",
  "All three sites run their tests with jest (npm test)."
  ],
  "false": [
  "cx-shared has a Snackbar component in src/components/Snackbar.",
  "next.upexpress.com depends on @metrolinx/cx-shared ^9.0.0.",
  "next.metrolinx.com runs its tests with vitest."
  ] }
EOF

"$NODE" - "$SCRIPT_DIR" "$REPO_ROOT" "$C" "$INSTALL" "$W" "$TRUE_ROUNDS" "$FALSE_ROUNDS" "$CL" <<'JS' 2> "$W/review.stderr"
const path = require('path'), fs = require('fs');
const [scripts, repo, cfg, install, work, tr, fr, clRoot] = process.argv.slice(2);
const spec = require(path.join(scripts, 'spec-mode-runner.js'));
const { promptBuildCalls } = require(path.join(scripts, 'lib/prompt-build-calls.js'));
const { buildCodelineContext } = require(path.join(scripts, 'lib/codeline-context.js'));
const { readOnlyToolGrant } = require(path.join(scripts, 'lib/agent-tools.js'));
const disc = JSON.parse(fs.readFileSync(path.join(process.env.LOG_DIR, 'codeline-discovery.json'), 'utf8'));
const codelines = disc.codelines.map((c) => ({ name: c.name, path: c.path }));
const prd = JSON.parse(fs.readFileSync(path.join(cfg, 'prd.json'), 'utf8'));
const claims = JSON.parse(fs.readFileSync(path.join(work, 'claims.json'), 'utf8'));
const id = 'code-review-cycle';
const base = JSON.parse(fs.readFileSync(path.join(install, 'orchestrations/projects/metrolinx/prompts', `${id}.json`), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(repo, 'orchestrations/prompts/templates', `${id}.json`), 'utf8'));
const { reviewPrompt } = promptBuildCalls({
  engineRoot: repo, logDir: process.env.LOG_DIR, runClaude: spec.runClaude,
  promptExec: spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(scripts, 'ai-run.sh')),
  projectConfigDir: cfg, codelineContext: buildCodelineContext({ codelines, factsFile: path.join(cfg, 'codeline-facts.json'), surveyed: [] }),
  stories: prd.stories || [], mintedDetail: [], toolGrant: readOnlyToolGrant(codelines.map((c) => c.path)), reviewEnabled: true,
});
const withClaims = (list) => ({ ...base, body: `${base.body}\n\n# How this project's codelines are laid out\n${list.map((c) => `- ${c}`).join('\n')}\n` });
// JUDGED FROM THE VERDICT, claim by claim: a finding is about a planted claim when the reviewer's own quoted claim
// contains that claim's text (its distinctive tail, after the codeline it names) — never by shared words, which paired
// the lie "upexpress depends on cx-shared ^9.0.0" with the truth "... ^7.2.2".
const vfile = path.join(process.env.LOG_DIR, 'prompt-review-verdicts.jsonl');
const lastVerdict = () => { const l = fs.readFileSync(vfile, 'utf8').trim().split('\n').pop(); return JSON.parse(l).verdict; };
const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9^@./]+/g, ' ').replace(/[.]+(\s|$)/g, ' ').trim();
const quoted = (v) => ((v && v.falseClaims) || []).map((c) => norm(typeof c === 'string' ? c : c.claim || ''));
const struck = (v, claim) => { const k = norm(claim).split(' ').slice(-4).join(' '); return quoted(v).some((q) => q.includes(k)); };
(async () => {
  let fp = 0, otherFindings = 0, caught = 0, missed = 0;
  for (let r = 1; r <= Number(tr); r += 1) {
    const v = await reviewPrompt({ id, template, generated: withClaims(claims.true) });
    const reason = String((v && v.reason) || '');
    const hits = v && v.reviewed !== false ? claims.true.filter((c) => struck(lastVerdict(), c)) : [];
    fp += hits.length;
    if (v && v.ok === false && !hits.length) otherFindings += 1;
    console.log(`RESULT true-round ${r}: ${v && v.ok === false ? 'REJECTED' : v && v.reviewed === false ? 'NO VERDICT' : 'approved'}`
      + `${hits.length ? ` — FALSE POSITIVE on: ${hits.map((h) => h.slice(0, 60)).join(' | ')}` : ''}`
      + `${v && v.ok === false && !hits.length ? ` — finding not about a planted claim: ${reason.slice(0, 200)}` : ''}`);
  }
  for (let r = 1; r <= Number(fr); r += 1) {
    const v = await reviewPrompt({ id, template, generated: withClaims([...claims.true, ...claims.false]) });
    const vd = v && v.reviewed !== false ? lastVerdict() : { falseClaims: [] };
    const got = claims.false.filter((c) => struck(vd, c));
    // A true claim is a false positive only when the reviewer struck IT, not the lie planted beside it.
    const fpHere = claims.true.filter((c) => struck(vd, c) && !claims.false.some((f) => struck(vd, f) && norm(f).split(' ').slice(0, 2).join(' ') === norm(c).split(' ').slice(0, 2).join(' ')));
    caught += got.length; missed += claims.false.length - got.length; fp += fpHere.length;
    console.log(`RESULT false-round ${r}: caught ${got.length}/${claims.false.length}${fpHere.length ? ` — and FALSE POSITIVE on: ${fpHere.map((h) => h.slice(0, 60)).join(' | ')}` : ''}`);
  }
  console.log(`RESULT false_positives=${fp} lies_caught=${caught} lies_missed=${missed} other_findings_on_true_rounds=${otherFindings}`);
  console.log(`RESULT verdict=${fp === 0 && missed === 0 ? 'SOLID — no false positive, every lie caught' : 'NOT SOLID'}`);
})();
JS
