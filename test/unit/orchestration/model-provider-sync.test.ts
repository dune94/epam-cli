/**
 * Root cause of a live hang (found 2026-07-07, tier3 relaunch): spec-mode's LLM
 * model-review step overrides a story's .model field (e.g.
 * moonshotai/kimi-k2 -> MiniMax-M3) but never touched .aiProvider. A story ended
 * up with aiProvider="qwen" (OpenRouter routing, correct for the OLD model)
 * paired with model="MiniMax-M3" (a MiniMax-native model needing the "minimax"
 * provider) — sending the wrong model name to the wrong API. That request never
 * resolved and hung until the pipeline's 600s watchdog killed it, twice, on
 * SKY-002-test and SKY-003-test — misread at first as flaky-API/network noise.
 *
 * Fix: spec-mode-runner.js now derives the correct provider for the new model
 * (via resolveModelProvider(), a JS port of claude.sh's resolve_model_provider())
 * and updates .aiProvider in lockstep whenever .model changes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_MODE_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');

const { resolveModelProvider } = require(SPEC_MODE_RUNNER);

const PROVIDER_MAP =
  'zhipuai/*=qwen|moonshotai/*=qwen|z-ai/*=qwen|glm-*=qwen|kimi-*=qwen|deepseek/*=qwen|MiniMax-*=minimax';

describe('resolveModelProvider() — JS port of resolve_model_provider (config-driven, no hardcoded vendors)', () => {
  it('matches the exact live bug shape: MiniMax-M3 resolves to "minimax", not "qwen"', () => {
    expect(resolveModelProvider('MiniMax-M3', { EPAM_MODEL_PROVIDER_MAP: PROVIDER_MAP })).toBe('minimax');
  });

  it('matches an OpenRouter-routed vendor to "qwen"', () => {
    expect(resolveModelProvider('moonshotai/kimi-k2', { EPAM_MODEL_PROVIDER_MAP: PROVIDER_MAP })).toBe('qwen');
    expect(resolveModelProvider('z-ai/glm-5.2', { EPAM_MODEL_PROVIDER_MAP: PROVIDER_MAP })).toBe('qwen');
  });

  it('returns null when no pattern matches (caller keeps existing aiProvider)', () => {
    expect(resolveModelProvider('gpt-4o', { EPAM_MODEL_PROVIDER_MAP: PROVIDER_MAP })).toBeNull();
  });

  it('returns null when EPAM_MODEL_PROVIDER_MAP is unset (opt-in, no-op by default)', () => {
    expect(resolveModelProvider('MiniMax-M3', {})).toBeNull();
  });

  it('is domain-agnostic: works for an arbitrary hypothetical vendor map, not tied to this project\'s vendors', () => {
    const hypothetical = 'gpt-*=openai|claude-*=anthropic|Llama-*=meta';
    expect(resolveModelProvider('gpt-5-codex', { EPAM_MODEL_PROVIDER_MAP: hypothetical })).toBe('openai');
    expect(resolveModelProvider('claude-sonnet-5', { EPAM_MODEL_PROVIDER_MAP: hypothetical })).toBe('anthropic');
    expect(resolveModelProvider('Llama-3', { EPAM_MODEL_PROVIDER_MAP: hypothetical })).toBe('meta');
  });
});

describe('spec-mode model-override path keeps aiProvider in sync (source inspection)', () => {
  const src = readFileSync(SPEC_MODE_RUNNER, 'utf8');

  it('calls resolveModelProvider immediately after mutating story.model', () => {
    const idx = src.indexOf('story.model = fa.finalModel;');
    expect(idx).toBeGreaterThan(-1);
    const nextLines = src.slice(idx, idx + 700);
    expect(nextLines).toMatch(/resolveModelProvider\(fa\.finalModel\)/);
    expect(nextLines).toMatch(/story\.aiProvider = newProvider;/);
  });
});
