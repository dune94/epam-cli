/**
 * AN AGENT INPUT IS NEVER TRUNCATED.
 *
 * Operator mandate, 2026-08-15: "i want no truncation of inputs anywhere in pipeline".
 *
 * Every site below cuts INSIDE a unit of meaning — mid-sentence, mid-literal, mid-stream —
 * on text that is then handed to a model as evidence or as instructions. A severed literal
 * is worse than an absent one: the reader cannot tell it is incomplete and acts on the
 * fragment. That is the standing rule these tests enforce.
 *
 * Each test executes the REAL function and asserts on the artifact it produces — the
 * rendered prompt — never on source text.
 */
import { describe, it, expect } from 'vitest';

const {
  buildAssignmentPrompt,
  buildGuardEvidence,
} = require('../../../orchestrations/scripts/spec-mode-runner.js');

/** A brief longer than the 320-char cut, with a decisive literal past the boundary. */
const LONG_BRIEF =
  'Owns the service layer and every adapter beneath it. '.repeat(6) +
  'CRITICAL: the delimiter is the literal "#" and never "-".';

describe('a role brief reaches the assignment prompt whole', () => {
  const ROLES = [{ name: 'alpha-engineer', brief: LONG_BRIEF }];
  const STORIES = [
    { id: 'S-1', title: 'a story', description: 'do the thing', codelines: ['one'] },
  ];

  it('the fixture actually exceeds the old cut, or this proves nothing', () => {
    expect(LONG_BRIEF.length).toBeGreaterThan(320);
  });

  it('renders a non-empty prompt', () => {
    expect(buildAssignmentPrompt(STORIES, ROLES).length).toBeGreaterThan(200);
  });

  it('carries the brief in full, including the literal past the old boundary', () => {
    const p = buildAssignmentPrompt(STORIES, ROLES);
    // The whole brief, not a prefix of it.
    expect(p).toContain(LONG_BRIEF.replace(/\s+/g, ' ').trim());
    // The decisive literal sits past char 320 — exactly what a prefix cut would sever.
    expect(p, 'the rule naming the delimiter was cut off').toContain('never "-"');
  });

  it('still collapses whitespace — the fix removes the CUT, not the normalisation', () => {
    const messy = [{ name: 'r', brief: 'line one\n\n   line two' }];
    const p = buildAssignmentPrompt(STORIES, messy);
    expect(p).toContain('line one line two');
  });
});

describe('the guard vocabulary sees every finding, whole', () => {
  const FINDINGS = Array.from({ length: 10 }, (_, i) => ({
    file: `src/f${i}.ts`,
    reason: `Reason ${i} `.repeat(45) + `DELIMITER-IS-HASH-${i}`,
  }));

  it('the fixture exceeds both old cuts, or this proves nothing', () => {
    expect(FINDINGS.length).toBeGreaterThan(8);
    expect(FINDINGS[0].reason.length).toBeGreaterThan(300);
  });

  it('includes findings past the 8th — the block the prompt calls ground truth', () => {
    const e = buildGuardEvidence(FINDINGS);
    expect(e, 'the 9th finding did not exist to the model').toContain('src/f8.ts');
    expect(e).toContain('src/f9.ts');
  });

  it('carries each reason whole, including a literal past char 300', () => {
    const e = buildGuardEvidence(FINDINGS);
    expect(e, 'a reason arrived severed mid-sentence').toContain('DELIMITER-IS-HASH-0');
    expect(e).toContain('DELIMITER-IS-HASH-9');
  });

  it('is empty-safe', () => {
    expect(buildGuardEvidence(undefined)).toBe('');
    expect(buildGuardEvidence([])).toBe('');
  });
});
