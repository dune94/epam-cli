import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * snapshot-watch.js is a HOST process, same class as runner-host.js: it writes
 * orchestrations/dashboards/live/build-info.json on disk, which agent-monitor's nginx container
 * only reads via a bind mount. Without it, a launched run's own pre-flight hard-fails 3 checks
 * immediately — confirmed live 2026-09-04 against a genuinely fresh install. install.sh,
 * --uninstall, pipeline-services.sh --start/--stop, and pipeline-health.sh all needed wiring.
 */
const REPO = path.resolve(__dirname, '../../..');

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-watch-'));
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations/scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations/dashboards'), { recursive: true });
  for (const f of ['install.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer', f), path.join(dir, 'orchestrations-installer', f));
    fs.chmodSync(path.join(dir, 'orchestrations-installer', f), 0o755);
  }
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/pipeline-services.sh'), path.join(dir, 'orchestrations-installer/pipeline-services.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/pipeline-services.sh'), 0o755);
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/pipeline-health.sh'), path.join(dir, 'orchestrations-installer/pipeline-health.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/pipeline-health.sh'), 0o755);
  for (const f of ['container-runtime.sh', 'isolated-compose-identity.sh', 'runner-host-control.sh', 'snapshot-watch-control.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }

  const marker = path.join(dir, 'snapshot-watch.marker');
  fs.writeFileSync(path.join(dir, 'orchestrations/scripts/snapshot-watch.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');
setInterval(() => {}, 60000);
`);

  const pidfile = path.join(dir, 'orchestrations/dashboards/.snapshot-watch.pid');
  cleanups.push(() => {
    if (!fs.existsSync(pidfile)) return;
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  return { dir, marker, pidfile };
}

describe('snapshot-watch.js lifecycle', () => {
  it('lib/snapshot-watch-control.sh starts it as a real, detached, PID-tracked process', () => {
    const f = fixture();
    const script = `
. "${f.dir}/orchestrations-installer/lib/snapshot-watch-control.sh"
_ok() { :; }
_bad() { :; }
start_snapshot_watch "${f.dir}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(fs.existsSync(f.pidfile), 'no pidfile written').toBe(true);
    const pid = Number(fs.readFileSync(f.pidfile, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    expect(alive, 'pidfile does not point at a real running process').toBe(true);
    expect(fs.existsSync(f.marker), 'snapshot-watch.js was never actually executed').toBe(true);
  });

  it('stop_snapshot_watch actually kills it and removes the pidfile', async () => {
    const f = fixture();
    const startScript = `. "${f.dir}/orchestrations-installer/lib/snapshot-watch-control.sh"\n_ok(){ :; }\n_bad(){ :; }\nstart_snapshot_watch "${f.dir}"`;
    spawnSync('bash', ['-c', startScript], { encoding: 'utf8', timeout: 10_000 });
    const pid = Number(fs.readFileSync(f.pidfile, 'utf8').trim());

    const stopScript = `. "${f.dir}/orchestrations-installer/lib/snapshot-watch-control.sh"\nstop_snapshot_watch "${f.dir}"`;
    const r = spawnSync('bash', ['-c', stopScript], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(f.pidfile), 'pidfile was not removed').toBe(false);

    // SIGTERM is not instant — poll briefly rather than check right away.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((res) => setTimeout(res, 50));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    expect(alive, 'the process was not actually killed').toBe(false);
  });

  it('pipeline-health.sh reports UNHEALTHY when snapshot-watch.js is not running', () => {
    const f = fixture();
    const r = spawnSync('bash', [path.join(f.dir, 'orchestrations-installer/pipeline-health.sh')], {
      cwd: f.dir, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: f.dir },
    });
    // _bad() (✗ lines) writes to stderr, by this script's own convention.
    expect(`${r.stdout}${r.stderr}`, `did not flag snapshot-watch as down:\n${r.stdout}\n${r.stderr}`).toMatch(/snapshot-watch\.js is NOT running/);
    expect(r.status, 'a missing required daemon must fail the health check').toBe(1);
  });

  it('pipeline-health.sh reports it healthy once running', () => {
    const f = fixture();
    const startScript = `. "${f.dir}/orchestrations-installer/lib/snapshot-watch-control.sh"\n_ok(){ :; }\n_bad(){ :; }\nstart_snapshot_watch "${f.dir}"`;
    spawnSync('bash', ['-c', startScript], { encoding: 'utf8', timeout: 10_000 });

    const r = spawnSync('bash', [path.join(f.dir, 'orchestrations-installer/pipeline-health.sh')], {
      cwd: f.dir, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: f.dir },
    });
    expect(r.stdout, `did not report snapshot-watch as running:\n${r.stdout}`).toMatch(/snapshot-watch\.js is running/);
  });
});
