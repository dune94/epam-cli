/**
 * THE HELPER THAT SATISFIES THE COVERAGE GATE MUST REALLY SATISFY IT.
 *
 * gatedRunEnv() supplies the precondition a paid launcher now has: a passing coverage measurement.
 * If it silently did not, every test using it would fail for a reason that looks like the launcher's
 * fault — and worse, a helper that "passed" by making the gate stand down would quietly disable the
 * gate everywhere it is used. So this drives the REAL gate with it and asserts it passes for the
 * right reason, then proves the same gate still blocks without it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gatedRunEnv } from '../../helpers/gated-run-env';

const REPO = join(__dirname, '../../..');
const GATE = join(REPO, 'orchestrations/scripts/lib/stage-coverage-gate.sh');
const NODE = process.execPath;

function wholeMap(env: Record<string, string>) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(GATE)}; require_all_stage_coverage`], {
    encoding: 'utf8', timeout: 300_000, cwd: REPO,
    env: { ...process.env, NODE_BIN: NODE, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('the gate precondition helper really passes the gate', () => {
  it('the whole-map gate PASSES with it, and says the run is gated', () => {
    const r = wholeMap(gatedRunEnv());
    expect(r.code, `the helper does not satisfy the gate: ${r.out.slice(0, 800)}`).toBe(0);
    expect(r.out, 'it passed without declaring the run gated, so no stage would enforce')
      .toMatch(/the run is gated/i);
  }, 360_000);

  it('and the same gate BLOCKS without it — the helper is evidence, not a bypass', () => {
    const r = wholeMap({
      STAGE_COVERAGE_LCOV: '/tmp/no-such-lcov-at-all.info',
      STAGE_COVERAGE_LCOV_SHELL: '/tmp/no-such-shell-lcov.info',
      STAGE_COVERAGE_REPORT: '/tmp/no-such-report-at-all.json',
    });
    expect(r.code, 'the gate passed with no coverage data — it is not gating anything').not.toBe(0);
  }, 360_000);
});
