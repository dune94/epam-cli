/**
 * openspec brownfield intelligence: classify defect vs novel, and PRESERVE a
 * defect's acceptance criteria intact.
 *
 * Design (user direction, 2026-07-23): keep openspec as the single spec agent so
 * the code-graph-detective stays hooked to it (gated on `agent === 'openspec'`)
 * and greenfield is untouched. But a brownfield story is not always a bug — some
 * carry genuinely novel work. So openspec must have the intelligence to detect a
 * bug and "redact itself" — still RUN (locationHint + detective fire) but NOT
 * rewrite the ACs, because elaborating a defect's ACs bakes in a guessed fix
 * mechanism that misdirected the live AMSD-1820 run (openspec expanded a symptom
 * into 8 "split the discount" ACs; the agent built exactly that wrong design).
 *
 * A deterministic backstop (preserveDefectAcceptanceCriteria) enforces the STEP-3
 * prompt instruction even if the model ignores it. Greenfield never triggers it.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildBrownfieldArchaeologyBlock, preserveDefectAcceptanceCriteria } = spec;

describe('buildBrownfieldArchaeologyBlock — greenfield is untouched', () => {
  it('emits nothing for a greenfield run (no EPAM_BROWNFIELD)', () => {
    const { archaeologyBlock, schemaLine } = buildBrownfieldArchaeologyBlock({});
    expect(archaeologyBlock).toBe('');
    expect(schemaLine).toBe('');
  });
});

describe('buildBrownfieldArchaeologyBlock — brownfield classification', () => {
  const { archaeologyBlock, schemaLine } = buildBrownfieldArchaeologyBlock({ EPAM_BROWNFIELD: '1' });

  it('asks openspec to classify the story as defect vs novel', () => {
    expect(archaeologyBlock).toMatch(/CLASSIFY THIS STORY/);
    expect(archaeologyBlock).toMatch(/"defect"/);
    expect(archaeologyBlock).toMatch(/"novel"/);
    expect(schemaLine).toMatch(/"storyKind":"defect\|novel"/);
  });

  it('makes ACs immutable and produces the VC (verification criteria) layer instead', () => {
    // VC model (2026-07-24): ACs are never elaborated for ANY brownfield story;
    // verification lives in a separate, mechanism-free VC layer.
    expect(archaeologyBlock).toMatch(/VERIFICATION CRITERIA \(do NOT touch the acceptance criteria\)/);
    expect(archaeologyBlock).toMatch(/IMMUTABLE ticket intent/);
    expect(archaeologyBlock).toMatch(/copy the existing array through VERBATIM/);
    expect(schemaLine).toMatch(/"verificationCriteria":/);
    expect(schemaLine).toMatch(/"vcSource":/);
  });

  it('forbids any implementation mechanism in a VC (the AC-quality guard)', () => {
    // Sourced from the shared VC_OBSERVABILITY_RULES constant (2026-07-24 hardening).
    expect(archaeologyBlock).toMatch(/prescribes HOW to implement/);
    expect(archaeologyBlock).toMatch(/split.*halve.*calculate independently/is);
    expect(archaeologyBlock).toMatch(/CROSS-COMPARISON that presumes a mechanism/);
  });

  it('still requires locationHint for both kinds (detective/archaeology preserved)', () => {
    // Both kinds must still LOCATE — but the question they are asked now
    // differs: the fix site for a defect, the attachment point it integrates
    // with for a novel story. Asking a feature for a "fix site" invited an
    // invented file (live AMSD-2041: a fabricated quote against a real
    // filename). See brownfield-new-feature.test.ts.
    expect(archaeologyBlock).toMatch(/LOCATE \(always, for both kinds/);
    expect(archaeologyBlock, 'the two kinds are no longer asked different questions')
      .toMatch(/attach|integrat/i);
    expect(schemaLine).toMatch(/"locationHint":/);
  });
});

describe('preserveDefectAcceptanceCriteria — deterministic backstop', () => {
  const ORIGINAL = ['discount shows for return trip', 'no regression for outbound'];
  const REWRITTEN = ['split the discount across both segments', 'sum equals total', 'each segment non-negative'];

  it('restores the original ACs when openspec rewrote a DEFECT (and reports it redacted)', () => {
    const story = { id: 'AMSD-1820', acceptanceCriteria: ORIGINAL.slice() };
    const payload = { storyKind: 'defect', acceptanceCriteria: REWRITTEN.slice(), locationHint: [{ file: 'x.ts' }] };
    const redacted = preserveDefectAcceptanceCriteria(payload, story, { EPAM_BROWNFIELD: '1' });
    expect(redacted).toBe(true);
    expect(payload.acceptanceCriteria).toEqual(ORIGINAL); // openspec's edits thrown away
    expect(payload.locationHint).toEqual([{ file: 'x.ts' }]); // locationHint survives — detective still works
  });

  it('is a no-op (returns false) when a defect\'s ACs were already left unchanged', () => {
    const story = { id: 'B', acceptanceCriteria: ORIGINAL.slice() };
    const payload = { storyKind: 'defect', acceptanceCriteria: ORIGINAL.slice() };
    expect(preserveDefectAcceptanceCriteria(payload, story, { EPAM_BROWNFIELD: '1' })).toBe(false);
    expect(payload.acceptanceCriteria).toEqual(ORIGINAL);
  });

  it('preserves ACs for NOVEL brownfield work too (VC model: ACs immutable for ALL brownfield)', () => {
    const story = { id: 'C', acceptanceCriteria: ORIGINAL.slice() };
    const payload = { storyKind: 'novel', acceptanceCriteria: REWRITTEN.slice() };
    // Under the VC model ACs are immutable regardless of storyKind — a novel
    // story's ACs are restored just like a defect's; verification is the VC layer.
    expect(preserveDefectAcceptanceCriteria(payload, story, { EPAM_BROWNFIELD: '1' })).toBe(true);
    expect(payload.acceptanceCriteria).toEqual(ORIGINAL);
  });

  it('is a no-op in GREENFIELD even if storyKind says defect (brownfield-gated)', () => {
    const story = { id: 'D', acceptanceCriteria: ORIGINAL.slice() };
    const payload = { storyKind: 'defect', acceptanceCriteria: REWRITTEN.slice() };
    expect(preserveDefectAcceptanceCriteria(payload, story, {})).toBe(false);
    expect(payload.acceptanceCriteria).toEqual(REWRITTEN); // greenfield flow never altered
  });

  it('never throws on malformed input (missing payload / ACs)', () => {
    expect(preserveDefectAcceptanceCriteria(null, { acceptanceCriteria: [] }, { EPAM_BROWNFIELD: '1' })).toBe(false);
    expect(preserveDefectAcceptanceCriteria({ storyKind: 'defect' }, {}, { EPAM_BROWNFIELD: '1' })).toBe(false);
  });
});
