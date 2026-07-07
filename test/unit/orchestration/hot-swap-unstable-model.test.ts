/**
 * User request (2026-07-07, after diagnosing a live provider/model-mismatch
 * hang): "If it is a model/provider related issue - then we need a hot-swap
 * model if a model is unstable."
 *
 * hot_swap_story_model_if_unstable() (run-agent-orchestration.sh) is called
 * right after a story's FIRST watchdog timeout, before the automatic retry —
 * a timeout means zero signal was produced in the full effort-scaled window,
 * so retrying with the exact same model+provider risks repeating an unstable
 * pairing for the full window again. It escalates exactly one ladder step
 * (reusing the same EPAM_MODEL_LADDER_MEDIUM/HIGH + EPAM_MODEL_PROVIDER_MAP
 * config already used by claude.sh's inference ladder) and writes the new
 * model/provider back into the PRD before the retry.
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

describe('run-agent-orchestration.sh — hot-swap wiring', () => {
  it('hot_swap_story_model_if_unstable is defined', () => {
    expect(orchSrc).toMatch(/hot_swap_story_model_if_unstable\s*\(\)/);
  });

  it('is called after the first timeout, before the automatic retry', () => {
    const idx = orchSrc.indexOf('timed out after ${timeout_secs}s — retrying once');
    expect(idx).toBeGreaterThan(-1);
    const nextLines = orchSrc.slice(idx, idx + 300);
    expect(nextLines).toMatch(/hot_swap_story_model_if_unstable "\$story_id"/);
  });
});

describe('hot_swap_story_model_if_unstable — REAL execution', () => {
  function run(opts: {
    currentModel: string;
    ladderTier?: string;
    ladderMedium?: string;
    ladderHigh?: string;
    providerMap?: string;
  }): { model: string; aiProvider: string | null; warned: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hot-swap-test-'));
    try {
      const fnBody = extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [{ id: 'SKY-999', model: opts.currentModel, aiProvider: 'qwen', ladderTier: opts.ladderTier }],
        }),
      );
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdFile}"`,
          `warning() { echo "WARN: $*" >&2; }`,
          opts.ladderMedium ? `EPAM_MODEL_LADDER_MEDIUM="${opts.ladderMedium}"` : '',
          opts.ladderHigh ? `EPAM_MODEL_LADDER_HIGH="${opts.ladderHigh}"` : '',
          opts.providerMap ? `EPAM_MODEL_PROVIDER_MAP="${opts.providerMap}"` : '',
          fnBody,
          `hot_swap_story_model_if_unstable "SKY-999"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const stderr = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const prd = JSON.parse(readFileSync(prdFile, 'utf8'));
      return {
        model: prd.stories[0].model,
        aiProvider: prd.stories[0].aiProvider,
        warned: stderr.split('\n').filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('escalates the model one ladder step AND syncs the provider (the live bug shape, fixed)', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'medium',
      ladderMedium: 'moonshotai/kimi-k2=MiniMax-M3',
      providerMap: 'moonshotai/*=qwen|MiniMax-*=minimax',
    });
    expect(result.model).toBe('MiniMax-M3');
    expect(result.aiProvider).toBe('minimax');
  });

  it('uses the HIGH ladder for a high-tier story', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'high',
      ladderHigh: 'moonshotai/kimi-k2=z-ai/glm-5.1',
      providerMap: 'moonshotai/*=qwen|z-ai/*=qwen',
    });
    expect(result.model).toBe('z-ai/glm-5.1');
    expect(result.aiProvider).toBe('qwen');
  });

  it('is a no-op when no ladder is configured for this tier', () => {
    const result = run({ currentModel: 'moonshotai/kimi-k2', ladderTier: 'medium' });
    expect(result.model).toBe('moonshotai/kimi-k2');
  });

  it('is a no-op when the current model has no entry in the configured ladder', () => {
    const result = run({
      currentModel: 'some-other-model',
      ladderTier: 'medium',
      ladderMedium: 'moonshotai/kimi-k2=MiniMax-M3',
    });
    expect(result.model).toBe('some-other-model');
  });

  it('leaves aiProvider unchanged when the new model has no provider-map match (keeps existing aiProvider rather than nulling it)', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'medium',
      ladderMedium: 'moonshotai/kimi-k2=some-unmapped-model',
      providerMap: 'moonshotai/*=qwen',
    });
    expect(result.model).toBe('some-unmapped-model');
    expect(result.aiProvider).toBe('qwen');
  });

  it('is domain-agnostic: works for an arbitrary hypothetical vendor ladder, not tied to this project\'s models', () => {
    const result = run({
      currentModel: 'gpt-4o',
      ladderTier: 'medium',
      ladderMedium: 'gpt-4o=claude-sonnet-5',
      providerMap: 'gpt-*=openai|claude-*=anthropic',
    });
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.aiProvider).toBe('anthropic');
  });
});

/**
 * Watchdog retry-timeout scaling (2026-07-07): found live that a story's SECOND
 * watchdog attempt (post-hot-swap) can time out too — a live process inspection
 * during a real timeout showed a genuinely in-flight, still-ESTABLISHED API
 * connection, not a stuck/crashed process. Root cause: each retry within a
 * claude.sh invocation appends more KB/coordinator-guidance context, so by the
 * time a story reaches its 4th-5th internal attempt the cumulative prompt is
 * measurably bigger than attempt 1's — a bigger prompt can legitimately take
 * longer to answer. Handing the retry the exact same flat timeout budget that
 * already proved insufficient once is the wrong default. Fix: the retry gets a
 * scaled-up timeout (EPAM_WATCHDOG_RETRY_MULTIPLIER, default 1.5x).
 */
describe('run_story_with_watchdog — retry timeout scaling (REAL execution)', () => {
  function run(opts: { multiplier?: string }): { durations: number[] } {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-timeout-test-'));
    try {
      const watchdogBody = extractFunctionBodyBraceCounted('run_story_with_watchdog');
      const hotSwapBody = extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable');
      const callLog = join(dir, 'timeout-calls.txt');
      const logFile = join(dir, 'story.log');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `warning() { :; }`,
          `error() { :; }`,
          `wait_if_paused() { :; }`,
          `PHASE="core"`,
          `LOG_DIR="${dir}"`,
          opts.multiplier ? `EPAM_WATCHDOG_RETRY_MULTIPLIER="${opts.multiplier}"` : '',
          // Stub `timeout` itself: log the requested duration, fail (124) on the
          // first call, succeed on the second — simulates "timed out once, then
          // the retry with a bigger budget completes."
          `_timeout_call_count=0`,
          `timeout() {`,
          `  _timeout_call_count=$((_timeout_call_count + 1))`,
          `  echo "$1" >> "${callLog}"`,
          `  if [ "$_timeout_call_count" -eq 1 ]; then return 124; fi`,
          `  return 0`,
          `}`,
          hotSwapBody,
          watchdogBody,
          `STORY_TIMEOUT_SECS=100`,
          `run_story_with_watchdog "SKY-999" "${logFile}"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const durations = readFileSync(callLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number);
      return { durations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('scales the retry timeout by the default 1.5x multiplier', () => {
    const { durations } = run({});
    expect(durations).toEqual([100, 150]);
  });

  it('respects a custom EPAM_WATCHDOG_RETRY_MULTIPLIER', () => {
    const { durations } = run({ multiplier: '2' });
    expect(durations).toEqual([100, 200]);
  });

  it('setting the multiplier to 1 restores the old flat-timeout behavior', () => {
    const { durations } = run({ multiplier: '1' });
    expect(durations).toEqual([100, 100]);
  });
});
