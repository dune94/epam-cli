/**
 * THE MINT REPORTED MORE PROPOSALS THAN IT ACCOUNTED FOR.
 *
 * Three consecutive runs printed a tally that does not balance:
 *
 *     proposed=6 minted=3 unchanged=0 rejected=1     -> 2 unexplained
 *     proposed=8 minted=5 unchanged=0 rejected=0     -> 3 unexplained
 *     proposed=7 minted=5 unchanged=0 rejected=0     -> 2 unexplained
 *
 * The mint retries when proposals are refused, re-prompting with the reasons. Across attempts
 * `minted` and `unchanged` accumulate, but `rejected` does not — it is replaced by the last
 * attempt's list through the object spread. So a proposal refused on attempt 1 and corrected
 * on attempt 2 is counted in `proposed`, counted again in `minted`, and its rejection is
 * erased. The roster is right; the report of how it was reached is not.
 *
 * That matters because this line is the only account an operator gets of what the mint did. A
 * tally with a silent remainder reads as proposals vanishing, and I spent time on three
 * separate runs trying to find agents that had never gone missing.
 *
 * Every proposal now lands in exactly one bucket, and the buckets sum to `proposed`.
 */
import { describe, it, expect } from 'vitest';

const { reconcileMintTally } = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** The live shape: two attempts, the first partly refused and corrected in the second. */
const TWO_ATTEMPTS = {
  proposed: 7,
  minted: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }],
  unchanged: [],
  rejected: [],
  rejectedAcrossAttempts: [
    { name: 'a', reason: 'brief names a path that does not exist' },
    { name: '_placeholder', reason: 'name is not a plain kebab-case identifier' },
  ],
};

describe('the tally balances', () => {
  it('every proposal is accounted for', () => {
    const t = reconcileMintTally(TWO_ATTEMPTS);
    expect(
      t.minted + t.unchanged + t.rejected + t.superseded,
      'the buckets do not sum to the number of proposals',
    ).toBe(t.proposed);
  });

  it('a proposal refused then corrected is counted as superseded, not lost', () => {
    const t = reconcileMintTally(TWO_ATTEMPTS);
    expect(t.superseded).toBe(2);
  });

  it('the minted count is unchanged — this is reporting, not behaviour', () => {
    expect(reconcileMintTally(TWO_ATTEMPTS).minted).toBe(5);
  });

  it('a still-refused proposal is reported as rejected, not superseded', () => {
    const t = reconcileMintTally({
      proposed: 3, minted: [{ name: 'a' }, { name: 'b' }], unchanged: [],
      rejected: [{ name: 'c', reason: 'still wrong' }],
      rejectedAcrossAttempts: [{ name: 'c', reason: 'still wrong' }],
    });
    expect(t.rejected).toBe(1);
    expect(t.superseded).toBe(0);
    expect(t.minted + t.unchanged + t.rejected + t.superseded).toBe(t.proposed);
  });
});

describe('a single-attempt mint is unaffected', () => {
  it('nothing refused, nothing superseded', () => {
    const t = reconcileMintTally({ proposed: 5, minted: [1, 2, 3, 4, 5], unchanged: [], rejected: [], rejectedAcrossAttempts: [] });
    expect(t).toMatchObject({ proposed: 5, minted: 5, rejected: 0, superseded: 0 });
  });

  it('one refused on the only attempt', () => {
    const t = reconcileMintTally({ proposed: 5, minted: [1, 2, 3, 4], unchanged: [], rejected: [{ name: 'x' }], rejectedAcrossAttempts: [{ name: 'x' }] });
    expect(t.rejected).toBe(1);
    expect(t.superseded).toBe(0);
  });
});

describe('it never invents or hides a remainder', () => {
  it('an unexplained remainder is reported rather than absorbed', () => {
    // If the numbers still cannot be reconciled, say so — silently padding a bucket to make
    // the line add up would recreate the defect in a quieter form.
    const t = reconcileMintTally({ proposed: 9, minted: [1, 2], unchanged: [], rejected: [], rejectedAcrossAttempts: [] });
    expect(t.unaccounted).toBe(7);
  });

  it('a balanced tally reports no remainder', () => {
    expect(reconcileMintTally(TWO_ATTEMPTS).unaccounted).toBe(0);
  });

  it('degenerate input does not throw', () => {
    expect(() => reconcileMintTally({})).not.toThrow();
    expect(() => reconcileMintTally(null as any)).not.toThrow();
  });
});
