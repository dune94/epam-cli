/**
 * THE ROSTER DIFF DOES NOT INVENT A KIND.
 *
 * The diff is what an operator reads at the mint pause to see what this run created. It sorted
 * agents into "IMPLEMENTERS, may author code" and "INVESTIGATORS, read-only, never own a story"
 * using `(detail.get(n) || {}).kind || 'implementer'` — so an agent whose kind was never stated
 * was reported as one that may author code.
 *
 * It grants nothing: permission comes from membership in project-roles.json, and
 * project-roster.js refuses a roster entry whose kind is not one of the declared kinds. The defect
 * is in what the operator is TOLD — a default that resolves silence toward the more powerful
 * answer, in the one artefact whose job is to show what was made.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'), 'utf8');
const CODE = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('an unstated kind is reported as unstated', () => {
  it('does not default a missing kind to the one that may author code', () => {
    expect(CODE).not.toMatch(/\.kind\s*\|\|\s*'implementer'/);
  });

  it('the diff has a section for agents whose kind was not stated', () => {
    // Silence must be visible. Folding it into either column hides the roster's own gap.
    expect(CODE).toMatch(/KIND NOT STATED/);
  });
});
