/**
 * PODMAN COMPOSE MUST NOT NEED A DAEMON THAT NOTHING STARTS.
 *
 * THE LIVE FAILURE (2026-09-07, a clean `npx amsd-pipeline --dest … ` with
 * EPAM_CONTAINER_RUNTIME=podman): every stack failed at its first image, with
 *
 *   unable to get image 'clickhouse/clickhouse-server:24': failed to connect to the docker API
 *   at unix:///…/podman/podman.sock … no such file or directory
 *
 * and the install ended "✗ install incomplete" having created ZERO containers.
 *
 * WHY. `podman compose` is not an implementation — it is a wrapper that hands the file to an
 * EXTERNAL provider. Left to choose, podman picks docker-compose, which speaks the Docker API
 * over a daemon socket. Rootless podman starts no such socket, and neither does this installer,
 * so the provider cannot pull anything. podman-compose drives the podman CLI directly and needs
 * no daemon at all.
 *
 * The operator's own choice always wins: someone who has a socket and prefers docker-compose sets
 * PODMAN_COMPOSE_PROVIDER themselves, and this must not overwrite it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * Runs the REAL container_compose with a stub runtime on PATH that prints the provider it was
 * given. Asserting on what the runtime RECEIVED — the receiving end — not on what the script says.
 */
function composeEnv(runtime: string, preset?: string): string {
  const bin = tmp('bin-');
  const stub = join(bin, runtime);
  writeFileSync(stub, '#!/usr/bin/env bash\necho "PROVIDER=${PODMAN_COMPOSE_PROVIDER-<unset>}"\n');
  chmodSync(stub, 0o755);

  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export EPAM_CONTAINER_RUNTIME=${runtime}`,
    preset ? `export PODMAN_COMPOSE_PROVIDER=${preset}` : '',
    `. ${JSON.stringify(LIB)}`,
    'container_compose -f /dev/null up -d',
  ].join('\n'));
  try {
    return execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); }
}

describe('compose under podman', () => {
  it('uses a provider that needs no daemon socket', () => {
    expect(composeEnv('podman'),
      'podman compose was left to pick its own provider — it picks docker-compose, which needs a '
      + 'Docker API socket nothing starts, and every image pull fails')
      .toContain('PROVIDER=podman-compose');
  });

  it("never overrides an operator's own choice", () => {
    expect(composeEnv('podman', 'docker-compose'),
      'the operator set PODMAN_COMPOSE_PROVIDER and it was overwritten')
      .toContain('PROVIDER=docker-compose');
  });

  it('leaves docker alone — it has a daemon and needs no provider steering', () => {
    expect(composeEnv('docker'), 'a podman-only setting leaked into the docker path')
      .toContain('PROVIDER=<unset>');
  });
});
