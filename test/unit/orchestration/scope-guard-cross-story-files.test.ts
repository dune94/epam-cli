/**
 * _scope_lock() / _scope_unlock() (claude.sh) — cross-story file protection.
 *
 * Root cause this fixes (found live, 2026-07-06): the original _scope_lock()
 * only ever chmod'd .ts files under src/ read-only. Root-level, non-.ts
 * scaffold artifacts (tsconfig.json, package.json, vitest.config.ts) were
 * completely unprotected against a LATER story rewriting them.
 *
 * Confirmed via git history: SKY-001's scaffold correctly wrote
 * `"moduleResolution": "node"` (a VALID pairing with `"module": "CommonJS"`).
 * SKY-002 — which never declared tsconfig.json in its own technicalNotes.files
 * and had no business touching it — rewrote it to `"moduleResolution": "node16"`
 * (an INVALID pairing) on its very first attempt, then regenerated the same
 * wrong value on every subsequent retry, exhausting the entire retry/
 * escalation ladder (8 attempts, 2 model tiers) on a self-inflicted
 * regression in a file outside its own declared scope — not a real defect in
 * SKY-002's own code.
 *
 * Fix: extend the lock to ALSO protect any file (any extension, any location)
 * declared by a DIFFERENT story's technicalNotes.files — generic, not
 * hardcoded to config-file names.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const lines = claudeSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    body.push(lines[i]);
    if (lines[i] === '}') return body.join('\n');
  }
  throw new Error(`Could not find end of function ${name}`);
}

function isWritable(path: string): boolean {
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o200) !== 0;
}

describe('_scope_lock() / _scope_unlock() — design (static)', () => {
  const lockBody = extractFunctionBody('_scope_lock');
  const unlockBody = extractFunctionBody('_scope_unlock');

  it('locks files declared by OTHER stories (select(.id != $id)), not just its own out-of-scope .ts files', () => {
    expect(lockBody).toMatch(/select\(\.id != \$id\)/);
  });

  it('is generic — no hardcoded config-file names (tsconfig.json, package.json, etc.)', () => {
    expect(lockBody).not.toMatch(/tsconfig\.json|package\.json|vitest\.config/);
  });

  it('_scope_unlock accepts a story_id parameter to restore other-story files it locked', () => {
    expect(unlockBody).toMatch(/local story_id="\$\{1:-\}"/);
    expect(unlockBody).toMatch(/select\(\.id != \$id\)/);
  });

  it('the call site passes $story_id to _scope_unlock (not called bare)', () => {
    const idx = claudeSrc.indexOf('_scope_unlock "$story_id"');
    expect(idx).toBeGreaterThan(-1);
  });
});

describe('_scope_lock() / _scope_unlock() — REAL execution, REPRODUCES the exact live tsconfig.json defect', () => {
  function runLockThenAttemptWrite(opts: {
    prdStories: Record<string, unknown>[];
    lockingStoryId: string;
    fileToWrite: string; // relative to project root
  }): { wasWritable: boolean; wasReadonlyAfterLock: boolean; writableAfterUnlock: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'scope-guard-test-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: opts.prdStories }));

      const targetPath = join(dir, opts.fileToWrite);
      mkdirSync(join(targetPath, '..'), { recursive: true });
      writeFileSync(targetPath, 'original content');

      const wasWritable = isWritable(targetPath);

      const lockFnBody = extractFunctionBody('_scope_lock');
      const unlockFnBody = extractFunctionBody('_scope_unlock');
      const scriptPath = join(dir, 'lock.sh');
      writeFileSync(
        scriptPath,
        [
          `PRD_FILE="${prdPath}"`,
          `PROJECT_ROOT="${dir}"`,
          `log() { :; }`,
          lockFnBody,
          unlockFnBody,
          `_scope_lock "${opts.lockingStoryId}"`,
          `echo "LOCKED"`,
        ].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const wasReadonlyAfterLock = !isWritable(targetPath);

      const unlockScriptPath = join(dir, 'unlock.sh');
      writeFileSync(
        unlockScriptPath,
        [
          `PRD_FILE="${prdPath}"`,
          `PROJECT_ROOT="${dir}"`,
          unlockFnBody,
          `_scope_unlock "${opts.lockingStoryId}"`,
        ].join('\n'),
      );
      execFileSync('bash', [unlockScriptPath], { encoding: 'utf8' });
      const writableAfterUnlock = isWritable(targetPath);

      return { wasWritable, wasReadonlyAfterLock, writableAfterUnlock };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the fix: tsconfig.json (owned by SKY-001, not declared by SKY-002) becomes read-only while SKY-002 runs, and writable again after unlock', () => {
    const result = runLockThenAttemptWrite({
      prdStories: [
        { id: 'SKY-001', technicalNotes: { files: ['tsconfig.json', 'package.json'] } },
        { id: 'SKY-002', technicalNotes: { files: ['src/client.ts'] } },
      ],
      lockingStoryId: 'SKY-002',
      fileToWrite: 'tsconfig.json',
    });
    expect(result.wasWritable).toBe(true);
    expect(result.wasReadonlyAfterLock).toBe(true);
    expect(result.writableAfterUnlock).toBe(true);
  });

  it('does NOT lock a file that IS declared by the CURRENT story (a story must be able to write its own files)', () => {
    // technicalNotes.files always stores ABSOLUTE paths in the real PRD
    // (confirmed convention, see WORKTREE_MODE rewrite logic elsewhere in
    // claude.sh) — the lock function's own .ts-under-src loop compares
    // against `find`'s absolute output, so the fixture must match that
    // shape, not a relative path.
    const dir = mkdtempSync(join(tmpdir(), 'scope-guard-ownfile-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'tsconfig.json'), 'original');
      writeFileSync(join(dir, 'src', 'client.ts'), 'original');

      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [
            { id: 'SKY-001', technicalNotes: { files: [join(dir, 'tsconfig.json')] } },
            { id: 'SKY-002', technicalNotes: { files: [join(dir, 'src', 'client.ts')] } },
          ],
        }),
      );

      const lockFnBody = extractFunctionBody('_scope_lock');
      const scriptPath = join(dir, 'lock.sh');
      writeFileSync(
        scriptPath,
        [`PRD_FILE="${prdPath}"`, `PROJECT_ROOT="${dir}"`, `log() { :; }`, lockFnBody, `_scope_lock "SKY-002"`].join('\n'),
      );
      execFileSync('bash', [scriptPath], { encoding: 'utf8' });

      expect(isWritable(join(dir, 'src', 'client.ts'))).toBe(true);
      expect(isWritable(join(dir, 'tsconfig.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('protects root-level config files with ANY name/extension, not just a hardcoded list (domain-agnostic proof: a .env.production file owned by another story)', () => {
    const result = runLockThenAttemptWrite({
      prdStories: [
        { id: 'INFRA-001', technicalNotes: { files: ['.env.production', 'docker-compose.yml'] } },
        { id: 'APP-002', technicalNotes: { files: ['src/app.ts'] } },
      ],
      lockingStoryId: 'APP-002',
      fileToWrite: '.env.production',
    });
    expect(result.wasReadonlyAfterLock).toBe(true);
  });

  it('does not error when a declared file from another story does not exist yet on disk (not-yet-implemented dependency)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-guard-missing-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const prdPath = join(dir, 'prd.json');
      writeFileSync(
        prdPath,
        JSON.stringify({
          stories: [
            { id: 'SKY-003', technicalNotes: { files: ['src/not-yet-built.ts'] } },
            { id: 'SKY-002', technicalNotes: { files: ['src/client.ts'] } },
          ],
        }),
      );
      writeFileSync(join(dir, 'src', 'client.ts'), 'content');

      const lockFnBody = extractFunctionBody('_scope_lock');
      const scriptPath = join(dir, 'lock.sh');
      writeFileSync(
        scriptPath,
        [`PRD_FILE="${prdPath}"`, `PROJECT_ROOT="${dir}"`, `log() { :; }`, lockFnBody, `_scope_lock "SKY-002"`, `echo "DONE"`].join('\n'),
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      expect(output).toContain('DONE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
