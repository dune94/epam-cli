/**
 * A SHARED BIND MOUNT IS WRITABLE FROM BOTH SIDES — PROVEN ON REAL DIRECTORIES.
 *
 * ./spool is the boundary between the containerised API and runner-host.js, which runs ON THE
 * HOST. The compose file states it: "a host process must own it."
 *
 * TWO DEFECTS THIS ENCODES, both mine, both found by an install rather than a test:
 *
 *  1. The podman ownership remap that is correct for ./data (a container-private database) was
 *     applied to ./spool as well. The host runner then died on
 *         EACCES: mkdir '.../launch-dashboard/spool/requests'
 *     and the install reported "runner-host failed to start".
 *
 *  2. The correction — widening the mode — could not work on a directory the host user NO LONGER
 *     OWNED after (1). `chmod` returned EPERM, the error was swallowed, and the next install
 *     failed identically. Ownership must be handed BACK before the mode is widened.
 *
 * WHY THIS RUNS REAL PODMAN AND NOT A STUB: the whole defect lives in rootless uid mapping —
 * `podman unshare chown 1000:1000` makes a directory owned by a SUBUID the host user cannot even
 * chmod. A stubbed podman would have reported success for the exact operation that fails. It
 * needs no install, no containers and no tokens: two fixture directories and a few seconds.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const HAVE_PODMAN = spawnSync('podman', ['--version'], { encoding: 'utf8' }).status === 0;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    // give ownership back before deleting, or rmSync hits the same EPERM this test is about
    spawnSync('podman', ['unshare', 'chown', '-R', '0:0', d], { encoding: 'utf8' });
    rmSync(d, { recursive: true, force: true });
  }
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Runs one of the real functions from the shipped lib against a real directory. */
function apply(fn: string, dir: string, runtime = 'podman'): string {
  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    `export EPAM_CONTAINER_RUNTIME=${runtime}`,
    `. ${JSON.stringify(LIB)}`,
    `${fn} ${JSON.stringify(dir)}`,
    'echo "rc=$?"',
  ].join('\n'));
  return execFileSync('bash', [drive], { encoding: 'utf8', timeout: 60_000 });
}

/** True when the HOST user can create a file here — what runner-host.js needs. */
function hostCanWrite(dir: string): boolean {
  try { writeFileSync(join(dir, `.probe-${Date.now()}`), 'x'); return true; } catch { return false; }
}

/** The uid the directory has INSIDE the container's user namespace. 0 = the host user. */
function nsUid(dir: string): string {
  const r = spawnSync('podman', ['unshare', 'stat', '-c', '%u', dir], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

describe.skipIf(!HAVE_PODMAN)('a shared bind mount under rootless podman', () => {
  it('RECOVERS a directory already taken by the container, and the host can write it again', () => {
    // Exactly the state install #1 left behind: owned by the container's mapped uid.
    const spool = tmp('spool-');
    spawnSync('podman', ['unshare', 'chown', '-R', '1000:1000', spool], { encoding: 'utf8' });
    expect(hostCanWrite(spool), 'fixture is not in the broken state the test needs').toBe(false);

    apply('ensure_shared_bind_mount', spool);

    expect(hostCanWrite(spool), 'the host still cannot write the spool — runner-host.js dies on '
      + 'EACCES mkdir spool/requests and the install reports "runner-host failed to start"')
      .toBe(true);
  });

  it('leaves it writable by the CONTAINER too — both sides, or it is not shared', () => {
    const spool = tmp('spool-');
    spawnSync('podman', ['unshare', 'chown', '-R', '1000:1000', spool], { encoding: 'utf8' });
    apply('ensure_shared_bind_mount', spool);

    expect(nsUid(spool), 'ownership was not returned to the host user').toBe('0');
    const mode = statSync(spool).mode & 0o777;
    expect(mode & 0o002, `the container's mapped uid owns nothing here, so without other-write it `
      + `cannot write (mode ${mode.toString(8)})`).toBe(0o002);
  });

  it('works on a fresh host-owned directory, the ordinary first install', () => {
    const spool = tmp('spool-');
    mkdirSync(join(spool, 'requests'), { recursive: true });
    apply('ensure_shared_bind_mount', spool);
    expect(hostCanWrite(spool)).toBe(true);
    expect(hostCanWrite(join(spool, 'requests')), 'subdirectories were missed').toBe(true);
    expect(statSync(join(spool, 'requests')).mode & 0o002, 'subdirectory not shared').toBe(0o002);
  });

  it('REPORTS failure instead of swallowing it — a silent chmod is how this recurred', () => {
    const out = apply('ensure_shared_bind_mount', '/proc/1/nonexistent-shared-mount');
    expect(out, 'a directory that cannot be made shared returned success anyway')
      .toMatch(/rc=[1-9]|could not/);
  });

  it('a CONTAINER-PRIVATE mount is still handed to the container', () => {
    // ./data is the API's own SQLite database; the container must own it outright.
    const data = tmp('data-');
    apply('ensure_bind_mount_ownership', data);
    expect(nsUid(data), 'the container cannot open its database').toBe('1000');
  });
});

describe('docker is untouched by either function', () => {
  it('neither changes ownership nor mode under docker', () => {
    const d = tmp('docker-');
    const before = statSync(d).mode & 0o777;
    apply('ensure_shared_bind_mount', d, 'docker');
    apply('ensure_bind_mount_ownership', d, 'docker');
    expect(statSync(d).mode & 0o777, 'a podman-only fix changed a docker install, where the host '
      + 'uid IS the container uid and nothing needed changing').toBe(before);
  });
});
