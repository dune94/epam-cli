/**
 * A REVIEWER THAT COULD NOT JUDGE HAS NOT APPROVED ANYTHING.
 *
 * The spec-pass review had three outcomes and handled two. 'fail' reverted the change — restoring
 * the story's acceptance criteria, description, title and technicalNotes, dropping any new stories.
 * 'pass' kept it. 'unreviewed' matched neither: the loop retried twice, wrote a `reviewer_unjudged`
 * event, and fell through to acceptance.
 *
 * That event is written and read by nothing — grep the tree. A logged block that does not block, on
 * a gate guarding PRD mutations: three attempts producing no judgement, and the change stands.
 *
 * The decision is now named, exported and asserted here rather than expressed as a single `===`
 * comparison buried in a 10,000-line runner, because that is how it came to be stated in two places
 * and to disagree with itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { reviewOutcomeKeepsChange } = require(RUNNER);

describe('a reviewer that could not judge has not approved anything', () => {
  it('the decision is exported, so it can be asserted at all', () => {
    expect(typeof reviewOutcomeKeepsChange,
      'the decision is inline again — it cannot be tested where it lives').toBe('function');
  });

  it('only an explicit pass keeps the change', () => {
    expect(reviewOutcomeKeepsChange('pass'), 'an approved change was reverted').toBe(true);
    expect(reviewOutcomeKeepsChange('fail'), 'a rejected change was kept').toBe(false);
    expect(reviewOutcomeKeepsChange('unreviewed'),
      'a change nobody could judge was kept — "we could not tell" is not "it is fine"').toBe(false);
  });

  it('and anything unrecognised is treated as not-approved', () => {
    // A verdict the reviewer has never emitted must not become an approval by default. This is the
    // direction that fails safe: a new outcome added upstream reverts until somebody decides.
    for (const v of ['', 'PASS', 'approved', 'error', 'timeout', undefined as never, null as never]) {
      expect(reviewOutcomeKeepsChange(v as never),
        `'${String(v)}' was treated as an approval`).toBe(false);
    }
  });

  it('the call site asks the question rather than testing one value', () => {
    // The receiver. Exporting a correct decision that nothing calls is the shape of a library with
    // a test and no caller — which this repo has shipped before.
    const src = readFileSync(RUNNER, 'utf8');
    expect(src, 'the call site no longer consults the decision')
      .toMatch(/if \(!reviewOutcomeKeepsChange\(reviewResult\.verdict\)\)/);
    expect(src, 'the old single-value comparison is back at the revert site')
      .not.toMatch(/\n\s*if \(reviewResult\.verdict === 'fail'\) \{/);
  });

  it('rejection and silence stay tellable apart in the record', () => {
    // Both revert, but they are different events: one is a judgement, the other is its absence.
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toMatch(/reviewResult\.verdict === 'fail' \? 'reviewer_rejected' : 'reviewer_unjudged'/);
  });
});
