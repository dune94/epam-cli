import { describe, it, expect } from 'vitest';
import { BudgetGuard } from '../../../src/billing/BudgetGuard.js';
import type { BudgetGuardrails } from '../../../src/config/types.js';

function makeGuard(overrides: Partial<BudgetGuardrails> = {}): BudgetGuard {
  return new BudgetGuard(
    { warningAt: Infinity, hardLimitAt: Infinity, onHardLimit: 'downgrade', ...overrides },
    'claude-sonnet-4-6',
  );
}

describe('BudgetGuard', () => {
  it('returns ok when no limits are set', () => {
    const guard = makeGuard();
    const result = guard.recordUsage(1000, 500);
    expect(result.action).toBe('ok');
    expect(result.message).toBe('');
  });

  it('tracks cumulative cost across multiple recordings', () => {
    const guard = makeGuard();
    guard.recordUsage(100_000, 10_000);
    guard.recordUsage(100_000, 10_000);
    expect(guard.inputTokens).toBe(200_000);
    expect(guard.outputTokens).toBe(20_000);
    expect(guard.sessionCost).toBeGreaterThan(0);
  });

  it('fires warning when warningAt is crossed', () => {
    // Sonnet: $3/M input, $15/M output. 1M input = $3.
    const guard = makeGuard({ warningAt: 0.01 });
    // ~10K input tokens of Sonnet = $0.03 > $0.01 warning
    const result = guard.recordUsage(10_000, 0);
    expect(result.action).toBe('warning');
    expect(result.message).toContain('warning threshold');
  });

  it('fires warning only once per session', () => {
    const guard = makeGuard({ warningAt: 0.01 });
    const first = guard.recordUsage(10_000, 0);
    expect(first.action).toBe('warning');
    const second = guard.recordUsage(10_000, 0);
    expect(second.action).toBe('ok');
  });

  it('fires downgrade when hardLimitAt is crossed with onHardLimit=downgrade', () => {
    const guard = makeGuard({ hardLimitAt: 0.01, onHardLimit: 'downgrade' });
    const result = guard.recordUsage(10_000, 0);
    expect(result.action).toBe('downgrade');
    expect(result.message).toContain('Auto-downgrading');
  });

  it('fires pause when hardLimitAt is crossed with onHardLimit=pause', () => {
    const guard = makeGuard({ hardLimitAt: 0.01, onHardLimit: 'pause' });
    const result = guard.recordUsage(10_000, 0);
    expect(result.action).toBe('pause');
    expect(result.message).toContain('Pausing');
  });

  it('hard limit takes precedence over warning', () => {
    const guard = makeGuard({ warningAt: 0.005, hardLimitAt: 0.01 });
    // Single large usage crosses both thresholds
    const result = guard.recordUsage(10_000, 0);
    expect(result.action).toBe('downgrade');
  });

  it('hasLimits returns false when both are Infinity', () => {
    const guard = makeGuard();
    expect(guard.hasLimits).toBe(false);
  });

  it('hasLimits returns true when warningAt is finite', () => {
    const guard = makeGuard({ warningAt: 5.0 });
    expect(guard.hasLimits).toBe(true);
  });

  it('loadTokens sets cumulative counts for session resume', () => {
    const guard = makeGuard({ warningAt: 100.0 });
    guard.loadTokens(500_000, 50_000);
    expect(guard.inputTokens).toBe(500_000);
    expect(guard.outputTokens).toBe(50_000);
    expect(guard.sessionCost).toBeGreaterThan(0);
  });

  it('reset clears all state', () => {
    const guard = makeGuard();
    guard.recordUsage(100_000, 10_000);
    guard.reset();
    expect(guard.inputTokens).toBe(0);
    expect(guard.outputTokens).toBe(0);
    expect(guard.sessionCost).toBe(0);
  });

  it('setModel updates the model used for cost calculation', () => {
    const guard = makeGuard();
    guard.recordUsage(1_000_000, 0);
    const costSonnet = guard.sessionCost; // $3/M = $3.00
    guard.reset();
    guard.setModel('gpt-4o-mini');
    guard.recordUsage(1_000_000, 0);
    const costMini = guard.sessionCost; // $0.15/M = $0.15
    expect(costSonnet).toBeGreaterThan(costMini);
  });
});
