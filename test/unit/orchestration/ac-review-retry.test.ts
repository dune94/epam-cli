/**
 * Spec-pass AC write — retry on reviewPrdChange rejection (spec-mode-runner.js).
 *
 * A content-quality rejection from reviewPrdChange() used to just revert the
 * story's AC/description/title/technicalNotes and move on — never telling
 * the SAME agent what was actually wrong and letting it try again. This adds
 * up to 2 retries (3 attempts total), reusing the existing `forcedRetryNote`
 * parameter (the same one checkSplitMandateViolation's call site already
 * uses for a DIFFERENT violation class — a missed mandatory split), with an
 * INDEPENDENT attempt budget.
 *
 * Static-tier verification: the per-story agent loop and reviewPrdChange()
 * are not exported (same as this file's own `run()` entry point), and a
 * full behavioral test would require mocking runClaude/buildGateExec/
 * promptExec end-to-end. This confirms the exact code shape is wired
 * correctly instead — the same tier already used elsewhere in this repo for
 * hard-to-isolate control flow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(SPEC_RUNNER, 'utf8');

function extractBlock(startAnchor: string, endAnchor: string): string {
  const startIdx = src.indexOf(startAnchor);
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (startIdx === -1 || endIdx === -1) throw new Error('anchor not found');
  return src.slice(startIdx, endIdx + endAnchor.length);
}

describe('AC-write reviewPrdChange consumer — retry-on-violation (static)', () => {
  const block = extractBlock(
    "} else if (anyFieldChanged) {",
    "outcome: reviewResult.verdict === 'fail' ? 'reverted' : 'pass',"
  );

  it('retries up to 3 total attempts on a fail verdict', () => {
    expect(block).toMatch(/let acReviewAttempts = 1;/);
    expect(block).toMatch(/while \(reviewResult\.verdict === 'fail' && acReviewAttempts < 3\)/);
  });

  it('reuses the existing forcedRetryNote parameter, not a new one', () => {
    expect(block).toMatch(/forcedRetryNote: correctiveNote/);
  });

  it('retries the SAME agent that produced the rejected payload (openspec vs speckit)', () => {
    expect(block).toMatch(/agent === 'speckit'/);
    expect(block).toMatch(/runSpeckitReview\(\{ promptExec, story, openspecOutput: openspecPayload/);
    expect(block).toMatch(/runSpecAgent\(\{ promptExec, agent, story/);
  });

  it('re-applies applySpecChanges and re-reviews inside the retry loop (in addition to the initial application before this block)', () => {
    const occurrences = [...block.matchAll(/changes = applySpecChanges\(story, payload, newStories, prd, opts\.phase, runId\)/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    const reviewOccurrences = [...block.matchAll(/await reviewPrdChange\(\{/g)];
    expect(reviewOccurrences.length).toBeGreaterThanOrEqual(2); // initial call + at least one retry re-review
  });

  it('rolls back the rejected attempt\'s story fields and split children before reapplying, so retries never compound', () => {
    expect(block).toMatch(/story\.acceptanceCriteria = beforeSnapshot\.acceptanceCriteria;/);
    expect(block).toMatch(/newStories\.splice\(newStoriesCountBefore, newStories\.length - newStoriesCountBefore\);/);
  });

  it('logs the final outcome (attempts, pass/reverted, reason) via logGuardedStepRetry (double-write to per-run + persistent history)', () => {
    expect(block).toMatch(/logGuardedStepRetry\(logDir, \{/);
    expect(block).toMatch(/step: 'ac-review'/);
    expect(block).toMatch(/attempts: acReviewAttempts/);
  });

  it('still reverts (unchanged existing behavior) when all attempts are exhausted', () => {
    expect(block).toMatch(/if \(reviewResult\.verdict === 'fail'\) \{/);
    expect(block).toMatch(/REJECTED \$\{agent\}'s changes to \$\{story\.id\} after \$\{acReviewAttempts\} attempt\(s\)/);
  });
});

describe('runSpeckitReview() — accepts forcedRetryNote with the same primacy placement as runSpecAgent (static)', () => {
  it('accepts a forcedRetryNote parameter', () => {
    const idx = src.indexOf('async function runSpeckitReview(');
    const sig = src.slice(idx, src.indexOf(')', idx) + 1);
    expect(sig).toMatch(/forcedRetryNote/);
  });

  it('prepends forcedRetryNote at the top of the prompt (primacy), same as runSpecAgent\'s forcedRetryBlock', () => {
    const idx = src.indexOf('async function runSpeckitReview(');
    const body = src.slice(idx, idx + 600);
    expect(body).toMatch(/const forcedRetryBlock = forcedRetryNote \? `\$\{forcedRetryNote\}\\n\\n` : '';/);
    expect(body).toMatch(/const prompt = `\$\{forcedRetryBlock\}/);
  });
});

describe('AC-review retry budget is independent from checkSplitMandateViolation\'s retry budget (static)', () => {
  it('checkSplitMandateViolation\'s own retry counter (summary.stats.agentAttempts) is a separate variable from acReviewAttempts', () => {
    // The two retry mechanisms must never share a counter — seeding both
    // violations in the same story turn should show 2 (split-mandate) + 3
    // (ac-review) = 5 total distinct attempts tracked, not one shared budget.
    expect(src).toMatch(/let mandateCheck = checkSplitMandateViolation/);
    expect(src).not.toMatch(/acReviewAttempts.*mandateCheck|mandateCheck.*acReviewAttempts/);
  });
});
