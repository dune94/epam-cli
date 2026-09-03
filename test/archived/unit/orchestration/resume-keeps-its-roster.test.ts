/**
 * A RESUME MUST NOT DESTROY THE ROSTER IT IS RESUMING WITH.
 *
 * Live 2026-08-08, run 20260808T203346Z. The operator reviewed a roster at pause 1 and
 * resumed. pre-run-reset then cleared all three generated-roster files ("this run mints from
 * the canonical base"), the mint was correctly skipped because this was a resume, so nothing
 * re-registered them — and role assignment died with "no project implementation roles are
 * registered". The pause exists so a human can approve a roster before the spec phase; the
 * resume deleted exactly that.
 *
 * Two independent defects, one per describe block below:
 *
 *  1. the clear is unconditional — it must not run for a resume;
 *  2. the "was this roster reviewed?" guard treats a SKIPPED mint as an unreviewed roster,
 *     but on a resume the review already happened, in the run being resumed.
 *
 * Both are executed here, not asserted from source.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(__dirname, '../../../');
const RESET = readFileSync(join(REPO, 'orchestrations/scripts/pre-run-reset.sh'), 'utf8');
const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real roster-clearing block, lifted out of pre-run-reset. */
function clearBlock(): string {
  const start = RESET.indexOf('_ROSTER_CLEARED=0');
  expect(start, 'the roster-clearing block is gone').toBeGreaterThan(-1);
  return RESET.slice(start, RESET.indexOf('# Restore the live roster', start));
}

/**
 * THE RESUME DECISION MOVED ABOVE THIS BLOCK; THE REQUIREMENT DID NOT.
 *
 * "is this a resume" is asked once now, near the top of the reset, because the run-state clearing
 * (estate-survey.json and the fetched documents) needs the same answer and used to run ~190 lines
 * BEFORE it was worked out. This block reads that answer rather than re-deriving it, so lifting it
 * out means lifting the decision with it — from the SOURCE, never restated here, or this test
 * would pass against a decision the script no longer makes.
 */
function resumeDecision(): string {
  const at = RESET.indexOf('_IS_RESUMED_RUN=0');
  expect(at, 'the hoisted resume decision is gone').toBeGreaterThan(-1);
  return RESET.slice(at, RESET.indexOf('\nfi', at) + 3);
}

/** Seeds a reviewed roster, runs the real block, reports which files survived. */
function runClear(env: Record<string, string>): { survived: string[]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'resume-roster-')); dirs.push(dir);
  const cfg = join(dir, 'cfg'); mkdirSync(cfg, { recursive: true });
  const files = ['project-roles.json', 'project-investigators.json', 'agent-profiles.json'];
  for (const f of files) writeFileSync(join(cfg, f), '{"seeded":true}');

  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\nset -u\ninfo(){ echo "[info] $*"; }\n` +
    `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(cfg)}\n${resumeDecision()}\n${clearBlock()}\n`);
  const out = execFileSync('bash', [sh], {
    encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: '', ...env },
  });
  return { survived: files.filter((f) => existsSync(join(cfg, f))), out };
}

describe('the fixture is real', () => {
  it('a NORMAL run still clears the previous run roster — the ephemeral rule', () => {
    const { survived, out } = runClear({});
    expect(survived, 'a fresh run must start from the canonical base').toEqual([]);
    expect(out).toMatch(/Cleared 3 generated-roster file/);
  });
});

describe('THE DEFECT: a resume keeps the roster it is resuming with', () => {
  it('no roster file is cleared when EPAM_RESUME_RUN is set', () => {
    const { survived } = runClear({ EPAM_RESUME_RUN: '20260808T203346Z' });
    expect(
      survived.sort(),
      'the resume deleted the roster the operator approved at pause 1, and the skipped mint ' +
      'never re-registered it — assignment then had no roles at all',
    ).toEqual(['agent-profiles.json', 'project-investigators.json', 'project-roles.json']);
  });

  it('it says it kept them, so the operator is not left guessing', () => {
    expect(runClear({ EPAM_RESUME_RUN: 'X' }).out).toMatch(/resum/i);
  });
});

describe('THE SECOND DEFECT: a skipped mint is not an unreviewed roster', () => {
  // On a resume the mint is skipped deliberately; the review happened in the run being
  // resumed and its verdict is on disk. Demanding a fresh review refuses a roster that WAS
  // reviewed — which is what killed run 20260808T203346Z.
  it('a resume with a skipped mint does not demand a new review', () => {
    expect(
      roster.rosterReviewIsRequired({ verdict: 'not_run', mintSkipped: true, pauseConfigured: false }),
      'a resumed roster is refused even though it was reviewed before the pause',
    ).toBe(false);
  });

  it('a NORMAL run with no review still demands one — the guard keeps its teeth', () => {
    expect(roster.rosterReviewIsRequired({ verdict: 'not_run', mintSkipped: false, pauseConfigured: false }))
      .toBe(true);
  });

  it('a failed review on a normal run still demands one', () => {
    expect(roster.rosterReviewIsRequired({ verdict: 'review_failed', mintSkipped: false, pauseConfigured: false }))
      .toBe(true);
  });

  it('a configured pause defers to the operator rather than refusing', () => {
    expect(roster.rosterReviewIsRequired({ verdict: 'review_failed', mintSkipped: false, pauseConfigured: true }))
      .toBe(false);
  });

  it('a sound review never demands another', () => {
    expect(roster.rosterReviewIsRequired({ verdict: 'sound', mintSkipped: false, pauseConfigured: false }))
      .toBe(false);
  });
});
