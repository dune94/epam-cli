/**
 * Review → re-implement → re-review loop, with self-heal + agent-KB for BOTH the
 * implementation agent and the reviewer.
 *
 * Before (found live 2026-07-23): a reviewer verdict was advisory — Step 3.6 ran
 * the review once, warned on changes_requested, and continued. The reviewer could
 * not send the change back to the impl agent, so an over-engineered fix shipped.
 *
 * After:
 *  - reviewer writes review-feedback-<id>.json on changes_requested
 *  - claude.sh injects that feedback into the re-implementation prompt
 *  - Step 3.6 loops: review → re-implement (run_story_with_watchdog, which reuses
 *    claude.sh's failure-analyst self-heal + impl agent-KB) → re-review, bounded
 *    by REVIEW_MAX_CYCLES; on exhaustion it marks the story escalated and hard-
 *    blocks (a change that keeps failing review never silently merges)
 *  - reviewer reads its own agent-KB (KB-review-agent.md) and appends blocker
 *    lessons on escalation — reviewer self-heal across runs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const reviewSrc = readFileSync(join(ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');
const claudeSrc = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const orchSrc = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('reviewer → writes feedback + reads its agent-KB', () => {
  it('writes review-feedback-<id>.json on changes_requested (for the impl agent to read)', () => {
    expect(reviewSrc).toMatch(/review-feedback-\$\{story_id\}\.json/);
    expect(reviewSrc).toMatch(/jq -c '\{verdict, summary, issues\}'/);
  });
  it('clears stale feedback when the story is approved', () => {
    expect(reviewSrc).toMatch(/rm -f "\$\{LOG_DIR[^}]*\}\/review-feedback-\$\{story_id\}\.json"/);
  });
  it('reads the review-agent KB into the review prompt (reviewer self-heal across runs)', () => {
    expect(reviewSrc).toMatch(/KB-review-agent\.md/);
    expect(reviewSrc).toMatch(/LEARNED REVIEW RULES/);
  });
});

describe('claude.sh → injects reviewer feedback into the re-implementation', () => {
  it('reads review-feedback-<id>.json and formats the issues', () => {
    expect(claudeSrc).toMatch(/_review_feedback_file=.*review-feedback-\$\{story_id\}\.json/);
    expect(claudeSrc).toMatch(/Reviewer Feedback — ADDRESS THESE/);
  });

  // The real jq the impl prompt uses to format reviewer issues.
  it('formats a blocker issue with file:line and suggested fix (real jq)', () => {
    const jq = `
      (.issues // []) | map(
        "- [" + (.severity // "issue") + "] " + (.description // "")
        + (if (.file // "") != "" then " (" + .file + (if (.line // 0) > 0 then ":" + (.line|tostring) else "" end) + ")" else "" end)
        + (if (.suggestedFix // "") != "" then "\\n  - Suggested fix: " + .suggestedFix else "" end)
      ) | join("\\n")`;
    const out = execFileSync('jq', ['-r', jq], {
      input: JSON.stringify({ issues: [{ severity: 'blocker', file: 'src/x.ts', line: 42, description: 'over-engineered', suggestedFix: 'remove the split' }] }),
      encoding: 'utf8',
    }).trim();
    expect(out).toBe('- [blocker] over-engineered (src/x.ts:42)\n  - Suggested fix: remove the split');
    expect(out).not.toContain('))'); // the double-paren bug must stay fixed
  });
});

describe('Step 3.6 → review→re-implement→re-review loop', () => {
  it('re-invokes the impl agent (run_story_with_watchdog) on changes_requested', () => {
    expect(orchSrc).toMatch(/review requested changes — re-implementing/);
    expect(orchSrc).toMatch(/run_story_with_watchdog "\$_fb_story"/);
  });
  it('is bounded by REVIEW_MAX_CYCLES', () => {
    expect(orchSrc).toMatch(/_review_max_cycles="\$\{REVIEW_MAX_CYCLES:-2\}"/);
    expect(orchSrc).toMatch(/_review_cycle" -ge "\$_review_max_cycles"/);
  });
  it('on exhaustion marks the story escalated, appends a reviewer-KB lesson, and hard-blocks', () => {
    expect(orchSrc).toMatch(/reviewStatus: "escalated"/);
    expect(orchSrc).toMatch(/KB-review-agent\.md/);
    // Hard-block now fires on the direct escalation FLAG (not only tagged-story count),
    // so an escalation with zero review-feedback files still blocks (2026-07-24 fix).
    expect(orchSrc).toMatch(/review changes unresolved after/);
    expect(orchSrc).toMatch(/\[ "\$\{_review_escalated:-0\}" -eq 1 \]/);
    expect(orchSrc).toMatch(/exit 2/);
  });
  it('breaks the loop (proceeds) only on an approved review', () => {
    expect(orchSrc).toMatch(/code review APPROVED for phase.*break/s);
  });
});
