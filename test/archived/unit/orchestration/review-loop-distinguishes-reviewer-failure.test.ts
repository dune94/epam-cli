/**
 * B24 — the review loop treats "reviewer broken" as "code needs changing".
 *
 * Live (metrolinx 20:52 run, AMSD-1820 — the run where the fix AND a verified
 * reproducing test were both committed and the repro-gate PASSED):
 *
 *   21:01:50 Step 3.6: Running Team Lead code review for phase...
 *            review requested changes — re-implementing (cycle 1 → 2)
 *            review still requesting changes after 2 cycle(s) — escalating
 *            review changes unresolved after 2 cycle(s) (escalated: flag=1 tagged-stories=0)
 *
 * CHAIN:
 *  1. the review agent thrashed and produced no verdict;
 *  2. team-lead-review.sh correctly FAILS SAFE — it emits a synthetic
 *     changes_requested ("review-agent did not complete ... blocking rather than
 *     auto-approving") instead of defaulting to approved;
 *  3. but that verdict is PHASE-level, so no per-story review-feedback-<id>.json
 *     is written;
 *  4. the loop iterates review-feedback-*.json, finds NONE, and re-implements
 *     NOTHING — two entirely empty cycles — then escalates with tagged-stories=0.
 *
 * Re-implementing was never the right response: the story was not wrong, the
 * REVIEWER failed. Two cycles and a phase restart were spent re-doing work that had
 * already passed every gate.
 *
 * The fail-OPEN half of this was fixed earlier the same day (block on
 * _review_escalated rather than on a count of feedback files). This is the root
 * cause underneath it: the loop cannot tell the two situations apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = (p: string) => readFileSync(join(__dirname, '../../../orchestrations/scripts/', p), 'utf8');
const codeOnly = (s: string) => s.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const ORCH = codeOnly(raw('run-agent-orchestration.sh'));
const REVIEW = raw('team-lead-review.sh');
const REVIEW_CODE = codeOnly(REVIEW);

describe('B24 — reviewer failure is distinguishable from changes-requested', () => {
  it('the reviewer signals "did not complete" distinctly, not as ordinary feedback', () => {
    // A dedicated marker the caller can branch on — the synthetic verdict already
    // exists, but the caller cannot currently tell it apart from real feedback.
    expect(REVIEW).toMatch(/review_incomplete|REVIEW_INCOMPLETE|reviewIncomplete/);
  });

  it('the loop branches on it instead of re-implementing', () => {
    expect(ORCH).toMatch(/review_incomplete|REVIEW_INCOMPLETE|reviewIncomplete/);
  });

  it('does NOT run re-implementation when there is no per-story feedback', () => {
    // The live failure: two cycles that re-implemented nothing at all. The
    // guard now lives in the partition-by-ladder-exhaustion loop (2026-08-06:
    // re-implementation only fires for stories collected from a REAL
    // review-feedback-*.json existence check into _review_climbable_stories) —
    // a wider window than before, since the ladder-exhaustion/safety-valve
    // logic sits between that partition and the actual re-implement call.
    const i = ORCH.indexOf('Re-implementing $_fb_story');
    expect(i).toBeGreaterThan(-1);
    const near = ORCH.slice(Math.max(0, i - 2500), i);
    expect(near, 'must guard the re-implement loop on feedback existing').toMatch(/-f "\$_fb"|_fb_count|feedback/);
  });

  it('retries the REVIEWER when the reviewer is what failed', () => {
    // The decision moved into review_feedback_is_incomplete(). It used to be an
    // inline `[ -f "$_review_incomplete_flag" ] || [ "$_fb_count" -eq 0 ]`,
    // which missed the third unparseable path in team-lead-review.sh — the one
    // that writes a per-story feedback file and no flag. That path fired live on
    // 2026-07-26 and re-implemented a repro-gate-verified fix. Behaviour is
    // pinned in review-incomplete-not-changes-requested.test.ts.
    const i = ORCH.search(/review_feedback_is_incomplete|review-incomplete-|REVIEW_INCOMPLETE/);
    expect(i).toBeGreaterThan(-1);
    expect(ORCH.slice(i, i + 800)).toMatch(/re-?run|retry|review/i);
  });

  it('still BLOCKS if the reviewer never completes — never auto-approves', () => {
    // The fail-safe must survive: a change nobody reviewed cannot pass.
    expect(REVIEW_CODE).toMatch(/changes_requested/);
    expect(ORCH).toMatch(/_review_escalated/);
  });
});

describe('B24 — reviewer iteration budget', () => {
  it('is higher than the 12 that thrashed', () => {
    const m = REVIEW.match(/EPAM_MAX_ITERATIONS="\$\{REVIEW_MAX_ITERATIONS:-(\d+)\}"/);
    expect(m, 'reviewer iteration budget not found').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(12);
  });

  it('stays bounded', () => {
    const m = REVIEW.match(/EPAM_MAX_ITERATIONS="\$\{REVIEW_MAX_ITERATIONS:-(\d+)\}"/);
    expect(Number(m![1])).toBeLessThanOrEqual(40);
  });
});
