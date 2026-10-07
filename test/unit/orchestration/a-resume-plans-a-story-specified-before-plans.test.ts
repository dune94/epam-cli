/**
 * A STORY SPECIFIED BEFORE IT HAD A PLAN GETS ITS PLAN ON RESUME; A PASSED LANE STILL SHIPS ITS OTHER RELEASE LINES.
 *
 * The £0 rehearsal of AMSD-2974 (2026-10-06): the story was specified before plans existed, so the resume skipped the
 * spec pass and no detective wrote a plan — no release line could ever run; and the library lane, declared passed
 * on its own line, was skipped whole, release lines included. Operator, 2026-10-06: "Yea" to (a) a story with spec
 * output and no plan gets its plan written (the detective's plan only, nothing re-specified), (b) a passed lane still
 * runs the release lines the plan names off its base. A resumed lane works from its own checkpoint PRD, which never
 * held the plan — the plan is read from the canonical PRD then; no checkpoint is edited.
 *
 * EXECUTED: lib/handlers/write-missing-plans.js running the real detective with a model stand-in that answers with
 * the real reply the real detective gave (test/fixtures/frozen-detective); the real release-line handlers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const FIXTURE = join(ROOT, 'test/fixtures/frozen-detective/amsd-2974-cxshared-overall-plan-20261006.txt');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'resume-plan-')); dirs.push(d); return d; };

function project(stories: object[], runnerBody?: string) {
  const d = tmp();
  for (const cl of ['lib', 'site']) mkdirSync(join(d, cl), { recursive: true });
  const proj = join(d, 'project'); mkdirSync(join(proj, 'prompts'), { recursive: true });
  copyFileSync(join(ROOT, 'orchestrations/prompts/templates/code-graph-detective.json'), join(proj, 'prompts', 'code-graph-detective.json'));
  const asked = join(d, 'asked');
  const runner = join(d, 'runner.sh');
  writeFileSync(runner, runnerBody ?? `#!/bin/bash\ncat > /dev/null\necho asked >> ${JSON.stringify(asked)}\ncat ${JSON.stringify(FIXTURE)}\n`);
  chmodSync(runner, 0o755);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { outputDir: join(d, 'lib'), outputDirs: [{ codeline: 'lib', path: join(d, 'lib') }, { codeline: 'site', path: join(d, 'site') }] }, stories }));
  const logs = join(d, 'logs'); mkdirSync(logs);
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/write-missing-plans.js'), prd], {
    encoding: 'utf8', timeout: 170000,
    env: { ...process.env, EPAM_BROWNFIELD: '1', EPAM_PROJECT_CONFIG_DIR: proj, AI_RUNNER_CMD: runner, LOG_DIR: logs, SPEC_MODE_NO_MAIN: '1', EPAM_ORCHESTRATION_PROVIDER: process.env.EPAM_ORCHESTRATION_PROVIDER || 'openrouter', NODE_BIN: process.execPath },
  });
  const after = JSON.parse(readFileSync(prd, 'utf8'));
  const askedN = existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  return { r, after, askedN };
}
const sites = [{ codeline: 'lib', file: 'src/a.ts', reason: 'r', changeRequired: true }];
const specified = { id: 'S-1', codeline: 'lib', codelines: ['lib', 'site'], title: 't', description: 'd', fixSiteAnalysis: sites, fixSiteAnalysisPerCodeline: { lib: sites, site: [] } };

describe('(a) a story with spec output and no plan gets its plan — and nothing else changes', () => {
  it('the detective writes it; the plan is stored; the story\'s fix sites are untouched', () => {
    const { r, after, askedN } = project([specified]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(askedN, 'the detective was never asked').toBeGreaterThan(0);
    const s = after.stories[0];
    expect(s.overallPlan, 'no plan was stored').toBeTruthy();
    expect(s.overallPlan.packages[0].releaseLines.length).toBeGreaterThan(1);
    expect(s.fixSiteAnalysis).toEqual(sites);
    expect(s.fixSiteAnalysisPerCodeline).toEqual({ lib: sites, site: [] });
  }, 180000);

  it('a story never specified is left to the spec pass — no detective is asked', () => {
    const { r, after, askedN } = project([{ id: 'S-2', codeline: 'lib', codelines: ['lib', 'site'], title: 't' }]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(askedN).toBe(0);
    expect(after.stories[0].overallPlan).toBeUndefined();
  }, 180000);

  it('a story that has its plan keeps it — no detective is asked', () => {
    const plan = { codelines: [{ codeline: 'lib', part: 'p', order: 1 }], packages: [] };
    const { r, after, askedN } = project([{ ...specified, overallPlan: plan }]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(askedN).toBe(0);
    expect(after.stories[0].overallPlan).toEqual(plan);
  }, 180000);

  it('a detective that cannot answer leaves no plan, says so, and does not stop the run', () => {
    const { r, after } = project([specified], '#!/bin/bash\ncat > /dev/null\nexit 1\n');
    expect(r.status).toBe(0);
    expect(after.stories[0].overallPlan).toBeUndefined();
    expect(r.stdout + r.stderr).toMatch(/no plan/i);
  }, 180000);
});

describe('(b) a resumed lane\'s release lines come from the canonical plan when its own PRD has none', () => {
  const plan = { codelines: [{ codeline: 'lib', part: 'p', order: 1 }], packages: [{ package: '@s/l', providedBy: 'lib', consumers: [], releaseLines: [
    { line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: true }, { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false }] }] };
  const lane = { implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', codeline: 'lib', status: 'completed', completed: true }] };
  const canonical = { stories: [{ id: 'S-1', overallPlan: plan }] };
  it('the lines, and the line\'s PRD carries the plan with the story pending', () => {
    const d = tmp();
    const lp = join(d, 'lane.json'); writeFileSync(lp, JSON.stringify(lane));
    const cp = join(d, 'canonical.json'); writeFileSync(cp, JSON.stringify(canonical));
    const lines = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/release-lines.js'), lp, 'lib', cp], { encoding: 'utf8' });
    expect(lines.stdout.trim()).toBe('1.x\tv1.9.0');
    const out = join(d, 'line.json');
    const made = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/release-line-prd.js'), lp, out, 'lib', '1.x', cp], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const s = JSON.parse(readFileSync(out, 'utf8')).stories[0];
    expect(s.status).toBe('pending');
    expect(s.overallPlan).toEqual(plan);
  });
  it('without a canonical plan either, there are no lines', () => {
    const d = tmp();
    const lp = join(d, 'lane.json'); writeFileSync(lp, JSON.stringify(lane));
    const cp = join(d, 'canonical.json'); writeFileSync(cp, JSON.stringify({ stories: [{ id: 'S-1' }] }));
    expect(spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/release-lines.js'), lp, 'lib', cp], { encoding: 'utf8' }).stdout).toBe('');
  });
});
