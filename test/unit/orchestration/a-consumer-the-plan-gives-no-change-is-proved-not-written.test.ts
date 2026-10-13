/**
 * A CODELINE THE STORY'S PLAN GIVES NO CHANGE IS PROVED AGAINST THE RELEASE IT WILL RECEIVE — NOT FORCED TO WRITE ONE.
 *
 * The £0 rehearsal of AMSD-2974 (2026-10-06): the plan gives the two sites locked to ^7 no code change — they receive
 * the fix through the library's 7.x back-port — and their lanes were blocked by the reproduction gate ("no test file
 * accompanies the change") for changing nothing; and they were built against the library's 8.x checkout, not the 7.x
 * line they receive. Operator: "Pipeline needs to handle this scenario" (declaring them passed would skip the proof).
 *
 * EXECUTED: the real handlers; the real reproduction gate on a real repository with nothing changed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const H = (n: string) => join(SCRIPTS, 'lib/handlers', n);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'no-change-')); dirs.push(d); return d; };
const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });

const planWith = (change: string, onBase = false) => ({
  codelines: [{ codeline: 'lib', part: 'p', order: 1 }, { codeline: 'site', part: 'none', order: 2 }],
  packages: [{ package: '@s/lib', providedBy: 'lib',
    releaseLines: [{ line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: true }, { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: onBase }],
    consumers: [{ codeline: 'site', declaredRange: '^1.5.0', receivesVia: '1.9.1', usage: [], change }] }],
});
const prdFile = (stories: object[], extra: object = {}) => { const d = tmp(); const f = join(d, 'prd.json'); writeFileSync(f, JSON.stringify({ stories, ...extra })); return f; };

describe('the plan says whether a codeline has a change of its own', () => {
  it('exactly none → no change', () => expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1', overallPlan: planWith('none') }]), 'S-1', 'site']).status).toBe(0));
  // AMSD-2974 run 9 resume 14 (2026-10-13): the planner wrote consumers[].change "exactly none" — the wording our own
  // template asks for ("<exactly none, or the change this consumer makes…>") — the handler read it as a change, and
  // all three site lanes ran a writer that correctly changed nothing and was rejected 7+ times for "deliverables
  // incomplete". The value is taken from the template itself, so the test follows the template, not a literal.
  const TEMPLATE_NONE = (() => {
    const t = readFileSync(join(ROOT, 'orchestrations/prompts/templates/detective-overall-plan.json'), 'utf8');
    const m = t.match(/\\"change\\":\\"<([^,<>]*none)\b/);
    if (!m) throw new Error('the planner template no longer states its no-change wording — the harness is stale');
    return m[1];
  })();
  it('the template\'s own no-change wording (as the planner writes it) → no change', () => {
    expect(TEMPLATE_NONE).toBe('exactly none');
    expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1', overallPlan: planWith(TEMPLATE_NONE) }]), 'S-1', 'site']).status).toBe(0);
  });
  it('the template\'s wording plus something to do → has one', () => expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1', overallPlan: planWith(`${TEMPLATE_NONE}; bump the range`) }]), 'S-1', 'site']).status).toBe(1));
  it('a change → has one', () => expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1', overallPlan: planWith('rename the toast prop') }]), 'S-1', 'site']).status).toBe(1));
  it('none plus something to do → has one', () => expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1', overallPlan: planWith('none; review own messages') }]), 'S-1', 'site']).status).toBe(1));
  it('no plan → not known, so not "no change"', () => expect(node([H('plan-gives-no-change.js'), prdFile([{ id: 'S-1' }]), 'S-1', 'site']).status).toBe(1));
});

describe('the reproduction gate passes a codeline the plan gives no change, that changed nothing — and only that', () => {
  function gate(plan: object | null, change = false) {
    const d = tmp();
    const repo = join(d, 'site'); mkdirSync(repo);
    const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'develop'); writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'AI-S-1');
    if (change) { writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix'); }
    const prd = prdFile([{ id: 'S-1', ...(plan ? { overallPlan: plan } : {}) }]);
    return spawnSync('bash', [join(SCRIPTS, 'brownfield-repro-test-gate.sh'), 'S-1'], { encoding: 'utf8',
      env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop', PRD_FILE: prd, EPAM_CODELINE: 'site', NODE_BIN: process.execPath } });
  }
  it('plan says none, nothing changed → passes, and says why', () => {
    const r = gate(planWith('none'));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/plan gives site no change/);
  });
  it('plan gives it a change, nothing changed → still blocked', () => {
    const r = gate(planWith('rename the toast prop'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no test file accompanies the change/);
  });
  it('no plan, nothing changed → still blocked', () => {
    expect(gate(null).status).not.toBe(0);
  });
  it('plan says none, but code changed → judged as any change: blocked without a test', () => {
    const r = gate(planWith('none'), true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no test file accompanies the change/);
  });
});

describe('a lane\'s work copy carries the plan; the consumer is built from the line it receives', () => {
  it('carry-plan copies the canonical plan onto the lane copy\'s story that lacks one', () => {
    const lane = prdFile([{ id: 'S-1' }]);
    const canonical = prdFile([{ id: 'S-1', overallPlan: planWith('none') }]);
    expect(node([H('carry-plan.js'), lane, canonical]).status).toBe(0);
    expect(JSON.parse(readFileSync(lane, 'utf8')).stories[0].overallPlan).toEqual(planWith('none'));
  });

  function providers(onBase: boolean) {
    const d = tmp();
    for (const cl of ['lib', 'site']) mkdirSync(join(d, cl));
    writeFileSync(join(d, 'lib/package.json'), JSON.stringify({ name: '@s/lib', version: '2.4.0' }));
    writeFileSync(join(d, 'site/package.json'), JSON.stringify({ name: 'site', dependencies: { '@s/lib': '^1.5.0' } }));
    const prd = prdFile([{ id: 'S-1', overallPlan: planWith('none', onBase) }], { project: { outputDirs: [{ codeline: 'lib', path: join(d, 'lib') }, { codeline: 'site', path: join(d, 'site') }] } });
    return node([H('sibling-providers.js'), prd, join(d, 'site')]).stdout.trim().split('\t');
  }
  it('a consumer receiving a line off the provider\'s base is told that line and the story', () => {
    const [name, , suffix, story] = providers(false);
    expect(name).toBe('@s/lib');
    expect(suffix).toBe('-1.x');
    expect(story).toBe('S-1');
  });
  it('a consumer on the provider\'s own line is built from the provider as it stands', () => {
    const [, , suffix] = providers(true);
    expect(suffix || '').toBe('');
  });
});
