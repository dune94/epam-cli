/**
 * STEP 3.58 COMPARES THE FAILING-TEST SET AFTER A PHASE AGAINST THE TOLERATED BASELINE. IT
 * REPORTED "PASS" WHEN IT HAD READ NOTHING.
 *
 * `stable_after` is the INTERSECTION of every attempt's failure set — deliberately, so a one-off
 * flake present in one attempt but not all does not block a clean phase. But an unreadable attempt
 * log appended an EMPTY set, and intersecting with the empty set empties everything. So a single
 * missing log produced no new failures and a "pass"; if the suite never ran at all — the command
 * could not start, the write failed — every set was empty and the gate reported "no new test
 * failures beyond the tolerated baseline" having read no output whatsoever.
 *
 * A missing tolerated baseline had the opposite silent failure: it became the empty set, so every
 * PRE-EXISTING failure counted as newly introduced and the phase was blamed for breakage it
 * inherited — the inverse of the operator policy ("we inherit existing test failures, but we
 * cannot be expected to fix them").
 *
 * Both are now "unknown", which the caller already treats as blocking and now explains.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const RGD = join(SCRIPTS, 'lib/handlers/rgd-diff.py');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');

const PATTERN = 'FAIL ([a-z.]+\\.spec\\.ts > [a-z]+)';

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rgd-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

type Verdict = { verdict: string; new_failures: string[]; reason?: string };

/** Run the differ exactly as the step does: log_base plus -attempt-N siblings. */
function run(opts: { attempts: (string | null)[]; baseline: string[] | null }): Verdict {
  const base = join(work, 'r.log');
  opts.attempts.forEach((text, i) => {
    if (text === null) return;                       // deliberately absent
    writeFileSync(i === 0 ? base : join(work, `r-attempt-${i + 1}.log`), text);
  });
  const baselineFile = join(work, 'base.json');
  if (opts.baseline) writeFileSync(baselineFile, JSON.stringify({ failures: opts.baseline }));

  const r = spawnSync('python3', [RGD, PATTERN, String(opts.attempts.length), base, baselineFile], { encoding: 'utf8' });
  expect(r.status, `the differ crashed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

const FAIL_A = 'FAIL a.spec.ts > adds\n';
const FAIL_AB = 'FAIL a.spec.ts > adds\nFAIL b.spec.ts > subs\n';

describe('the regression delta gate cannot pass on no data', () => {
  it('passes when every attempt ran and nothing new broke', () => {
    // Guard against the fix being too strict: a healthy phase must still pass.
    const v = run({ attempts: [FAIL_A, FAIL_A], baseline: ['a.spec.ts > adds'] });
    expect(v.verdict, 'a clean phase was blocked').toBe('pass');
  });

  it('fails on a test that was passing at baseline', () => {
    const v = run({ attempts: [FAIL_AB, FAIL_AB], baseline: ['a.spec.ts > adds'] });
    expect(v.verdict).toBe('fail');
    expect(v.new_failures).toEqual(['b.spec.ts > subs']);
  });

  it('still tolerates a one-off flake — the intersection is the point', () => {
    // b fails in only ONE attempt. That is the noise the retry exists to filter, and it must not
    // become a "new failure" now that missing logs are handled differently.
    const v = run({ attempts: [FAIL_AB, FAIL_A], baseline: ['a.spec.ts > adds'] });
    expect(v.verdict, 'a single-attempt flake now blocks a clean phase').toBe('pass');
  });

  it('ONE missing attempt log is not a pass', () => {
    const v = run({ attempts: [FAIL_AB, null], baseline: ['a.spec.ts > adds'] });
    expect(v.verdict, 'a missing attempt log still empties the intersection and passes').toBe('unknown');
    expect(v.reason, 'the operator is not told the suite produced no output').toMatch(/no output/i);
  });

  it('a suite that never ran at all is not a pass', () => {
    const v = run({ attempts: ['', ''], baseline: ['a.spec.ts > adds'] });
    expect(v.verdict, 'the gate reported a pass having read nothing').toBe('unknown');
  });

  it('a missing tolerated baseline does not blame the phase for inherited failures', () => {
    const v = run({ attempts: [FAIL_A, FAIL_A], baseline: null });
    expect(v.verdict, 'a pre-existing failure was reported as newly introduced').not.toBe('fail');
    expect(v.verdict).toBe('unknown');
    expect(v.reason).toMatch(/baseline/i);
  });

  it('the step reports WHICH cannot-verify it hit', () => {
    // Three now — an uncompilable pattern, a suite that produced no output, a missing baseline —
    // fixed in three different places. Naming only the pattern sent every investigation at
    // dependency-check.json.
    const body = readFileSync(ORCH, 'utf8');
    const i = body.indexOf('CANNOT VERIFY');
    expect(i, 'the cannot-verify branch is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 700, i + 300);
    expect(block, 'the differ’s own reason is still discarded').toMatch(/_rgd_reason/);
  });

  it('an unverifiable result still blocks the phase', () => {
    // The whole value of "unknown": it must not be treated as a pass by the caller either.
    const body = readFileSync(ORCH, 'utf8');
    const i = body.indexOf('CANNOT VERIFY');
    expect(body.slice(i, i + 900), 'a cannot-verify result no longer stops the phase').toMatch(/exit 1/);
  });
});
