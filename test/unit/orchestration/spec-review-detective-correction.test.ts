/**
 * When SPEC_REVIEW flags planAlignment: "unexplained_mismatch" for a story, Step 4
 * (coordinator review, spec-mode-runner.js) re-invokes the code-graph-detective for that
 * SAME story inline — no pipeline abort, no waiting for a full re-run — with the
 * reviewer's own rejection reason threaded into the detective's prompt as corrective
 * context, mirroring the existing PRIOR COORDINATOR FLAGS pattern already used for
 * openspec/speckit re-elaboration.
 *
 * Bounded to ONE corrective re-invocation per story per spec pass — every other retry in
 * this file (the detective's own maxAttempts, iteration caps) is capped, never open-ended.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

function extractFunctionBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(0);
  const end = SRC.indexOf('\n}', start) + 2;
  return SRC.slice(start, end);
}

describe('runCodeGraphDetective accepts corrective context from a prior rejection', () => {
  it('the prompt template threads a correctiveContext block when provided', () => {
    const body = extractFunctionBody('runCodeGraphDetective');
    expect(body, 'must accept an opts param carrying corrective context').toMatch(/correctiveContext/);
  });

  // MOVED 2026-08-08 into renderDetectiveCorrection(), so this now asserts the RENDERED
  // OUTPUT rather than grepping the source of the enclosing function. The old form broke on a
  // pure refactor while the behaviour was intact — the brittleness this suite keeps paying for.
  it('the corrective block tells the model what its PLAN was and what the reviewer said', () => {
    const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
    const out = spec.renderDetectiveCorrection({
      priorPlan: 'I will trace the client setup',
      priorFindings: [{ file: 'src/services/client.ts' }],
      reviewNotes: 'diverged from the plan with no stated reason',
      uncoveredCriteria: [],
    });
    expect(out).toMatch(/REJECTED/i);
    expect(out, 'the model is not shown its own prior plan').toContain('I will trace the client setup');
    expect(out, 'the reviewer reason never reaches the model').toContain('diverged from the plan');
  });
});

describe('Step 4 (coordinator review) wires the correction back inline, bounded to one retry', () => {
  const start = SRC.indexOf('summary.stats.coordinatorReviewCompleted = true;');
  expect(start, 'Step 4 completion marker not found — used as an anchor').toBeGreaterThan(0);
  // Look at the whole coordinator-review block, from the review call through the stats line.
  const blockStart = SRC.lastIndexOf('const reviewPayload = buildReviewPayload(');
  const block = SRC.slice(blockStart, start + 100);

  it('re-invokes the detective for a story flagged unexplained_mismatch', () => {
    expect(block, 'must check for the unexplained_mismatch verdict').toMatch(/unexplained_mismatch/);
    expect(block, 'must call the detective again, not just log the flag').toMatch(/runCodeGraphDetective\(|runDetective\(/);
  });

  it('does not loop unboundedly — no while/recursive re-review of the correction', () => {
    // A crude but effective structural guard: the correction call must not be inside
    // anything that could re-invoke Step 4 itself.
    expect(block).not.toMatch(/while\s*\(/);
  });

  it('updates story.fixSiteAnalysis in place after a successful correction', () => {
    expect(block).toMatch(/\.fixSiteAnalysis\s*=/);
  });
});
