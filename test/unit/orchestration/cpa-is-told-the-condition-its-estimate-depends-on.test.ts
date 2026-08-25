/**
 * CPA IS TOLD THE CONDITION ITS ESTIMATE DEPENDS ON.
 *
 * cpa-system.md asks for one field conditionally:
 *
 *   "iterationEstimate": <integer 5–200+, BROWNFIELD STORIES ONLY>
 *
 * and buildPrompt never tells the model whether the story IS brownfield. The word appears once in
 * cpa-inference.js — in a comment. So the model is asked for a field whose condition it cannot
 * evaluate, and it reasonably omits it.
 *
 * MEASURED, not inferred: across 1,817 records in orchestrations/logs/cpa-review.jsonl,
 * `iterationEstimate` was returned **zero** times (1,647 answers without it, 170 skipped). The
 * `|| 1` floor in cpa-inference.js:315 then turned that silence into the number 1, which is
 * indistinguishable from a genuine estimate of 1 — and 211 archived story records carry a budget
 * derived from it.
 *
 * Two things are asserted here: the condition reaches the prompt, and absence stays visible
 * afterwards, so "the model did not answer" can never again look like "the model answered 1".
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cpa = require(join(LIB, 'cpa-inference.js'));

// buildPrompt renders this project's copy of the seam prompt, so it needs a project to render
// for — the same requirement the pipeline satisfies at run time.
process.env.EPAM_PROJECT_CONFIG_DIR = process.env.EPAM_PROJECT_CONFIG_DIR
  || join(__dirname, '../../../orchestrations/projects/metrolinx');

const story = { id: 'X-1', title: 'a ticket', description: 'do a thing' };
// Asserted on the SECTION the prompt is composed from, not the rendered prompt: rendering needs
// this project's MINTED prompt copy, which a reset deletes — so a render-based test would fail
// for a reason unrelated to what it checks.
const build = (over: Record<string, unknown> = {}) => cpa.buildModeSection({ story, ...over });

describe('the brownfield condition reaches the estimator', () => {
  it('says the story is brownfield when it is', () => {
    const p = build({ brownfield: true });
    expect(p, 'the prompt never states the condition iterationEstimate depends on')
      .toMatch(/brownfield/i);
  });

  it('does not claim brownfield when it is not', () => {
    const p = build({ brownfield: false });
    expect(p).not.toMatch(/this is a BROWNFIELD story/i);
  });

  it('still builds a usable prompt either way', () => {
    expect(build({ brownfield: true }).length).toBeGreaterThan(50);
    expect(build({ brownfield: false }).length).toBeGreaterThan(20);
  });
});

describe('an absent estimate stays distinguishable from a real one', () => {
  const norm = (raw: Record<string, unknown>) => {
    const r = cpa.normaliseIterationEstimate((raw as { iterationEstimate?: unknown }).iterationEstimate);
    return { iterationEstimate: r.value, iterationEstimateProvided: r.provided };
  };

  it('exposes normaliseReview so the floor can be asserted at all', () => {
    expect(typeof cpa.normaliseIterationEstimate,
      'the clamp is unreachable from a test, so its behaviour cannot be pinned').toBe('function');
  });

  it('records that the model did NOT supply an estimate', () => {
    const r = norm({ confidence: 0.5 });
    expect(r.iterationEstimateProvided,
      'a missing estimate is recorded as though the model gave one').toBe(false);
  });

  it('records that the model DID supply one, and keeps the value', () => {
    const r = norm({ confidence: 0.5, iterationEstimate: 40 });
    expect(r.iterationEstimateProvided).toBe(true);
    expect(r.iterationEstimate).toBe(40);
  });

  it('a genuine estimate of 1 is distinguishable from silence', () => {
    // The exact confusion that hid this for 1,817 records.
    expect(norm({ iterationEstimate: 1 }).iterationEstimateProvided).toBe(true);
    expect(norm({}).iterationEstimateProvided).toBe(false);
    expect(norm({}).iterationEstimate).toBe(1); // floor preserved — it overrides nothing
  });

  it('still clamps a hallucinated value to the declared ceiling', () => {
    expect(norm({ iterationEstimate: 99999 }).iterationEstimate).toBe(500);
    expect(norm({ iterationEstimate: -5 }).iterationEstimate).toBe(1);
  });
});
