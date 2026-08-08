/**
 * THE EPHEMERAL ROSTER MEANS BOTH REGISTRIES, NOT ONE.
 *
 * A run must start from the canonical base, never from a previous run's mutated roster. The
 * mint writes TWO registries — project-roles.json (implementers, read by the write perimeter)
 * and project-investigators.json (read-only investigators, plus the codeline→investigator
 * mapping the lanes resolve through).
 *
 * pre-run-reset cleared project-roles.json and agent-profiles.json. The investigator registry
 * was added later and the reset never learned about it, so it survived every run.
 *
 * Live 2026-08-08: project-investigators.json carried SIX investigators — three minted that
 * run and three left over from 2026-08-07 whose profiles no longer existed, because
 * profiles.json HAD been restored from canonical. A registered investigator with no brief is
 * worse than an absent one: it resolves to a name that reads as minted and investigates with
 * nothing, and byCodeline can point a lane straight at it.
 *
 * The test runs the REAL reset block extracted from the script against a fixture.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RESET = join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh');
const resetSrc = readFileSync(RESET, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real roster-clearing block, lifted out of the script. */
function rosterBlock(): string {
  const start = resetSrc.indexOf('_ROSTER_CLEARED=0');
  expect(start, 'the roster-clearing block is gone from pre-run-reset').toBeGreaterThan(-1);
  const end = resetSrc.indexOf('# Restore the live roster', start);
  expect(end).toBeGreaterThan(start);
  return resetSrc.slice(start, end);
}

/** Seeds a project config dir with a full previous-run roster, then runs the real block. */
function runReset() {
  const dir = mkdtempSync(join(tmpdir(), 'reset-roster-')); dirs.push(dir);
  const cfg = join(dir, 'projectcfg');
  mkdirSync(cfg, { recursive: true });

  writeFileSync(join(cfg, 'project-roles.json'),
    JSON.stringify({ roles: ['last-run-engineer'] }, null, 2));
  writeFileSync(join(cfg, 'agent-profiles.json'),
    JSON.stringify({ profiles: { 'last-run-engineer': 'a brief' } }, null, 2));
  writeFileSync(join(cfg, 'project-investigators.json'), JSON.stringify({
    investigators: ['last-run-investigator'],
    byCodeline: { alpha: 'last-run-investigator' },
  }, null, 2));

  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n` +
    `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\n${rosterBlock()}\n`);
  const out = execFileSync('bash', [sh], { encoding: 'utf8' });
  return { cfg, out };
}

describe('the fixture is real', () => {
  it('the seeded roster exists before the reset runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-check-')); dirs.push(dir);
    const f = join(dir, 'project-investigators.json');
    writeFileSync(f, '{}');
    expect(existsSync(f)).toBe(true);
    expect(rosterBlock()).toContain('_ROSTER_CLEARED');
  });
});

describe('every generated registry is cleared, not just the roles', () => {
  it('project-roles.json is cleared — the pre-existing behaviour still holds', () => {
    const { cfg } = runReset();
    expect(existsSync(join(cfg, 'project-roles.json'))).toBe(false);
  });

  it('agent-profiles.json is cleared — the pre-existing behaviour still holds', () => {
    const { cfg } = runReset();
    expect(existsSync(join(cfg, 'agent-profiles.json'))).toBe(false);
  });

  it('THE DEFECT: project-investigators.json is cleared too', () => {
    const { cfg } = runReset();
    expect(
      existsSync(join(cfg, 'project-investigators.json')),
      'a previous run\'s investigators survive into this one — three did on 2026-08-08, with ' +
      'no profiles, while byCodeline could point a lane at one of them',
    ).toBe(false);
  });

  it('the count reported to the operator covers all three files', () => {
    const { out } = runReset();
    expect(out).toMatch(/Cleared 3 generated-roster file/);
  });
});

describe('a project with nothing generated is left alone', () => {
  it('no files and no claim of having cleared any', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-empty-')); dirs.push(dir);
    const cfg = join(dir, 'projectcfg');
    mkdirSync(cfg, { recursive: true });
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      `#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n` +
      `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\n${rosterBlock()}\n`);
    expect(execFileSync('bash', [sh], { encoding: 'utf8' })).not.toMatch(/Cleared/);
  });

  it('an unset EPAM_PROJECT_CONFIG_DIR does not error or delete anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-unset-')); dirs.push(dir);
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      `#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n` +
      `EPAM_PROJECT_CONFIG_DIR=""\n${rosterBlock()}\n`);
    expect(() => execFileSync('bash', [sh], { encoding: 'utf8' })).not.toThrow();
  });
});
