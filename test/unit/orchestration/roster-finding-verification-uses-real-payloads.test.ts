/**
 * THE ROSTER FINDING RE-CHECK WAS INERT, AND INVERTED UNDERNEATH.
 *
 * Every fixture in this file is CAPTURED OUTPUT from the AMSD-2041 run of 2026-08-08 that
 * halted at the roster gate — test/fixtures/captured/roster-review/. Nothing here is a shape
 * I imagined. That distinction is the whole point: the previous tests for this gate fed it
 * `{claim:'c', checked:'k', found:'f', severity:'blocking'}`, which proves the gate can read a
 * field and cannot detect anything about what the field MEANS. They were green while the
 * gate halted a real run.
 *
 * Two defects, both invisible to hand-written fixtures:
 *
 * 1. INERT. verifyFindings opens with
 *        if (!v || !v.kind || v.kind === 'not_mechanically_checkable') { kept.push(f); ... }
 *    and the `verification` object declared NO required fields. Real output carries only
 *    {codeline, expected} — no `kind`, no `subject`. So every real finding took the bail-out
 *    branch and was kept unchecked. The re-check has never run in production.
 *
 * 2. INVERTED. The schema described `expected` as "what you found" (reality), but the agent
 *    uses it for what the BRIEF asserts: the captured finding says expected:"present" while
 *    its own `found` reads "metrolinx does NOT declare ts-jest". verifyFindings compared it as
 *    reality — keeping a finding when measurement AGREED with `expected` and refuting it when
 *    it differed. That is backwards: agreement means the brief was right (no defect), and
 *    disagreement is exactly the defect. Had `kind`/`subject` been present, the real ts-jest
 *    defect would have been DISCARDED as refuted, and cycle 1's nine confirmations kept.
 *
 * Together they explain the halt: nine confirmations survived unfiltered and burned the
 * 2-cycle correction budget, then a genuine defect arrived with no budget left.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { verifyFindings } = require('../../../orchestrations/scripts/lib/verify-findings.js');
const { TOOL_ROSTER_REVIEW } = require('../../../orchestrations/scripts/spec-mode-runner.js');

const CAPTURED = join(__dirname, '../../fixtures/captured/roster-review');
const realReview = JSON.parse(readFileSync(join(CAPTURED, 'cycle2-real.json'), 'utf8'));
const cycle1Log = readFileSync(join(CAPTURED, 'cycle1-real.log'), 'utf8');

/** The dependency-check config the run really uses, and the real manifest of the codeline. */
const realDepCheck = JSON.parse(readFileSync(join(CAPTURED, 'dependency-check.real.json'), 'utf8'));
const realManifest = JSON.parse(readFileSync(join(CAPTURED, 'metrolinx-package.real.json'), 'utf8'));

/** The codeline the captured finding is about — read from the finding, never typed here. */
const CODELINE: string = realReview.findings[0].verification.codeline;

/**
 * Names the real manifest declares, and one it does not. Both DERIVED from the captured
 * manifest so no package name is written into this file: the engine may not hardcode stack
 * facts and neither may its tests.
 */
function manifestNames(): Set<string> {
  const names = new Set<string>();
  for (const key of realDepCheck.manifestKeys) {
    const section = realManifest[key];
    if (section && typeof section === 'object') for (const n of Object.keys(section)) names.add(n);
  }
  return names;
}
const DECLARED: string = [...manifestNames()].sort()[0];
const UNDECLARED: string = `${DECLARED}-${'not-declared'}`;

function codelines() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-verify-'));
  const repo = join(dir, CODELINE);
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, realDepCheck.manifestFile), JSON.stringify(realManifest, null, 2));
  // WITHOUT this, declaredNames() returns null, every check reports "could not run", and
  // findings fall through to `kept` — so the comparison tests below would pass while proving
  // nothing. That happened on the first draft of this file. In production the same config is
  // resolved from EPAM_PROJECT_CONFIG_DIR; this is that file, captured.
  writeFileSync(join(repo, '.epam', 'dependency-check.json'), JSON.stringify(realDepCheck, null, 2));
  return { dir, list: [{ name: CODELINE, path: repo }] };
}

describe('the harness can actually settle a check — no vacuous passes', () => {
  it('declaredNames really reads the real manifest, and settles present vs absent', () => {
    const { declaredNames } = require('../../../orchestrations/scripts/lib/verify-findings.js');
    const { dir, list } = codelines();
    try {
      const names = declaredNames(list[0].path);
      expect(names, 'the manifest could not be read — every check below would be unsettled').not.toBeNull();
      expect(names.has(DECLARED), 'a name the real manifest declares was not found').toBe(true);
      expect(names.has(UNDECLARED), 'the absent name is somehow declared').toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the captured fixtures are what they claim to be', () => {
  it('cycle 2 is real reviewer output with two blocking findings', () => {
    expect(realReview.verdict).toBe('defects_found');
    expect(realReview.findings.length).toBe(2);
    expect(realReview.findings.every((f: any) => f.severity === 'blocking')).toBe(true);
  });

  it('and its findings carry NO kind and NO subject — the shape that made the check inert', () => {
    for (const f of realReview.findings) {
      expect(f.verification, 'the captured finding has no verification block at all').toBeTruthy();
      expect(f.verification.kind, 'kind was present after all — this fixture is not the defect').toBeUndefined();
      expect(f.verification.subject).toBeUndefined();
    }
  });

  it('cycle 1 really did report nine confirmations as blocking', () => {
    // "This claim is sound" is the reviewer's own words for "no defect here".
    expect((cycle1Log.match(/This claim is sound/g) || []).length).toBe(9);
    expect(cycle1Log).toMatch(/9 finding\(s\), 9 blocking/);
  });
});

describe('DEFECT 1: a mechanically-checkable finding may not skip the check', () => {
  it('the schema REQUIRES kind and subject inside verification', () => {
    const v = TOOL_ROSTER_REVIEW.parameters.properties.findings.items.properties.verification;
    expect(
      v.required,
      'verification declared no required fields, so real output omitted kind/subject and ' +
      'every finding took the unchecked bail-out branch',
    ).toEqual(expect.arrayContaining(['kind', 'subject', 'codeline', 'expected', 'briefAsserts']));
  });

  it('the real captured payload would now be rejected as malformed, not silently trusted', () => {
    const { dir, list } = codelines();
    try {
      const r = verifyFindings(realReview.findings, list);
      expect(r.kept, 'a finding with no kind was kept as a trusted blocking defect').toEqual([]);
      expect(r.unsettled.length, 'it was dropped silently instead of being surfaced').toBe(2);
      for (const u of r.unsettled) expect(u._why).toMatch(/kind|subject|malformed/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('DEFECT 2: the comparison is against what the BRIEF asserts', () => {
  /** The captured finding, with the two fields the schema now requires. */
  function realFindingCompleted() {
    const f = JSON.parse(JSON.stringify(realReview.findings[0]));
    f.verification.kind = 'dependency_declared';
    f.verification.subject = UNDECLARED;
    f.verification.expected = 'absent';        // what the reviewer found: not declared
    f.verification.briefAsserts = 'present';   // what the brief claims
    return f;
  }

  it('a REAL defect survives: the brief asserts a package the codeline does not declare', () => {
    const { dir, list } = codelines();
    try {
      const r = verifyFindings([realFindingCompleted()], list);
      expect(
        r.kept.length,
        'the genuine defect was discarded as refuted — the comparison is inverted',
      ).toBe(1);
      expect(r.refuted).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a CONFIRMATION is dropped: the brief asserts a package, and the codeline declares it', () => {
    const { dir, list } = codelines();
    try {
      const f = realFindingCompleted();
      f.verification.subject = DECLARED;         // present in the manifest
      f.verification.expected = 'present';       // reviewer read it correctly
      f.verification.briefAsserts = 'present';   // and the brief was right
      f.found = `${CODELINE} declares ${DECLARED}. This claim is sound.`;
      const r = verifyFindings([f], list);
      expect(
        r.kept,
        'a finding whose own evidence confirms the brief was kept as a blocking defect — ' +
        'nine of these burned the correction budget on 2026-08-08',
      ).toEqual([]);
      expect(r.refuted.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an absence the brief asserts, which is genuinely absent, is a confirmation too', () => {
    const { dir, list } = codelines();
    try {
      const f = realFindingCompleted();
      f.verification.subject = UNDECLARED;
      f.verification.expected = 'absent';        // reviewer read it correctly
      f.verification.briefAsserts = 'absent';    // and the brief was right
      const r = verifyFindings([f], list);
      expect(r.kept, 'the brief was right that it is missing; that is not a defect').toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an absence the brief asserts, which is actually PRESENT, is a real defect', () => {
    const { dir, list } = codelines();
    try {
      const f = realFindingCompleted();
      f.verification.subject = DECLARED;
      f.verification.expected = 'present';       // reviewer read it correctly
      f.verification.briefAsserts = 'absent';    // brief says missing; it is declared
      expect(verifyFindings([f], list).kept.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('judgements no tool settles are still the reviewer\'s to make', () => {
  it('not_mechanically_checkable is kept untouched', () => {
    const { dir, list } = codelines();
    try {
      const f = {
        agent: 'x', severity: 'blocking', claim: 'two agents own the same surface',
        checked: 'read both briefs', found: 'overlap',
        verification: { kind: 'not_mechanically_checkable' },
      };
      expect(verifyFindings([f], list).kept.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a finding with no verification block at all is kept — it claims no mechanical basis', () => {
    const { dir, list } = codelines();
    try {
      const f = { agent: 'x', severity: 'blocking', claim: 'vague brief', checked: 'read it', found: 'vague' };
      expect(verifyFindings([f], list).kept.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a named codeline that does not exist is surfaced, not trusted', () => {
    const { dir, list } = codelines();
    try {
      const f = realReview.findings[0];
      const g = JSON.parse(JSON.stringify(f));
      g.verification.kind = 'dependency_declared';
      g.verification.subject = UNDECLARED;
      g.verification.codeline = `${CODELINE}-does-not-exist`;
      const r = verifyFindings([g], list);
      expect(r.unsettled.length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
