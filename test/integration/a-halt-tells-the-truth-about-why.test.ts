/**
 * THE HALT MESSAGE IS A DIAGNOSIS, AND A CONFIDENT WRONG ONE COSTS MORE THAN NO ANSWER.
 *
 * When a story halts, _halt_recovery_state tells the operator whether the ladder was exhausted or
 * whether a gate verdict stopped it. That decides where they look next. It lived inside
 * run-agent-orchestration.sh, which cannot be sourced without running the pipeline, so the
 * sentence an operator acts on had never been executed by a test.
 *
 * On a live run the writer burned 12 attempts and this printed:
 *
 *     recovery was NOT exhausted for 'X': 0 of 12 attempt(s) used, ladder still below its top rung.
 *     The story failed on a gate verdict, not on running out of attempts.
 *
 * Both halves were wrong, and they sent the reader hunting a gate verdict that was not the cause.
 * The count comes from <LOG_DIR>/story-retry-state/<story>.count, so an empty or wrong LOG_DIR
 * reads 0 — and 0 was then reported as a fact rather than as "I could not tell".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/halt-recovery.sh');
const RETRY_LIB = join(SCRIPTS, 'lib/story-retry-state.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Run the real function with the real retry-state library, against a log dir that records
 * `used` attempts for the story — or against no log dir at all.
 */
function halt({ used, exhausted, withLogDir = true }:
  { used: number | null; exhausted: boolean; withLogDir?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'halt-')); dirs.push(dir);
  if (used !== null) {
    mkdirSync(join(dir, 'story-retry-state'), { recursive: true });
    writeFileSync(join(dir, 'story-retry-state', 'S-1.count'), String(used));
  }
  const script = [
    'set -uo pipefail',
    `. ${JSON.stringify(RETRY_LIB)}`,
    `. ${JSON.stringify(LIB)}`,
    'error() { echo "$*"; }',
    `story_ladder_exhausted() { return ${exhausted ? 0 : 1}; }`,
    'MAX_RETRIES=11',
    withLogDir ? `LOG_DIR=${JSON.stringify(dir)}` : 'LOG_DIR=""',
    '_halt_recovery_state "S-1"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

describe('a halt tells the truth about why', () => {
  it('says EXHAUSTED, with the real count, when the ladder ran out', () => {
    const out = halt({ used: 12, exhausted: true });
    expect(out).toMatch(/exhausted/i);
    expect(out, 'the operator is told a count that is not the one recorded').toContain('12');
  });

  it('says NOT exhausted, with the real count, when a verdict stopped it early', () => {
    const out = halt({ used: 2, exhausted: false });
    expect(out).toMatch(/NOT exhausted/);
    expect(out).toContain('2');
  });

  it('does not report 0 attempts as fact when it cannot read the count', () => {
    // THE LIVE FAILURE. No readable state, so the count defaults to 0 — and "0 of 12 attempt(s)
    // used, the story failed on a gate verdict" was printed as a finding. An unknown must read as
    // an unknown, exactly as an unreadable gate log is a warn and never a pass.
    const out = halt({ used: null, exhausted: false, withLogDir: false });
    expect(out, 'a count it could not read was asserted as 0').not.toMatch(/\b0 of \d+ attempt/);
  });

  it('says so plainly when the retry state is unreadable', () => {
    const out = halt({ used: null, exhausted: false, withLogDir: false });
    expect(out, 'the operator is given no hint that the number is unknown')
      .toMatch(/could not|unknown|no retry state|unreadable/i);
  });
});
