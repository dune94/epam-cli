/**
 * A PROVIDER REPORTING $0 WAS BELIEVED, AND THE PRICING TABLE WAS NEVER CONSULTED.
 *
 * buildRunResultJson decided which cost to publish like this:
 *
 *     const isEstimate = result.usage.costUsd == null;
 *     const cost = isEstimate ? calculateCost(model, in, out) : result.usage.costUsd!;
 *
 * `== null` is true only for null/undefined. A provider that returns costUsd: 0 — because it does
 * not know, not because the call was free — therefore lands in the "real billed cost" branch, is
 * published as confirmed spend, and the local pricing table is never asked.
 *
 * Live 2026-08-17, mock3 run 20260817T162132Z. Every call ran on z-ai/glm-5.2, which IS priced at
 * $0.93/M in and $3.00/M out. 13 of 14 ledger records carried costUsd 0:
 *
 *     recorded   $0.0069
 *     should be  $0.2592     (215,795 in + 19,497 out at the table's own rates)
 *
 * A 37x under-report, on the measurement the operator has called priority #1 — and it degrades
 * exactly where it hurts most, because the story budget guard sums these numbers to enforce
 * storyBudgetHardLimitUsd. A runaway story on a provider that reports zero is invisible to the only
 * mechanism that stops it.
 *
 * The rule this encodes: a cost of zero alongside tokens actually consumed is a MISSING cost, not a
 * free call. Fall back to the table, and say the number is an estimate.
 */
import { describe, it, expect } from 'vitest';
import { buildRunResultJson } from '../../../src/cli/commands/run';

const MODEL = 'z-ai/glm-5.2';   // priced in orchestrations/config/model-pricing.json
const CFG = { model: MODEL, provider: 'openrouter' };

const usage = (over: Record<string, unknown> = {}) => ({
  inputTokens: 215795, outputTokens: 19497, ...over,
});
const result = (over: Record<string, unknown> = {}) => ({
  finalResponse: 'x', toolCallCount: 0, iterations: 1, usage: usage(), ...over,
} as any);

describe('a provider zero is not a billed cost', () => {
  it('falls back to the pricing table when the provider reports 0 with real tokens', () => {
    const out: any = buildRunResultJson(result({ usage: usage({ costUsd: 0 }) }), CFG);
    // 215795/1e6*0.93 + 19497/1e6*3.00 = 0.2592
    expect(out.cost_usd, 'a provider 0 was published as confirmed spend').toBeCloseTo(0.2592, 3);
  });

  it('says so — the fallback is an ESTIMATE, never confirmed spend', () => {
    const out: any = buildRunResultJson(result({ usage: usage({ costUsd: 0 }) }), CFG);
    expect(out.cost_is_estimate,
      'a table-derived number was presented as the provider\'s billed cost').toBe(true);
  });

  it('a GENUINELY free call still reports 0', () => {
    // Zero tokens and zero cost is a real free call — nothing was consumed, so there is nothing
    // to price. This is what stops the fix turning every no-op into a phantom charge.
    const out: any = buildRunResultJson(
      result({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }), CFG);
    expect(out.cost_usd).toBe(0);
  });

  it('a real non-zero provider cost still WINS over the table', () => {
    // The provider's own billed figure is the better number whenever it gives one; the table is
    // fallback-only. This is the behaviour that must not regress.
    const out: any = buildRunResultJson(result({ usage: usage({ costUsd: 0.9999 }) }), CFG);
    expect(out.cost_usd).toBeCloseTo(0.9999, 4);
    expect(out.cost_is_estimate, 'a real billed cost was mislabelled an estimate').toBe(false);
  });

  it('an absent provider cost still uses the table, as before', () => {
    const out: any = buildRunResultJson(result(), CFG);
    expect(out.cost_usd).toBeCloseTo(0.2592, 3);
    expect(out.cost_is_estimate).toBe(true);
  });

  it('an UNPRICED model with a provider zero stays 0 — and is not invented', () => {
    // No rate exists, so there is nothing honest to fall back to. It must stay 0 (and remain
    // flagged elsewhere as unknown) rather than being guessed at.
    const out: any = buildRunResultJson(
      result({ usage: usage({ costUsd: 0 }) }),
      { model: 'no-such-model-anywhere', provider: 'x' });
    expect(out.cost_usd).toBe(0);
  });
});
