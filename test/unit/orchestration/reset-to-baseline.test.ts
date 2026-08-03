/**
 * reset-to-baseline.sh — resets a project's git state to the last
 * known-good ("<id>: story complete") checkpoint.
 *
 * Root cause this fixes (found live, 2026-07-06): a faster validation loop
 * (invoking run-agent-orchestration.sh directly against an already-scaffolded
 * project, reusing completed stories' committed state instead of a full
 * teardown+rebuild) has no teardown of its own — unlike the full
 * tier3-travel-app-run.sh wrapper, which does a genuine `rm -rf` + fresh
 * `git init` before every run. Across several runs, every failed story
 * attempt's auto-committed leftover files (worktree-health-check.sh's
 * AUTO_COMMIT=true safety net) accumulated on master — a LATER run's "whole
 * test suite" external verification then failed for an EARLIER, otherwise-
 * passing story purely because a sibling story's stale broken test file was
 * still sitting in the tree. This script provides the missing teardown step
 * for that faster loop: reset to the last "<id>: story complete" commit, remove
 * leftover worktrees/branches, and clean untracked files — found dynamically
 * via `git log --grep`, never a hardcoded SHA or story ID.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/reset-to-baseline.sh');

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' });
}

function initRepoWithHistory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reset-baseline-test-'));
  git(dir, 'init --quiet');
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "Test"');
  writeFileSync(join(dir, 'README.md'), 'init');
  git(dir, 'add -A');
  git(dir, 'commit --quiet -m "init: project"');

  writeFileSync(join(dir, 'src.ts'), 'export const scaffold = 1;');
  git(dir, 'add -A');
  git(dir, 'commit --quiet -m "SKY-001: story complete (1 file(s))"');

  writeFileSync(join(dir, 'client.ts'), 'export class Client {}');
  git(dir, 'add -A');
  git(dir, 'commit --quiet -m "SKY-002: story complete (1 file(s))"');

  return dir;
}

describe('reset-to-baseline.sh — design', () => {
  it('exits 1 (not a git repo) when the target has no .git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-baseline-nogit-'));
    try {
      let exitCode = 0;
      try {
        execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
      } catch (e: any) {
        exitCode = e.status ?? 1;
      }
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when no "<id>: story complete" commit exists anywhere in history (nothing safe to reset to)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reset-baseline-nobaseline-'));
    try {
      git(dir, 'init --quiet');
      git(dir, 'config user.email "test@test.com"');
      git(dir, 'config user.name "Test"');
      writeFileSync(join(dir, 'README.md'), 'init');
      git(dir, 'add -A');
      git(dir, 'commit --quiet -m "init: project"');

      let exitCode = 0;
      let stderr = '';
      try {
        execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
      } catch (e: any) {
        exitCode = e.status ?? 1;
        stderr = e.stderr?.toString() ?? '';
      }
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/no '<id>: story complete' commit found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never hardcodes a story ID or SHA — finds the baseline dynamically via git log --grep', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/git log --grep='?\^?\[\^:\]\*: story complete /);
    expect(src).not.toMatch(/SKY-\d+/);
  });
});

describe('reset-to-baseline.sh — REAL execution against the exact live contamination scenario', () => {
  it('REPRODUCES the fix: resets past a contaminating auto-commit back to the last "<id>: story complete" checkpoint', () => {
    const dir = initRepoWithHistory();
    try {
      // Simulate a failed story's leftover, auto-committed broken file —
      // exactly what worktree-health-check.sh's AUTO_COMMIT=true produces.
      writeFileSync(join(dir, 'broken.ts'), 'this is not valid typescript {{{');
      git(dir, 'add -A');
      git(dir, 'commit --quiet -m "chore(wt-primary): auto-commit agent output for phase core"');
      git(dir, 'commit --quiet --allow-empty -m "merge: phase core primary lane (1 commits)"');

      expect(existsSync(join(dir, 'broken.ts'))).toBe(true);

      const output = execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      expect(existsSync(join(dir, 'broken.ts'))).toBe(false);
      expect(existsSync(join(dir, 'client.ts'))).toBe(true);
      const headSubject = git(dir, 'log -1 --format=%s').trim();
      expect(headSubject).toBe('SKY-002: story complete (1 file(s))');
      expect(output).toContain('SKY-002: story complete');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes leftover git worktrees and their branches before resetting', () => {
    const dir = initRepoWithHistory();
    try {
      const wtPath = `${dir}-wt-primary`;
      execSync(`git worktree add -b wt-primary "${wtPath}"`, { cwd: dir, encoding: 'utf8' });
      expect(existsSync(wtPath)).toBe(true);

      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      expect(existsSync(wtPath)).toBe(false);
      const branches = git(dir, 'branch --list');
      expect(branches).not.toContain('wt-primary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}-wt-primary`, { recursive: true, force: true });
    }
  });

  it('is idempotent — running it twice in a row on an already-clean repo does not error or change anything further', () => {
    const dir = initRepoWithHistory();
    try {
      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
      const firstHead = git(dir, 'log -1 --format=%H').trim();
      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
      const secondHead = git(dir, 'log -1 --format=%H').trim();
      expect(secondHead).toBe(firstHead);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans untracked files too, not just committed contamination', () => {
    const dir = initRepoWithHistory();
    try {
      writeFileSync(join(dir, 'untracked-leftover.log'), 'stale log noise');
      expect(existsSync(join(dir, 'untracked-leftover.log'))).toBe(true);

      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      expect(existsSync(join(dir, 'untracked-leftover.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses `git worktree remove --force` as the primary removal method (not a raw rm -rf that could leave admin metadata dangling)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/git worktree remove --force/);
  });

  it('REPRODUCES the exact live failure this prevents: after cleanup, a subsequent `git worktree add -b wt-primary` does NOT fail with "branch already exists"', () => {
    const dir = initRepoWithHistory();
    try {
      const wtPath = `${dir}-wt-primary`;
      execSync(`git worktree add -b wt-primary "${wtPath}"`, { cwd: dir, encoding: 'utf8' });

      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      // This is the exact command/error class hit live earlier the same
      // session when a worktree was torn down via raw `rm -rf` + manual
      // `git branch -D` instead of `git worktree remove`.
      expect(() => {
        execSync(`git worktree add -b wt-primary "${wtPath}"`, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}-wt-primary`, { recursive: true, force: true });
    }
  });

  it('verifies zero worktrees remain after cleanup and fails loudly (not silently) if any are still registered', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/remaining_worktrees=/);
    expect(src).toMatch(/FATAL — .*worktree\(s\) still registered/);
  });

  it('handles a worktree whose directory was already deleted out-of-band (rm -rf by a previous crash) without erroring — falls back to prune', () => {
    const dir = initRepoWithHistory();
    try {
      const wtPath = `${dir}-wt-primary`;
      execSync(`git worktree add -b wt-primary "${wtPath}"`, { cwd: dir, encoding: 'utf8' });
      // Simulate a crash that deleted the directory but left git's registry
      // pointing at it (git worktree remove --force would fail here since
      // the working directory is gone).
      rmSync(wtPath, { recursive: true, force: true });

      expect(() => {
        execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });
      }).not.toThrow();

      const branches = git(dir, 'branch --list');
      expect(branches).not.toContain('wt-primary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}-wt-primary`, { recursive: true, force: true });
    }
  });

  it('cleans up MULTIPLE leftover worktrees in one pass (primary AND independent lanes)', () => {
    const dir = initRepoWithHistory();
    try {
      const wtPrimary = `${dir}-wt-primary`;
      const wtIndependent = `${dir}-wt-independent`;
      execSync(`git worktree add -b wt-primary "${wtPrimary}"`, { cwd: dir, encoding: 'utf8' });
      execSync(`git worktree add -b wt-independent "${wtIndependent}"`, { cwd: dir, encoding: 'utf8' });

      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      expect(existsSync(wtPrimary)).toBe(false);
      expect(existsSync(wtIndependent)).toBe(false);
      const worktreeList = git(dir, 'worktree list');
      expect(worktreeList.trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}-wt-primary`, { recursive: true, force: true });
      rmSync(`${dir}-wt-independent`, { recursive: true, force: true });
    }
  });

  it('resets to the MOST RECENT "<id>: story complete" commit when multiple exist, not the first one', () => {
    const dir = initRepoWithHistory();
    try {
      writeFileSync(join(dir, 'contamination.ts'), 'broken');
      git(dir, 'add -A');
      git(dir, 'commit --quiet -m "chore(wt-primary): auto-commit agent output for phase core"');

      execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

      // Must land on SKY-002's commit (the latest "<id>: story complete"), not
      // SKY-001's (the first one git log --grep would find without -n 1
      // ordering by recency).
      const headSubject = git(dir, 'log -1 --format=%s').trim();
      expect(headSubject).toBe('SKY-002: story complete (1 file(s))');
      expect(existsSync(join(dir, 'client.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
