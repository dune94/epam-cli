/**
 * A REFUSAL THE PRODUCER CANNOT ACT ON EARNS THE SAME ANSWER AGAIN.
 *
 * "seam 'implementer' is not declared in the registry" tells a model that its answer was wrong and
 * nothing about what a right one looks like. The retry re-asks the same model with the same brief,
 * so a rejection carrying no route out samples the same mistake three times — which is exactly what
 * the live run did before it was killed.
 *
 * The resolver can derive the correct seam from the agent's NAME. If the refusal is going to
 * happen, it should carry that answer.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const roster = require(join(REPO, 'orchestrations/scripts/lib/project-roster.js'));

const persona = 'You implement the story.';
const entry = (seam: string) => ({
  persona, kind: 'implementer', ancestor: 'checkout-form-engineer',
  derivedFromSha256: roster.personaDigest(persona), seam,
});

describe('a refusal names the seam the resolver derives', () => {
  it('an unresolvable seam is refused with the derived answer, not just a complaint', () => {
    const v = roster.checkEntry('checkout-form-engineer', entry('not-a-real-seam'),
      { 'checkout-form-engineer': persona });
    expect(v.ok).toBe(false);
    expect(v.reason, 'the refusal does not tell the producer what to use instead — the retry will '
      + 'draw the same wrong answer').toMatch(/story-writer/);
  });

  it('and still says what was wrong with what it was given', () => {
    const v = roster.checkEntry('checkout-form-engineer', entry('not-a-real-seam'),
      { 'checkout-form-engineer': persona });
    expect(v.reason).toMatch(/not-a-real-seam/);
  });
});
