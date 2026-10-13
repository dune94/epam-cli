#!/usr/bin/env bash
# A RESUME REVIEWS ONLY WHAT CHANGED — ON LIVE TOKENS, THE REAL BUILDER, THE INSTALL'S 44 PROMPTS (COPIES).
#
#   run.sh <work-dir> [install]
#
# AMSD-2974 run 9 iteration 3 (2026-10-13): adding release-line-port.json — an engine template no project prompt is
# built from — changed the prompt-input digest (it covered every template), and the resume sent every kept prompt back
# to the reviewer, paid, mid-run; two were rewritten. Operator: "I don't want a full review". The digest now covers the
# templates the build reads, and a kept prompt is judged again only when the generator or reviewer that approved it
# changed. This runs buildProjectPrompts exactly as the mint does on a resume (keepExisting, the real bootstrap and
# registry, lib/prompt-build-calls.js on the Claude set) against copies of the install's project, counting calls:
#   S1 an engine-only template added (the run's own case) → 0 generator, 0 reviewer calls; digest unchanged
#   S2 one kept prompt recorded as judged by an older reviewer → exactly 1 reviewer call, for it
#   S3 one generated prompt's template changed → it alone is rebuilt (generator called for it, nothing else)
# Writes only under <work-dir>; the install is checked unchanged. Prints RESULT lines; exit 0 always.
set -uo pipefail
W="${1:?work dir}"; INSTALL="${2:-$HOME/projects/tests/installs/amsd-2974-20260930T1455}"
rm -rf "$W"; mkdir -p "$W"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/orchestrations/scripts"; NODE="${NODE_BIN:-$(command -v node)}"
P="$INSTALL/orchestrations/projects/metrolinx"; L="$INSTALL/orchestrations/logs"
[ -d "$P/prompts" ] && [ -f "$L/codeline-discovery.json" ] || { echo "RESULT setup=missing install prompts or discovery"; exit 0; }
_sum() { find "$P/prompts" "$P/.prompt-cache" -type f -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -c1-32; }
_before=$(_sum)

export EPAM_PROVIDER_SET="${EPAM_PROVIDER_SET:-claude}" EPAM_BROWNFIELD=1
unset ANTHROPIC_API_KEY CLAUDE_API_KEY EPAM_API_KEY_ANTHROPIC

scenario() {   # <name> <mutation>
    local name="$1" d="$W/$1"; mkdir -p "$d"
    tar -C "$P" --exclude=./runs -cf - . | tar -C "$d" --one-top-level=project -xf -
    cp -a "$REPO_ROOT/orchestrations/prompts" "$d/prompts-layer"
    mkdir -p "$d/logs"; cp "$L/codeline-discovery.json" "$d/logs/"
    ( # shellcheck source=/dev/null
      . "$SCRIPT_DIR/lib/env-file.sh"; load_project_env "$d/project" >/dev/null 2>&1
      export EPAM_PROJECT_CONFIG_DIR="$d/project" LOG_DIR="$d/logs" ACTIVITY_FILE="$d/logs/agent-activity.jsonl" EPAM_AGENT_REPLY_LOG_DIR="$d/replies"
      "$NODE" - "$SCRIPT_DIR" "$REPO_ROOT" "$d" "$name" <<'JS'
const path = require('path'), fs = require('fs');
const [scripts, repo, d, name] = process.argv.slice(2);
const cfg = path.join(d, 'project'), layer = path.join(d, 'prompts-layer'), tdir = path.join(layer, 'templates');
const spec = require(path.join(scripts, 'spec-mode-runner.js'));
const B = require(path.join(scripts, 'lib/project-prompt-builder.js'));
const { promptBuildCalls } = require(path.join(scripts, 'lib/prompt-build-calls.js'));
const { buildCodelineContext } = require(path.join(scripts, 'lib/codeline-context.js'));
const { readOnlyToolGrant } = require(path.join(scripts, 'lib/agent-tools.js'));
const reg = path.join(repo, 'orchestrations/agents/invocation-profiles.json');
const disc = JSON.parse(fs.readFileSync(path.join(d, 'logs/codeline-discovery.json'), 'utf8'));
const codelines = (disc.codelines || []).map((c) => ({ name: c.name, path: c.path }));
const prd = JSON.parse(fs.readFileSync(path.join(cfg, 'prd.json'), 'utf8'));
const out = (k, v) => console.log(`RESULT ${name} ${k}=${v}`);
const before = B.promptInputsDigest({ templatesDir: tdir, registryFile: reg });
let target = '';
const generatedIds = fs.readdirSync(path.join(cfg, 'prompts')).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).filter((id) => { try { return !!JSON.parse(fs.readFileSync(path.join(cfg, 'prompts', `${id}.json`), 'utf8')).generatedFrom || /Generated from/.test(JSON.stringify(JSON.parse(fs.readFileSync(path.join(cfg, 'prompts', `${id}.json`), 'utf8')).$why || '')); } catch { return false; } }).sort();
if (name === 'S1') {
  fs.writeFileSync(path.join(tdir, 'zz-engine-only-added.json'), JSON.stringify({ id: 'zz-engine-only-added', seams: [], placeholders: [], version: 1, body: 'engine only' }));
} else if (name === 'S2') {
  target = generatedIds[0];
  const f = path.join(cfg, 'prompts', `${target}.json`); const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.judgedWith = 'an-older-generator:an-older-reviewer'; fs.writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');
} else if (name === 'S3') {
  target = generatedIds[0];
  const f = path.join(tdir, `${target}.json`); const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (typeof t.body === 'string') t.body += '\n'; else t.bodies = Object.fromEntries(Object.entries(t.bodies || {}).map(([k, v]) => [k, `${v}\n`]));
  fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\n');
}
if (target) out('target', target);
out('digest_unchanged', B.promptInputsDigest({ templatesDir: tdir, registryFile: reg }) === before ? 'yes' : 'NO');
const lines = [], calls = { gen: [], review: [] };
(async () => {
  try {
    const real = promptBuildCalls({
      engineRoot: repo, logDir: process.env.LOG_DIR, runClaude: spec.runClaude,
      promptExec: spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(scripts, 'ai-run.sh')),
      projectConfigDir: cfg, codelineContext: buildCodelineContext({ codelines, factsFile: path.join(cfg, 'codeline-facts.json'), surveyed: [] }),
      stories: prd.stories || [], mintedDetail: [], toolGrant: readOnlyToolGrant(codelines.map((c) => c.path)), reviewEnabled: true,
    });
    const counted = { ...real,
      runText: async (...a) => { calls.gen.push(String(a[0] && a[0].id || '')); return real.runText(...a); },
      reviewPrompt: real.reviewPrompt && (async (o) => { calls.review.push(o.id); return real.reviewPrompt(o); }) };
    await B.buildProjectPrompts({
      keepExisting: true, templatesDir: tdir, bootstrapFile: path.join(layer, 'bootstrap.json'), registryFile: reg,
      projectConfigDir: cfg, mode: 'generate', attempts: 3, projectContext: 'Project: metrolinx',
      codelineContext: '', mintedRoles: '(none minted this run)', ...counted, log: (m) => lines.push(m),
    });
    out('built', 'ok');
  } catch (e) { out('built', `ERROR ${String(e && e.message).slice(0, 200)}`); }
  out('generator_calls', calls.gen.length); out('reviewer_calls', calls.review.length);
  out('reviewed_ids', calls.review.join(',') || 'none');
  out('rebuilt', lines.filter((l) => /generated \S+ \(attempt|template changed since this copy/.test(l)).map((l) => l.replace(/\[prompt-builder\] /, '')).join(' | ') || 'none');
  out('kept', lines.filter((l) => /\] kept /.test(l)).length);
})();
JS
    ) > "$d/out.txt" 2> "$d/stderr.txt"
    grep -a "^RESULT" "$d/out.txt"
}

scenario S1; scenario S2; scenario S3
echo "RESULT install_untouched=$([ "$(_sum)" = "$_before" ] && echo yes || echo NO)"
