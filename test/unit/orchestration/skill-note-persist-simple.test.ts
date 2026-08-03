/**
 * _persist_skill_note_simple() — lib/story-guards.sh
 *
 * Root cause this closes (found live, 2026-08-02): a story that repeatedly
 * fails REVIEW for the same reason (e.g. AMSD-2041's upexpress live_preview
 * gap) had no mechanism to persist that lesson for the writer across runs —
 * only FailureAnalyst's tsc/test-failure diagnoses fed the skill-note
 * pipeline (via claude.sh's heavier run_change_with_reviewer_retry). This is
 * the lightweight sibling used by run-agent-orchestration.sh's Step 3.6
 * review-rejection path, which has no access to that LLM-review machinery.
 *
 * Real temp files, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const STORY_GUARDS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const storyGuardsSrc = readFileSync(STORY_GUARDS_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(storyGuardsSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = storyGuardsSrc.indexOf('\n}', start) + 2;
  return storyGuardsSrc.slice(start, end);
}
// _persist_skill_note_simple calls _text_violates_anti_pattern internally —
// both must be present in the sourced script for a real (non-mocked) run.
const TEXT_GATE_FN = extractFunctionBody('_text_violates_anti_pattern');
const PERSIST_FN = extractFunctionBody('_persist_skill_note_simple');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANAGEMENT_TOKEN_RULES = JSON.stringify([
  {
    id: 'contentstack-live-preview-wrong-token-key',
    textMatchPattern:
      '(?is)(live_preview|LivePreview)[\\s\\S]{0,120}management_token|management_token[\\s\\S]{0,120}(live_preview|LivePreview)',
    message: 'Contentstack live_preview must use preview_token, not management_token — the type declaration is stale.',
  },
]);

function runPersist(opts: {
  profilesFile: string | null;
  role: string;
  text: string;
  configDir?: string | null;
}): { rc: number; output: string; profiles: Record<string, string> | null } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-'));
  cleanupDirs.push(dir);
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      opts.configDir ? `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(opts.configDir)}` : '',
      'log() { echo "LOG: $*" >&2; }',
      'warning() { echo "WARN: $*" >&2; }',
      'error() { echo "ERROR: $*" >&2; }',
      TEXT_GATE_FN,
      PERSIST_FN,
      `_persist_skill_note_simple ${JSON.stringify(opts.profilesFile ?? '')} ${JSON.stringify(opts.role)} "$RAW_TEXT"`,
      'echo "RC=$?"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, RAW_TEXT: opts.text },
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const rc = parseInt(output.match(/RC=(\d+)/)?.[1] ?? '-1', 10);
  let profiles: Record<string, string> | null = null;
  if (opts.profilesFile) {
    try {
      profiles = JSON.parse(readFileSync(opts.profilesFile, 'utf8'));
    } catch {
      profiles = null;
    }
  }
  return { rc, output, profiles };
}

function makeProfilesFile(dir: string, contents: Record<string, string>): string {
  const p = join(dir, 'profiles.json');
  writeFileSync(p, JSON.stringify(contents, null, 2));
  return p;
}

describe('_persist_skill_note_simple — no-op guards', () => {
  it('returns 0 and does nothing when the profiles file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const missing = join(dir, 'does-not-exist.json');
    const { rc } = runPersist({ profilesFile: missing, role: 'writer', text: 'some lesson' });
    expect(rc).toBe(0);
  });

  it('returns 0 and does nothing when the raw text is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const profilesFile = makeProfilesFile(dir, { writer: 'base prompt' });
    const { rc, profiles } = runPersist({ profilesFile, role: 'writer', text: '' });
    expect(rc).toBe(0);
    expect(profiles!.writer).toBe('base prompt');
  });
});

describe('_persist_skill_note_simple — anti-pattern gate refusal', () => {
  it('refuses to persist a note that contradicts a known anti-pattern, and does not modify the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'anti-patterns.json'), MANAGEMENT_TOKEN_RULES);
    const profilesFile = makeProfilesFile(dir, { writer: 'base prompt' });
    const { rc, output, profiles } = runPersist({
      profilesFile,
      role: 'writer',
      text: 'Review rejected AMSD-2041 for: live_preview must set management_token per the SDK type',
      configDir: dir,
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/Refusing to persist.*contradicts a known anti-pattern/);
    expect(profiles!.writer).toBe('base prompt');
  });
});

describe('_persist_skill_note_simple — exact-duplicate skip', () => {
  it('does not append when the exact text already exists in the role profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const profilesFile = makeProfilesFile(dir, {
      writer: 'base prompt\n\n[Self-Heal] live_preview must be forwarded through getEntry',
    });
    const { rc, output, profiles } = runPersist({
      profilesFile,
      role: 'writer',
      text: 'live_preview must be forwarded through getEntry',
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/Exact duplicate already present/);
    expect(profiles!.writer).toBe('base prompt\n\n[Self-Heal] live_preview must be forwarded through getEntry');
  });
});

describe('_persist_skill_note_simple — successful persist', () => {
  it('appends a new [Self-Heal] note to the role profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const profilesFile = makeProfilesFile(dir, { writer: 'base prompt' });
    const { rc, output, profiles } = runPersist({
      profilesFile,
      role: 'writer',
      text: 'live_preview must be forwarded through public query functions like getEntry',
    });
    expect(rc).toBe(0);
    expect(output).toMatch(/Skill note appended to \[writer\] profile/);
    expect(profiles!.writer).toBe(
      'base prompt\n\n[Self-Heal] live_preview must be forwarded through public query functions like getEntry',
    );
  });

  it('appends to an initially-empty role profile with no leading separator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const profilesFile = makeProfilesFile(dir, { writer: '' });
    const { rc, profiles } = runPersist({ profilesFile, role: 'writer', text: 'first ever note' });
    expect(rc).toBe(0);
    expect(profiles!.writer).toBe('[Self-Heal] first ever note');
  });

  it('does NOT persist when the role does not exist in profiles.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-note-persist-cfg-'));
    cleanupDirs.push(dir);
    const profilesFile = makeProfilesFile(dir, { writer: 'base prompt' });
    const { rc, output, profiles } = runPersist({ profilesFile, role: 'no-such-role', text: 'a note' });
    expect(rc).toBe(0);
    expect(output).toMatch(/Profile role \[no-such-role\] not found.*NOT persisted/);
    expect(profiles).toEqual({ writer: 'base prompt' });
  });
});
