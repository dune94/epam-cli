/**
 * AN UNREVIEWED STORY IS NOT A REJECTED STORY.
 *
 * regintel 140717Z, core review cycle 1: three reviews came back APPROVED but with their first five
 * bytes missing (`dict":"approved",…`), so team-lead-review recorded them as
 *   {"verdict":"changes_requested","reviewIncomplete":true,"issues":[{"severity":"blocker",
 *    "description":"review-agent output had no parseable verdict — the change was NOT reviewed …"}]}
 * The phase-level rule already knows this shape (review_feedback_is_incomplete: re-run the REVIEW,
 * not the writer) — but only when EVERY story is incomplete. With ten real verdicts beside them, the
 * per-story loop treated the three as rejections: it advanced their ladders, reset the stories and
 * re-implemented them against feedback whose only content was that there was none. REGI-004-A and
 * REGI-010-A ended marked FAILED; REGI-004-B was blocked behind 004-A. Approved code, wrecked state.
 *
 * The loop now partitions the feedback set: a story whose feedback says reviewIncomplete is left for
 * the next review cycle to judge; only a story with a real verdict is re-implemented or escalated.
 * Driven through the REAL lib function over the run's own feedback shapes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/phase-assessment.sh');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const INCOMPLETE = { verdict: 'changes_requested', summary: 'review output unparseable', reviewIncomplete: true,
  issues: [{ severity: 'blocker', description: 'review-agent output had no parseable verdict — the change was NOT reviewed; blocking rather than auto-approving.' }] };
const REJECTED = { verdict: 'changes_requested', summary: 'AC3 fails', issues: [{ severity: 'blocker', file: 'regintel/ingest.py', description: '_classify_source_type uses strict equality' }] };

function partition(files: Record<string, object>) {
  const d = mkdtempSync(join(tmpdir(), 'unreviewed-')); dirs.push(d);
  for (const [id, body] of Object.entries(files)) writeFileSync(join(d, `review-feedback-${id}.json`), JSON.stringify(body));
  const r = spawnSync('bash', ['-c', `LOG_DIR="${d}"; PHASE=core; . "${LIB}"; review_feedback_to_reimplement`], { encoding: 'utf8' });
  return { out: (r.stdout || '').trim().split('\n').filter(Boolean), err: r.stderr || '', status: r.status };
}

describe('an unreviewed story is not a rejected story', () => {
  it('a story whose review was never parsed is NOT handed to the writer', () => {
    const r = partition({ 'REGI-004-A': INCOMPLETE });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toEqual([]);
  });

  it('a story with a real verdict IS handed to the writer, beside an unreviewed one that is not', () => {
    const r = partition({ 'REGI-002': REJECTED, 'REGI-004-A': INCOMPLETE, 'REGI-009b': INCOMPLETE });
    expect(r.out).toEqual(['REGI-002']);
  });

  it('an unreadable feedback file is not evidence the code is wrong either', () => {
    const d = mkdtempSync(join(tmpdir(), 'unreviewed-')); dirs.push(d);
    writeFileSync(join(d, 'review-feedback-REGI-007.json'), '{"verdict": ');
    const r = spawnSync('bash', ['-c', `LOG_DIR="${d}"; PHASE=core; . "${LIB}"; review_feedback_to_reimplement`], { encoding: 'utf8' });
    expect((r.stdout || '').trim()).toBe('');
  });

  it('the orchestrator\'s changes-requested loop takes its stories from that partition — not from every feedback file', () => {
    // The receiver: the loop that advances rungs, resets and re-implements. It must ask the
    // partition, so an incomplete verdict can never reach advance_story_retry_rung.
    const src = readFileSync(ORCH, 'utf8');
    const at = src.indexOf('_review_climbable_stories=()');
    expect(at).toBeGreaterThan(0);
    const loop = src.slice(at, at + 1500);
    expect(loop).toMatch(/review_feedback_to_reimplement/);
    expect(loop).not.toMatch(/for _fb in "\$LOG_DIR"\/review-feedback-\*\.json/);
  });
});
