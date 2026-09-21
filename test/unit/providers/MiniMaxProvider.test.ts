/**
 * MiniMaxProvider token-count fallback.
 *
 * Root cause (found 2026-07-17, run-20260717T183414, SKY-004-impl):
 * MiniMax's streaming API does not honour stream_options.include_usage=true,
 * leaving inputTokens and outputTokens both 0. append_cost_record's pricing-
 * table fallback is gated on "tokens_in > 0 || tokens_out > 0", so it also
 * silently zeroed out — making the story appear free.
 *
 * Fix: when streaming completes with 0 tokens but non-empty content,
 * MiniMaxProvider now estimates tokens from character counts (1 token ≈ 4 chars)
 * so the pricing-table fallback has something to work with. Same applied to the
 * non-streaming complete() path as a defensive fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider.js';
import type { ProviderRequest } from '../../../src/providers/types.js';

const SYSTEM_PROMPT = 'You are a helpful assistant.';
const USER_MESSAGE  = 'Hello, how are you?';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    messages: [{ role: 'user', content: USER_MESSAGE }],
    systemPrompt: SYSTEM_PROMPT,
    ...overrides,
  };
}

function makeProvider(): MiniMaxProvider {
  return new MiniMaxProvider('test-api-key');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encodeSSE(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function makeSseStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx++]);
      } else {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}

// ─── complete() — no-usage fallback ──────────────────────────────────────────

describe('MiniMaxProvider.complete() — token fallback when API returns no usage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns non-zero token estimates when prompt_tokens and completion_tokens are absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'The answer is 42.' }, finish_reason: 'stop' }],
        usage: {},  // no prompt_tokens / completion_tokens
      }),
    }));

    const provider = makeProvider();
    const result = await provider.complete(makeRequest());

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('uses real token counts when the API provides them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      }),
    }));

    const provider = makeProvider();
    const result = await provider.complete(makeRequest());

    expect(result.usage.inputTokens).toBe(123);
    expect(result.usage.outputTokens).toBe(45);
  });

  it('does NOT estimate when response content is empty (genuine zero-output call)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: {},
      }),
    }));

    const provider = makeProvider();
    const result = await provider.complete(makeRequest());

    // Input still estimated (request had content), output stays 0 (truly empty)
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBe(0);
  });
});

// ─── stream() — no-usage fallback ────────────────────────────────────────────

describe('MiniMaxProvider.stream() — token fallback when streaming returns no usage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns non-zero token estimates when the stream has no usage chunk', async () => {
    const textChunk = encodeSSE({
      choices: [{ delta: { content: 'Streaming response text here.' }, finish_reason: null }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseStream([textChunk]),
    }));

    const provider = makeProvider();
    const result = await provider.stream(makeRequest(), () => {});

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('uses real token counts when the streaming final chunk contains usage', async () => {
    const textChunk = encodeSSE({
      choices: [{ delta: { content: 'Hello!' }, finish_reason: null }],
    });
    const usageChunk = encodeSSE({
      choices: [],
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseStream([textChunk, usageChunk]),
    }));

    const provider = makeProvider();
    const result = await provider.stream(makeRequest(), () => {});

    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(30);
  });

  it('does NOT estimate when the stream produces no content at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSseStream([]),
    }));

    const provider = makeProvider();
    const result = await provider.stream(makeRequest(), () => {});

    expect(result.usage.outputTokens).toBe(0);
  });

  it('estimated outputTokens scale with response length', async () => {
    const shortChunk = encodeSSE({ choices: [{ delta: { content: 'Hi.' }, finish_reason: null }] });
    const longChunk  = encodeSSE({ choices: [{ delta: { content: 'A'.repeat(400) }, finish_reason: null }] });

    let shortResult: Awaited<ReturnType<MiniMaxProvider['stream']>>;
    let longResult:  Awaited<ReturnType<MiniMaxProvider['stream']>>;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([shortChunk]) }));
    shortResult = await makeProvider().stream(makeRequest(), () => {});

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([longChunk]) }));
    longResult = await makeProvider().stream(makeRequest(), () => {});

    expect(longResult.usage.outputTokens).toBeGreaterThan(shortResult.usage.outputTokens);
  });
});

// ─── stream() — a chunk the parser cannot read is never dropped silently ─────
//
// regintel 140717Z (2026-09-21): three MiniMax-M3 reviews reached the pipeline as
// `dict":"approved",…` — the first five bytes of the answer gone, and the engine recorded
// "no parseable verdict" on approved work. The provider's own trace already lacked them: the
// loss is in this stream loop, whose only loss path was `catch { /* skip malformed chunk */ }`.
// A data event the parser cannot read is now REPORTED — on stderr with its raw payload, and
// on the response as droppedChunks — so the text is known to be incomplete and the evidence
// is captured, instead of an answer that looks whole and is not.
describe('MiniMaxProvider.stream() — a malformed data event is reported, never swallowed', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('counts the dropped event on the response and writes its raw payload to stderr', async () => {
    const enc = new TextEncoder();
    const good1 = encodeSSE({ choices: [{ delta: { content: 'dict":"approved"' }, finish_reason: null }] });
    const broken = enc.encode('data: {"choices":[{"delta":{"content":"{\\"ver"}}]\n\n'); // truncated JSON
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([broken, good1]) }));

    const result = await makeProvider().stream(makeRequest(), () => {});

    expect((result as any).droppedChunks, 'the dropped event was not counted').toBe(1);
    const written = errSpy.mock.calls.map(c => String(c[0])).join('');
    expect(written).toMatch(/malformed|unreadable|dropped/i);
    expect(written).toContain('{\\"ver');   // the raw payload is the evidence
  });

  it('a clean stream reports zero dropped events', async () => {
    const good = encodeSSE({ choices: [{ delta: { content: '{"verdict":"approved"}' }, finish_reason: 'stop' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([good]) }));
    const result = await makeProvider().stream(makeRequest(), () => {});
    expect((result as any).droppedChunks ?? 0).toBe(0);
  });
});

// ─── stream() — the raw SSE payloads can be captured for diagnosis ──────────
//
// regintel 140717Z: MiniMax-M3 answers reached the pipeline as `dict":"approved"` — five bytes
// gone — with NO malformed event reported, so the loss is not the parser's catch. Nothing in the
// engine holds the raw stream, so every hypothesis so far was a guess. With
// EPAM_STREAM_CAPTURE_DIR set, every data payload the provider read is appended, verbatim and in
// order, to <dir>/minimax-<pid>-<n>.sse — the evidence the next occurrence needs.
describe('MiniMaxProvider.stream() — raw SSE capture when EPAM_STREAM_CAPTURE_DIR is set', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('writes every data payload, verbatim and in order, to the capture dir', async () => {
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'sse-cap-'));
    process.env.EPAM_STREAM_CAPTURE_DIR = dir;
    try {
      const c1 = encodeSSE({ choices: [{ delta: { content: '{"ver' }, finish_reason: null }] });
      const c2 = encodeSSE({ choices: [{ delta: { content: 'dict":"approved"}' }, finish_reason: 'stop' }] });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([c1, c2]) }));
      await makeProvider().stream(makeRequest(), () => {});
      const files = readdirSync(dir).filter(f => f.endsWith('.sse'));
      expect(files.length).toBe(1);
      const raw = readFileSync(join(dir, files[0]), 'utf8');
      expect(raw.indexOf('{\\"ver')).toBeGreaterThanOrEqual(0);
      expect(raw.indexOf('{\\"ver')).toBeLessThan(raw.indexOf('dict\\":'));
    } finally {
      delete process.env.EPAM_STREAM_CAPTURE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures nothing when the variable is unset', async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'sse-cap-'));
    delete process.env.EPAM_STREAM_CAPTURE_DIR;
    const c1 = encodeSSE({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: makeSseStream([c1]) }));
    await makeProvider().stream(makeRequest(), () => {});
    expect(readdirSync(dir).length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
