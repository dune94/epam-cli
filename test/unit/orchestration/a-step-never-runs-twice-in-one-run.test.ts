/**
 * A STEP RUNS ONCE PER RUN. A RESUME REPEATS NOTHING.
 *
 * Operator rule, 2026-09-02: "we never repeat steps in a pipeline — yes, we retry, but a step never
 * runs more than once." Named explicitly: profile/roster generation, prompt generation, the
 * detective manifest. They are expensive, their output is consumed downstream, and it must be
 * persisted rather than deleted.
 *
 * THREE STEPS BROKE THE RULE, FOUND ONE AT A TIME OVER ONE DAY, all with the same shape:
 *
 *   roster derivation   re-ran the specialiser (~13 min, paid) over a roster the operator had
 *                       just approved at the pause
 *   estate survey       re-observed an estate already surveyed, and the log had already recorded
 *                       this being fixed once before
 *   prompt provisioning rebuilt all 39 prompts from a complete set already on disk
 *
 * The prompt case shows why "cache it" is not the fix. The cache key includes mintedRoles, a resume
 * SKIPS the mint, so that string becomes the literal '(none minted this run)' instead of the
 * roster — every entry missed. Measured on the 2026-09-02 resume of 20260902T022134Z: roles digest
 * 1dad7a5a… at pause 1 against cba40c8d… on the resume, 9 reused and 30 rebuilt. THE STAGE MUST NOT
 * RUN, not run cheaply.
 *
 * THE ARTEFACT ON DISK IS THE SIGNAL. pre-run-reset owns the lifetime: it deletes on a NEW launch
 * and keeps when EPAM_RESUME_RUN is set. So an artefact still present when a step starts means the
 * step already ran. One fact, one owner, nothing to keep in step with anything else.
 *
 * This file asserts the RULE across every step it governs, rather than one more instance of it.
 * Each of the three was found by a dead or wasteful run because the previous fix was written as a
 * one-off.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const src = (p: string) => readFileSync(join(REPO, p), 'utf8');

const RESET = src('orchestrations/scripts/pre-run-reset.sh');
const MINT = src('orchestrations/scripts/mint-agents-step.js');
const ROSTER = src('orchestrations/scripts/lib/project-roster.js');
const SPEC = src('orchestrations/scripts/spec-mode-runner.js');

describe('a step never runs twice in one run', () => {
  it('the sources are readable — otherwise every assertion below is vacuous', () => {
    for (const [n, s] of [['reset', RESET], ['mint', MINT], ['roster', ROSTER], ['spec', SPEC]] as const) {
      expect(s.length, `${n} source is empty`).toBeGreaterThan(1000);
    }
  });

  it('THE RESET OWNS THE LIFETIME: a resume keeps this run\'s own artefacts', () => {
    // Without this the steps below cannot skip: their signal is the artefact's presence.
    expect(RESET, 'the reset does not distinguish a resume from a new run')
      .toMatch(/_IS_RESUMED_RUN/);
    expect(RESET, 'the roster deletion is not resume-aware, so a resume must re-derive')
      .toMatch(/_IS_RESUMED_RUN[^\n]*\n\s*info[^\n]*roster/i);
  });

  it('ROSTER: a settled roster on disk is reused, not re-derived', () => {
    expect(ROSTER, 'buildProjectRoster does not reuse an existing settled roster')
      .toMatch(/reusing the settled roster on disk/);
  });

  it('SURVEY: an estate already surveyed is not re-observed', () => {
    expect(SPEC, 'surveyEstate does not reuse a survey already produced for this run')
      .toMatch(/estate survey already done for this run/);
  });

  it('PROMPTS: provisioning does not run when they are already installed', () => {
    expect(MINT, 'prompt provisioning has no resume guard — it rebuilds every time')
      .toMatch(/prompts already provisioned for this run/);
    expect(MINT, 'the guard does not consult EPAM_RESUME_RUN')
      .toMatch(/EPAM_RESUME_RUN/);
    // AND THE FLAG GATES THE BUILD. Asserting the guard exists says nothing about whether it stops
    // anything — the flag could be set and never read, which is how base/mid/top survived across
    // 40 seams. This ties the decision to the call it is meant to prevent.
    expect(MINT, 'the skip flag does not gate the buildProjectPrompts call')
      .toMatch(/_built\s*=\s*_skipProvisioning[\s\S]{0,80}?await buildProjectPrompts\(/);
  });

  it('SKIPPING THE BUILD DOES NOT SKIP THE VERIFICATION', () => {
    // linkPromptsToRoster checks that every minted agent's seam has a prompt in THIS project. It
    // is data-only and free, and a resume needs it precisely because it did not rebuild. An early
    // `return` out of the provisioning block would have abandoned it — a worse bug than the repeat.
    expect(MINT, 'the prompt-roster link step is gone').toMatch(/linkPromptsToRoster\(\{/);
    const guardAt = MINT.indexOf('prompts already provisioned for this run');
    // The CALL, not any mention. The first version used indexOf('linkPromptsToRoster') and matched
    // the prose in the guard's own comment, reporting the call as sitting before the guard.
    const linkAt = MINT.indexOf('linkPromptsToRoster({');
    expect(guardAt, 'the resume guard was not found').toBeGreaterThan(-1);
    expect(linkAt, 'the link step was not found').toBeGreaterThan(-1);
    expect(linkAt, 'the link step sits before the guard, so it cannot be reached after a skip')
      .toBeGreaterThan(guardAt);
    // And the guard must not be a bare `return`, which would exit the whole step.
    const window = MINT.slice(guardAt, guardAt + 400);
    expect(window, 'the guard returns out of the step, abandoning everything after it')
      .not.toMatch(/\n\s*return;/);
  });

  it('A SKIP IS REPORTED AS A SKIP, never as a run that produced nothing', () => {
    // "0 copied, 0 generated" for a skip is the same sentence as a provisioning run that silently
    // did nothing — two opposite states, one message, which is how a dead stage hides.
    expect(MINT, 'the provisioning log is not conditional, so a skip reports 0 copied / 0 generated')
      .toMatch(/if \(!_skipProvisioning\)/);
  });

  it('ABSENCE IS REPORTED, NOT ASSUMED — a resume with no artefact says so and rebuilds', () => {
    // Silently continuing when the artefact is missing is indistinguishable from a run that never
    // produced it, which is the failure mode every guard here exists to end.
    expect(MINT, 'a resume that finds no prompts installed does not say so')
      .toMatch(/resuming, but no prompts are installed/);
    expect(ROSTER, 'a roster that fails its contract is silently trusted instead of re-derived')
      .toMatch(/does not satisfy the contract/);
  });
});
