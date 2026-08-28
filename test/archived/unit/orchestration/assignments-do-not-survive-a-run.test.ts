/**
 * A PREVIOUS RUN'S ASSIGNMENTS MUST NOT SURVIVE INTO THIS ONE.
 *
 * role-assignments.json records which agent owns each (story, codeline). It is generated, and
 * nothing cleared it.
 *
 * Live 2026-08-09: a run started at 23:51 and the file on disk was from 23:18 — a different
 * run, killed. It named `contentstack-context-react-engineer`, a role that does not exist in
 * the roster the new run minted. The rosters are ephemeral by design, so an assignment file
 * that outlives its roster points every consumer at an agent with no brief.
 *
 * It is also actively misleading: while diagnosing the assignment failure it read as three
 * successful assignments, and the run had in fact assigned nothing. The registries next to it
 * are cleared for exactly this reason — project-investigators.json was added to that list on
 * 2026-08-08 after surviving every reset the same way. This file was never added at all.
 *
 * The clearing runs against the real block extracted from pre-run-reset.sh, not a copy of it.
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

/** The real clearing block, lifted out of the script. */
function clearBlock(): string {
  const start = resetSrc.indexOf('_ROSTER_CLEARED=0');
  expect(start, 'the clearing block is gone from pre-run-reset').toBeGreaterThan(-1);
  const end = resetSrc.indexOf('# Restore the live roster', start);
  expect(end).toBeGreaterThan(start);
  return resetSrc.slice(start, end);
}

/**
 * THE RESUME DECISION MOVED ABOVE THIS BLOCK; THE REQUIREMENT DID NOT.
 *
 * "is this a resume" is asked once now, near the top of the reset, because the run-state clearing
 * further up needs the same answer and used to run ~190 lines before it existed. This block reads
 * that answer rather than re-deriving it, so lifting the block out means lifting the decision with
 * it — taken from the SOURCE, never restated here, or this test would pass against a decision the
 * script no longer makes.
 */
function resumeDecision(): string {
  const at = resetSrc.indexOf('_IS_RESUMED_RUN=0');
  expect(at, 'the hoisted resume decision is gone').toBeGreaterThan(-1);
  return resetSrc.slice(at, resetSrc.indexOf('\nfi', at) + 3);
}

/** Seeds a config dir and a log dir with a full previous-run state, then runs the real block. */
function runReset(opts: { resume?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reset-assign-')); dirs.push(dir);
  const cfg = join(dir, 'projectcfg');
  const logs = join(dir, 'logs');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(logs, { recursive: true });

  writeFileSync(join(cfg, 'project-roles.json'), JSON.stringify({ roles: ['last-run-engineer'] }));
  writeFileSync(join(cfg, 'project-investigators.json'), JSON.stringify({ investigators: ['last-run-investigator'] }));
  writeFileSync(join(logs, 'role-assignments.json'), JSON.stringify([
    { storyId: 'S-1', codeline: 'one', agentRole: 'a-role-from-a-killed-run' },
  ]));

  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    '#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n' +
    `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\n` +
    `LOG_DIR=${JSON.stringify(logs)}\n` +
    (opts.resume ? 'EPAM_RESUME_RUN=20260809T000000Z\n' : '') +
    // AFTER the variable it reads, before the block that reads its answer — the same order the
    // real script has, where the decision sits above the clearing and below the environment.
    `${resumeDecision()}\n${clearBlock()}\n`);
  const out = execFileSync('bash', [sh], { encoding: 'utf8' });
  return { cfg, logs, out };
}

describe('the fixture is real', () => {
  it('the stale assignment file exists before the reset runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-check-')); dirs.push(dir);
    const f = join(dir, 'role-assignments.json');
    writeFileSync(f, '[]');
    expect(existsSync(f)).toBe(true);
  });
});

describe('THE DEFECT: role-assignments.json is cleared on a fresh run', () => {
  it('it does not survive into the next run', () => {
    const { logs } = runReset();
    expect(
      existsSync(join(logs, 'role-assignments.json')),
      "a killed run's assignments survived, naming an agent this run never minted",
    ).toBe(false);
  });

  it('the registries beside it are still cleared — existing behaviour holds', () => {
    const { cfg } = runReset();
    expect(existsSync(join(cfg, 'project-roles.json'))).toBe(false);
    expect(existsSync(join(cfg, 'project-investigators.json'))).toBe(false);
  });

  it('the operator is told how many generated files were cleared', () => {
    expect(runReset().out).toMatch(/Cleared \d+ generated/);
  });
});

describe('a RESUME keeps what its own run produced', () => {
  it('assignments made by the run being resumed are not destroyed', () => {
    // The roster is deliberately preserved on resume; the assignments derived from it must be
    // too, or the resumed run continues with a roster and no owners.
    const { logs } = runReset({ resume: true });
    expect(
      existsSync(join(logs, 'role-assignments.json')),
      'the resume cleared the assignments belonging to the run it is resuming',
    ).toBe(true);
  });

  it('and the roster is still preserved on resume', () => {
    const { cfg } = runReset({ resume: true });
    expect(existsSync(join(cfg, 'project-roles.json'))).toBe(true);
  });
});

describe('nothing to clear is not an error', () => {
  it('an empty log dir does not fail or claim to have cleared anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-empty-')); dirs.push(dir);
    const cfg = join(dir, 'cfg'); const logs = join(dir, 'logs');
    mkdirSync(cfg, { recursive: true }); mkdirSync(logs, { recursive: true });
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      '#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n' +
      `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\nLOG_DIR=${JSON.stringify(logs)}\n${resumeDecision()}\n${clearBlock()}\n`);
    expect(execFileSync('bash', [sh], { encoding: 'utf8' })).not.toMatch(/Cleared/);
  });

  it('an unset LOG_DIR does not error or delete anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-nolog-')); dirs.push(dir);
    const cfg = join(dir, 'cfg'); mkdirSync(cfg, { recursive: true });
    const sh = join(dir, 'run.sh');
    writeFileSync(sh,
      '#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n' +
      `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\nLOG_DIR=""\n${clearBlock()}\n`);
    expect(() => execFileSync('bash', [sh], { encoding: 'utf8' })).not.toThrow();
  });
});
