/**
 * THE ROSTER GATE READ A VERDICT NOTHING EVER EMITTED.
 *
 * project-roster.js accepted the roster on `verdict === 'approved'` and retried the judge on
 * `verdict === 'review_failed'`. The reviewer emits neither. Its prompt declares `sound` and
 * `defects_found`, and the schema also allows `nothing_to_review`.
 *
 * With no overlap, EVERY outcome fell through to the rejection branch. Live 2026-09-01, metrolinx
 * AMSD-1919: batch5 returned `{"verdict":"sound"}` with zero findings and zero blocking — a clean
 * pass — and the roster was thrown away anyway. Three attempts, all rejected, the mint failed and
 * the run halted. The same step killed the 30 August run.
 *
 * The cost is not only the halt. Six review batches per attempt, three attempts — eighteen model
 * calls whose verdict could not be acted on whatever it said.
 *
 * A gate must be written against the vocabulary its judge ACTUALLY emits. This is the same defect
 * shape already recorded for the spec-review gate, in a different gate, and it survived because
 * nothing tested the mapping — the reviewer was tested, the roster writer was tested, and the JOIN
 * between them was not.
 *
 * THE LAST TEST HERE IS THE ONE THAT MATTERS: it reads the vocabulary out of the prompt template
 * and asserts the gate handles every value the reviewer is told to produce. That is what makes the
 * two impossible to drift apart again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/project-roster.js');
const TEMPLATE = join(REPO, 'orchestrations/prompts/templates/project-roster-review.json');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyReviewVerdict } = require(LIB);

const blocking = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, severity: 'blocking', claim: `c${i}` }));
const advisory = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, severity: 'advisory', claim: `c${i}` }));

describe('the roster gate reads the verdict the reviewer emits', () => {
  it('is exported at all', () => {
    expect(typeof classifyReviewVerdict, 'classifyReviewVerdict is not exported').toBe('function');
  });

  it('THE DEFECT: `sound` is an approval', () => {
    // batch5 returned exactly this on 2026-09-01 and the roster was discarded.
    expect(classifyReviewVerdict({ verdict: 'sound', findings: [] }).outcome).toBe('approved');
  });

  it('`defects_found` with a blocking finding is a rejection', () => {
    const r = classifyReviewVerdict({ verdict: 'defects_found', findings: blocking(1) });
    expect(r.outcome).toBe('rejected');
    expect(r.reason, 'the rejection carries nothing for the next attempt to act on').toBeTruthy();
  });

  it('`defects_found` with only advisory findings is an APPROVAL', () => {
    // Advisory findings are notes, not blockers — the mint already proceeds past them elsewhere.
    // Treating them as rejections would fail a roster nobody objected to.
    expect(classifyReviewVerdict({ verdict: 'defects_found', findings: advisory(3) }).outcome)
      .toBe('approved');
  });

  it('`nothing_to_review` blames the JUDGE, not the roster', () => {
    // The reviewer did not look. Deleting the roster over that destroys work the review never
    // examined; the judge is what needs retrying.
    expect(classifyReviewVerdict({ verdict: 'nothing_to_review', findings: [] }).outcome)
      .toBe('review_failed');
  });

  it('an unrecognised verdict is never silently treated as approval', () => {
    // The failure that made this test necessary was a vocabulary mismatch. If it drifts again the
    // gate must say so, not guess in either direction.
    for (const v of ['approved', 'yes', '', undefined, null]) {
      const r = classifyReviewVerdict({ verdict: v as any, findings: [] });
      expect(r.outcome, `"${String(v)}" was treated as an approval`).not.toBe('approved');
      expect(r.reason, `"${String(v)}" produced no explanation`).toBeTruthy();
    }
  });

  it('a missing verdict object is not an approval', () => {
    for (const v of [null, undefined, {}]) {
      expect(classifyReviewVerdict(v as any).outcome).not.toBe('approved');
    }
  });

  it('THE ANTI-DRIFT CHECK: every verdict the template declares is handled', () => {
    // Read the vocabulary out of the prompt the reviewer is actually given. Anything it is told to
    // emit that this gate does not recognise is the original defect, returning.
    const declared = [...new Set(
      (JSON.stringify(JSON.parse(readFileSync(TEMPLATE, 'utf8')))
        .match(/\b(sound|defects_found|nothing_to_review)\b/g) || []),
    )];
    expect(declared.length, 'no verdict vocabulary found in the template — this proves nothing')
      .toBeGreaterThan(0);
    for (const v of declared) {
      const r = classifyReviewVerdict({ verdict: v, findings: [] });
      expect(r.outcome, `the reviewer is told it may answer "${v}" and the gate does not handle it`)
        .not.toBe('unrecognised');
    }
  });
});
