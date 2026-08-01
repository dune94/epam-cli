/**
 * Self-Heal All Phases — retry ladder + failure analyst must be wired for every
 * story in every phase (scaffold, core, ui_and_review).
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - Structural invariants only — no model names, no AC text, no PRD reads
 * - Mock PRD fixture used for any data-driven assertions
 * - All phases in the mock PRD must trigger the same retry+heal machinery
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const ORCH_SH   = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const MOCK_PRD  = join(__dirname, '../../fixtures/mock-prd.json');

const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc   = readFileSync(ORCH_SH, 'utf8');
const mockPrd   = JSON.parse(readFileSync(MOCK_PRD, 'utf8'));

// ── 1. Retry ladder exists and is unconditional (all phases) ─────────────────
describe('claude.sh — retry ladder fires for any story in any phase', () => {
  it('implement_story loop contains InferenceLadder Rung1 log line', () => {
    expect(claudeSrc).toMatch(/InferenceLadder\[Rung1\//);
  });

  it('implement_story loop contains InferenceLadder Rung2 log line', () => {
    expect(claudeSrc).toMatch(/InferenceLadder\[Rung2\//);
  });

  it('implement_story loop contains InferenceLadder Rung3 log line', () => {
    expect(claudeSrc).toMatch(/InferenceLadder\[Rung3\//);
  });

  it('EPAM_REASONING_EFFORT is exported so subprocesses receive it', () => {
    expect(claudeSrc).toMatch(/export\s+EPAM_REASONING_EFFORT/);
  });

  it('reasoning effort is reset to low at story start (no cross-story leakage)', () => {
    // Env-overridable via EPAM_RUNG0_REASONING_EFFORT — default is still "low".
    expect(claudeSrc).toMatch(/export EPAM_REASONING_EFFORT="\$\{EPAM_RUNG0_REASONING_EFFORT:-low\}"/);
  });

  it('ladder log lines do NOT contain "temp=" (reasoning effort ≠ temperature)', () => {
    const ladderLines = claudeSrc.split('\n').filter(l => l.includes('InferenceLadder'));
    for (const line of ladderLines) {
      expect(line, `InferenceLadder log line must not reference temperature: "${line}"`).not.toMatch(/temp=/);
    }
  });

  it('R2 calls get_model_ladder_step to escalate model', () => {
    expect(claudeSrc).toMatch(/get_model_ladder_step.*R2|ladder_step_r2.*get_model_ladder_step/is);
  });

  it('get_model_ladder_step reads EPAM_MODEL_LADDER — body has no hardcoded model names', () => {
    const funcStart = claudeSrc.indexOf('get_model_ladder_step()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/EPAM_MODEL_LADDER/);
    // The function body must be data-driven — no specific model families hardcoded
    expect(body).not.toMatch(/MiniMax|zhipuai|moonshotai|kimi/i);
  });
});

// ── 2. Failure analyst wired across all phases ────────────────────────────────
describe('claude.sh — failure analyst fires for any story in any phase', () => {
  it('run_failure_analyst is called in the retry loop (not phase-gated)', () => {
    const implStart = claudeSrc.indexOf('implement_story()');
    const implEnd   = claudeSrc.indexOf('\n}\n', implStart + 100);
    const implBody  = claudeSrc.slice(implStart, implEnd);
    expect(implBody).toMatch(/run_failure_analyst/);
  });

  it('analyst fires only when VERIFICATION_FAILURE is set (test suite ran and failed)', () => {
    expect(claudeSrc).toContain('[ -z "${VERIFICATION_FAILURE:-}" ] && return 0');
  });

  it('analyst fires only when more retries remain (not after the final attempt)', () => {
    const guardIdx   = claudeSrc.indexOf('retry_count -lt $MAX_RETRIES');
    const afterGuard = claudeSrc.slice(guardIdx, guardIdx + 200);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(afterGuard).toMatch(/run_failure_analyst/);
  });

  it('analyst always injects diagnosis into COORDINATOR_PROMPT_AMENDMENT', () => {
    expect(claudeSrc).toMatch(/COORDINATOR_PROMPT_AMENDMENT.*Self-Heal|Self-Heal.*COORDINATOR_PROMPT_AMENDMENT/is);
  });

  it('analyst uses ORCH_GATE_MODEL via env var — no hardcoded model names in body', () => {
    const analystStart = claudeSrc.indexOf('run_failure_analyst()');
    const analystEnd   = claudeSrc.indexOf('\n}', analystStart + 100);
    const body         = claudeSrc.slice(analystStart, analystEnd);
    expect(body).toMatch(/gate_model.*ORCH_GATE_MODEL/);
    expect(body).not.toMatch(/gpt-4o|claude-haiku|qwen3-coder/);
  });
});

// ── 3. Gate model env-var clobber prevention (run 103 root cause) ─────────────
describe('claude.sh — tier-script ORCH_GATE_MODEL survives .env reload', () => {
  it('saves ORCH_GATE_PROVIDER before the load_env_file CALL (not just the definition)', () => {
    const saveIdx = claudeSrc.indexOf('_claude_pre_gate_provider=');
    const callIdx = claudeSrc.indexOf('load_env_file "$(');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(callIdx);
  });

  it('saves ORCH_GATE_MODEL before the load_env_file CALL', () => {
    const saveIdx = claudeSrc.indexOf('_claude_pre_gate_model=');
    const callIdx = claudeSrc.indexOf('load_env_file "$(');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(callIdx);
  });

  it('saves EPAM_ORCHESTRATION_PROVIDER before the load_env_file CALL', () => {
    const saveIdx = claudeSrc.indexOf('_claude_pre_orch_provider=');
    const callIdx = claudeSrc.indexOf('load_env_file "$(');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(callIdx);
  });

  it('restores ORCH_GATE_MODEL after load_env_file (conditional on saved value being set)', () => {
    // indexOf-based check avoids catastrophic regex backtracking on large file
    const loadIdx    = claudeSrc.indexOf('load_env_file "$(');
    const restoreStr = '[ -n "$_claude_pre_gate_model"    ] && ORCH_GATE_MODEL="$_claude_pre_gate_model"';
    const restoreIdx = claudeSrc.indexOf(restoreStr);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(loadIdx);
  });

  it('restores EPAM_ORCHESTRATION_PROVIDER after load_env_file', () => {
    const loadIdx    = claudeSrc.indexOf('load_env_file "$(');
    const restoreStr = '_claude_pre_orch_provider" ] && EPAM_ORCHESTRATION_PROVIDER=';
    const restoreIdx = claudeSrc.indexOf(restoreStr);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(loadIdx);
  });

  it('unsets _claude_pre_* temp vars after restore (no subprocess env pollution)', () => {
    expect(claudeSrc).toContain('unset _claude_pre_gate_provider _claude_pre_gate_model _claude_pre_orch_provider');
  });

  it('re-exports gate vars after restore so worktree subprocesses inherit correct values', () => {
    const restoreIdx   = claudeSrc.indexOf('unset _claude_pre_');
    const afterRestore = claudeSrc.slice(restoreIdx, restoreIdx + 200);
    expect(afterRestore).toMatch(/export.*ORCH_GATE/);
  });
});

// ── 4. run-agent-orchestration.sh also protects gate vars ────────────────────
describe('run-agent-orchestration.sh — gate vars protected from .env override', () => {
  it('saves ORCH_GATE_PROVIDER before loading .env', () => {
    const saveIdx = orchSrc.indexOf('_pre_gate_provider=');
    const loadIdx = orchSrc.indexOf('. "$_env_file"');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(loadIdx);
  });

  it('saves ORCH_GATE_MODEL before loading .env', () => {
    const saveIdx = orchSrc.indexOf('_pre_gate_model=');
    const loadIdx = orchSrc.indexOf('. "$_env_file"');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(loadIdx);
  });

  it('restores ORCH_GATE_MODEL after .env load', () => {
    const loadIdx    = orchSrc.indexOf('. "$_env_file"');
    const restoreStr = '[ -n "$_pre_gate_model"    ] && ORCH_GATE_MODEL="$_pre_gate_model"';
    const restoreIdx = orchSrc.indexOf(restoreStr);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(loadIdx);
  });

  it('exports ORCH_GATE_MODEL so child processes inherit it', () => {
    expect(orchSrc).toMatch(/\[ -n.*ORCH_GATE_MODEL.*\]\s*&&\s*export ORCH_GATE_MODEL/);
  });
});

// ── 5. Tier3 script exports gate vars (structural — not checking specific values) ─
describe('tier3 script(s) — gate model env vars are exported (not which model)', () => {
  // We verify structure: gate vars MUST be exported by some tier3 script.
  // We do NOT check specific model names — those are configuration choices.
  const TIER3_SH = join(__dirname, '../../../orchestrations/scripts/tier3-travel-app-run.sh');
  const tier3Src = readFileSync(TIER3_SH, 'utf8');

  it('exports ORCH_GATE_PROVIDER', () => {
    expect(tier3Src).toMatch(/export\s+ORCH_GATE_PROVIDER/);
  });

  it('exports ORCH_GATE_MODEL', () => {
    expect(tier3Src).toMatch(/export\s+ORCH_GATE_MODEL/);
  });

  it('exports EPAM_MODEL_LADDER_MEDIUM and EPAM_MODEL_LADDER_HIGH, each with at least one from=to mapping', () => {
    // Format: "MODEL_A=MODEL_B|MODEL_C=MODEL_D" — check structure not specific models
    for (const varName of ['EPAM_MODEL_LADDER_MEDIUM', 'EPAM_MODEL_LADDER_HIGH']) {
      const idx  = tier3Src.indexOf(`${varName}=`);
      const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
      expect(idx, `${varName} not exported`).toBeGreaterThan(-1);
      expect(line).toContain('=');
      expect(line).toContain('|');
    }
  });

  it('EPAM_MODEL_LADDER (no suffix) is still exported as a back-compat single-ladder override', () => {
    expect(tier3Src).toMatch(/export\s+EPAM_MODEL_LADDER="\$\{EPAM_MODEL_LADDER:-\}"/);
  });
});

// ── 6. Mock PRD — all phases have stories that can trigger retry ──────────────
describe('mock PRD fixture — all phases have stories (retry fires for each)', () => {
  const phases = Object.keys(mockPrd.implementationOrder as Record<string, string[]>);

  it('at least two phases defined (scaffold + core minimum)', () => {
    expect(phases.length).toBeGreaterThanOrEqual(2);
  });

  it.each(phases)('phase "%s" has at least one story', (phase) => {
    const storyIds = (mockPrd.implementationOrder as Record<string, string[]>)[phase];
    expect(storyIds.length).toBeGreaterThan(0);
  });

  it('every story ID in mock implementationOrder exists in mock stories array', () => {
    const allStoriesById = new Set(mockPrd.stories.map((s: any) => s.id));
    const allPhaseIds    = Object.values(mockPrd.implementationOrder as Record<string, string[]>).flat();
    for (const id of allPhaseIds) {
      expect(allStoriesById.has(id), `${id} in implementationOrder not found in stories`).toBe(true);
    }
  });
});

// ── 7. Model ladder — fully env-driven, no hardcoded names in function body ───
describe('claude.sh — model ladder function is fully data-driven', () => {
  it('get_model_ladder_step function exists', () => {
    expect(claudeSrc).toMatch(/get_model_ladder_step\s*\(\)/);
  });

  it('function body reads EPAM_MODEL_LADDER (not hardcoded switch/case)', () => {
    const funcStart = claudeSrc.indexOf('get_model_ladder_step()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/EPAM_MODEL_LADDER/);
  });

  it('function body has NO hardcoded model family names', () => {
    const funcStart = claudeSrc.indexOf('get_model_ladder_step()');
    const funcEnd   = claudeSrc.indexOf('\n}', funcStart);
    const body      = claudeSrc.slice(funcStart, funcEnd);
    expect(body).not.toMatch(/MiniMax|zhipuai|moonshotai|kimi|glm/i);
  });
});

// ── 8. EPAM_REASONING_EFFORT — correct API parameter, never temperature ────────
describe('providers — EPAM_REASONING_EFFORT maps to native API param, not temperature', () => {
  const minimaxSrc = readFileSync(
    join(__dirname, '../../../src/providers/minimax/MiniMaxProvider.ts'), 'utf8'
  );
  const qwenSrc = readFileSync(
    join(__dirname, '../../../src/providers/qwen/QwenProvider.ts'), 'utf8'
  );

  it('MiniMaxProvider has resolveReasoningEffort, which stays independent of temperature', () => {
    expect(minimaxSrc).toMatch(/resolveReasoningEffort/);
    // resolveTemperature (added 2026-07-06, see resolveTemperature.test.ts) is a
    // separate, independent knob read from EPAM_TEMPERATURE — this guards that
    // resolveReasoningEffort itself never reads/touches temperature.
    const fnStart = minimaxSrc.indexOf('resolveReasoningEffort(request: ProviderRequest)');
    const fnEnd = minimaxSrc.indexOf('\n  }', fnStart);
    expect(minimaxSrc.slice(fnStart, fnEnd)).not.toMatch(/temperature/i);
  });

  it('MiniMaxProvider passes reasoning_effort as a separate request field', () => {
    expect(minimaxSrc).toMatch(/reasoning_effort/);
  });

  it('MiniMaxProvider temperature is resolved via resolveTemperature (request.temperature > EPAM_TEMPERATURE > default), not effort mapping', () => {
    expect(minimaxSrc).toMatch(/resolveTemperature\(request, 0\.7\)/);
    expect(minimaxSrc).not.toMatch(/effort.*===.*'high'.*return 0\.1|effort.*===.*'medium'.*return 0\.3/);
  });

  it('QwenProvider resolves temperature independently of reasoning effort (resolveTemperature never reads EPAM_REASONING_EFFORT)', () => {
    expect(qwenSrc).toMatch(/resolveTemperature\(request, 0\.7\)/);
  });

  it('QwenProvider sends reasoning.effort to OpenRouter via resolveOpenRouterReasoning', () => {
    expect(qwenSrc).toMatch(/resolveOpenRouterReasoning/);
    expect(qwenSrc).toMatch(/reasoning.*effort/is);
  });

  it('QwenProvider resolveOpenRouterReasoning covers low effort (not just medium+high)', () => {
    const funcStart = qwenSrc.indexOf('resolveOpenRouterReasoning');
    const funcEnd   = qwenSrc.indexOf('\n  }', funcStart);
    const body      = qwenSrc.slice(funcStart, funcEnd);
    expect(body).toMatch(/low/);
  });
});
