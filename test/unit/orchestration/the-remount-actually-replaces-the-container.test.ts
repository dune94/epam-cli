/**
 * THE REMOUNT REPLACES THE CONTAINER — it does not merely restart it.
 *
 * pre-run-reset.sh writes docker-compose.observability.override.yml with THIS run's /prd-dir and
 * /logs-dir, then brings agent-monitor up with --force-recreate. Docker compose honours that flag
 * and rebuilds the container with the new volume set. podman-compose does NOT: it restarts the
 * existing container, which keeps the volumes it was created with, so the override is written,
 * reported as applied, and silently has no effect.
 *
 * Live 2026-09-08, pipeline-tests-41:
 *
 *   override written           08:28
 *   agent-monitor created      08:23:34   <- install time, before the override existed
 *   agent-monitor started      08:28      <- merely restarted
 *   mounts: agents, nginx confs, njs, live   <- no /logs-dir, no /prd-dir
 *
 * pre-run-reset printed "✓ agent-monitor restarted → /logs-dir = ..." while the container had no
 * such mount, and the run then failed pre-flight on a /logs path nginx could not serve. The same
 * class the file's own comment already records for nginx.conf ("without --force-recreate the
 * container keeps serving the nginx.conf it started with") -- one runtime down.
 *
 * So the service is REMOVED first, then created. The seam is driven with a fake compose recorder;
 * what is asserted is the ORDER of the commands actually issued, because that order is the fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../');
const RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function remountUnder(runtime: string) {
  const src = readFileSync(RESET, 'utf8');
  const start = src.indexOf('_obs_runtime_lib() {');
  expect(start, 'the runtime helpers moved').toBeGreaterThan(-1);
  const guard = src.indexOf('if [ "${EPAM_SKIP_CONTAINER_RESTART:-0}" = "1" ]; then', start);
  const end = src.indexOf('\nfi\n', guard) + 4;
  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'replace-')); dirs.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.txt');
  for (const rt of ['docker', 'podman']) {
    writeFileSync(join(bin, rt), `#!/usr/bin/env bash\nprintf '${rt} %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(join(bin, rt), 0o755);
  }
  writeFileSync(join(bin, 'podman-compose'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'podman-compose'), 0o755);

  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'info(){ printf "INFO %s\\n" "$*"; }', 'success(){ printf "OK %s\\n" "$*"; }',
    `COMPOSE_BASE=${JSON.stringify(join(dir, 'base.yml'))}`,
    `COMPOSE_OVERRIDE=${JSON.stringify(join(dir, 'override.yml'))}`,
    'OBS_PROJECT=testproj', 'PRD_PRESENT=1',
    `PRD_DIR=${JSON.stringify(dir)}`, 'PRD_BASENAME=prd.json', `LOG_DIR=${JSON.stringify(dir)}`,
    `INSTALLER_LIB=${JSON.stringify(join(REPO_ROOT, 'orchestrations-installer/lib/container-runtime.sh'))}`,
    block,
  ].join('\n'));
  writeFileSync(join(dir, 'base.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'override.yml'), 'services: {}\n');

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EPAM_CONTAINER_RUNTIME: runtime },
  });
  return { out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

describe('the remount actually replaces the container', () => {
  for (const rt of ['podman', 'docker']) {
    it(`${rt}: the service is REMOVED before it is created, so the override applies`, () => {
      const r = remountUnder(rt);
      const lines = r.calls.trim().split('\n').filter(Boolean);
      expect(lines.length, 'nothing was invoked — this proves nothing').toBeGreaterThan(0);
      const rmAt = lines.findIndex((l) => /\brm\b/.test(l));
      const upAt = lines.findIndex((l) => /\bup\b/.test(l));
      expect(rmAt, 'the container is never removed, so podman-compose restarts the existing one '
        + 'and it keeps the volumes it was created with — the override is silently inert')
        .toBeGreaterThan(-1);
      expect(upAt, 'the service is never brought up').toBeGreaterThan(-1);
      expect(rmAt, 'removal must come BEFORE creation, or the old container survives')
        .toBeLessThan(upAt);
    });
  }

  it('it still reports the mount it established', () => {
    expect(remountUnder('podman').out).toMatch(/agent-monitor restarted|remount/i);
  });
});
