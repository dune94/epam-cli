/**
 * A GATE THAT COULD NOT JUDGE DOES NOT REPORT A PASS.
 *
 * `parseReviewVerdict` ended:
 *
 *   return { verdict: m ? m[1] : 'pass', issues: [] };
 *
 * and its caller's catch block ended:
 *
 *   console.warn(`... call failed ... — defaulting to pass`);
 *   return { verdict: 'pass', issues: [] };
 *
 * So prd-change-reviewer answered "pass" when it could not parse the reviewer's output, and again
 * when the call itself threw. The consumer only ever tests `verdict === 'fail'`, so anything else
 * — including a silent failure to review at all — lets the PRD change through.
 *
 * This is the same fail-open shape as the roster review's `nothing_to_review`, and the same one I
 * reintroduced in the batch aggregation on 2026-08-24. A gate has THREE outcomes, not two: it
 * passed, it failed, or it did not run. The third must never collapse into the first.
 *
 * The verdict vocabulary is read from what the code actually emits, so this asserts behaviour
 * rather than restating a contract.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

describe('parseReviewVerdict', () => {
  it('reads a clean pass', () => {
    expect(spec.parseReviewVerdict(JSON.stringify({ verdict: 'pass', issues: [] })).verdict)
      .toBe('pass');
  });

  it('reads a clean fail, with its issues', () => {
    const r = spec.parseReviewVerdict(JSON.stringify({ verdict: 'fail', issues: ['bad'] }));
    expect(r.verdict).toBe('fail');
    expect(r.issues).toContain('bad');
  });

  it('recovers a verdict embedded in surrounding prose', () => {
    // The salvage path must keep working — models routinely wrap JSON in commentary.
    expect(spec.parseReviewVerdict('Here is my answer:\n{"verdict":"fail","issues":[]}\nDone')
      .verdict).toBe('fail');
  });

  it('does NOT report a pass when there is no verdict to read', () => {
    const r = spec.parseReviewVerdict('I was unable to complete this review.');
    expect(r.verdict, 'unparseable output was reported as a passing review').not.toBe('pass');
  });

  it('does NOT report a pass for empty output', () => {
    expect(spec.parseReviewVerdict('').verdict, 'silence was reported as a pass').not.toBe('pass');
    expect(spec.parseReviewVerdict(null as unknown as string).verdict).not.toBe('pass');
  });

  it('says WHY it could not judge, so the outcome is diagnosable', () => {
    const r = spec.parseReviewVerdict('nothing useful here');
    expect(String((r.issues || []).join(' ')).length,
      'a gate that could not judge left no explanation').toBeGreaterThan(0);
  });

  it('the un-judged verdict is not "fail" either — it is its own outcome', () => {
    // Reporting "fail" would be safe but wrong: it blames the artefact for the gate's failure,
    // which is the mistake the roster review made with nothing_to_review.
    const r = spec.parseReviewVerdict('nothing useful here');
    expect(['pass', 'fail']).not.toContain(r.verdict);
  });
});
