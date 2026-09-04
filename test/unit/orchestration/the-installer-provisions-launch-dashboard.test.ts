import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE INSTALLER MUST PROVISION launch-dashboard/ ITSELF — no human, no LLM, doing the
 * down/rebuild/up/verify dance by hand, which is exactly what happened before this existed.
 *
 * Three things a plain `docker compose up -d` does NOT give for free, all required here:
 *   1. a REBUILD, so changed source (Dart, Node) actually reaches the running containers — `up -d`
 *      alone recreates containers from whatever image already exists.
 *   2. ISOLATION from every other install on the machine — two checkouts must be able to run their
 *      launch-dashboard stack at once, which needs both a distinct compose project name and a
 *      distinct subnet (hit directly during manual testing: "Pool overlaps with other one on this
 *      address space").
 *   3. A REAL "is it up" check — `up -d` exits 0 the instant containers are CREATED, not when the
 *      service inside can answer a request.
 *
 * Docker itself is STUBBED (a fake binary that logs its invocation and exits 0 immediately) so
 * these tests run without a real container runtime. The "is it up" check is tested against a REAL
 * local HTTP server standing in for the launch-api container — this is what proves the gating
 * logic itself (not just that some command was run) actually works.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER = path.join(REPO, 'orchestrations-installer/install.sh');

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function serveHealth(port: number, ok = true): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
    server.listen(port, '127.0.0.1', () => resolve());
    cleanups.push(() => server.close());
  });
}

/** A minimal tree install.sh reads, PLUS a launch-dashboard/ subtree with its own compose+.env. */
function fixture(opts: { withCompose?: boolean; withEnvExample?: boolean; port?: number } = {}) {
  const { withCompose = true, withEnvExample = true, port = 18099 } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-launch-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(dir, 'orchestrations-installer/install.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/install.sh'), 0o755);
  for (const f of ['container-runtime.sh', 'wait-for-health.sh', 'isolated-compose-identity.sh', 'runner-host-control.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f),
      path.join(dir, 'orchestrations-installer/lib', f));
  }
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'EPAM_PROVIDER_SET=claude\nJIRA_URL=\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), 'services: {}\n');

  if (withCompose) {
    fs.mkdirSync(path.join(dir, 'launch-dashboard'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch-dashboard/docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(dir, 'launch-dashboard/.env'), `LAUNCH_PASSWORD=test\nLAUNCH_UI_PORT=${port}\n`);
    if (withEnvExample) {
      fs.writeFileSync(path.join(dir, 'launch-dashboard/.env.example'), 'LAUNCH_PASSWORD=\nLAUNCH_UI_PORT=8099\n');
    }
  }

  // THE ROOT .env — a SEPARATE file from launch-dashboard/.env, where LANGFUSE_SECRET_KEY/
  // PUBLIC_KEY actually live (.env.example's own declared shape). Found live 2026-09-04, real
  // Langfuse traces never appearing for any launch-dashboard-triggered run: start_runner_host()
  // sourced ONLY launch-dashboard/.env, never this file, so the daemon's own langfuse-passthrough
  // logic (runner-host.js) always found the vars unset and never forwarded them to a launch.
  fs.writeFileSync(path.join(dir, '.env'), 'LANGFUSE_SECRET_KEY=sk-test-1234\nLANGFUSE_PUBLIC_KEY=pk-test-1234\n');

  // Stub docker: logs its full invocation (argv AND the env vars this feature depends on), exits 0
  // instantly — a real docker build/up takes real time and this test is about the ORCHESTRATION
  // logic around it, not about actually building an image.
  const log = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
{ printf 'ARGV: %s\\n' "$*"; printf 'LAUNCH_SUBNET=%s\\n' "\${LAUNCH_SUBNET:-}"; printf '%s\\n' '---'; } >> ${JSON.stringify(log)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);

  // A stub runner-host.js: writes its own PID AND the env vars it actually received to a marker
  // file, then stays alive (a real event loop, same as the real one's setInterval poll) until
  // killed. Proves install.sh's own spawn/idempotency/stop logic AND that it hands the daemon a
  // usable environment — found live, twice, that it did not: LAUNCH_PASSWORD was never exported
  // (Docker Compose auto-loads a service's .env; a bare host process gets none of that for free),
  // and SPOOL_DIR/RUNS_DB defaulted to the CONTAINER's bind-mount paths ('/spool', '/data/...'),
  // meaningless — and unwritable — on the host.
  fs.mkdirSync(path.join(dir, 'launch-dashboard/backend/src'), { recursive: true });
  const runnerHostMarker = path.join(dir, 'runner-host-started.marker');
  fs.writeFileSync(path.join(dir, 'launch-dashboard/backend/src/runner-host.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(runnerHostMarker)}, JSON.stringify({
  pid: process.pid,
  LAUNCH_PASSWORD: process.env.LAUNCH_PASSWORD || null,
  SPOOL_DIR: process.env.SPOOL_DIR || null,
  RUNS_DB: process.env.RUNS_DB || null,
  LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || null,
}) + '\\n');
setInterval(() => {}, 60000);
`);

  // ANY test whose install reaches LAUNCH_STATUS=up now also spawns this real daemon — not just
  // the tests that mean to test it. Every fixture() call registers its own cleanup regardless of
  // whether that specific test cares, or a real process leaks onto the host for every OTHER test
  // in this file that happens to get the dashboard healthy. Read lazily: the pidfile does not
  // exist yet at fixture-creation time, only after install.sh has actually run.
  cleanups.push(() => {
    const pidfile = path.join(dir, 'launch-dashboard/.runner-host.pid');
    if (!fs.existsSync(pidfile)) return;
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });

  return { dir, bin, log, runnerHostMarker };
}

const run = (f: { dir: string; bin: string }, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn('bash', [path.join(f.dir, 'orchestrations-installer/install.sh'), ...args], {
      cwd: f.dir,
      env: {
        ...process.env, PATH: `${f.bin}:${process.env.PATH}`,
        EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(f.dir, 'bin-shim'),
        // Fast in tests: the real default (30 tries * 1s) would make every test slow.
        EPAM_LAUNCH_HEALTH_TRIES: '5', EPAM_LAUNCH_HEALTH_INTERVAL: '0',
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (status) => resolve({ status, out }));
  });

describe('the installer provisions launch-dashboard', () => {
  it('is a no-op, cleanly, when launch-dashboard/ is not part of this tree', async () => {
    const f = fixture({ withCompose: false });
    const r = await run(f, ['--no-docker']);
    expect(r.out, 'a missing launch-dashboard must be reported as such, not silently skipped')
      .toMatch(/launch dashboard/i);
    expect(r.status).toBe(0);
  });

  it('skips with --no-docker, same as the observability dashboards', async () => {
    const f = fixture();
    const r = await run(f, ['--no-docker']);
    expect(fs.existsSync(f.log), 'docker was invoked despite --no-docker').toBe(false);
    expect(r.status).toBe(0);
  });

  it('rebuilds — not just `up -d` — so changed source actually reaches the containers', async () => {
    const port = 18101;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const log = fs.readFileSync(f.log, 'utf8');
    expect(log, `docker was never invoked:\n${log}`).toMatch(/compose/);
    expect(log, 'no --build: a stale image would silently keep serving the OLD code').toMatch(/--build/);
    expect(log, 'up -d is missing').toMatch(/\bup\b.*-d\b|-d\b.*\bup\b/);
  });

  it('pre-creates data/ and spool/ as the host user BEFORE compose ever sees them', async () => {
    // Found live 2026-09-03 against a genuinely fresh install: without this, Docker auto-creates
    // an absent bind-mount source itself, AS ROOT — and launch-api's own `user: 1000:1000` then
    // cannot write its database file to it. "unable to open database file", crash-looping.
    const port = 18106;
    await serveHealth(port);
    const f = fixture({ port });
    fs.rmSync(path.join(f.dir, 'launch-dashboard/data'), { recursive: true, force: true });
    fs.rmSync(path.join(f.dir, 'launch-dashboard/spool'), { recursive: true, force: true });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    for (const sub of ['data', 'spool']) {
      const p = path.join(f.dir, 'launch-dashboard', sub);
      expect(fs.existsSync(p), `${sub}/ was never created`).toBe(true);
      // Created by the (unprivileged, test-running) host process — never by a root-owned
      // container's bind-mount auto-creation, which is exactly the bug this guards against.
      expect(fs.statSync(p).uid, `${sub}/ is not owned by the invoking user`).toBe(process.getuid?.());
    }
  });

  it('names an isolated compose project — never the bare directory name', async () => {
    const port = 18102;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const log = fs.readFileSync(f.log, 'utf8');
    expect(log, `no -p flag reached compose:\n${log}`).toMatch(/-p\s+\S+/);
    expect(log).not.toMatch(/-p\s+launch-dashboard\b/);
  });

  it('declares a subnet — the compose file cannot pick one that avoids every other install', async () => {
    const port = 18103;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const log = fs.readFileSync(f.log, 'utf8');
    expect(log).toMatch(/LAUNCH_SUBNET=172\.\d+\.0\.0\/16/);
  });

  it('creates launch-dashboard/.env from its template when absent, WITH the fixed default LAUNCH_PASSWORD so it starts unattended', async () => {
    // Operator decision 2026-09-04, superseding the earlier random-generation decision: a random
    // value made every install's password unknowable without reading the file, and desynced from
    // the live process the moment a NEWER .env got copied in (a running container keeps whatever
    // password it started with in memory) — the only fix was a manual docker restart, discovered
    // live. A fixed, known default removes the ambiguity; the operator changes it via the
    // dashboard's own change-password flow, not by hoping a generated value matches reality.
    const port = 18104;
    await serveHealth(port);
    const f = fixture({ port });
    fs.rmSync(path.join(f.dir, 'launch-dashboard/.env'));
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const envPath = path.join(f.dir, 'launch-dashboard/.env');
    expect(fs.existsSync(envPath), 'no .env was created from the template').toBe(true);
    const body = fs.readFileSync(envPath, 'utf8');
    const lines = body.match(/^LAUNCH_PASSWORD=.*$/gm) ?? [];
    expect(lines.length, `expected exactly one LAUNCH_PASSWORD= line, found ${lines.length}:\n${body}`).toBe(1);
    expect(lines[0], 'LAUNCH_PASSWORD was not set to the fixed default').toBe('LAUNCH_PASSWORD=abcd1234');
    // MUST BE SHOWN TO THE OPERATOR, not file-only.
    expect(r.out, `the default password was never printed to the operator:\n${r.out}`).toContain('abcd1234');
    expect(r.out, 'did not tell the operator to change it').toMatch(/change/i);
  });

  it('skips starting (never crashes into compose\'s hard-fail) when .env already exists with LAUNCH_PASSWORD left blank', async () => {
    const f = fixture({ port: 18105 });
    fs.writeFileSync(path.join(f.dir, 'launch-dashboard/.env'), 'LAUNCH_PASSWORD=\nLAUNCH_UI_PORT=18105\n');
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.out, 'did not warn about the blank password').toMatch(/LAUNCH_PASSWORD/);
    const dockerLog = path.join(f.dir, 'docker.log');
    const log = fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, 'utf8') : '';
    expect(log, 'attempted to bring the launch dashboard up despite a known-blank password').not.toMatch(/launch-dashboard.*up -d|up -d.*--build/);
  });

  it('FAILS the install when neither .env nor a template exists — never silently proceeds', async () => {
    const f = fixture({ withEnvExample: false });
    fs.rmSync(path.join(f.dir, 'launch-dashboard/.env'));
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.status, 'missing .env with no template must fail the install').not.toBe(0);
    expect(r.out).toMatch(/\.env/);
  });

  it('DEEMS THE APP UP only when the health endpoint actually answers — not from compose exiting 0', async () => {
    // The stub "docker" exits 0 instantly and starts nothing real. Nothing is listening on the
    // health port, so even though compose "succeeded", the install must still FAIL.
    const f = fixture({ port: 18105 });
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.status, 'compose exiting 0 was trusted as "up" without checking').not.toBe(0);
    expect(r.out).toMatch(/never answered healthy|not answering/i);
  });

  it('reports success once a real health endpoint answers', async () => {
    const port = 18106;
    await serveHealth(port);
    const f = fixture({ port });
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.status, `install did not succeed:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/healthy/i);
  });

  it('retries on a subnet collision with the NEXT candidate, not a human picking one by hand', async () => {
    // Simulates exactly the failure hit during manual testing: the first subnet is already
    // claimed by an unrelated stack ("Pool overlaps with other one on this address space"). The
    // stub docker refuses only the FIRST subnet it is asked for; a real install must recover on
    // its own by trying the next declared candidate — never require a human to notice and re-run
    // with a different value by hand.
    const port = 18109;
    // The retry also steps the PORT by the same offset as the subnet (found live: a second
    // install can collide on the port alone, independent of the subnet) — so the attempt that
    // actually succeeds (the second one, offset 10) tries port+10, not the .env-declared port.
    await serveHealth(port + 10);
    const f = fixture({ port });
    // ONLY the launch-dashboard compose call is rejected-then-retried — the observability stack's
    // OWN unrelated `up -d` (docker-compose.observability.yml) runs earlier in install.sh and must
    // not be confused with it, so matching is scoped to that specific compose file.
    fs.writeFileSync(path.join(f.bin, 'docker'), `#!/bin/bash
{ printf 'ARGV: %s\\n' "$*"; printf 'LAUNCH_SUBNET=%s\\n' "\${LAUNCH_SUBNET:-}"; printf '%s\\n' '---'; } >> ${JSON.stringify(f.log)}
if [[ "$*" == *launch-dashboard/docker-compose.yml* ]]; then
  n=$(grep -c '^ARGV: .*launch-dashboard/docker-compose\\.yml' ${JSON.stringify(f.log)} 2>/dev/null || echo 0)
  [ "$n" = "1" ] && { echo "Error response from daemon: Pool overlaps with other one on this address space" >&2; exit 1; }
fi
exit 0
`);
    fs.chmodSync(path.join(f.bin, 'docker'), 0o755);

    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const log = fs.readFileSync(f.log, 'utf8');
    const launchAttempts = log.split('---\n')
      .filter((b) => b.includes('launch-dashboard') && b.includes('compose'));
    const subnets = launchAttempts
      .map((b) => b.match(/LAUNCH_SUBNET=(172\.\d+\.0\.0\/16)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
    expect(subnets.length, `expected at least 2 attempts (one rejected, one accepted):\n${log}`)
      .toBeGreaterThanOrEqual(2);
    expect(subnets[0], 'the retry used the SAME subnet again instead of the next candidate')
      .not.toBe(subnets[1]);
    expect(r.status, `install did not recover from the collision:\n${r.out}`).toBe(0);

    // DB DATA (Langfuse's postgres/clickhouse, this stack's own launch-api sqlite volume) MUST
    // SURVIVE a retry's teardown. The teardown between attempts uses a bare `down` — never `-v` —
    // specifically so a collision-triggered retry can never be the thing that deletes real data;
    // only an explicit `install.sh --uninstall` does that (see the-installer-uninstalls-safely).
    const downCalls = (log.match(/^ARGV:.*\bdown\b.*$/gm) || []);
    expect(downCalls.length, `expected a teardown between retry attempts:\n${log}`).toBeGreaterThan(0);
    for (const call of downCalls) {
      expect(call, `a non-uninstall down call carried -v, which would delete volumes:\n${call}`).not.toMatch(/(^|\s)-v(\s|$)/);
    }
  });

  it('does NOT retry on a failure that is not a subnet collision — burning through every candidate would hide the real error', async () => {
    const f = fixture({ port: 18110 });
    fs.writeFileSync(path.join(f.bin, 'docker'), `#!/bin/bash
{ printf 'ARGV: %s\\n' "$*"; printf '%s\\n' '---'; } >> ${JSON.stringify(f.log)}
if [[ "$*" == *launch-dashboard/docker-compose.yml* ]]; then
  echo "Error: Dockerfile not found" >&2
  exit 1
fi
exit 0
`);
    fs.chmodSync(path.join(f.bin, 'docker'), 0o755);
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const log = fs.readFileSync(f.log, 'utf8');
    const launchAttempts = (log.match(/^ARGV:.*launch-dashboard\/docker-compose\.yml/gm) || []).length;
    expect(launchAttempts, `a non-collision failure was retried anyway, hiding the real error:\n${log}`).toBe(1);
    expect(r.status).not.toBe(0);
  });

  it('records launch dashboard status in the install manifest', async () => {
    const port = 18107;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'install-manifest.json'), 'utf8'));
    expect(manifest.launchDashboard).toBe('up');
  });

  it('--check verifies without rebuilding — no compose invocation', async () => {
    const port = 18108;
    await serveHealth(port);
    const f = fixture({ port });
    const r = await run(f, ['--check', '--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    // `docker info` (the runtime-liveness probe) is fine and expected even under --check; a
    // COMPOSE invocation would mean it rebuilt/restarted something --check must only observe.
    const log = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
    expect(log, `--check must not rebuild or restart anything:\n${log}`).not.toMatch(/compose/);
    expect(r.out).toMatch(/up at/i);
  });
});

describe('install.sh starts and stops runner-host.js (the process that launches pipeline runs)', () => {
  // "the install script must start all services" (operator, 2026-09-04) — a saved launch request
  // previously sat "pending" forever because nothing ever started the process that polls for it.
  // A REAL node process is spawned here (a stub runner-host.js, not the real one) — proving
  // install.sh's own spawn/idempotency/stop logic, not just that some string appears in its output.

  it('starts it once the dashboard is genuinely up, writes a pidfile to a real running process', async () => {
    const port = 18111;
    await serveHealth(port);
    const f = fixture({ port });
    const r = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.out, `runner-host section missing or failed:\n${r.out}`).toMatch(/Runner host/);
    expect(r.out).toMatch(/started \(pid/);
    const pidfile = path.join(f.dir, 'launch-dashboard/.runner-host.pid');
    expect(fs.existsSync(pidfile), 'no pidfile written').toBe(true);
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(alive, 'pidfile does not point at a real running process').toBe(true);
    expect(fs.existsSync(f.runnerHostMarker), 'the stub runner-host.js was never actually executed').toBe(true);

    const seen = JSON.parse(fs.readFileSync(f.runnerHostMarker, 'utf8').trim().split('\n')[0]);
    // LAUNCH_PASSWORD: Docker Compose auto-loads a service's .env; a bare host process does not —
    // install.sh must source launch-dashboard/.env itself before spawning, or the real config.js
    // (which hard-requires this) crashes the daemon instantly on every real install.
    expect(seen.LAUNCH_PASSWORD, 'LAUNCH_PASSWORD from launch-dashboard/.env never reached the daemon').toBe('test');
    // SPOOL_DIR/RUNS_DB: their code defaults ('/spool', '/data/runs.db') are the CONTAINER's
    // bind-mount paths — meaningless, and unwritable, for a bare host process.
    expect(seen.SPOOL_DIR, 'SPOOL_DIR was left at its container-only default').toBe(path.join(f.dir, 'launch-dashboard/spool'));
    expect(seen.RUNS_DB, 'RUNS_DB was left at its container-only default').toBe(path.join(f.dir, 'launch-dashboard/data/runs.db'));
  });

  it('LANGFUSE_SECRET_KEY from the ROOT .env reaches the daemon — a separate file from launch-dashboard/.env', async () => {
    // Confirmed live 2026-09-04, pipeline-tests-10: a real launch-dashboard-triggered run produced
    // zero Langfuse traces despite LANGFUSE_SECRET_KEY/PUBLIC_KEY being correctly filled in at the
    // ROOT .env — start_runner_host() only ever sourced launch-dashboard/.env, a DIFFERENT file
    // that has no Langfuse keys at all (they are not even in its own .env.example template).
    const port = 18113;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const pidfile = path.join(f.dir, 'launch-dashboard/.runner-host.pid');
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });

    const seen = JSON.parse(fs.readFileSync(f.runnerHostMarker, 'utf8').trim().split('\n')[0]);
    expect(seen.LANGFUSE_SECRET_KEY,
      'LANGFUSE_SECRET_KEY from the root .env never reached the daemon — every launch-dashboard run traces to nothing')
      .toBe('sk-test-1234');
  });

  it('RE-RUNNING install.sh picks up a CHANGED .env — a daemon holding stale credentials is restarted', async () => {
    // THE INSTALLER MUST BE ABLE TO DELIVER A WORKING DAEMON, and re-running it is the only
    // sanctioned way to fix an environment (operator, 2026-09-04: "installer must do all
    // restarts"). start_runner_host() returned "already running" whenever a live process owned the
    // pidfile and never looked at WHAT that process was running with — so a daemon started before
    // the operator filled in .env kept its empty values forever, and no amount of re-running
    // install.sh could fix it.
    //
    // Live pipeline-tests-11: install.sh creates .env from .env.example (blank), starts
    // runner-host, and the operator then fills in LANGFUSE_SECRET_KEY/PUBLIC_KEY. The daemon held
    // "" for both, so runner-host.js's langfuse passthrough forwarded nothing and every
    // launch-dashboard run traced to nothing — with the installer reporting a clean, healthy
    // install the whole time.
    const port = 18114;
    await serveHealth(port);
    const f = fixture({ port });

    // First install: the operator has not filled in the key yet (blank, as .env.example ships it).
    fs.writeFileSync(path.join(f.dir, '.env'), 'LANGFUSE_SECRET_KEY=\nLANGFUSE_PUBLIC_KEY=\n');
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const firstPid = Number(fs.readFileSync(path.join(f.dir, 'launch-dashboard/.runner-host.pid'), 'utf8').trim());
    cleanups.push(() => { try { process.kill(firstPid, 'SIGKILL'); } catch { /* already gone */ } });
    const before = JSON.parse(fs.readFileSync(f.runnerHostMarker, 'utf8').trim().split('\n').pop()!);
    expect(before.LANGFUSE_SECRET_KEY, 'precondition: the first daemon should hold no key').toBeFalsy();

    // The operator fills it in and re-runs the installer — the ONLY sanctioned repair path.
    fs.writeFileSync(path.join(f.dir, '.env'), 'LANGFUSE_SECRET_KEY=sk-filled-in-later\nLANGFUSE_PUBLIC_KEY=pk-filled-in-later\n');
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const secondPid = Number(fs.readFileSync(path.join(f.dir, 'launch-dashboard/.runner-host.pid'), 'utf8').trim());
    cleanups.push(() => { try { process.kill(secondPid, 'SIGKILL'); } catch { /* already gone */ } });

    const after = JSON.parse(fs.readFileSync(f.runnerHostMarker, 'utf8').trim().split('\n').pop()!);
    expect(after.LANGFUSE_SECRET_KEY,
      're-running install.sh left a daemon running with the credentials it started with — the installer cannot repair its own environment')
      .toBe('sk-filled-in-later');
    // ...and the stale process is genuinely gone, not merely superseded by a second one.
    let staleAlive = false;
    try { process.kill(firstPid, 0); staleAlive = true; } catch { staleAlive = false; }
    expect(staleAlive, 'the stale daemon is still running alongside the new one').toBe(false);
  });

  it('is idempotent — a second install.sh run does not spawn a second runner-host', async () => {
    const port = 18112;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const pidfile = path.join(f.dir, 'launch-dashboard/.runner-host.pid');
    const firstPid = fs.readFileSync(pidfile, 'utf8').trim();
    cleanups.push(() => { try { process.kill(Number(firstPid), 'SIGKILL'); } catch { /* already gone */ } });

    const r2 = await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r2.out, `did not report already running:\n${r2.out}`).toMatch(/already running/);
    const secondPid = fs.readFileSync(pidfile, 'utf8').trim();
    expect(secondPid, 'a second runner-host was spawned instead of reusing the first').toBe(firstPid);
    const markerLines = fs.readFileSync(f.runnerHostMarker, 'utf8').trim().split('\n').filter(Boolean);
    expect(markerLines.length, `runner-host.js was executed more than once:\n${markerLines.join(',')}`).toBe(1);
  });

  it('--uninstall stops it and removes the pidfile', async () => {
    const port = 18113;
    await serveHealth(port);
    const f = fixture({ port });
    await run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    const pidfile = path.join(f.dir, 'launch-dashboard/.runner-host.pid');
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    cleanups.push(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });

    const r = await run(f, ['--uninstall'], { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.out, `uninstall did not report stopping it:\n${r.out}`).toMatch(/stopped runner-host/);
    expect(fs.existsSync(pidfile), 'pidfile was not removed').toBe(false);

    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((res) => setTimeout(res, 50));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    expect(alive, 'the process was not actually killed by --uninstall').toBe(false);
  });
});
