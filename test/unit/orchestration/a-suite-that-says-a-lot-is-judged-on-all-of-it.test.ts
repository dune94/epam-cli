/**
 * A SUITE THAT SAYS A LOT IS JUDGED ON ALL OF IT.
 *
 * Live 2026-10-05, AMSD-2974 gotransit lane: Step 19's suite baseline "exited 1 and produced NO
 * parseable failures" from 1,059,724 bytes, so nothing was subtracted and every writer attempt was
 * charged with pre-existing failures. Reproduced outside the run: the suite (29 suites PASS so far)
 * was cut off mid stack-trace at 1 MiB — execSync's default maxBuffer. Node kills the child when its
 * output passes the buffer, and runVerification reported that as a failed suite with exit 1.
 *
 * EXECUTED: the real runVerification and runTests, on a project whose declared suite prints 3 MiB
 * of noise and then its verdict — the shape of a real jest run full of console output.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../orchestrations/plugins/verification-plugin.js');

const root = mkdtempSync(join(tmpdir(), 'loud-suite-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOISE_BYTES = 3 * 1024 * 1024;
function project(exitCode: number) {
  const dir = mkdtempSync(join(root, 'p-'));
  mkdirSync(join(dir, '.epam'));
  // Shell, not node: a node script's process.exit drops pending pipe writes and would cut its own
  // output, which is not the defect under test. jest reports on stderr, so the noise and the verdict
  // go there; the pass case also prints a stdout line.
  const suite = join(dir, 'suite.sh');
  writeFileSync(suite, [
    `yes 'console.error  noisy log line from a component under test' | head -c ${NOISE_BYTES} >&2`,
    exitCode === 0 ? `echo 'Tests: 12 passed, 12 total'` : `printf 'FAIL src/a.spec.ts\\nTests: 1 failed, 11 passed, 12 total\\n' >&2`,
    `exit ${exitCode}`,
  ].join('\n'));
  const command = `bash ${JSON.stringify(suite)}`;
  writeFileSync(join(dir, '.epam', 'verification.json'), JSON.stringify({ test: { command }, typecheck: { command } }));
  return dir;
}

describe('a declared suite with more than 1 MiB of output', () => {
  for (const fn of ['runVerification', 'runTests'] as const) {
    it(`${fn}: a passing suite passes, and its verdict line is in the output`, () => {
      const r = fn === 'runVerification' ? plugin.runVerification(project(0), undefined, 'test') : plugin.runTests(project(0));
      expect(r.status, `a passing suite was reported ${r.status} (exit ${r.exitCode})`).toBe('pass');
      expect(r.output).toContain('Tests: 12 passed');
    }, 60_000);

    it(`${fn}: a failing suite fails with its own exit code, and the failure is in the output`, () => {
      const r = fn === 'runVerification' ? plugin.runVerification(project(3), undefined, 'test') : plugin.runTests(project(3));
      expect(r.status).toBe('fail');
      expect(r.output.length, 'the output was cut short').toBeGreaterThan(NOISE_BYTES);
      expect(r.exitCode, 'the suite\'s own exit code was replaced').toBe(3);
      expect(r.output, 'the failure line was cut off — nothing the parser could read').toContain('FAIL src/a.spec.ts');
    }, 60_000);
  }
});
