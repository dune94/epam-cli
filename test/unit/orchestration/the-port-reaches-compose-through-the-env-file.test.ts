/**
 * THE CHOSEN PORT MUST REACH COMPOSE, AND AN EXPORTED VARIABLE DOES NOT ALWAYS DO IT.
 *
 * THE LIVE FAILURE (2026-09-07, clean-machine podman install). The launch dashboard came up
 * healthy on 8099 while the installer health-checked 8109 and declared the install incomplete:
 *
 *   ✗ containers started but never answered healthy at http://localhost:8109/api/health
 *   (containers: launch-api / launch-ui, Up, 0.0.0.0:8099->80/tcp)
 *
 * CAUSE. The retry exports LAUNCH_UI_PORT=8109 and calls compose. Docker Compose lets the shell
 * environment win over the project's .env file; PODMAN-COMPOSE DOES NOT — `podman compose config`
 * with LAUNCH_UI_PORT=8109 exported still resolves `ports: 8099:80` from launch-dashboard/.env.
 * So every retry republished the SAME port while the installer walked 8109, 8119, … and could
 * never match. The stack was healthy the whole time.
 *
 * Writing the chosen port into the .env compose actually reads is correct on BOTH runtimes —
 * docker reads that file too — and removes the precedence difference instead of depending on it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL = join(process.cwd(), 'orchestrations-installer', 'install.sh');
const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe('the launch port', () => {
  it('is WRITTEN INTO the .env compose reads, not only exported', () => {
    const src = readFileSync(INSTALL, 'utf8');
    const loop = src.slice(src.indexOf('for _LD_SUBNET in'), src.indexOf('if [ "$_LD_UP" = "1" ]'));
    expect(loop, 'the retry only exports LAUNCH_UI_PORT — podman-compose takes the .env value '
      + 'instead, so every attempt republishes the same port while the health check walks away '
      + 'from it').toMatch(/reconcile_env_endpoint[^\n]*LAUNCH_UI_PORT/);
  });

  it('the write lands in launch-dashboard/.env, which is the file compose substitutes from', () => {
    const src = readFileSync(INSTALL, 'utf8');
    const loop = src.slice(src.indexOf('for _LD_SUBNET in'), src.indexOf('if [ "$_LD_UP" = "1" ]'));
    const m = loop.match(/reconcile_env_endpoint\s+"([^"]+)"\s+LAUNCH_UI_PORT/);
    expect(m, 'no reconciliation call found').toBeTruthy();
    expect(m![1], 'written to the wrong file — compose substitutes from the project directory .env')
      .toMatch(/LAUNCH_DIR.*\.env|launch-dashboard\/\.env/);
  });

  it('reconcile_env_endpoint really replaces a port line', () => {
    // The helper is shared with LANGFUSE_BASE_URL; prove it on the shape used here.
    const dir = tmp('env-');
    const f = join(dir, '.env');
    writeFileSync(f, 'LAUNCH_PASSWORD=x\nLAUNCH_UI_PORT=8099\n');
    const drive = join(tmp('drv-'), 'd.sh');
    writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
      'export EPAM_CONTAINER_RUNTIME=podman',
      `. ${JSON.stringify(LIB)}`,
      `reconcile_env_endpoint ${JSON.stringify(f)} LAUNCH_UI_PORT 8109`].join('\n'));
    execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 });
    const after = readFileSync(f, 'utf8');
    expect(after, 'the port compose reads was not updated').toContain('LAUNCH_UI_PORT=8109');
    expect(after, 'the stale port survived').not.toContain('LAUNCH_UI_PORT=8099');
    expect(after, 'an unrelated setting was disturbed').toContain('LAUNCH_PASSWORD=x');
  });
});
