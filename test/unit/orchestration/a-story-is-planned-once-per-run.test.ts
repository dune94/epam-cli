/**
 * A STORY IS PLANNED ONCE PER RUN; EVERY LANE WORKS FROM THAT ONE PLAN.
 *
 * Live 2026-10-07 (AMSD-2974, run 20261001T181327Z resumed): each resume restores the canonical PRD from the run's
 * checkpoint, which never held the plan, so the detective planned the story again on every launch — and answered
 * differently: this launch gave upexpress and metrolinx a change of their own (their stand-alone sign-in toast), the
 * last one gave them none. Each lane's checkpoint PRD still carried the older plan, and carry-plan only filled a plan
 * that was missing — so the lanes skipped the writer on a plan the run no longer held. A false green.
 *
 * Operator, 2026-10-06: one plan per story, passed to every codeline. A STEP NEVER RUNS TWICE: the plan a run wrote is
 * kept under the run (runs/<run>/plans/<story>.json) and reused on resume; a lane's copy takes the run's plan.
 *
 * EXECUTED: lib/handlers/write-missing-plans.js with the real detective and a model stand-in that answers with the
 * real reply the real detective gave (test/fixtures/frozen-detective); lib/handlers/carry-plan.js.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const FIXTURE = join(ROOT, 'test/fixtures/frozen-detective/amsd-2974-cxshared-overall-plan-20261006.txt');
const RUN = '20261001T181327Z';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'plan-once-')); dirs.push(d); return d; };

const story = { id: 'S-1', codeline: 'lib', codelines: ['lib', 'site'], title: 'make the notice accessible', description: 'the notice is not announced to screen readers' };

/** A project whose canonical PRD is restored as a resume restores it: the story, no plan. */
function project() {
  const d = tmp();
  for (const cl of ['lib', 'site']) mkdirSync(join(d, cl), { recursive: true });
  const proj = join(d, 'project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json'), join(proj, 'prompts', 'code-graph-detective.json'));
  const asked = join(d, 'asked');
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, `#!/bin/bash\ncat > /dev/null\necho asked >> ${JSON.stringify(asked)}\ncat ${JSON.stringify(FIXTURE)}\n`);
  chmodSync(runner, 0o755);
  const prd = join(d, 'prd.json');
  const restore = () => writeFileSync(prd, JSON.stringify({ project: { outputDir: join(d, 'lib'), outputDirs: [{ codeline: 'lib', path: join(d, 'lib') }, { codeline: 'site', path: join(d, 'site') }] }, stories: [story] }));
  restore();
  const logs = join(d, 'logs'); mkdirSync(logs);
  const launch = () => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/write-missing-plans.js'), prd], {
      encoding: 'utf8', timeout: 170000,
      env: { ...process.env, EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: proj, EPAM_RESUME_RUN: RUN, ORCH_RUN_ID: RUN, AI_RUNNER_CMD: runner, LOG_DIR: logs, SPEC_MODE_NO_MAIN: '1', EPAM_ORCHESTRATION_PROVIDER: process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter', NODE_BIN: process.execPath },
    });
    return { r, plan: JSON.parse(readFileSync(prd, 'utf8')).stories[0].overallPlan };
  };
  const askedN = () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { proj, launch, restore, askedN };
}

describe('the plan a run wrote is the plan on every later launch of that run', () => {
  it('first launch: the detective plans, and the plan is kept under the run', () => {
    const p = project();
    const { r, plan } = p.launch();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(plan, 'no plan was written').toBeTruthy();
    expect(p.askedN()).toBeGreaterThan(0);
    const kept = join(p.proj, 'runs', RUN, 'plans', 'S-1.json');
    expect(existsSync(kept), 'the plan was not kept under the run').toBe(true);
    expect(JSON.parse(readFileSync(kept, 'utf8'))).toEqual(plan);
  }, 180000);

  it('a resume restores the PRD without the plan: the kept plan is used, the detective is not asked again', () => {
    const p = project();
    const first = p.launch().plan;
    const askedFirst = p.askedN();
    p.restore();
    const { r, plan } = p.launch();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(plan).toEqual(first);
    expect(p.askedN(), 'the detective planned the story again').toBe(askedFirst);
    expect(r.stdout + r.stderr).toMatch(/S-1: the plan this run wrote is kept/);
  }, 180000);

  it('a story whose PRD carries a plan has that plan kept under the run, untouched', () => {
    const p = project();
    const plan = { codelines: [{ codeline: 'lib', part: 'p', order: 1 }], packages: [] };
    const prdPath = join(p.proj, '..', 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')); prd.stories[0].overallPlan = plan; writeFileSync(prdPath, JSON.stringify(prd));
    const { r, plan: after } = p.launch();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(after).toEqual(plan);
    expect(p.askedN()).toBe(0);
    expect(JSON.parse(readFileSync(join(p.proj, 'runs', RUN, 'plans', 'S-1.json'), 'utf8'))).toEqual(plan);
  }, 180000);
});

describe('a lane\'s copy takes the run\'s plan — an older plan it carries is replaced', () => {
  const stale = { codelines: [{ codeline: 'site', part: 'none', order: 2 }], packages: [{ package: '@s/lib', providedBy: 'lib', releaseLines: [], consumers: [{ codeline: 'site', declaredRange: '^1', receivesVia: '1.0.1', usage: [], change: 'none' }] }] };
  const current = { codelines: [{ codeline: 'site', part: 'fix its own sign-in toast', order: 2 }], packages: [{ package: '@s/lib', providedBy: 'lib', releaseLines: [], consumers: [{ codeline: 'site', declaredRange: '^1', receivesVia: '1.0.1', usage: [], change: 'fix its own stand-alone sign-in toast' }] }] };
  const carry = (lanePlan: object | null, canonicalPlan: object | null) => {
    const d = tmp();
    const lane = join(d, 'lane.json'); writeFileSync(lane, JSON.stringify({ stories: [{ id: 'S-1', ...(lanePlan ? { overallPlan: lanePlan } : {}) }] }));
    const canonical = join(d, 'canonical.json'); writeFileSync(canonical, JSON.stringify({ stories: [{ id: 'S-1', ...(canonicalPlan ? { overallPlan: canonicalPlan } : {}) }] }));
    expect(spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/carry-plan.js'), lane, canonical]).status).toBe(0);
    return JSON.parse(readFileSync(lane, 'utf8')).stories[0].overallPlan;
  };
  it('the lane carries an older plan: the run\'s plan replaces it', () => expect(carry(stale, current)).toEqual(current));
  it('the lane carries none: the run\'s plan is given', () => expect(carry(null, current)).toEqual(current));
  it('the run has no plan: the lane\'s copy is left as it is', () => expect(carry(stale, null)).toEqual(stale));
});
