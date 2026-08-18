/**
 * THE MINT TALLY DOUBLE-COUNTED A REFUSAL AND REPORTED THE REMAINDER AS UNACCOUNTED.
 *
 * Live 2026-08-17, run 20260817T162132Z:
 *
 *     proposed=5 minted=3 unchanged=0 rejected=1 superseded=0 UNACCOUNTED=1
 *
 * with agent-mint.json holding:
 *
 *     minted: 3
 *     rejected: [mockb-codebase-investigator]                               <- unique, still refused
 *     rejectedAcrossAttempts: [mockb-codebase-investigator, mockb-...]      <- 2 refusal EVENTS
 *     attempts: 2
 *
 * `proposed` counts proposal EVENTS across attempts (5). `rejected` counts UNIQUE names still
 * refused (1). `superseded` deliberately excludes anything still rejected (0). So mockb's second
 * refusal was subtracted from nothing and surfaced as a phantom missing proposal.
 *
 * Every proposal event has exactly one outcome: 3 minted + 0 unchanged + 2 refusal events = 5.
 *
 * `superseded` is a DESCRIPTOR, not a bucket — a superseded proposal's refusal is already counted
 * in rejectedAcrossAttempts and its later success is already in minted, so subtracting it as well
 * double-counts. It stays in the report because "refused once, corrected later" is worth seeing.
 *
 * The mechanism was right to surface a remainder rather than fold it into another bucket; that is
 * the only reason this was findable at all. What was wrong was the arithmetic.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reconcileMintTally } = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const named = (...names: string[]) => names.map((name) => ({ name }));

describe('the mint tally left a proposal unaccounted', () => {
  it('THE LIVE CASE RECONCILES — a name refused twice consumes two proposals', () => {
    const t = reconcileMintTally({
      proposed: 5,
      minted: named('fare-logic-engineer', 'departure-board-engineer', 'mocka-codebase-investigator'),
      unchanged: [],
      rejected: named('mockb-codebase-investigator'),
      rejectedAcrossAttempts: named('mockb-codebase-investigator', 'mockb-codebase-investigator'),
    });
    expect(t.unaccounted, 'the second refusal of one agent still reads as a lost proposal').toBe(0);
    expect(t.minted).toBe(3);
    expect(t.rejected, 'the report no longer says which agents are still refused').toBe(1);
  });

  it('a genuinely superseded proposal reconciles too', () => {
    // Refused on attempt 1, corrected and minted on attempt 2: 1 refusal event + 1 mint = 2.
    const t = reconcileMintTally({
      proposed: 2,
      minted: named('good-engineer'),
      unchanged: [],
      rejected: [],
      rejectedAcrossAttempts: named('good-engineer'),
    });
    expect(t.unaccounted).toBe(0);
    expect(t.superseded, 'a corrected proposal is no longer reported as superseded').toBe(1);
  });

  it('superseded is a descriptor, not a third bucket to subtract', () => {
    // The old arithmetic subtracted superseded AND the refusal it came from, so a run with several
    // corrections would have gone NEGATIVE and clamped silently to 0.
    const t = reconcileMintTally({
      proposed: 4,
      minted: named('a', 'b'),
      unchanged: [],
      rejected: [],
      rejectedAcrossAttempts: named('a', 'b'),
    });
    expect(t.unaccounted).toBe(0);
    expect(t.superseded).toBe(2);
  });

  it('a REAL discrepancy is still reported — this must not silence the signal', () => {
    // 5 proposed, 1 minted, nothing refused: 4 genuinely unexplained. Folding this away would
    // remove the only reason the live defect was visible.
    const t = reconcileMintTally({
      proposed: 5, minted: named('a'), unchanged: [], rejected: [], rejectedAcrossAttempts: [],
    });
    expect(t.unaccounted, 'a genuine remainder is now hidden').toBe(4);
  });

  it('the clean single-attempt case is unchanged', () => {
    const t = reconcileMintTally({
      proposed: 3, minted: named('a', 'b', 'c'), unchanged: [], rejected: [], rejectedAcrossAttempts: [],
    });
    expect(t).toMatchObject({ proposed: 3, minted: 3, rejected: 0, superseded: 0, unaccounted: 0 });
  });

  it('survives a missing or empty result', () => {
    expect(reconcileMintTally(null).unaccounted).toBe(0);
    expect(reconcileMintTally({}).proposed).toBe(0);
  });
});
