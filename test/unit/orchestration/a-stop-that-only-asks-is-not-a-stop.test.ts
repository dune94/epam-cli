/**
 * A STOP THAT ONLY ASKS IS NOT A STOP.
 *
 * stop_runner_host sends SIGTERM, deletes the pidfile, and returns 0 — in that order, without ever
 * looking to see whether the process died:
 *
 *     if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
 *         kill "$_pid" 2>/dev/null
 *         rm -f "$_pidfile" "$_envfile"
 *         return 0
 *     fi
 *
 * Two consequences, and the visible one is much the smaller.
 *
 * THE FLAKE. pipeline-services-start-stop.test.ts checks liveness the instant --stop returns, and
 * under load the daemon has not yet run its SIGTERM handler, so the check fails: "runner-host was
 * not actually killed". Measured 2026-09-04 — 1 failure in 8 runs on master under artificial CPU
 * contention, and twice in three full-suite runs. It has nothing to do with what changed around it.
 *
 * THE REAL DEFECT. The pidfile is deleted whether or not the kill took effect, and --stop reports
 * "stopped runner-host" either way. A daemon that is wedged, stopped, or slow to exit therefore
 * survives with NOTHING left on disk pointing at it — and start_runner_host looks for exactly that
 * pidfile to decide whether one is already running. So the next --start spawns a SECOND daemon
 * watching the SAME spool directory. Both would claim the next request; the runner's in-process
 * lock is per-process and cannot see a sibling. That is two pipeline runs launched from one
 * operator click, on real credentials.
 *
 * So a stop must WAIT for the process to be gone, escalate if it will not go, and report only what
 * is true.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const LIB = join(REPO, 'orchestrations-installer/lib/runner-host-control.sh');

/**
 * Run stop_runner_host against a REAL daemon process of our choosing, and report both what the
 * function said and whether the process is genuinely gone afterwards.
 *
 * `trapTerm` makes the daemon ignore SIGTERM — a wedged daemon, which is the case the current
 * implementation cannot distinguish from a stopped one.
 */
function stopAgainstDaemon({ trapTerm }: { trapTerm: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-runner-'));
  const launch = join(dir, 'launch-dashboard');
  mkdirSync(launch, { recursive: true });

  const daemon = join(dir, 'daemon.sh');
  writeFileSync(daemon, [
    '#!/bin/bash',
    trapTerm ? "trap '' TERM" : '',
    'while :; do sleep 0.2; done',
  ].join('\n'));
  spawnSync('chmod', ['+x', daemon]);

  const script = join(dir, 'probe.sh');
  writeFileSync(script, [
    '#!/bin/bash',
    'set -uo pipefail',
    `. ${JSON.stringify(LIB)}`,
    // Start the daemon exactly as the control script does, and record ITS pid.
    `( exec </dev/null >/dev/null 2>&1; exec setsid ${JSON.stringify(daemon)} ) &`,
    `echo $! > ${JSON.stringify(join(launch, '.runner-host.pid'))}`,
    `PID=$(cat ${JSON.stringify(join(launch, '.runner-host.pid'))})`,
    'sleep 0.4',                                   // let it be genuinely up
    'kill -0 "$PID" 2>/dev/null || { echo "SETUP_FAILED"; exit 9; }',
    `stop_runner_host ${JSON.stringify(launch)}; echo "RC=$?"`,
    // THE MOMENT THE FUNCTION RETURNS. No sleep: that is the contract under test.
    'if kill -0 "$PID" 2>/dev/null; then echo "ALIVE=yes"; else echo "ALIVE=no"; fi',
    `if [ -f ${JSON.stringify(join(launch, '.runner-host.pid'))} ]; then echo "PIDFILE=kept"; else echo "PIDFILE=gone"; fi`,
    'kill -9 "$PID" 2>/dev/null; exit 0',          // never leak the fixture daemon
  ].join('\n'));

  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
  rmSync(dir, { recursive: true, force: true });
  return `${r.stdout}${r.stderr}`;
}

describe('stopping the runner-host actually stops it', () => {
  it('the fixture daemon really starts — otherwise every case here is vacuous', () => {
    const out = stopAgainstDaemon({ trapTerm: false });
    expect(out, 'the probe never got a live daemon to stop').not.toContain('SETUP_FAILED');
  });

  it('the process is GONE by the time the stop returns', () => {
    const out = stopAgainstDaemon({ trapTerm: false });
    expect(out, [
      'stop_runner_host returned while the process was still alive. It sends SIGTERM and returns',
      'without waiting, so "stopped runner-host" is printed for a request, not an outcome — and a',
      'caller that checks liveness immediately is right to disbelieve it.',
    ].join('\n')).toContain('ALIVE=no');
  });

  it('a daemon that IGNORES SIGTERM is escalated, not declared dead', () => {
    // The case that costs money: a wedged daemon survives, its pidfile is deleted, and the next
    // --start therefore sees nothing running and spawns a SECOND daemon on the same spool.
    const out = stopAgainstDaemon({ trapTerm: true });
    expect(out, [
      'a daemon ignoring SIGTERM survived the stop. The pidfile is deleted regardless, so nothing',
      'on disk points at it any more and start_runner_host will spawn a SECOND daemon watching the',
      'same spool — two runs launched from one click, on real credentials.',
    ].join('\n')).toContain('ALIVE=no');
  });

  it('and the pidfile is cleared once the process is genuinely gone', () => {
    const out = stopAgainstDaemon({ trapTerm: false });
    expect(out).toContain('PIDFILE=gone');
  });

  it('reports success when it succeeded', () => {
    const out = stopAgainstDaemon({ trapTerm: false });
    expect(out, 'a successful stop must report success').toContain('RC=0');
  });
});
