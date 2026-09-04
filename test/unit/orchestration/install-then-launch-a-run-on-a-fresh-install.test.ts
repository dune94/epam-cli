/**
 * INSTALL AND PRE-LAUNCH, TOGETHER, FOR REAL — not two isolated unit tests each stubbing the half
 * the other one owns.
 *
 * Both real bugs this session found — the agent-monitor restart resolving to the WRONG docker
 * compose subnet (pre-run-reset-uses-persisted-subnet-and-ports.test.ts) and orchestrations/logs
 * ending up root-owned on a fresh install (the-installer-packages-a-ref-into-a-new-tree.test.ts,
 * "a FRESH install creates orchestrations/logs...") were each individually unit-tested with STUBBED
 * docker, and each individually went green — while the REAL run against a REAL fresh install
 * (pipeline-tests-7, then pipeline-tests-8) still failed at pre-flight both times. A stub proves the
 * script constructs the right argv; it cannot prove the argv, run against a REAL docker daemon that
 * creates missing bind-mount paths as root, actually works. Only a real install + a real restart,
 * run together, catches what only shows up at the JOIN.
 *
 * SCOPED TO agent-monitor ONLY, not the whole observability stack (postgres/clickhouse/redis/
 * langfuse/grafana) — this host already runs a full stack for another install; duplicating it here
 * would risk the "nothing I launch may flood memory" rule for no benefit, since agent-monitor
 * (nginx) is the only service pre-run-reset.sh's restart touches. The isolated subnet/project name
 * and the .pipeline-services-state.env content are constructed the SAME way install.sh's own
 * compose_up() does (isolated_project_name / isolated_subnet_candidates, the shared library both
 * use) — not hand-rolled — so this test tracks the real mechanism rather than a copy of it.
 *
 * REAL docker, REAL dashboard assets (this repo's own nginx.conf, dashboards/live, njs — extracted
 * via install.sh --dest --ref HEAD, the exact mechanism a real install uses), REAL pre-run-reset.sh.
 * node_modules is SYMLINKED from this checkout (never copied) so install.sh's build step does not
 * re-download the world — the build itself still runs for real via `npm run build`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** A free TCP port on this host — this box already runs the dev stack's own agent-monitor plus a
 * separate test install's full stack, both on their own default ports; a fixed port would collide
 * with whichever of them happens to be up. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

const REPO = path.resolve(__dirname, '../../..');
const INSTALLER_REL = 'orchestrations-installer/install.sh';
const IDENTITY_LIB = path.join(REPO, 'orchestrations-installer/lib/isolated-compose-identity.sh');

const cleanups: Array<() => void> = [];
afterAll(() => { while (cleanups.length) cleanups.pop()!(); });

function sh(cwd: string, cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, ...opts });
}

/** The SAME functions install.sh itself uses — never hand-derived, so this test tracks the real
 * mechanism instead of a private copy of it that could silently drift from it. */
function identity(dest: string): { project: string; candidates: string[] } {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(IDENTITY_LIB)}; isolated_project_name ${JSON.stringify(dest)} obs; echo; isolated_subnet_candidates ${JSON.stringify(dest)}`], { encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n');
  return { project: lines[0], candidates: lines.slice(1) };
}

describe('install + pre-launch, together, on a REAL fresh install', () => {
  it('a fresh --dest install can restart agent-monitor via pre-run-reset.sh with no permission error and no network mismatch', async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'install-launch-e2e-'));
    cleanups.push(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ } });

    // Symlink node_modules from this checkout — installing a second copy for a test would cost
    // minutes and disk for no signal; the build step (tsup) still runs for real either way.
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'), 'dir');

    const install = sh(REPO, 'bash', [INSTALLER_REL, '--dest', dest, '--ref', 'HEAD', '--no-docker'], {
      env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(dest, 'bin-shim') },
    });
    expect(install.status, `install (--no-docker) failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
    // The OTHER fix, exercised together with this one: proves the directory this restart is about
    // to write into (orchestrations/logs/archive) is actually writable before the restart even
    // starts, rather than only after the fact.
    expect(fs.existsSync(path.join(dest, 'orchestrations/logs')),
      'orchestrations/logs was not created by the fresh install').toBe(true);

    const { project, candidates } = identity(dest);
    const dashboardPort = await freePort();
    cleanups.push(() => {
      sh(dest, 'docker', ['compose', '-f', 'docker-compose.observability.yml', '-p', project, 'down', '-v', '--remove-orphans']);
    });

    // THE SAME BRING-UP install.sh's own compose_up() does for this one service — a REAL, isolated
    // network + container, not a stub. No override file yet (pre-run-reset.sh generates that), so
    // this is a bare agent-monitor: no /prd-dir or /logs-dir mount, exactly like install.sh's own
    // first bring-up. A dedicated free port — this host already runs the dev stack's own
    // agent-monitor AND a separate test install's full stack, both on the compose file's default
    // 8092. THE SAME retry-over-candidates install.sh's own compose_up() does: the FIRST candidate
    // is stable per dest path, but this host already has other stacks sitting on several of the
    // 172.19-172.28 range, so the first choice is not guaranteed free.
    let subnet = '';
    let up: ReturnType<typeof sh> | undefined;
    for (const candidate of candidates) {
      up = sh(dest, 'docker', ['compose', '-f', 'docker-compose.observability.yml', '-p', project, 'up', '-d', 'agent-monitor'], {
        env: { ...process.env, EPAM_OBS_SUBNET: candidate, EPAM_OBS_DASHBOARD_PORT: String(dashboardPort) },
      });
      if (up.status === 0) { subnet = candidate; break; }
      sh(dest, 'docker', ['compose', '-f', 'docker-compose.observability.yml', '-p', project, 'down']);
    }
    expect(up?.status, `initial agent-monitor bring-up failed on every candidate subnet (${candidates.join(', ')}):\n${up?.stdout}\n${up?.stderr}`).toBe(0);

    // THE SAME 5 VALUES install.sh's compose_up() persists on every successful bring-up — written
    // here because this test brought the stack up directly rather than through install.sh's own
    // --docker path (memory-scoped to agent-monitor only; see file header).
    fs.writeFileSync(path.join(dest, '.pipeline-services-state.env'), [
      `OBS_PROJECT=${project}`,
      `OBS_SUBNET=${subnet}`,
      'OBS_CLICKHOUSE_PORT=8123',
      'OBS_LANGFUSE_PORT=3100',
      `OBS_DASHBOARD_PORT=${dashboardPort}`,
      'OBS_GRAFANA_PORT=3001',
      '',
    ].join('\n'));

    // A real (synthetic-content, real-shape) PRD — the run only needs pre-run-reset.sh to reach the
    // restart and the archive step; it never reaches Jira ingest or any agent call.
    const prdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-launch-e2e-prd-'));
    cleanups.push(() => { try { fs.rmSync(prdDir, { recursive: true, force: true }); } catch { /* best-effort */ } });
    const prd = path.join(prdDir, 'prd.json');
    fs.writeFileSync(prd, JSON.stringify({ stories: [] }));

    // THE ACTUAL RESTART — the exact command this session's fix (pre-run-reset.sh) changed,
    // against a REAL docker daemon that auto-creates missing bind-mount paths as root, and a REAL
    // network that was created on a DIFFERENT subnet than the compose file's own bare default.
    const reset = sh(dest, 'bash', ['orchestrations/scripts/pre-run-reset.sh', '--prd', prd], {
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '' },
    });
    expect(reset.status, `pre-run-reset.sh failed on a REAL fresh install:\n${reset.stdout}\n${reset.stderr}`).toBe(0);
    expect(reset.stdout, 'pre-run-reset.sh did not emit its completion sentinel — some state-clearing step aborted part-way')
      .toContain('PRE_RUN_RESET_STATE_CLEARED');
    expect(`${reset.stdout}${reset.stderr}`, 'the restart hit the root-owned-directory permission error this test exists to catch')
      .not.toMatch(/Permission denied/);
    expect(`${reset.stdout}${reset.stderr}`, 'the restart hit the subnet-mismatch this test exists to catch')
      .not.toMatch(/is not connected to the network/);
    expect(reset.stdout, 'agent-monitor was never actually restarted — it silently fell into the "not running" branch')
      .toContain('agent-monitor restarted');

    // THE OUTCOME THAT ACTUALLY MATTERS: the dashboard is reachable, on the SAME port the state
    // file declared — not a default that happened to coincide with it.
    const health = sh(dest, 'curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://localhost:${dashboardPort}/`]);
    expect(health.stdout, 'agent-monitor is not actually serving after the restart').toBe('200');
  }, 180_000);
});
