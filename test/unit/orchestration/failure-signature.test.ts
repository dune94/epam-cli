/**
 * A failure signature must be derived from TOOL OUTPUT, never from the LLM's prose.
 *
 * The replay of 118 real healing episodes found only FOUR carried a compiler error
 * code — the rest were free-text diagnoses. A regex classifier over that prose
 * scored 50.8%; careful human reading of the same corpus scored 94.1%. That 43-point
 * gap is not a tuning problem, it is the nature of classifying prose, and it makes
 * the store's deterministic (agent_role, signature) lookup key unreliable at the
 * source.
 *
 * tsc and vitest already emit exact, stable identifiers. This module reads those.
 * The model's summary stays in the episode as `diagnosis` — useful for a human
 * reading the log, never used as a key.
 *
 * Fixtures below are REAL tool output shapes, not invented ones — the same rule that
 * caught the validator which deleted working tests because a fabricated stub omitted
 * the `AssertionError:` line.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
const sig = require(join(__dirname, '../../../orchestrations/scripts/lib/failure-signature.js'));

describe('tsc output', () => {
  it('extracts the error code', () => {
    expect(sig.fromToolOutput(
      "src/svc/discount.ts(77,3): error TS1005: ';' expected."
    )).toEqual({ signature: 'TS1005', source: 'tsc' });
  });

  it('picks the FIRST error when several are reported — a stable key needs one', () => {
    expect(sig.fromToolOutput([
      "src/a.ts(1,1): error TS2532: Object is possibly 'undefined'.",
      "src/b.ts(9,2): error TS1005: ';' expected.",
    ].join('\n')).signature).toBe('TS2532');
  });

  it('ignores a code appearing inside prose rather than an error line', () => {
    // returns null outright — prose is never a key, not even when it contains a code
    expect(sig.fromToolOutput('the agent mentioned TS1005 in passing')).toBeNull();
  });
});

describe('vitest output', () => {
  it('classifies a transform/parse failure as never-ran, not as a test failure', () => {
    // These demand opposite responses: a malformed test proves nothing about the fix.
    expect(sig.fromToolOutput([
      'Error: Transform failed with 1 error:',
      '/repo/src/x.spec.ts:36:10: ERROR: Expected ";" but found ":"',
    ].join('\n'))).toEqual({ signature: 'parse-error', source: 'vitest' });
  });

  it('classifies a real assertion failure as a test failure', () => {
    expect(sig.fromToolOutput([
      ' ❯ reproduces the bug',
      "AssertionError: expected undefined to deeply equal { name: '' }",
      ' Test Files  1 failed (1)',
    ].join('\n'))).toEqual({ signature: 'test-failure', source: 'vitest' });
  });

  it('does NOT mistake AssertionError for a parse error (the live regex bug)', () => {
    // `ERROR: Expected` once matched `AssertionError: expected` case-insensitively
    // and every assertion failure was misread as "never ran" — deleting good tests.
    expect(sig.fromToolOutput('AssertionError: expected 1 to be 2').signature).toBe('test-failure');
  });

  it('classifies a missing module', () => {
    expect(sig.fromToolOutput("Error: Cannot find module './skyscanner-client'").signature)
      .toBe('missing-module');
  });
});

describe('honesty about what it cannot key', () => {
  it('returns null rather than guessing when the output has no tool signal', () => {
    expect(sig.fromToolOutput('the agent seemed confused')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(sig.fromToolOutput('')).toBeNull();
    expect(sig.fromToolOutput(undefined as any)).toBeNull();
  });
});

describe('episode construction records WHERE the key came from', () => {
  it('marks a tool-derived signature as trustworthy for keying', () => {
    const ep = sig.buildEpisode({ id: 'e1', toolOutput: 'src/a.ts(1,1): error TS2532: x', diagnosis: 'prose' });
    expect(ep.signature).toBe('TS2532');
    expect(ep.signature_source).toBe('tsc');
  });

  it('records the diagnosis but NEVER derives the key from it', () => {
    const ep = sig.buildEpisode({ id: 'e1', toolOutput: 'nothing useful', diagnosis: 'Missing closing brace causing TS1005' });
    expect(ep.diagnosis).toContain('TS1005');   // kept for humans
    expect(ep.signature).toBeNull();            // but not used as a key
    expect(ep.signature_source).toBeNull();
  });
});
