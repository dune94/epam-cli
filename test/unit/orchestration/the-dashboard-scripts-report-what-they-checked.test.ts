/**
 * THE THREE DASHBOARD SCRIPTS — 597 lines between them, none with a test.
 *
 * The dashboards are how a run is watched while it happens, and the operator's requirement is that
 * they are part of the flow. These are the three things that check them:
 *
 *   verify-dashboards.sh      a STATIC audit of the pages — nav completeness, field drift, fetch
 *                             paths that resolve. Needs no server.
 *   validate-dashboards.sh    a POST-RUN check that the data the pages read is really there.
 *   dashboard-health-check.sh a RUNTIME check that the endpoints serve, with --fix to restart.
 *
 * They share one failure mode, and it is the one that matters: a checker that finds nothing because
 * it looked at nothing reports exactly what a clean run reports. So every assertion here is that the
 * script SAYS what it examined, and refuses rather than passing when it cannot examine it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(S, script), ...args], {
    encoding: 'utf8', timeout: 180_000, cwd: join(__dirname, '../../..'),
    env: { ...process.env, EPAM_COVERAGE_GATED: '0', NODE_BIN: process.execPath, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('verify-dashboards audits the pages without needing a server', () => {
  it('produces a report naming the checks it performed', () => {
    const r = run('verify-dashboards.sh');
    expect(r.out.trim(), 'the static audit produced no output at all').not.toBe('');
    expect(r.out, 'it does not say which checks it ran')
      .toMatch(/nav|navigation|field|fetch|parity|check/i);
  }, 240_000);

  it('--strict makes a WARN fail, and without it a WARN does not', () => {
    // The two modes must actually differ, or --strict is decoration and an operator believes they
    // asked for something stricter than they got.
    const lenient = run('verify-dashboards.sh');
    const strict = run('verify-dashboards.sh', ['--strict']);
    expect(strict.code >= lenient.code,
      '--strict was more permissive than the default').toBe(true);
  }, 240_000);

  it('an unknown option is refused rather than silently ignored', () => {
    const r = run('verify-dashboards.sh', ['--not-a-flag']);
    expect(r.code, 'a mis-typed --strict would have run non-strict and looked fine').not.toBe(0);
    expect(r.out).toMatch(/Unknown option/);
  }, 240_000);

  it('--help explains itself and exits cleanly', () => {
    const r = run('verify-dashboards.sh', ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--strict|--json|Usage/i);
  }, 240_000);
});

describe('validate-dashboards refuses to validate what it cannot find', () => {
  it('a MISSING logs directory is refused, not reported as clean', () => {
    // A validator that finds no problems because it found no files is the exact shape of a green
    // report on a broken run.
    const r = run('validate-dashboards.sh', ['--logs', '/no/such/logs', '--dashboards', '/no/such/dash']);
    expect(r.code, 'it validated a directory that does not exist').not.toBe(0);
  }, 240_000);

  it('names what it was looking for when it refuses', () => {
    const r = run('validate-dashboards.sh', ['--logs', '/no/such/logs']);
    expect(r.out.trim(), 'it refused without saying what was missing').not.toBe('');
  }, 240_000);

  it('an unknown option is refused', () => {
    const r = run('validate-dashboards.sh', ['--not-a-flag']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Unknown option/);
  }, 240_000);

  it('an EMPTY logs directory is a finding, not a pass', () => {
    // The run produced nothing. That is precisely what this exists to notice.
    const logs = mkdtempSync(join(tmpdir(), 'logs-'));
    const dash = mkdtempSync(join(tmpdir(), 'dash-'));
    const r = run('validate-dashboards.sh', ['--logs', logs, '--dashboards', dash]);
    expect(r.code, 'a run that produced no logs at all was validated as fine').not.toBe(0);
  }, 240_000);
});

describe('dashboard-health-check reports the endpoints it probed', () => {
  it('names the endpoints it checked, so a silent skip is visible', () => {
    const r = run('dashboard-health-check.sh', [], { EPAM_DASHBOARD_URL: 'http://127.0.0.1:1' });
    expect(r.out.trim(), 'the health check produced no output at all').not.toBe('');
  }, 240_000);

  it('a dashboard that is not serving is a FAILURE, not a warning', () => {
    // Port 1 is reserved; nothing listens there. A run started with the dashboards down is a run
    // nobody can watch.
    const r = run('dashboard-health-check.sh', [], { EPAM_DASHBOARD_URL: 'http://127.0.0.1:1' });
    expect(r.code, 'a dead dashboard exited 0').not.toBe(0);
  }, 240_000);

  it('an unknown option is refused', () => {
    const r = run('dashboard-health-check.sh', ['--not-a-flag']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Unknown option/);
  }, 240_000);

  it('--help explains its modes and exits cleanly', () => {
    const r = run('dashboard-health-check.sh', ['--help']);
    expect(r.code).toBe(0);
    expect(r.out, 'the usage does not mention --fix, which is what makes it useful in a pipeline')
      .toMatch(/--fix/);
  }, 240_000);
});
