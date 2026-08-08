/**
 * TWO LITERALS THAT DECIDE WHETHER EVIDENCE COUNTS.
 *
 * 1. WHICH TRACKER TYPES MEAN "DEFECT" IS PROJECT DATA.
 *
 *      return t === 'bug' ? 'defect' : 'novel';
 *
 *    This project's Jira says "Bug". Another says "Defect", "Fault", "Incident", or a
 *    localised name — and there EVERY story classifies novel: the detective is never asked for
 *    a causal site or a quoted broken line, real defects get the feature contract, and
 *    grounding drops from quotation to provenance. Silently, with no gate. That is the failure
 *    this detective was built to prevent, reachable by a config mismatch nobody would see.
 *    The literal also became load-bearing on 2026-08-08: it used to select one paragraph of
 *    prompt, and now selects the whole prescription AND the grounding contract.
 *
 * 2. A MAGIC LENGTH DECIDES WHETHER A QUOTE IS EVIDENCE.
 *
 *      if (needle.length < 8) return null;   // "too short to be distinctive"
 *
 *    `a === b` is 7 characters. `x != y` is 6. A defect whose broken expression is genuinely
 *    short has every finding scored null, is judged UNGROUNDED, and retries three times before
 *    passing through flagged — with no config mismatch required.
 *
 * Both are declared now, defaulting to today's behaviour where a default is safe, and to the
 * safer contract where it is not.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

beforeEach(() => {
  delete process.env.EPAM_DEFECT_ISSUE_TYPES;
  delete process.env.EPAM_MIN_EVIDENCE_CHARS;
});

describe('the engine names no tracker vocabulary', () => {
  it('no issue-type literal decides the story kind', () => {
    const i = SRC.indexOf('function inferStoryKindHint');
    // CODE lines only — the comment deliberately quotes the old literal to explain the defect,
    // and a guard that cannot tell code from the story of the code forbids documenting it.
    const code = SRC.slice(i, i + 1400).split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(
      code,
      "a tracker's own word for a defect is project data; hardcoding it silently disables " +
      'defect tracing wherever the wording differs',
    ).not.toMatch(/===\s*['"]bug['"]/);
  });
});

describe('the project declares which types are defects', () => {
  it('a declared type classifies as defect', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    expect(spec.inferStoryKindHint({ issueType: 'Bug' })).toBe('defect');
  });

  it('several types can be declared', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'defect,fault,incident';
    for (const t of ['Defect', 'FAULT', 'incident']) {
      expect(spec.inferStoryKindHint({ issueType: t })).toBe('defect');
    }
  });

  it('spacing in the declaration does not matter', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = ' bug ,  defect ';
    expect(spec.inferStoryKindHint({ issueType: 'defect' })).toBe('defect');
  });

  it('an undeclared type is novel', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    expect(spec.inferStoryKindHint({ issueType: 'Story' })).toBe('novel');
  });

  it('both field spellings are still read', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    expect(spec.inferStoryKindHint({ issuetype: 'bug' })).toBe('defect');
  });

  it('a missing or malformed story is novel, not a crash', () => {
    process.env.EPAM_DEFECT_ISSUE_TYPES = 'bug';
    expect(spec.inferStoryKindHint(undefined)).toBe('novel');
    expect(spec.inferStoryKindHint({})).toBe('novel');
  });
});

describe('with nothing declared it takes the safer contract', () => {
  it('every story is novel', () => {
    // Demanding a cause for work that has none is the more expensive error, and it is the one
    // the reality anchor exists to prevent.
    expect(spec.inferStoryKindHint({ issueType: 'Bug' })).toBe('novel');
    expect(spec.inferStoryKindHint({ issueType: 'Story' })).toBe('novel');
  });
});

describe('the evidence threshold is declared, not magic', () => {
  const line = (n: number) => 'a'.repeat(n);

  it('the default still rejects a trivially short quote', () => {
    expect(spec.minEvidenceChars()).toBeGreaterThan(1);
  });

  it('it is configurable, so a project with short expressions is not stuck', () => {
    process.env.EPAM_MIN_EVIDENCE_CHARS = '4';
    expect(spec.minEvidenceChars()).toBe(4);
  });

  it('a malformed declaration falls back to the default rather than to zero', () => {
    // Zero would accept "}" as evidence — worse than the magic number it replaced.
    process.env.EPAM_MIN_EVIDENCE_CHARS = 'nonsense';
    expect(spec.minEvidenceChars()).toBeGreaterThan(1);
    process.env.EPAM_MIN_EVIDENCE_CHARS = '0';
    expect(spec.minEvidenceChars()).toBeGreaterThan(1);
  });

  it('no bare numeric literal decides it any more', () => {
    const i = SRC.indexOf('function verifyDetectiveEvidence');
    expect(SRC.slice(i, i + 900)).not.toMatch(/needle\.length < \d/);
  });

  it('a short real expression can be accepted when the project says so', () => {
    process.env.EPAM_MIN_EVIDENCE_CHARS = '5';
    expect(spec.minEvidenceChars()).toBe(5);
    expect(line(7).length).toBeGreaterThanOrEqual(spec.minEvidenceChars());
  });
});

describe('the project that runs today declares its own', () => {
  it('metrolinx config declares the defect issue types', () => {
    const cfg = readFileSync(
      join(__dirname, '../../../orchestrations/projects/metrolinx/config.env'), 'utf8');
    expect(
      cfg,
      'without a declaration every metrolinx story becomes novel and defect tracing is lost',
    ).toMatch(/^EPAM_DEFECT_ISSUE_TYPES=/m);
  });
});
