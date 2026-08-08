/**
 * DET-1: THE PARENT SURVEYS THE ESTATE. IT NEVER ANSWERS FOR A CODELINE.
 *
 * The roster is minted from the ticket, its documents and each codeline's declared
 * dependencies — all CLAIMS about the estate, none an observation of it. So briefs named
 * modules nobody had searched for, and scope came from ticket labels that are routinely wrong
 * about which repositories are involved. The estate survey opens the repositories first.
 *
 * Its output is deliberately two things that must never merge:
 *   - findings: evidence about the estate;
 *   - recommendedInvestigators: a recommendation about the TEAM.
 * In one blob, a recommendation is inherited as a discovery.
 *
 * And it may report ABOUT an investigation but never supply findings FOR a codeline. A fix
 * site today carries {file, function, reason, fix} and NO codeline, so if the parent's output
 * could become one, four contamination routes open at once: a file found in codeline A
 * entering B's writer manifest, checkFixSiteCoverage passing on another repo's evidence,
 * locationHint pointing into the wrong repository, and reviewers rejecting correct work over a
 * file that is a phantom there. That boundary is enforced in CODE here, not in the prompt —
 * a prompt is a request, and this is the one thing that must not depend on compliance.
 *
 * Three states are also not two. "Investigated and found nothing" is EVIDENCE that the story
 * does not apply; it must never be confusable with "not investigated", or an unexamined
 * repository reads as a clean bill of health.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const CODELINES = [
  { name: 'gotransit', path: '/estate/gotransit' },
  { name: 'upexpress', path: '/estate/upexpress' },
  { name: 'metrolinx', path: '/estate/metrolinx' },
];

const byName = (r: any, n: string) => r.codelines.find((c: any) => c.codeline === n);

describe('the fixture is real', () => {
  it('the sanitizer is exported and returns both halves separately', () => {
    expect(typeof spec.sanitizeSurvey).toBe('function');
    const r = spec.sanitizeSurvey({ codelines: [], recommendedInvestigators: [] }, CODELINES);
    expect(r).toHaveProperty('codelines');
    expect(r).toHaveProperty('recommendedInvestigators');
    expect(r).toHaveProperty('violations');
  });
});

describe('the parent may never supply a fix site', () => {
  it.each(['file', 'files', 'function', 'fix', 'patch', 'locationHint', 'lineRange', 'diff'])(
    'a survey entry carrying "%s" has it stripped and the breach recorded',
    (key) => {
      const r = spec.sanitizeSurvey({
        codelines: [{
          codeline: 'gotransit', state: 'in_scope', evidence: 'listed src/',
          [key]: 'src/preview/handler.ts',
        }],
        recommendedInvestigators: [],
      }, CODELINES);

      const entry = byName(r, 'gotransit');
      expect(entry[key], `${key} survived into the survey and can reach a writer manifest`).toBeUndefined();
      expect(r.violations.join(' ')).toContain(key);
    },
  );

  it('the surviving entry keeps only breadth: state, evidence and surfaces', () => {
    const r = spec.sanitizeSurvey({
      codelines: [{
        codeline: 'gotransit', state: 'in_scope', evidence: 'listed src/preview',
        surfaces: ['src/preview', 'src/routes'], file: 'a.ts', fix: 'change it',
      }],
      recommendedInvestigators: [],
    }, CODELINES);

    expect(Object.keys(byName(r, 'gotransit')).sort()).toEqual(
      ['codeline', 'evidence', 'state', 'surfaces']);
    expect(byName(r, 'gotransit').surfaces).toEqual(['src/preview', 'src/routes']);
  });

  it('a survey reporting on a codeline that is NOT in scope is discarded, not merged', () => {
    const r = spec.sanitizeSurvey({
      codelines: [
        { codeline: 'gotransit', state: 'in_scope', evidence: 'looked' },
        { codeline: 'some-other-repo', state: 'in_scope', evidence: 'invented' },
      ],
      recommendedInvestigators: [{ codeline: 'some-other-repo', focus: 'f', why: 'w' }],
    }, CODELINES);

    expect(r.codelines.map((c: any) => c.codeline)).not.toContain('some-other-repo');
    expect(r.recommendedInvestigators.map((x: any) => x.codeline)).not.toContain('some-other-repo');
    expect(r.violations.join(' ')).toMatch(/not in scope/);
  });
});

describe('silence is not a state', () => {
  it('a codeline the survey never mentions is not_investigated, not absent', () => {
    const r = spec.sanitizeSurvey({
      codelines: [{ codeline: 'gotransit', state: 'in_scope', evidence: 'looked' }],
      recommendedInvestigators: [],
    }, CODELINES);

    expect(r.codelines.length, 'an unreported codeline vanished from the survey').toBe(3);
    expect(byName(r, 'metrolinx').state).toBe('not_investigated');
    expect(byName(r, 'metrolinx').evidence).toMatch(/no entry/);
  });

  it('"looked and found nothing" is distinguishable from "never looked"', () => {
    // This distinction is the whole point: one is evidence the story does not apply there,
    // the other is an unexamined repository. Collapsing them is a clean bill of health nobody
    // issued.
    const r = spec.sanitizeSurvey({
      codelines: [
        { codeline: 'gotransit', state: 'no_work_found', evidence: 'searched, no such surface' },
        { codeline: 'upexpress', state: 'failed', evidence: 'checkout unreadable' },
      ],
      recommendedInvestigators: [],
    }, CODELINES);

    expect(byName(r, 'gotransit').state).toBe('no_work_found');
    expect(byName(r, 'upexpress').state).toBe('failed');
    expect(byName(r, 'metrolinx').state).toBe('not_investigated');
    expect(new Set(r.codelines.map((c: any) => c.state)).size).toBe(3);
  });

  it('an unrecognised state falls back to not_investigated, never to a clean result', () => {
    const r = spec.sanitizeSurvey({
      codelines: [{ codeline: 'gotransit', state: 'looks_fine', evidence: 'vibes' }],
      recommendedInvestigators: [],
    }, CODELINES);
    expect(byName(r, 'gotransit').state).toBe('not_investigated');
  });
});

describe('an empty or broken survey does not block the run', () => {
  it.each([
    ['null payload', null],
    ['no codelines key', {}],
    ['codelines not an array', { codelines: 'nope' }],
  ])('%s yields every codeline as not_investigated rather than throwing', (_l, payload) => {
    const r = spec.sanitizeSurvey(payload, CODELINES);
    expect(r.codelines.length).toBe(3);
    expect(r.codelines.every((c: any) => c.state === 'not_investigated')).toBe(true);
  });

  it('a survey with no codelines in scope returns empty rather than inventing any', () => {
    const r = spec.sanitizeSurvey({ codelines: [], recommendedInvestigators: [] }, []);
    expect(r.codelines).toEqual([]);
  });
});

describe('the two halves stay separate', () => {
  it('recommendations do not appear among the findings', () => {
    const r = spec.sanitizeSurvey({
      codelines: [{ codeline: 'gotransit', state: 'in_scope', evidence: 'looked' }],
      recommendedInvestigators: [{ codeline: 'gotransit', focus: 'routing', why: 'saw routes' }],
    }, CODELINES);

    expect(byName(r, 'gotransit')).not.toHaveProperty('focus');
    expect(byName(r, 'gotransit')).not.toHaveProperty('why');
    expect(r.recommendedInvestigators[0]).toEqual(
      { codeline: 'gotransit', focus: 'routing', why: 'saw routes' });
  });
});
