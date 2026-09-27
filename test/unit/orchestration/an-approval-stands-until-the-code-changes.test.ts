/**
 * AN APPROVAL STANDS UNTIL THE CODE CHANGES.
 *
 * regintel run 20260926T125158Z's review loop re-reviewed every story in the phase on every round:
 * 63 reviews over three rounds for ~21 stories (~$8 of the resume's ~$10), and re-reading approved,
 * unchanged code produced new minor findings on stories approved rounds earlier (26 → 13 → 19 issues).
 *
 * review_stands (lib/review-scope.sh), executed on that run's own records — the review log and the
 * story-change log exactly as the run left them: a story whose last review approved it, completely,
 * after its last commit is not reviewed again; anything else is.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCOPE = join(ROOT, 'orchestrations/scripts/lib/review-scope.sh');
const LOGS = join(ROOT, 'test/fixtures/regintel/logs-20260926T125158Z');

function stands(ids: string[], logDir = LOGS): Record<string, boolean> {
  const script = `. ${JSON.stringify(SCOPE)}; for id in ${ids.join(' ')}; do review_stands "$id" core && echo "$id yes" || echo "$id no"; done`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8',
    env: { ...process.env, LOG_DIR: logDir, REVIEW_LOG: join(logDir, 'code-reviews.jsonl') } });
  expect(r.status, r.stderr).toBe(0);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const [id, v] = l.split(' '); return [id, v === 'yes']; }));
}

const STANDS = ['REGI-002a', 'REGI-002b', 'REGI-003b', 'REGI-004b', 'REGI-005b', 'REGI-007A', 'REGI-007B', 'REGI-008',
  'REGI-009-A', 'REGI-009-B', 'REGI-010-A', 'REGI-010-B', 'REGI-011-impl', 'REGI-011-test', 'REGI-014'];

describe('on run 20260926T125158Z\'s own review and commit records', () => {
  it('the 15 stories approved after their last commit are not reviewed again', () => {
    const r = stands(STANDS);
    for (const id of STANDS) expect(r[id], `${id} would be re-reviewed`).toBe(true);
  });

  it('a story whose last review asked for changes is reviewed again (REGI-006, 012, 013, 005a)', () => {
    const r = stands(['REGI-006', 'REGI-012', 'REGI-013', 'REGI-005a']);
    for (const [id, v] of Object.entries(r)) expect(v, `${id} would be skipped`).toBe(false);
  });

  it('a story committed after its last review is reviewed again (REGI-003a, 004a: reworked in round 4)', () => {
    const r = stands(['REGI-003a', 'REGI-004a']);
    for (const [id, v] of Object.entries(r)) expect(v, `${id} would be skipped`).toBe(false);
  });

  it('a story with no review record — an adopted story — is reviewed', () => {
    expect(stands(['REGI-015', 'REGI-016'])).toEqual({ 'REGI-015': false, 'REGI-016': false });
  });
});

describe('what makes an approval stop standing', () => {
  it('a new commit after the approval sends the story back to the reviewer', () => {
    const d = mkdtempSync(join(tmpdir(), 'review-stands-'));
    try {
      copyFileSync(join(LOGS, 'code-reviews.jsonl'), join(d, 'code-reviews.jsonl'));
      copyFileSync(join(LOGS, 'story-changes.jsonl'), join(d, 'story-changes.jsonl'));
      expect(stands(['REGI-008'], d)['REGI-008']).toBe(true);
      appendFileSync(join(d, 'story-changes.jsonl'), JSON.stringify({ storyId: 'REGI-008', sha: 'f'.repeat(40), committedAt: '2026-09-26T20:00:00-04:00', files: ['regintel/api.py'] }) + '\n');
      expect(stands(['REGI-008'], d)['REGI-008']).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('an approval the reviewer marked incomplete does not stand', () => {
    const d = mkdtempSync(join(tmpdir(), 'review-stands-'));
    try {
      copyFileSync(join(LOGS, 'code-reviews.jsonl'), join(d, 'code-reviews.jsonl'));
      copyFileSync(join(LOGS, 'story-changes.jsonl'), join(d, 'story-changes.jsonl'));
      appendFileSync(join(d, 'code-reviews.jsonl'), JSON.stringify({ phase_id: 'core', timestamp: '2026-09-26T21:00:00-04:00', story: 'REGI-008', verdict: 'approved', reviewIncomplete: true, issues: [] }) + '\n');
      expect(stands(['REGI-008'], d)['REGI-008']).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('an approval in another phase does not stand for this one', () => {
    // REGI-001A was approved in scaffold; asked about under core it has no core review.
    expect(stands(['REGI-001A'])['REGI-001A']).toBe(false);
  });
});
