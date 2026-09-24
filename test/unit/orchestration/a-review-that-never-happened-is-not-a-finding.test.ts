/**
 * A REVIEW THAT NEVER HAPPENED IS NOT A FINDING AGAINST THE CODE.
 *
 * regintel, 2026-09-21, REGI-003a: six consecutive reviews came back with no parseable verdict
 * (16:45 → 16:51, one a minute). team-lead-review-json.py marked each one correctly —
 * reviewIncomplete:true, "review output unparseable" — and the per-story feedback file carried it,
 * so the Step 3.6 loop did the right thing and re-ran the REVIEW.
 *
 * The LEDGER did not carry it. The jsonl record projects {phase_id, timestamp, story, verdict,
 * review_status, issues, ...} and drops reviewIncomplete, so code-reviews.jsonl holds six records
 * indistinguishable from six real rejections of the code — `grep -c reviewIncomplete
 * code-reviews.jsonl` = 0 across the whole run.
 *
 * That ledger is the reviewer's own memory: prior-reviews.py reads it back and renders it into the
 * NEXT review's prompt. So the next reviewer was handed six phantom blockers reading
 * "[blocker] review-agent output had no parseable verdict" as its own prior findings ABOUT THE
 * CODE — misinformation manufactured by the engine and fed to an agent.
 *
 * Nothing is deleted: an iteration that produced no verdict is a real fact about the reviewer and
 * stays in the ledger and in the memory block. It is rendered as what it is — a reviewer failure —
 * and its synthetic blocker is not presented as a finding.
 *
 * Both ends are driven for real: the ledger line is produced by the script's own jq program, and
 * the memory block by the real prior-reviews.py over that produced line.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const REVIEW_SH = join(ROOT, 'orchestrations/scripts/team-lead-review.sh');
const PRIOR = join(ROOT, 'orchestrations/scripts/lib/handlers/prior-reviews.py');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const INCOMPLETE = JSON.stringify({
  verdict: 'changes_requested', reviewIncomplete: true, summary: 'review output unparseable',
  issues: [{ severity: 'blocker', description: 'review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.' }],
});
const REAL = JSON.stringify({
  verdict: 'changes_requested', summary: 'AC5 unmet',
  issues: [{ severity: 'blocker', file: 'regintel/dedup.py', description: 'RU-006 is classified needs-review, not duplicate' }],
});

/** The ledger writer, lifted from the script it lives in and executed — not read for a substring. */
function ledgerProgram(): string {
  const src = readFileSync(REVIEW_SH, 'utf8');
  const start = src.indexOf('    if ! jq -cn \\');
  expect(start, 'the ledger-writing jq block moved — find it before trusting this test').toBeGreaterThan(0);
  const warn = src.indexOf('warning "  could not record this review', start);
  expect(warn).toBeGreaterThan(start);
  const end = src.indexOf('\n    fi\n', warn);          // the block's own closing fi, at its own indent
  expect(end).toBeGreaterThan(warn);
  const block = src.slice(start, end + '\n    fi'.length);
  // It must be the real thing: the record's own field names, straight from the script.
  expect(block).toContain('review_status:$verdict');
  return block;
}

function writeLedgerLine(reviewJson: string, story: string) {
  const d = mkdtempSync(join(tmpdir(), 'review-ledger-')); dirs.push(d);
  const log = join(d, 'code-reviews.jsonl');
  const verdict = JSON.parse(reviewJson).verdict;
  const r = spawnSync('bash', ['-c', `
set -u
warning(){ :; }
PHASE_ID=core; story_id=${story}; STORY_VERDICT=${verdict}
REVIEW_JSON=$(cat)
REVIEW_LOG="${log}"
${ledgerProgram()}
`], { input: reviewJson, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return { dir: d, log, line: JSON.parse(readFileSync(log, 'utf8').trim()) };
}

describe('a review that never happened is not a finding against the code', () => {
  it('the ledger records that the reviewer failed — not that the code was rejected', () => {
    const { line } = writeLedgerLine(INCOMPLETE, 'REGI-003a');
    expect(line.story).toBe('REGI-003a');
    expect(line.reviewIncomplete, 'code-reviews.jsonl held 0 records carrying this across the whole 2026-09-21 run').toBe(true);
  });

  it('a real rejection is still recorded as a rejection, with no incomplete marker', () => {
    const { line } = writeLedgerLine(REAL, 'REGI-010-A');
    expect(line.verdict).toBe('changes_requested');
    expect(line.issues_found).toBe(1);
    expect(line.reviewIncomplete ?? false).toBe(false);
  });

  it('the next reviewer is not handed a no-verdict iteration as a prior finding about the code', () => {
    const { log } = writeLedgerLine(INCOMPLETE, 'REGI-003a');
    const r = spawnSync('python3', [PRIOR, log, 'REGI-003a'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out, 'the iteration is not erased — it happened').toContain('Iteration 1');
    expect(out, 'it is rendered as a reviewer failure').toMatch(/no verdict/i);
    expect(out, 'the synthetic blocker must not read as a finding about the code')
      .not.toContain('[blocker]');
  });

  it('a real prior finding is still rendered in full, beside the failed iteration', () => {
    const { log } = writeLedgerLine(INCOMPLETE, 'REGI-003a');
    const d2 = writeLedgerLine(REAL, 'REGI-003a');
    // One story, two iterations, in order: the failed one then the real one.
    const merged = join(d2.dir, 'merged.jsonl');
    writeFileSync(merged, readFileSync(log, 'utf8') + readFileSync(d2.log, 'utf8'));
    const r = spawnSync('python3', [PRIOR, merged, 'REGI-003a'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Iteration 2');
    expect(r.stdout).toContain('[blocker] RU-006 is classified needs-review, not duplicate');
    expect((r.stdout.match(/\[blocker\]/g) || []).length, 'exactly one finding — the other iteration had none').toBe(1);
  });
});
