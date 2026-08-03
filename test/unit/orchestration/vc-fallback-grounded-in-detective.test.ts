/**
 * safeFallbackVc() must stay grounded in the detective's findings, not just
 * the ticket title/description — otherwise the LAST-RESORT VC (used when the
 * regenerate loop can't converge) throws away everything the detective found
 * and hands the writer pure boilerplate.
 *
 * This is the SAME root-cause class as vc-grounded-in-detective.test.ts's
 * 2026-07-25 (AMSD-1820) incident, one step further down the pipeline. That
 * fix moved the detective call BEFORE VC enforcement and threaded its
 * findings into the REGENERATE callback (regenerateVcViaOpenspec) — but
 * safeFallbackVc(), the true last-resort branch when regeneration itself
 * exhausts its cycles, never received findings at all; it only ever took
 * `story` (title/description).
 *
 * Confirmed recurring live, 2026-08-03 (real tier3-metrolinx-run.sh,
 * AMSD-2041): the detective correctly identified the real fix site
 * (ContentstackContext.tsx's ContentstackProvider, with detailed reasoning),
 * but the persisted verificationCriteria were the pure generic fallback:
 * "The behavior described in the ticket is observed to be correct after the
 * change..." / "Existing behavior related to this area is unchanged..." —
 * zero reference to what the detective had already found. The writer, hand ed
 * a broad fixSiteAnalysis but VCs with no anchor to it, produced zero source
 * changes across 2 review cycles.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { findVcMechanism, safeFallbackVc, enforceVerificationCriteria } = spec;

const STORY = { id: 'AMSD-2041', title: '[GO, UP, MX] Live Preview of Content in CMS' };

const FINDINGS = [
  {
    file: 'src/context/ContentstackContext.tsx',
    function: 'ContentstackProvider',
    reason: 'single point where all content enters the React tree',
  },
];

describe('safeFallbackVc — grounded in detective findings when available', () => {
  it('REPRODUCES the live gap: with no findings param, the fallback is pure boilerplate with zero location grounding', () => {
    const fb = safeFallbackVc(STORY);
    expect(fb.join(' ')).not.toContain('ContentstackContext.tsx');
  });

  it('when findings are passed, the fallback names the located file — grounded, not generic', () => {
    const fb = safeFallbackVc(STORY, FINDINGS);
    expect(fb.join(' ')).toContain('src/context/ContentstackContext.tsx');
  });

  it('grounded fallback is STILL mechanism-free (must never itself become a mechanism VC)', () => {
    const fb = safeFallbackVc(STORY, FINDINGS);
    expect(findVcMechanism(fb)).toEqual([]);
  });

  it('with no findings at all (novel story, nothing located), behavior is unchanged from before', () => {
    const fb = safeFallbackVc(STORY, []);
    expect(fb.length).toBeGreaterThan(0);
    expect(findVcMechanism(fb)).toEqual([]);
  });
});

describe('enforceVerificationCriteria — threads findings through to the fallback branch, not just regenerate', () => {
  it('a regenerator that never converges still ends grounded in findings, not generic boilerplate', async () => {
    const r = await enforceVerificationCriteria(STORY, ['Split it per field.'], {
      regenerateVc: async () => ['Still split it per field.'], // never clean
      maxCycles: 2,
      findings: FINDINGS,
    });
    expect(r.source).toBe('fallback');
    expect(findVcMechanism(r.vc)).toEqual([]);
    expect(r.vc.join(' ')).toContain('src/context/ContentstackContext.tsx');
  });
});

describe('the real call site passes findings all the way to the fallback branch', () => {
  it('enforceVerificationCriteria is called with a findings option, not just regenerateVc/reviewVc', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
      'utf8',
    );
    const i = src.indexOf('await enforceVerificationCriteria(story, rawVc');
    expect(i).toBeGreaterThan(-1);
    const call = src.slice(i, i + 500);
    expect(call, 'the fallback branch has no way to see detectiveFindings without this').toMatch(/findings:\s*detectiveFindings/);
  });
});
