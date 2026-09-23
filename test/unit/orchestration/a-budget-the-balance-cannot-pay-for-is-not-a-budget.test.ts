/**
 * A BUDGET THE BALANCE CANNOT PAY FOR IS NOT A BUDGET.
 *
 * Live, regintel resume 9, 2026-09-23 — caused by my own fix that morning:
 *
 *   ModelOverride[moonshotai/kimi-k3]: output budget 16384 → 943718 (the model's own maximum)
 *   [FailureAnalyst] Attempt never ran: OpenRouter 402 — requested 930541 max_tokens exceeds
 *                    affordable 790769 credits
 *   ERROR Failed to implement REGI-009a after 8 attempts
 *
 * The provider refuses any request whose max_tokens COULD cost more than the credit remaining.
 * kimi-k3 bills output at $15/M, so its 943,718-token maximum reserves $14.16 against an $11.66
 * balance and every call on that rung was rejected in under a second — eight attempts, a spent
 * ladder, and no tokens generated. Every other model on the ladder reserves under a dollar, so
 * the fault only appears on one rung and only when the balance is low: the cap depends on the
 * credit, which nothing in the engine accounted for.
 *
 * The budget is therefore the smallest of three DECLARED things — the model's own maximum, what
 * the balance can pay for, and what a single story is allowed to spend — and never less than the
 * tier. Nothing is authored: the price comes from the provider registry (refresh-model-limits.sh)
 * and the balance from the set's own balanceProbe.
 *
 * Executes the REAL decision from lib/story-attempt.sh.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const ATTEMPT = join(ROOT, 'orchestrations/scripts/lib/story-attempt.sh');

function budgetBlock(): string {
  const src = engineSource(ATTEMPT);
  const start = src.indexOf('                        if [ -n "${_ov_out_tokens:-}" ]');
  if (start === -1) throw new Error('the output-budget block moved');
  const END = '                        # end output-budget decision';
  const stop = src.indexOf(END, start);
  if (stop === -1) throw new Error('the output-budget end marker moved');
  return src.slice(start, stop);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function decide(o: { tier: number; modelMax: number; pricePerMillion?: number; balance?: string; storyLimit?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'afford-'));
  dirs.push(dir);
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }',
    `STORY_MAX_OUTPUT_TOKENS=${o.tier}`,
    `_ov_out_tokens=${o.modelMax}`,
    `_ov_out_price=${o.pricePerMillion ?? ''}`,
    'STORY_MODEL=fixture-model',
    `balance_probe_read() { ${o.balance ? `echo ${o.balance}` : 'return 1'}; }`,
    ...(o.storyLimit ? [`export EPAM_STORY_BUDGET_HARD_LIMIT_USD=${o.storyLimit}`] : []),
    // the block uses `local`, which is only valid inside a function — as it is in the engine
    '_decide() {',
    budgetBlock(),
    '}',
    '_decide',
    'echo "BUDGET=$STORY_MAX_OUTPUT_TOKENS"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, budget: Number((out.match(/BUDGET=(\d+)/) || [])[1]) };
}

describe('a budget the balance cannot pay for is not a budget', () => {
  it('REPRODUCES the live 402: the model maximum costs more than the balance', () => {
    // kimi-k3's real numbers: 943,718 tokens at $15/M = $14.16, against $11.66 of credit
    const { budget, out } = decide({ tier: 16384, modelMax: 943718, pricePerMillion: 15, balance: '11.66' });
    expect(budget * 15 / 1e6, `the request would reserve more than the balance:\n${out.slice(-300)}`).toBeLessThanOrEqual(11.66);
    expect(budget, 'the budget fell below the tier it started from').toBeGreaterThanOrEqual(16384);
  });

  it('says why it capped, rather than silently shrinking', () => {
    const { out } = decide({ tier: 16384, modelMax: 943718, pricePerMillion: 15, balance: '11.66' });
    expect(out.toLowerCase()).toMatch(/afford|balance|credit/);
  });

  it('leaves an affordable maximum alone — MiniMax-M3 reserves $0.61', () => {
    expect(decide({ tier: 16384, modelMax: 512000, pricePerMillion: 1.2, balance: '11.66' }).budget).toBe(512000);
  });

  it('respects a declared per-story spend limit as well as the balance', () => {
    // $2 a story at $15/M is 133,333 tokens, even with plenty of credit
    const { budget } = decide({ tier: 16384, modelMax: 943718, pricePerMillion: 15, balance: '500', storyLimit: '2' });
    expect(budget).toBeLessThanOrEqual(133_334);
    expect(budget).toBeGreaterThanOrEqual(16384);
  });

  it('takes the model maximum when the price is unknown — no guess, no cap', () => {
    // the engine leaves some prices null on purpose; an unpriced model is not a reason to shrink
    expect(decide({ tier: 16384, modelMax: 512000, balance: '11.66' }).budget).toBe(512000);
  });

  it('takes the model maximum when the balance cannot be read', () => {
    expect(decide({ tier: 16384, modelMax: 512000, pricePerMillion: 1.2 }).budget).toBe(512000);
  });
});
