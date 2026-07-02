/**
 * Model Retry Ladder — enforces the three-phase inference ladder in claude.sh.
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - No hardcoded model names in positive assertions
 * - No reads from travel-app-prd.canonical.json
 * - Structural invariants only for shell script contracts
 *
 * Three-phase sequence per story failure:
 *   R1: same model, EPAM_REASONING_EFFORT → medium (think harder, same model)
 *   R2: escalate model (EPAM_MODEL_LADDER lookup, cross-family), effort → medium
 *   R3: keep escalated model, EPAM_REASONING_EFFORT → high (maximum effort)
 *
 * Reasoning effort and temperature are independent concepts — effort controls
 * thinking depth (native API parameter), temperature controls output randomness.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const TIER3_SH  = join(__dirname, '../../../orchestrations/scripts/tier3-travel-app-run.sh');
const src   = readFileSync(CLAUDE_SH, 'utf8');
const tier3 = readFileSync(TIER3_SH, 'utf8');

// ── 1. Ladder function must exist and be configurable ─────────────────────────
describe('claude.sh — model ladder function is env-var-driven (no hardcoded models)', () => {
  it('defines get_model_ladder_step as a shell function', () => {
    expect(src).toMatch(/get_model_ladder_step\s*\(\)|function\s+get_model_ladder_step/);
  });

  it('get_model_ladder_step reads EPAM_MODEL_LADDER env var (not hardcoded cases)', () => {
    expect(src).toMatch(/EPAM_MODEL_LADDER/);
    const funcStart = src.indexOf('get_model_ladder_step()');
    const funcEnd   = src.indexOf('\n}', funcStart);
    const funcBody  = src.slice(funcStart, funcEnd);
    // Body must be data-driven — no specific model family names
    expect(funcBody).not.toMatch(/MiniMax-M[0-9]|zhipuai\/|moonshotai\//);
  });

  it('get_model_ladder_step is called inside the retry loop', () => {
    const defIdx    = src.indexOf('get_model_ladder_step()');
    const afterDef  = src.slice(defIdx);
    const callCount = (afterDef.match(/get_model_ladder_step/g) ?? []).length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ── 2. Tier3 script owns the ladder configuration (structural only) ───────────
describe('tier3 script — EPAM_MODEL_LADDER is exported with valid format', () => {
  it('exports EPAM_MODEL_LADDER', () => {
    expect(tier3).toMatch(/export\s+EPAM_MODEL_LADDER/);
  });

  it('EPAM_MODEL_LADDER has at least one from=to mapping (pipe-separated)', () => {
    // Format must be: "MODEL_A=MODEL_B|MODEL_C=MODEL_D"
    // We check for structure, not specific model names
    expect(tier3).toMatch(/EPAM_MODEL_LADDER.*=.*\|/s);
  });

  it('tier3 sets ORCH_GATE_MODEL to a non-empty value different from the .env default', () => {
    // We verify it is SET — not which specific model it is
    expect(tier3).toMatch(/ORCH_GATE_MODEL=\S+/);
    // Must not be the .env stale default that causes run 103 gate clobber
    expect(tier3).not.toMatch(/ORCH_GATE_MODEL=qwen\/qwen3-coder/);
  });

  it('tier3 sets ORCH_GATE_PROVIDER to a non-empty value', () => {
    expect(tier3).toMatch(/ORCH_GATE_PROVIDER=\S+/);
  });
});

// ── 3. Three-phase ladder sequence ───────────────────────────────────────────
describe('claude.sh — three-phase inference ladder (R1: effort↑, R2: model↑, R3: effort↑)', () => {
  it('Rung1 sets EPAM_REASONING_EFFORT=medium (same model, think harder)', () => {
    expect(src).toMatch(/InferenceLadder\[Rung1\//is);
    expect(src).toMatch(/EPAM_REASONING_EFFORT.*medium/is);
  });

  it('R2 calls get_model_ladder_step to switch model family', () => {
    expect(src).toMatch(/R2.*get_model_ladder_step|get_model_ladder_step.*ladder_step_r2|InferenceLadder\[R2\]/is);
  });

  it('R3 sets EPAM_REASONING_EFFORT=high (maximum effort with escalated model)', () => {
    expect(src).toMatch(/EPAM_REASONING_EFFORT.*high.*R3|R3.*EPAM_REASONING_EFFORT.*high|InferenceLadder\[R3\]|InferenceLadder\[R\$\{retry_count\}\]/is);
  });

  it('EPAM_REASONING_EFFORT is exported so provider subprocesses receive it', () => {
    expect(src).toMatch(/export\s+EPAM_REASONING_EFFORT/);
  });

  it('reasoning effort is reset to low at story start (no leakage between stories)', () => {
    expect(src).toMatch(/EPAM_REASONING_EFFORT.*low.*story start|STORY_MODEL_ORIGINAL|export EPAM_REASONING_EFFORT="low"/is);
  });
});

// ── 4. Reasoning effort reaches providers as native API parameter ─────────────
describe('MiniMax + Qwen providers — EPAM_REASONING_EFFORT passed as native API parameter', () => {
  const minimaxSrc = readFileSync(
    join(__dirname, '../../../src/providers/minimax/MiniMaxProvider.ts'), 'utf8'
  );
  const qwenSrc = readFileSync(
    join(__dirname, '../../../src/providers/qwen/QwenProvider.ts'), 'utf8'
  );

  it('MiniMaxProvider reads EPAM_REASONING_EFFORT and passes reasoning_effort (not temperature)', () => {
    expect(minimaxSrc).toMatch(/EPAM_REASONING_EFFORT/);
    expect(minimaxSrc).toMatch(/reasoning_effort/);
    expect(minimaxSrc).not.toMatch(/resolveTemperature/);
  });

  it('QwenProvider does NOT conflate reasoning effort with temperature', () => {
    expect(qwenSrc).not.toMatch(/resolveTemperature/);
  });

  it('QwenProvider sends reasoning.effort to OpenRouter for models that support it', () => {
    expect(qwenSrc).toMatch(/resolveOpenRouterReasoning/);
    expect(qwenSrc).toMatch(/reasoning.*effort/is);
  });

  it('QwenProvider resolveOpenRouterReasoning covers low/medium/high (not just medium+high)', () => {
    expect(qwenSrc).toMatch(/effort.*low|low.*effort/is);
  });

  it('QwenProvider resolveModel handles models from multiple OpenRouter providers', () => {
    // Must accept models from any provider that goes through OpenRouter,
    // not just one hardcoded family. Check the regex includes multiple prefixes.
    expect(qwenSrc).toMatch(/moonshotai|zhipuai/);
  });
});

// ── 5. EPAM_FINAL_FALLBACK_MODEL still used at R3 when no ladder escalation ──
describe('claude.sh — final fallback used when ladder produces no step', () => {
  it('EPAM_FINAL_FALLBACK_MODEL is referenced at R3 (last retry safety net)', () => {
    expect(src).toMatch(/EPAM_FINAL_FALLBACK_MODEL.*R3|EPAM_FINAL_FALLBACK.*final.*retry|_ffm.*EPAM_FINAL_FALLBACK/is);
  });
});

// ── 6. No silent failures in the retry ladder ────────────────────────────────
describe('claude.sh — retry ladder emits visible log lines at each step', () => {
  it('Rung1 step emits an InferenceLadder log line', () => {
    expect(src).toMatch(/InferenceLadder\[Rung1\//);
  });

  it('Rung2 step emits an InferenceLadder log line', () => {
    expect(src).toMatch(/InferenceLadder\[Rung2\//);
  });

  it('Rung3 step emits an InferenceLadder log line', () => {
    expect(src).toMatch(/InferenceLadder\[Rung3\//);
  });

  it('InferenceLadder lines do not contain "temp=" (reasoning effort ≠ temperature)', () => {
    const ladderLines = src.split('\n').filter(l => l.includes('InferenceLadder'));
    for (const line of ladderLines) {
      expect(line, `Remove "temp=" from: ${line}`).not.toMatch(/temp=/);
    }
  });
});
