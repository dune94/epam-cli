/**
 * THE REVIEW BATCH BUDGET IS DECLARED BY THE SEAM, NOT GUESSED IN CODE.
 *
 * spec-mode-runner.js sized the roster review with a literal:
 *
 *   const _budget = Math.max(4000, Number(process.env.EPAM_ROSTER_REVIEW_BATCH_CHARS || '60000'));
 *
 * The commit that introduced it said the batches were "sized by a declared budget, not guessed".
 * They were guessed. 60000 is measured against nothing, and project-roster-review — which declares
 * timeoutSecs, maxOutputTokens and reasoningEffort in invocation-profiles.json — declared no budget
 * at all.
 *
 * The number had teeth. The canonical and derived rosters together are ~276KB, so a 60000-character
 * budget produced six model calls. The aggregation then failed the WHOLE review if any one of those
 * six answered off-schema, and on 2026-09-01 that is exactly what happened: a clean batch carrying
 * real findings was discarded because a sibling was unusable, the judge was retried three times at
 * six calls each, and the mint failed. Every extra batch is another chance to draw a bad answer.
 *
 * Declared at 300000, the roster fits in ONE call and the failure mode has nowhere to occur.
 *
 * NO DEFAULT. A seam that declares no budget is a seam nobody sized, and inventing a number in code
 * is how the literal arrived the first time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
const PROFILES = join(REPO, 'orchestrations/agents/profiles.json');

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const seam = (registry.profiles || registry)['project-roster-review'];
const source = readFileSync(RUNNER, 'utf8');

describe('the review batch budget is declared, not hardcoded', () => {
  it('the seam declares it, beside the rest of its own sizing', () => {
    expect(seam, 'project-roster-review is not in the registry').toBeTruthy();
    expect(typeof seam.reviewBatchChars, 'the seam declares no reviewBatchChars').toBe('number');
    expect(seam.reviewBatchChars).toBeGreaterThanOrEqual(4000);
  });

  it('and says WHY, so the next reader does not replace it with a guess', () => {
    expect(seam._why_reviewBatchChars, 'the declared number carries no reason').toBeTruthy();
  });

  it('THE LITERAL IS GONE from the runner', () => {
    // The specific shape that was there. A number in code is a number nobody declared.
    expect(source, "the runner still falls back to a hardcoded 60000")
      .not.toMatch(/EPAM_ROSTER_REVIEW_BATCH_CHARS\s*\|\|\s*['"]60000['"]/);
    expect(source, 'the runner reads the seam declaration').toMatch(/reviewBatchChars/);
  });

  it('a seam with no declared budget is REFUSED, not defaulted', () => {
    // The fail-open this replaces: picking a number here is exactly how the literal got in.
    const at = source.indexOf('_declaredBudget');
    expect(at, 'the declared-budget read is missing').toBeGreaterThan(-1);
    const block = source.slice(at, at + 700);
    expect(block, 'an undeclared budget silently falls back to something')
      .toMatch(/review_failed/);
    expect(block, 'the refusal does not say what to declare').toMatch(/reviewBatchChars/);
  });

  it('THE POINT OF THE NUMBER: the whole roster fits in ONE call', () => {
    // Six batches meant six chances of a flaky answer, and the aggregation used to discard the
    // entire review on any one of them. One batch removes the failure mode rather than softening it.
    const profiles = JSON.parse(readFileSync(PROFILES, 'utf8'));
    const agents = profiles.agents || profiles.profiles || profiles;
    const canonicalPlusDerived = JSON.stringify(agents).length * 2;
    expect(canonicalPlusDerived, 'the roster is unexpectedly tiny; this proves nothing')
      .toBeGreaterThan(100000);
    expect(Math.ceil(canonicalPlusDerived / seam.reviewBatchChars),
      `${canonicalPlusDerived} chars against a ${seam.reviewBatchChars} budget still needs more than one call`)
      .toBe(1);
  });
});
