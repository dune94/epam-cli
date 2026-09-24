/**
 * THE OPERATOR REPORT SAYS WHEN NOTHING WAS REVIEWED.
 *
 * lifecycle-report.py renders a story's review from the LAST code-reviews.jsonl record it matches.
 * An unparseable review is recorded with the shape of a rejection — changes_requested and one
 * synthetic blocker — so before this change the report showed the operator "changes_requested" for
 * a story the reviewer never judged (live regintel 2026-09-21, REGI-003a: six in a row).
 *
 * Driven end to end: the REAL script is copied into an install-shaped tree (it derives its log
 * directory from its own location), fed a ledger, and the HTML and JSON it WRITES are asserted on.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'orchestrations/scripts/lifecycle-report.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function report(ledger: object[]) {
  const d = mkdtempSync(join(tmpdir(), 'lifecycle-')); dirs.push(d);
  const orch = join(d, 'orchestrations');
  mkdirSync(join(orch, 'scripts'), { recursive: true });
  mkdirSync(join(orch, 'logs'), { recursive: true });
  copyFileSync(SCRIPT, join(orch, 'scripts', 'lifecycle-report.py'));
  writeFileSync(join(orch, 'prd.json'), JSON.stringify({ stories: [STORY] }));
  writeFileSync(join(orch, 'logs', 'code-reviews.jsonl'), ledger.map(r => JSON.stringify(r)).join('\n') + '\n');
  const html = join(d, 'out.html'); const json = join(d, 'out.json');
  const r = spawnSync('python3', [join(orch, 'scripts', 'lifecycle-report.py'), '--story', 'REGI-003a', '--phase', 'core',
    '--html', html, '--json-out', json], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return { html: readFileSync(html, 'utf8'), json: JSON.parse(readFileSync(json, 'utf8')) };
}

// Shaped like a real PRD story: every field the report reads, as the regintel PRD carries them
// (24 of 24 stories there carry effort; a story without it is not a shape the pipeline produces).
const STORY = { id: 'REGI-003a', title: 'Deduplicate regulatory updates', status: 'in_progress', effort: 'medium',
  estimatedHours: 3, agentRole: 'backend', acceptanceCriteria: ['AC1', 'AC2'], storyType: 'feature', priority: 'high' };
const base = { phase_id: 'core', story: 'REGI-003a', timestamp: '2026-09-21T16:45:04-04:00', reviewer: 'team-lead-agent' };
const INCOMPLETE = { ...base, verdict: 'changes_requested', review_status: 'changes_requested', reviewIncomplete: true, issues_found: 1,
  issues: [{ severity: 'blocker', description: 'review-agent output had no parseable verdict — the change was NOT reviewed' }] };
const REAL = { ...base, verdict: 'changes_requested', review_status: 'changes_requested', reviewIncomplete: false, issues_found: 1,
  issues: [{ severity: 'blocker', description: 'RU-006 is classified needs-review, not duplicate' }] };
const NOTICE = 'the reviewer produced no verdict';

describe('the operator report says when nothing was reviewed', () => {
  it('a review that produced no verdict is named as that, in the HTML and the JSON', () => {
    const { html, json } = report([INCOMPLETE]);
    expect(json.stages?.review, 'the review stage must be present at all — otherwise nothing is tested').toBeTruthy();
    expect(json.stages.review.reviewIncomplete).toBe(true);
    expect(html).toContain(NOTICE);
  });

  it('a real rejection carries no such notice', () => {
    const { html, json } = report([REAL]);
    expect(html, 'the report rendered no review at all — the negative below would be vacuous').toContain('Stage 2');
    expect(html).not.toContain(NOTICE);
    expect(json.stages?.review, 'the review stage must be present at all').toBeTruthy();
    expect(json.stages.review.reviewIncomplete).toBe(false);
  });

  it('the notice follows the LATEST record: a real verdict after a failed one clears it', () => {
    const { html } = report([INCOMPLETE, REAL]);
    expect(html).not.toContain(NOTICE);
  });

  it('a ledger written before the field existed renders with no notice and no error', () => {
    const { reviewIncomplete, ...legacy } = REAL;
    const { html } = report([legacy]);
    expect(html).toContain('Stage 2');
    expect(html).not.toContain(NOTICE);
  });
});
