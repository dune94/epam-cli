/**
 * A STAGE THAT IS NOT TESTED DOES NOT RUN.
 *
 * The pipeline's stages execute code. Some of that code has never been executed by a test — twenty
 * of forty-one handlers had never been run at all, and the defect that killed the 2026-08-31
 * metrolinx run sat in a branch no test had ever reached since v1.5.
 *
 * Knowing that after the fact is worth little. The gate has to be in front of the stage: before
 * Step N runs, ask what proportion of the code Step N executes is covered, and if it is below the
 * configured threshold with the blocker on, HALT — do not spend, do not write to a codeline.
 *
 * Three properties make it a gate rather than a report:
 *
 *   - it is generic. One handler, one shell function, called with a STAGE NAME. A per-stage
 *     implementation would drift, and the stage that drifts is the one nobody is watching.
 *   - the threshold and the blocker come from CONFIG, not from the engine. Turning the blocker off
 *     is an operator's decision, made in one place, visible.
 *   - ABSENT COVERAGE IS NOT FULL COVERAGE. No data means nothing was measured, which is the
 *     state a pipeline is in when the suite never ran — the exact case this exists to stop.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const HANDLER = join(REPO, 'orchestrations/scripts/lib/handlers/stage-coverage.js');
const GATE = join(REPO, 'orchestrations/scripts/lib/stage-coverage-gate.sh');

/** A workspace with a declared stage map and an lcov file we control. */
function workspace(opts: {
  lcov?: string; threshold?: number; blocker?: boolean; stages?: Record<string, string[]>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stagecov-'));
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  // REAL FILES, because the handler counts what is on disk. A fixture of names alone measures
  // nothing while looking like it measured — which is how this test read 0% against a handler that
  // was answering correctly.
  mkdirSync(join(dir, 'orchestrations/scripts/lib'), { recursive: true });
  writeFileSync(join(dir, 'orchestrations/scripts/lib/alpha.js'),
    Array.from({ length: 100 }, (_, i) => `const a${i} = ${i};`).join('\n'));
  writeFileSync(join(dir, 'orchestrations/scripts/lib/unrelated.js'),
    Array.from({ length: 100 }, (_, i) => `const u${i} = ${i};`).join('\n'));
  if (opts.lcov !== undefined) writeFileSync(join(dir, 'coverage/lcov.info'), opts.lcov);
  // THE STAGE MAP IS THE ENGINE'S: which files a stage runs.
  writeFileSync(join(dir, 'stage-coverage.json'), JSON.stringify({
    roots: ['orchestrations/scripts'],
    extensions: ['.js'],
    excludePattern: 'node_modules',
    stages: opts.stages ?? { 'step-1-spec': ['orchestrations/scripts/lib/alpha\\.js$'] },
  }, null, 2));
  // THE POLICY IS THE PROJECT'S: how much cover it demands before it spends. Kept apart because
  // what metrolinx requires is not a decision about mock3, and neither is the engine's to make.
  writeFileSync(join(dir, 'coverage-policy.json'), JSON.stringify({
    thresholdPercent: opts.threshold ?? 95,
    blocker: opts.blocker ?? true,
  }, null, 2));
  return dir;
}

/** An lcov record: `hit` of `found` lines covered in that file. */
const record = (file: string, found: number, hit: number) => [
  `SF:${file}`,
  ...Array.from({ length: found }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`),
  `LF:${found}`, `LH:${hit}`, 'end_of_record', '',
].join('\n');

function askHandler(dir: string, stage: string) {
  const r = spawnSync(process.execPath, [HANDLER, stage], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: { ...process.env, STAGE_COVERAGE_CONFIG: join(dir, 'stage-coverage.json'),
      STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'), STAGE_COVERAGE_ROOT: dir },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function runGate(dir: string, stage: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(GATE)}\nrequire_stage_coverage ${JSON.stringify(stage)}`], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: { ...process.env, STAGE_COVERAGE_CONFIG: join(dir, 'stage-coverage.json'),
      STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'), STAGE_COVERAGE_ROOT: dir,
      STAGE_COVERAGE_POLICY: join(dir, 'coverage-policy.json'), ...extra },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

describe('a stage does not run untested code', () => {
  it('the handler reports the percentage for the stage it is asked about', () => {
    const dir = workspace({ lcov: record('orchestrations/scripts/lib/alpha.js', 100, 96) });
    const r = askHandler(dir, 'step-1-spec');
    expect(r.code, r.err).toBe(0);
    expect(Number(r.out), 'the reported percentage is not the stage\'s').toBeCloseTo(96, 0);
  }, 60_000);

  it('and reports only the files that stage executes, not the whole repo', () => {
    // A stage-keyed gate that answers with a repo-wide average tells every stage the same thing.
    const dir = workspace({
      stages: { 'step-1-spec': ['orchestrations/scripts/lib/alpha\\.js$'] },
      lcov: record('orchestrations/scripts/lib/alpha.js', 100, 40)
          + record('orchestrations/scripts/lib/unrelated.js', 100, 100),
    });
    expect(Number(askHandler(dir, 'step-1-spec').out),
      'an unrelated file lifted the stage\'s number').toBeCloseTo(40, 0);
  }, 60_000);

  it('ABSENT coverage data is not full coverage', () => {
    // The state a pipeline is in when the suite never ran.
    const dir = workspace({});   // no lcov written at all
    const r = askHandler(dir, 'step-1-spec');
    expect(r.out, 'missing coverage data reported as a percentage').not.toMatch(/^100/);
    expect(`${r.out}${r.err}`, 'it did not say the data was missing')
      .toMatch(/no coverage data|not measured|missing/i);
  }, 60_000);

  it('an unknown stage refuses rather than answering 100', () => {
    const dir = workspace({ lcov: record('orchestrations/scripts/lib/alpha.js', 10, 10) });
    const r = askHandler(dir, 'a-stage-nobody-declared');
    expect(r.code, 'an undeclared stage was waved through').not.toBe(0);
    expect(r.err).toMatch(/not declared|unknown stage/i);
  }, 60_000);

  it('the gate HALTS a stage below the threshold when the blocker is on', () => {
    const dir = workspace({ threshold: 95, blocker: true,
      lcov: record('orchestrations/scripts/lib/alpha.js', 100, 40) });
    const r = runGate(dir, 'step-1-spec');
    expect(r.code, 'a stage at 40% ran with the blocker on').not.toBe(0);
    expect(`${r.out}${r.err}`, 'the halt does not say the stage or the number')
      .toMatch(/step-1-spec/);
    expect(`${r.out}${r.err}`).toMatch(/40|coverage/i);
  }, 60_000);

  it('and lets it run when it meets the threshold', () => {
    const dir = workspace({ threshold: 95, blocker: true,
      lcov: record('orchestrations/scripts/lib/alpha.js', 100, 96) });
    expect(runGate(dir, 'step-1-spec').code, 'a stage at 96% was blocked at a 95% threshold').toBe(0);
  }, 60_000);

  it('with the blocker OFF it warns and continues — the operator decided', () => {
    const dir = workspace({ threshold: 95, blocker: false,
      lcov: record('orchestrations/scripts/lib/alpha.js', 100, 10) });
    const r = runGate(dir, 'step-1-spec');
    expect(r.code, 'the blocker was off and it halted anyway').toBe(0);
    expect(`${r.out}${r.err}`, 'it continued silently — the operator cannot see what was waived')
      .toMatch(/coverage/i);
  }, 60_000);

  it('the threshold comes from config, not from the engine', () => {
    // Same coverage, different declared threshold: the answer must change.
    const lcov = record('orchestrations/scripts/lib/alpha.js', 100, 50);
    expect(runGate(workspace({ threshold: 95, blocker: true, lcov }), 'step-1-spec').code)
      .not.toBe(0);
    expect(runGate(workspace({ threshold: 40, blocker: true, lcov }), 'step-1-spec').code,
      'a 50% stage was blocked at a 40% threshold — the number is hardcoded somewhere').toBe(0);
  }, 60_000);

  it('EVERY file in the project belongs to a stage', () => {
    // ALL CODE IS IN PLAY. A stage map that covers the files I happened to think about is a
    // denominator I chose, and a denominator I chose is one I can flatter — which is how "95%
    // coverage" came to mean 95% of four files. A file assigned to no stage is measured by nothing
    // and gated by nothing.
    const r = spawnSync(process.execPath, [HANDLER, '--audit'], {
      encoding: 'utf8', timeout: 120000, cwd: REPO,
    });
    expect(r.status, `the audit failed: ${r.stderr.slice(0, 400)}`).toBe(0);
    const audit = JSON.parse(r.stdout);
    expect(audit.unassigned,
      `these files belong to no stage, so nothing measures or gates them:\n  `
      + `${(audit.unassigned || []).slice(0, 30).join('\n  ')}`).toEqual([]);
  }, 180_000);

  it('and the stage line totals equal the project line total', () => {
    // The arithmetic that makes the per-stage numbers trustworthy: if they do not add up, the
    // difference is code nobody is looking at.
    const r = spawnSync(process.execPath, [HANDLER, '--audit'], {
      encoding: 'utf8', timeout: 120000, cwd: REPO,
    });
    expect(r.status, r.stderr.slice(0, 300)).toBe(0);
    const audit = JSON.parse(r.stdout);
    expect(audit.stageLines,
      `the stages account for ${audit.stageLines} lines but the project has ${audit.projectLines}; `
      + `the difference is ${Math.abs(audit.projectLines - audit.stageLines)} lines nobody measures`)
      .toBe(audit.projectLines);
  }, 180_000);

  it('a project that declares NO policy is refused, not defaulted', () => {
    // The engine must not decide an operator's risk. No policy is a missing decision, not 95%.
    const dir = workspace({ lcov: record('orchestrations/scripts/lib/alpha.js', 10, 10) });
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(GATE)}\nrequire_stage_coverage 'step-1-spec'`], {
      encoding: 'utf8', timeout: 60000, cwd: REPO,
      env: { ...process.env, STAGE_COVERAGE_CONFIG: join(dir, 'stage-coverage.json'),
        STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'), STAGE_COVERAGE_ROOT: dir,
        STAGE_COVERAGE_POLICY: join(dir, 'no-such-policy.json'), EPAM_PROJECT_CONFIG_DIR: '' },
    });
    expect(r.status, 'a stage ran under a policy nobody declared').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/policy/i);
  }, 60_000);

  it('missing coverage data HALTS when the blocker is on', () => {
    // The most important case: no data is the state before anyone has run the suite, and it must
    // not be the state in which a stage is allowed to spend.
    const dir = workspace({ blocker: true });
    expect(runGate(dir, 'step-1-spec').code, 'a stage ran with no coverage data at all').not.toBe(0);
  }, 60_000);
});
