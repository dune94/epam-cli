/**
 * resolve_brownfield_effort_floor must NOT treat every prescribed fix as
 * minimal — a multi-site fix, or one checkFixSiteCoverage (spec-mode-
 * runner.js) flags as leaving verification criteria unaddressed, needs MORE
 * room than a true single-file reuse-existing-helper fix.
 *
 * Live AMSD-2041, 2026-08-01: the detective's fixSiteAnalysis named 2 files
 * (Contentstack SDK Stack config + Provider rewiring) and left 4 verification
 * criteria uncovered (SDK install, query interfaces, preview API route,
 * tests) — but the OLD logic only checked "does any finding have a non-empty
 * helper", so this story got the same 6-12 iteration floor as a genuine
 * one-file fix. Review confirmed the real change needed 7-8 files touched.
 * The implementer hit "reached maximum iterations" repeatedly and 2 of 3
 * codelines produced a ZERO-diff attempt.
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

function iterationsFor(story: Record<string, unknown>): number {
  const dir = mkdtempSync(join(tmpdir(), 'eff-floor-scope-'));
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
  return parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim(), 10);
}

describe('resolve_brownfield_effort_floor scales with fixSiteAnalysis scope', () => {
  it('a TRUE single-site, fully-covered, helper-bearing fix still gets the fast 6-iteration path', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'parseDispatchLineItemKey' }],
      fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
    });
    expect(iters).toBeLessThanOrEqual(6);
  });

  it('the real AMSD-2041 shape (2 sites, 4 uncovered VCs) gets a floor well above the trivial-fix path', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [
        { file: 'src/services/contentstack.ts', helper: '' },
        { file: 'src/context/ContentstackContext.tsx', helper: '' },
      ],
      fixSiteAnalysisCoverage: {
        complete: false,
        uncoveredVerificationCriteria: [
          'SDK installed', 'preview API route', 'getStaticProps forwarding', 'unit tests',
        ],
      },
    });
    // 8 + 4*2 + 3*4 = 28 by the scaling formula
    expect(iters).toBeGreaterThanOrEqual(24);
  });

  it('a single site WITH a helper but incomplete coverage does NOT take the fast path', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'someHelper' }],
      fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['something not addressed'] },
    });
    expect(iters).toBeGreaterThan(6);
  });

  it('multiple sites with NO helper at all (novel work, several files) still scales up, not just floors at 12', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [
        { file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' },
        { file: 'c.ts', helper: '' }, { file: 'd.ts', helper: '' },
      ],
    });
    // 8 + 4*4 = 24
    expect(iters).toBeGreaterThanOrEqual(24);
  });

  it('the scaled formula is CEILED — a very large story does not get unbounded iterations (context-window risk)', () => {
    // 8 + 4*6 + 3*6 = 50 by the raw formula — must be capped, not applied raw.
    const iters = iterationsFor({
      fixSiteAnalysis: Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.ts`, helper: '' })),
      fixSiteAnalysisCoverage: {
        complete: false,
        uncoveredVerificationCriteria: Array.from({ length: 6 }, (_, i) => `vc${i}`),
      },
    });
    expect(iters).toBeLessThanOrEqual(30);
    expect(iters).toBeGreaterThan(24); // still elevated, just bounded
  });

  it('the ceiling is env-overridable via EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eff-floor-scope-'));
    dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{
        id: 'AMSD-2041',
        fixSiteAnalysis: Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.ts`, helper: '' })),
      }],
    }));
    const script = `
log() { :; }
export EPAM_BROWNFIELD=1
export PRD_FILE='${prd}'
export EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS=15
STORY_MAX_ITERATIONS=6
STORY_MAX_OUTPUT_TOKENS=3072
${fn}
resolve_brownfield_effort_floor AMSD-2041
echo "$STORY_MAX_ITERATIONS"
`;
    const iters = parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim(), 10);
    expect(iters).toBe(15);
  });

  it('is backward compatible: a PRD with no fixSiteAnalysisCoverage field at all still works (old runs / other stories)', () => {
    const iters = iterationsFor({
      fixSiteAnalysis: [{ file: 'src/x.ts', helper: 'existingHelper' }],
    });
    expect(iters).toBeLessThanOrEqual(6);
  });

  it('is a FLOOR — never lowers an already-larger budget even for a huge scaled scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eff-floor-scope-'));
    dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({
      stories: [{
        id: 'AMSD-2041',
        fixSiteAnalysis: [{ file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' }],
        fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['x', 'y', 'z'] },
      }],
    }));
    const script = `
log() { :; }
export EPAM_BROWNFIELD=1
export PRD_FILE='${prd}'
STORY_MAX_ITERATIONS=50
STORY_MAX_OUTPUT_TOKENS=3072
${fn}
resolve_brownfield_effort_floor AMSD-2041
echo "$STORY_MAX_ITERATIONS"
`;
    const iters = parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim(), 10);
    expect(iters).toBe(50);
  });
});
