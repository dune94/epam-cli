/**
 * THE OUTPUT BUDGET IS THE MODEL'S OWN MAXIMUM; A TIER MAY RAISE IT, NEVER LOWER IT.
 *
 * Every authored output ceiling this pipeline has had became a wall — 6144, 8192, 12288, 16384 —
 * and each was raised only after a paid run hit it. On 2026-09-23 the run's own traces settled it:
 * 85 of 6,301 model iterations ended EXACTLY at a declared ceiling, while the provider's registry
 * said those same models emit 131,072 (glm-5.3), 235,929 (kimi-k2.5), 512,000 (MiniMax-M3) and
 * 943,718 (kimi-k3) tokens. The pipeline was capping its models at 1.6–6% of capability and then
 * spending retries on the truncation.
 *
 * A cap below the model's maximum saves nothing: spend is bounded by
 * costControls.storyBudgetHardLimitUsd (passed to the runner as --max-budget-usd), and a truncated
 * attempt that gets retried costs MORE than one that finishes.
 *
 * Executes the REAL decision from lib/story-attempt.sh. The numbers come from the provider's
 * registry via scripts/refresh-model-limits.sh — none is authored here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const ATTEMPT = join(ROOT, 'orchestrations/scripts/lib/story-attempt.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real block, by its own anchor. */
function budgetBlock(): string {
  const src = engineSource(ATTEMPT);
  const start = src.indexOf('                        if [ -n "${_ov_out_tokens:-}" ]');
  if (start === -1) throw new Error('the output-budget block moved');
  const END = '                        # end output-budget decision';
  const stop = src.indexOf(END, start);
  if (stop === -1) throw new Error('the output-budget end marker moved');
  return src.slice(start, stop);
}

function decide(tierBudget: string, modelMax: string) {
  const dir = mkdtempSync(join(tmpdir(), 'out-budget-'));
  dirs.push(dir);
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'log() { echo "LOG: $*"; }',
    `STORY_MAX_OUTPUT_TOKENS=${tierBudget}`,
    `_ov_out_tokens=${modelMax}`,
    'STORY_MODEL=fixture-model',
    // the block uses `local`, which is only valid inside a function — as it is in the engine
    '_decide() {',
    budgetBlock(),
    '}',
    '_decide',
    'echo "BUDGET=$STORY_MAX_OUTPUT_TOKENS"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
  return (r.stdout || '') + (r.stderr || '');
}

describe("the output budget is the model's own maximum", () => {
  it('raises a tier budget to what the model can actually emit', () => {
    const out = decide('16384', '512000');
    expect(out).toMatch(/BUDGET=512000/);
    expect(out, 'the raise was silent').toMatch(/the model's own maximum/);
  });

  it('never lowers a budget that is already higher', () => {
    expect(decide('600000', '131072')).toMatch(/BUDGET=600000/);
  });

  it('leaves the tier alone for a model that declares no maximum', () => {
    expect(decide('16384', '')).toMatch(/BUDGET=16384/);
  });
});

describe('every model the ladders name carries the provider-declared maximum', () => {
  // Written by scripts/refresh-model-limits.sh from the provider's registry. If a model appears on
  // a ladder without one, the tier becomes its ceiling again and truncation returns.
  const set = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.openrouter.json'), 'utf8'));

  it('no ladder model is left without a declared output maximum', () => {
    const named = new Set<string>();
    for (const tier of Object.values<any>(set.ladders ?? {})) {
      if (tier?.startModel) named.add(String(tier.startModel));
      for (const step of tier?.modelLadder ?? []) { if (step.from) named.add(step.from); if (step.to) named.add(step.to); }
    }
    const overrides = Object.values<any>(set.modelOverrides ?? {});
    const missing = [...named].filter((m) => {
      const ov = overrides.find((o) => o?.matchSubstring && m.toLowerCase().includes(String(o.matchSubstring).toLowerCase()));
      return !ov || !ov.maxOutputTokens;
    });
    expect(missing, 'these ladder models would still be capped by a tier').toEqual([]);
  });

  it('every declared maximum is far above the ceilings that truncated live', () => {
    for (const [name, ov] of Object.entries<any>(set.modelOverrides ?? {})) {
      if (!ov?.maxOutputTokens) continue;
      expect(ov.maxOutputTokens, `${name} is still near the ceilings that truncated (6144–16384)`).toBeGreaterThan(16384);
    }
  });
});
