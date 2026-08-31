/**
 * THE MEASUREMENT IS STORED, AND A STORED MEASUREMENT THAT OUTLIVED ITS CODE IS NOT USED.
 *
 * Computing a stage's coverage means parsing lcov and reading every in-scope file to count its
 * executable lines. The writer stage is entered once per seam, in a fresh process each time, so
 * recomputing would put a whole-tree sweep in front of every model call — for an answer that cannot
 * have changed, because no test ran in between.
 *
 * So it is computed once and persisted. Which creates the only failure that matters here: a number
 * that no longer describes the tree. A stale percentage reports cover that does not exist, which is
 * exactly the silence this gate was built to end.
 *
 * The properties, each executed rather than read:
 *
 *   persisting produces a report      — with a number for every declared stage
 *   the report is what gets read      — a doctored report changes the answer, proving the fast path
 *   a moved tree invalidates it       — edit a file, the persisted answer is refused
 *   changed lcov invalidates it       — the coverage data is part of what the answer depends on
 *   a cold cache is still CORRECT     — missing report costs time, never accuracy
 *   an empty stage is named           — a pattern matching nothing must not score 0% and halt forever
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HANDLER = join(__dirname, '../../orchestrations/scripts/lib/handlers/stage-coverage.js');
const NODE = process.execPath;

/** A small but REAL tree: files on disk, lcov describing them, a stage map over them. */
function workspace(opts: { hit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persist-'));
  mkdirSync(join(dir, 'orchestrations/scripts/lib'), { recursive: true });
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  const files = ['alpha.js', 'beta.js'];
  for (const f of files) {
    writeFileSync(join(dir, 'orchestrations/scripts/lib', f),
      Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join('\n'));
  }
  writeFileSync(join(dir, 'stage-coverage.json'), JSON.stringify({
    roots: ['orchestrations/scripts'], extensions: ['.js'], excludePattern: 'node_modules',
    stages: {
      'step-1-spec': ['orchestrations/scripts/lib/alpha\\.js$'],
      'step-2-writer': ['orchestrations/scripts/lib/beta\\.js$'],
    },
  }));
  const hit = opts.hit ?? 90;
  const lcov = files.flatMap((f) => [
    `SF:orchestrations/scripts/lib/${f}`,
    ...Array.from({ length: 100 }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`),
    'LF:100', `LH:${hit}`, 'end_of_record',
  ]).join('\n');
  writeFileSync(join(dir, 'coverage/lcov.info'), lcov);
  return dir;
}

const REPORT = (dir: string) => join(dir, 'coverage/stage-coverage.json');

function run(dir: string, ...args: string[]) {
  return spawnSync(NODE, [HANDLER, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env,
      STAGE_COVERAGE_ROOT: dir,
      STAGE_COVERAGE_CONFIG: join(dir, 'stage-coverage.json'),
      STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'),
      STAGE_COVERAGE_REPORT: REPORT(dir),
    },
  });
}

describe('stage coverage is persisted, not recomputed', () => {
  it('persisting writes a report carrying every declared stage', () => {
    const dir = workspace();
    const r = run(dir, '--persist');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(REPORT(dir)), 'nothing was persisted').toBe(true);
    const report = JSON.parse(readFileSync(REPORT(dir), 'utf8'));
    expect(Object.keys(report.stages).sort()).toEqual(['step-1-spec', 'step-2-writer']);
    expect(report.stages['step-1-spec'].pct).toBeCloseTo(90, 1);
    expect(typeof report.fingerprint, 'the report carries no fingerprint, so it can never go stale')
      .toBe('string');
  }, 120_000);

  it('and the gate READS that report rather than measuring again', () => {
    // Doctor the stored number to something the tree cannot produce. If the answer changes, the
    // stored value is what was consulted — which is the whole point. If it does not, the fast path
    // is dead code and every seam is paying for a full sweep.
    const dir = workspace();
    expect(run(dir, '--persist').status).toBe(0);
    const report = JSON.parse(readFileSync(REPORT(dir), 'utf8'));
    report.stages['step-1-spec'].pct = 42.5;
    writeFileSync(REPORT(dir), JSON.stringify(report));
    const r = run(dir, 'step-1-spec');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'the persisted measurement was ignored — it recomputed').toBe('42.5');
  }, 120_000);

  it('a tree that has MOVED invalidates it — a stale number is never served', () => {
    const dir = workspace();
    expect(run(dir, '--persist').status).toBe(0);
    const report = JSON.parse(readFileSync(REPORT(dir), 'utf8'));
    report.stages['step-1-spec'].pct = 42.5; // the marker that proves which path answered
    writeFileSync(REPORT(dir), JSON.stringify(report));

    // The code the measurement described is not the code on disk any more.
    writeFileSync(join(dir, 'orchestrations/scripts/lib/alpha.js'),
      Array.from({ length: 120 }, (_, i) => `const y${i} = ${i};`).join('\n'));

    const r = run(dir, 'step-1-spec');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim(), 'a percentage measured against code that no longer exists was served')
      .not.toBe('42.5');
  }, 120_000);

  it('and so does changed coverage data — the suite is part of what the answer depends on', () => {
    const dir = workspace();
    expect(run(dir, '--persist').status).toBe(0);
    const report = JSON.parse(readFileSync(REPORT(dir), 'utf8'));
    report.stages['step-1-spec'].pct = 42.5;
    writeFileSync(REPORT(dir), JSON.stringify(report));

    // A fresh suite run with a different result. Same files, different measurement.
    const lcov = readFileSync(join(dir, 'coverage/lcov.info'), 'utf8').replace(/LH:90/g, 'LH:50');
    writeFileSync(join(dir, 'coverage/lcov.info'), lcov);
    const t = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'coverage/lcov.info'), t, t);

    const r = run(dir, 'step-1-spec');
    expect(r.stdout.trim(), 'the report survived a re-measurement of the suite').not.toBe('42.5');
  }, 120_000);

  it('a cold cache is slower, never wrong — and it warms itself for the stages after', () => {
    const dir = workspace({ hit: 73 });
    expect(existsSync(REPORT(dir)), 'the fixture started warm; this proves nothing').toBe(false);
    const r = run(dir, 'step-2-writer');
    expect(r.status, r.stderr).toBe(0);
    expect(Number(r.stdout.trim()), 'the cold answer is wrong').toBeCloseTo(73, 1);
    expect(existsSync(REPORT(dir)), 'a cold query left the next stage to sweep the tree again')
      .toBe(true);
    const report = JSON.parse(readFileSync(REPORT(dir), 'utf8'));
    expect(Object.keys(report.stages).length, 'it persisted only the stage it was asked about')
      .toBe(2);
  }, 120_000);

  it('every stage comes back from ONE process, because startup is now the whole bill', () => {
    const dir = workspace();
    const r = run(dir, '--all');
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
    expect(lines.sort()).toEqual(['step-1-spec', 'step-2-writer']);
  }, 120_000);

  it('a stage whose patterns match nothing is NAMED, not scored 0%', () => {
    // Scoring it 0 would halt the pipeline forever over code that does not exist — a gate nobody can
    // satisfy. It is almost always a pattern that stopped matching after a rename.
    const dir = workspace();
    const cfg = JSON.parse(readFileSync(join(dir, 'stage-coverage.json'), 'utf8'));
    cfg.stages.ghost = ['orchestrations/scripts/lib/no-such-file\\.js$'];
    writeFileSync(join(dir, 'stage-coverage.json'), JSON.stringify(cfg));
    const r = run(dir, 'ghost');
    expect(r.status, 'an empty stage was scored rather than reported').not.toBe(0);
    expect(r.stderr, 'the refusal does not name the stage or say why').toMatch(/ghost.*matches no file/s);
    expect(r.stdout.trim(), 'it printed a percentage for a stage with no code').toBe('');
  }, 120_000);

  it('two trees measuring the same stage NAME do not read each other\'s numbers', () => {
    // The defect this replaces: a second cache keyed on the stage name alone, under a shared temp
    // directory. Two runs both asking about "step-1-spec" got whichever answer was written last —
    // and nothing tied the stored value to the tree it measured, so it could outlive the code it
    // described. Stage names are not unique across projects; a measurement is not a name.
    const a = workspace({ hit: 96 });
    const b = workspace({ hit: 40 });
    const ra = run(a, 'step-1-spec');
    const rb = run(b, 'step-1-spec');
    expect(ra.status, ra.stderr).toBe(0);
    expect(rb.status, rb.stderr).toBe(0);
    expect(Number(ra.stdout.trim()), 'the first tree\'s answer is wrong').toBeCloseTo(96, 1);
    expect(Number(rb.stdout.trim()), 'the second tree was served the first tree\'s measurement')
      .toBeCloseTo(40, 1);
    // And asking the first again, after the second has been measured, still gives the first's.
    expect(Number(run(a, 'step-1-spec').stdout.trim()),
      'the first tree\'s answer was overwritten by the second\'s').toBeCloseTo(96, 1);
  }, 120_000);

  it('no coverage data at all is still a refusal, warm report or not', () => {
    const dir = workspace();
    expect(run(dir, '--persist').status).toBe(0);
    writeFileSync(join(dir, 'coverage/lcov.info'), '');
    const r = run(dir, 'step-1-spec');
    // Emptied lcov: either refused outright, or measured as uncovered. Never the old 90.
    if (r.status === 0) expect(Number(r.stdout.trim())).toBeLessThan(90);
    else expect(r.stderr).toMatch(/not the same as everything being covered|nothing was measured/);
  }, 120_000);
});
