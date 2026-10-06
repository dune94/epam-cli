/**
 * THE MOCK DETECTIVE WRITES THE STORY'S PLAN FROM ITS OWN REQUEST, AS THE REAL ONE DID (2026-10-06).
 *
 * Without it no £0 rehearsal can reach a release-line pass: nothing would ever mark a line off the codeline's base.
 * EXECUTED: the engine's real detective prescription for a story spanning a provider (a real git repo with release
 * tags) and two consumers, one locked to an older major; the mock's answer parsed by the engine's real parser.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixPlan } from './seams/fixplan';

const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
process.env.SPEC_MODE_NO_MAIN = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(SCRIPTS, 'spec-mode-runner.js'));
const work = mkdtempSync(join(tmpdir(), 'mock-plan-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function codeline(name: string, manifest: object, tags: string[] = []) {
  const d = join(work, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify(manifest));
  spawnSync('git', ['-C', d, 'init', '-q', '-b', 'master']);
  for (const t of tags) {
    writeFileSync(join(d, 'v.txt'), t);
    spawnSync('git', ['-C', d, 'add', '-A']);
    spawnSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', t]);
    spawnSync('git', ['-C', d, 'tag', t]);
  }
  return d;
}
const lib = codeline('lib', { name: '@scope/lib', version: '2.4.0' }, ['v1.8.0', 'v1.9.0', 'v2.3.0', 'v2.4.0']);
const now = codeline('now', { name: 'now', dependencies: { '@scope/lib': '^2.0.0' } });
const old = codeline('old', { name: 'old', dependencies: { '@scope/lib': '^1.5.0' } });
const prd = { project: { outputDir: lib, outputDirs: [{ codeline: 'lib', path: lib }, { codeline: 'now', path: now }, { codeline: 'old', path: old }] }, stories: [] };
const story = { id: 'S-1', codeline: 'lib', codelines: ['lib', 'now', 'old'] };

describe('the mock detective writes the plan the engine reads', () => {
  it('the provider\'s own line, a line for the consumer locked to an older major, every consumer in its range', () => {
    const prompt = runner.detectivePrescription('novel', story, prd);
    const plan = runner.parseOverallPlan(fixPlan(prompt));
    expect(plan, 'the mock wrote no plan the engine can read').toBeTruthy();
    expect(plan.codelines.map((c: { codeline: string }) => c.codeline)).toEqual(['lib', 'now', 'old']);
    const lines = plan.packages[0].releaseLines;
    expect(lines).toEqual([
      { line: '2.x', base: 'v2.4.0', version: '2.4.1', onCodelineBase: true },
      { line: '1.x', base: 'v1.9.0', version: '1.9.1', onCodelineBase: false },
    ]);
    expect(plan.packages[0].consumers.map((c: { codeline: string; receivesVia: string }) => `${c.codeline}:${c.receivesVia}`)).toEqual(['now:2.4.1', 'old:1.9.1']);
  });

  it('a lane given the plan is not asked for one, and the mock writes none', () => {
    const p = runner.parseOverallPlan(fixPlan(runner.detectivePrescription('novel', story, prd)));
    const given = runner.detectivePrescription('novel', { ...story, codeline: 'old', overallPlan: p }, prd);
    expect(runner.parseOverallPlan(fixPlan(given))).toBeNull();
  });
});
