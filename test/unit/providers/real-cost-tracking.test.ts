/**
 * Real (provider-billed) cost tracking — added 2026-07-13 after a live
 * discrepancy: a tier3 run's dashboard showed $4.06 total spend while
 * OpenRouter's own real account-balance delta for the same run was $0.86.
 * Root cause: three disconnected pricing mechanisms, none reflecting real
 * billing —
 *   1. src/billing/pricing.ts had ZERO entries for z-ai/glm-5.1, MiniMax-M3,
 *      or moonshotai/kimi-k2 (the exact models the run used), so
 *      calculateCost() silently returned 0 for every one of its calls.
 *   2. orchestrations/scripts/model-pricing.json (the bash-side fallback)
 *      had a stale z-ai/glm-5.1 output rate ($4.30/M vs the real OpenRouter
 *      rate of $3.036/M, confirmed via live pricing lookup).
 *   3. OpenRouter can return REAL, billed cost directly in the response
 *      (`usage.cost`, via a `usage.include=true` request flag) — never
 *      requested anywhere in this codebase.
 *
 * Per feedback_real_cost_tracking_critical (explicit, emphatic user
 * priority: "#1 objective... real API costs... critical, not a joke"):
 * real cost capture must be the PRIMARY path; a maintained pricing table is
 * fallback-only, and callers must be able to tell the difference — an
 * estimate silently presented as confirmed spend is the exact bug that
 * shipped unnoticed.
 *
 * This file tests, with REAL execution (mocked fetch, not just type
 * assertions): QwenProvider requests and parses real cost (complete +
 * stream); MiniMaxProvider's defensive parse behaves correctly whether or
 * not a cost field is present; AgentRunner's cross-turn accumulation
 * correctly refuses to report a partial sum as if it were the whole
 * picture; calculateCost() covers every model family actually used in
 * production (the exact gap that caused the live bug).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createQwenProvider } from '../../../src/providers/qwen/QwenProvider.js';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider.js';
import { calculateCost } from '../../../src/billing/pricing.js';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';
import type { LLMProvider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.js';
import type { Tool, ToolResult } from '../../../src/tools/types.js';

function stubFetch(responses: Array<Record<string, any>>) {
  let call = 0;
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { ok: true, json: async () => body } as Response;
    }),
  );
  return { getBodies: () => bodies };
}

describe('QwenProvider (OpenRouter) — real cost capture', () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    vi.unstubAllGlobals();
  });

  it('requests real cost via usage.include=true on complete()', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { getBodies } = stubFetch([
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001234 } },
    ]);
    const provider = createQwenProvider()!;
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'z-ai/glm-5.1', stream: false });
    expect(getBodies()[0].usage).toEqual({ include: true });
  });

  it('surfaces real cost in the response when OpenRouter returns usage.cost', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    stubFetch([
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0042 } },
    ]);
    const provider = createQwenProvider()!;
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'z-ai/glm-5.1', stream: false });
    expect(result.usage.costUsd).toBe(0.0042);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it('leaves costUsd undefined (not 0, not fabricated) when the response has no usage.cost', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    stubFetch([
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const provider = createQwenProvider()!;
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'z-ai/glm-5.1', stream: false });
    expect(result.usage.costUsd).toBeUndefined();
  });

  it('streaming: request includes both stream_options.include_usage and usage.include', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const sseBody =
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
      `data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"cost":0.0009}}\n\n` +
      `data: [DONE]\n\n`;
    let capturedBody: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        const encoder = new TextEncoder();
        return {
          ok: true,
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => {
                  if (sent) return { done: true, value: undefined };
                  sent = true;
                  return { done: false, value: encoder.encode(sseBody) };
                },
              };
            },
          },
        } as unknown as Response;
      }),
    );
    const provider = createQwenProvider()!;
    const result = await provider.stream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'z-ai/glm-5.1', stream: true },
      () => {},
    );
    expect(capturedBody.stream_options).toEqual({ include_usage: true });
    expect(capturedBody.usage).toEqual({ include: true });
    expect(result.usage.costUsd).toBe(0.0009);
  });
});

describe('MiniMaxProvider (direct API) — defensive cost parse, estimate-only by default', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves costUsd undefined when MiniMax\'s response has no cost field (its documented, current behavior)', async () => {
    stubFetch([
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const provider = new MiniMaxProvider('test-key');
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'MiniMax-M3', stream: false });
    expect(result.usage.costUsd).toBeUndefined();
  });

  it('opportunistically captures costUsd if a future MiniMax response includes usage.total_cost', async () => {
    stubFetch([
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_cost: 0.0021 } },
    ]);
    const provider = new MiniMaxProvider('test-key');
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'MiniMax-M3', stream: false });
    expect(result.usage.costUsd).toBe(0.0021);
  });
});

describe('calculateCost() — every model family this codebase actually uses in production', () => {
  // Found live 2026-07-13: glm-5.1/MiniMax-M3/kimi-k2 were completely absent
  // from this table, so calculateCost() silently returned 0 for 100% of a
  // real run's calls. These are the exact models used across the qwen and
  // minimax providers today — every one must resolve to a non-zero rate.
  it.each([
    ['z-ai/glm-5.1', 1_000_000, 1_000_000],
    ['z-ai/glm-5.2', 1_000_000, 1_000_000],
    ['moonshotai/kimi-k2', 1_000_000, 1_000_000],
    ['MiniMax-M3', 1_000_000, 1_000_000],
    ['MiniMax-M2.7', 1_000_000, 1_000_000],
    ['claude-sonnet-4-6', 1_000_000, 1_000_000],
    ['gpt-4o', 1_000_000, 1_000_000],
    ['gemini-2.5-pro', 1_000_000, 1_000_000],
  ])('%s has a real, non-zero pricing entry', (model, tin, tout) => {
    const cost = calculateCost(model, tin, tout);
    expect(cost).toBeGreaterThan(0);
  });

  it('z-ai/glm-5.1 matches OpenRouter\'s verified live rate ($0.966 in / $3.036 out per 1M), not the previously-stale $4.30 output rate', () => {
    const cost = calculateCost('z-ai/glm-5.1', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.966 + 3.036, 5);
  });

  it('still returns 0 for a genuinely unknown model (unchanged existing behavior — no silent guessing)', () => {
    expect(calculateCost('totally-made-up-model-xyz', 1000, 1000)).toBe(0);
  });
});

describe('AgentRunner — cross-turn cost accumulation refuses to report a partial sum as the whole picture', () => {
  function makeTool(name: string): Tool {
    return {
      name,
      description: 'test tool',
      permission: 'safe',
      definition: { name, description: 'test tool', inputSchema: { type: 'object', properties: {} } },
      execute: async (): Promise<ToolResult> => ({ toolUseId: 'x', content: 'ok', isError: false }),
    };
  }

  function makeProvider(responses: ProviderResponse[]): LLMProvider {
    let call = 0;
    return {
      name: 'mock',
      defaultModel: 'mock-model',
      complete: async (_req: ProviderRequest) => responses[Math.min(call++, responses.length - 1)],
      stream: async (_req: ProviderRequest) => responses[Math.min(call++, responses.length - 1)],
    };
  }

  it('sums costUsd across turns when EVERY turn reports real cost', async () => {
    const provider = makeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.005 },
      },
    ]);
    const runner = new AgentRunner({
      userMessage: 'do the thing',
      systemPrompt: 'you are a test agent',
      provider,
      model: 'mock-model',
      tools: [makeTool('noop')],
      dangerousSkipApproval: true,
    });
    const result = await runner.run();
    expect(result.usage.costUsd).toBeCloseTo(0.015, 10);
  });

  it('reports costUsd as undefined (not a silently-partial sum) when even ONE turn is missing real cost', async () => {
    const provider = makeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 10 }, // no costUsd this turn
      },
    ]);
    const runner = new AgentRunner({
      userMessage: 'do the thing',
      systemPrompt: 'you are a test agent',
      provider,
      model: 'mock-model',
      tools: [makeTool('noop')],
      dangerousSkipApproval: true,
    });
    const result = await runner.run();
    expect(result.usage.costUsd).toBeUndefined();
    // Token accumulation must still work regardless of cost provenance.
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(30);
  });

  it('single-turn run with real cost reports it directly', async () => {
    const provider = makeProvider([
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0007 } },
    ]);
    const runner = new AgentRunner({
      userMessage: 'hi',
      systemPrompt: 'you are a test agent',
      provider,
      model: 'mock-model',
      tools: [],
      dangerousSkipApproval: true,
    });
    const result = await runner.run();
    expect(result.usage.costUsd).toBe(0.0007);
  });
});
