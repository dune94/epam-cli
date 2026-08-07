/**
 * A CRITERION MUST SAY WHO OBSERVES IT, AND ON WHAT.
 *
 * Two rounds of instruction did not stop the same two shapes. Rules alone produced them;
 * contrast pairs naming those shapes as REJECTED produced them again on the very next run
 * (20260807T013407Z):
 *
 *   VC2  "the Contentstack SDK query issued by getEntry or getSingleEntry ... includes those
 *         preview parameters"                          — an internal call path
 *   VC4  "Given the Contentstack Stack initialization options object, it contains a
 *         live_preview configuration property"          — internal structure
 *
 * WHY MORE PROSE WAS NEVER GOING TO WORK. The same session deliberately improved the
 * producer's grounding: fetched vendor documents, declared file contents, the detective's
 * located fix site. All of that is implementation-shaped — the vendor guide shows a config
 * block, the source shows getEntry. The producer is then asked to write external observations
 * about the internal material we just handed it, and corrected when it does. Instruction
 * fighting the inputs loses.
 *
 * So the standard becomes a FIELD, not a paragraph. Each criterion declares who observes it
 * and on what surface. VC4 would have to claim a person observes a Stack initialization
 * options object; VC2, that a person observes an SDK query. Neither can be said honestly, and
 * the absurdity is visible to a reader and to a reviewer instead of being a matter of taste.
 *
 * It also settles an argument the pipeline was holding with itself. The producer's samples
 * teach "given <the client> is mocked ..." as acceptable; the reviewer flagged exactly that as
 * "prescribes mocking setup". With a declared `setup` field, a precondition is a precondition
 * rather than a violation, and both sides can stop disagreeing about it.
 *
 * The persisted `verificationCriteria` stays an array of STRINGS: every downstream consumer —
 * the guard, coverage checking, the writer prompt, claude.sh — reads that shape, and changing
 * it to satisfy this would be a rewrite of the contract rather than an addition to it.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { normalizeVerificationCriteria, TOOL_DEFINITIONS } = spec;

describe('the tool declares the standard', () => {
  const props = TOOL_DEFINITIONS.TOOL_SPEC_AGENT.parameters.properties;

  it('a per-criterion declaration exists alongside the criteria', () => {
    expect(props.verificationCriteriaDetail, 'nothing asks the producer who observes a criterion').toBeTruthy();
    expect(props.verificationCriteriaDetail.type).toBe('array');
  });

  it('observer and surface are REQUIRED — the two questions a bad criterion cannot answer', () => {
    const item = props.verificationCriteriaDetail.items;
    expect(item.required).toContain('criterion');
    expect(item.required).toContain('observer');
    expect(item.required).toContain('surface');
  });

  it('setup is OPTIONAL — a precondition is not a violation', () => {
    const item = props.verificationCriteriaDetail.items;
    expect(item.properties.setup, 'there is nowhere to declare a precondition').toBeTruthy();
    expect(item.required, 'requiring setup would force every criterion to invent one').not.toContain('setup');
  });

  it('observer is constrained — "the system" is not an observer', () => {
    const observer = props.verificationCriteriaDetail.items.properties.observer;
    expect(Array.isArray(observer.enum), 'a free-text observer lets "the application" observe itself').toBe(true);
    expect(observer.enum.length).toBeGreaterThan(1);
  });
});

describe('the criteria list is still strings — the downstream contract is unchanged', () => {
  it('detail supplies the criteria when present', () => {
    const out = normalizeVerificationCriteria({
      verificationCriteriaDetail: [
        { criterion: 'the page shows the draft title', observer: 'end user', surface: 'the rendered page' },
        { criterion: 'the page shows published content when inactive', observer: 'tester', surface: 'the rendered page' },
      ],
    });
    expect(out).toEqual([
      'the page shows the draft title',
      'the page shows published content when inactive',
    ]);
    expect(out.every((v: unknown) => typeof v === 'string')).toBe(true);
  });

  it('a plain string array still works — older payloads are not broken', () => {
    expect(normalizeVerificationCriteria({ verificationCriteria: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('detail wins when both are present, and nothing is lost', () => {
    const out = normalizeVerificationCriteria({
      verificationCriteria: ['stale'],
      verificationCriteriaDetail: [{ criterion: 'fresh', observer: 'tester', surface: 'the response' }],
    });
    expect(out).toEqual(['fresh']);
  });

  it('a detail entry with no criterion text contributes nothing', () => {
    expect(normalizeVerificationCriteria({
      verificationCriteriaDetail: [{ observer: 'tester', surface: 'the page' }, { criterion: '  ' }],
    })).toEqual([]);
  });

  it('junk yields an empty list rather than throwing', () => {
    expect(normalizeVerificationCriteria(null)).toEqual([]);
    expect(normalizeVerificationCriteria({ verificationCriteriaDetail: 'nope' })).toEqual([]);
  });
});

describe('the declarations are kept, not discarded after use', () => {
  it('vcDeclarations() returns the normalised per-criterion record', () => {
    const d = spec.vcDeclarations({
      verificationCriteriaDetail: [
        { criterion: 'c1', observer: 'end user', surface: 'the rendered page', setup: 'the client is mocked' },
        { criterion: 'c2', observer: 'tester', surface: 'the response' },
      ],
    });
    expect(d).toHaveLength(2);
    expect(d[0]).toEqual({ criterion: 'c1', observer: 'end user', surface: 'the rendered page', setup: 'the client is mocked' });
    expect(d[1].setup, 'an absent precondition should be empty, not undefined').toBe('');
  });

  it('an older string-only payload yields no declarations rather than fabricated ones', () => {
    expect(spec.vcDeclarations({ verificationCriteria: ['a'] })).toEqual([]);
  });
});

describe('the standard reaches the prompts, and the reviewer stops fighting it', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
  const BF = { EPAM_BROWNFIELD: '1' };

  it('the producer is asked for the declaration in its output shape', () => {
    const { schemaLine } = spec.buildBrownfieldArchaeologyBlock(BF, { hasAcceptanceCriteria: false });
    expect(schemaLine, 'the schema hint never mentions it, so nothing will be returned')
      .toMatch(/verificationCriteriaDetail/);
    expect(schemaLine).toMatch(/observer/);
    expect(schemaLine).toMatch(/surface/);
  });

  it('the producer is told what observer and surface mean', () => {
    const { archaeologyBlock } = spec.buildBrownfieldArchaeologyBlock(BF, { hasAcceptanceCriteria: false });
    expect(archaeologyBlock).toMatch(/WHO observes it/);
    expect(archaeologyBlock).toMatch(/rendered page|API response/);
    expect(archaeologyBlock, 'if nobody can see it, it is not a criterion').toMatch(/not a verification criterion/i);
  });

  it('THE ARGUMENT ENDS: a declared precondition is explicitly not a violation', () => {
    // The producer's samples teach "given <the client> is mocked ..."; the reviewer flagged
    // exactly that as "prescribes mocking setup" on run 20260807T013407Z. Both were following
    // their instructions. Now the reviewer is told the difference.
    const i = SRC.indexOf('A criterion may declare a PRECONDITION');
    expect(i, 'the reviewer is still free to flag a precondition as prescription').toBeGreaterThan(-1);
    const block = SRC.slice(i, i + 400);
    expect(block).toMatch(/NOT implementation prescription/);
    expect(block).toMatch(/Flag what the criterion ASSERTS/);
  });

  it('the declarations are persisted on the story, not consumed', () => {
    expect(SRC, 'the declaration is used and thrown away').toMatch(/story\.verificationCriteriaDetail = _vcDecl/);
  });

  it('only declarations for criteria that SURVIVED are kept', () => {
    // A declaration for a criterion the guard dropped would describe something the story no
    // longer verifies.
    expect(SRC).toMatch(/vcDeclarations\(payload\)\.filter\(\(d\) => enforced\.vc\.includes\(d\.criterion\)\)/);
  });
});
