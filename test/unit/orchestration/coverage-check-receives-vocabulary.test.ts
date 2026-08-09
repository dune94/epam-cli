/**
 * THE COVERAGE CHECK NEVER RECEIVED ITS VOCABULARY ON THE MAIN PATH.
 *
 * checkFixSiteCoverage(findings, verificationCriteria, vocabulary) refuses to guess: with no
 * derived vocabulary it returns `complete: null` and the reason "coverage not computed rather
 * than guessed". That is deliberate and correct.
 *
 * The main call site was missing a comma:
 *
 *     checkFixSiteCoverage(
 *       story.fixSiteAnalysis || [], story.verificationCriteria || []
 *       (story.specification || {}).guardVocabulary,
 *     );
 *
 * which parses as `verificationCriteria || ([](...).guardVocabulary)` — valid JavaScript, so
 * neither the parser nor ESLint objected. Two consequences:
 *
 *   - With criteria present the `||` short-circuits, the call gets TWO arguments, and
 *     vocabulary is undefined. Coverage therefore returned `complete: null` on EVERY run —
 *     and claude.sh maps null to true ("if .fixSiteAnalysisCoverage.complete == null then
 *     true"), so the gate was fail-open for its entire life while appearing to work.
 *   - With criteria absent the array literal is CALLED: "TypeError: [] is not a function".
 *
 * The correction path passed all three arguments correctly, which is why only the main path
 * was starved and the defect stayed invisible.
 *
 * Both sites now go through one exported function, so the argument list exists in one place
 * and is executed by this test rather than being read out of the source.
 */
import { describe, it, expect } from 'vitest';

const { coverageForStory, checkFixSiteCoverage } =
  require('../../../orchestrations/scripts/spec-mode-runner.js');

/** A story whose criterion is genuinely addressed by its fix site. */
function coveredStory() {
  return {
    fixSiteAnalysis: [{ file: 'src/services/newsService.ts', function: 'fetchArticles', reason: 'filters unpublished', fix: 'pass draft flag' }],
    verificationCriteria: ['unpublished articles appear when the draft flag is set'],
    specification: { guardVocabulary: { blacklist: [{ term: 'when' }, { term: 'appear' }] } },
  };
}

describe('the fixture is real', () => {
  it('checkFixSiteCoverage itself computes a verdict when handed a vocabulary', () => {
    const s = coveredStory();
    const direct = checkFixSiteCoverage(s.fixSiteAnalysis, s.verificationCriteria, s.specification.guardVocabulary);
    expect(direct.complete).not.toBeNull();
  });

  it('and refuses to compute one without it — the behaviour being defeated', () => {
    const s = coveredStory();
    expect(checkFixSiteCoverage(s.fixSiteAnalysis, s.verificationCriteria, undefined).complete).toBeNull();
  });
});

describe('THE DEFECT: the vocabulary reaches the check', () => {
  it('a story with a derived vocabulary gets a real verdict, not null', () => {
    expect(
      coverageForStory(coveredStory()).complete,
      'coverage returned null despite a vocabulary being present — the gate is fail-open',
    ).not.toBeNull();
  });

  it('an addressed criterion is reported as covered', () => {
    const r = coverageForStory(coveredStory());
    expect(r.complete).toBe(true);
    expect(r.uncoveredVerificationCriteria).toEqual([]);
  });

  it('an UNaddressed criterion is actually caught — the point of the check', () => {
    const s = coveredStory();
    s.verificationCriteria.push('the scheduling calendar recalculates departure times');
    const r = coverageForStory(s);
    expect(r.complete, 'a criterion no fix site touches was reported as covered').toBe(false);
    expect(r.uncoveredVerificationCriteria).toEqual(['the scheduling calendar recalculates departure times']);
  });
});

describe('the degenerate shapes that used to throw', () => {
  it('a story with NO verificationCriteria does not throw', () => {
    const s: any = coveredStory();
    delete s.verificationCriteria;
    expect(() => coverageForStory(s)).not.toThrow();
  });

  it('a story with no fixSiteAnalysis does not throw', () => {
    const s: any = coveredStory();
    delete s.fixSiteAnalysis;
    expect(() => coverageForStory(s)).not.toThrow();
  });

  it('a story with no specification does not throw, and declines to guess', () => {
    const s: any = coveredStory();
    delete s.specification;
    expect(() => coverageForStory(s)).not.toThrow();
    expect(coverageForStory(s).complete, 'a verdict was invented with no vocabulary').toBeNull();
  });

  it('an empty story object does not throw', () => {
    expect(() => coverageForStory({})).not.toThrow();
  });
});
