/**
 * A PAYLOAD THE MODEL WRAPPED IN AN ARRAY IS STILL THE PAYLOAD.
 *
 * The agent-mint asked for {"proposedAgents": [...]} and got
 *
 *     [{"proposedAgents":[{"name":"commerce-checkout-engineer","kind":"implementer", ...}]}]
 *
 * — the right answer inside a single-element array. The parse looked for proposedAgents at the top
 * level, found an Array instead of an object, and rejected it. Three times, because a content
 * retry cannot change a shape the model considers correct: metrolinx AMSD-1919 died there on
 * 2026-08-29, after discovery, minting and a grounded roster review had all succeeded.
 *
 * Unwrapping ONE element is not leniency about content — every field is still validated afterwards,
 * and a two-element array is still refused, because that is a model that answered twice and we
 * cannot know which it meant.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { unwrapEnvelope } = require_(join(__dirname, '../../../orchestrations/scripts/lib/agent-output-schema.js'));

const payload = { proposedAgents: [{ name: 'commerce-checkout-engineer', kind: 'implementer' }] };

describe('A SINGLE-ELEMENT ENVELOPE IS UNWRAPPED', () => {
  it('THE DEFECT: the answer inside a one-element array is found', () => {
    expect(unwrapEnvelope([payload], 'proposedAgents'),
      'the mint rejected its own correct answer three times and killed the run')
      .toEqual(payload);
  });

  it('leaves an already-correct payload untouched', () => {
    expect(unwrapEnvelope(payload, 'proposedAgents')).toEqual(payload);
  });

  it('REFUSES a two-element array — that is a model that answered twice', () => {
    const two = [payload, payload];
    expect(unwrapEnvelope(two, 'proposedAgents'), 'we cannot know which answer was meant')
      .toEqual(two);
  });

  it('does not unwrap when the element lacks the expected key', () => {
    const other = [{ somethingElse: [] }];
    expect(unwrapEnvelope(other, 'proposedAgents')).toEqual(other);
  });

  it('handles a null or non-object payload without throwing', () => {
    expect(unwrapEnvelope(null, 'proposedAgents')).toBeNull();
    expect(unwrapEnvelope('text', 'proposedAgents')).toBe('text');
  });

  it('unwraps for any declared key, not just this one', () => {
    const assignments = { assignments: [{ storyId: 'S-1' }] };
    expect(unwrapEnvelope([assignments], 'assignments')).toEqual(assignments);
  });
});
