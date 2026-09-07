/**
 * A BIND MOUNT THE CONTAINER CANNOT WRITE IS NOT A BIND MOUNT.
 *
 * install.sh already pre-creates ./data and ./spool as the host user, and its comment names the
 * exact trap it was fixed for: a bind mount auto-created by the engine is owned by root, and
 * launch-api (running as ${LAUNCH_UID:-1000}) then cannot write its SQLite file.
 *
 * That fix is correct FOR DOCKER, where host uid 1000 IS container uid 1000. Under ROOTLESS
 * PODMAN it is not: the host user maps to uid 0 INSIDE the user namespace, and the container's
 * 1000 maps to a subuid that owns nothing. The same mkdir therefore reproduces the very failure
 * the comment describes — live: "unable to open database file", launch-api crash-looping, and
 * nginx reporting "host not found in upstream" as the downstream symptom.
 *
 * So ownership has to be expressed in the CONTAINER's terms when the runtime is podman, and left
 * alone when it is docker. Asserting on what the runtime was actually asked to do.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Records what the runtime binary was invoked with, so the RECEIVER is what gets asserted. */
function run(runtime: string, uid?: string): string {
  const bin = tmp('bin-');
  const rec = join(bin, 'calls.txt');
  const stub = join(bin, runtime);
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(rec)}\n`);
  chmodSync(stub, 0o755);
  const target = tmp('mnt-');

  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export EPAM_CONTAINER_RUNTIME=${runtime}`,
    uid ? `export LAUNCH_UID=${uid}` : '',
    `. ${JSON.stringify(LIB)}`,
    `ensure_bind_mount_ownership ${JSON.stringify(target)}`,
  ].join('\n'));
  execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 });
  return existsSync(rec) ? readFileSync(rec, 'utf8').trim() : '';
}

describe('a bind mount under rootless podman', () => {
  it('is made writable by the uid the container actually runs as', () => {
    const calls = run('podman');
    expect(calls, 'podman was never asked to remap the mount into the user namespace — the '
      + "container's uid owns nothing and SQLite cannot create its file").toContain('unshare');
    expect(calls, 'the remap did not use chown').toContain('chown');
    expect(calls, "the container's default uid 1000 was not used").toMatch(/1000:1000/);
  });

  it('honours a project that runs the container as a different uid', () => {
    expect(run('podman', '1500'), 'LAUNCH_UID was ignored — a project running as another uid '
      + 'still cannot write').toMatch(/1500:1500/);
  });

  it('does nothing under docker, where the host uid IS the container uid', () => {
    expect(run('docker'), 'a podman-only remap ran under docker and changed ownership that was '
      + 'already correct').toBe('');
  });
});
