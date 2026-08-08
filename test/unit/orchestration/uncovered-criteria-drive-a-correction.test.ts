/**
 * A COVERAGE GAP MUST DRIVE THE CORRECTION IT ALREADY HAS.
 *
 * The pipeline computes whether every verification criterion is addressed by some fix site,
 * and it has a bounded corrective re-invocation of the detective. They were never connected.
 *
 * The re-invocation fires on ONE trigger: review.planAlignment === 'unexplained_mismatch' —
 * the detective diverging from its own plan. Coverage is computed on the line after and
 * recorded on the story. Live 2026-08-08 (AMSD-2041): three lanes each reported uncovered
 * criteria — "real-time onEntryChange React subscriptions not covered by any fix site",
 * "error/disconnect handling (criterion 6) not addressed" — and the run proceeded to the
 * writer gate with a manifest missing the feature's actual mechanism. The observation was
 * printed by the COST ESTIMATOR as a pricing risk and consumed by nothing.
 *
 * Same lesson as the roster: a reviewer whose findings nothing consumes is a critic. This is
 * that fix one layer down, reusing the machinery rather than adding more.
 *
 * The decision is a pure function so it can be tested without running the pipeline.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const MISMATCH = { planAlignment: 'unexplained_mismatch' };
const ALIGNED = { planAlignment: 'aligned' };
const COVERED = { complete: true, uncoveredVerificationCriteria: [] };
const GAPS = {
  complete: false,
  uncoveredVerificationCriteria: [
    'content refreshes without a page reload',
    'errors are surfaced when the connection drops',
  ],
};
const UNKNOWN = { complete: null, uncoveredVerificationCriteria: [], reason: 'no derived vocabulary' };

describe('the fixture is real', () => {
  it('the decision is exported', () => {
    expect(typeof spec.detectiveCorrectionNeeded).toBe('function');
  });
});

describe('the existing trigger is preserved', () => {
  it('an unexplained plan/execution mismatch still corrects', () => {
    const d = spec.detectiveCorrectionNeeded({ review: MISMATCH, coverage: COVERED, brownfield: true });
    expect(d.correct).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/plan/i);
  });

  it('an aligned review with full coverage does not correct', () => {
    expect(spec.detectiveCorrectionNeeded({ review: ALIGNED, coverage: COVERED, brownfield: true }).correct)
      .toBe(false);
  });
});

describe('THE FIX: uncovered criteria also correct', () => {
  it('a coverage gap triggers the correction even when the plan aligned', () => {
    const d = spec.detectiveCorrectionNeeded({ review: ALIGNED, coverage: GAPS, brownfield: true });
    expect(
      d.correct,
      'the manifest reaches the writer missing the criteria nobody prescribed a site for',
    ).toBe(true);
  });

  it('the uncovered criteria are carried as corrective context, not just a flag', () => {
    // "Try again" reproduces the same answer. The detective has to be told WHAT is missing.
    const d = spec.detectiveCorrectionNeeded({ review: ALIGNED, coverage: GAPS, brownfield: true });
    expect(d.uncovered).toEqual(GAPS.uncoveredVerificationCriteria);
  });

  it('both triggers together still correct once, with both reasons', () => {
    const d = spec.detectiveCorrectionNeeded({ review: MISMATCH, coverage: GAPS, brownfield: true });
    expect(d.correct).toBe(true);
    expect(d.reasons.length).toBe(2);
  });
});

describe('it does not fire on an unmeasured gap', () => {
  it('coverage of unknown does NOT trigger a correction', () => {
    // complete === null means no vocabulary was available and coverage was never computed.
    // Correcting against a gap nobody measured spends a model call to chase nothing.
    expect(spec.detectiveCorrectionNeeded({ review: ALIGNED, coverage: UNKNOWN, brownfield: true }).correct)
      .toBe(false);
  });

  it('a missing coverage object is treated as unmeasured, not as a gap', () => {
    expect(spec.detectiveCorrectionNeeded({ review: ALIGNED, coverage: null, brownfield: true }).correct)
      .toBe(false);
  });
});

describe('scope is unchanged', () => {
  it('greenfield never corrects — the detective is a brownfield step', () => {
    expect(spec.detectiveCorrectionNeeded({ review: MISMATCH, coverage: GAPS, brownfield: false }).correct)
      .toBe(false);
  });
});

describe('the uncovered criteria REACH the agent', () => {
  // Carrying them in the decision object is not enough: the corrective block rendered the
  // plan, the prior findings and the review notes, and would have dropped these on the floor.
  // A correction the agent is never told about is a re-sample of the same answer.
  const render = () => spec.renderDetectiveCorrection({
    priorPlan: 'I will trace the client setup',
    priorFindings: [{ file: 'src/services/client.ts' }],
    reviewNotes: '',
    uncoveredCriteria: [
      'content refreshes without a page reload',
      'errors are surfaced when the connection drops',
    ],
  });

  it('every uncovered criterion appears verbatim', () => {
    const t = render();
    expect(t).toContain('content refreshes without a page reload');
    expect(t).toContain('errors are surfaced when the connection drops');
  });

  it('it says what is wrong with the previous answer, in terms of coverage', () => {
    // the claim, not one phrasing of it: some criteria have no site that would satisfy them
    expect(render()).toMatch(/no site[^.]*(produce|address|cover|satisf)|not (addressed|covered)/i);
  });

  it('it asks for sites that close them, not a re-explanation', () => {
    expect(render()).toMatch(/add|find|name/i);
  });

  it('it keeps what it already got right rather than starting over', () => {
    // A correction that discards good sites trades one gap for another.
    expect(render()).toMatch(/keep|retain|in addition|as well as/i);
  });

  it('with no uncovered criteria the block does not invent a coverage complaint', () => {
    const t = spec.renderDetectiveCorrection({
      priorPlan: 'p', priorFindings: [], reviewNotes: 'diverged from plan', uncoveredCriteria: [],
    });
    expect(t).not.toMatch(/verification criteri(a|on) (that )?no/i);
  });
});
