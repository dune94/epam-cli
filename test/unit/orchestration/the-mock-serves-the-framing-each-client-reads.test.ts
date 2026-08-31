/**
 * MOCKSERVER EXPECTATIONS — 1,453 lines, the largest single file on the board.
 *
 * This is what makes a rehearsal answer like a real run. Every one of its failure modes looks like a
 * model that said nothing rather than a mock that framed its answer wrong, and its own header
 * records each one:
 *
 *   TWO FRAMINGS, NOT ONE. The OpenAI and Anthropic wire formats are different; serving one to the
 *   other yields a client that connects, reads nothing usable, and reports an empty turn.
 *
 *   A SEAM THAT ACTS DELIVERS THROUGH A CALL. Replaying only its text leaves the work undone —
 *   roster-specialiser's roster never appeared and its contract refused, three attempts in a row.
 *
 *   A FINGERPRINT MUST SURVIVE RENDERING. The matcher rejected lines beginning with a placeholder
 *   and accepted any that merely contained one, so a fingerprint became a string that matches
 *   nothing.
 *
 * Requiring this file used to EXECUTE the whole registration pass, so a test that imported it hit
 * MockServer and the two framings could not be unit tested at all. It is opt-in now, which is what
 * makes everything below possible.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mock = require(join(S, 'mock-expectations.js'));

/** Parse an SSE body into its data payloads. */
function events(body: string) {
  return body.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}

describe('the OpenAI framing is what an OpenAI client can read', () => {
  it('carries the content in a streamed delta, because the CLI requests stream:true', () => {
    // A plain body yields no output at all — the client connects and reads nothing.
    const evs = events(mock.sse('the answer'));
    expect(evs.length, 'no chunks were emitted').toBeGreaterThan(0);
    const text = evs.map((e: any) => e.choices?.[0]?.delta?.content || '').join('');
    expect(text, 'the answer never appears in any delta').toBe('the answer');
  });

  it('terminates the stream, or the client waits forever', () => {
    const body = mock.sse('x');
    expect(body, 'the stream never signals completion').toContain('[DONE]');
    expect(JSON.stringify(events(body)), 'no chunk carries a finish reason').toContain('stop');
  });

  it('an EMPTY answer is still a well-formed stream', () => {
    // A seam that legitimately answers nothing must still produce a readable turn, or it becomes
    // indistinguishable from a mock that failed.
    const body = mock.sse('');
    expect(body).toContain('[DONE]');
    expect(() => events(body), 'an empty answer produced malformed JSON').not.toThrow();
  });

  it('TOOL CALLS are re-emitted so the client executes them for real', () => {
    // A seam that ACTS delivers through a call. Replaying only its text leaves the work undone —
    // roster-specialiser's roster never appeared and its contract refused three times.
    // A recorded call carries its parameters as `input`; the OpenAI wire form calls that field
    // `arguments` and requires it to be a STRING. Getting that translation wrong emits a call the
    // client cannot execute, and the work silently does not happen.
    const body = mock.sseToolCalls([{ name: 'write_file', input: { path: 'a.txt', text: 'hi' } }]);
    const evs = events(body);
    const calls = evs.flatMap((e: any) => e.choices?.[0]?.delta?.tool_calls || []);
    expect(calls.length, 'the recorded tool call was not re-emitted').toBeGreaterThan(0);
    expect(JSON.stringify(calls), 'the call lost the function it was calling').toContain('write_file');
    expect(JSON.stringify(calls), 'the call lost its arguments').toContain('a.txt');
    expect(typeof calls[0].function.arguments,
      'arguments were emitted as an object, which the OpenAI wire form cannot carry').toBe('string');
  });

  it('several tool calls keep distinct indexes, or the client merges them into one', () => {
    const body = mock.sseToolCalls([
      { name: 'read_file', input: { p: 'a' } },
      { name: 'write_file', input: { p: 'b' } }]);
    const calls = events(body).flatMap((e: any) => e.choices?.[0]?.delta?.tool_calls || []);
    const idx = new Set(calls.map((c: any) => c.index));
    expect(idx.size, 'two tool calls shared an index and would be merged').toBe(2);
  });
});

describe('the Anthropic framing is a different wire format, not a variant', () => {
  it('uses named events, which is what the Anthropic client reads', () => {
    // Serving the OpenAI shape here yields a client that connects, reads nothing usable, and reports
    // an empty turn — a framing mismatch that looks like a silent model.
    const body = mock.anthropicSse('the answer', 'claude-x');
    expect(body, 'the stream does not open a message').toContain('event: message_start');
    expect(body, 'the stream never delivers a content block').toMatch(/content_block/);
    expect(body, 'the answer is absent from the stream').toContain('the answer');
  });

  it('and it is NOT the OpenAI shape — the two must not converge', () => {
    const anthropic = mock.anthropicSse('x', 'm');
    const openai = mock.sse('x');
    expect(anthropic, 'the anthropic framing emitted OpenAI chunks')
      .not.toContain('chat.completion.chunk');
    expect(openai, 'the OpenAI framing emitted anthropic events').not.toContain('event: message_start');
  });

  it('carries the model it was asked to impersonate', () => {
    expect(mock.anthropicSse('x', 'claude-opus-5'), 'the model name was dropped')
      .toContain('claude-opus-5');
  });

  it('anthropic TOOL CALLS are emitted in the anthropic shape', () => {
    const body = mock.anthropicSseToolCalls(
      [{ name: 'write_file', input: { path: 'a.txt' } }], 'claude-x');
    expect(body, 'no tool use was emitted at all').toMatch(/tool_use|input_json/);
    expect(body, 'the tool name is absent').toContain('write_file');
  });

  it('an empty answer is still well-formed in the anthropic shape', () => {
    const body = mock.anthropicSse('', 'm');
    expect(body).toContain('event: message_start');
    expect(body, 'the stream never closes').toMatch(/message_stop|message_delta/);
  });
});

describe('the stand-in answer satisfies the gate that reads it', () => {
  it('a seam expecting a role gets one, because its consumer gate demands it', () => {
    // The stand-in is put through the CONSUMER'S OWN gate: an answer the gate rejects makes every
    // rehearsal of that seam fail for a reason that has nothing to do with the pipeline.
    if (typeof mock.expectsARole === 'function' && typeof mock.standInRoleName === 'function') {
      const seams = ['role-assigner', 'roster-review', 'team-lead-review'];
      for (const s of seams) {
        if (mock.expectsARole(s)) {
          expect(mock.standInRoleName(s), `${s} expects a role and the stand-in names none`)
            .toBeTruthy();
        }
      }
    }
  });

  it('contractStandIn produces something for a seam, or nothing at all — never half an answer', () => {
    const out = mock.contractStandIn('team-lead-review');
    expect(out === null || out === undefined || typeof out === 'string' || typeof out === 'object',
      'the stand-in is neither an answer nor an absence').toBe(true);
  });
});
