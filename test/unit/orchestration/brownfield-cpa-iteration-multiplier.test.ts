/**
 * CPA's brownfield-only iterationEstimate — an ABSOLUTE turn-count estimate
 * (1-500, cpa-system.md "Iteration Estimate"), not a multiplier — sets a
 * floor on top of whichever floor resolve_brownfield_effort_floor() already
 * computed. Redesigned 2026-08-01 from a 1.0-3.0x multiplier: that range
 * cannot span "5 iterations for a bug fix" to "200 for a large multi-layer
 * change" (a real ~40x gap). It can correct a case the naive
 * single-site/helper/coverage-complete heuristic misclassifies as trivial.
 * Found live, 2026-08-01, AMSD-2041/upexpress: 1 fixSiteAnalysis entry with
 * a helper, checkFixSiteCoverage reported "complete" via a bag-of-words
 * false positive (the finding's prose happened to share terms with all 6
 * behavioral verification criteria even though it never addressed the real
 * scope) — the heuristic alone had no way to catch this; CPA, given the
 * same fixSiteAnalysis + coverage verdict in its prompt plus broader
 * judgment, is the intended correction.
 *
 * Real execution of the actual function extracted from claude.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function extractFn(): string {
  const start = CLAUDE_SH.indexOf('resolve_brownfield_effort_floor() {');
  if (start === -1) throw new Error('function not found');
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn();

function iterationsFor(story: Record<string, unknown>, envOverrides: NodeJS.ProcessEnv = {}): number {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-iter-est-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-2041', ...story }] }));
  const script = `
log() { :; }
export EPAM_BROWNFIELD=1
export PRD_FILE='${prd}'
STORY_MAX_ITERATIONS=6
STORY_MAX_OUTPUT_TOKENS=3072
${fn}
resolve_brownfield_effort_floor AMSD-2041
echo "$STORY_MAX_ITERATIONS"
`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
  return parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim(), 10);
}

describe('resolve_brownfield_effort_floor — CPA iterationEstimate (absolute) floor', () => {
  it('the REAL AMSD-2041/upexpress shape: a false-positive-complete coverage verdict still gets raised via CPA judgment', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'src/context/ContentstackContext.tsx', helper: 'ContentstackFactory' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] }, // the false positive
      cpaIterationEstimate: 25, // CPA's own, better-informed judgment (under the default ceiling)
    });
    // Without CPA's estimate this would take the 6-iteration fast path
    // (single site, has helper, "complete" coverage) — exactly the live miss.
    expect(iters).toBeGreaterThan(6);
    expect(iters).toBe(25);
  });

  it('a large CPA estimate is honored up to the (env-raised) ceiling, not silently capped at the default', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'src/context/ContentstackContext.tsx', helper: 'ContentstackFactory' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
      cpaIterationEstimate: 60,
    }, { EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS: '100' });
    expect(iters).toBe(60);
  });

  it('raises the SCALED (multi-site) floor too, not just the fast path — whichever is larger wins', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' }],
      fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['x'] },
      cpaIterationEstimate: 25,
    });
    // base scaled floor: 8 + 4*2 + 3*1 = 19; CPA's 25 is larger and wins.
    expect(iters).toBe(25);
  });

  it('a low CPA estimate does NOT lower an already-larger heuristic-derived floor', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' }, { file: 'c.ts', helper: '' }],
      cpaIterationEstimate: 3, // smaller than the scaled floor below
    });
    // scaled floor: 8 + 4*3 = 20, CPA's low estimate must not reduce it.
    expect(iters).toBeGreaterThanOrEqual(20);
  });

  it('a default estimate of 1 (CPA never ran, or genuinely found nothing extra) changes nothing', () => {
    const withDefault = iterationsFor({
      fixSiteAnalysis: [{ file: 'x.ts', helper: 'h' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
      cpaIterationEstimate: 1,
    });
    const withoutField = iterationsFor({
      fixSiteAnalysis: [{ file: 'x.ts', helper: 'h' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
    });
    expect(withDefault).toBe(withoutField);
    expect(withDefault).toBe(6);
  });

  it('an out-of-range estimate (e.g. a malformed PRD value) is clamped to the ceiling, not trusted raw', () => {
    const tooHigh = iterationsFor({
      fixSiteAnalysis: [{ file: 'x.ts', helper: 'h' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
      cpaIterationEstimate: 9999,
    });
    expect(tooHigh).toBe(30); // clamped to the default cap, not 9999
  });

  it('the ceiling used for the CPA floor is env-overridable, same as the scaling formula\'s', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'x.ts', helper: 'h' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
      cpaIterationEstimate: 100,
    }, { EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS: '10' });
    expect(iters).toBe(10);
  });

  it('a large real-world estimate (200, the user\'s own example for a large brownfield change) is honored up to the ceiling default', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'x.ts', helper: 'h' }],
      cpaIterationEstimate: 200,
    }, { EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS: '250' });
    expect(iters).toBe(200);
  });
});
