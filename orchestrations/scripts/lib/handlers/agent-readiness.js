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
 *   argv[4]  optional: the roster file this run is actually using
 *   argv[5]  optional: the codeline paths in scope, comma-separated
 *
 *   stdout   one JSON object: { agents: [...], gaps: [...], ready: bool }
 *   exit 0   every agent is ready
 *   exit 1   at least one gap — the gaps array says which, per agent, per requirement
 *   exit 2   the audit could not run, or had nothing to audit
 *
 * Reports GAPS, never guesses a remedy: an agent missing a tool grant is a decision for whoever
 * declared the seam, and a handler that invented one would hide the omission.
 *
 * IT MUST AUDIT THE RUN, NOT A FILE.
 *
 * It read agents/profiles.json unconditionally. That file is the canonical roster, restored to a
 * base state at the start of every run, and the agents a run MINTS live in the project store until
 * applyProjectProfiles merges them in. So the audit could pass in full while the four agents this
 * run had just created were not in the set at all — the same vacuous shape as a gate that reports
 * success because it had nothing to examine.
 *
 * Two changes: the roster file is named by the caller, and the project's minted profiles are
 * overlaid on top regardless — a minted agent is never silently outside the audit. And an EMPTY
 * roster is exit 2, never "ready": zero agents, zero gaps is not a pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

const rosterFile = process.argv[4] || path.join(agentsDir, 'profiles.json');
// Comma- or colon-separated codeline paths this run is working on.
const codelinePaths = process.argv[5] || '';

let registry;
let profiles;
try {
  registry = readJson(path.join(agentsDir, 'invocation-profiles.json'));
  profiles = readJson(rosterFile);
} catch (err) {
  process.stderr.write(`[agent-readiness] cannot read the roster: ${err.message}\n`);
  process.exit(2);
}

const { resolveSeam, seamInvocationEnv } = require('../seam-invocation.js');
const { projectProfilesPath } = require('../agent-roster.js');

/** Every agent this run will actually invoke: the roster, plus whatever this run minted. */
const agents = Object.keys(profiles).filter((k) => !k.startsWith('_'));
const mintedNames = [];
try {
  const store = readJson(projectProfilesPath(agentsDir)).profiles || {};
  for (const name of Object.keys(store)) {
    mintedNames.push(name);
    if (!agents.includes(name)) agents.push(name);
  }
} catch { /* no project store yet — a first run mints into an empty one */ }

// ZERO AGENTS, ZERO GAPS IS NOT A PASS. It is the audit reporting that it had nothing to look at.
if (!agents.length) {
  process.stderr.write(
    `[agent-readiness] the roster at ${rosterFile} holds no agents, and the project store at `
    + `${projectProfilesPath(agentsDir)} adds none. There is nothing to audit — which is not the `
    + 'same as everything being ready, so this is a failure rather than a pass.\n');
  process.exit(2);
}

/** What produces each input kind, declared by the seams themselves. */
const producers = new Set(
  Object.values(registry.profiles || {}).map((p) => p.produces).filter(Boolean),
);
// engineProduces records inputs the PIPELINE supplies rather than an agent — a required input
// with a pipeline producer is satisfied, and treating it as a gap would report the engine's own
// deliberate design as a defect.
for (const kind of registry.engineProduces || []) producers.add(kind);

// Resolved ONCE for the project: the skill picture is per-codeline, not per-agent, so asking for
// every agent would run the same resolution sixty times.
let skillsAvailable = false;
try {
  // THE CALLER NAMES THE CODELINES, because only the caller knows them.
  //
  // This asked process.env.EPAM_CODELINE_PATHS, which mint-agents-step does not set — it holds the
  // codelines in memory and prints them at the top of the stage. So the audit resolved no stacks,
  // decided the project had no skills at all, and failed run 20260817T195746Z with 60 identical
  // gaps, every one of them false, after discovery, survey, mint, assignment and 36 prompts had
  // all come out correct.
  //
  // Exactly the mistake this audit's first version made one field over: it read profiles.json
  // instead of the roster the run was using. A guard that fails a healthy run is worse than no
  // guard — it costs the run and teaches the operator to distrust the gate.
  const s = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, 'agent-skills.js'), '',
    agentsDir, codelinePaths || process.env.EPAM_CODELINE_PATHS || process.env.PROJECT_ROOT || '',
  ], { encoding: 'utf8', timeout: 20000 }));
  skillsAvailable = !s.empty;
} catch { skillsAvailable = false; }

const report = [];
const gaps = [];

for (const agent of agents) {
  const row = {
    agent,
    minted: mintedNames.includes(agent),
    seam: null, ladder: null, prompt: null, inputs: [], tools: null, skills: null,
  };

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
  // The KIND is declared on the seam; the LIST resolves per project, so a literal list here would
  // freeze one project's answer. Absent BOTH is the gap.
  row.tools = seam.allowedTools || seam.toolGrant || null;
  if (!row.tools) {
    gaps.push({ agent, requirement: 'tools', detail: `seam '${seamName}' declares neither allowedTools nor a toolGrant kind — if this agent must read the repository to do its job, it cannot` });
  }

  // ── skills ──────────────────────────────────────────────────────────────
  //
  // NOT a per-seam declaration. A skill is not a property of the archetype: an -investigator on a
  // Rust service and one on a Node front end are the same seam and need different knowledge. It is
  // resolved at invocation from the ecosystem registry and the KB written for that codeline, and
  // handed to the phase-assessment agent as __PROJECT_SKILLS__ so an AGENT decides what each
  // profile should therefore know.
  //
  // So the gap is not "this seam declares no skills" — it is "nothing could be resolved for this
  // project", which would mean every agent works blind.
  row.skills = skillsAvailable ? 'resolved at invocation' : null;
  if (!skillsAvailable) {
    gaps.push({ agent, requirement: 'skills', detail: 'no project skills resolve — neither a codeline stack nor any KB, so every agent works with no knowledge of this project' });
  }

  report.push(row);
}

const out = {
  roster: rosterFile,
  audited: report.length,
  minted: mintedNames,
  agents: report,
  gaps,
  ready: gaps.length === 0,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(gaps.length ? 1 : 0);
