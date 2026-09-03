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

  it('every candidate is a valid /16 in the range this installer reserves (172.19-172.28)', () => {
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    for (const line of a.lines) {
      const m = line.match(/^172\.(\d+)\.0\.0\/16$/);
      expect(m, `not a 172.x.0.0/16: ${line}`).toBeTruthy();
      const octet = Number(m![1]);
      expect(octet).toBeGreaterThanOrEqual(19);
      expect(octet).toBeLessThanOrEqual(28);
    }
  });

  it('avoids the ranges already known to be in use on this host (16-18, 29-31)', () => {
    const a = call('isolated_subnet_candidates', '/home/x/epam-cli');
    for (const line of a.lines) {
      expect(line).not.toMatch(/^172\.(1[6-8]|29|3[01])\./);
    }
  });
});
