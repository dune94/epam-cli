/**
 * LIVE integration test — makes tiny real API calls (a few hundred tokens,
 * well under $0.01 total) to verify real-cost capture actually works end to
 * end, not just against mocked provider responses. Added 2026-07-13 after
 * a trust breakdown: cost figures reported earlier had drifted far from
 * what the CLI's --json output shows, and the local unit tests
 * (test/unit/providers/real-cost-tracking.test.ts) only prove the parsing
 * logic works against a fixture — they can't prove OpenRouter/MiniMax still
 * return cost data in the shape we expect, or that our pricing-table rates
 * are still accurate. This test hits the real APIs and checks:
 *   1. OpenRouter-routed models (via the openrouter provider) report
 *      cost_is_estimate=false with a real, non-zero usage.cost.
 *   2. MiniMax (no real cost API) correctly falls back and reports
 *      cost_is_estimate=true, never silently claiming a real cost it
 *      doesn't have.
 *   3. The real OpenRouter-billed cost for each call is within a small
 *      tolerance of what our local pricing table would have computed for
 *      the same token counts — an independent check that the table's
 *      rates (verified by hand once, 2026-07-13) haven't drifted.
 *
 * Requires OPENROUTER_API_KEY and MINIMAX_API_KEY. Skipped automatically
 * if either is unset — this must never run unattended in CI without a key,
 * and never run in a loop (each run spends real, small money).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { calculateCost } from '../../src/billing/pricing.js';

const REPO_ROOT = join(__dirname, '../../');
const CLI = join(REPO_ROOT, 'dist/epam.js');
const NODE_BIN = process.env.NODE_BIN || process.execPath;

const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
const hasMiniMaxKey = !!process.env.MINIMAX_API_KEY;

interface RunJsonOutput {
  usage: { inputTokens: number; outputTokens: number };
  cost_usd: number;
  cost_is_estimate: boolean;
}

function runOnce(provider: string, model: string): RunJsonOutput {
  const out = execFileSync(
    NODE_BIN,
    [CLI, 'run', '--json', '--provider', provider, '--model', model, '--no-tools'],
    {
      input: 'Reply with exactly the single word: OK',
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  return JSON.parse(out);
}

describe.skipIf(!hasOpenRouterKey)('real-cost-live — OpenRouter-routed models report real, non-estimated cost', () => {
  it('z-ai/glm-5.1 returns cost_is_estimate=false with real cost close to the pricing table', () => {
    const result = runOnce('openrouter', 'z-ai/glm-5.1');
    expect(result.cost_is_estimate).toBe(false);
    expect(result.cost_usd).toBeGreaterThan(0);

    const tableEstimate = calculateCost('z-ai/glm-5.1', result.usage.inputTokens, result.usage.outputTokens);
    // Real billed cost should track the table within ~30% — catches the
    // table drifting stale again without requiring bit-exact equality
    // (OpenRouter rounds cost to a few significant figures).
    expect(Math.abs(result.cost_usd - tableEstimate)).toBeLessThan(Math.max(tableEstimate * 0.3, 0.0002));
  });

  it('moonshotai/kimi-k2 returns cost_is_estimate=false with real cost close to the pricing table', () => {
    const result = runOnce('openrouter', 'moonshotai/kimi-k2');
    expect(result.cost_is_estimate).toBe(false);
    expect(result.cost_usd).toBeGreaterThan(0);

    const tableEstimate = calculateCost('moonshotai/kimi-k2', result.usage.inputTokens, result.usage.outputTokens);
    expect(Math.abs(result.cost_usd - tableEstimate)).toBeLessThan(Math.max(tableEstimate * 0.3, 0.0002));
  });
});

describe.skipIf(!hasMiniMaxKey)('real-cost-live — MiniMax has no real cost API, must be honestly flagged as an estimate', () => {
  it('MiniMax-M3 returns cost_is_estimate=true, never silently claims a real cost', () => {
    const result = runOnce('minimax', 'MiniMax-M3');
    expect(result.cost_is_estimate).toBe(true);
    expect(result.cost_usd).toBeGreaterThan(0);
  });
});
