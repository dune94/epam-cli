/**
 * Persisted [Self-Heal] skill notes, injected DIRECTLY into
 * build_implementation_prompt()'s output — REAL execution of the actual,
 * unmodified bash block, extracted by marker (not re-implemented).
 *
 * ESCAPED DEFECT (found live, 2026-08-02, AMSD-2041 Writer Retest relaunch):
 * profiles.json's [Self-Heal] notes — both FailureAnalyst's tsc/test-failure
 * diagnoses AND Step 3.6's review-rejection lessons
 * (_persist_skill_note_simple(), lib/story-guards.sh) — were being WRITTEN
 * correctly, but grepping every consumer of profiles.json role text in
 * claude.sh found exactly zero that fed it into the actual coding-agent
 * prompt (build_implementation_prompt()). The only consumers were: the
 * REVIEWER's own persona, FailureAnalyst's own diagnostic context (a
 * DIFFERENT prompt), and duplicate-check gates before appending a new note.
 * A brand-new run's first attempt at a story never saw what a PRIOR run had
 * already learned about it.
 *
 * Real proof this was live, not theoretical: upexpress's writer reproduced
 * the IDENTICAL dead-code live_preview-forwarding defect on a fresh relaunch
 * despite two prior review rejections and a correctly persisted,
 * file/line-precise note in profiles.json's typescript-engineer entry.
 *
 * Fix: read the story's agentRole's [Self-Heal] lines from
 * $AGENT_PROFILES_FILE and inject them into the prompt, same pattern as the
 * existing codeline-facts injection (see
 * codeline-facts-prompt-injection.test.ts) and review_feedback injection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractBlock(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

const SKILL_NOTE_BLOCK = extractBlock(
  '    # Persisted skill notes (cross-run learning',
  '\n    # testCriteria — written by TC writer',
);

// The final heredoc's own conditional injection line, so this test tracks
// the REAL wiring (not just that the variable gets computed) — verified
// present, not re-executed (the full heredoc has too many other
// dependencies to run standalone).
it('the final prompt heredoc actually injects $skill_note_block', () => {
  expect(src).toMatch(/\$\(\[ -n "\$skill_note_block" \] && printf '%s\\n' "\$skill_note_block" \|\| true\)/);
});

it('is injected AFTER review_feedback and BEFORE verification_criteria in the heredoc (same-run feedback still takes priority position)', () => {
  const reviewIdx = src.indexOf('## Reviewer Feedback — ADDRESS THESE');
  const skillIdx = src.indexOf('$([ -n "$skill_note_block" ]');
  const vcIdx = src.indexOf('## Verification Criteria (what a tester will CONFIRM');
  expect(reviewIdx).toBeGreaterThan(-1);
  expect(skillIdx).toBeGreaterThan(reviewIdx);
  expect(vcIdx).toBeGreaterThan(skillIdx);
});

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runSkillNoteBlock(profilesFile: string, storyJson: object): string {
  const script = `
run_extracted() {
  local AGENT_PROFILES_FILE='${profilesFile}'
  local story_json='${JSON.stringify(storyJson).replace(/'/g, "'\\''")}'
${SKILL_NOTE_BLOCK}
  echo "$skill_note_block"
}
run_extracted
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

function makeProfilesFile(dir: string, contents: Record<string, string>): string {
  const p = join(dir, 'profiles.json');
  writeFileSync(p, JSON.stringify(contents, null, 2));
  return p;
}

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'skill-note-prompt-'));
  cleanupDirs.push(d);
  return d;
}

describe('skill-note prompt injection — real extracted bash', () => {
  it('injects the real persisted [Self-Heal] note as a "## Lessons From Prior Runs" section', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, {
      'typescript-engineer':
        'base persona text\n\n[Self-Heal] live_preview must be forwarded through getEntry and every other public query function',
    });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out).toContain('## Lessons From Prior Runs');
    expect(out).toContain('live_preview must be forwarded through getEntry');
  });

  it('REPRODUCES the real upexpress lesson that should have prevented the live regression', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, {
      'typescript-engineer':
        'base persona\n\n[Self-Heal] Review REPEATEDLY rejected AMSD-2041 (unresolved after 2 cycles) for:\n- AC#3 NOT MET — live_preview is dead code. setCommonConfig destructures live_preview but NONE of the public functions (getEntry, getSingleEntry, getAllContentTypeEntries) forward it to createContentTypeQuery.',
    });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out).toContain('AC#3 NOT MET');
    expect(out).toContain('getEntry, getSingleEntry, getAllContentTypeEntries');
  });

  it('only includes [Self-Heal] lines, not the rest of the role persona text', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, {
      'typescript-engineer': 'You are a TypeScript engineer. Write clean code.\n\n[Self-Heal] the actual lesson',
    });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out).toContain('the actual lesson');
    expect(out).not.toContain('Write clean code');
  });

  it('produces no block when the role has no [Self-Heal] notes yet', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, { 'typescript-engineer': 'just a base persona, no notes' });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out.trim()).toBe('');
  });

  it('produces no block when the story has no agentRole', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, { 'typescript-engineer': '[Self-Heal] some note' });
    const out = runSkillNoteBlock(profiles, {});
    expect(out.trim()).toBe('');
  });

  it('produces no block when AGENT_PROFILES_FILE does not exist', () => {
    const dir = makeDir();
    const out = runSkillNoteBlock(join(dir, 'does-not-exist.json'), { agentRole: 'typescript-engineer' });
    expect(out.trim()).toBe('');
  });

  it('produces no block when the story\'s agentRole has no entry in profiles.json', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, { 'other-role': '[Self-Heal] unrelated note' });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out.trim()).toBe('');
  });

  it('includes multiple accumulated [Self-Heal] notes for the same role', () => {
    const dir = makeDir();
    const profiles = makeProfilesFile(dir, {
      'typescript-engineer': 'base\n\n[Self-Heal] first lesson\n\n[Self-Heal] second lesson',
    });
    const out = runSkillNoteBlock(profiles, { agentRole: 'typescript-engineer' });
    expect(out).toContain('first lesson');
    expect(out).toContain('second lesson');
  });
});
