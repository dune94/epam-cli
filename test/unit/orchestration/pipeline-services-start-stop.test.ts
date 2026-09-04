import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * pipeline-services.sh --stop / --start — restart the docker stacks + runner-host WITHOUT a full
 * re-install and WITHOUT touching data. Different from --uninstall (deletes volumes/images) and
 * from install.sh (re-packages a ref) — this exists for "WSL went down, or the operator wants to
 * bounce services," where nothing about the install itself should change.
 *
 * THE IDENTITY MUST SURVIVE A STOP/START: `down` (no -v) still removes the network, so a naive
 * `up` afterward with no env would fall back to default subnet/ports and could collide with the
 * dev stack. install.sh persists what it actually resolved to .pipeline-services-state.env; this
 * script must read that back, never re-decide.
 */
const REPO = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'orchestrations-installer/pipeline-services.sh';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-services-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(REPO, SCRIPT_REL), path.join(dir, SCRIPT_REL));
  fs.chmodSync(path.join(dir, SCRIPT_REL), 0o755);
  for (const f of ['container-runtime.sh', 'runner-host-control.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), 'services: {}\n');
  fs.mkdirSync(path.join(dir, 'launch-dashboard/backend/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'launch-dashboard/docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, 'launch-dashboard/.env'), 'LAUNCH_PASSWORD=test\nLAUNCH_UI_PORT=18199\n');

  const runnerHostMarker = path.join(dir, 'runner-host.marker');
  fs.writeFileSync(path.join(dir, 'launch-dashboard/backend/src/runner-host.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(runnerHostMarker)}, process.pid + '\\n');
setInterval(() => {}, 60000);
`);
  cleanups.push(() => {
    const pidfile = path.join(dir, 'launch-dashboard/.runner-host.pid');
    if (!fs.existsSync(pidfile)) return;
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  // Logs argv AND the env vars a real compose file would interpolate — a stub can't parse YAML,
  // so a subnet/port only ever reaches this log via these explicit env dumps, same pattern the
  // launch-dashboard retry test already relies on.
  const dockerLog = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
{ printf 'ARGV: %s\\n' "$*"; printf 'EPAM_OBS_SUBNET=%s\\n' "\${EPAM_OBS_SUBNET:-}"; printf 'LAUNCH_SUBNET=%s\\n' "\${LAUNCH_SUBNET:-}"; } >> ${JSON.stringify(dockerLog)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);

  return { dir, bin, dockerLog, runnerHostMarker };
}

function writeState(dir: string, extra: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    OBS_PROJECT: 'test-install-amsd-pipeline-obs-123456',
    OBS_SUBNET: '172.24.0.0/16',
    OBS_CLICKHOUSE_PORT: '8123', OBS_LANGFUSE_PORT: '3100', OBS_DASHBOARD_PORT: '8092', OBS_GRAFANA_PORT: '3001',
    LAUNCH_PROJECT: 'test-install-amsd-pipeline-launch-123456',
    LAUNCH_SUBNET: '172.25.0.0/16', LAUNCH_UI_PORT: '18199',
    ...extra,
  };
  fs.writeFileSync(path.join(dir, '.pipeline-services-state.env'),
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

const run = (f: { dir: string; bin: string }, args: string[]) =>
  spawnSync('bash', [path.join(f.dir, SCRIPT_REL), ...args], {
    cwd: f.dir, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, EPAM_NONINTERACTIVE: '1', EPAM_CONTAINER_RUNTIME: 'docker' },
  });

describe('pipeline-services.sh', () => {
  it('--start refuses loudly when the install has no persisted state (never brought up before)', () => {
    const f = fixture();
    const r = run(f, ['--start']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/pipeline-services-state\.env/);
  });

  it('--stop tears down BOTH compose projects WITHOUT -v, preserving data, using the SAVED identity', () => {
    const f = fixture();
    writeState(f.dir);
    const r = run(f, ['--stop']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const log = fs.readFileSync(f.dockerLog, 'utf8');
    expect(log, `no -p scoping reached down:\n${log}`).toMatch(/-p\s+test-install-amsd-pipeline-obs-123456/);
    expect(log).toMatch(/-p\s+test-install-amsd-pipeline-launch-123456/);
    expect(log, 'down must never carry -v — this is a pause, not an uninstall').not.toMatch(/(^|\s)-v(\s|$)/m);
    expect(log, 'down must never carry --rmi — this is a pause, not an uninstall').not.toMatch(/--rmi/);
  });

  it('--stop also stops runner-host, if it was running', () => {
    const f = fixture();
    writeState(f.dir);
    // Simulate an already-running runner-host from a prior install.sh run. stdio: 'ignore' is
    // load-bearing here, not cosmetic — a backgrounded daemon that inherits a PIPED stdio (even
    // with its own fds separately redirected) keeps that pipe open forever, and spawnSync then
    // hangs waiting for a 'close' that never comes (the exact bug fixed in install.sh itself).
    const r1 = spawnSync('bash', ['-c',
      '( exec </dev/null >/dev/null 2>&1; exec setsid node launch-dashboard/backend/src/runner-host.js ) & echo $! > launch-dashboard/.runner-host.pid'],
      { cwd: f.dir, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    expect(r1.status).toBe(0);
    const pid = Number(fs.readFileSync(path.join(f.dir, 'launch-dashboard/.runner-host.pid'), 'utf8').trim());

    const r = run(f, ['--stop']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout, `did not report stopping runner-host:\n${r.stdout}`).toMatch(/stopped runner-host/);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive, 'runner-host was not actually killed').toBe(false);
  });

  it('--start brings both stacks up using the SAVED subnet/ports, never re-rolling new ones', () => {
    const f = fixture();
    writeState(f.dir, { OBS_SUBNET: '172.26.0.0/16', LAUNCH_UI_PORT: '18777' });
    const r = run(f, ['--start']);
    expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    const log = fs.readFileSync(f.dockerLog, 'utf8');
    expect(log, `saved obs subnet was not reused:\n${log}`).toMatch(/172\.26\.0\.0\/16/);
    expect(log, `expected an 'up -d' for the observability stack:\n${log}`).toMatch(/up\s+-d/);
  });

  it('--start also starts runner-host, idempotently, using the real spawn/env logic', () => {
    const f = fixture();
    writeState(f.dir);
    const r = run(f, ['--start']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const pidfile = path.join(f.dir, 'launch-dashboard/.runner-host.pid');
    expect(fs.existsSync(pidfile)).toBe(true);
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    expect(alive, 'runner-host was not actually started').toBe(true);
    expect(fs.existsSync(f.runnerHostMarker)).toBe(true);
  });
});
