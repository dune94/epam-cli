/**
 * Step 3.6's review-escalation loop must clear a stale reviewStatus:"escalated"
 * tag left by an EARLIER cycle when a LATER review cycle genuinely approves
 * the same story.
 *
 * Root cause this fixes (found live, 2026-08-02, Writer Retest run): a
 * phase-level retry (triggered by an unrelated later gate failure) re-ran
 * Step 3.6 from scratch. Its first pass exhausted REVIEW_MAX_CYCLES and
 * escalated, tagging reviewStatus:"escalated" on the story. A LATER retry's
 * review then genuinely APPROVED the exact same story (verified: all 6
 * acceptance criteria correctly met) — but the hard-block check right after
 * the loop still found the stale tag from the earlier escalation and blocked
 * a change the reviewer HAD just approved. Nothing ever cleared it on a
 * subsequent real approval.
 *
 * Real execution of the actual, unmodified bash block, extracted by marker.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = orchSrc.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return orchSrc.slice(start, end + endMarker.length);
}

const STORY_RETRY_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');

const REVIEW_LOOP_BLOCK = extractBlock(
  '_review_max_retries="${EPAM_MAX_RETRIES:-7}"',
  // END THE BLOCK ON A STABLE ANCHOR, NOT ON AN EXIT CODE.
// This pinned `exit 2`, so the suite failed to LOAD the moment Step 3.6 changed to
// exit 3 (a HALT is not a remediation and must not be retried). Stopping at the message
// instead left the enclosing `if` unclosed, and bash exited 2 on the syntax error.
// The next section header is outside the block and does not move when a code does.
  '# Step 3.7: Pre-review build gate',
);

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runReviewLoop(opts: {
  prdStories: any[];
  reviewOutcome: 'approve' | 'reject-always';
  phaseStoryIds?: string[];
}): { exitCode: number; output: string; finalPrd: any } {
  const dir = mkdtempSync(join(tmpdir(), 'review-escalation-clear-'));
  cleanupDirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const prdPath = join(dir, 'prd.json');
  writeFileSync(
    prdPath,
    JSON.stringify({
      implementationOrder: { core: opts.phaseStoryIds ?? opts.prdStories.map((s) => s.id) },
      stories: opts.prdStories,
    }),
  );

  // Stub team-lead-review.sh: 'approve' exits 0 immediately (real review
  // succeeded); 'reject-always' exits 1 every time AND writes a real
  // review-feedback-<id>.json per story (matching real team-lead-review.sh's
  // own behavior on changes_requested) — the escalate branch iterates
  // exactly those files to know which story to tag.
  const stubPath = join(dir, 'team-lead-review.sh');
  writeFileSync(
    stubPath,
    opts.reviewOutcome === 'approve'
      ? '#!/usr/bin/env bash\nexit 0\n'
      : [
          '#!/usr/bin/env bash',
          ...opts.prdStories.map(
            (s) => `echo '{"verdict":"changes_requested","summary":"x","issues":[]}' > "$LOG_DIR/review-feedback-${s.id}.json"`,
          ),
          'exit 1',
        ].join('\n'),
  );
  chmodSync(stubPath, 0o755);

  const scriptPath = join(dir, 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `export SCRIPT_DIR=${JSON.stringify(dir)}`,
      `export PRD_FILE=${JSON.stringify(prdPath)}`,
      `export PHASE=core`,
      `export LOG_DIR=${JSON.stringify(logDir)}`,
      'log() { echo "LOG: $*"; }',
      'warning() { echo "WARN: $*"; }',
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      '_emit_agent() { :; }',
      'review_feedback_is_incomplete() { return 1; }',
      '_reset_story_for_reimplementation() { :; }',
      'run_story_with_watchdog() { :; }',
      `source ${JSON.stringify(STORY_RETRY_LIB)}`,
      REVIEW_LOOP_BLOCK,
      'echo "REACHED_END"',
    ].join('\n'),
  );

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  const output = (result.stdout || '') + (result.stderr || '');
  return { exitCode: result.status ?? -1, output, finalPrd: JSON.parse(readFileSync(prdPath, 'utf8')) };
}

describe('Step 3.6 review loop — clears a stale escalated tag on real approval', () => {
  it('REPRODUCES the live defect and proves the fix: a story pre-tagged reviewStatus:"escalated" (carried over from an earlier phase-retry cycle) is CLEARED when this cycle\'s review approves it', () => {
    const { exitCode, finalPrd } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041', reviewStatus: 'escalated' }],
      reviewOutcome: 'approve',
    });

    const story = finalPrd.stories.find((s: any) => s.id === 'AMSD-2041');
    expect(story.reviewStatus, 'stale "escalated" tag was not cleared on real approval').not.toBe('escalated');
    expect(exitCode, 'the run was blocked despite a real, current approval').toBe(0);
  });

  it('does NOT clear the tag, and DOES hard-block, when the review genuinely still fails this cycle', () => {
    const { exitCode, finalPrd } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041' }],
      reviewOutcome: 'reject-always',
    });

    const story = finalPrd.stories.find((s: any) => s.id === 'AMSD-2041');
    expect(story.reviewStatus).toBe('escalated');
    // 3, not 2 — see lib/phase-exit.sh: a HALT is not a remediation and must not be retried.
    expect(exitCode).toBe(3);
  });

  it('only clears the tag for stories in the CURRENT phase, not unrelated stories', () => {
    const { finalPrd } = runReviewLoop({
      prdStories: [
        { id: 'AMSD-2041', reviewStatus: 'escalated' },
        { id: 'OTHER-1', reviewStatus: 'escalated' },
      ],
      phaseStoryIds: ['AMSD-2041'], // OTHER-1 deliberately excluded from this phase
      reviewOutcome: 'approve',
    });
    // OTHER-1 is not in implementationOrder.core (only AMSD-2041 is), so it
    // must be left untouched — this run says nothing about OTHER-1's review.
    const other = finalPrd.stories.find((s: any) => s.id === 'OTHER-1');
    expect(other.reviewStatus).toBe('escalated');
  });

  it('is a no-op when no story was ever escalated (the common case)', () => {
    const { exitCode, finalPrd } = runReviewLoop({
      prdStories: [{ id: 'AMSD-2041' }],
      reviewOutcome: 'approve',
    });
    const story = finalPrd.stories.find((s: any) => s.id === 'AMSD-2041');
    expect(story.reviewStatus).toBeUndefined();
    expect(exitCode).toBe(0);
  });
});
