/**
 * TracedProvider must report the provider's REAL BILLED cost when it has one,
 * and only fall back to the local price table when it does not.
 *
 * THE BUG (backlog B7 + the kimi-k3 $0 report, both the same defect):
 * OpenRouterProvider already asks OpenRouter for real cost (`usage: { include: true }`)
 * and surfaces it as `response.usage.costUsd` — the amount actually charged.
 * TracedProvider then IGNORED it and recomputed from MODEL_PRICING:
 *
 *     const cost = calculateCost(request.model, in, out);   // <- price table
 *
 * `calculateCost` returns 0 for any model absent from the table (pricing.ts:104),
 * so a model too new to be listed reports $0 while really burning money. Measured
 * live: moonshotai/kimi-k3 recorded in=34,511 / out=3,088 and cost $0.0000, while
 * glm-5.1, glm-5.2 and MiniMax-M3 priced correctly.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: kimi-k3 is the TOP rung of
 * EPAM_MODEL_LADDER_HIGH. It is only reached by escalation — i.e. when a story is
 * going badly and burning the MOST money. Cost silently under-reported in exactly
 * the worst case.
 *
 * Fixing it at this layer is model-agnostic: no price table to maintain, so a
 * brand-new ladder model can never silently cost $0 again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider, ProviderRequest, ProviderResponse } from '../../../src/providers/types';

const spans: any[] = [];
vi.mock('../../../src/observability/OtelTracer.js', () => ({
  emitLlmSpan: (s: any) => spans.push(s),
  isOtelEnabled: () => true,
}));

/** A model deliberately absent from MODEL_PRICING, like kimi-k3 was. */
const UNPRICED_MODEL = 'moonshotai/kimi-k3';

function fakeProvider(usage: ProviderResponse['usage']): LLMProvider {
  return {
    name: 'openrouter',
    complete: async (_req: ProviderRequest): Promise<ProviderResponse> => ({
      content: [{ type: 'text', text: 'ok' } as any],
      stopReason: 'end_turn',
      usage,
    }),
  } as unknown as LLMProvider;
}

async function runComplete(usage: ProviderResponse['usage'], model = UNPRICED_MODEL) {
  const { wrapWithTracing } = await import('../../../src/observability/TracedProvider');
  const p = wrapWithTracing(fakeProvider(usage));
  await p.complete({ model, messages: [{ role: 'user', content: 'hi' }] } as any);
  return spans[spans.length - 1];
}

describe('TracedProvider — real billed cost is authoritative', () => {
  beforeEach(() => { spans.length = 0; vi.resetModules(); });

  it('reports the provider-billed cost for a model the price table does not know', async () => {
    // The live kimi-k3 numbers.
    const span = await runComplete({ inputTokens: 34_511, outputTokens: 3_088, costUsd: 0.0412 });
    expect(span.costUsd).toBeCloseTo(0.0412, 6);
  });

  it('does NOT silently report $0 when the provider billed real money', async () => {
    const span = await runComplete({ inputTokens: 34_511, outputTokens: 3_088, costUsd: 0.0412 });
    expect(span.costUsd).not.toBe(0);
  });

  it('prefers the billed cost over the price table even when the model IS priced', async () => {
    // The table is an estimate; the provider's number is what was charged.
    const span = await runComplete(
      { inputTokens: 1_000, outputTokens: 1_000, costUsd: 0.99 }, 'claude-haiku-4-5-20251001');
    expect(span.costUsd).toBeCloseTo(0.99, 6);
  });

  it('falls back to the price table when the provider reports no cost', async () => {
    const { calculateCost } = await import('../../../src/billing/pricing');
    const model = 'claude-haiku-4-5-20251001';
    const expected = calculateCost(model, 1_000, 1_000);
    const span = await runComplete({ inputTokens: 1_000, outputTokens: 1_000 }, model);
    expect(span.costUsd).toBeCloseTo(expected, 10);
  });

  it('treats a genuine zero-cost call as zero, not as "missing"', async () => {
    const span = await runComplete({ inputTokens: 10, outputTokens: 10, costUsd: 0 }, UNPRICED_MODEL);
    expect(span.costUsd).toBe(0);
  });
});
