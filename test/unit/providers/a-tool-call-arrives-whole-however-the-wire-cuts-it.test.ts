/**
 * A TOOL CALL ARRIVES WHOLE, HOWEVER THE WIRE CUTS IT.
 *
 * Run 20260915T101555Z, story REGI-001A, MiniMax-M3: 32 `write_file` calls reached the tool with
 * NO arguments. Langfuse shows the model emitted them (turn 365: 1,788 output tokens, 63 chars of
 * text, one tool call) and the tool got `{}` — "The paths[0] argument must be of type string.
 * Received undefined". Six attempts, 367 calls, $4.18, nothing delivered.
 *
 * The vendor streams a tool call as many `delta.tool_calls[].function.arguments` fragments, and
 * the HTTP body reaches us in reads that end wherever the socket happens to end them — inside an
 * SSE event as often as not. The parser split each read on '\n' and JSON.parsed each `data:` line
 * on its own, with no carry-over; both halves of a cut event failed to parse and were skipped, the
 * arguments lost a slice, the final JSON.parse failed, and `catch { return {} }` handed the tool an
 * empty call. Small calls survive because they fit in one read; a file's worth of content does
 * not. Every harness turn had passed because the stand-in delivered the whole call in one read.
 *
 * The events below are the OpenAI-compatible shape both vendors send. The read boundaries are the
 * point: one falls inside a `data:` line, one inside a multi-byte character.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider.js';
import { OpenRouterProvider } from '../../../src/providers/openrouter/OpenRouterProvider.js';
import type { ProviderRequest } from '../../../src/providers/types.js';

const REQ: ProviderRequest = {
  messages: [{ role: 'user', content: 'write the file' }],
  systemPrompt: 'be brief',
  tools: [{ name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } }],
};

/** The content the model wants written — long enough that no single read carries it. */
const CONTENT = 'def threshold() -> float:\n    return 0.70  # — default when unset\n'.repeat(40);
const ARGS = JSON.stringify({ path: '/out/regintel/config.py', content: CONTENT });

/** One OpenAI-compatible chunk. */
function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'x', object: 'chat.completion.chunk', model: 'MiniMax-M3',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** The vendor's framing: name first, then the arguments in fragments, then the finish and usage. */
function vendorEvents(): string {
  const pieces: string[] = [];
  for (let i = 0; i < ARGS.length; i += 97) pieces.push(ARGS.slice(i, i + 97));
  let s = chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] });
  for (const p of pieces) s += chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] });
  s += chunk({}, 'tool_calls');
  s += `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`;
  s += 'data: [DONE]\n\n';
  return s;
}

/** The body delivered in reads of `size` bytes — boundaries land inside events and inside the em dash. */
function readsOf(body: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

function fetchReturning(stream: ReadableStream<Uint8Array>) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: stream, text: async () => '' });
}

afterEach(() => vi.unstubAllGlobals());

const READ_SIZES = [1024, 333, 7];

describe('a tool call arrives whole, however the wire cuts it', () => {
  for (const size of READ_SIZES) {
    it(`MiniMax: reads of ${size} bytes deliver write_file with its path and content`, async () => {
      vi.stubGlobal('fetch', fetchReturning(readsOf(vendorEvents(), size)));
      const r = await new MiniMaxProvider('k').stream(REQ, () => {});
      const call = r.content.find((c) => c.type === 'tool_use');
      expect(call?.name).toBe('write_file');
      expect(call?.input).toEqual({ path: '/out/regintel/config.py', content: CONTENT });
      expect(r.stopReason).toBe('tool_use');
    });

    it(`OpenRouter: reads of ${size} bytes deliver write_file with its path and content`, async () => {
      vi.stubGlobal('fetch', fetchReturning(readsOf(vendorEvents(), size)));
      const r = await new OpenRouterProvider({ apiKey: 'k', openRouterMode: true }).stream(REQ, () => {});
      const call = r.content.find((c) => c.type === 'tool_use');
      expect(call?.name).toBe('write_file');
      expect(call?.input).toEqual({ path: '/out/regintel/config.py', content: CONTENT });
    });
  }

  it('arguments that truly do not parse are refused loudly, never handed over as {}', async () => {
    // The vendor sent a tool call whose arguments are not JSON (a cut stream on THEIR side).
    const broken = chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path": "/out/a.py", "content": "abc' } }] })
      + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', fetchReturning(readsOf(broken, 4096)));
    const r = await new MiniMaxProvider('k').stream(REQ, () => {});
    const call = r.content.find((c) => c.type === 'tool_use');
    expect(call).toBeDefined();
    expect(call?.input).not.toEqual({});
    expect(JSON.stringify(call?.input)).toMatch(/not valid JSON/);
  });
});
