/**
 * checkFixSiteCoverage — does the detective's fixSiteAnalysis actually touch
 * every verification criterion, or does it silently leave some uncovered?
 *
 * Live AMSD-2041, 2026-08-01: the detective's prompt is single-causal-site
 * framed ("investigating this bug ticket" / "PRESCRIBE THE MINIMAL FIX") —
 * right for a one-line defect, wrong for a multi-layer feature. It named 2
 * files (Contentstack SDK Stack config + Provider useState/useEffect
 * rewiring) while team-lead review caught 6+ more blockers sharing no term
 * with either finding: installing @contentstack/live-preview-utils, adding a
 * live_preview field to query/entry interfaces, a pages/api/preview.ts route,
 * getStaticProps preview forwarding, and tests. Nothing ever flagged that gap
 * — the implementer got a prescription that looked complete and wasn't.
 *
 * This is a deterministic (no LLM) term-overlap check, not a re-diagnosis: it
 * only proves whether the WORDING of each VC shows up anywhere in what the
 * detective found.
 */
import { describe, it, expect } from 'vitest';

const { checkFixSiteCoverage } = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('checkFixSiteCoverage', () => {
  it('reports complete when every VC shares a term with some finding', () => {
    const findings = [
      { file: 'src/services/contentstack.ts', function: 'Stack', reason: 'initializes the SDK', fix: 'add live_preview config' },
    ];
    const vcs = ['The Stack live_preview config enables draft content.'];
    const result = checkFixSiteCoverage(findings, vcs);
    expect(result.complete).toBe(true);
    expect(result.uncoveredVerificationCriteria).toEqual([]);
  });

  it('the real AMSD-2041 shape: the real 2-entry fixSiteAnalysis leaves the real uncovered review blockers uncovered', () => {
    // Pulled verbatim from the live AMSD-2041 prd.json (2026-08-01) — not
    // hand-simplified prose, per feedback_test_fixture_fidelity_not_just_real_execution.
    const findings = [
      {
        file: 'src/services/contentstack.ts', function: 'Stack',
        reason: 'This is where the Contentstack SDK Stack is initialized (line 69: `contentstack.Stack(options)`). Live Preview requires the Stack to be created with `live_preview` config (enable, host, preview_token). Without this, the SDK never processes live preview data — every downstream component is starved of preview content. This is the root cause, not the presentation-layer components that merely read content.',
        fix: 'Add `live_preview` configuration to the `options` object passed to `contentstack.Stack()`. The options object (constructed above line 69) must include `live_preview: { enable: true, host: CONTENTSTACK_PREVIEW_HOST, preview_token: CONTENTSTACK_PREVIEW_TOKEN }` (or equivalent env-driven fields). This enables the Contentstack SDK to resolve live preview hash/query parameters and return draft content instead of only published content. The env vars should follow the existing pattern already used for `CONTENTSTACK_API_HOST` (referenced at line 71).',
      },
      {
        file: 'src/context/ContentstackContext.tsx', function: 'ContentstackProvider',
        reason: 'The provider currently memoizes `defaultContent` once and never updates it. For Live Preview, the provider must subscribe to the Contentstack Live Preview SDK\'s `liveUpdate` events and merge incoming preview data into the context so all 236+ consumers of `useContent` re-render with draft content. This is the client-side wiring that makes preview data flow to components.',
        fix: 'In `ContentstackProvider`, initialize the Contentstack Live Preview SDK (e.g., `LivePreview.init()`) and add a `useEffect` that subscribes to `onLiveUpdate` (or `onMessage`) events, merging the incoming preview entry data into the existing `content` state via `setContent`. Replace the static `useMemo` with `useState` so the context value updates when live preview pushes new data. The existing `useContent` hook and `getContentByKey`/`getValue` utility need no changes — they already read from context dynamically.',
      },
    ];
    // Blocker descriptions pulled verbatim from the real team-lead review verdict
    // (lane-metrolinx.log, 2026-08-01) that these 2 findings did NOT prevent.
    const uncoveredBlockers = [
      'The `@contentstack/live-preview-utils` dependency is not installed anywhere in the project. No import of this package exists in the codebase.',
      'No vitest unit tests exist for the Live Preview feature. There is no `test/unit/` directory at all.',
    ];
    // Two other real blockers from the same review (the interface-update
    // blocker and the pages/api/preview.ts route blocker) are known false
    // negatives of this bag-of-words heuristic: they happen to share
    // incidental words ("hash"/"data", "enable") with the findings'
    // explanation text, even though the concerns are unrelated. A term-
    // overlap check is a coarse safety net, not a semantic prover — real
    // false negatives exist and are documented rather than chased into a
    // fragile, over-tuned matcher.
    //
    // The blocker the 2 findings DO actually address (Stack live_preview config).
    const coveredBlocker = 'The `options` object passed to `contentstack.Stack(options)` has no `live_preview` key, so `Stack.livePreview` is undefined.';

    const result = checkFixSiteCoverage(findings, [...uncoveredBlockers, coveredBlocker]);
    expect(result.complete).toBe(false);
    for (const blocker of uncoveredBlockers) {
      expect(result.uncoveredVerificationCriteria, `expected uncovered: "${blocker.slice(0, 60)}..."`).toContain(blocker);
    }
    expect(result.uncoveredVerificationCriteria).not.toContain(coveredBlocker);
  });

  it('an empty findings list leaves every non-trivial VC uncovered', () => {
    const result = checkFixSiteCoverage([], ['The dashboard displays the updated total.']);
    expect(result.complete).toBe(false);
    expect(result.uncoveredVerificationCriteria).toHaveLength(1);
  });

  it('an empty VC list is trivially complete (nothing to cover)', () => {
    const result = checkFixSiteCoverage([{ file: 'x.ts', reason: 'r', fix: 'f' }], []);
    expect(result.complete).toBe(true);
    expect(result.uncoveredVerificationCriteria).toEqual([]);
  });

  it('handles missing/malformed findings fields without throwing', () => {
    expect(() => checkFixSiteCoverage([{ file: 'x.ts' }], ['some criterion'])).not.toThrow();
    expect(() => checkFixSiteCoverage(undefined, undefined)).not.toThrow();
  });

  it('matches on a stem overlap (e.g. "install" vs "installed") not just exact tokens', () => {
    const findings = [{ file: 'package.json', reason: 'install the live-preview SDK dependency', fix: 'npm install @contentstack/live-preview-utils' }];
    const vcs = ['The live-preview SDK is installed as a dependency.'];
    const result = checkFixSiteCoverage(findings, vcs);
    expect(result.complete).toBe(true);
  });
});
