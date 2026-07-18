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
