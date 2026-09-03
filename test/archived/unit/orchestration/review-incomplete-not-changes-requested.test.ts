/**
 * "The reviewer failed" must never be actioned as "the code needs changing".
 *
 * B24 already established this: team-lead-review.sh fails SAFE when its agent
 * produces no verdict, emitting a synthetic changes_requested so an unreviewed
 * change can never auto-approve — and the orchestration loop is supposed to
 * answer that by RE-RUNNING THE REVIEW rather than re-implementing a story that
 * was never the problem.
 *
 * The guard did not fire. Live metrolinx 2026-07-26: the review-agent burned
 * 3143 output tokens and wrote a 0-byte log, and the pipeline responded with
 *
 *   Step 3.6: review requested changes — re-implementing (cycle 1 → 2)
 *
 * against a fix the bug-reproduction gate had just proven fails-on-baseline and
 * passes-with-fix. It re-implemented code on the strength of feedback whose only
 * content was "there is no feedback".
 *
 * The reason is that there are TWO unparseable-verdict paths in
 * team-lead-review.sh. Lines 197 and 611 write review-incomplete-<phase>.flag,
 * which the guard looks for. Line 473 — the one that fired — writes only a
 * per-story review-feedback-<id>.json. So the flag was absent AND the feedback
 * count was 1, and both halves of the guard's condition missed.
 *
 * The fix keys on CONTENT rather than on a side-channel file: the synthetic
 * verdict declares reviewIncomplete, and any feedback that says "I did not
 * review this" is treated as reviewer failure regardless of which path produced
 * it or how the phase happens to be named.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

function extractFunctionBody(name: string): string {
  const re = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const m = re.exec(orchSrc);
  if (!m) throw new Error(`No function definition found for ${name}()`);
  const start = m.index;
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Returns true when the pipeline should re-run the REVIEW instead of the code. */
function isReviewerFailure(files: Record<string, unknown>, opts: { flag?: boolean } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'review-incomplete-'));
  cleanupDirs.push(logDir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(logDir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  if (opts.flag) writeFileSync(join(logDir, 'review-incomplete-core.flag'), 'REVIEW_INCOMPLETE\n');

  const script = join(logDir, 'drive.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `LOG_DIR=${JSON.stringify(logDir)}`,
      'PHASE=core',
      extractFunctionBody('review_feedback_is_incomplete'),
      'if review_feedback_is_incomplete; then echo "RESULT=reviewer_failure"; else echo "RESULT=real_findings"; fi',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return /RESULT=reviewer_failure/.test(out);
}

const UNPARSEABLE = {
  verdict: 'changes_requested',
  summary: 'review output unparseable',
  reviewIncomplete: true,
  issues: [{
    severity: 'blocker',
    description: 'review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.',
  }],
};

const REAL_FINDING = {
  verdict: 'changes_requested',
  summary: 'over-engineered',
  issues: [{ severity: 'major', description: 'reuse the existing helper instead of a new function' }],
};

describe('an unreviewed change is not a change that needs re-writing', () => {
  it('recognises the live shape — per-story synthetic verdict, no flag file', () => {
    // Exactly what was on disk when the pipeline re-implemented a verified fix.
    expect(isReviewerFailure({ 'review-feedback-AMSD-1820.json': UNPARSEABLE }),
      'the pipeline would re-implement the story again — the reviewer never looked at it')
      .toBe(true);
  });

  it('still recognises the flag-file path', () => {
    // The other two unparseable paths (team-lead-review.sh:197, :611).
    expect(isReviewerFailure({}, { flag: true })).toBe(true);
  });

  it('still recognises the no-feedback-at-all path', () => {
    expect(isReviewerFailure({})).toBe(true);
  });

  it('does NOT hijack a genuine changes_requested', () => {
    // The reviewer's real findings must still drive a re-implementation —
    // that loop is how over-engineering gets corrected.
    expect(isReviewerFailure({ 'review-feedback-AMSD-1820.json': REAL_FINDING }),
      'real reviewer findings were misread as reviewer failure, disabling the fix loop')
      .toBe(false);
  });

  it('treats a mixed batch as real findings — at least one story WAS reviewed', () => {
    expect(isReviewerFailure({
      'review-feedback-AMSD-1820.json': UNPARSEABLE,
      'review-feedback-AMSD-1999.json': REAL_FINDING,
    })).toBe(false);
  });

  it('is not fooled by a feedback file that is not valid JSON', () => {
    // Unreadable feedback is not evidence that the code is wrong either.
    expect(isReviewerFailure({ 'review-feedback-X.json': 'not json' })).toBe(true);
  });
});

describe('the synthetic verdict declares itself', () => {
  const tlr = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');

  it('the unparseable-verdict path marks reviewIncomplete', () => {
    // Without this the content-based check has nothing to key on, and we are
    // back to relying on a flag file whose name must match across two scripts.
    const idx = tlr.indexOf("'summary': 'review output unparseable'");
    expect(idx, 'the unparseable synthetic verdict was not found').toBeGreaterThan(-1);
    const stanza = tlr.slice(Math.max(0, idx - 400), idx + 200);
    expect(stanza, 'the synthetic verdict does not say it is an unreviewed change')
      .toMatch(/reviewIncomplete/);
  });

  it('the orchestration loop consults the shared predicate', () => {
    expect(orchSrc).toMatch(/review_feedback_is_incomplete/);
    const reimpl = orchSrc.indexOf('review requested changes — re-implementing');
    const guard = orchSrc.indexOf('review_feedback_is_incomplete');
    expect(guard, 'the guard must be evaluated before the re-implementation branch')
      .toBeLessThan(reimpl);
  });
});
