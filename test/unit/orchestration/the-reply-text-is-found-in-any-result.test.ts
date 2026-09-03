/**
 * THE COST SEAM ALREADY HOLDS THE REPLY; IT JUST NEVER READ IT.
 *
 * emitCostSnapshot reads the provider's whole JSON result to count tokens, so the completion has
 * been sitting in that same string the entire time the traces recorded out=4ch. Different runners
 * shape the result differently, exactly as they shape usage differently — and the token parser
 * already accepts input_tokens / inputTokens / input for that reason. This does the same for text.
 */
import { describe, it, expect } from 'vitest';

const { replyTextFrom } = require('../../../orchestrations/scripts/lib/cost-emitter.js');

describe('the reply text is found in any result shape', () => {
  it('finds a top-level result string', () => {
    expect(replyTextFrom({ result: '<PROJECT_AGENTS>{}</PROJECT_AGENTS>' }))
      .toBe('<PROJECT_AGENTS>{}</PROJECT_AGENTS>');
  });

  it('finds text in a content block list', () => {
    expect(replyTextFrom({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }))
      .toBe('one\ntwo');
  });

  it('finds a chat-style message body', () => {
    expect(replyTextFrom({ choices: [{ message: { content: 'answer' } }] })).toBe('answer');
  });

  it('finds a plain completion field', () => {
    expect(replyTextFrom({ completion: 'answer' })).toBe('answer');
  });

  it('keeps the reply WHOLE', () => {
    expect(replyTextFrom({ result: 'y'.repeat(3885) })).toHaveLength(3885);
  });

  it('returns empty when the result carries no text, rather than inventing one', () => {
    expect(replyTextFrom({ usage: { input_tokens: 5 } })).toBe('');
    expect(replyTextFrom(null)).toBe('');
    expect(replyTextFrom({ content: [] })).toBe('');
  });
});
