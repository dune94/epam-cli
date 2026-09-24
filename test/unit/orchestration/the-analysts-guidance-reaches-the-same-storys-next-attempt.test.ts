/**
 * THE ANALYST'S GUIDANCE REACHES THE SAME STORY'S NEXT ATTEMPT — AND NO OTHER STORY'S.
 *
 * record_run_guidance is the in-run channel from the failure analyst to the retry: failure-healing
 * records what it prescribed (target skill or kb), and run_guidance_for_story reads it back for
 * the next attempt's prompt. Both ends are driven here, through the real functions, over one
 * ledger — what the reader returns is what the retry would be given.
 *
 * It is a guard: it can refuse (no LOG_DIR) and it can decline (an empty note), and no test had
 * ever named it (pre-flight guard calibration, 2026-09-24).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const KB = join(__dirname, '../../../orchestrations/scripts/lib/knowledge-base.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const FNS = ['_run_guidance_file', 'record_run_guidance', 'run_guidance_for_story'].map((n) => shellFunction(KB, n)).join('\n');

function sh(script: string, logDir?: string) {
  const r = spawnSync('bash', ['-c', `${logDir ? `export LOG_DIR="${logDir}"` : 'unset LOG_DIR'}\n${FNS}\n${script}`], { encoding: 'utf8' });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}
function ledgerDir() { const d = mkdtempSync(join(tmpdir(), 'guidance-')); dirs.push(d); return d; }

describe('the analyst\'s guidance reaches the same story\'s next attempt', () => {
  it('a recorded note is what the next attempt of that story reads back', () => {
    const d = ledgerDir();
    const r = sh(`record_run_guidance REGI-009a "raise maxOutputTokens: the attempt was truncated mid-file" skill
run_guidance_for_story REGI-009a`, d);
    expect(r.status, r.err).toBe(0);
    expect(r.out.trim()).toBe('raise maxOutputTokens: the attempt was truncated mid-file');
    const rec = JSON.parse(readFileSync(join(d, 'run-guidance.jsonl'), 'utf8').trim());
    expect(rec).toMatchObject({ storyId: 'REGI-009a', target: 'skill' });
  });

  it('another story is not handed it', () => {
    const d = ledgerDir();
    const r = sh(`record_run_guidance REGI-009a "only for 009a" kb
printf '[%s]' "$(run_guidance_for_story REGI-010-A)"`, d);
    expect(r.out).toBe('[]');
  });

  it('the same note recorded twice is read once, in order, beside a different one', () => {
    const d = ledgerDir();
    const r = sh(`record_run_guidance S-1 "first" skill; record_run_guidance S-1 "second" kb; record_run_guidance S-1 "first" skill
run_guidance_for_story S-1`, d);
    expect(r.out.trim().split('\n')).toEqual(['first', 'second']);
  });

  it('an empty note records nothing — the ledger is not created for it', () => {
    const d = ledgerDir();
    const r = sh(`record_run_guidance S-1 "" skill; echo "rc=$?"`, d);
    expect(r.out).toContain('rc=0');
    expect(existsSync(join(d, 'run-guidance.jsonl'))).toBe(false);
  });

  it('with no LOG_DIR it REFUSES to record — a note written nowhere would be lost silently', () => {
    const r = sh(`record_run_guidance S-1 "a note" skill; echo "rc=$?"`);
    expect(r.out).toMatch(/rc=[1-9]/);
    expect(r.err).toMatch(/LOG_DIR is required/);
  });

  it('and reading with no ledger is an empty answer, not an error — a first attempt has none', () => {
    const d = ledgerDir();
    const r = sh(`printf '[%s]' "$(run_guidance_for_story S-1)"; echo " rc=$?"`, d);
    expect(r.out.trim()).toBe('[] rc=0');
  });
});
