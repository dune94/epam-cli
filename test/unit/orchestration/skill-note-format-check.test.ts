/**
 * Deterministic pre-check for skill_note/kb_entry format rules, added after a
 * live run (2026-07-07, tier3 core phase) observed the LLM reviewer
 * (run_prd_change_reviewer) reject already-well-formed self-heal notes 3/3
 * times purely on flaky format judgment — e.g. "Always end TypeScript
 * statements with semicolons and separate array/object properties with
 * commas to avoid TS1005 errors" (well under 200 chars, starts with
 * "Always", no story-ID reference) was still rejected with "not a concrete
 * do/don't instruction." Each rejection round wastes a gate-model round-trip
 * and 3 retries before falling back to an unreviewed persist anyway.
 *
 * _skill_note_format_ok() checks the same OBJECTIVELY verifiable rules the
 * reviewer's own profile states (length cap, imperative opener, no story-ID
 * reference, not a verbatim duplicate of an existing line in the profile).
 * When a candidate passes, run_change_with_reviewer_retry() skips the LLM
 * review entirely for that candidate — these are checkable facts, not
 * judgment calls, so there is nothing for an LLM to usefully adjudicate.
 * Genuinely subjective checks (contradiction, whether the lesson is sound)
 * are intentionally NOT covered here and still require the real reviewer —
 * this only short-circuits the specific false-rejection failure mode that
 * was observed burning cost live.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

function checkFormat(note: string, storyId: string, existingProfileText = ''): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'skill-note-format-'));
  try {
    const fnBody = extractFunctionBody('_skill_note_format_ok');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      `${fnBody}\n_skill_note_format_ok "$1" "$2" "$3"\necho "RC=$?"\n`,
    );
    const output = execFileSync('bash', [scriptPath, note, storyId, existingProfileText], { encoding: 'utf8' });
    return output.includes('RC=0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('_skill_note_format_ok — REAL execution', () => {
  it('accepts a well-formed note (imperative opener, short, no story ID, no duplicate)', () => {
    expect(
      checkFormat(
        'Always end TypeScript statements with semicolons and separate array/object properties with commas to avoid TS1005 errors',
        'SKY-002-impl',
      ),
    ).toBe(true);
  });

  it.each(['Do not', 'Never', 'Always', 'Avoid', 'Use', 'Prefer'])('accepts notes starting with "%s"', (verb) => {
    expect(checkFormat(`${verb} do the thing that fixes the bug.`, 'SKY-001')).toBe(true);
  });

  it('rejects a note over 200 characters', () => {
    const longNote = 'Always ' + 'x'.repeat(200);
    expect(checkFormat(longNote, 'SKY-001')).toBe(false);
  });

  it('rejects a note that does not start with an imperative opener', () => {
    expect(checkFormat('The bug was caused by a missing semicolon in the file.', 'SKY-001')).toBe(false);
  });

  it('rejects a note that references the story ID', () => {
    expect(checkFormat('Always fix the SKY-002-impl bug before committing.', 'SKY-002-impl')).toBe(false);
  });

  it('rejects a note that duplicates an existing line in the profile', () => {
    const note = 'Always validate input before use.';
    expect(checkFormat(note, 'SKY-001', `Some profile text.\n${note}\nMore text.`)).toBe(false);
  });

  it('rejects an empty note', () => {
    expect(checkFormat('', 'SKY-001')).toBe(false);
  });
});

describe('run_change_with_reviewer_retry — skips the LLM reviewer when format check passes', () => {
  function runRetry(opts: {
    changeType: string;
    candidate: string;
    storyId?: string;
    before?: string;
    reviewerRaisesAlarm?: boolean; // if the fake reviewer is invoked, fail loudly so the test catches it
  }): { verdict: string; finalText: string; reviewerWasCalled: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-shortcircuit-'));
    try {
      const retryBody = extractFunctionBody('run_change_with_reviewer_retry');
      const formatCheckBody = extractFunctionBody('_skill_note_format_ok');
      const reviewerCalledFile = join(dir, 'reviewer-called.txt');

      const script = `
TMPDIR="${dir}"
${formatCheckBody}
run_prd_change_reviewer() {
  echo "called" >> "${reviewerCalledFile}"
  echo "fail"
}
run_prd_change_summarizer() {
  echo "should-not-be-reached"
}
log() { :; }
warning() { :; }
${retryBody}
verdict=$(run_change_with_reviewer_retry "${opts.storyId ?? 'SKY-001'}" "${opts.changeType}" "${opts.before ?? ''}" "${opts.candidate}" 3)
final_text=$(cat "${dir}/.reviewer-retry-text-$$" 2>/dev/null || echo "")
echo "VERDICT=$verdict"
echo "FINAL_TEXT=$final_text"
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const verdict = output.match(/VERDICT=(\w+)/)?.[1] ?? '';
      const finalText = output.match(/FINAL_TEXT=(.*)$/m)?.[1] ?? '';
      let reviewerWasCalled = false;
      try {
        reviewerWasCalled = readFileSync(reviewerCalledFile, 'utf8').includes('called');
      } catch {
        reviewerWasCalled = false;
      }
      return { verdict, finalText, reviewerWasCalled };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a well-formed skill_note passes immediately WITHOUT ever calling the LLM reviewer', () => {
    const { verdict, finalText, reviewerWasCalled } = runRetry({
      changeType: 'skill_note',
      candidate: 'Always validate input before use.',
    });
    expect(verdict).toBe('pass');
    expect(finalText).toBe('Always validate input before use.');
    expect(reviewerWasCalled).toBe(false);
  });

  it('a well-formed kb_entry passes immediately WITHOUT ever calling the LLM reviewer', () => {
    const { verdict, reviewerWasCalled } = runRetry({
      changeType: 'kb_entry',
      candidate: 'Never mutate shared state inside a promise callback.',
    });
    expect(verdict).toBe('pass');
    expect(reviewerWasCalled).toBe(false);
  });

  it('a malformed skill_note (no imperative opener) still goes through the real LLM reviewer', () => {
    const { verdict, reviewerWasCalled } = runRetry({
      changeType: 'skill_note',
      candidate: 'The bug happens because of a missing semicolon somewhere.',
    });
    expect(reviewerWasCalled).toBe(true);
    expect(verdict).toBe('fail');
  });

  it('other change types (ac_patch, tc_patch) are NEVER short-circuited, even if they look imperative', () => {
    const { reviewerWasCalled } = runRetry({
      changeType: 'ac_patch',
      candidate: 'Always require a valid apiKey.',
    });
    expect(reviewerWasCalled).toBe(true);
  });

  it('a well-formed candidate that duplicates existing profile text still goes through the LLM reviewer', () => {
    const note = 'Always validate input before use.';
    const { reviewerWasCalled } = runRetry({
      changeType: 'skill_note',
      candidate: note,
      before: `Existing profile text.\n${note}\nMore existing text.`,
    });
    expect(reviewerWasCalled).toBe(true);
  });
});
