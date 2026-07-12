/**
 * The skill_note persistence call site in run_failure_analyst's `skill)` case
 * (claude.sh, inside the FailureAnalyst's target=skill branch) used to
 * `head -c 500` the existing profile text before handing it to
 * run_change_with_reviewer_retry / _skill_note_format_ok's duplicate check.
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run): new
 * skill notes are appended to the END of a profile's (single, growing) prompt
 * string, not written to a separate bounded log. Once a profile grows past
 * 500 chars — typescript-engineer reached 12,341 chars this session — the
 * `head -c 500` snapshot only ever sees the OLDEST part of the profile, never
 * anything appended more recently. The duplicate check (`grep -qF "$note"`
 * against that truncated snippet) can therefore never detect a note that's
 * already present past character 500 — guaranteeing every profile long
 * enough to have this problem is permanently blind to its own duplicates.
 *
 * Live symptom: a genuinely self-contradictory note ("Do not use 'as' keyword
 * for type assertions... use explicit type casting with 'value as Type'...")
 * got persisted TWICE, verbatim, into typescript-engineer's profile during
 * SKY-003-impl's two retry rounds — the second submission was byte-identical
 * to the first, yet passed the deterministic format/dedup check both times.
 *
 * Fix: pass the FULL profile text (no truncation) to the dedup check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

describe('claude.sh — skill_note before-text call site (static)', () => {
  it('no longer truncates the existing profile text with head -c 500', () => {
    const idx = claudeSrc.indexOf('_skill_review_verdict=$(run_change_with_reviewer_retry');
    const block = claudeSrc.slice(idx, idx + 400);
    expect(block).not.toMatch(/head -c 500/);
  });

  it('still reads the profile role via jq -c', () => {
    // Moved earlier (2026-07-11) to feed a duplicate-check guard as well as
    // the reviewer call — search from the skill) case's start rather than
    // anchoring immediately before the reviewer-retry call site.
    const caseIdx = claudeSrc.indexOf('                skill)');
    const reviewerIdx = claudeSrc.indexOf('_skill_review_verdict=$(run_change_with_reviewer_retry', caseIdx);
    const block = claudeSrc.slice(caseIdx, reviewerIdx + 100);
    expect(block).toMatch(/jq -c --arg role "\$story_role" '\.\[\$role\] \/\/ ""'/);
  });
});

describe('skill_note dedup — REAL execution: reproduces the exact live defect and proves the fix', () => {
  function buildLongProfileWithDuplicateNote(): { dir: string; profilesFile: string; note: string } {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-dedup-'));
    const profilesFile = join(dir, 'profiles.json');
    // `note` is the raw candidate as submitted to _skill_note_format_ok — the
    // "[Self-Heal] " tag is only prepended when the note is actually WRITTEN
    // to the profile file (see the persist step in run_failure_analyst), not
    // before the format/dedup check runs on the candidate itself.
    const note =
      "Do not use 'as' keyword for type assertions in TypeScript when the type is not explicitly defined; use explicit type casting with 'value as Type' or '<Type>value' instead.";
    // Padding pushes the note well past the old 500-char truncation point,
    // matching the real typescript-engineer profile (12K+ chars) where the
    // note lives far past character 500.
    const padding = 'x'.repeat(600);
    const profileText = `Base profile instructions. ${padding}\n\n[Self-Heal] ${note}`;
    writeFileSync(profilesFile, JSON.stringify({ 'typescript-engineer': profileText }, null, 2));
    return { dir, profilesFile, note };
  }

  function formatCheckWithBefore(note: string, before: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-format-check-'));
    try {
      const fnBody = extractFunctionBody('_skill_note_format_ok');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\n_skill_note_format_ok "$1" "SKY-003-impl" "$2"\necho "RC=$?"\n`);
      const output = execFileSync('bash', [scriptPath, note, before], { encoding: 'utf8' });
      return output.includes('RC=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect: head -c 500 on a long profile hides an existing duplicate note', () => {
    const { dir, profilesFile, note } = buildLongProfileWithDuplicateNote();
    try {
      const truncatedBefore = execFileSync(
        'bash',
        ['-c', `jq -c --arg role "typescript-engineer" '.[$role] // ""' "${profilesFile}" | head -c 500`],
        { encoding: 'utf8' },
      );
      // Bug reproduced: the duplicate note is invisible in the truncated snippet,
      // so the format/dedup check incorrectly says "not a duplicate" (passes).
      const passedDespiteDuplicate = formatCheckWithBefore(note, truncatedBefore);
      expect(passedDespiteDuplicate).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FIX: passing the full (untruncated) profile text correctly detects the duplicate', () => {
    const { dir, profilesFile, note } = buildLongProfileWithDuplicateNote();
    try {
      const fullBefore = execFileSync(
        'bash',
        ['-c', `jq -c --arg role "typescript-engineer" '.[$role] // ""' "${profilesFile}"`],
        { encoding: 'utf8' },
      );
      const passedDespiteDuplicate = formatCheckWithBefore(note, fullBefore);
      // Fixed: duplicate is visible now, so the deterministic check correctly
      // fails (routing to the real LLM reviewer instead of silently re-persisting).
      expect(passedDespiteDuplicate).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuinely NEW note (not a duplicate) still passes with the full profile text', () => {
    const { dir, profilesFile } = buildLongProfileWithDuplicateNote();
    try {
      const fullBefore = execFileSync(
        'bash',
        ['-c', `jq -c --arg role "typescript-engineer" '.[$role] // ""' "${profilesFile}"`],
        { encoding: 'utf8' },
      );
      const newNote = 'Always declare explicit return types on exported async functions.';
      expect(formatCheckWithBefore(newNote, fullBefore)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
