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

  it('produces the VC (verification criteria) layer', () => {
    // VC model (2026-07-24): ACs are never elaborated for ANY brownfield story;
    // verification lives in a separate, mechanism-free VC layer.
    //
    // The schema key is verificationCriteriaDetail, not verificationCriteria: a VC now
    // declares WHO observes it and on WHAT surface, because a criterion nobody can be
    // named to observe is not observable. This asserted the old flat key.
    expect(archaeologyBlock).toMatch(/VERIFICATION CRITERIA/);
    expect(schemaLine).toMatch(/"verificationCriteriaDetail":/);
    expect(schemaLine).toMatch(/"observer":/);
    expect(schemaLine).toMatch(/"vcSource":/);
  });

  it('mentions acceptance criteria ONLY when the story has them', () => {
    // A brownfield ticket has no ACs — the AC gate skips them entirely and records that
    // VCs come from the description. This block previously spent three sentences on AC
    // immutability regardless, i.e. ceremony about an array that is empty by design.
    // With ACs present (greenfield, or a ticket that really carries them) the
    // immutability instruction must still be intact.
    const withAcs = buildBrownfieldArchaeologyBlock(
      { EPAM_BROWNFIELD: '1' }, { hasAcceptanceCriteria: true }).archaeologyBlock;
    expect(withAcs).toMatch(/IMMUTABLE ticket intent/);
    expect(withAcs).toMatch(/copy the existing array through VERBATIM/);

    const withoutAcs = buildBrownfieldArchaeologyBlock(
      { EPAM_BROWNFIELD: '1' }, { hasAcceptanceCriteria: false }).archaeologyBlock;
    expect(
      withoutAcs,
      'the prompt talks about acceptance criteria to a ticket that has none',
    ).not.toMatch(/acceptance criteria|acceptanceCriteria/i);
  });

  it('forbids any implementation mechanism in a VC (the AC-quality guard)', () => {
    // Sourced from the shared VC_OBSERVABILITY_RULES constant (2026-07-24 hardening).
    expect(archaeologyBlock).toMatch(/prescribes HOW to implement/);
    // 2026-08-06: the rule no longer enumerates example phrasings — those were five
    // sentences from one past incident, carrying client-domain nouns. What a violation
    // looks like for a given story is derived per story by the guard-vocabulary agent.
    // The PRINCIPLE is what must survive, and that is what is asserted now.
    expect(archaeologyBlock).toMatch(/prescribes HOW to implement/i);
    expect(archaeologyBlock, 'the rule enumerates remembered examples again').not.toMatch(/halve|per segment|for each line item/i);
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
