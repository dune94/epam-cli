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
import { execFileSync, spawnSync } from 'node:child_process';
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

  it('gates every retry on a successful escalation', () => {
    // Restructured 2026-07-29 (LAD-1): the single "retry once" is now a climb
    // loop, so the invariant is no longer "hot_swap appears after that message"
    // — it is that a retry only happens when hot_swap reports it ADVANCED to a
    // new rung. Retrying without advancing would re-run the same model, which
    // is the gamble the ladder exists to avoid.
    const idx = orchSrc.indexOf('while [ "$_rc" -eq 124 ]');
    expect(idx, 'the ladder climb loop is gone — only one escalation can happen').toBeGreaterThan(-1);
    const loop = orchSrc.slice(idx, idx + 900);
    expect(loop, 'the retry is not gated on a successful escalation')
      .toMatch(/hot_swap_story_model_if_unstable "\$story_id" \|\| _lad_swapped=1/);
    expect(orchSrc, 'the climb has no upper bound').toMatch(/EPAM_MAX_LADDER_ATTEMPTS/);
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
      const fnBody = [extractFunctionBodyBraceCounted('_story_archetype_ladder'), extractFunctionBodyBraceCounted('_resolve_ladder_tier'), extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable')].join('\n');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [{ id: 'SKY-999', model: opts.currentModel, aiProvider: 'openrouter', ladderTier: opts.ladderTier }],
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
      const stderr = (() => { const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' }); return `${r.stdout || ''}${r.stderr || ''}`; })();
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
      providerMap: 'moonshotai/*=openrouter|MiniMax-*=minimax',
    });
    expect(result.model).toBe('MiniMax-M3');
    expect(result.aiProvider).toBe('minimax');
  });

  it('uses the HIGH ladder for a high-tier story', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'high',
      ladderHigh: 'moonshotai/kimi-k2=z-ai/glm-5.1',
      providerMap: 'moonshotai/*=openrouter|z-ai/*=openrouter',
    });
    expect(result.model).toBe('z-ai/glm-5.1');
    expect(result.aiProvider).toBe('openrouter');
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
      providerMap: 'moonshotai/*=openrouter',
    });
    expect(result.model).toBe('some-unmapped-model');
    expect(result.aiProvider).toBe('openrouter');
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
 * REPRODUCES a live incident (2026-07-12, tier3-travel-app run): SKY-003-test
 * timed out on z-ai/glm-5.1 (a raw provider hang -- the API call's own raw
 * result file was 0 bytes, i.e. genuinely no response within the full
 * effort-scaled window, not a slow-but-working call). z-ai/glm-5.1 is
 * ESCALATION_MODEL_HIGH -- the TOP of both EPAM_MODEL_LADDER_MEDIUM and
 * EPAM_MODEL_LADDER_HIGH in tier3-travel-app-run.sh -- so
 * hot_swap_story_model_if_unstable() found no further ladder step and
 * silently no-op'd. The retry then re-invoked the IDENTICAL model/provider,
 * hit the same class of hang again, and the story was skipped entirely
 * after the second timeout -- exactly the "we gave up instead of healing"
 * gap flagged after this run.
 *
 * Fix: when no ladder step is available (the story is already at the top of
 * its ladder), fall back to EPAM_FINAL_FALLBACK_MODEL/PROVIDER -- a
 * genuinely DIFFERENT model+provider pairing already configured elsewhere in
 * this pipeline for exactly this "nowhere left to escalate" situation (see
 * claude.sh's own InferenceLadder Rung3 fallback) -- instead of silently
 * repeating the identical, already-failed pairing.
 */
describe('hot_swap_story_model_if_unstable — top-of-ladder fallback (fixes live gap)', () => {
  function run(opts: {
    currentModel: string;
    ladderTier?: string;
    ladderMedium?: string;
    ladderHigh?: string;
    providerMap?: string;
    finalFallbackModel?: string;
    finalFallbackProvider?: string;
  }): { model: string; aiProvider: string | null; warned: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'hot-swap-fallback-test-'));
    try {
      const fnBody = [extractFunctionBodyBraceCounted('_story_archetype_ladder'), extractFunctionBodyBraceCounted('_resolve_ladder_tier'), extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable')].join('\n');
      const prdFile = join(dir, 'prd.json');
      writeFileSync(
        prdFile,
        JSON.stringify({
          stories: [{ id: 'SKY-999', model: opts.currentModel, aiProvider: 'openrouter', ladderTier: opts.ladderTier }],
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
          opts.finalFallbackModel ? `EPAM_FINAL_FALLBACK_MODEL="${opts.finalFallbackModel}"` : '',
          opts.finalFallbackProvider ? `EPAM_FINAL_FALLBACK_PROVIDER="${opts.finalFallbackProvider}"` : '',
          fnBody,
          `hot_swap_story_model_if_unstable "SKY-999"`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const stderr = (() => { const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' }); return `${r.stdout || ''}${r.stderr || ''}`; })();
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

  it('REPRODUCES the live gap: a model at the top of its ladder (no configured step) now falls back to EPAM_FINAL_FALLBACK_MODEL instead of silently no-opping', () => {
    const result = run({
      currentModel: 'z-ai/glm-5.1',
      ladderTier: 'high',
      ladderHigh: 'MiniMax-M3=z-ai/glm-5.1', // z-ai/glm-5.1 is a TARGET, never a source -- no step FROM it
      providerMap: 'z-ai/*=openrouter|moonshotai/*=openrouter',
      finalFallbackModel: 'moonshotai/kimi-k2',
      finalFallbackProvider: 'openrouter',
    });
    // Desired (post-fix): swaps to the configured final fallback, a genuinely
    // different model, instead of leaving z-ai/glm-5.1 in place to repeat
    // the same hang on retry.
    expect(result.model).toBe('moonshotai/kimi-k2');
    expect(result.aiProvider).toBe('openrouter');
  });

  it('does not fall back when the current model already IS the final fallback (nothing left to try)', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'medium',
      finalFallbackModel: 'moonshotai/kimi-k2',
      finalFallbackProvider: 'openrouter',
    });
    expect(result.model).toBe('moonshotai/kimi-k2');
  });

  it('remains a true no-op when no final fallback is configured at all (preserves old behavior)', () => {
    const result = run({ currentModel: 'z-ai/glm-5.1', ladderTier: 'high' });
    expect(result.model).toBe('z-ai/glm-5.1');
  });

  it('a normal mid-ladder model still prefers its OWN ladder step over the final fallback (fallback is last-resort only)', () => {
    const result = run({
      currentModel: 'moonshotai/kimi-k2',
      ladderTier: 'medium',
      ladderMedium: 'moonshotai/kimi-k2=MiniMax-M3',
      providerMap: 'MiniMax-*=minimax',
      finalFallbackModel: 'z-ai/glm-5.1',
      finalFallbackProvider: 'openrouter',
    });
    expect(result.model).toBe('MiniMax-M3');
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
      const hotSwapBody = [extractFunctionBodyBraceCounted('_story_archetype_ladder'), extractFunctionBodyBraceCounted('_resolve_ladder_tier'), extractFunctionBodyBraceCounted('hot_swap_story_model_if_unstable')].join('\n');
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
          // the retry with a bigger budget completes." Call count is tracked in
          // a file, not a shell variable: `timeout ... | tee ...` runs this
          // function in a pipeline subshell, so a plain variable increment
          // never survives between invocations — every call would otherwise
          // see count=1 and return 124 forever, silently exercising the
          // double-timeout path this test isn't even trying to cover.
          `_timeout_call_count_file="${dir}/timeout-call-count"`,
          `echo 0 > "$_timeout_call_count_file"`,
          `timeout() {`,
          `  local _n=$(($(cat "$_timeout_call_count_file") + 1))`,
          `  echo "$_n" > "$_timeout_call_count_file"`,
          `  echo "$1" >> "${callLog}"`,
          `  if [ "$_n" -eq 1 ]; then return 124; fi`,
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
      (() => { const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' }); return `${r.stdout || ''}${r.stderr || ''}`; })();
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
