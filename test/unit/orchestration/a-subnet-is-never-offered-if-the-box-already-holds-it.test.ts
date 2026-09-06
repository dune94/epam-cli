/**
 * A SUBNET ALREADY ON THE BOX IS NEVER OFFERED.
 *
 * Live 2026-09-06, installing v1.50 into pipeline-tests-28: the observability stack came up on the
 * first candidate and the launch dashboard then exhausted the SAME five candidates — one held by
 * its own sibling, four by installs 298423, 348644 and 944875 that were already running. The
 * install reported incomplete, twice, and the second attempt failed for exactly the reason the
 * first did.
 *
 * TWO DEFECTS IN ONE FUNCTION. It offered five candidates out of a ten-wide window, so six
 * coexisting stacks exhaust it by arithmetic; and it never asked the daemon what was already
 * allocated, so it kept proposing subnets that could not possibly work. The retry loop above it
 * was doing the only checking, one failed `compose up` at a time.
 *
 * THE FIX IS TO ASK. Docker knows what it has allocated, the answer is free to obtain, and a
 * candidate that is already held is not a candidate. Determinism is kept — the same seed still
 * starts in the same place — because an install that moves its network every time it is repaired
 * is its own kind of defect.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIB = resolve(__dirname, '../../../orchestrations-installer/lib/isolated-compose-identity.sh');

/**
 * Runs the real function with a stubbed `docker` reporting a chosen set of allocated subnets.
 * `allocated: null` means docker is not on PATH at all.
 */
function candidates(seed: string, allocated: string[] | null): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'subnet-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    if (allocated !== null) {
      // Answers `network inspect`-style queries the way the daemon does, and nothing else.
      const docker = join(bin, 'docker');
      writeFileSync(docker, `#!/usr/bin/env bash\nprintf '%s\\n' ${allocated.map((s) => `'${s}'`).join(' ') || "''"}\nexit 0\n`);
      chmodSync(docker, 0o755);
    }
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; isolated_subnet_candidates "$1"`, '--', seed], {
      encoding: 'utf8',
      timeout: 30_000,
      // A MINIMAL PATH, so the real docker on this machine cannot answer for the stub and make
      // the result depend on whatever the developer happens to be running.
      env: { PATH: allocated === null ? '/usr/bin:/bin' : `${bin}:/usr/bin:/bin`, HOME: process.env.HOME || '' },
    });
    return (r.stdout || '').trim().split('\n').filter(Boolean);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SEED = '/home/someone/projects/ai/pipeline-tests-28';

describe('the subnet candidates', () => {
  it('GUARD: produces candidates at all, in /16 form', () => {
    const c = candidates(SEED, []);
    expect(c.length, 'no candidates — every assertion below would be vacuous').toBeGreaterThan(0);
    for (const s of c) expect(s).toMatch(/^\d+\.\d+\.0\.0\/16$/);
  });

  it('offers enough of them that six coexisting stacks cannot exhaust the list', () => {
    // The live failure was arithmetic: five candidates, six stacks. This box held seven networks.
    //
    // COUNTED PER SPACE, not in total. A total would be satisfied by the 10.x reserve alone, so a
    // narrowed 172 window — the exact defect being fixed — would pass while every install crowded
    // into a few subnets and then spilled into the reserve. The primary space must be whole.
    const c = candidates(SEED, []);
    const primary = c.filter((s) => s.startsWith('172.'));
    const reserve = c.filter((s) => s.startsWith('10.'));
    expect(primary.length,
      'the primary 172.16-172.31 space is not offered whole — installs crowd and then exhaust it')
      .toBe(16);
    expect(reserve.length, 'no deep reserve — exhausting the primary space would fail the install')
      .toBeGreaterThanOrEqual(16);
    expect(new Set(c).size, 'a candidate was offered twice').toBe(c.length);
  });

  it('NEVER offers a subnet the daemon already holds', () => {
    const held = ['172.22.0.0/16', '172.23.0.0/16', '172.24.0.0/16', '172.25.0.0/16', '172.26.0.0/16'];
    const c = candidates(SEED, held);
    for (const s of held) {
      expect(c, `${s} is already allocated on this box and was offered anyway`).not.toContain(s);
    }
    expect(c.length, 'excluding the held subnets left nothing to try').toBeGreaterThan(0);
  });

  it('is DETERMINISTIC — the same seed and the same box give the same answer', () => {
    expect(candidates(SEED, ['172.22.0.0/16'])).toEqual(candidates(SEED, ['172.22.0.0/16']));
  });

  it('different installs do not all start in the same place', () => {
    const a = candidates('/home/someone/projects/ai/pipeline-tests-28', []);
    const b = candidates('/home/someone/projects/ai/pipeline-tests-29', []);
    expect(a[0], 'two installs would race for one subnet before either could start').not.toBe(b[0]);
  });

  it('WITHOUT DOCKER it still answers — the installer must not be blocked by the check', () => {
    // The check is an optimisation over the retry loop, never a prerequisite. If the daemon cannot
    // be asked, offering the full list is exactly today's behaviour and the loop still sorts it.
    const c = candidates(SEED, null);
    expect(c.length, 'no docker on PATH produced no candidates — the installer cannot even try')
      .toBeGreaterThanOrEqual(16);
  });
});
