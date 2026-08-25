/**
 * AN ABSENT VERDICT IS NOT AN APPROVAL — AND IS NOT PERSISTED AS ONE.
 *
 * spec-mode-runner.js wrote the coordinator's review into the story like this:
 *
 *   coordinatorReview: { verdict: review.verdict || 'approved', ... }
 *
 * A review that returned no verdict — because it produced prose, or failed, or was never really
 * run — was recorded on disk as `approved`. That record is read back on later passes
 * (`existingSpec.coordinatorReview`) and summarised into the run report, so a review that never
 * happened becomes a durable approval that nothing downstream can distinguish from a real one.
 *
 * This is the third instance of one shape found on 2026-08-24: `nothing_to_review` treated as a
 * defective roster, `warn` aggregated into `sound`, and an unparseable prd-change-review reported
 * as `pass`. A gate has THREE outcomes — passed, failed, did not run — and the third keeps
 * collapsing into the first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');

/**
 * Asserted against the SOURCE deliberately.
 *
 * The write sits deep inside runSpecCoordinator, behind a model call, a mandate check and a
 * snapshot — reaching it from a unit test would mean stubbing most of the pass, and the stub
 * would encode my assumptions rather than the pipeline's behaviour. What must be true is narrow
 * and structural: no persisted verdict field may default to a passing word. That IS checkable
 * here, and the companion behavioural assertions live in
 * an-unrecognised-verdict-is-not-a-pass.test.ts and a-gate-that-cannot-judge-does-not-pass.test.ts.
 */
const src = () => readFileSync(RUNNER, 'utf8');

describe('no verdict is persisted with a passing default', () => {
  it('coordinatorReview does not default its verdict to approved', () => {
    expect(src(),
      "`review.verdict || 'approved'` records a review that returned nothing as an approval")
      .not.toMatch(/verdict:\s*review\.verdict\s*\|\|\s*'approved'/);
  });

  it('no verdict field anywhere defaults to a passing word', () => {
    // The class, not the site. Any `verdict: <expr> || 'pass|approved|sound|ok'`.
    const bad = [...src().matchAll(/verdict:\s*[^,\n]*\|\|\s*'(approved|pass|passed|sound|ok|clean)'/g)]
      .map((m) => m[0]);
    expect(bad, `verdict field(s) defaulting to a passing value: ${bad.join(' | ')}`).toEqual([]);
  });

  it('the absent case is recorded as its own outcome', () => {
    // Whatever replaces it must NAME the absence rather than silently choosing a side.
    expect(src()).toMatch(/verdict:\s*review\.verdict\s*\|\|\s*'unreviewed'/);
  });
});
