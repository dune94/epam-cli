/**
 * A HALT IS NEVER RETRIED.
 *
 * run-agent-orchestration.sh exits non-zero for two unrelated reasons, and both used
 * to be exit 2:
 *
 *   REMEDIATED  a gate applied a fix — re-running the phase should now pass.
 *   HALT        the reviewer never approved the change AND the ladder is exhausted.
 *               There is no higher rung; re-running cannot possibly help.
 *
 * Live run 20260814T213253Z (metrolinx, AMSD-2041). Step 3.6 got this exactly right:
 *
 *     [ERROR] Step 3.6: review changes unresolved after 4 cycle(s), ladder exhausted
 *     [ERROR]          A change the reviewer never approved must NOT proceed —
 *                      human review required.
 *
 * ...and then exited 2. The caller read 2, called it remediation, and retried:
 *
 *     [00:03:30] Gate remediation applied for 'core' ('metrolinx') — retrying
 *     [SUCCESS]  [story-branch] AMSD-2041: freshly based on origin/develop
 *                               (working tree hard-reset + cleaned)
 *
 * That retry hard-reset the branch — orphaning work that had already passed `npm run
 * test` and `tsc` — then spent 12 further attempts against the exhausted ladder and
 * failed. ~15 minutes and real money to arrive where Step 3.6 already was.
 *
 * These tests EXECUTE the launcher's real run_phase against a stubbed orchestrator
 * that exits with a chosen code, and count how many times the stub is invoked. A
 * source-text check ("does it mention exit 3") would pass on a comment; only the
 * invocation count proves the retry did not happen.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');

/**
 * Every launcher that decides whether to retry a phase. The bug was found in one of
 * these and existed identically in all of them.
 */
const LAUNCHERS = [
  'tier3-metrolinx-run.sh',
  'tier3-mock-run.sh',
  'tier3-skyscanner-app-run.sh',
  'tier3-travel-app-run.sh',
];

/**
 * Extract the launcher's run_phase function and run it with a stubbed
 * run-agent-orchestration.sh that exits `code`. Returns how many times the stub ran.
 */
function runPhaseWithStub(launcher: string, code: number) {
  const src = readFileSync(join(SCRIPTS, launcher), 'utf8');
  const start = src.indexOf('run_phase() {');
  if (start < 0) return { found: false, calls: 0, out: '' };
  // Balance to the function's closing brace at column 0.
  const end = src.indexOf('\n}\n', start);
  const fn = src.slice(start, end + 3);

  const dir = mkdtempSync(join(tmpdir(), 'halt-'));
  try {
    const stubDir = join(dir, 'scripts');
    mkdirSync(join(stubDir, 'lib'), { recursive: true });
    const counter = join(dir, 'calls');
    writeFileSync(counter, '');
    // The stub records each invocation, then exits with the code under test.
    const stub = join(stubDir, 'run-agent-orchestration.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\necho x >> "${counter}"\nexit ${code}\n`);
    chmodSync(stub, 0o755);
    // Some launchers remediate the PRD before running the phase. Stub it as a no-op
    // success so the harness reaches the exit-code decision under test — without it,
    // those launchers `fail` before the orchestrator is ever invoked.
    const remediate = join(stubDir, 'prd-remediate.sh');
    writeFileSync(remediate, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(remediate, 0o755);
    // The real shared decision function — not a copy.
    writeFileSync(
      join(stubDir, 'lib', 'phase-exit.sh'),
      readFileSync(join(SCRIPTS, 'lib', 'phase-exit.sh'), 'utf8'),
    );

    const harness = `
      set -uo pipefail
      SCRIPT_DIR="${stubDir}"
      LOG_FILE="${join(dir, 'log.txt')}"
      PRD_FILE="${join(dir, 'prd.json')}"
      EPAM_BROWNFIELD=1
      info()    { echo "INFO: $*"; }
      success() { echo "SUCCESS: $*"; }
      warning() { echo "WARNING: $*"; }
      error()   { echo "ERROR: $*"; }
      log()     { echo "$*"; }
      fail()    { echo "FAIL: $*"; exit 9; }
      . "${stubDir}/lib/phase-exit.sh"
      ${fn}
      run_phase core
      echo "run_phase rc=$?"
    `;
    const res = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
    const calls = existsSync(counter)
      ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
      : 0;
    return { found: true, calls, out: (res.stdout || '') + (res.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the retryable/not-retryable decision is defined once', () => {
  const LIB = join(SCRIPTS, 'lib', 'phase-exit.sh');

  function isRetryable(code: string) {
    const r = spawnSync(
      'bash',
      ['-c', `. "${LIB}"; if phase_exit_is_retryable "${code}"; then echo YES; else echo NO; fi`],
      { encoding: 'utf8' },
    );
    return (r.stdout || '').trim();
  }

  it('only REMEDIATED is retryable', () => {
    expect(isRetryable('2')).toBe('YES');
  });

  it('HALT is not retryable', () => {
    expect(isRetryable('3')).toBe('NO');
  });

  it('success and unknown codes are not retryable', () => {
    // An unclassified code must never be retried: retrying an outcome nobody has
    // classified is how the HALT came to be retried in the first place.
    expect(isRetryable('0')).toBe('NO');
    expect(isRetryable('1')).toBe('NO');
    expect(isRetryable('7')).toBe('NO');
    expect(isRetryable('')).toBe('NO');
  });

  it('names the halt in words, so a failure reads as a decision not a number', () => {
    const r = spawnSync('bash', ['-c', `. "${LIB}"; phase_exit_describe 3`], { encoding: 'utf8' });
    expect((r.stdout || '').toLowerCase()).toMatch(/human review/);
  });
});

describe('no launcher retries a HALT', () => {
  for (const launcher of LAUNCHERS) {
    it(`${launcher}: exit 3 runs the phase exactly once`, () => {
      const { found, calls, out } = runPhaseWithStub(launcher, 3);
      expect(found, `${launcher} has no run_phase to test`).toBe(true);
      expect(calls, `the phase was run ${calls} times on a HALT.\n${out}`).toBe(1);
    });

    it(`${launcher}: exit 2 still retries exactly once`, () => {
      // The remediation retry is legitimate and must survive the fix — a gate that
      // stops retrying everything would be its own regression.
      const { found, calls, out } = runPhaseWithStub(launcher, 2);
      expect(found).toBe(true);
      expect(calls, `expected 2 invocations (initial + retry), got ${calls}.\n${out}`).toBe(2);
    });
  }
});
