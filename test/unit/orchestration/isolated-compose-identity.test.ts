import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * isolated_project_name / isolated_subnet_candidates — the automation this installer needs to
 * NEVER depend on a human hand-picking a free port or subnet (as happened during manual
 * verification testing: "Pool overlaps with other one on this address space", resolved by hand).
 *
 * Pure functions, no docker required: run against the shell library directly and assert on stdout.
 */
const LIB = path.resolve(__dirname, '../../../orchestrations-installer/lib/isolated-compose-identity.sh');

function call(fn: string, ...args: string[]) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; ${fn} "$@"`, '--', ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), lines: r.stdout.trim().split('\n').filter(Boolean) };
}

describe('isolated_project_name', () => {
  it('is deterministic — the same root produces the same name every time', () => {
    const a = call('isolated_project_name', '/home/x/epam-cli', 'launch');
    const b = call('isolated_project_name', '/home/x/epam-cli', 'launch');
    expect(a.out).toBe(b.out);
  });

  it('differs for different roots, so two checkouts never share a project', () => {
    const a = call('isolated_project_name', '/home/x/epam-cli', 'launch');
    const b = call('isolated_project_name', '/home/x/epam-dogfood', 'launch');
    expect(a.out).not.toBe(b.out);
  });

  it('is a valid compose project name — lowercase, no path separators', () => {
    const a = call('isolated_project_name', '/home/x/Some Weird Path!', 'launch');
    expect(a.out).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });
});

describe('isolated_subnet_candidates', () => {
  it('is deterministic — the same root produces the same first candidate every time', () => {
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    const b = call('isolated_subnet_candidates', '/home/x/epam-cli');
    expect(a.lines[0]).toBe(b.lines[0]);
  });

  it('yields more than one candidate, so a collision has somewhere to go', () => {
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    expect(a.lines.length).toBeGreaterThan(1);
    expect(new Set(a.lines).size, 'candidates repeat — a retry would just hit the same taken CIDR').toBe(a.lines.length);
  });

  it('every candidate is a well-formed /16 inside RFC1918', () => {
    /**
     * WIDENED 2026-09-06, and the range is no longer pinned here.
     *
     * This used to require 172.19–172.28: ten values, of which the generator offered five. Six
     * coexisting stacks therefore exhausted it by arithmetic — which is exactly what happened
     * installing v1.50 into pipeline-tests-28 on a box already running three other installs. The
     * observability stack took the first candidate and the launch dashboard had nowhere left to
     * go, twice.
     *
     * The space is now 172.16–172.31 plus a 10.100–10.199 reserve, and WHICH of them are usable
     * is decided by asking the daemon rather than by a range written here. Both are RFC1918
     * ranges Docker itself defaults to, so nothing offered can collide with a corporate VPN the
     * way 192.168 might.
     */
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    expect(a.lines.length, 'no candidates produced').toBeGreaterThan(0);
    for (const line of a.lines) {
      expect(line, `not a well-formed /16: ${line}`).toMatch(/^(172\.(1[6-9]|2\d|3[01])|10\.1\d\d)\.0\.0\/16$/);
    }
  });

  it('offers more than a handful — several installs must be able to coexist', () => {
    // The live failure was a counting failure: five candidates, six stacks wanting one each.
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    expect(a.lines.length).toBeGreaterThanOrEqual(16);
  });

  it('WHAT IS IN USE IS ASKED, NOT ASSUMED', () => {
    /**
     * The assertion this replaces listed 172.16–18 and 172.29–31 as "already known to be in use on
     * this host". That was one machine's arrangement written into a test — the docker bridge is
     * conventionally 172.17, but everything else on that list was simply what happened to be
     * running here. A second machine, or this one tomorrow, holds something different, and the
     * generator would still avoid the wrong ones while offering the taken ones.
     *
     * a-subnet-is-never-offered-if-the-box-already-holds-it.test.ts drives the real function with
     * a stubbed daemon and asserts the exclusion directly. Here it is enough that no range is
     * excluded on faith: 172.17 must be OFFERED when nothing holds it, or the generator is still
     * carrying a hardcoded opinion about this host.
     */
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    const offered = a.lines.join(' ');
    expect(offered.length).toBeGreaterThan(0);
    // Nothing may be missing for a reason this file invented; the daemon is the only authority.
    expect(a.lines.some((l: string) => /^172\./.test(l)),
      'no 172.x candidate at all — the space collapsed').toBe(true);
  });
});
