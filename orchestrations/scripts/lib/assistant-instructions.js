'use strict';
/**
 * EVERY AGENT'S STANDING INSTRUCTIONS, AUTHORED BY AN AGENT — per project, per seam.
 *
 * Operator, 2026-09-29: "We cannot have thin SI" and "YOU need to do this agentically." A seam's
 * standing instructions (the codemie-web assistant's system instructions; the `__PERSONA__` slot every
 * other stack's prompt carries) are written by the seam si-author from four inputs that are all read,
 * never listed here:
 *
 *   the seam's task prompt       its template (engine-prompt.js templatePathFor)
 *   the seam's declaration       invocation-profiles.json: _what, toolGrant (as the tools it gives),
 *                                appliesTo, consumes, produces, maxToolCalls
 *   the agent's persona          agent-roster.js agentPersona (the project roster once it carries the
 *                                agent, the install's profiles before)
 *   the project                  its name and mode, and each codeline with the stack its ecosystem
 *                                plugin recognises
 *
 * si-review then falsifies them (reviewed like roster-review reviews briefs). A blocking finding sends
 * the seam back to si-author with the findings, up to the configured number of cycles; after that the
 * last instructions are KEPT and the findings recorded — never a halt.
 *
 * PERSISTED per project, one file per seam, under <project config>/assistant-instructions/, with a
 * digest of every input (the three templates and both authoring personas included). A seam is authored
 * again only when its digest changes, so a later run pays for nothing that did not change.
 *
 * WHEN IT RUNS (lib/mint-and-spec.sh): once before ingest and at mint start — from what exists then
 * (canonical personas, the project's mode, the estate) so the seams that run before the roster (codeline
 * discovery, AC classification, the mint's own seams) have authored instructions — and again after the
 * mint, when the roster and the codelines are known; only seams whose inputs changed are re-authored.
 *
 * CONSUMERS read one thing, `assistant-instructions` (readAuthored): the codemie-web assistant registry
 * and the persona slot (template-persona.js). Where nothing has been authored — a seam run outside a
 * pipeline run, or the two authoring seams themselves, whose instructions are their canonical personas —
 * the consumer lays out the agent's recorded persona (layoutDeclared) and says so.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** What the two authoring seams produce, as the registry declares it — the rest follows from these. */
const AUTHORED_KIND = 'assistant-instructions';
const REVIEW_KIND = 'instructions-review';
const LAYOUT_TEMPLATE = 'assistant-instructions';
const CORRECTIVE_TEMPLATE = 'si-author-corrective';

const TOOL_SI_AUTHOR = {
  name: 'submit_assistant_instructions',
  description: 'Submit the standing instructions for one pipeline agent, as named parts.',
  parameters: {
    type: 'object',
    required: ['role_and_purpose', 'judgement_framework', 'duties', 'constraints', 'output_protocol'],
    properties: {
      role_and_purpose: { type: 'string', description: 'The role, and in two to four sentences what the agent decides or produces, for whom, and what goes wrong downstream when it gets this wrong.' },
      judgement_framework: { type: 'array', items: { type: 'string' }, description: 'The standard the agent judges by: one concrete, checkable criterion per entry, including calibration.' },
      duties: { type: 'array', items: { type: 'string' }, description: 'What the agent does on every task, in order: one duty per entry.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Its tools exactly as declared, and its boundaries: one per entry.' },
      output_protocol: { type: 'string', description: 'One or two sentences: answer in exactly the structure the task prompt specifies and nothing else.' },
    },
  },
};

const TOOL_SI_REVIEW = {
  name: 'submit_instructions_review',
  description: 'Report what is false or missing in one agent\'s authored standing instructions.',
  parameters: {
    type: 'object',
    required: ['verdict', 'findings'],
    properties: {
      verdict: { type: 'string', enum: ['sound', 'defects_found'], description: 'sound = no finding of either severity. defects_found = at least one finding.' },
      findings: {
        type: 'array',
        description: 'One entry per defect. Empty when the instructions are sound.',
        items: {
          type: 'object',
          required: ['severity', 'quote', 'checked', 'found', 'remedy'],
          properties: {
            severity: { type: 'string', enum: ['blocking', 'advisory'], description: 'blocking = the agent would act wrongly or be misled. advisory = only the wording could be sharper.' },
            quote: { type: 'string', description: 'The instructions\' own words.' },
            checked: { type: 'string', description: 'What you checked.' },
            found: { type: 'string', description: 'What you found.' },
            remedy: { type: 'string', description: 'What must change.' },
          },
        },
      },
    },
  },
};

const agentsDirOf = (env) => env.EPAM_AGENTS_DIR || path.join(__dirname, '..', '..', 'agents');

function readRegistry(env = process.env) {
  // eslint-disable-next-line global-require
  const { registryPath } = require('./seam-invocation.js');
  return JSON.parse(fs.readFileSync(registryPath(agentsDirOf(env)), 'utf8'));
}

/** The authoring seams, read from what they produce — never named here. */
function authoringSeams(profiles) {
  const by = (kind) => Object.keys(profiles).find((k) => profiles[k] && profiles[k].produces === kind);
  return { author: by(AUTHORED_KIND), review: by(REVIEW_KIND) };
}

/** Settings for authoring (config/spec-mode-defaults.json `assistantInstructions`). */
function settings(env = process.env) {
  const file = env.EPAM_SPEC_MODE_DEFAULTS_FILE || path.join(__dirname, '..', '..', 'config', 'spec-mode-defaults.json');
  const s = (JSON.parse(fs.readFileSync(file, 'utf8')) || {}).assistantInstructions;
  if (!s || !Number.isInteger(s.reviewCycles) || !Number.isInteger(s.concurrency)) {
    throw new Error(`[instructions] ${file} declares no assistantInstructions {reviewCycles, concurrency}`);
  }
  return s;
}

const artefactDir = (projectDir) => path.join(projectDir, AUTHORED_KIND);
const fileFor = (projectDir, seam) => path.join(artefactDir(projectDir), `${String(seam).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

/** A seam's authored instructions for this project, or undefined when none have been authored. */
function readAuthored(seam, env = process.env) {
  const projectDir = env.EPAM_PROJECT_CONFIG_DIR || '';
  if (!projectDir || !seam) return undefined;
  try {
    const doc = JSON.parse(fs.readFileSync(fileFor(projectDir, seam), 'utf8'));
    return doc && typeof doc.rendered === 'string' && doc.rendered.trim() ? doc : undefined;
  } catch { return undefined; }
}

/** The full text of a template: its body, or every body of a multi-part one. */
function templateText(id) {
  // eslint-disable-next-line global-require
  const { templatePathFor } = require('./engine-prompt.js');
  const doc = JSON.parse(fs.readFileSync(templatePathFor(id), 'utf8'));
  if (typeof doc.body === 'string') return doc.body;
  return Object.entries(doc.bodies || {}).map(([k, v]) => `[${k}]\n${v}`).join('\n\n');
}

/** The tools a declared grant gives, as the runner receives them. */
function toolsOf(grant, codelinePaths) {
  if (!grant) return [];
  // eslint-disable-next-line global-require
  const list = require('./agent-tools.js').toolGrantFor(grant, codelinePaths || []);
  return String(list || '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** A seam's declaration as the author and reviewer are shown it. */
function declarationOf(seam, profile, codelinePaths) {
  return {
    seam,
    purpose: profile._what || '',
    tools: toolsOf(profile.toolGrant, codelinePaths),
    runsIn: profile.appliesTo || ['every mode'],
    consumes: (profile.consumes || []).map((c) => (typeof c === 'string' ? c : c.kind)),
    produces: profile.produces || '',
    maxToolCalls: profile.maxToolCalls,
  };
}

/** The agent's persona, where the pipeline keeps it. */
function personaOf(profile, env) {
  if (!profile.persona) return '';
  // eslint-disable-next-line global-require
  const { agentPersona } = require('./agent-roster.js');
  return String(agentPersona(profile.persona, agentsDirOf(env), env.EPAM_PROJECT_CONFIG_DIR) || '').trim();
}

/**
 * THE PROJECT, AS FAR AS IT IS KNOWN — data only. Codelines come from the caller (the discovery's
 * selection, or a greenfield project's declared codeline); each one's stack is what its ecosystem
 * plugin recognises from the manifest actually present.
 */
function projectContext({ project, mode, codelines, estateRoot }) {
  // eslint-disable-next-line global-require
  let resolveEcosystem = null;
  try { ({ resolveEcosystem } = require('./handlers/codeline-manifests.js')); } catch { resolveEcosystem = null; }
  const cls = (codelines || []).filter((c) => c && c.path).map((c) => {
    let eco = null;
    try { const hit = resolveEcosystem && resolveEcosystem(c.path); eco = hit && hit.eco; } catch { eco = null; }
    return { name: c.name || path.basename(c.path), path: c.path, stack: (eco && eco.stack) || null, manifest: (eco && eco.file) || null };
  });
  const ctx = { project: project || null, mode: mode || null, codelines: cls };
  if (!cls.length && estateRoot) ctx.estateRoot = estateRoot;
  return ctx;
}

/** Which seams this run uses: every seam with a task template that applies to this mode. */
function seamsForRun(profiles, mode) {
  const { author, review } = authoringSeams(profiles);
  const MODES = ['brownfield', 'greenfield'];
  return Object.keys(profiles).filter((k) => {
    const p = profiles[k];
    if (!p || !p.template || k === author || k === review) return false;
    const modes = (p.appliesTo || []).filter((a) => MODES.includes(a));
    return !modes.length || !mode || modes.includes(mode);
  });
}

const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const bullets = (list) => (list || []).map((x) => `- ${String(x).trim()}`).join('\n');

/** The authored parts, laid out as the agent reads them (templates/assistant-instructions.json). */
function layoutAuthored(role, parts) {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  return renderEngineTemplate(LAYOUT_TEMPLATE, {
    __ROLE__: role, __ROLE_AND_PURPOSE__: String(parts.role_and_purpose || '').trim(),
    __JUDGEMENT__: bullets(parts.judgement_framework), __DUTIES__: bullets(parts.duties),
    __CONSTRAINTS__: bullets(parts.constraints), __OUTPUT__: String(parts.output_protocol || '').trim(),
  }, 'authored').trim();
}

/** An agent's recorded persona, laid out the same way, where nothing has been authored. */
function layoutDeclared(role, personaText) {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  return renderEngineTemplate(LAYOUT_TEMPLATE, { __ROLE__: role, __PERSONA_TEXT__: personaText }, 'declared').trim();
}

/** Why an authored answer cannot be used, or '' when it can. */
function authoredGap(p) {
  if (!p || typeof p !== 'object') return 'no instructions object came back';
  const missing = TOOL_SI_AUTHOR.parameters.required.filter((k) => {
    const v = p[k];
    return Array.isArray(v) ? !v.filter((x) => String(x || '').trim()).length : !String(v || '').trim();
  });
  return missing.length ? `these parts are missing or empty: ${missing.join(', ')}` : '';
}

/** Everything a seam's instructions depend on, for its digest. */
function inputsFor(seam, profiles, ctx, env) {
  const profile = profiles[seam];
  const { author, review } = authoringSeams(profiles);
  return {
    declaration: declarationOf(seam, profile, (ctx.codelines || []).map((c) => c.path)),
    persona: personaOf(profile, env),
    template: templateText(profile.template),
    context: ctx,
    authoring: {
      author: templateText(profiles[author].template), review: templateText(profiles[review].template),
      layout: templateText(LAYOUT_TEMPLATE), corrective: templateText(CORRECTIVE_TEMPLATE),
      authorPersona: personaOf(profiles[author], env), reviewPersona: personaOf(profiles[review], env),
    },
  };
}

/**
 * Author (and review) ONE seam's instructions. `ask(seam, prompt, toolDef, tag, accept)` makes one
 * schema-bound call through the seam hub and returns the payload or null.
 */
async function authorSeam(seam, profiles, ctx, { ask, env = process.env, cycles }) {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate } = require('./engine-prompt.js');
  const { author, review } = authoringSeams(profiles);
  const inputs = inputsFor(seam, profiles, ctx, env);
  const declaration = JSON.stringify(inputs.declaration, null, 2);
  const context = JSON.stringify(ctx, null, 2);
  const reviews = [];
  let parts = null; let rendered = ''; let corrective = '';
  for (let cycle = 1; cycle <= Math.max(1, cycles); cycle += 1) {
    const prompt = renderEngineTemplate(profiles[author].template, {
      __TARGET_SEAM__: seam, __TARGET_DECLARATION__: declaration, __TARGET_PERSONA__: inputs.persona,
      __TARGET_TEMPLATE__: inputs.template, __PROJECT_CONTEXT__: context, __CORRECTIVE__: corrective,
    });
    // eslint-disable-next-line no-await-in-loop
    const got = await ask(author, prompt, TOOL_SI_AUTHOR, 'ASSISTANT_INSTRUCTIONS', (p) => authoredGap(p));
    if (authoredGap(got)) break;                       // keep the previous cycle's, if any
    parts = got;
    rendered = layoutAuthored(inputs.declaration.purpose, parts);
    const reviewPrompt = renderEngineTemplate(profiles[review].template, {
      __TARGET_SEAM__: seam, __TARGET_DECLARATION__: declaration, __TARGET_TEMPLATE__: inputs.template,
      __PROJECT_CONTEXT__: context, __AUTHORED__: rendered,
    });
    // eslint-disable-next-line no-await-in-loop
    const verdict = await ask(review, reviewPrompt, TOOL_SI_REVIEW, 'INSTRUCTIONS_REVIEW',
      (p) => (p && Array.isArray(p.findings) && typeof p.verdict === 'string' ? '' : 'a review is a verdict and a findings list'));
    reviews.push(verdict || { verdict: 'unreviewed', findings: [] });
    const blocking = ((verdict && verdict.findings) || []).filter((f) => f && f.severity === 'blocking');
    if (!verdict || !blocking.length) break;
    corrective = renderEngineTemplate(CORRECTIVE_TEMPLATE, {
      __FINDINGS__: JSON.stringify(verdict.findings, null, 2),
    });
  }
  if (!parts) return null;
  return { seam, digest: sha(inputs), parts, rendered, reviews, cycles: reviews.length, authoredAt: new Date().toISOString() };
}

/** The ask function every real run uses: the seam hub, the seam's own ladder, retries and grant. */
function hubAsker(env = process.env, { logDir, repoPath } = {}) {
  // eslint-disable-next-line global-require
  const spec = require('../spec-mode-runner.js');
  const execSpec = spec.resolvePromptExec(env.AI_RUNNER_CMD || path.join(__dirname, '..', 'ai-run.sh'));
  return async (seam, prompt, toolDef, tag, accept) => {
    const r = await spec.runSeamUntilAccepted({
      seam, execSpec, prompt, toolDef, tag, accept, logDir: logDir || null, repoPath: repoPath || '',
      logPath: logDir ? path.join(logDir, `${seam}.log`) : null, env: { EPAM_AGENT_NAME: seam },
    });
    return r && r.payload;
  };
}

/**
 * Ensure every seam this run uses has current authored instructions. Returns a tally; never throws for
 * one seam's failure — that seam keeps whatever it had, and the consumer says so.
 */
async function ensureAll({ ctx, env = process.env, ask, log = (m) => process.stderr.write(`${m}\n`) }) {
  const projectDir = env.EPAM_PROJECT_CONFIG_DIR || '';
  if (!projectDir) { log('[instructions] EPAM_PROJECT_CONFIG_DIR is unset — no project to author instructions for'); return { authored: 0, reused: 0, failed: 0 }; }
  const reg = readRegistry(env);
  const profiles = reg.profiles || {};
  const { reviewCycles, concurrency } = settings(env);
  const seams = seamsForRun(profiles, ctx.mode);
  fs.mkdirSync(artefactDir(projectDir), { recursive: true });
  const tally = { authored: 0, reused: 0, failed: 0 };
  const queue = [...seams];
  const worker = async () => {
    while (queue.length) {
      const seam = queue.shift();
      try {
        const digest = sha(inputsFor(seam, profiles, ctx, env));
        const have = readAuthored(seam, env);
        if (have && have.digest === digest) { tally.reused += 1; continue; }
        // eslint-disable-next-line no-await-in-loop
        const doc = await authorSeam(seam, profiles, ctx, { ask, env, cycles: reviewCycles });
        if (!doc) { tally.failed += 1; log(`[instructions] ${seam}: not authored — the author gave no usable answer; ${have ? 'the previous instructions stand' : 'its recorded persona is used'}`); continue; }
        fs.writeFileSync(fileFor(projectDir, seam), `${JSON.stringify(doc, null, 2)}\n`);
        tally.authored += 1;
        const last = doc.reviews[doc.reviews.length - 1] || {};
        log(`[instructions] ${seam}: authored in ${doc.cycles} cycle(s), review ${last.verdict || 'none'}${(last.findings || []).length ? ` (${last.findings.length} finding(s) recorded)` : ''}`);
      } catch (e) {
        tally.failed += 1;
        log(`[instructions] ${seam}: not authored — ${(e && e.message) || e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  log(`[instructions] ${seams.length} seam(s): ${tally.authored} authored, ${tally.reused} unchanged, ${tally.failed} not authored`);
  return tally;
}

/** The codelines this run knows: the discovery's selection, else a greenfield project's own codeline. */
function knownCodelines(env = process.env) {
  const logDir = env.LOG_DIR || '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(logDir, 'codeline-discovery.json'), 'utf8'));
    const cls = (d.codelines || []).filter((c) => c && c.path);
    if (cls.length) return cls.map((c) => ({ name: c.name, path: c.path }));
  } catch { /* not discovered yet */ }
  if (env.EPAM_BROWNFIELD !== '1' && env.OUTPUT_DIR) return [{ name: path.basename(env.OUTPUT_DIR), path: env.OUTPUT_DIR }];
  return [];
}

module.exports = {
  TOOL_SI_AUTHOR, TOOL_SI_REVIEW, readAuthored, layoutAuthored, layoutDeclared, ensureAll, authorSeam,
  seamsForRun, projectContext, knownCodelines, hubAsker, authoringSeams, inputsFor, AUTHORED_KIND, REVIEW_KIND,
};

if (require.main === module) {
  const env = process.env;
  const codelines = knownCodelines(env);
  const ctx = projectContext({
    project: env.PROJECT_NAME || path.basename(env.EPAM_PROJECT_CONFIG_DIR || ''),
    mode: env.EPAM_BROWNFIELD === '1' ? 'brownfield' : 'greenfield',
    codelines, estateRoot: env.JIRA_CODELINE_ROOT || '',
  });
  const repoPath = (codelines[0] && codelines[0].path) || env.JIRA_CODELINE_ROOT || env.PROJECT_ROOT || '';
  // NEVER FATAL: a run whose instructions could not be authored keeps what it had, and says so.
  const said = (e) => { process.stderr.write(`[instructions] not authored — ${(e && e.message) || e}\n`); process.exit(0); };
  try {
    ensureAll({ ctx, env, ask: hubAsker(env, { logDir: env.LOG_DIR, repoPath }) }).then(() => process.exit(0), said);
  } catch (e) { said(e); }
}
