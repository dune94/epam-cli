/**
 * "SOUND" WAS ASSERTED ABOUT A SET NOBODY LOOKED AT, AND THE SURVEY REVIEWER WAS NEVER INVOKED.
 *
 * 1. reviewRoster and the mint both short-circuit an empty roster with
 *    `{ verdict: 'sound', findings: [], reviewed: 0 }`. No model is called, nothing is examined,
 *    and the pipeline is told the roster is sound. It is the vacuous pass in its purest form:
 *    zero findings because there was nothing to find, reported as a clean bill of health.
 *
 *    Live 2026-08-17: a correction cycle indicted both implementers, cleared them, minted no
 *    replacement, and the next review returned "sound" — true of the empty set, and the run died
 *    several steps later at assignment. A guard was written to catch that and has been removed;
 *    the reviewer must simply stop claiming something it did not check.
 *
 * 2. survey-review exists as a seam and a template — read-only, the survey and codeline facts as
 *    required inputs — and nothing invokes it. A reviewer nobody calls reviews nothing, which is
 *    the same shape as the readiness audit that was written and never wired.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roster = require(join(ROOT, 'orchestrations/scripts/lib/agent-roster.js'));

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('an empty roster was called sound', () => {
  it('AN EMPTY ROSTER IS NOT SOUND — it is unreviewed', async () => {
    const out = await spec.reviewRoster({ minted: [], profiles: {}, codelines: [], tickets: [] });
    expect(out.verdict, 'the reviewer still certifies a set it never looked at').not.toBe('sound');
    expect(out.verdict).toBe('nothing_to_review');
    expect(out.reviewed, 'it claims to have reviewed something').toBe(0);
  });

  it('the mint says the same thing, in the same words', () => {
    // Two places short-circuited with 'sound'; a fix to one leaves the other lying.
    expect(src('orchestrations/scripts/mint-agents-step.js'),
      'the mint still reports an empty roster as sound')
      .not.toMatch(/!_mintedDetail\.length\) return \{ verdict: 'sound'/);
  });

  it('the schema admits the verdict, or the model can never return it', () => {
    const s = src('orchestrations/scripts/spec-mode-runner.js');
    const i = s.indexOf('TOOL_ROSTER_REVIEW');
    expect(s.slice(i, i + 2000), 'nothing_to_review is not a verdict the contract allows')
      .toMatch(/nothing_to_review/);
  });

  it('an unreviewed roster still counts as needing review', () => {
    // not_run and review_failed already mean "review still owed". An empty roster that later
    // gains agents owes one too — treating it as settled is how the vacuous pass returns.
    // Takes an object, not a string — a string argument leaves verdict undefined and every
    // assertion passes for the wrong reason.
    expect(roster.rosterReviewIsRequired({ verdict: 'nothing_to_review' }),
      'an unreviewed roster is treated as already cleared').toBe(true);
    expect(roster.rosterReviewIsRequired({ verdict: 'sound' }),
      'a real pass now demands another review').toBe(false);
    // The deliberate exits stay exits: a resume and a configured pause both skip the demand.
    expect(roster.rosterReviewIsRequired({ verdict: 'nothing_to_review', mintSkipped: true })).toBe(false);
  });

  it('A REVIEWER NOBODY CALLS REVIEWS NOTHING — survey-review is invoked', () => {
    const mint = src('orchestrations/scripts/mint-agents-step.js');
    expect(mint, 'survey-review exists as a seam and nothing runs it').toMatch(/reviewSurvey|survey-review/);
  });

  it('the survey review runs BEFORE the roster is minted from it', () => {
    // Reviewing after the mint would report on claims the roster has already inherited.
    const mint = src('orchestrations/scripts/mint-agents-step.js');
    const review = Math.min(
      ...['reviewSurvey', 'survey-review'].map((k) => {
        const i = mint.indexOf(k);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    const mintCall = mint.indexOf('mintProjectAgents({');
    expect(review, 'survey-review is not invoked at all').toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(review, 'the survey is reviewed after the roster was already built from it')
      .toBeLessThan(mintCall);
  });

  it('a survey that did not run is not reviewed', () => {
    // The survey is allowed to fail; reviewing a failure produces findings about nothing.
    const s = src('orchestrations/scripts/spec-mode-runner.js');
    const i = s.indexOf('async function reviewSurvey');
    expect(i, 'reviewSurvey does not exist').toBeGreaterThan(-1);
    expect(s.slice(i, i + 700), 'it reviews a survey that never ran').toMatch(/\.ran|ran\s*[!=]==?/);
  });
});
