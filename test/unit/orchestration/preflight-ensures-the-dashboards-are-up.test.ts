/**
 * THE DASHBOARDS ARE PART OF THE RUN, SO PRE-FLIGHT ENSURES THEY ARE SERVING.
 *
 * The dashboards are how a run is watched while it happens — what is running now, what each agent
 * cost, which stories moved. A run that starts with them down is a run nobody can see, and the
 * operator finds out hours in with the money already spent.
 *
 * Two defects this covers:
 *
 *   The old probe curled ${DASH}/prd.json — a file the dashboards no longer read. It could fail
 *   while every dashboard served perfectly, and pass while they were blank. The endpoint checked
 *   has to be the one the operator actually opens.
 *
 *   It only REPORTED. "Ensure they are up" means act: restart the container, re-check, and fail
 *   only if they are still down.
 *
 * MEASUREMENT NOTE: this sandbox cannot curl even its own loopback — a live local server answers
 * 000. So the probe and the VERDICT are separate functions, and these tests replace the probe and
 * drive the verdict across every status curl can return. That is where the defect was: `curl`
 * already prints 000 on failure, and an `|| echo 000` on top appended a SECOND one, making "000000"
 * — a valid integer zero, which passed `-lt 400`. A dashboard on a dead port reported as serving.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const LIB = join(REPO, 'orchestrations/scripts/lib/dashboard-ensure.sh');

/** Drive the verdict with a chosen status, the probe replaced. */
function withStatus(code: string, noFix = true) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}
     _dashboard_code() { printf '%s' ${JSON.stringify(code)}; }
     ensure_dashboards_up "http://dashboard.test" ${noFix ? '--no-fix' : ''}`], {
    encoding: 'utf8', timeout: 60_000, cwd: REPO,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('pre-flight ensures the dashboards are up', () => {
  it.each(['200', '204', '302'])('a dashboard answering %s is UP', (code) => {
    const r = withStatus(code);
    expect(r.code, `HTTP ${code} was reported down: ${r.out}`).toBe(0);
    expect(r.out).toMatch(/✓[^\n]*dashboard/i);
  }, 90_000);

  it.each(['404', '500', '502'])('a dashboard answering %s is DOWN — the socket accepting is not enough', (code) => {
    // A container that boots but serves 502 is exactly the state a reachability check calls healthy.
    const r = withStatus(code);
    expect(r.code, `HTTP ${code} was reported as serving`).not.toBe(0);
  }, 90_000);

  it('an unreachable dashboard is DOWN — the 000-doubling defect', () => {
    const r = withStatus('000');
    expect(r.code, 'a dashboard on a dead port was reported as serving').not.toBe(0);
  }, 90_000);

  it('_dashboard_serving is the verdict, and it is driven directly', () => {
    // The guard scanner's bar is that a blocking function's NAME appears under test/. That bar
    // exists because three guards were confirmed inert in production while the suite was green —
    // each had tests, none ran the guard against a case it was supposed to catch. Driving it
    // through its caller is not the same as driving it.
    const verdict = (code: string) => spawnSync('bash', ['-c',
      `. ${JSON.stringify(LIB)}; _dashboard_serving ${JSON.stringify(code)}; echo "rc=$?"`],
      { encoding: 'utf8', timeout: 60_000, cwd: REPO }).stdout.trim();
    expect(verdict('200'), 'a 200 was not judged as serving').toBe('rc=0');
    expect(verdict('204')).toBe('rc=0');
    expect(verdict('301')).toBe('rc=0');
    expect(verdict('404'), 'a 404 was judged as serving').toBe('rc=1');
    expect(verdict('502'), 'a container answering 502 was judged as serving').toBe('rc=1');
    expect(verdict('000'), 'an unreachable dashboard was judged as serving').toBe('rc=1');
    expect(verdict(''), 'an empty status was judged as serving').toBe('rc=1');
  }, 90_000);

  it('with no URL configured it refuses rather than silently passing', () => {
    const r = spawnSync('bash', ['-c',
      `. ${JSON.stringify(LIB)}; ensure_dashboards_up "" --no-fix`],
      { encoding: 'utf8', timeout: 60_000, cwd: REPO });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(r.status, 'an unconfigured dashboard was treated as healthy').not.toBe(0);
    expect(out).toMatch(/no URL configured/i);
  }, 90_000);

  it('it RESTARTS them before failing — ensure, not report', () => {
    // Without --no-fix the function must reach for the restart path. Asserted on the attempt,
    // because whether a container starts here depends on docker, not on this logic.
    const r = withStatus('000', false);
    expect(r.out, 'it gave up without trying to bring the dashboards up')
      .toMatch(/restarting it before giving up|after a restart|no way to restart/i);
  }, 120_000);

  it('and PRE-FLIGHT actually calls it — a function nothing calls guards nothing', () => {
    const src = readFileSync(join(REPO, 'orchestrations/scripts/preflight-check.sh'), 'utf8');
    expect(src, 'pre-flight does not source the dashboard check').toMatch(/dashboard-ensure\.sh/);
    expect(src, 'pre-flight sources it but never calls it').toMatch(/ensure_dashboards_up\s+"\$_DASH"/);
    expect(src, 'the dead prd.json probe is still there').not.toMatch(/curl -sf \$\{_DASH\}\/prd\.json/);
  });
});
