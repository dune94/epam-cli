/**
 * ONE PLAN FOR THE STORY, WRITTEN ONCE, AND EVERY CODELINE WORKED FROM IT.
 *
 * Operator, 2026-10-06: "when code detection returns multiple codelines we need an overall plan passed to each
 * codeline as a shared artefact"; "when there is only one codeline — one plan, same process"; the agent that
 * generates the plan is the code-graph detective. Proven on the real model the same day (Copilot, Claude
 * Sonnet 5, the real-estate copy of AMSD-2974): asked by detective-overall-plan, the detective wrote the plan —
 * 8.x and a 7.x back-port cut from v7.14.0, each consumer's blast radius, no consumer range edited. The engine
 * then parsed ZERO fix sites from that reply (it took the plan's codeline list for the fix-site list), and
 * nothing stored or distributed the plan.
 *
 * EXECUTED: the real parse on that real reply (frozen unchanged in test/fixtures/frozen-detective), the real
 * lane merge (lib/story-merge.js), and every real renderer an agent of a later lane is given: the detective's
 * prescription, the writer's fix plan and the reviewers' criteria (lib/producers/fix-plan.js), the spec
 * agent's shared block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
process.env.SPEC_MODE_NO_MAIN = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(SCRIPTS, 'spec-mode-runner.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixPlan = require(join(SCRIPTS, 'lib/producers/fix-plan.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storyMerge = require(join(SCRIPTS, 'lib/story-merge.js'));

const REPLY = readFileSync(join(ROOT, 'test/fixtures/frozen-detective/amsd-2974-cxshared-overall-plan-20261006.txt'), 'utf8');

/** The plan as the reply states it — read from the reply, never typed here. */
const STATED = JSON.parse((REPLY.match(/<OVERALL_PLAN>([\s\S]*?)<\/OVERALL_PLAN>/) || [])[1] || 'null');
const PROVIDER = STATED.packages[0].providedBy;
const CONSUMER = STATED.packages[0].consumers.find((c: { receivesVia: string }) => !STATED.packages[0].releaseLines.some((l: { version: string; line: string }) => l.version === c.receivesVia && l === STATED.packages[0].releaseLines[0]))
  || STATED.packages[0].consumers[0];
const LINES = STATED.packages[0].releaseLines as Array<{ line: string; base: string; version: string }>;

describe('the frozen reply is the real thing', () => {
  it('states a plan with every codeline, a provider, two release lines and its consumers', () => {
    expect(STATED.codelines.length).toBeGreaterThan(1);
    expect(LINES.length).toBe(2);
    expect(STATED.packages[0].consumers.length).toBeGreaterThan(1);
  });
});

describe('the detective\'s answer is read as two things: the plan and the fix sites', () => {
  it('the fix sites are found after the plan', () => {
    const sites = runner.parseDetectiveFindings(REPLY, '');
    expect(Array.isArray(sites) && sites.length, 'the plan was read as the fix-site list').toBeGreaterThan(0);
    expect(sites.every((s: { file: string }) => typeof s.file === 'string' && s.file.length > 0)).toBe(true);
  });
  it('the plan is read whole', () => {
    const plan = runner.parseOverallPlan(REPLY);
    expect(plan.codelines.map((c: { codeline: string }) => c.codeline)).toEqual(STATED.codelines.map((c: { codeline: string }) => c.codeline));
    expect(plan.packages[0].releaseLines).toEqual(LINES);
    expect(plan.packages[0].consumers[0].usage.length).toBeGreaterThan(0);
  });
  it('an answer with no plan has none, and its fix sites are read as before', () => {
    const noPlan = REPLY.replace(/<OVERALL_PLAN>[\s\S]*?<\/OVERALL_PLAN>/, '');
    expect(runner.parseOverallPlan(noPlan)).toBeNull();
    expect(runner.parseDetectiveFindings(noPlan, '').length).toBe(runner.parseDetectiveFindings(REPLY, '').length);
  });
  it('a malformed plan is not invented into one', () => {
    expect(runner.parseOverallPlan('<OVERALL_PLAN>{"codelines": "all of them"}</OVERALL_PLAN>')).toBeNull();
  });
});

const lanes = STATED.codelines.map((c: { codeline: string }) => c.codeline) as string[];
const storyWith = (codeline: string, plan: object | undefined) => ({
  id: 'S-1', title: 't', description: 'd', codeline, codelines: lanes, ...(plan ? { overallPlan: plan } : {}),
  fixSiteAnalysis: [], fixSiteAnalysisPerCodeline: {},
});
const prdFor = (codeline: string) => ({
  project: { outputDir: `/w/${codeline}`, outputDirs: lanes.map((cl) => ({ codeline: cl, path: `/w/${cl}` })) },
  stories: [storyWith(codeline, undefined)],
});

describe('the plan is written once and kept by every lane', () => {
  it('the first lane\'s plan survives a later lane that brings another', () => {
    const plan = runner.parseOverallPlan(REPLY);
    const canonical = { stories: [storyWith(lanes[0], plan)] };
    const later = { stories: [{ ...storyWith(lanes[1], { codelines: [{ codeline: lanes[1], part: 'a different plan', order: 1 }], packages: [] }), status: 'completed', completed: true }] };
    const merged = storyMerge.mergeLaneIntoCanonical({ canonical, updated: later, codeline: lanes[1] });
    const s = merged.stories.find((x: { id: string }) => x.id === 'S-1');
    expect(s.overallPlan).toEqual(plan);
  });
});

describe('every agent of a later codeline is given the plan, and its own part in it', () => {
  const planOf = () => runner.parseOverallPlan(REPLY);
  const consumer = CONSUMER.codeline as string;
  const part = (STATED.codelines.find((c: { codeline: string }) => c.codeline === consumer) || {}).part as string;

  it('the detective: works this codeline\'s part of the plan, and is not asked for another plan', () => {
    const out = runner.detectivePrescription('novel', storyWith(consumer, planOf()), prdFor(consumer));
    expect(out).toContain(part.slice(0, 60));
    for (const l of LINES) expect(out).toContain(l.base);
    expect(out, 'a second plan was asked for').not.toContain('<OVERALL_PLAN>');
  });

  it('the writer\'s fix plan', () => {
    const text = fixPlan.renderStoryPlan(storyWith(consumer, planOf()), prdFor(consumer), []);
    expect(text).toContain(part.slice(0, 60));
    for (const l of LINES) expect(text).toContain(l.base);
    expect(text, 'an absolute path reached the writer').not.toContain('/w/');
  });

  it('both reviewers (one renderer)', () => {
    const text = fixPlan.renderShared('review-shared', storyWith(consumer, planOf()), prdFor(consumer), []);
    expect(text).toContain(part.slice(0, 60));
    for (const l of LINES) expect(text).toContain(l.version);
  });

  it('the spec agent', () => {
    const text = runner.sharedSpecBlock([], storyWith(consumer, planOf()));
    expect(text).toContain(part.slice(0, 60));
    for (const l of LINES) expect(text).toContain(l.base);
  });

  it('a story with no plan renders exactly what it rendered before', () => {
    const s = storyWith(consumer, undefined);
    expect(fixPlan.renderStoryPlan(s, prdFor(consumer), [])).toBe(fixPlan.renderFixPlan([]));
    expect(runner.sharedSpecBlock([], s)).toBe('');
  });
});

describe('the first detective is asked for the plan; how a consumer receives it never moves its range', () => {
  it('a story with no plan yet is asked for one, with every codeline, single or many', () => {
    const many = runner.detectivePrescription('novel', storyWith(lanes[0], undefined), prdFor(lanes[0]));
    expect(many).toContain('<OVERALL_PLAN>');
    const one = runner.detectivePrescription('novel', { ...storyWith(lanes[0], undefined), codelines: [lanes[0]] }, prdFor(lanes[0]));
    expect(one).toContain('<OVERALL_PLAN>');
  });
  it('the plan says how a consumer receives the release within its declared range — never by installing the latest', () => {
    const out = runner.detectivePrescription('novel', storyWith(lanes[0], undefined), prdFor(lanes[0]));
    expect(out).toMatch(/within (the|its) declared range/i);
    expect(out).toMatch(/never by installing the latest/i);
  });
});

describe('the real detective run stores the plan on the story, once', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, copyFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os');
  const work = mkdtempSync(join(tmpdir(), 'one-plan-'));
  const fixture = join(ROOT, 'test/fixtures/frozen-detective/amsd-2974-cxshared-overall-plan-20261006.txt');
  // A stand-in model that answers with the real reply the real model gave.
  const runnerSh = join(work, 'det-runner.sh');
  writeFileSync(runnerSh, `#!/bin/bash\ncat > /dev/null\ncat ${JSON.stringify(fixture)}\n`);
  chmodSync(runnerSh, 0o755);
  const proj = join(work, 'project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(SCRIPTS, '../prompts/templates/code-graph-detective.json'), join(proj, 'prompts', 'code-graph-detective.json'));
  const site = join(work, 'site'); mkdirSync(site, { recursive: true });

  async function detect(story: Record<string, unknown>) {
    const saved = { ...process.env };
    Object.assign(process.env, { EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: proj, PROJECT_ROOT: site, AI_RUNNER_CMD: runnerSh, EPAM_ORCHESTRATION_PROVIDER: process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter', SPEC_MODE_NO_MAIN: '1' });
    delete process.env.PRD_FILE;
    try {
      const logDir = join(work, `logs-${Math.random().toString(36).slice(2)}`); mkdirSync(logDir, { recursive: true });
      await runner.runCodeGraphDetective(story, logDir, { promptExec: { cmd: runnerSh, args: [] }, prd: prdFor(lanes[0]) });
    } finally { process.env = saved; }
  }

  it('a story with no plan gets the one its detective wrote', async () => {
    const s = storyWith(lanes[0], undefined);
    await detect(s);
    expect((s as { overallPlan?: { packages: unknown[] } }).overallPlan, 'the plan the detective wrote was not stored').toBeTruthy();
    expect((s as { overallPlan: { packages: Array<{ releaseLines: unknown }> } }).overallPlan.packages[0].releaseLines).toEqual(LINES);
  }, 170000);

  it('a story that already has its plan keeps it — a later detective does not replace it', async () => {
    const first = { codelines: [{ codeline: lanes[0], part: 'the first plan', order: 1 }], packages: [] };
    const s = storyWith(lanes[1], first);
    await detect(s);
    expect((s as { overallPlan: unknown }).overallPlan).toEqual(first);
  }, 170000);
});
