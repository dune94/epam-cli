/**
 * _selective_worktree_reset — added 2026-08-01 (backlog #107, reconciled
 * with #112's work-carryover). Rung escalations previously had zero git
 * checkout/reset/clean between them — a failed rung's half-applied edits,
 * broken partial writes, or any other incidental corruption sat on disk and
 * the next (usually stronger, costlier) model silently inherited it.
 *
 * DESIGN NOTE (why this isn't a declared-files preserve-list): an earlier
 * version restricted preservation to the story's declared technicalNotes.files
 * — rejected because a half-broken write and a genuinely correct but
 * UNDECLARED file are both indistinguishable "has a diff from baseline";
 * that design risked silently destroying real work outside the declared set.
 * "Preserve anything with a diff" was considered next and also rejected — a
 * broken file also has a diff, so that rule makes the reset a no-op.
 *
 * What ships instead: LAST_ATTEMPT_TSC_PASSED (set by claude.sh right after
 * run_tsc_verification) is real, already-computed evidence the WHOLE tree is
 * at least type/syntax-correct. Pass -> preserve everything wholesale,
 * declared or not. Fail (or tsc never ran) -> no positive evidence anything
 * is good -> full reset to baseline.
 *
 * Real git repos throughout (bare "origin" + working clone), no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

const FN_BODY = extractFunctionBody('_selective_worktree_reset');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bare "origin" + a working clone, with one pre-existing tracked file. */
function makeFixture(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'worktree-reset-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, 'src/tracked.ts'), 'export const original = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  return { clone };
}

function runReset(projectRoot: string, tscPassed: boolean, opts: { brownfield?: boolean } = {}): string {
  const scriptPath = join(projectRoot, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `EPAM_BROWNFIELD=${opts.brownfield === false ? '0' : '1'}`,
      'JIRA_BASELINE_BRANCH=develop',
      'log() { echo "LOG: $*" >&2; }',
      `LAST_ATTEMPT_TSC_PASSED=${tscPassed}`,
      `LAST_VERIFIED_TOUCHED_FILES="src/tracked.ts"`,
      `LAST_VERIFIED_UNCHANGED_FILES=""`,
      FN_BODY,
      '_selective_worktree_reset "SKY-TEST"',
      'echo "TOUCHED_AFTER=[$LAST_VERIFIED_TOUCHED_FILES]"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return (result.stdout || '') + (result.stderr || '');
}

describe('_selective_worktree_reset — tsc-validated preservation', () => {
  it('preserves EVERYTHING (including undeclared files) when the last attempt tsc-passed', () => {
    const { clone } = makeFixture();
    writeFileSync(join(clone, 'src/tracked.ts'), 'export const original = 1;\nexport const realFix = true;\n');
    mkdirSync(join(clone, 'src/new'), { recursive: true });
    writeFileSync(join(clone, 'src/new/undeclared-but-real.ts'), 'export const undeclaredRealWork = true;\n');
    runReset(clone, true);
    expect(readFileSync(join(clone, 'src/tracked.ts'), 'utf-8')).toContain('realFix');
    expect(existsSync(join(clone, 'src/new/undeclared-but-real.ts'))).toBe(true);
    expect(readFileSync(join(clone, 'src/new/undeclared-but-real.ts'), 'utf-8')).toContain('undeclaredRealWork');
  });

  it('fully resets to baseline (tracked files) when tsc did NOT pass — no positive evidence anything is good', () => {
    const { clone } = makeFixture();
    writeFileSync(join(clone, 'src/tracked.ts'), 'export const original = 1;\nexport const brokenHalfWrite = ');
    runReset(clone, false);
    expect(readFileSync(join(clone, 'src/tracked.ts'), 'utf-8')).toBe('export const original = 1;\n');
  });

  it('removes untracked files too when tsc did NOT pass', () => {
    const { clone } = makeFixture();
    writeFileSync(join(clone, 'src/stray-corruption.ts'), 'garbage from a broken write');
    runReset(clone, false);
    expect(existsSync(join(clone, 'src/stray-corruption.ts'))).toBe(false);
  });

  it('clears LAST_VERIFIED_TOUCHED_FILES/UNCHANGED_FILES on a real reset, so the next prompt note does not claim erased work is "already done"', () => {
    const { clone } = makeFixture();
    writeFileSync(join(clone, 'src/tracked.ts'), 'export const original = 1;\nexport const brokenHalfWrite = ');
    const out = runReset(clone, false);
    expect(out).toContain('TOUCHED_AFTER=[]');
  });

  it('does NOT clear LAST_VERIFIED_TOUCHED_FILES when tsc passed (nothing was reset)', () => {
    const { clone } = makeFixture();
    const out = runReset(clone, true);
    expect(out).toContain('TOUCHED_AFTER=[src/tracked.ts]');
  });

  it('is a no-op when EPAM_BROWNFIELD is not set (greenfield)', () => {
    const { clone } = makeFixture();
    writeFileSync(join(clone, 'src/tracked.ts'), 'export const original = 1;\nexport const shouldSurvive = true;\n');
    runReset(clone, false, { brownfield: false });
    expect(readFileSync(join(clone, 'src/tracked.ts'), 'utf-8')).toContain('shouldSurvive');
  });

  it('is a safe no-op when the project has no git repo at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-reset-nogit-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/f.ts'), 'content\n');
    runReset(dir, false);
    expect(readFileSync(join(dir, 'src/f.ts'), 'utf-8')).toBe('content\n');
  });

  it('is a safe no-op when the baseline branch ref cannot be resolved (no origin)', () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-reset-noorigin-'));
    cleanupDirs.push(root);
    execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/f.ts'), 'content\nno-origin-should-survive\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: root });
    runReset(root, false);
    expect(readFileSync(join(root, 'src/f.ts'), 'utf-8')).toContain('no-origin-should-survive');
  });
});
