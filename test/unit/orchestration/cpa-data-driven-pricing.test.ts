/**
 * CPA pricing must be data-driven: all cost lookup comes from model-pricing.json,
 * not hardcoded tier arrays. Root cause of -80% variance: estimate-stories.sh used
 * effort-tier arrays (Opus/Sonnet/Haiku rates) for models like moonshotai/kimi-k2
 * and MiniMax-M3, causing 2-10x misestimates. calibrate.py had a duplicate MODEL_PRICING
 * dict with old openrouter3.7-* model names that never matched live logs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../');
const estimateSrc  = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/estimate-stories.sh'), 'utf8');
const calibrateSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/calibrate.py'), 'utf8');
const pricingFile  = join(REPO_ROOT, 'orchestrations/scripts/model-pricing.json');
const pricingData  = JSON.parse(readFileSync(pricingFile, 'utf8'));

// ── model-pricing.json has the current models ────────────────────────────────

describe('model-pricing.json completeness', () => {
  it('contains moonshotai/kimi-k2 (used in travel-app SKY-002/003/004)', () => {
    expect(pricingData).toHaveProperty('moonshotai/kimi-k2');
  });

  it('contains MiniMax-M3 or minimax/minimax-m3 (used in travel-app SKY-001)', () => {
    const hasEntry = 'MiniMax-M3' in pricingData || 'minimax/minimax-m3' in pricingData;
    expect(hasEntry).toBe(true);
  });

  it('kimi-k2 input rate matches documented $0.57/M', () => {
    expect(pricingData['moonshotai/kimi-k2'].input).toBe(0.57);
  });

  it('all entries have both input and output keys', () => {
    for (const [model, rates] of Object.entries(pricingData)) {
      if (model.startsWith('_')) continue;
      expect((rates as any).input, `${model}.input`).toBeTypeOf('number');
      expect((rates as any).output, `${model}.output`).toBeTypeOf('number');
    }
  });
});

// ── estimate-stories.sh: data-driven lookup ─────────────────────────────────

describe('estimate-stories.sh pricing — data-driven', () => {
  it('defines MODEL_PRICING_FILE pointing to model-pricing.json', () => {
    expect(estimateSrc).toContain('MODEL_PRICING_FILE=');
    expect(estimateSrc).toContain('model-pricing.json');
  });

  it('defines lookup_model_pricing() function', () => {
    expect(estimateSrc).toContain('lookup_model_pricing()');
  });

  it('lookup_model_pricing reads from $MODEL_PRICING_FILE (not a hardcoded path)', () => {
    const fnStart = estimateSrc.indexOf('lookup_model_pricing()');
    const fnEnd   = estimateSrc.indexOf('\n}', fnStart);
    const fnBody  = estimateSrc.slice(fnStart, fnEnd);
    expect(fnBody).toContain('$MODEL_PRICING_FILE');
    expect(fnBody).not.toMatch(/\/model-pricing\.json[^$"]/); // no bare hardcoded path
  });

  it('uses prefix matching in lookup (handles moonshotai/kimi-k2 and MiniMax-M3)', () => {
    // THE HANDLER, which is the lookup now. This sliced the shell function, and the program moved
    // into lib/handlers/model-price-lookup.py when its heredoc was lifted — so the slice stopped
    // containing the logic while still containing the function. Reading the handler is also
    // stronger: it is the exact file the pipeline executes.
    const fnBody = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/handlers/model-price-lookup.py'), 'utf8');
    expect(fnBody).toContain('startswith');
  });

  it('extracts s_model from PRD per story in the processing loop', () => {
    expect(estimateSrc).toContain('s_model=$(jq -r');
    expect(estimateSrc).toContain('.model // ""');
  });

  it('calls lookup_model_pricing with s_model before falling back to tier arrays', () => {
    const lookupCall = estimateSrc.indexOf('lookup_model_pricing "${s_model');
    const caseBlock  = estimateSrc.indexOf('case "$s_provider"');
    expect(lookupCall).toBeGreaterThan(-1);
    expect(caseBlock).toBeGreaterThan(-1);
    // The data-driven lookup must appear before the provider fallback case
    expect(lookupCall).toBeLessThan(caseBlock);
  });

  it('openrouter_PRICING tier arrays are kept as fallback only (not the primary path)', () => {
    // The fallback is inside an else block following the model-pricing lookup
    const modelBlock  = estimateSrc.indexOf('_model_prices=$(lookup_model_pricing');
    const openrouterPricing = estimateSrc.indexOf('openrouter_PRICING_INPUT', modelBlock);
    const elseBlock   = estimateSrc.indexOf('else', modelBlock);
    expect(elseBlock).toBeGreaterThan(-1);
    // openrouter_PRICING must appear AFTER the else (inside the fallback branch)
    expect(openrouterPricing).toBeGreaterThan(elseBlock);
  });
});

// ── calibrate.py: no hardcoded MODEL_PRICING dict ────────────────────────────

describe('calibrate.py pricing — data-driven', () => {
  it('does not contain the old MODEL_PRICING inline dict', () => {
    expect(calibrateSrc).not.toContain('MODEL_PRICING = {');
  });

  it('does not reference the old openrouter3.7-max model name', () => {
    expect(calibrateSrc).not.toContain('openrouter3.7-max');
  });

  it('does not reference the old openrouter3.7-plus model name', () => {
    expect(calibrateSrc).not.toContain('openrouter3.7-plus');
  });

  it('loads model-pricing.json from the script directory', () => {
    expect(calibrateSrc).toContain('model-pricing.json');
    expect(calibrateSrc).toContain('_load_model_pricing');
  });

  it('compute_cost returns 0.0 for unknown models (not a hardcoded sonnet fallback)', () => {
    expect(calibrateSrc).toContain('return 0.0');
    // Must not have the old fallback that silently used sonnet pricing
    expect(calibrateSrc).not.toContain('{"in": 0.003, "out": 0.015}');
  });

  it('uses prefix matching (handles date-suffixed model names like haiku-4-5-20251001)', () => {
    expect(calibrateSrc).toContain('startswith');
  });

  it('divides by 1_000_000 not 1_000 (model-pricing.json is per-million, not per-1K)', () => {
    const fnStart = calibrateSrc.indexOf('def compute_cost');
    const fnEnd   = calibrateSrc.indexOf('\ndef ', fnStart + 1);
    const fnBody  = calibrateSrc.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);
    expect(fnBody).toContain('1_000_000');
    expect(fnBody).not.toContain('/ 1000)');
  });
});

// ── Runtime: calibrate.py compute_cost uses model-pricing.json ───────────────

describe('calibrate.py compute_cost() — runtime', () => {
  const pythonBin = process.env.PYTHON3_BIN || 'python3';
  // Inline runner: exercise compute_cost without needing a real phase-cost.jsonl
  function runComputeCost(model: string): number {
    const script = `
import sys, json
sys.path.insert(0, '${join(REPO_ROOT, 'orchestrations/scripts')}')
# Patch SCRIPT_DIR so _load_model_pricing finds the real file
import calibrate
import pathlib
calibrate.SCRIPT_DIR = pathlib.Path('${join(REPO_ROOT, 'orchestrations/scripts')}')
calibrate._PRICING_TABLE = {}  # reset cache
result = calibrate.compute_cost(1_000_000, 1_000_000, '${model}')
print(result)
`;
    try {
      const out = execFileSync(pythonBin, ['-c', script], { encoding: 'utf8' });
      return parseFloat(out.trim());
    } catch {
      return -1;
    }
  }

  it('kimi-k2: returns non-zero cost using actual $0.57/$2.30 rates', () => {
    const cost = runComputeCost('moonshotai/kimi-k2');
    // 1M input @ $0.57 + 1M output @ $2.30 = $2.87
    expect(cost).toBeCloseTo(2.87, 1);
  });

  it('unknown model: returns 0.0 (not sonnet fallback)', () => {
    const cost = runComputeCost('unknown-model-xyz-123');
    expect(cost).toBe(0);
  });

  it('minimax-m3 via prefix match: returns non-zero cost', () => {
    // model-pricing.json has "MiniMax-M3" and "minimax/minimax-m3"
    const cost = runComputeCost('MiniMax-M3');
    expect(cost).toBeGreaterThan(0);
  });
});
