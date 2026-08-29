/**
 * THE ANSWER IS THE ANSWER, WHATEVER THE MODEL WRAPPED IT IN.
 *
 * metrolinx AMSD-1919 halted three times on 2026-08-29 with:
 *
 *   the answer was 3885 characters long and did not parse.
 *   Last rejection: the response had no "proposedAgents" array.
 *   [{"proposedAgents":[{"name":"checkout-forms-engineer","kind":"implementer",...
 *
 * The answer is visibly present. unwrapEnvelope removes a one-element array and returns the
 * payload untouched for anything else — `payload.length !== 1` — so the moment a model emits the
 * answer alongside any second element, or nests it one layer deeper, the parser reports that the
 * key is absent when it is not. The run then dies after discovery, minting and a grounded roster
 * review have all succeeded, and the whole ticket is abandoned over packaging.
 *
 * Removing an envelope is not the same as accepting a wrong answer: every field is still validated
 * by the caller exactly as before. This only decides WHERE the answer is.
 */
import { describe, it, expect } from 'vitest';

const { unwrapEnvelope } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

const AGENTS = [{ name: 'checkout-forms-engineer', kind: 'implementer' }];

describe('the answer is found in any envelope', () => {
  it('unwraps the one-element array (the shape already handled)', () => {
    const out = unwrapEnvelope([{ proposedAgents: AGENTS }], 'proposedAgents');
    expect(out.proposedAgents).toEqual(AGENTS);
  });

  it('finds the answer when the model emits a SECOND element beside it', () => {
    const out = unwrapEnvelope(
      [{ proposedAgents: AGENTS }, { note: 'I also considered a detective.' }],
      'proposedAgents',
    );
    expect(out.proposedAgents).toEqual(AGENTS);
  });

  it('finds the answer when it is not the first element', () => {
    const out = unwrapEnvelope(
      [{ thinking: 'surveying the codeline' }, { proposedAgents: AGENTS }],
      'proposedAgents',
    );
    expect(out.proposedAgents).toEqual(AGENTS);
  });

  it('finds the answer nested one layer deeper', () => {
    const out = unwrapEnvelope([[{ proposedAgents: AGENTS }]], 'proposedAgents');
    expect(out.proposedAgents).toEqual(AGENTS);
  });

  it('leaves a payload that genuinely lacks the key alone', () => {
    // The negative: unwrapping must never invent an answer. A payload with no such key comes back
    // untouched so the caller still rejects it.
    const nothing = [{ somethingElse: 1 }, { alsoNot: 2 }];
    expect(unwrapEnvelope(nothing, 'proposedAgents')).toEqual(nothing);
  });

  it('does not merge two competing answers', () => {
    // Two elements each claiming the key is an ambiguity nobody decided. Returning the payload
    // untouched makes the caller reject it, which is the safe reading.
    const two = [{ proposedAgents: AGENTS }, { proposedAgents: [] }];
    expect(unwrapEnvelope(two, 'proposedAgents')).toEqual(two);
  });
});
