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
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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
      /**
       * A daemon that LISTS what it holds and REFUSES to create what it holds.
       *
       * Both halves matter. Docker does not reliably release the pool of a removed network, so a
       * subnet can be absent from `network ls` and still be ungrantable — asking only the listing
       * offers it, `compose up` fails at network creation, and compose then creates the containers
       * unattached and connects them afterwards WITHOUT service aliases. That is how a stack ends
       * up with DNS that resolves nothing while every container reports itself healthy.
       */
      const docker = join(bin, 'docker');
      const held = allocated.map((s) => `'${s}'`).join(' ') || "''";
      writeFileSync(docker, [
        '#!/usr/bin/env bash',
        'if [ "$1" = "network" ] && [ "$2" = "create" ]; then',
        `  for h in ${held}; do`,
        '    for a in "$@"; do [ "$a" = "$h" ] && { echo "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space" >&2; exit 1; }; done',
        '  done',
        '  exit 0',
        'fi',
        `printf '%s\\n' ${held}`,
        'exit 0',
      ].join('\n'));
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

describe('the two stacks of ONE install do not compete for one list', () => {
  /**
   * Live 2026-09-06, pipeline-tests-29: the observability stack and the launch dashboard were both
   * seeded with the bare $ROOT, so they were handed the SAME ordered candidates. The launch stack
   * ended up holding the subnet the observability stack wanted, and the observability stack then
   * failed its network create, retried onto another candidate, and came up with containers that
   * had NO network aliases at all — `getent hosts postgres` unresolved, so langfuse could never
   * reach its database however healthy postgres was.
   *
   * The mock stack already avoids this by seeding with "$ROOT-mock" (install.sh:750). The launch
   * dashboard was never given the same treatment.
   *
   * WHAT IS ASSERTED IS THE FIRST CHOICE, not whole-list disjointness. These are ordered
   * preferences over a shared space; two seeds must not RACE for the same first pick, and each
   * still walks the rest of the space as a fallback. Requiring the lists to be disjoint would
   * demand a partition the space cannot give, which is why an earlier attempt at that assertion
   * was withdrawn rather than shipped.
   */
  it('the launch stack does not want the same subnet the obs stack wants', () => {
    const root = '/home/someone/projects/ai/pipeline-tests-29';
    const obs = candidates(root, []);
    const launch = candidates(`${root}-launch`, []);
    const mock = candidates(`${root}-mock`, []);
    expect(obs[0], 'no candidates').toBeTruthy();
    expect(launch[0],
      'the launch dashboard races the observability stack for one subnet, and the loser retries '
      + 'onto a network whose containers come up with no aliases').not.toBe(obs[0]);
    expect(mock[0], 'the mock stack races one of them').not.toBe(obs[0]);
    expect(mock[0]).not.toBe(launch[0]);
  });
});

describe('each stack asks with its own seed', () => {
  /**
   * The generator hands different seeds different first choices — proven above. That is worth
   * nothing if the CALL SITES all pass the same seed, which is exactly what happened: the
   * observability stack and the launch dashboard both passed the bare $ROOT.
   *
   * This reads install.sh because the alternative is running a full install, and the property is
   * a wiring fact rather than a behaviour: three stacks, three distinct seeds. A fourth stack
   * added later with a copied line fails here.
   */
  it('no two stacks are seeded identically in install.sh', () => {
    const src = readFileSync(resolve(__dirname, '../../../orchestrations-installer/install.sh'), 'utf8');
    const seeds = [...src.matchAll(/isolated_subnet_candidates\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(seeds.length, 'no call sites found — this test is measuring nothing').toBeGreaterThanOrEqual(3);
    expect(new Set(seeds).size,
      `two stacks share a seed and will race for one subnet: ${seeds.join(', ')}`)
      .toBe(seeds.length);
  });
});

describe('a candidate the daemon will not grant is not a candidate', () => {
  /**
   * THE LISTING IS NOT THE AUTHORITY. Docker keeps the address pool of a network it has removed —
   * recorded on this box on 2026-09-04 and again on 2026-09-06 — so `network ls` can show a /16
   * free while `network create --subnet` on it fails "Pool overlaps with other one on this
   * address space".
   *
   * That is not a cosmetic difference. When compose cannot create the network it still creates the
   * CONTAINERS, and a later attempt connects them to a network without their service aliases. The
   * stack then comes up with every container healthy and no DNS at all: `getent hosts postgres`
   * unresolved, and langfuse dying on "Can't reach database server" while postgres sits healthy
   * beside it. Two installs were lost to reading that as a database fault.
   */
  it('skips a subnet the daemon refuses to create, even when the listing omits it', () => {
    // The stub lists NOTHING as allocated but refuses to create these — exactly the released-but-
    // still-held case, which a listing-only check cannot see.
    const dir = mkdtempSync(join(tmpdir(), 'subnet-probe-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const refuse = ['172.16.0.0/16', '172.17.0.0/16'];
    writeFileSync(join(bin, 'docker'), [
      '#!/usr/bin/env bash',
      'if [ "$1" = "network" ] && [ "$2" = "create" ]; then',
      `  for h in ${refuse.map((s) => `'${s}'`).join(' ')}; do`,
      '    for a in "$@"; do [ "$a" = "$h" ] && { echo "invalid pool request: Pool overlaps" >&2; exit 1; }; done',
      '  done',
      '  exit 0',
      'fi',
      "printf ''",          // the listing claims nothing is allocated
      'exit 0',
    ].join('\n'));
    chmodSync(join(bin, 'docker'), 0o755);
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; isolated_subnet_candidates "$1"`, '--',
      '/home/someone/projects/ai/pipeline-tests-29'], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME || '' },
    });
    const out = (r.stdout || '').trim().split('\n').filter(Boolean);
    expect(out.length, 'no candidates produced').toBeGreaterThan(0);
    try {
      for (const s of refuse) {
        expect(out, `${s} cannot be created on this daemon and was offered anyway — compose will `
          + 'fail its network create and connect the containers without aliases').not.toContain(s);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
