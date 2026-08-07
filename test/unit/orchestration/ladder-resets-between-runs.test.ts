/**
 * THE LADDER MUST CLIMB WITHIN A RUN AND START AT ZERO BETWEEN RUNS.
 *
 * lib/story-retry-state.sh puts each story's rung counter on disk because Step 3.6 re-invokes
 * claude.sh as a fresh subprocess per review cycle, and a `local` counter reset to 0 every
 * time — the ladder never climbed. That half is a standing requirement: "retries MUST proceed
 * up the rungs, nothing is allowed to intercede."
 *
 * The other half was asserted and never true. The module's own header claimed the state was
 * "wiped for free by the existing teardown/clean-slate reset at the start of every run. No
 * separate reset logic is needed or wanted here." pre-run-reset.sh's sweep matches *.log,
 * story-outputs-*.txt and eslint-baseline-*.json. It never matched *.count.
 *
 * Live 2026-08-07: AMSD-2041.count held 6 across every run of that night. A resumed writer
 * attempt therefore began at rung 3 of 4 — the reviewer requested changes ONCE, the ladder was
 * declared exhausted, Step 3.6 escalated with no re-implementation cycle, and the phase
 * halted. The review-loop fixes made minutes earlier were never exercised, because the budget
 * to exercise them had been spent by a previous run.
 *
 * Worse than the inconvenience: a story that exhausts its ladder is escalated after a single
 * rejection on EVERY future run, forever, until someone deletes the file by hand.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const STATE_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A LOG_DIR shaped like a real one, with ladder counters and a log to archive. */
function logDir(counters: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'ladderreset-')); dirs.push(d);
  mkdirSync(join(d, 'story-retry-state'), { recursive: true });
  for (const [story, n] of Object.entries(counters)) {
    writeFileSync(join(d, 'story-retry-state', `${story}.count`), n);
  }
  writeFileSync(join(d, 'something.log'), 'prior run output\n');
  return d;
}

describe('within a run, the rung persists across subprocesses', () => {
  it('a written count is read back — the requirement this file exists for', () => {
    const d = logDir({});
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(STATE_LIB)}; write_story_retry_count ${JSON.stringify(d)} ST-1 4; read_story_retry_count ${JSON.stringify(d)} ST-1`],
      { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('4');
  });

  it('an unknown story starts at 0, not at an error', () => {
    const d = logDir({});
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(STATE_LIB)}; read_story_retry_count ${JSON.stringify(d)} NEVER-SEEN`], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('0');
  });
});

describe('between runs, the rung resets to zero', () => {
  function runReset(d: string) {
    // pre-run-reset.sh requires --prd; without it the script exits before reaching any of
    // the clearing logic, and a test that omits it proves only that the arg check works.
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ project: { name: 'test', outputDir: d }, stories: [] }));
    // LOG_DIR comes from --log-dir, NOT the environment. Setting the env var alone pointed
    // the script at the REAL orchestrations/logs — a test that would have operated on live
    // state while proving nothing about the fixture.
    return spawnSync('bash', [RESET, '--prd', prd, '--log-dir', d], {
      encoding: 'utf8',
      env: { ...process.env, ORCH_RUN_ID: 'TESTRUN', EPAM_PREFLIGHT_ENVIRONMENT: '0' },
    });
  }

  it('the fixture is real — the counter exists before the reset', () => {
    const d = logDir({ 'AMSD-2041': '6' });
    expect(existsSync(join(d, 'story-retry-state/AMSD-2041.count'))).toBe(true);
    expect(readFileSync(join(d, 'story-retry-state/AMSD-2041.count'), 'utf8')).toBe('6');
  });

  it('THE DEFECT: a counter left by a previous run is cleared', () => {
    const d = logDir({ 'AMSD-2041': '6' });
    runReset(d);
    expect(
      existsSync(join(d, 'story-retry-state/AMSD-2041.count')),
      'a story that exhausted its ladder once would be escalated after one rejection forever',
    ).toBe(false);
  });

  it('every story is cleared, not just the first', () => {
    const d = logDir({ 'A-1': '6', 'B-2': '3', 'C-3': '7' });
    runReset(d);
    for (const s of ['A-1', 'B-2', 'C-3']) {
      expect(existsSync(join(d, `story-retry-state/${s}.count`)), `${s} survived the reset`).toBe(false);
    }
  });

  it('a fresh story therefore starts at rung 0 on the next run', () => {
    const d = logDir({ 'AMSD-2041': '6' });
    runReset(d);
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(STATE_LIB)}; read_story_retry_count ${JSON.stringify(d)} AMSD-2041`], { encoding: 'utf8' });
    expect(r.stdout.trim(), 'the next run inherits an exhausted ladder').toBe('0');
  });

  it('the reset survives a LOG_DIR with no counters at all', () => {
    const d = mkdtempSync(join(tmpdir(), 'ladderempty-')); dirs.push(d);
    writeFileSync(join(d, 'x.log'), 'x');
    expect(runReset(d).status, 'reset failed when there was nothing to clear').toBe(0);
  });

  it('the module no longer claims a reset it does not get', () => {
    const lib = readFileSync(STATE_LIB, 'utf8');
    // The correction QUOTES the old wording, so the phrase still appears. What must be gone
    // is the CLAIM built on it.
    expect(
      lib,
      'the header still asserts no reset logic is needed, which is what made this bug invisible',
    ).not.toMatch(/No separate reset logic is needed or wanted here\./);
    expect(lib).toMatch(/pre-run-reset\.sh now clears these counters explicitly/);
  });
});
