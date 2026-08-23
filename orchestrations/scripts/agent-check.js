#!/usr/bin/env node
/**
 * PROVE ONE AGENT WORKS, ON ITS OWN, WITHOUT A PIPELINE RUN.
 *
 * Every agent defect found on 2026-08-23 was found by launching a run, watching it, and reading
 * what it left behind: the roster reviewer with no tools, the ladder that never reached a seam, the
 * brief block that rendered blank. Each cost a paid run to see, and killing the run destroyed the
 * evidence. That is the wrong way round — an agent is a unit and should be provable as one.
 *
 * This invokes ONE seam through the SAME path a run uses — its declared prompt, its declared
 * ladder and model, its declared tool grant, ai-run.sh — with a small, realistic input, and checks
 * the reply against what the seam declares it produces. No orchestration, no story loop, no reset,
 * no writes to a codeline.
 *
 * IT SPENDS REAL TOKENS, deliberately: the question is whether the agent works, and a mocked reply
 * answers a different question. One call per agent, smallest input that is still honest.
 *
 *   agent-check.js --seam <name>        check one
 *   agent-check.js --all                check every seam that declares a prompt
 *   agent-check.js --seam <name> --dry  render and validate the INPUT only; calls nothing
 *
 * Exit status is 0 only when every checked agent answered and its answer met its contract.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, 'lib');
const REGISTRY = path.join(__dirname, '..', 'agents', 'invocation-profiles.json');
const AI_RUN = path.join(__dirname, 'ai-run.sh');

const argv = process.argv.slice(2);
const arg = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

/** Every seam that names a prompt — read from the registry, never listed here. */
function seams() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const out = [];
  (function walk(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        if (typeof v.template === 'string') {
          out.push({ seam: k, template: v.template, produces: v.produces || '', profile: v });
        }
        walk(v);
      }
    }
  }((reg.profiles || {})));
  return out;
}

/**
 * A REALISTIC VALUE FOR ONE PLACEHOLDER.
 *
 * Derived from the placeholder's own name rather than a per-seam table: a table of 39 seams'
 * inputs is a second description of the pipeline that drifts from the first. The names are the
 * pipeline's own vocabulary — __STORY_ID__, __DIFF__, __CODELINE_CONTEXT__ — and they say what the
 * value is. Where a name is not self-describing the value is still a plainly-labelled string, so a
 * reply that depends on it can be read as depending on it.
 */
function valueFor(ph, ctx) {
  const n = ph.replace(/^__|__$/g, '').toLowerCase();
  const pick = (...pairs) => {
    for (const [re, v] of pairs) if (re.test(n)) return v;
    return null;
  };
  return pick(
    [/story_?id|ticket_?id|jira/, ctx.storyId],
    [/(^|_)path$|_path$|file$/, ctx.repoPath],
    [/codeline/, `- ${ctx.codeline} at ${ctx.repoPath}`],
    [/stack/, 'TypeScript, Node.js 20, jest'],
    [/title|summary/, 'Live preview of draft content in the CMS'],
    [/description|body|context|block|section|prompt|note|addendum|persona/,
      'This is the supplied context for the check. It is short on purpose: the question is '
      + 'whether this agent answers in the shape it declares, not whether it can summarise a '
      + 'large input.'],
    [/diff|patch/, '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-const a = 1;\n+const a = 2;\n'],
    [/test|spec/, 'src/x.test.ts'],
    [/criteria|ac(s)?$|vc(s)?$/, 'AC1: the page renders draft content when preview is enabled'],
    [/command|cmd/, 'npm test'],
    [/model|rung/, 'z-ai/glm-5.2'],
    [/tool/, 'read_file, list_files, search'],
    [/error|failure|log/, 'SyntaxError: Unexpected token export'],
    [/count|max|budget|limit/, '3'],
  ) || `(supplied value for ${ph})`;
}

/** Render the prompt this seam actually executes, with every placeholder it declares supplied. */
function renderFor(s, ctx) {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate, placeholdersIn } = require(path.join(LIB, 'engine-prompt.js'));
  const tplPath = path.join(__dirname, '..', 'prompts', 'templates', `${s.template}.json`);
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  // EVERY PART, NOT THE FIRST. A multi-body prompt declares the UNION of its parts' placeholders,
  // so rendering only part one and supplying only its placeholders fails on a value another part
  // needs — which reads as a pipeline defect and is not one. tc-writer found this immediately.
  const parts = tpl.bodies ? Object.keys(tpl.bodies) : [null];
  const rendered = [];
  for (const part of parts) {
    const body = part ? tpl.bodies[part] : String(tpl.body || '');
    const values = {};
    for (const ph of [...new Set(placeholdersIn(body))]) values[ph] = valueFor(ph, ctx);
    // The declared set may exceed this part's own usage; supply those too so the render is total.
    for (const ph of (tpl.placeholders || [])) if (!(ph in values)) values[ph] = valueFor(ph, ctx);

    // AND THE PROJECT COPY MAY DECLARE MORE THAN THE TEMPLATE. It is generated, so it can carry a
    // placeholder the template does not — tc-writer's does. Rather than guess at the difference,
    // the renderer is asked, and it names exactly what it is missing. Bounded, so a renderer that
    // always refuses cannot spin here.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rendered.push(renderEngineTemplate(s.template, values, part || undefined));
        break;
      } catch (e) {
        const m = String(e.message).match(/missing values for:\s*(.+)$/m);
        if (!m) throw e;
        const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
        if (!names.length) throw e;
        for (const ph of names) values[ph] = valueFor(ph, ctx);
        if (attempt === 5) throw e;
      }
    }
  }
  return rendered.join('\n\n');
}

/**
 * Did the agent answer in the shape its seam declares?
 *
 * Deliberately shallow: this asks whether the reply is USABLE — non-empty, and parseable as the
 * kind of thing the seam produces. Whether the content is correct is the agent's job and a
 * reviewer's; whether it is receivable at all is what every failure this month turned on.
 */
function checkReply(raw, produces) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, why: 'the agent returned nothing' };
  const looksJson = /^[[{]/.test(text) || /\{[\s\S]*\}/.test(text);
  if (/verdict|report|assignments|selection|criteria|survey|roster|prompts|contracts|estimate|findings|evidence|specification|summary|diagnosis|plan/i.test(produces)) {
    if (!looksJson) {
      return { ok: false, why: `declares it produces '${produces}' but the reply carries no JSON` };
    }
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    try { JSON.parse(m[0]); } catch (e) {
      return { ok: false, why: `the JSON it returned does not parse: ${e.message.slice(0, 80)}` };
    }
  }
  return { ok: true, why: `${text.length} chars` };
}

function checkOne(s, ctx) {
  let prompt;
  try {
    prompt = renderFor(s, ctx);
  } catch (e) {
    return { seam: s.seam, stage: 'input', ok: false, why: `prompt did not render: ${e.message}` };
  }
  if (!prompt.trim()) return { seam: s.seam, stage: 'input', ok: false, why: 'rendered empty' };
  if (ctx.dry) return { seam: s.seam, stage: 'input', ok: true, why: `${prompt.length} chars` };

  // THE SAME INVOCATION PATH A RUN USES: the seam's own env — its ladder, model, effort, tool
  // grant — resolved through seam-invocation, then ai-run.sh. A check that called a model directly
  // would prove the model works, not that this seam does.
  let env = { ...process.env, EPAM_AGENT_NAME: s.seam };
  try {
    // eslint-disable-next-line global-require
    const { seamInvocationEnv } = require(path.join(LIB, 'seam-invocation.js'));
    env = { ...env, ...seamInvocationEnv(s.seam, undefined, { env }) };
  } catch { /* a seam with no resolvable env still gets checked, and will say so */ }

  const tmp = path.join(require('os').tmpdir(), `agent-check-${s.seam.replace(/\W/g, '_')}.txt`);
  fs.writeFileSync(tmp, prompt);
  try {
    const raw = execFileSync('bash', [AI_RUN], {
      encoding: 'utf8', env, timeout: Number(ctx.timeoutMs), input: fs.readFileSync(tmp, 'utf8'),
      maxBuffer: 10 * 1024 * 1024,
    });
    const v = checkReply(raw, s.produces);
    return { seam: s.seam, stage: 'reply', ...v };
  } catch (e) {
    return { seam: s.seam, stage: 'call', ok: false, why: `the call failed: ${String(e.message).slice(0, 110)}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

const ctx = {
  storyId: arg('--story', 'AMSD-2041'),
  codeline: arg('--codeline', 'metrolinx'),
  repoPath: arg('--repo', process.env.PROJECT_ROOT || process.cwd()),
  dry: has('--dry'),
  timeoutMs: arg('--timeout-ms', '300000'),
};

const all = seams();
const wanted = has('--all') ? all : all.filter((s) => s.seam === arg('--seam'));
if (!wanted.length) {
  process.stderr.write(`no seam matched. --all, or --seam <one of>:\n  ${all.map((s) => s.seam).join('\n  ')}\n`);
  process.exit(2);
}

const results = [];
for (const s of wanted) {
  const r = checkOne(s, ctx);
  results.push(r);
  process.stdout.write(`${(r.ok ? 'ok  ' : 'FAIL')}  ${r.seam.padEnd(26)} ${r.stage.padEnd(6)} ${r.why}\n`);
}
const bad = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - bad.length}/${results.length} agent(s) answered in contract\n`);
process.exit(bad.length ? 1 : 0);
