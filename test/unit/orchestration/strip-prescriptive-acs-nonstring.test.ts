/**
 * stripPrescriptiveACs must not throw on a non-string AC (found live 2026-07-24,
 * AMSD-1820: "speckit review failed: ac.trim is not a function"). Speckit output is
 * LLM-shaped and occasionally contains a non-string acceptanceCriteria element (an
 * object / null / number); the function called `ac.trim()` unconditionally → TypeError
 * → the whole speckit review threw. It must coerce defensively and keep going.
 */
import { describe, it, expect } from 'vitest';

const { stripPrescriptiveACs } = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('stripPrescriptiveACs — robust against non-string ACs', () => {
  it('does not throw when an AC is an object / null / number (the live crash)', () => {
    expect(() => stripPrescriptiveACs(['a valid string AC', { given: 'x', when: 'y' }, null, 123], 'T')).not.toThrow();
  });

  it('still cleans/keeps valid string ACs and returns the clean+flagged shape', () => {
    const { clean, flagged } = stripPrescriptiveACs(['The email shows the discount', { bad: 'shape' }], 'T');
    expect(Array.isArray(clean)).toBe(true);
    expect(Array.isArray(flagged)).toBe(true);
    // the observable string AC survives as clean
    expect(clean).toContain('The email shows the discount');
  });

  it('empty / undefined input returns empty arrays (no throw)', () => {
    expect(stripPrescriptiveACs([], 'T')).toEqual({ clean: [], flagged: [] });
    expect(stripPrescriptiveACs(undefined, 'T')).toEqual({ clean: [], flagged: [] });
  });
});
