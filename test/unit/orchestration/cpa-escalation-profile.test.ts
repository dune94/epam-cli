/**
 * Verifies that contextualize-stories.sh emits the probability-weighted
 * escalation profile (modelProfile, escalationCost, selfHealCost, totalCost)
 * and that calibration.json contains escalationRates per effort tier.
 *
 * The escalation profile prevents absurd estimates by weighting k3 at 0.5%
 * (not 100%) and separating self-heal cost from base story cost.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT  = join(__dirname, '../../../');
const CPA_SRC    = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/contextualize-stories.sh'), 'utf8');
const CAL_FILE   = join(REPO_ROOT, 'orchestrations/logs/calibration.json');

describe('calibration.json — escalationRates', () => {
  const cal = JSON.parse(readFileSync(CAL_FILE, 'utf8'));
  const rates = cal.escalationRates ?? {};

  it('has escalationRates at the top level', () => {
    expect(rates).toBeTruthy();
    expect(typeof rates).toBe('object');
  });

  for (const tier of ['low', 'medium', 'high']) {
    it(`tier "${tier}" has p_rung2, p_rung3, p_k3, selfHealP`, () => {
      const t = rates[tier];
      expect(t).toBeTruthy();
      expect(typeof t.p_rung2).toBe('number');
      expect(typeof t.p_rung3).toBe('number');
      expect(typeof t.p_k3).toBe('number');
      expect(typeof t.selfHealP).toBe('number');
    });

    it(`tier "${tier}" p_k3 < p_rung3 < p_rung2 (k3 is the rarest rung)`, () => {
      const t = rates[tier];
      expect(t.p_k3).toBeLessThan(t.p_rung3);
      expect(t.p_rung3).toBeLessThan(t.p_rung2);
    });

    it(`tier "${tier}" probabilities are all between 0 and 1`, () => {
      const t = rates[tier];
      for (const key of ['p_rung2', 'p_rung3', 'p_k3', 'selfHealP']) {
        expect(t[key]).toBeGreaterThanOrEqual(0);
        expect(t[key]).toBeLessThanOrEqual(1);
      }
    });
  }

  it('high tier has higher escalation probabilities than low tier', () => {
    expect(rates.high.p_rung2).toBeGreaterThan(rates.low.p_rung2);
    expect(rates.high.p_rung3).toBeGreaterThan(rates.low.p_rung3);
    expect(rates.high.p_k3).toBeGreaterThan(rates.low.p_k3);
  });
});

describe('contextualize-stories.sh — compute_escalation_profile', () => {
  it('defines compute_escalation_profile function', () => {
    expect(CPA_SRC).toContain('compute_escalation_profile()');
  });

  it('reads escalationRates from calibration.json inside the function', () => {
    const fnStart = CPA_SRC.indexOf('compute_escalation_profile()');
    const fnBody  = CPA_SRC.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('escalationRates');
  });

  it('reads ESCALATION_MODEL, ESCALATION_MODEL_HIGH, ORCH_GATE_MODEL from env', () => {
    const fnStart = CPA_SRC.indexOf('compute_escalation_profile()');
    const fnBody  = CPA_SRC.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('ESCALATION_MODEL');
    expect(fnBody).toContain('ESCALATION_MODEL_HIGH');
    expect(fnBody).toContain('ORCH_GATE_MODEL');
  });

  it('takes its escalation models from the environment, naming none of its own', () => {
    // WAS: `expect(fnBody).toContain('EPAM_MODEL_LADDER_HIGH')` and
    //      `expect(fnBody).toContain('kimi-k3')`.
    //
    // Both went stale with 2f8d980 ("every agent can climb, and the engine holds no tier
    // vocabulary"), which moved ladder parsing out of this function into the shared seam
    // machinery — the function now receives ESCALATION_MODEL / ESCALATION_MODEL_HIGH. Neither
    // string has been in this script since, so the assertion could only ever fail; it went
    // unnoticed because the suite fails to COLLECT wherever logs/calibration.json is absent.
    //
    // The second half was worse than stale: a test asserting a specific model name is the
    // hardcoding the commit existed to remove. A project on other models must pass this.
    const fnStart = CPA_SRC.indexOf('compute_escalation_profile()');
    const fnBody  = CPA_SRC.slice(fnStart, fnStart + 5000);

    // The escalation rungs come from the environment the ladder machinery populates.
    expect(fnBody).toContain('ESCALATION_MODEL');
    expect(fnBody).toContain('ESCALATION_MODEL_HIGH');

    // And the function invents no model of its own — the vocabulary lives in llm-settings.json.
    const declared = new Set<string>();
    const settings = JSON.parse(readFileSync(
      join(__dirname, '../../../orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
    for (const tier of Object.values<any>(settings.ladders ?? {})) {
      for (const hop of tier.modelLadder ?? []) { declared.add(hop.from); declared.add(hop.to); }
      if (tier.startModel) declared.add(tier.startModel);
    }
    expect(declared.size, 'no rungs declared — this assertion would prove nothing').toBeGreaterThan(1);
    for (const model of declared) {
      expect(fnBody, `compute_escalation_profile hardcodes the model '${model}'`).not.toContain(model);
    }
  });

  it('outputs modelProfile with rung1/rung2/rung3/k3 keys', () => {
    const fnStart = CPA_SRC.indexOf('compute_escalation_profile()');
    const fnBody  = CPA_SRC.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('"modelProfile"');
    expect(fnBody).toContain('"rung1"');
    expect(fnBody).toContain('"rung2"');
    expect(fnBody).toContain('"rung3"');
    expect(fnBody).toContain('"k3"');
  });

  it('outputs escalationCost, selfHealCost, expectedRetries, totalStoryCost', () => {
    const fnStart = CPA_SRC.indexOf('compute_escalation_profile()');
    const fnBody  = CPA_SRC.slice(fnStart, fnStart + 5000);
    expect(fnBody).toContain('"escalationCost"');
    expect(fnBody).toContain('"selfHealCost"');
    expect(fnBody).toContain('"expectedRetries"');
    expect(fnBody).toContain('"totalStoryCost"');
  });

  it('is called after blending, before JSON accumulation', () => {
    const blendIdx  = CPA_SRC.indexOf('IFS=\'|\' read -r b_min b_cost b_tok b_turns b_mhrs');
    const escCallIdx = CPA_SRC.indexOf('compute_escalation_profile "$f_effort"');
    const jsonIdx   = CPA_SRC.indexOf('JSON_RESULTS=$(echo "$JSON_RESULTS" | jq');
    expect(escCallIdx).toBeGreaterThan(blendIdx);
    expect(escCallIdx).toBeLessThan(jsonIdx);
  });
});

describe('contextualize-stories.sh — JSON output schema (escalation fields)', () => {
  it('passes escCost, escHealCost, escRetries, escHealP, escTotal to jq', () => {
    const jsonBlock = CPA_SRC.slice(CPA_SRC.indexOf('JSON_RESULTS=$(echo "$JSON_RESULTS" | jq'));
    expect(jsonBlock).toContain('--argjson escCost');
    expect(jsonBlock).toContain('--argjson escHealCost');
    expect(jsonBlock).toContain('--argjson escRetries');
    expect(jsonBlock).toContain('--argjson escTotal');
    expect(jsonBlock).toContain('--argjson modelProfile');
  });

  it('blendedEstimate.totalCost = totalStoryCost × pipelineOverheadRatio', () => {
    const blendedBlock = CPA_SRC.slice(CPA_SRC.indexOf('blendedEstimate: {'));
    expect(blendedBlock).toContain('totalCost: ($escTotal * ($por | tonumber))');
  });

  it('emits top-level escalation object in cpa-review schema', () => {
    const jsonBlock = CPA_SRC.slice(CPA_SRC.indexOf('schema: "cpa-review-v1"'));
    expect(jsonBlock).toContain('escalation: {');
    expect(jsonBlock).toContain('modelProfile: $modelProfile');
    expect(jsonBlock).toContain('escalationCost: $escCost');
    expect(jsonBlock).toContain('selfHealCost: $escHealCost');
    expect(jsonBlock).toContain('totalEstimate:');
  });

  it('console output shows Escalation and Self-heal lines', () => {
    expect(CPA_SRC).toContain('"Escalation:"');
    expect(CPA_SRC).toContain('"Self-heal:"');
    expect(CPA_SRC).toContain('"Retries (exp):"');
  });
});
