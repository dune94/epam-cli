/**
 * ONE UNUSABLE BATCH VOIDED AN ENTIRE ROSTER REVIEW.
 *
 * A roster review runs one model call per batch of agents. The aggregation failed the WHOLE review
 * if ANY batch was unexamined — missing verdict, `nothing_to_review`, or a verdict outside the
 * enum. With six or more batches, one off-schema answer from the model discards all of them.
 *
 * Live 2026-09-01, metrolinx AMSD-1919: batch5 returned `defects_found` with real, grounded
 * findings — files read, greps run, line numbers cited — and it was thrown away because a sibling
 * batch was not usable. The gate then retried the JUDGE, six calls a time, three times, and the
 * mint failed with the roster never once judged on its merits. The run was killed at 37 minutes.
 *
 * WHY IT WAS NEVER TESTED: the logic sat inside `async function reviewProjectRoster()` in a
 * 10,000-line file, in the same function that does the batching and makes the model calls, and was
 * not exported. Exercising it meant paying for a run. That is the same defect shape as the roster
 * gate beside it — a decision buried where only money can reach it.
 *
 * THE RULE: judge on the batches that WERE examined, report the ones that were not, and never
 * discard a blocking finding because a different batch failed to answer.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { aggregateRosterReview } = require(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'));

const LEGAL = ['sound', 'defects_found', 'nothing_to_review'];
const batch = (verdict: string | null, findings: any[] = [], agents = ['a']) =>
  ({ agents, part: verdict === null ? null : { verdict, findings } });
const blocking = { agent: 'x', severity: 'blocking', claim: 'a real defect' };

describe('one bad batch does not void the whole review', () => {
  it('is exported so it can be tested without paying for a run', () => {
    expect(typeof aggregateRosterReview).toBe('function');
  });

  it('every batch clean → sound', () => {
    const r = aggregateRosterReview([batch('sound'), batch('sound')], LEGAL);
    expect(r.verdict).toBe('sound');
    expect(r.unexamined).toBe(0);
  });

  it('THE DEFECT: a clean batch beside an unusable one is still judged', () => {
    // batch5 said sound; a sibling returned nothing. The review must not become review_failed.
    const r = aggregateRosterReview([batch('sound'), batch(null)], LEGAL);
    expect(r.verdict, 'one unusable batch voided the whole review').toBe('sound');
    expect(r.unexamined, 'the unexamined batch is not reported, so nobody can retry just it').toBe(1);
  });

  it('AND A BLOCKING FINDING SURVIVES A SIBLING FAILURE', () => {
    // The dangerous direction: discarding a real defect because another batch failed to answer
    // would let a bad roster through on the strength of an unrelated model hiccup.
    const r = aggregateRosterReview([batch('defects_found', [blocking]), batch(null)], LEGAL);
    expect(r.verdict).toBe('defects_found');
    expect(r.findings, 'the blocking finding was discarded').toContainEqual(blocking);
  });

  it('a verdict outside the enum marks only ITS batch unexamined', () => {
    const r = aggregateRosterReview([batch('sound'), batch('warn')], LEGAL);
    expect(r.verdict).toBe('sound');
    expect(r.unexamined).toBe(1);
  });

  it('nothing_to_review marks only ITS batch unexamined', () => {
    const r = aggregateRosterReview([batch('defects_found', [blocking]), batch('nothing_to_review')], LEGAL);
    expect(r.verdict).toBe('defects_found');
    expect(r.unexamined).toBe(1);
  });

  it('NO batch examined → review_failed, and the roster is not implicated', () => {
    // The one case that must still fail the judge rather than the roster: nothing was judged.
    const r = aggregateRosterReview([batch(null), batch('nothing_to_review')], LEGAL);
    expect(r.verdict).toBe('review_failed');
    expect(r.reason).toMatch(/not implicated/i);
  });

  it('an empty result set is review_failed, never sound', () => {
    // A fail-open here would approve a roster no reviewer ever looked at.
    expect(aggregateRosterReview([], LEGAL).verdict).toBe('review_failed');
    expect(aggregateRosterReview(null as any, LEGAL).verdict).toBe('review_failed');
  });

  it('with no declared enum, no verdict can be called illegal', () => {
    // The schema declaring nothing must not turn every answer into a failure.
    const r = aggregateRosterReview([batch('anything_at_all')], []);
    expect(r.verdict).toBe('sound');
    expect(r.unexamined).toBe(0);
  });

  it('a partially-examined review says how many were missed', () => {
    const r = aggregateRosterReview([batch('sound'), batch(null), batch(null)], LEGAL);
    expect(r.unexamined).toBe(2);
    expect(r.reason, 'the caller cannot tell which batches to retry').toMatch(/2 of 3/);
  });
});
