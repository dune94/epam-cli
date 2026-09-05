/**
 * A GATE THAT EXISTS TO PROTECT MONEY MUST STAND DOWN WHEN NOTHING CAN BE SPENT.
 *
 * `_coverage_gate_run_spends` (lib/stage-coverage-gate.sh) is the predicate the stage-coverage gate
 * asks before it enforces. It was added 2026-08-31 and no test has ever named it, which is exactly
 * what scan-uncalibrated-guards.js counts: a function that can STOP a run, that nothing under test/
 * has ever heard of. It pushed the uncalibrated count to 31 against a baseline of 30 seeded
 * 2026-08-20, so preflight-static.sh exits 1 — on v1.38 and v1.39 alike, blocking every paid launch
 * under the rule that pre-flight must pass first.
 *
 * The honest repair is the test, not a bumped number. Three of these guards were confirmed INERT in
 * production while the suite was green, which is why the ratchet exists at all.
 *
 * WHAT IT DECIDES, AND WHY BOTH DIRECTIONS ARE DANGEROUS:
 *
 *   returns 0 — the run can spend, so enforce coverage. Wrong here means a free rehearsal is
 *               refused for being under-covered. That is a DEADLOCK, not mere strictness: the
 *               launch stage sits at 2.3% because its code is inline, inline code only executes
 *               when the script RUNS, and a free rehearsal is the one mechanism that runs it
 *               without spending. Refusing it leaves no path to ever becoming covered.
 *
 *   returns 1 — the run spends nothing, so measure and report only. Wrong here means a PAID run
 *               skips the gate whose whole justification is that untested code is the most
 *               expensive thing this pipeline runs. The 2026-08-31 metrolinx run paid for Jira
 *               ingest, codeline discovery, an estate survey and an agent mint before dying on a
 *               branch no test had ever executed.
 *
 * So the negative assertions here are not padding — an over-permissive answer costs money and an
 * over-strict one makes the gate unsatisfiable, and this repository has been bitten by both.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const GATE = join(LIB, 'stage-coverage-gate.sh');
const FREE_GUARD = join(LIB, 'free-run-guard.sh');

/**
 * Execute the REAL function and report its exit status.
 *
 * Sourced from its real location by default, so the runtime BASH_SOURCE resolution that finds
 * free-run-guard.sh beside it is the thing under test rather than something the harness fakes.
 */
function runSpends(env: Record<string, string> = {}, opts: { isolate?: boolean } = {}) {
  let gate = GATE;
  let dir: string | null = null;
  if (opts.isolate) {
    // The gate ALONE, with no free-run-guard.sh beside it — the "cannot prove it is free" case.
    dir = mkdtempSync(join(tmpdir(), 'gate-alone-'));
    gate = join(dir, 'stage-coverage-gate.sh');
    copyFileSync(GATE, gate);
  }
  try {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(gate)}; _coverage_gate_run_spends; echo "rc=$?"`], {
      encoding: 'utf8',
      timeout: 30_000,
      // A clean environment: inheriting the developer's EPAM_FREE_RUN would make these vacuous.
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', ...env },
    });
    const m = /rc=(\d+)/.exec(out);
    if (!m) throw new Error(`no exit status in output: ${out}`);
    return { rc: Number(m[1]), out };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

describe('the predicate the money gate asks before it enforces', () => {
  it('the guard it depends on is really there — otherwise every case below is vacuous', () => {
    expect(existsSync(GATE)).toBe(true);
    expect(existsSync(FREE_GUARD),
      'free-run-guard.sh has moved; the isolation case would then pass for the wrong reason')
      .toBe(true);
  });

  it('END ONE — an ordinary run SPENDS, so the gate enforces', () => {
    // EPAM_FREE_RUN unset: the default state of every real launch.
    expect(runSpends().rc, [
      'an ordinary paid run was reported as spending nothing, so the coverage gate stands down',
      'on exactly the runs it exists to protect.',
    ].join('\n')).toBe(0);
  });

  it('END TWO — a declared free run spends nothing, so the gate only measures', () => {
    expect(runSpends({ EPAM_FREE_RUN: '1' }).rc, [
      'a free rehearsal was told it can spend, so the coverage gate enforces against it. The',
      'launch stage sits at 2.3% precisely because its inline code only runs during a rehearsal —',
      'refusing the rehearsal leaves no way for it ever to become covered.',
    ].join('\n')).toBe(1);
  });

  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'Yes'])(
    'EPAM_FREE_RUN=%s is honoured as free', (v) => {
      expect(runSpends({ EPAM_FREE_RUN: v }).rc,
        `EPAM_FREE_RUN=${v} was not recognised as a free run, so a no-pay rehearsal gets gated`)
        .toBe(1);
    });

  // THE NEGATIVE HALF. Anything that is not an affirmative must read as "this run spends" — a
  // typo must never buy an exemption from a gate that protects money.
  it.each(['0', 'false', 'no', '', 'maybe', 'free', '2'])(
    'EPAM_FREE_RUN=%s is NOT a free run', (v) => {
      expect(runSpends({ EPAM_FREE_RUN: v }).rc,
        `EPAM_FREE_RUN=${v} was treated as free, so a PAID run skipped the coverage gate`)
        .toBe(0);
    });

  it('UNABLE TO PROVE A RUN IS FREE MEANS IT SPENDS — a missing guard buys no exemption', () => {
    // free-run-guard.sh absent AND free_run_requested undefined. The unsafe direction would be to
    // assume "free" and wave the run through.
    expect(runSpends({ EPAM_FREE_RUN: '1' }, { isolate: true }).rc, [
      'with free-run-guard.sh missing the gate concluded the run was free — and it did so even',
      'with EPAM_FREE_RUN=1 set, which it had no way to interpret. A missing file must never',
      'grant an exemption from a gate that protects money.',
    ].join('\n')).toBe(0);
  });

  it('a free_run_requested already in scope is used, not re-sourced over', () => {
    // The caller may have sourced the guard already. The gate must defer to that definition
    // rather than silently replacing it — two notions of "free" that disagree is the drift the
    // function's own comment says it exists to avoid.
    const out = execFileSync('bash', ['-c',
      `free_run_requested() { return 0; }; . ${JSON.stringify(GATE)}; `
      + '_coverage_gate_run_spends; echo "rc=$?"'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
    });
    expect(/rc=(\d+)/.exec(out)?.[1],
      'the caller\'s own free_run_requested was ignored, so two notions of "free" can disagree')
      .toBe('1');
  });
});
