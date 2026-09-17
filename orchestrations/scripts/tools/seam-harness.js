#!/usr/bin/env node
/**
 * seam-harness.js — run ONE seam, as the pipeline runs it, on the inputs a recorded run gave it.
 *
 *   node orchestrations/scripts/tools/seam-harness.js --seam project-roster-review \
 *        --run 20260916T234139Z --project skyscanner [--out <dir>]
 *
 * Operator, 2026-09-17: "Why do we have to run the entire pipeline to prove one fix?" A run that
 * aborts leaves its cassette (orchestrations/cassettes/<project>-<runId>/<seam>.json — the model's
 * replies and tool calls) and its inputs on disk. This takes the seam's REAL inputs from that run,
 * invokes the seam's REAL function with the REAL runner (the active provider set, real tools, real
 * model), and reports what the seam produced. One seam, cents, seconds — RED reproduces the abort,
 * GREEN proves the fix — before any relaunch.
 *
 * Nothing about a seam is written here twice: each entry below names the seam's inputs from the
 * run and the pipeline function that consumes them. A seam not listed is reported as such.
 *
 * Exit: 0 when the seam accepted (sound / complete), 1 when it refused, 2 on a harness error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

// THE ENGINE UNDER TEST IS THIS REPOSITORY; THE INPUTS MAY BE ANOTHER INSTALL'S. --install names
// the install whose run is being reproduced (its cassettes, logs, project config and PRD); the
// seam functions are always this checkout's, which is what makes a fix provable on the other
// agent's inputs before it is released to them.
const ENGINE = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(arg('install', ENGINE));
const SCRIPTS = path.join(ENGINE, 'orchestrations', 'scripts');
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function lastReplyText(cassetteFile) {
  const recs = readJson(cassetteFile);
  const list = Array.isArray(recs) ? recs : [recs];
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] && list[i].text) return list[i].text;
  throw new Error(`no reply text in ${cassetteFile}`);
}

/** Where a run's inputs live: the cassette, the archived logs, the project's config dir. */
function runContext({ run, project }) {
  // The cassette is one source of a seam's recorded reply; a run that never exported one still
  // left its inputs in the logs, so its absence is reported by the seam that needs it, not here.
  const cassette = path.join(ROOT, 'orchestrations', 'cassettes', `${project}-${run}`);
  const projectDir = path.join(ROOT, 'orchestrations', 'projects', project);
  // The run's logs, wherever pre-run-reset archived them — the archive whose files are newest
  // after the run started holds this run. mint-inputs.json (codelines) travels with them.
  const archives = fs.readdirSync(path.join(ROOT, 'orchestrations', 'logs', 'archive'))
    .filter((d) => d.startsWith('pre-run-')).sort();
  const runStamp = run.replace(/[TZ]/g, '');
  const later = archives.filter((d) => d.replace(/^pre-run-/, '').replace(/[TZ]/g, '') > runStamp);
  const logDirs = [path.join(ROOT, 'orchestrations', 'logs'), ...later.map((d) => path.join(ROOT, 'orchestrations', 'logs', 'archive', d))];
  const find = (name) => logDirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
  return { cassette, projectDir, find };
}

/** The run's stories: the PRD the project declares (PRD_FILE, loaded by seam-harness.sh). */
function storiesOf() {
  const prd = process.env.PRD_FILE ? path.resolve(ROOT, process.env.PRD_FILE) : '';
  if (!prd || !fs.existsSync(prd)) return [];
  const d = readJson(prd);
  return Array.isArray(d.stories) ? d.stories : [];
}

const SEAMS = {
  /**
   * project-roster: the whole roster stage — specialiser (produce) and reviewer (review) through
   * lib/project-roster.js buildProjectRoster, with the SAME closures mint-agents-step.js runs
   * (lib/roster-seams.js). Inputs from the run: the codelines the mint discovered, the agents it
   * minted (agent-mint.json), the estate survey's answer (its cassette), the project's PRD.
   */
  'project-roster': async (ctx, out) => {
    const roster = require(path.join(SCRIPTS, 'lib', 'project-roster.js'));
    const spec = require(path.join(SCRIPTS, 'spec-mode-runner.js'));
    const tools = require(path.join(SCRIPTS, 'lib', 'agent-tools.js'));
    const { rosterSeams } = require(path.join(SCRIPTS, 'lib', 'roster-seams.js'));
    const mintInputs = ctx.find('mint-inputs.json');
    const mintFile = ctx.find('agent-mint.json');
    if (!mintInputs) throw new Error('run inputs missing: mint-inputs.json');
    const codelines = readJson(mintInputs).codelines || [];
    const mintedDetail = mintFile ? (readJson(mintFile).minted || []) : [];
    // The survey's answer: the run persisted it (estate-survey.json in its logs); the cassette is
    // the fallback for a run whose logs were swept before that file joined the archive list.
    let survey = { ran: false, codelines: [] };
    const surveyFile = ctx.find('estate-survey.json');
    const surveyCassette = path.join(ctx.cassette, 'estate-survey.json');
    if (surveyFile) {
      try { const s = readJson(surveyFile); survey = { ran: true, ...s }; } catch { /* left as not run */ }
    } else if (fs.existsSync(surveyCassette)) {
      try { survey = { ran: true, ...JSON.parse(lastReplyText(surveyCassette).replace(/^[\s\S]*?(\{)/, '$1')) }; } catch { /* left as not run */ }
    }
    const stories = storiesOf();
    const AGENTS_DIR = path.join(ENGINE, 'orchestrations', 'agents');
    const canonicalPath = path.join(AGENTS_DIR, 'profiles.canonical.json');
    // The roster lands in a COPY of the project dir so the harness never writes the project's own roster.json.
    const projectDir = path.join(out, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const f of fs.readdirSync(ctx.projectDir)) {
      const src = path.join(ctx.projectDir, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(projectDir, f));
    }
    // A SETTLED ROSTER SHORT-CIRCUITS THE STAGE (buildProjectRoster reuses it, by design, on a
    // resume). The harness exists to RUN the seams, so the copy starts without one — a 0.15 s
    // "accepted" that called no model is not a test.
    fs.rmSync(path.join(projectDir, 'roster.json'), { force: true });
    process.env.EPAM_PROJECT_CONFIG_DIR = projectDir;
    const promptExec = spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(SCRIPTS, 'ai-run.sh'));
    const toolGrant = tools.readOnlyToolGrant(codelines.map((c) => c && c.path));
    const { produce, review } = rosterSeams({
      spec, promptExec, projectConfigDir: projectDir, LOG_DIR: out, AGENTS_DIR,
      REPO_PATH: codelines.length ? codelines[0].path : '', codelines, stories, mintedDetail, survey, toolGrant,
    });
    const log = [];
    const result = await roster.buildProjectRoster({
      canonicalPath, logDir: out, projectConfigDir: projectDir, produce, review,
      attempts: Number(process.env.EPAM_ROSTER_ATTEMPTS || 3),
      log: (m) => { log.push(m); process.stderr.write(`[roster] ${m}\n`); },
    }).then((r) => ({ ok: true, roster: r })).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    return { accepted: result.ok, result: { ...result, log }, inputs: { codelines, minted: mintedDetail.map((m) => m.name), surveyRan: survey.ran, stories: stories.length, toolGrant } };
  },

  /**
   * project-roster-review: judges the specialiser's derived roster against the canonical one.
   * Inputs from the run: the specialiser's last answer (its delta), composed exactly as
   * lib/project-roster.js composes it; the canonical copy the run made; the codelines the mint
   * discovered; the mint's read-only tool grant.
   */
  'project-roster-review': async (ctx, out) => {
    const roster = require(path.join(SCRIPTS, 'lib', 'project-roster.js'));
    const spec = require(path.join(SCRIPTS, 'spec-mode-runner.js'));
    const tools = require(path.join(SCRIPTS, 'lib', 'agent-tools.js'));
    const canonicalPath = ctx.find('roster-canonical-copy.json');
    const mintInputs = ctx.find('mint-inputs.json');
    if (!canonicalPath || !mintInputs) throw new Error(`run inputs missing: canonical=${canonicalPath} mint-inputs=${mintInputs}`);
    const canonical = readJson(canonicalPath);
    const delta = roster.extractDeltaJson(lastReplyText(path.join(ctx.cassette, 'roster-specialiser.json')));
    if (!delta) throw new Error('the specialiser\'s last reply holds no delta JSON');
    let composed = roster.composeFromDelta(delta, canonical).roster;
    composed = roster.withMintedAgents(composed, ctx.projectDir);
    const rosterPath = path.join(out, 'roster.json');
    fs.writeFileSync(rosterPath, JSON.stringify(composed, null, 2));
    const codelines = readJson(mintInputs).codelines || [];
    const toolGrant = tools.readOnlyToolGrant(codelines.map((c) => c && c.path));
    process.env.EPAM_PROJECT_CONFIG_DIR = ctx.projectDir;
    process.env.EPAM_AGENT_NAME = 'project-roster-review';
    const promptExec = spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(SCRIPTS, 'ai-run.sh'));
    const verdict = await spec.reviewProjectRoster({
      promptExec, rosterPath, canonicalPath, codelines, tickets: storiesOf(), logDir: out,
      repoPath: codelines.length ? codelines[0].path : '', toolGrant,
    });
    return { accepted: verdict && verdict.verdict === 'sound', result: verdict, inputs: { rosterPath, canonicalPath, codelines, toolGrant } };
  },
};

async function main() {
  const seam = arg('seam'); const run = arg('run'); const project = arg('project');
  if (!seam || !run || !project) { console.error('usage: --seam <name> --run <runId> --project <name> [--out <dir>]'); process.exit(2); }
  if (!SEAMS[seam]) { console.error(`seam '${seam}' has no harness entry; known: ${Object.keys(SEAMS).join(', ')}`); process.exit(2); }
  const out = arg('out', path.join(ROOT, 'orchestrations', 'logs', 'seam-harness', `${seam}-${run}-${Date.now()}`));
  fs.mkdirSync(out, { recursive: true });
  const ctx = runContext({ run, project });
  const started = Date.now();
  const r = await SEAMS[seam](ctx, out);
  const report = { seam, run, project, providerSet: process.env.EPAM_PROVIDER_SET || '', accepted: r.accepted, seconds: Math.round((Date.now() - started) / 10) / 100, inputs: r.inputs, result: r.result };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ accepted: r.accepted, seconds: report.seconds, out }, null, 0));
  const findings = (r.result && r.result.findings) || [];
  for (const f of findings) console.log(`  [${f.severity}] ${f.agent}: ${String(f.found || f.claim || '').slice(0, 220)}`);
  process.exit(r.accepted ? 0 : 1);
}

main().catch((e) => { console.error(`[seam-harness] ${e && e.stack || e}`); process.exit(2); });
