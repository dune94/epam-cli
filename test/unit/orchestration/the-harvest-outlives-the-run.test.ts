/**
 * A HARVEST NOBODY STARTS IS NOT A HARVEST.
 *
 * cassette-watch.js only covers `kill -9` and OOM if it is ALREADY RUNNING when the run dies, which
 * means it must be owned by the install, exactly as snapshot-watch.js is: started when the install
 * brings its services up, stopped when the install is torn down. A script sitting in the tree that
 * nothing launches would leave the gap exactly where it was while looking closed.
 *
 * These assert the control functions really start and stop a process, and that the installer and
 * the services script both call them — the receiver AND the caller.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CONTROL = join(ROOT, 'orchestrations-installer/lib/cassette-watch-control.sh');
const INSTALL = join(ROOT, 'orchestrations-installer/install.sh');
const SERVICES = join(ROOT, 'orchestrations-installer/pipeline-services.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A fake install root carrying a watcher that just sleeps, so start/stop is observable. */
function fakeRoot() {
  const root = tmp('cwctl-');
  mkdirSync(join(root, 'orchestrations/scripts'), { recursive: true });
  mkdirSync(join(root, 'orchestrations/dashboards'), { recursive: true });
  writeFileSync(join(root, 'orchestrations/scripts/cassette-watch.js'),
    'setInterval(()=>{},1000);\n');
  return root;
}

function sh(root: string, body: string) {
  const d = tmp('cwsh-');
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
_ok(){ echo "OK: $*"; }; _bad(){ echo "BAD: $*"; }
source "${CONTROL}"
${body}
`);
  return spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
}


/** True once the pid is gone, polled up to timeoutMs. */
function waitGone(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    spawnSync('sleep', ['0.05']);
  }
  return false;
}

describe('the harvest is owned by the install, not by the run', () => {
  it('starts a real process and records its pid', () => {
    const root = fakeRoot();
    const r = sh(root, `start_cassette_watch "${root}"; echo "rc=$?"`);
    const pidfile = join(root, 'orchestrations/dashboards/.cassette-watch.pid');
    expect(existsSync(pidfile), `no pidfile. out: ${r.stdout}${r.stderr}`).toBe(true);
    const pid = parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid) && pid > 0, `bad pid: ${pid}`).toBe(true);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive, 'the watcher was not actually running').toBe(true);
    sh(root, `stop_cassette_watch "${root}"`);
  });

  it('stops it again, and clears the pidfile', () => {
    const root = fakeRoot();
    sh(root, `start_cassette_watch "${root}"`);
    const pidfile = join(root, 'orchestrations/dashboards/.cassette-watch.pid');
    const pid = parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
    sh(root, `stop_cassette_watch "${root}"`);
    expect(existsSync(pidfile), 'pidfile survived the stop').toBe(false);
    // SIGTERM is asynchronous: the kernel has not necessarily reaped it by the time bash returns,
    // so this waits for the process to actually go rather than racing it. Bounded, so a watcher
    // that genuinely ignores the signal still fails here instead of hanging the suite.
    expect(waitGone(pid, 5000), 'the watcher process outlived stop_cassette_watch').toBe(true);
  });

  it('is idempotent — a second start does not spawn a second watcher', () => {
    const root = fakeRoot();
    sh(root, `start_cassette_watch "${root}"`);
    const pidfile = join(root, 'orchestrations/dashboards/.cassette-watch.pid');
    const first = readFileSync(pidfile, 'utf8').trim();
    const r = sh(root, `start_cassette_watch "${root}"`);
    expect(readFileSync(pidfile, 'utf8').trim(), `spawned a duplicate. out: ${r.stdout}`).toBe(first);
    sh(root, `stop_cassette_watch "${root}"`);
  });

  it('the installer starts it and the uninstall stops it', () => {
    const src = readFileSync(INSTALL, 'utf8');
    expect(src, 'install.sh never starts the harvest').toContain('start_cassette_watch');
    expect(src, 'uninstall never stops the harvest — it would outlive the install').toContain('stop_cassette_watch');
    expect(src, 'install.sh does not source the control library').toContain('cassette-watch-control.sh');
  });

  it('the services script starts it AND stops it', () => {
    const src = readFileSync(SERVICES, 'utf8');
    expect(src, 'pipeline-services.sh never starts the harvest').toContain('start_cassette_watch');
    expect(src, 'pipeline-services.sh --stop leaves the harvest running').toContain('stop_cassette_watch');
  });

  it('the health check reports whether the harvest is up — a dead harvest is not healthy', () => {
    const src = readFileSync(join(ROOT, 'orchestrations-installer/pipeline-health.sh'), 'utf8');
    expect(src, 'pipeline-health.sh never asks whether the harvest is alive')
      .toContain('.cassette-watch.pid');
  });
});
