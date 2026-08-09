/**
 * A CODELINE NAME IS A PRIMARY KEY. IT MAY NOT COME FROM A SAMPLE.
 *
 * The discovery prompt used to show the model a worked example:
 *
 *     { "name": "cdts", "path": "/absolute/path/to/repo", ... }
 *
 * That example was a client repository name, so 546daf3 ("no client value reaches a model")
 * replaced it with a description of itself:
 *
 *     { "name": "<short-identifier-derived-from-the-directory-name>", ... }
 *
 * Removing the client value was right. But the example was the only thing pinning the
 * convention — strip the platform/domain decoration, keep the identifying word — and the
 * description honestly admits more than one answer. The model then produced 'gotransit' on one
 * run and 'nextgotransitcom' on the next, both defensible readings of the same instruction.
 *
 * That string is a primary key. It keys byCodeline, the KB stores, story.codelines,
 * project.outputDirs, the lane loop, and the per-codeline fix-site and verification-criteria
 * maps. Live 2026-08-08 the mint wrote registries keyed 'nextgotransitcom', discovery re-ran
 * across the pause boundary and rewrote the PRD as 'gotransit', investigatorForCodeline
 * returned '' for every lane, and all three silently fell back to the generic detective — so
 * the per-codeline investigators that run existed to produce were never used by anything.
 *
 * The fix keeps BOTH constraints. The prompt still carries no client value; the model still
 * makes the judgement only it can make — which repositories are in scope, and why — and the
 * name it returns is discarded in favour of one derived from the path. Identity becomes a pure
 * function of the directory: same answer on every run, and across a resume.
 */
import { describe, it, expect } from 'vitest';

const { deriveCodelineName, deriveCodelineNames } =
  require('../../../orchestrations/scripts/lib/codeline-name.js');

/** The live payload shape, with the two spellings the model actually produced. */
const SHORT = { name: 'gotransit', path: '/estate/next.gotransit.com', evidence: 'ticket component' };
const LONG = { name: 'nextgotransitcom', path: '/estate/next.gotransit.com', evidence: 'ticket component' };

describe('the fixture is real — both spellings came from the same model, same estate', () => {
  it('the two differ, so this test is not comparing a value with itself', () => {
    expect(SHORT.name).not.toBe(LONG.name);
    expect(SHORT.path).toBe(LONG.path);
  });

  it('the deterministic derivation already yields the short form', () => {
    expect(deriveCodelineName('next.gotransit.com')).toBe('gotransit');
  });
});

describe('THE DEFECT: the name comes from the path, never from the model', () => {
  it('the same repository gets the same name whatever the model called it', () => {
    const a = deriveCodelineNames({ codelines: [SHORT] }).codelines[0].name;
    const b = deriveCodelineNames({ codelines: [LONG] }).codelines[0].name;
    expect(
      b,
      'two runs over one estate produced two primary keys — registries written under one ' +
      'spelling cannot be read under the other',
    ).toBe(a);
  });

  it('and that name is the derived one', () => {
    expect(deriveCodelineNames({ codelines: [LONG] }).codelines[0].name).toBe('gotransit');
  });

  it('a model name that is outright wrong does not survive', () => {
    const bogus = { ...SHORT, name: 'the-frontend-repo' };
    expect(deriveCodelineNames({ codelines: [bogus] }).codelines[0].name).toBe('gotransit');
  });

  it('every codeline in the payload is derived, not just the first', () => {
    const parsed = deriveCodelineNames({ codelines: [
      { name: 'X', path: '/estate/next.gotransit.com', evidence: 'e' },
      { name: 'Y', path: '/estate/next.upexpress.com', evidence: 'e' },
      { name: 'Z', path: '/estate/next.metrolinx.com', evidence: 'e' },
    ] });
    expect(parsed.codelines.map((c: any) => c.name)).toEqual(['gotransit', 'upexpress', 'metrolinx']);
  });

  it('a trailing slash on the path does not change the identity', () => {
    const withSlash = { ...SHORT, path: '/estate/next.gotransit.com/' };
    expect(deriveCodelineNames({ codelines: [withSlash] }).codelines[0].name).toBe('gotransit');
  });

  it('the model\'s own judgement is preserved — only the name is replaced', () => {
    const cl = deriveCodelineNames({ codelines: [{ ...LONG, reason: 'ticket says [GO]' }] }).codelines[0];
    expect(cl.path).toBe(LONG.path);
    expect(cl.evidence).toBe(LONG.evidence);
    expect(cl.reason).toBe('ticket says [GO]');
  });

  it('what the model called it is kept for the log, not silently dropped', () => {
    const cl = deriveCodelineNames({ codelines: [LONG] }).codelines[0];
    expect(cl.modelName, 'an operator cannot see that a rename happened').toBe('nextgotransitcom');
  });

  it('no modelName is recorded when the model already agreed', () => {
    expect(deriveCodelineNames({ codelines: [SHORT] }).codelines[0].modelName).toBeUndefined();
  });

  it('nothing else on the payload is disturbed', () => {
    const parsed = deriveCodelineNames({ codelines: [LONG], unsure: [{ part: 'Intake', why: 'no repo' }] });
    expect(parsed.unsure).toEqual([{ part: 'Intake', why: 'no repo' }]);
  });
});

describe('degenerate payloads do not throw', () => {
  it.each([
    ['no codelines key', {}],
    ['codelines not an array', { codelines: 'nope' }],
    ['null', null],
    ['undefined', undefined],
  ])('%s is returned untouched', (_label, input) => {
    expect(() => deriveCodelineNames(input as any)).not.toThrow();
    expect(deriveCodelineNames(input as any)).toBe(input);
  });

  it('an entry with no path keeps whatever it had — nothing can be derived', () => {
    const cl = deriveCodelineNames({ codelines: [{ name: 'orphan', evidence: 'e' }] }).codelines[0];
    expect(cl.name).toBe('orphan');
  });

  it('an entry that is not an object is left alone', () => {
    expect(() => deriveCodelineNames({ codelines: [null, 'x'] } as any)).not.toThrow();
  });
});

describe('identity is stable across a resume — the case that broke the run', () => {
  it('discovery running twice over one estate produces identical keys', () => {
    const estate = ['/estate/next.gotransit.com', '/estate/next.upexpress.com', '/estate/next.metrolinx.com'];
    // Two independent samples, as the model really produced them on 2026-08-08.
    const mintRun = deriveCodelineNames({ codelines: estate.map((p, i) =>
      ({ name: ['nextgotransitcom', 'nextupexpresscom', 'nextmetrolinxcom'][i], path: p, evidence: 'e' })) });
    const resumeRun = deriveCodelineNames({ codelines: estate.map((p, i) =>
      ({ name: ['gotransit', 'upexpress', 'metrolinx'][i], path: p, evidence: 'e' })) });
    expect(resumeRun.codelines.map((c: any) => c.name))
      .toEqual(mintRun.codelines.map((c: any) => c.name));
  });
});
