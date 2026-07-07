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
import { execFileSync } from 'node:child_process';
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

  it('MiniMaxProvider reads EPAM_REASONING_EFFORT and passes reasoning_effort as its own native parameter, independent of temperature', () => {
    expect(minimaxSrc).toMatch(/EPAM_REASONING_EFFORT/);
    expect(minimaxSrc).toMatch(/reasoning_effort/);
    // resolveTemperature (added 2026-07-06, see resolveTemperature.test.ts) is a
    // separate, independent knob read from EPAM_TEMPERATURE — the invariant this
    // test guards is that resolveReasoningEffort itself never reads/touches
    // temperature, not that no temperature concept exists at all.
    const reasoningFnStart = minimaxSrc.indexOf('resolveReasoningEffort(request: ProviderRequest)');
    const reasoningFnEnd = minimaxSrc.indexOf('\n  }', reasoningFnStart);
    const reasoningFnBody = minimaxSrc.slice(reasoningFnStart, reasoningFnEnd);
    expect(reasoningFnBody).not.toMatch(/temperature/i);
  });

  it('QwenProvider does NOT conflate reasoning effort with temperature (resolveOpenRouterReasoning never reads/sets temperature)', () => {
    const reasoningFnStart = qwenSrc.indexOf('resolveOpenRouterReasoning(request: ProviderRequest)');
    const reasoningFnEnd = qwenSrc.indexOf('\n  }', reasoningFnStart);
    const reasoningFnBody = qwenSrc.slice(reasoningFnStart, reasoningFnEnd);
    expect(reasoningFnBody).not.toMatch(/temperature/i);
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

  it('QwenProvider resolveModel accepts z-ai/* slugs (GLM 5.x family)', () => {
    expect(qwenSrc).toMatch(/z-ai/);
  });
});

// ── 7. Rung 2 provider routing is config-driven, not hardcoded ───────────────
// (2026-07-06: replaced an inline `case $model in zhipuai/*|z-ai/*|...) qwen;;`
// statement baked into claude.sh — a different project's model vendors would
// get silently wrong/no provider routing from a hardcoded case like that.
// Routing now goes through resolve_model_provider(), which reads
// EPAM_MODEL_PROVIDER_MAP — a per-project config value (tier3-travel-app-run.sh
// supplies the z-ai/zhipuai/moonshotai/kimi/deepseek->qwen, MiniMax->minimax
// map for THIS project), with zero vendor names in the engine itself.
describe('claude.sh — Rung2 provider routing is config-driven via resolve_model_provider()', () => {
  it('Rung2 calls resolve_model_provider() instead of a hardcoded vendor case statement', () => {
    const rung2Idx = src.indexOf('Rung 2: model escalation');
    const rung2Block = src.slice(rung2Idx, rung2Idx + 1700);
    expect(rung2Block).toMatch(/resolve_model_provider "\$escalated_model_r2"/);
    expect(rung2Block).not.toMatch(/zhipuai\/\*|z-ai\/\*|moonshotai\/\*/);
  });

  it('resolve_model_provider() itself has zero hardcoded vendor/model names — reads EPAM_MODEL_PROVIDER_MAP', () => {
    const start = src.indexOf('resolve_model_provider() {');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/EPAM_MODEL_PROVIDER_MAP/);
    expect(body).not.toMatch(/zhipuai|moonshotai|z-ai|MiniMax|kimi|deepseek/i);
  });

  it('tier3-travel-app-run.sh supplies EPAM_MODEL_PROVIDER_MAP covering z-ai/* and zhipuai/* -> qwen', () => {
    const idx = tier3.indexOf('EPAM_MODEL_PROVIDER_MAP=');
    const line = tier3.slice(idx, tier3.indexOf('\n', idx));
    expect(line).toMatch(/zhipuai\/\*=qwen/);
    expect(line).toMatch(/z-ai\/\*=qwen/);
    expect(line).toMatch(/MiniMax-\*=minimax/);
  });
});

describe('resolve_model_provider() — REAL execution', () => {
  function extractFunctionBody(name: string): string {
    const start = src.indexOf(`${name}() {`);
    const end = src.indexOf('\n}', start);
    return src.slice(start, end + 2);
  }

  function run(model: string, map: string): string {
    const fnBody = extractFunctionBody('resolve_model_provider');
    const script = `EPAM_MODEL_PROVIDER_MAP="${map}"\n${fnBody}\nresolve_model_provider "${model}"\n`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  }

  const MAP = 'zhipuai/*=qwen|moonshotai/*=qwen|z-ai/*=qwen|glm-*=qwen|kimi-*=qwen|deepseek/*=qwen|MiniMax-*=minimax';

  it('matches a glob pattern and returns the configured provider', () => {
    expect(run('z-ai/glm-5.1', MAP)).toBe('qwen');
    expect(run('MiniMax-M3', MAP)).toBe('minimax');
    expect(run('moonshotai/kimi-k2', MAP)).toBe('qwen');
  });

  it('returns empty string when no pattern matches (caller keeps STORY_PROVIDER unchanged)', () => {
    expect(run('some-unlisted-model', MAP)).toBe('');
  });

  it('returns empty string when EPAM_MODEL_PROVIDER_MAP is unset (opt-in, no map = no-op)', () => {
    expect(run('z-ai/glm-5.1', '')).toBe('');
  });

  it('works for a hypothetical different-vendor project map — proves the engine is not tied to this project\'s vendors', () => {
    expect(run('gpt-4o', 'gpt-*=openai|claude-*=anthropic')).toBe('openai');
    expect(run('claude-sonnet-5', 'gpt-*=openai|claude-*=anthropic')).toBe('anthropic');
  });
});

// ── 8. Tier3 ESCALATION_MODEL is set and uses z-ai/glm-5.x ─────────────────
describe('tier3 script — ESCALATION_MODEL uses GLM 5.x reasoning model', () => {
  it('tier3 exports ESCALATION_MODEL variable', () => {
    expect(tier3).toMatch(/export\s+ESCALATION_MODEL/);
  });

  it('ESCALATION_MODEL default is z-ai/glm-5.x (reasoning, 1M ctx)', () => {
    expect(tier3).toMatch(/ESCALATION_MODEL.*z-ai\/glm-5/);
  });

  it('EPAM_MODEL_LADDER references ESCALATION_MODEL variable (not a hardcoded slug)', () => {
    // Ladder must reference ${ESCALATION_MODEL} so it can be overridden at runtime
    expect(tier3).toMatch(/EPAM_MODEL_LADDER.*ESCALATION_MODEL/s);
  });

  it('tier3 does not hardcode zhipuai/glm-z1-32b as the primary escalation step', () => {
    // glm-z1-32b is dead on OpenRouter — must not appear as a ladder target
    const ladderLine = tier3.split('\n').find(l => l.includes('EPAM_MODEL_LADDER='));
    expect(ladderLine).toBeDefined();
    // It may appear in legacy compat entries (as FROM, not TO for MiniMax-M3)
    // but must not be the MiniMax-M3 escalation target
    expect(ladderLine).not.toMatch(/MiniMax-M3=zhipuai\/glm-z1-32b/);
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
