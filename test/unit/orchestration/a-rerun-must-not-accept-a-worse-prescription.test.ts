/**
 * A RE-INVESTIGATION MAY NOT SILENTLY REPLACE A PRESCRIPTION WITH A WORSE ONE.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * detective-rerun-step.js takes a FRESH DRAW of the prescription and writes it over the one
 * that already stands. Its own header says so:
 *
 *     "a re-investigation is a fresh draw that can come back worse. The backup is what makes
 *      this step reversible, which is the only reason it is safe to run at all."
 *
 * A backup is only reversible if someone COMPARES it. Nobody did.
 *
 * Live 2026-08-11, AMSD-2041. Two runs of the same detective against the same codeline and the
 * same ticket, 40 minutes apart:
 *
 *     09:25  13 sites — pageService.ts prescribed "pass live_preview: true through to
 *            getEntry", ContentstackContext.tsx prescribed "replace useMemo with useState +
 *            merge logic"
 *     10:05  14 sites — pageService.ts GONE, the merge instruction GONE, and it reported
 *            SUCCESS
 *
 * The site COUNT went UP (13 -> 14) while the content was destroyed, which is why the existing
 * row — `{ before: before.length, after: after.length }` — could not see it. It counts. It does
 * not compare.
 *
 * Two days of runs then built from a plan missing the step that carried the whole feature, and
 * the code produced does not do the job. The file's own comments describe an EARLIER instance
 * of the same thing ("replaced a correct prescription ... with one asserting
 * changeRequired:false on ALL FIVE sites ... then reported '✓ every selected site carries
 * changeRequired' — true, and all false. Reverted from the backup.") — reverted BY HAND, after
 * the fact, by someone who happened to look.
 *
 * THE RULE: a replacement that LOSES ground is contained and reported, never applied silently.
 * Losing ground is structural and needs no project knowledge to detect: a file that had a site
 * and now has none; a site that was required and is now exempt; a declared package that
 * vanished. Explicit permission may override it; nothing else may.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rerun = require(join(ROOT, 'orchestrations/scripts/detective-rerun-step.js'));

/** The two real prescriptions from the live incident — canonical artefacts, not fixtures. */
function sitesFrom(snapshot: string, codeline = 'gotransit') {
  const p = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx', snapshot), 'utf8'));
  const s = (p.stories || []).find((x: any) => x.id === 'AMSD-2041');
  const per = s.fixSiteAnalysisPerCodeline || {};
  return (per[codeline] || (s.fixSiteAnalysis || []).filter((f: any) => f.codeline === codeline));
}

describe('the comparison exists at all', () => {
  it('exports a way to ask whether a replacement loses ground', () => {
    expect(typeof rerun.prescriptionRegressions,
      'detective-rerun-step exports no regression check — a fresh draw is applied blind')
      .toBe('function');
  });
});

describe('IT DETECTS LOSS OF GROUND, STRUCTURALLY', () => {
  const reg = (before: any[], after: any[]) => rerun.prescriptionRegressions(before, after) || [];

  it('an equal or better replacement is accepted', () => {
    // Guards against a check that simply rejects everything — which would "pass" every test
    // below while making the step useless.
    const before = [{ file: 'a.ts', changeRequired: true, fixVerified: true }];
    const after = [
      { file: 'a.ts', changeRequired: true, fixVerified: true },
      { file: 'b.ts', changeRequired: true, fixVerified: true },
    ];
    expect(reg(before, after), 'a strictly better prescription was rejected').toEqual([]);
  });

  it('THE LIVE DEFECT: a file that had a site and now has none', () => {
    const before = [{ file: 'pageService.ts', changeRequired: true }, { file: 'ctx.tsx', changeRequired: true }];
    const after = [{ file: 'ctx.tsx', changeRequired: true }];
    const r = reg(before, after);
    expect(r.length, 'a prescribed fix site disappeared and nothing objected').toBeGreaterThan(0);
    expect(JSON.stringify(r)).toContain('pageService.ts');
  });

  it('a site downgraded from required to exempt', () => {
    // The earlier incident this file documents: "changeRequired:false on ALL FIVE sites".
    const before = [{ file: 'a.ts', changeRequired: true }];
    const after = [{ file: 'a.ts', changeRequired: false }];
    expect(reg(before, after).length, 'a required site became exempt silently').toBeGreaterThan(0);
  });

  it('a declared package that vanished', () => {
    const before = [{ file: 'a.ts', changeRequired: true, requiredPackages: ['@scope/pkg'] }];
    const after = [{ file: 'a.ts', changeRequired: true, requiredPackages: [] }];
    expect(reg(before, after).length, 'a required package declaration was dropped').toBeGreaterThan(0);
  });

  it('a COUNT THAT RISES does not excuse content that is lost', () => {
    // Exactly the live shape: 13 -> 14 sites while the important one disappeared.
    const before = [{ file: 'pageService.ts', changeRequired: true }, { file: 'a.ts', changeRequired: true }];
    const after = [
      { file: 'a.ts', changeRequired: true },
      { file: 'b.ts', changeRequired: true },
      { file: 'c.ts', changeRequired: true },
    ];
    expect(reg(before, after).length, 'more sites was treated as better').toBeGreaterThan(0);
  });

  it('an empty replacement never counts as an improvement', () => {
    expect(reg([{ file: 'a.ts', changeRequired: true }], []).length).toBeGreaterThan(0);
  });
});

describe('AGAINST THE REAL 2026-08-11 PRESCRIPTIONS', () => {
  // The strongest available evidence: a known-good and known-bad pair produced by the real
  // detective from identical inputs. If the check cannot separate these two, it cannot do the
  // job it exists for.
  it('the good -> degraded replacement is REJECTED', () => {
    const good = sitesFrom('prd.json.pre-detective-rerun-20260811T092555Z');
    const degraded = sitesFrom('prd.json.pre-detective-rerun-20260811T100551Z');
    expect(good.length, 'harness is vacuous — no gotransit sites in the good snapshot')
      .toBeGreaterThan(0);
    expect(degraded.length, 'harness is vacuous — no gotransit sites in the degraded snapshot')
      .toBeGreaterThan(0);
    const r = rerun.prescriptionRegressions(good, degraded) || [];
    expect(r.length, 'the replacement that broke two days of runs was accepted').toBeGreaterThan(0);
    expect(JSON.stringify(r), 'the lost pageService.ts site was not reported')
      .toMatch(/pageService/);
  });

  it('and replacing a prescription WITH ITSELF is not a regression', () => {
    const good = sitesFrom('prd.json.pre-detective-rerun-20260811T092555Z');
    expect(rerun.prescriptionRegressions(good, good) || []).toEqual([]);
  });
});

describe('WHAT IT DOES WITH A REGRESSION', () => {
  it('says WHICH site and WHY, not just that something changed', () => {
    // A report that cannot be acted on gets ignored, and this step already had one: the row
    // carried before/after COUNTS, which is why nobody saw a 13 -> 14 that lost the feature.
    const r = rerun.prescriptionRegressions(
      [{ file: 'pageService.ts', changeRequired: true }], [{ file: 'other.ts', changeRequired: true }],
    ) || [];
    expect(r.length).toBeGreaterThan(0);
    for (const item of r) {
      expect(item, 'a regression with no file is not actionable').toHaveProperty('file');
      expect(item, 'a regression with no kind is not actionable').toHaveProperty('kind');
    }
  });
});

describe('THE GUARD IS WIRED — a computed check nobody consults is the same as no check', () => {
  // Caught by mutation earlier today on a different fix: a policy rendered into a variable that
  // was never interpolated passed every other assertion. The check above can be perfect and the
  // step can still overwrite the prescription. This drives the REAL merge.
  const story = () => ({
    id: 'S-1',
    // storyCodelines() reads THIS — without it nothing is in scope, the loop never runs, and
    // every assertion below passes while proving nothing. Found by the good-replacement test
    // failing: if a better prescription also fails to land, the harness is not replacing at all.
    codelines: ['cl1'],
    fixSiteAnalysisPerCodeline: {
      cl1: [
        { file: 'pageService.ts', codeline: 'cl1', reason: 'r', fix: 'the step that matters', changeRequired: true },
        { file: 'ctx.tsx', codeline: 'cl1', reason: 'r', fix: 'f', changeRequired: true },
      ],
    },
  });
  // `codelines` is a list of NAMES; the repo path comes from prd.project.outputDirs, which is
  // where byName is built from. Passing objects here silently selects nothing.
  const codelines = ['cl1'];
  const project = { outputDirs: [{ codeline: 'cl1', path: '/nonexistent-repo' }] };

  async function rerunWith(findings: any[]) {
    const prd = { project, stories: [story()] };
    const results = await rerun.runRerun({
      prd,
      codelines,
      detective: async () => findings,
      logDir: '',
    });
    return { prd, results };
  }

  it('a DEGRADED replacement does not reach the PRD', async () => {
    // The live shape: comes back without pageService.ts.
    const { prd } = await rerunWith([
      { file: 'ctx.tsx', reason: 'r', fix: 'f', changeRequired: true },
      { file: 'other.ts', reason: 'r', fix: 'f', changeRequired: true },
    ]);
    const kept = prd.stories[0].fixSiteAnalysisPerCodeline.cl1.map((f: any) => f.file);
    expect(kept, 'the degraded prescription was written over the good one')
      .toContain('pageService.ts');
  });

  it('and the rejection is REPORTED, naming what would have been lost', async () => {
    const { results } = await rerunWith([{ file: 'ctx.tsx', reason: 'r', fix: 'f', changeRequired: true }]);
    const row = (results.results || results || []).find?.((r: any) => r && r.codeline === 'cl1')
      || (results as any).results?.[0];
    expect(JSON.stringify(row), 'nothing in the row says a replacement was refused')
      .toMatch(/regress|rejected/i);
    expect(JSON.stringify(row), 'the lost site is not named').toMatch(/pageService/);
  });

  it('a GOOD replacement still lands — the guard is not a blanket refusal', async () => {
    const { prd } = await rerunWith([
      { file: 'pageService.ts', reason: 'r', fix: 'better', changeRequired: true },
      { file: 'ctx.tsx', reason: 'r', fix: 'f', changeRequired: true },
      { file: 'extra.ts', reason: 'r', fix: 'f', changeRequired: true },
    ]);
    const files = prd.stories[0].fixSiteAnalysisPerCodeline.cl1.map((f: any) => f.file);
    expect(files, 'an improved prescription was refused — the step is now useless')
      .toContain('extra.ts');
  });
});
