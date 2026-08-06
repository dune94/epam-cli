/**
 * THE PROMPT MUST NOT DEPEND ON ACCEPTANCE CRITERIA THAT DO NOT EXIST.
 *
 * A brownfield ticket has no acceptance criteria. The AC gate says so itself, skipping AC
 * processing entirely and recording "VCs are derived from the description". Yet the spec
 * agent's STEP 3 opens by talking about them at length:
 *
 *   "STEP 3 — VERIFICATION CRITERIA (do NOT touch the acceptance criteria).
 *    The acceptanceCriteria are the IMMUTABLE ticket intent — copy the existing array
 *    through VERBATIM: never reword, split, add, remove, re-scope...
 *    ...derived from the acceptance criteria AND the description (lean on the description
 *    when the ACs are sparse or missing)."
 *
 * Three sentences about an empty array, and the only source it then names is a description
 * that on AMSD-2041 is 395 characters — of which about a quarter is estimate boilerplate
 * ("Original Total Estimate: 8 Original FE Estimate: 8..."). Four thin VCs came out, and the
 * one covering the ticket's own stated limitation was dropped by the guard.
 *
 * Meanwhile the SAME prompt carries 4KB of vendor documentation, fetched from links on the
 * ticket, under a header that calls it "authoritative over assumption" — quoting the SDK
 * configuration, the callback contract and the CSR/SSR scope. STEP 3 does not name it, so
 * the model treats it as background for implementation and derives verification from the two
 * thinnest fields in the prompt.
 *
 * That is an integration gap: the documentation source was added on 2026-08-06 and the
 * instruction that decides where verification comes from was never updated.
 *
 * So: mention acceptance criteria ONLY when the story has them, and name referenced
 * documentation as a first-class source of observable checks.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const BROWNFIELD = { EPAM_BROWNFIELD: '1' };

function block(opts: Record<string, unknown>): string {
  return spec.buildBrownfieldArchaeologyBlock(BROWNFIELD, opts).archaeologyBlock;
}

describe('a story with NO acceptance criteria is not told about acceptance criteria', () => {
  const noAcs = () => block({ hasAcceptanceCriteria: false, hasReferencedDocs: true });

  it('the fixture renders something — otherwise every assertion is vacuous', () => {
    expect(noAcs().length).toBeGreaterThan(200);
    expect(noAcs()).toMatch(/VERIFICATION CRITERIA/);
  });

  it('THE DEPENDENCY IS GONE: the instruction never mentions acceptance criteria', () => {
    expect(
      noAcs(),
      'three sentences of ceremony about an array that is empty by design in brownfield',
    ).not.toMatch(/acceptance criteria|acceptanceCriteria/i);
  });

  it('the documentation is named as a source of verification', () => {
    expect(
      noAcs(),
      'the prompt carries 4KB of authoritative vendor quotes and STEP 3 does not mention them',
    ).toMatch(/documentation/i);
  });

  it('the description is still a source', () => {
    expect(noAcs()).toMatch(/description/i);
  });

  it('vcSource may not offer "acceptance" when there are none to derive from', () => {
    const schemaLine = spec.buildBrownfieldArchaeologyBlock(BROWNFIELD,
      { hasAcceptanceCriteria: false, hasReferencedDocs: true }).schemaLine;
    expect(schemaLine).toMatch(/vcSource/);
    expect(
      schemaLine,
      'the model is offered a value it cannot honestly use',
    ).not.toMatch(/"vcSource":"[^"]*acceptance/);
  });
});

describe('a story WITH acceptance criteria still uses them — greenfield is unchanged', () => {
  const withAcs = () => block({ hasAcceptanceCriteria: true, hasReferencedDocs: true });

  it('the immutability instruction survives', () => {
    expect(withAcs()).toMatch(/acceptanceCriteria/);
    expect(withAcs()).toMatch(/IMMUTABLE/);
  });

  it('acceptance is an allowed vcSource when ACs exist', () => {
    const schemaLine = spec.buildBrownfieldArchaeologyBlock(BROWNFIELD,
      { hasAcceptanceCriteria: true, hasReferencedDocs: true }).schemaLine;
    expect(schemaLine).toMatch(/acceptance/);
  });
});

describe('documentation is only offered as a source when documentation exists', () => {
  it('with no fetched docs, the instruction does not invite deriving from them', () => {
    const b = block({ hasAcceptanceCriteria: false, hasReferencedDocs: false });
    expect(b).toMatch(/description/i);
    expect(
      b,
      'inviting derivation from documents that were never fetched is an invitation to invent',
    ).not.toMatch(/referenced documentation/i);
  });
});

describe('the rest of the brownfield block is untouched', () => {
  it('classification and location steps still render', () => {
    const b = block({ hasAcceptanceCriteria: false, hasReferencedDocs: true });
    expect(b).toMatch(/STEP 1 — CLASSIFY/);
    expect(b).toMatch(/STEP 2 — LOCATE/);
    expect(b).toMatch(/storyKind/);
    expect(b).toMatch(/locationHint/);
  });

  it('greenfield renders no brownfield block at all', () => {
    expect(spec.buildBrownfieldArchaeologyBlock({}, { hasAcceptanceCriteria: true }).archaeologyBlock).toBe('');
  });
});
