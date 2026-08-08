/**
 * Cycle-time investigation, 2026-07-31 (mock1 run comparison): the spec
 * coordinator-review call's wall time varied 17s-4m36s across otherwise
 * near-identical mock1 runs. Root cause traced by code inspection, not
 * profiling: for a brownfield run (EPAM_BROWNFIELD=1), 2 of its 4 stated
 * review criteria are structurally void —
 *   - "are story splits logical" — spec-mode-runner.js's EPAM_BROWNFIELD
 *     guard unconditionally deletes any splitStories payload from every
 *     agent before this review ever runs, so splitChildren is always empty.
 *   - "are the ACs complete/testable/non-overlapping" — applySpecChanges()
 *     calls preserveDefectAcceptanceCriteria() as a universal brownfield
 *     backstop, forcing story.acceptanceCriteria back to the ticket's
 *     immutable original regardless of what openspec/speckit proposed.
 * Asking the LLM to judge two things the code already guarantees can't have
 * happened wastes context/reasoning and was worth narrowing. Greenfield
 * (EPAM_BROWNFIELD unset/not '1') is untouched — splits and AC elaboration
 * are real, judged behavior there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8',
);

function extractCoordinatorReviewBlock(): string {
  const start = SRC.indexOf('// ── Step 4: Coordinator review pass');
  const end = SRC.indexOf('// ── Step 5: Model adequacy re-assessment');
  expect(start, 'Step 4 coordinator review block not found').toBeGreaterThan(-1);
  expect(end, 'Step 5 marker not found').toBeGreaterThan(-1);
  return SRC.slice(start, end);
}

describe('spec coordinator-review — brownfield-aware criteria (cycle-time fix)', () => {
  const block = extractCoordinatorReviewBlock();

  it('branches the review criteria and payload on EPAM_BROWNFIELD', () => {
    expect(block).toMatch(/isBrownfieldReview\s*=\s*process\.env\.EPAM_BROWNFIELD\s*===\s*'1'/);
  });

  it('the brownfield criteria list drops split-quality and AC-completeness, keeps value-add and human-review flag', () => {
    const idx = block.indexOf('const reviewCriteria = isBrownfieldReview');
    expect(idx).toBeGreaterThan(-1);
    const brownfieldBranch = block.slice(idx, block.indexOf(': `For each story', idx));
    expect(brownfieldBranch).toMatch(/Did both agents add meaningful, non-overlapping value/);
    expect(brownfieldBranch).toMatch(/Flag any story needing human review/);
    expect(brownfieldBranch).not.toMatch(/acceptance criteria are complete/);
    expect(brownfieldBranch).not.toMatch(/story splits.*logical/);
    // Explains WHY to the model, not just a silent omission — a model told
    // nothing about splits/ACs could still hallucinate an opinion on them.
    expect(brownfieldBranch).toMatch(/never split/);
    expect(brownfieldBranch).toMatch(/immutable/);
  });

  it('the greenfield criteria list is unchanged — still all 4 original criteria', () => {
    const elseIdx = block.indexOf(': `For each story');
    expect(elseIdx).toBeGreaterThan(-1);
    const greenfieldBranch = block.slice(elseIdx, elseIdx + 500);
    expect(greenfieldBranch).toMatch(/Did both agents add meaningful, non-overlapping value/);
    expect(greenfieldBranch).toMatch(/Are the acceptance criteria complete, testable, and non-overlapping/);
    expect(greenfieldBranch).toMatch(/Are story splits logical and properly scoped/);
    expect(greenfieldBranch).toMatch(/Flag any story needing human review/);
  });

  /**
   * EXECUTED, not grepped. This used to slice the source for
   * `const reviewPayload = JSON.stringify(` and match a regex against the surrounding
   * text — so it broke the moment that construction was extracted into
   * buildReviewPayload(), while the BEHAVIOUR it cares about was unchanged. A test that
   * reads source text asserts how code is written, not what it does. It now builds a real
   * payload and inspects it.
   */
  it('omits the always-empty splitChildren field from the payload in brownfield (never populated there anyway)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildReviewPayload } = require('../../../orchestrations/scripts/spec-mode-runner.js');
    const parent = { id: 'P1', title: 't', acceptanceCriteria: [], specification: {} };
    const child = { id: 'C1', title: 'c', acceptanceCriteria: ['a'], specification: { createdFrom: 'P1' } };

    const brownfield = JSON.parse(buildReviewPayload([parent], true, [parent, child]));
    expect(brownfield[0]).not.toHaveProperty('splitChildren');

    const greenfield = JSON.parse(buildReviewPayload([parent], false, [parent, child]));
    expect(greenfield[0].splitChildren, 'greenfield must still receive its split children')
      .toHaveLength(1);
    expect(greenfield[0].splitChildren[0].id).toBe('C1');
  });

  it('the prompt still interpolates whichever criteria list was selected', () => {
    expect(block).toMatch(/\$\{reviewCriteria\}/);
  });

  it('the output JSON schema is unchanged regardless of mode (storyId/verdict/reviewNotes/qualityScore/flags/planAlignment)', () => {
    // planAlignment added 2026-08-05 (the reviewer's own judgment on detective plan/answer
    // consistency) — the invariant under test is that ONE schema serves both modes, which
    // still holds; only its content grew.
    expect(block).toMatch(
      // flags grew from bare slugs to objects carrying severity and the evidence behind the
      // call (2026-08-07) — severity is advisory metadata, not what the gate blocks on.
      // The invariant under test is unchanged: ONE schema serves both modes.
      /\{"storyId":"REM-xxx","verdict":"approved\|needs_review","reviewNotes":"coordinator observations","qualityScore":0\.0-1\.0,"flags":\[\{"flag":"short-slug","severity":"blocking\|advisory","why":"[^"]*"\}\],"planAlignment":"aligned\|justified_deviation\|unexplained_mismatch\|not_applicable"\}/,
    );
  });
});
