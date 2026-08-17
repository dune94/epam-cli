#!/usr/bin/env node
/**
 * CAN EVERY AGENT THIS RUN WILL INVOKE ACTUALLY DELIVER?
 *
 * An agent needs six things, and today each is checked — if at all — somewhere different, so no
 * one place can answer the question. This answers it for every agent at once, from data:
 *
 *   seam     the archetype it is an instance of, resolved (never guessed)
 *   ladder   a model, a reasoning effort and an output budget at that seam's position
 *   prompt   a PROJECT prompt. The template zone is the immutable generic parent — a seam that
 *            executes it is running an unspecialised prompt on a specific project
 *   inputs   the seam declares what it consumes; every REQUIRED input needs a producer, or the
 *            agent is asked to work from evidence that will never arrive
 *   tools    the capability to do the job. A reviewer with no read_file reviews from imagination
 *   skills   the project-specific knowledge the seam expects it to have
 *
 * WHY THIS IS A HANDLER AND NOT A TEST: it runs against the LIVE roster of a real project, which
 * only exists mid-run. A test can assert the registry is coherent; only this can answer "the four
 * agents this run just minted are ready to work".
 *
 *   argv[2]  the project config dir (its prompts/ is the project prompt library)
 *   argv[3]  optional: agents dir (default: <engine>/orchestrations/agents)
 *
 *   stdout   one JSON object: { agents: [...], gaps: [...], ready: bool }
 *   exit 0   every agent is ready
 *   exit 1   at least one gap — the gaps array says which, per agent, per requirement
 *
 * Reports GAPS, never guesses a remedy: an agent missing a tool grant is a decision for whoever
 * declared the seam, and a handler that invented one would hide the omission.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const projectConfigDir = process.argv[2];
if (!projectConfigDir) {
  process.stderr.write('[agent-readiness] usage: <project-config-dir> [agents-dir]\n');
  process.exit(2);
}

const engineRoot = path.join(__dirname, '..', '..', '..', '..');
const agentsDir = process.argv[3] || path.join(engineRoot, 'orchestrations', 'agents');
const promptsDir = path.join(projectConfigDir, 'prompts');
const templatesDir = path.join(engineRoot, 'orchestrations', 'prompts', 'templates');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

let registry;
let profiles;
try {
  registry = readJson(path.join(agentsDir, 'invocation-profiles.json'));
  profiles = readJson(path.join(agentsDir, 'profiles.json'));
} catch (err) {
  process.stderr.write(`[agent-readiness] cannot read the roster: ${err.message}\n`);
  process.exit(2);
}

const { resolveSeam, seamInvocationEnv } = require('../seam-invocation.js');

/** Every agent with a minted profile — the roster this run will actually invoke. */
const agents = Object.keys(profiles).filter((k) => !k.startsWith('_'));

/** What produces each input kind, declared by the seams themselves. */
const producers = new Set(
  Object.values(registry.profiles || {}).map((p) => p.produces).filter(Boolean),
);
// engineProduces records inputs the PIPELINE supplies rather than an agent — a required input
// with a pipeline producer is satisfied, and treating it as a gap would report the engine's own
// deliberate design as a defect.
for (const kind of registry.engineProduces || []) producers.add(kind);

const report = [];
const gaps = [];

for (const agent of agents) {
  const row = { agent, seam: null, ladder: null, prompt: null, inputs: [], tools: null, skills: null };

  // ── seam ────────────────────────────────────────────────────────────────
  let seamName;
  try { seamName = resolveSeam(agent); } catch { seamName = null; }
  row.seam = seamName;
  if (!seamName) {
    gaps.push({ agent, requirement: 'seam', detail: 'resolves to no seam — it is not a named profile, no seamPattern matches it, and no default is declared' });
    report.push(row);
    continue;
  }
  const seam = (registry.profiles || {})[seamName] || {};

  // ── ladder ──────────────────────────────────────────────────────────────
  let env = {};
  try { env = seamInvocationEnv(agent) || {}; } catch { env = {}; }
  row.ladder = {
    model: env.EPAM_MODEL || null,
    effort: env.EPAM_REASONING_EFFORT || null,
    maxOutputTokens: env.EPAM_MAX_OUTPUT_TOKENS || null,
  };
  for (const [k, label] of [['model', 'a model'], ['effort', 'a reasoning effort'], ['maxOutputTokens', 'an output-token budget']]) {
    if (!row.ladder[k]) {
      gaps.push({ agent, requirement: 'ladder', detail: `seam '${seamName}' resolves ${label} of nothing — the agent runs unconfigured` });
    }
  }

  // ── prompt: PROJECT copy, never the template zone ───────────────────────
  const templateId = seam.template;
  if (!templateId) {
    gaps.push({ agent, requirement: 'prompt', detail: `seam '${seamName}' declares no template` });
  } else {
    const projectCopy = path.join(promptsDir, `${templateId}.json`);
    const templateCopy = path.join(templatesDir, `${templateId}.json`);
    row.prompt = { id: templateId, project: exists(projectCopy), template: exists(templateCopy) };
    if (!exists(projectCopy)) {
      gaps.push({
        agent,
        requirement: 'prompt',
        detail: exists(templateCopy)
          ? `no PROJECT prompt at ${projectCopy} — this seam would execute the generic template, unspecialised for this project`
          : `no prompt at all for '${templateId}' — neither a project copy nor a template`,
      });
    }
  }

  // ── inputs: every REQUIRED consume needs a producer ─────────────────────
  for (const c of seam.consumes || []) {
    const satisfied = producers.has(c.kind);
    row.inputs.push({ kind: c.kind, required: !!c.required, hasProducer: satisfied });
    if (c.required && !satisfied) {
      gaps.push({ agent, requirement: 'inputs', detail: `requires '${c.kind}' but nothing in the pipeline produces it — the agent is asked to work from evidence that never arrives` });
    }
  }

  // ── tools ───────────────────────────────────────────────────────────────
  row.tools = seam.allowedTools || null;
  if (!row.tools) {
    gaps.push({ agent, requirement: 'tools', detail: `seam '${seamName}' grants no tools — if this agent must read the repository to do its job, it cannot` });
  }

  // ── skills ──────────────────────────────────────────────────────────────
  row.skills = seam.skills || null;
  if (!row.skills) {
    gaps.push({ agent, requirement: 'skills', detail: `seam '${seamName}' declares no skills — nothing states what project knowledge this agent is expected to hold` });
  }

  report.push(row);
}

const out = { agents: report, gaps, ready: gaps.length === 0 };
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(gaps.length ? 1 : 0);
