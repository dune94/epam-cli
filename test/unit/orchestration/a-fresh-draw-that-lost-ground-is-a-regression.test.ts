/**
 * THE GUARD THAT DECIDES WHETHER A DETECTIVE RE-RUN MADE THINGS WORSE.
 *
 * A detective re-run is a fresh draw, not a refinement: the second pass can come back with LESS
 * than the first. prescriptionRegressions is what stops the worse answer being kept — and it, along
 * with everything else in detective-rerun-step.js, had ZERO coverage. 406 lines nothing had run.
 *
 * Its four verdicts, each a way a replacement loses ground:
 *
 *   site-lost              a file that had a fix site has none now
 *   change-required-lost   a site that had to be EDITED is now exempt
 *   packages-lost          a declared package requirement vanished
 *   fix-verified-lost      a site whose helper was verified no longer is
 *
 * And the thing it must NOT do: call a fresh draw finding MORE a regression. Additions are the
 * point of re-running.
 *
 * Every case here is a shape a real detective returns, including the malformed ones — a null in the
 * list, a site with no file, a non-array where a list was declared.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { prescriptionRegressions, storyCodelines, codelinesFromPrd, sitesMissingTheField, rebuildFlat } =
  require(join(REPO, 'orchestrations/scripts/detective-rerun-step.js'));

const site = (o: Record<string, unknown>) => ({ file: 'src/a.ts', ...o });
const kinds = (r: Array<{ kind: string }>) => r.map((x) => x.kind).sort();

describe('a fresh draw that lost ground is a regression', () => {
  it('holding its ground is not a regression', () => {
    const before = [site({ changeRequired: true, fixVerified: true, requiredPackages: ['zod'] })];
    expect(prescriptionRegressions(before, before), 'a prescription replaced by itself was called a regression')
      .toEqual([]);
  });

  it('finding MORE is never a regression — that is the point of re-running', () => {
    const before = [site({ changeRequired: true })];
    const after = [site({ changeRequired: true }), { file: 'src/b.ts', changeRequired: true }];
    expect(prescriptionRegressions(before, after)).toEqual([]);
  });

  it('a file that had a site and now has none is site-lost', () => {
    const r = prescriptionRegressions([site({ changeRequired: true })], [{ file: 'src/other.ts' }]);
    expect(kinds(r)).toContain('site-lost');
    expect(r[0].file, 'the finding does not name the file it lost').toBe('src/a.ts');
  });

  it('a site that had to be edited and is now exempt is change-required-lost', () => {
    const r = prescriptionRegressions(
      [site({ changeRequired: true })], [site({ changeRequired: false })]);
    expect(kinds(r)).toContain('change-required-lost');
  });

  it('but a site exempt in BOTH is not — it never had ground to lose', () => {
    const r = prescriptionRegressions(
      [site({ changeRequired: false })], [site({ changeRequired: false })]);
    expect(kinds(r)).not.toContain('change-required-lost');
  });

  it('a declared package that vanished is packages-lost, and names the package', () => {
    const r = prescriptionRegressions(
      [site({ requiredPackages: ['zod', 'pino'] })], [site({ requiredPackages: ['zod'] })]);
    expect(kinds(r)).toContain('packages-lost');
    expect(r.find((x: { kind: string }) => x.kind === 'packages-lost')!.detail,
      'the finding does not say WHICH package was lost').toMatch(/pino/);
  });

  it('a verified fix that is no longer verified is fix-verified-lost', () => {
    const r = prescriptionRegressions(
      [site({ fixVerified: true })], [site({ fixVerified: false })]);
    expect(kinds(r)).toContain('fix-verified-lost');
  });

  it('several losses on one file are all reported, not just the first', () => {
    // A caller shown one of three regressions fixes one third of the problem.
    const r = prescriptionRegressions(
      [site({ changeRequired: true, fixVerified: true, requiredPackages: ['zod'] })],
      [site({ changeRequired: false, fixVerified: false, requiredPackages: [] })]);
    expect(kinds(r)).toEqual(['change-required-lost', 'fix-verified-lost', 'packages-lost']);
  });

  it('no previous prescription means nothing can have been lost', () => {
    expect(prescriptionRegressions([], [site({})])).toEqual([]);
  });

  it('and the shapes a real detective returns do not break it', () => {
    // Malformed output is what this receives on a bad draw; throwing here would take down the very
    // step that exists to catch a bad draw.
    for (const [name, before, after] of [
      ['null in the list', [null, site({ changeRequired: true })], [site({ changeRequired: true })]],
      ['a site with no file', [{ changeRequired: true }], [site({ changeRequired: true })]],
      ['not an array at all', 'nonsense', [site({})]],
      ['both not arrays', null, undefined],
      ['requiredPackages not an array', [site({ requiredPackages: 'zod' })], [site({})]],
    ] as Array<[string, unknown, unknown]>) {
      expect(() => prescriptionRegressions(before as never, after as never),
        `it threw on ${name}`).not.toThrow();
    }
  });
});

describe('the codeline readers survive a real prd', () => {
  it('storyCodelines reads a list, a single value, or neither', () => {
    expect(storyCodelines({ codelines: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(storyCodelines({ codeline: 'a' })).toEqual(['a']);
    expect(storyCodelines({})).toEqual([]);
  });

  it('and does not throw on the shapes a malformed prd carries', () => {
    for (const s of [null, undefined, {}, { codelines: null }, { codelines: 'a' }, { codeline: null }]) {
      expect(() => storyCodelines(s as never), `threw on ${JSON.stringify(s)}`).not.toThrow();
    }
  });

  it('codelinesFromPrd survives a prd with no codelines at all', () => {
    for (const p of [null, undefined, {}, { project: {} }, { project: { outputDirs: null } }]) {
      expect(() => codelinesFromPrd(p as never), `threw on ${JSON.stringify(p)}`).not.toThrow();
    }
  });

  it('sitesMissingTheField and rebuildFlat survive malformed input', () => {
    for (const v of [null, undefined, [], [null], 'nonsense', [{}]]) {
      expect(() => sitesMissingTheField(v as never), `sitesMissingTheField threw on ${JSON.stringify(v)}`)
        .not.toThrow();
    }
    for (const v of [null, undefined, {}, { fixSiteAnalysis: null }, { fixSiteAnalysis: 'x' }]) {
      expect(() => rebuildFlat(v as never), `rebuildFlat threw on ${JSON.stringify(v)}`).not.toThrow();
    }
  });
});
