/**
 * PODMAN NEEDS THE RUNTIME DIRECTORY THAT ACTUALLY HAS SYSTEMD IN IT.
 *
 * Podman starts aardvark-dns (container DNS) and healthchecks as TRANSIENT SYSTEMD UNITS, found
 * through $XDG_RUNTIME_DIR. On this machine `fnm` (a Node version manager) exports
 * XDG_RUNTIME_DIR=/tmp/fnm-runtime, which has no systemd/ in it. Podman then says
 *
 *   unable to get systemd connection to add healthchecks: lstat /tmp/fnm-runtime/systemd:
 *   no such file or directory
 *
 * once, at debug level, and carries on WITHOUT DNS. Live consequences, all one cause:
 *   - grafana:  lookup grafana.com on 172.22.0.1:53: connection refused
 *   - langfuse: Can't reach database server at `postgres:5432`
 *   - nginx:    host not found in upstream "launch-api"
 *
 * The session's real runtime dir is /run/user/<uid>, and it does have systemd/. So when the
 * inherited value is not a usable runtime dir and the real one is, the installer uses the real
 * one for its own container calls. It never invents a path, never overrides a value that works,
 * and touches nothing when the runtime is docker.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Reports the XDG_RUNTIME_DIR the runtime binary was actually invoked with. */
function runtimeDirSeen(opts: { runtime: string; inherited: string; real: string }): string {
  const bin = tmp('bin-');
  const stub = join(bin, opts.runtime);
  writeFileSync(stub, '#!/usr/bin/env bash\necho "XDG=${XDG_RUNTIME_DIR-<unset>}"\n');
  chmodSync(stub, 0o755);

  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export EPAM_CONTAINER_RUNTIME=${opts.runtime}`,
    `export XDG_RUNTIME_DIR=${JSON.stringify(opts.inherited)}`,
    // the "real" one the code should discover for itself
    `export EPAM_RUNTIME_DIR_PROBE=${JSON.stringify(opts.real)}`,
    `. ${JSON.stringify(LIB)}`,
    'container_compose -f /dev/null up -d',
  ].join('\n'));
  try {
    return execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); }
}

function withSystemd(): string { const d = tmp('rt-'); mkdirSync(join(d, 'systemd')); return d; }

describe('podman runtime directory', () => {
  it('is corrected when the inherited one has no systemd — the cause of every DNS failure', () => {
    const real = withSystemd();
    const broken = tmp('fnm-');            // no systemd/ inside, exactly like /tmp/fnm-runtime
    expect(runtimeDirSeen({ runtime: 'podman', inherited: broken, real }),
      'podman was handed a runtime dir with no systemd in it — it starts no DNS server and no '
      + 'healthchecks, and every name lookup between containers fails')
      .toContain(`XDG=${real}`);
  });

  it('leaves a WORKING inherited runtime dir alone', () => {
    const good = withSystemd();
    const real = withSystemd();
    expect(runtimeDirSeen({ runtime: 'podman', inherited: good, real }),
      'a usable runtime dir was replaced anyway').toContain(`XDG=${good}`);
  });

  it('does nothing for docker, which has a daemon and no systemd units', () => {
    const broken = tmp('fnm-');
    expect(runtimeDirSeen({ runtime: 'docker', inherited: broken, real: withSystemd() }),
      'a podman-only correction changed docker\'s environment').toContain(`XDG=${broken}`);
  });
});
