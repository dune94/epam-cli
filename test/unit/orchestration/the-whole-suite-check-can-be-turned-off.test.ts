/**
 * EPAM_WHOLE_SUITE_CHECK=0 — THE STORY IS JUDGED BY ITS OWN TESTS, NOT THE CODELINE'S WHOLE SUITE.
 *
 * Operator, 2026-10-05: "I am ok running the single test and forget the test baseline for brownfield."
 * next.gotransit.com's suite carries a test that fails 2 runs in 4 on its untouched baseline; the gate
 * ran the baseline once, so the flake was charged to the story (real-estate rehearsal).
 *
 * EXECUTED: the real verify_codeline_suite and pre_review_suite on a codeline whose declared suite
 * fails. Off: both pass without running it. Unset (the default): both still run it and fail.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const root = mkdtempSync(join(tmpdir(), 'whole-suite-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ran = join(root, 'suite-ran');
mkdirSync(join(root, 'cl', '.epam'), { recursive: true });
const suite = `touch ${JSON.stringify(ran)}; echo 'FAIL src/flaky.spec.ts'; exit 1`;
writeFileSync(join(root, 'cl', '.epam', 'verification.json'), JSON.stringify({ test: { command: suite } }));

function call(fn: 'verify' | 'step19', flag?: string) {
  rmSync(ran, { force: true });
  const body = fn === 'verify'
    ? `source ${JSON.stringify(join(SCRIPTS, 'lib/external-verification.sh'))} >/dev/null 2>&1; verify_codeline_suite S-1 /dev/null 'npm run test -- one.spec'`
    : `source ${JSON.stringify(join(SCRIPTS, 'lib/pre-review-gate.sh'))} >/dev/null 2>&1; pre_review_suite ${JSON.stringify(join(root, 'cl'))} ${JSON.stringify(root)} ${JSON.stringify(join(root, 'gate.log'))}`;
  const env: Record<string, string> = { ...(process.env as any), PROJECT_ROOT: join(root, 'cl'), LOG_DIR: root, SCRIPT_DIR: SCRIPTS, AUTOMATION_DIR: join(SCRIPTS, '..'), NODE_BIN: process.execPath, EPAM_BROWNFIELD: '1' };
  delete env.EPAM_WHOLE_SUITE_CHECK;
  if (flag !== undefined) env.EPAM_WHOLE_SUITE_CHECK = flag;
  const r = spawnSync('bash', ['-c', `log(){ echo "$*"; }; warning(){ echo "$*"; }; error(){ echo "$*"; }; success(){ :; }; info(){ :; }\n${body}`], { encoding: 'utf8', env, timeout: 60_000 });
  return { status: r.status, ran: existsSync(ran), out: r.stdout + r.stderr };
}

describe('Step 3.545 (update-invalidated-tests.sh) reads the same switch', () => {
  const run = (flag?: string) => {
    rmSync(ran, { force: true });
    const env: Record<string, string> = { ...(process.env as any), PROJECT_ROOT: join(root, 'cl'), LOG_DIR: root, NODE_BIN: process.execPath, EPAM_BROWNFIELD: '1', JIRA_BASELINE_BRANCH: 'develop', STORY_VERIFICATION_CRITERIA: 'x' };
    delete env.EPAM_WHOLE_SUITE_CHECK;
    if (flag !== undefined) env.EPAM_WHOLE_SUITE_CHECK = flag;
    const r = spawnSync('bash', [join(SCRIPTS, 'update-invalidated-tests.sh'), 'S-1'], { encoding: 'utf8', env, timeout: 120_000 });
    return { status: r.status, ran: existsSync(ran), out: r.stdout + r.stderr };
  };
  it('off — exits 0 without running the codeline\'s suite, and says so', () => {
    const r = run('0');
    expect(r.ran, 'the suite ran although the check is off').toBe(false);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/EPAM_WHOLE_SUITE_CHECK=0/);
  });
  it('default — the suite still runs', () => {
    const r = run();
    expect(r.ran, `the suite never ran — the "off" case proves nothing:\n${r.out.slice(-800)}`).toBe(true);
  });
});

describe('the whole-suite check', () => {
  for (const fn of ['verify', 'step19'] as const) {
    it(`${fn}: off — passes without running the codeline's suite, and says so`, () => {
      const r = call(fn, '0');
      expect(r.ran, 'the suite ran although the check is off').toBe(false);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/EPAM_WHOLE_SUITE_CHECK=0/);
    });
    it(`${fn}: default — the failing suite still runs and still fails`, () => {
      const r = call(fn);
      expect(r.ran, `the suite never ran — the test proves nothing:\n${r.out.slice(-600)}`).toBe(true);
      expect(r.status).not.toBe(0);
    });
  }
});
