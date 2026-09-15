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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mock-expectations.js'), 'utf8');

// Requiring is now SAFE: the module guards its main with `if (require.main !== module) return;`
// so importing it registers nothing and touches no server.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const b = require('../../../orchestrations/scripts/mock-expectations.js');

// THE STAND-IN RUNS ON ITS OWN SET. Its wire shape (fragment size, chunk size) is that set's
// declaration; on any other set the framing refuses, as it should.
const priorSet = process.env.EPAM_PROVIDER_SET;
beforeAll(() => { process.env.EPAM_PROVIDER_SET = 'mockserver'; });
afterAll(() => { if (priorSet === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = priorSet; });

/** The `data:` payloads of an SSE body, parsed. */
const events = (sse: string) => sse.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));

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

  // AS THE VENDOR SENDS IT. Run 20260915T101555Z: MiniMax streamed a write_file's arguments in
  // fragments, the client's parser lost a slice at a read boundary, and 32 calls reached the tool
  // empty — while every harness cell was green, because the stand-in served each call whole in
  // one event. A stand-in that cannot produce the vendor's shape cannot find the vendor's bug.
  it('an OpenAI tool call is streamed as the vendor streams it: name first, arguments in fragments', () => {
    const content = 'x'.repeat(1000);
    const evs = events(b.sseToolCalls([{ name: 'write_file', input: { path: '/a.py', content } }]));
    const deltas = evs.map((e) => e.choices?.[0]?.delta?.tool_calls?.[0]).filter(Boolean);
    expect(deltas[0].function.name).toBe('write_file');
    expect(deltas[0].function.arguments, 'the first event names the tool and carries no arguments').toBe('');
    const pieces = deltas.slice(1).map((d) => d.function.arguments);
    expect(pieces.length, 'the arguments must arrive in more than one event').toBeGreaterThan(3);
    for (const p of pieces) expect(p.length, 'no single event carries the whole input').toBeLessThan(200);
    expect(JSON.parse(pieces.join(''))).toEqual({ path: '/a.py', content });
    expect(evs.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('an Anthropic tool call is streamed as the vendor streams it: input_json_delta in fragments', () => {
    const content = 'y'.repeat(1000);
    const evs = events(b.anthropicSseToolCalls([{ name: 'write_file', input: { path: '/b.py', content } }], 'm'));
    const pieces = evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.partial_json);
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) expect(p.length).toBeLessThan(200);
    expect(JSON.parse(pieces.join(''))).toEqual({ path: '/b.py', content });
  });

  it('the wire shape is the set\'s declaration, and every other set refuses it', () => {
    const w = b.wire();
    expect(w.argumentDeltaChars).toBeGreaterThan(0);
    expect(w.chunkBytes).toBeGreaterThan(0);
    process.env.EPAM_PROVIDER_SET = 'claude';
    try { expect(() => b.wire()).toThrow(/wire shape/); } finally { process.env.EPAM_PROVIDER_SET = 'mockserver'; }
  });
});
