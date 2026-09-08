/**
 * THE SUBNET PROBE MUST ASK THE RUNTIME THAT WILL CREATE THE NETWORK.
 *
 * WHY THIS EXISTS. isolated_subnet_candidates picks the /16 an install's compose stacks run on.
 * It asked `docker` literally — for the held-subnet listing AND for the create/remove probe that
 * the file's own comment calls the only authoritative answer ("THE LISTING IS NOT THE AUTHORITY;
 * THE DAEMON IS"). On a PODMAN install of a box that also has docker installed, that proves a
 * subnet free in DOCKER's network namespace, which says nothing whatever about podman's.
 *
 * Live 2026-09-08, installing pipeline-tests-37 with EPAM_CONTAINER_RUNTIME=podman:
 *
 *   podman network create --subnet 172.28.0.0/16 ... returned non-zero exit status 125
 *   Error: subnet 172.28.0.0/16 is already used on the host or by another config
 *
 * 172.28.0.0/16 was free in docker and held by podman, by a DIFFERENT install's launch network.
 * The obs stack never came up. install.sh:680 already carries this same fix for its own probe
 * ("THE PROBE ASKS THE RESOLVED RUNTIME. It said `docker` literally"); this file was missed, so
 * the defect survived where it does the most damage — choosing the address space itself.
 *
 * The seam is driven with a FAKE runtime on PATH that records how it was called, so what is
 * asserted is the command actually executed, not the text of the function.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const LIB = join(__dirname, '../../../orchestrations-installer/lib/isolated-compose-identity.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Runs isolated_subnet_candidates with BOTH `docker` and `podman` on PATH as recorders.
 * Docker answers "free" to everything; podman answers "already used" for the first /16 it is
 * offered, exactly as the live failure did.
 */
function candidatesUnder(runtime: string) {
  const dir = mkdtempSync(join(tmpdir(), 'subnet-probe-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.txt');

  // docker: every probe succeeds — the wrong answer, and the one that shipped.
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nprintf 'docker %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  // podman: refuses 172.28.0.0/16, like the live box.
  writeFileSync(join(bin, 'podman'), `#!/usr/bin/env bash
printf 'podman %s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in *"172.28.0.0/16"*) echo "Error: subnet 172.28.0.0/16 is already used" >&2; exit 125 ;; esac
exit 0
`);
  for (const f of ['docker', 'podman']) chmodSync(join(bin, f), 0o755);

  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; EPAM_CONTAINER_RUNTIME=${runtime} isolated_subnet_candidates /some/install`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 });

  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { out: r.stdout || '', err: r.stderr || '', status: r.status, calls };
}

describe('the subnet probe asks the runtime that will use it', () => {
  it('GUARD: the seam produces candidates at all', () => {
    const r = candidatesUnder('docker');
    expect(r.status, r.err).toBe(0);
    expect(r.out.trim().split('\n').filter(Boolean).length,
      'no candidate subnets were offered, so every assertion below is vacuous')
      .toBeGreaterThan(0);
  });

  it('UNDER PODMAN IT PROBES PODMAN — not whatever docker happens to think', () => {
    const r = candidatesUnder('podman');
    expect(r.calls, 'the probe never invoked podman at all, so on a podman install it proves a '
      + 'subnet free in a network namespace nothing will use').toMatch(/^podman /m);
    expect(r.calls, 'the probe asked docker on a podman install — docker\'s networks are a '
      + 'different namespace, so a "free" answer is meaningless')
      .not.toMatch(/^docker /m);
  });

  it('AND IT DOES NOT OFFER A SUBNET PODMAN REFUSES — the live failure', () => {
    const r = candidatesUnder('podman');
    expect(r.out, 'offered 172.28.0.0/16, which podman refuses with exit 125 — the obs stack '
      + 'then fails to create its network and the install has no observability')
      .not.toContain('172.28.0.0/16');
    expect(r.out.trim().split('\n').filter(Boolean).length,
      'refusing one subnet emptied the candidate list — an install with nothing to try')
      .toBeGreaterThan(0);
  });

  it('UNDER DOCKER IT STILL PROBES DOCKER — the existing path is unchanged', () => {
    const r = candidatesUnder('docker');
    expect(r.calls).toMatch(/^docker /m);
    expect(r.calls).not.toMatch(/^podman /m);
  });
});
