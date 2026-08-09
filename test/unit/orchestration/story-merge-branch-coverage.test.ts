/**
 * The remaining branches of story-merge.js — the ones no live scenario had exercised.
 *
 * The merge is the seam where three lanes' work becomes one story, and every defect found in it
 * so far has been a QUIET one: last-writer-wins status, criteria from the wrong codeline, a
 * lane's slot overwritten with the union. None of them threw. They produced a plausible PRD that
 * was wrong, and were noticed only much later — by a spec score of 0.65, and by fix sites
 * inflating from 13 to 22 across a day of killed runs.
 *
 * That is the argument for covering the defensive branches rather than only the happy path: in
 * this file a wrong answer is indistinguishable from a right one at a glance, so the fallbacks
 * have to be pinned by something other than eyeballing. Each test below states what the branch
 * protects against, not merely that it is reachable.
 *
 * Covers the five branches left uncovered by the behavioural suites: the two `codelineOrder`
 * fallbacks, a lane PRD with no usable stories, a canonical PRD with no stories array, and a
 * lane that completes a story without stamping completedAt.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  mergeLaneIntoCanonical, normalizeCriteria, unionCriteria, normalizeFindings, concatFindings,
} = require(join(__dirname, '../../../orchestrations/scripts/lib/story-merge.js'));

describe('unionCriteria without a codeline order', () => {
  // The order argument is how canonical keeps a stable, meaningful sequence. When a caller has
  // no order to give, every lane's criteria must still survive — dropping them silently would
  // leave a story looking verified against nothing.
  const per = { gotransit: ['go-1', 'go-2'], upexpress: ['up-1'], metrolinx: ['mx-1'] };

  it('falls back to every key present', () => {
    expect(unionCriteria(per, undefined).sort()).toEqual(['go-1', 'go-2', 'mx-1', 'up-1']);
  });

  it('an empty order array is treated as no order, not as "no lanes"', () => {
    // [] must not mean "include nothing" — that would blank the story's criteria entirely.
    expect(unionCriteria(per, []).sort()).toEqual(['go-1', 'go-2', 'mx-1', 'up-1']);
  });

  it('a non-array order is ignored rather than throwing', () => {
    expect(unionCriteria(per, 'gotransit' as never).sort()).toEqual(['go-1', 'go-2', 'mx-1', 'up-1']);
  });

  it('an order naming a codeline with no entry contributes nothing and does not throw', () => {
    expect(unionCriteria(per, ['gotransit', 'never-ran'])).toEqual(['go-1', 'go-2']);
  });

  it('duplicates across lanes collapse, first-seen order wins', () => {
    expect(unionCriteria({ a: ['x', 'y'], b: ['y', 'z'] }, ['a', 'b'])).toEqual(['x', 'y', 'z']);
  });

  it('no lanes at all yields an empty list', () => {
    expect(unionCriteria({}, undefined)).toEqual([]);
  });
});

describe('concatFindings without a codeline order', () => {
  const per = {
    gotransit: [{ file: 'go.ts' }],
    upexpress: [{ file: 'up.ts' }],
  };

  it('falls back to every key present', () => {
    expect(concatFindings(per, undefined).map((f: { file: string }) => f.file).sort())
      .toEqual(['go.ts', 'up.ts']);
  });

  it('an empty order array includes every lane', () => {
    expect(concatFindings(per, [])).toHaveLength(2);
  });

  it('the same file in two codelines is kept twice', () => {
    // Deliberate: a shared file needs the same change in each checkout, and collapsing the
    // entries would leave one writer with no instruction.
    const dup = { a: [{ file: 'shared.ts', codeline: 'a' }], b: [{ file: 'shared.ts', codeline: 'b' }] };
    expect(concatFindings(dup, ['a', 'b'])).toHaveLength(2);
  });
});

describe('a lane PRD with nothing usable in it', () => {
  const canonical = () => ({
    stories: [{ id: 'S1', codelines: ['a', 'b'], verificationCriteria: ['keep-me'],
                verificationCriteriaPerCodeline: { a: ['keep-me'] } }],
  });

  it('a null lane PRD leaves canonical intact', () => {
    // A lane that died before writing its PRD must not erase the lanes that succeeded.
    const c = canonical();
    expect(mergeLaneIntoCanonical({ canonical: c, updated: null, codeline: 'b' }).stories[0]
      .verificationCriteria).toEqual(['keep-me']);
  });

  it('a lane PRD with no stories array leaves canonical intact', () => {
    const c = canonical();
    expect(mergeLaneIntoCanonical({ canonical: c, updated: {}, codeline: 'b' }).stories[0]
      .verificationCriteriaPerCodeline).toEqual({ a: ['keep-me'] });
  });

  it('a lane PRD whose stories is not an array is ignored', () => {
    const c = canonical();
    expect(mergeLaneIntoCanonical({ canonical: c, updated: { stories: 'nope' }, codeline: 'b' })
      .stories).toHaveLength(1);
  });

  it('a lane carrying only unrelated stories adds them without touching the existing one', () => {
    const c = canonical();
    const out = mergeLaneIntoCanonical({
      canonical: c, updated: { stories: [{ id: 'NEW-1', status: 'completed' }] }, codeline: 'b',
    });
    expect(out.stories.map((s: { id: string }) => s.id)).toEqual(['S1', 'NEW-1']);
    expect(out.stories[0].verificationCriteria).toEqual(['keep-me']);
  });
});

describe('a canonical PRD with no stories array', () => {
  it('does not throw, and the lane\'s stories become canonical\'s', () => {
    // Reachable on a first merge into a freshly synthesized PRD.
    const out = mergeLaneIntoCanonical({
      canonical: {}, updated: { stories: [{ id: 'S1', status: 'completed' }] }, codeline: 'a',
    });
    expect(out.stories).toHaveLength(1);
    expect(out.stories[0].id).toBe('S1');
  });

  it('an empty canonical and an empty lane produce an empty story list', () => {
    expect(mergeLaneIntoCanonical({ canonical: {}, updated: {}, codeline: 'a' }).stories).toEqual([]);
  });
});

describe('completedAt when the last lane did not stamp one', () => {
  it('is filled in rather than left null on a completed story', () => {
    // The story IS complete — every lane finished — so a missing timestamp from one lane must
    // not leave canonical claiming completion with no completion time, which reads downstream
    // as "never finished".
    const canonical = {
      stories: [{
        id: 'S1', codelines: ['a', 'b'],
        perCodeline: { a: { status: 'completed', completed: true, completedAt: '2026-08-09T00:00:00Z' } },
      }],
    };
    const out = mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'S1', status: 'completed', completed: true }] },  // no completedAt
      codeline: 'b',
    });
    const s = out.stories[0];
    expect(s.completed).toBe(true);
    expect(s.completedAt, 'a completed story with no completion time').toBeTruthy();
    expect(Number.isNaN(Date.parse(s.completedAt)), 'not a parseable timestamp').toBe(false);
  });

  it("a lane's own completedAt is preferred when it has one", () => {
    const canonical = {
      stories: [{
        id: 'S1', codelines: ['a', 'b'],
        perCodeline: { a: { status: 'completed', completed: true, completedAt: '2026-08-09T00:00:00Z' } },
      }],
    };
    const out = mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'S1', status: 'completed', completed: true, completedAt: '2026-01-02T03:04:05Z' }] },
      codeline: 'b',
    });
    expect(out.stories[0].completedAt).toBe('2026-01-02T03:04:05Z');
  });

  it('an incomplete story has no completedAt at all', () => {
    const canonical = { stories: [{ id: 'S1', codelines: ['a', 'b'] }] };
    const out = mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'S1', status: 'completed', completed: true, completedAt: 'x' }] },
      codeline: 'a',   // lane b has not run
    });
    expect(out.stories[0].completed).toBe(false);
    expect(out.stories[0].completedAt).toBeNull();
    expect(out.stories[0].status).toBe('in-progress');
  });
});

describe('the normalizers reject what a lane might really emit', () => {
  it('criteria: non-arrays, non-strings and blanks are dropped', () => {
    expect(normalizeCriteria(undefined)).toEqual([]);
    expect(normalizeCriteria(null)).toEqual([]);
    expect(normalizeCriteria('not an array' as never)).toEqual([]);
    expect(normalizeCriteria({ a: 1 } as never)).toEqual([]);
    expect(normalizeCriteria(['ok', '', '   ', 42, null, undefined, {}, []] as never)).toEqual(['ok']);
  });

  it('findings: only plain objects survive', () => {
    expect(normalizeFindings(undefined)).toEqual([]);
    expect(normalizeFindings('nope' as never)).toEqual([]);
    expect(normalizeFindings([{ file: 'a.ts' }, null, 'x', 42, [], undefined] as never))
      .toEqual([{ file: 'a.ts' }]);
  });

  it('an array of findings is not mistaken for a finding', () => {
    // Arrays are objects in JS; a nested array here would corrupt every downstream consumer
    // that reads .file off each entry.
    expect(normalizeFindings([[{ file: 'a.ts' }]] as never)).toEqual([]);
  });
});
