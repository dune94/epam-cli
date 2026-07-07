import { describe, it, expect, afterEach } from 'vitest';
import { resolveTemperature } from '../../../src/providers/types.js';
import type { ProviderRequest } from '../../../src/providers/types.js';

/**
 * resolveTemperature — closes the gap flagged this session: temperature was
 * always hardcoded to `request.temperature ?? 0.7` with no way to override it
 * per-story. Mirrors the existing request-field > env-var > default pattern
 * already used for reasoningEffort (see QwenProvider/MiniMaxProvider's
 * resolveReasoningEffort), so both knobs are wired consistently.
 *
 * Motivating use case: a model exhibiting "creative" token-selection variance
 * across many retry attempts on a task with rigid, exact-string requirements
 * (e.g. an AC asserting a literal error-message substring) converges more
 * reliably at temperature 0 — the orchestration layer can now set
 * EPAM_TEMPERATURE=0 for a scoped fix/retry without needing a code change.
 */

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    messages: [],
    model: 'test-model',
    stream: false,
    ...overrides,
  };
}

describe('resolveTemperature', () => {
  const savedEnv = process.env.EPAM_TEMPERATURE;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.EPAM_TEMPERATURE;
    else process.env.EPAM_TEMPERATURE = savedEnv;
  });

  it('uses the provider default when neither request.temperature nor EPAM_TEMPERATURE is set', () => {
    delete process.env.EPAM_TEMPERATURE;
    expect(resolveTemperature(makeRequest(), 0.7)).toBe(0.7);
  });

  it('explicit request.temperature takes priority over everything', () => {
    process.env.EPAM_TEMPERATURE = '0.9';
    expect(resolveTemperature(makeRequest({ temperature: 0.3 }), 0.7)).toBe(0.3);
  });

  it('EPAM_TEMPERATURE overrides the provider default when request.temperature is unset', () => {
    process.env.EPAM_TEMPERATURE = '0';
    expect(resolveTemperature(makeRequest(), 0.7)).toBe(0);
  });

  it('supports fractional EPAM_TEMPERATURE values', () => {
    process.env.EPAM_TEMPERATURE = '0.15';
    expect(resolveTemperature(makeRequest(), 0.7)).toBe(0.15);
  });

  it('falls back to the default when EPAM_TEMPERATURE is set but not a valid number', () => {
    process.env.EPAM_TEMPERATURE = 'not-a-number';
    expect(resolveTemperature(makeRequest(), 0.7)).toBe(0.7);
  });

  it('falls back to the default when EPAM_TEMPERATURE is an empty string', () => {
    process.env.EPAM_TEMPERATURE = '';
    expect(resolveTemperature(makeRequest(), 0.7)).toBe(0.7);
  });

  it('treats request.temperature = 0 as an explicit value, not "unset" (falsy-zero pitfall)', () => {
    delete process.env.EPAM_TEMPERATURE;
    expect(resolveTemperature(makeRequest({ temperature: 0 }), 0.7)).toBe(0);
  });
});
