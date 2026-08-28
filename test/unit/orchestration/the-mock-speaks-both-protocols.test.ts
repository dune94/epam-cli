/**
 * TWO CLIENTS, TWO FRAMINGS. Serving one to the other is a silent nothing.
 *
 * The epam-run path speaks OpenAI chat-completions: `data: {...}` then `data: [DONE]`.
 * Claude Code speaks Anthropic Messages: named EVENTS and a `message_stop` terminator, with NO
 * [DONE] sentinel. A client given the wrong framing connects, reads nothing usable, and reports
 * an EMPTY TURN — which reads as a model that said nothing rather than a protocol mismatch.
 * That is the worst kind of mock failure: it looks like a finding about the run.
 *
 * The Anthropic shape asserted here is the one PROVEN against Claude Code on 2026-08-25
 * (is_error:false, result:"OK", stop_reason:"end_turn").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mock-expectations.js'), 'utf8');

// Requiring is now SAFE: the module guards its main with `if (require.main !== module) return;`
// so importing it registers nothing and touches no server.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const b = require('../../../orchestrations/scripts/mock-expectations.js');

describe('the mock speaks both protocols', () => {
  it('both Anthropic builders exist', () => {
    expect(b.anthropicSse, 'no Anthropic text builder').toBeTruthy();
    expect(b.anthropicSseToolCalls, 'no Anthropic tool-call builder').toBeTruthy();
    expect(b.sse, 'the OpenAI builder must remain — the other path still needs it').toBeTruthy();
  });

  it('the text stream carries named events and terminates with message_stop', () => {
    const out = b.anthropicSse('hello', 'claude-sonnet-5');
    for (const e of ['message_start', 'content_block_start', 'content_block_delta',
                     'content_block_stop', 'message_delta', 'message_stop']) {
      expect(out, `missing event: ${e}`).toContain(`event: ${e}`);
    }
    expect(out, 'the content must actually reach the client').toContain('hello');
    expect(out, 'Anthropic has NO [DONE] sentinel — that is the OpenAI shape')
      .not.toContain('[DONE]');
  });

  it('a tool-call turn stops with tool_use, NOT end_turn', () => {
    // A client told the turn ENDED will not execute the call it was just handed — the seam
    // then delivers nothing and its contract refuses, which is how roster-specialiser failed
    // three attempts running on the other path.
    const out = b.anthropicSseToolCalls([{ name: 'bash', input: { command: 'ls' } }], 'm');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"bash"');
    expect(out).toContain('input_json_delta');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out, 'end_turn would tell the client the work is done').not.toContain('"stop_reason":"end_turn"');
  });

  it('the two framings are NOT interchangeable — asserted, not assumed', () => {
    const anthropic = b.anthropicSse('x', 'm');
    const openai = b.sse('x');
    expect(openai).toContain('[DONE]');
    expect(openai).not.toContain('event: message_start');
    expect(anthropic).not.toContain('[DONE]');
  });
});
