/**
 * Found live 2026-07-13: SKY-002-test was classified "low effort" (8
 * acceptanceCriteria, MiniMax-M3) by spec-mode-runner.js's
 * modelComplexitySignals() during Step 0 — before the inline TC writer
 * (post-impl-tc-writer.sh) had ever run for this story. Once TCs were
 * actually written, the real test file needed to satisfy 22 granular,
 * exact-match behavioral facts (exact error strings, env-var precedence,
 * multi-key field-extraction fallbacks, a large bannedPatterns list) — data
 * the Step 0 classifier never had. The story burned its full 8-attempt
 * escalation ladder on small precision slips against all 22 checks, then
 * failed on a watchdog timeout at the highest rung.
 *
 * maybe_upgrade_model_for_tc_density() (run-agent-orchestration.sh) is
 * called right after the inline TC writer succeeds, before that story's own
 * implementation attempt begins — re-assesses model tier using the now-known
 * TC-fact count, upgrading (and syncing aiProvider via EPAM_MODEL_PROVIDER_MAP,
 * same pattern as hot_swap_story_model_if_unstable) when facts exceed a
 * configurable threshold and the story isn't already at the upgrade tier.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFunctionBodyBraceCounted(name: string): string {
  const start = orchSrc.indexOf(`${name}()`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  const braceStart = orchSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < orchSrc.length; i++) {
    if (orchSrc[i] === '{') depth++;
    else if (orchSrc[i] === '}') {
      depth--;
      if (depth === 0) return orchSrc.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

describe('run-agent-orchestration.sh — TC-density model upgrade wiring', () => {
  it('maybe_upgrade_model_for_tc_density is defined', () => {
    expect(orchSrc).toMatch(/maybe_upgrade_model_for_tc_density\s*\(\)/);
  });

  it('is called right after the inline TC writer succeeds, before the story runs', () => {
    const idx = orchSrc.indexOf('success "  TC writer populated testCriteria for $story');
    expect(idx).toBeGreaterThan(-1);
    const nextLines = orchSrc.slice(idx, idx + 300);
    expect(nextLines).toMatch(/maybe_upgrade_model_for_tc_density "\$story" "\$\{_tc_inline_facts_len:-0\}"/);
  });
});

describe('maybe_upgrade_model_for_tc_density — REAL execution', () => {
  function run(opts: {
    currentModel: string;
    tcFactsCount: number;
    upgradeModel?: string;
    providerMap?: string;
    threshold?: string;
  }): { model: string; aiProvider: string | null; specification: any; warned: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'tc-density-upgrade-test-'));
    try {
      const fnBody = extractFunctionBodyBraceCounted('maybe_upgrade_model_for_tc_density');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [{ id: 'SKY-999', model: opts.currentModel, aiProvider: 'qwen', specification: {} }],
        }),
      );
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `warning() { echo "WARN: $*" >&2; }`,
          opts.upgradeModel ? `ORCH_UPGRADE_MODEL="${opts.upgradeModel}"` : '',
          opts.providerMap ? `EPAM_MODEL_PROVIDER_MAP="${opts.providerMap}"` : '',
          opts.threshold ? `EPAM_TC_FACTS_UPGRADE_THRESHOLD="${opts.threshold}"` : '',
          fnBody,
          `maybe_upgrade_model_for_tc_density "SKY-999" "${opts.tcFactsCount}"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const stderr = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const prd = JSON.parse(readFileSync(prdFile, 'utf8'));
      return {
        model: prd.stories[0].model,
        aiProvider: prd.stories[0].aiProvider,
        specification: prd.stories[0].specification,
        warned: stderr.split('\n').filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the live gap: 22 TC facts on a "low effort" model now upgrades instead of silently proceeding', () => {
    const result = run({
      currentModel: 'MiniMax-M3',
      tcFactsCount: 22,
      upgradeModel: 'z-ai/glm-5.1',
      providerMap: 'MiniMax-*=minimax|z-ai/*=qwen',
    });
    expect(result.model).toBe('z-ai/glm-5.1');
    expect(result.aiProvider).toBe('qwen');
    expect(result.specification.tcDensityUpgrade).toMatchObject({
      from: 'MiniMax-M3',
      to: 'z-ai/glm-5.1',
    });
  });

  it('does not upgrade when TC fact count is at or below the default threshold (15)', () => {
    const result = run({ currentModel: 'MiniMax-M3', tcFactsCount: 15, upgradeModel: 'z-ai/glm-5.1' });
    expect(result.model).toBe('MiniMax-M3');
    expect(result.specification.tcDensityUpgrade).toBeUndefined();
  });

  it('does not upgrade when TC fact count is low (the common case — most stories are not over-classified)', () => {
    const result = run({ currentModel: 'MiniMax-M3', tcFactsCount: 8, upgradeModel: 'z-ai/glm-5.1' });
    expect(result.model).toBe('MiniMax-M3');
  });

  it('does not upgrade when the story is already at the upgrade tier (no redundant write)', () => {
    const result = run({ currentModel: 'z-ai/glm-5.1', tcFactsCount: 22, upgradeModel: 'z-ai/glm-5.1' });
    expect(result.model).toBe('z-ai/glm-5.1');
    expect(result.specification.tcDensityUpgrade).toBeUndefined();
  });

  it('is a no-op when ORCH_UPGRADE_MODEL is not configured at all', () => {
    const result = run({ currentModel: 'MiniMax-M3', tcFactsCount: 22 });
    expect(result.model).toBe('MiniMax-M3');
  });

  it('respects a custom EPAM_TC_FACTS_UPGRADE_THRESHOLD', () => {
    const belowCustom = run({
      currentModel: 'MiniMax-M3',
      tcFactsCount: 10,
      upgradeModel: 'z-ai/glm-5.1',
      threshold: '5',
    });
    expect(belowCustom.model).toBe('z-ai/glm-5.1');

    const belowDefault = run({
      currentModel: 'MiniMax-M3',
      tcFactsCount: 10,
      upgradeModel: 'z-ai/glm-5.1',
    });
    expect(belowDefault.model).toBe('MiniMax-M3');
  });

  it('leaves aiProvider unchanged when the upgrade model has no provider-map match', () => {
    const result = run({
      currentModel: 'MiniMax-M3',
      tcFactsCount: 22,
      upgradeModel: 'some-unmapped-model',
      providerMap: 'MiniMax-*=minimax',
    });
    expect(result.model).toBe('some-unmapped-model');
    expect(result.aiProvider).toBe('qwen'); // unchanged from the original
  });

  it('is domain-agnostic: works for an arbitrary hypothetical vendor pairing, not tied to this project\'s models', () => {
    const result = run({
      currentModel: 'gpt-4o-mini',
      tcFactsCount: 20,
      upgradeModel: 'gpt-4o',
      providerMap: 'gpt-*=openai',
    });
    expect(result.model).toBe('gpt-4o');
    expect(result.aiProvider).toBe('openai');
  });
});
