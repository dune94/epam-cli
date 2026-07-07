/**
 * setup_worktrees() / cleanup_worktrees() (claude.sh) — previously had ZERO
 * test coverage despite being the most safety-critical worktree code in the
 * pipeline (the functions that actually create/destroy the git worktrees
 * every parallel-lane story runs in).
 *
 * Found live, 2026-07-06, while building reset-to-baseline.sh's teardown
 * fix: both functions had real, previously-undiscovered bugs of the exact
 * same class ("worktrees can never cause issues" — user directive):
 *
 * 1. setup_worktrees() treated DIRECTORY EXISTENCE at the worktree path as
 *    sufficient proof of a usable worktree. A stale, non-git-tracked
 *    directory (from a prior crash, or a raw `rm -rf` instead of
 *    `git worktree remove`) would be silently skipped — the caller believed
 *    a worktree was set up when it wasn't actually usable.
 * 2. cleanup_worktrees() removed the worktree CHECKOUT via `git worktree
 *    remove` but never deleted the underlying `wt-primary`/`wt-independent`
 *    BRANCH, and had no fallback if `git worktree remove` itself failed —
 *    either could leave a leftover branch ref colliding with the next
 *    `git worktree add -b wt-primary`, reproducing the exact
 *    "fatal: a branch named 'wt-primary' already exists" live failure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
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

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' });
}

function initBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-setup-test-'));
  git(dir, 'init --quiet');
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "Test"');
  writeFileSync(join(dir, 'README.md'), 'init');
  git(dir, 'add -A');
  git(dir, 'commit --quiet -m "init"');
  return dir;
}

function stubLogFns(): string {
  // Minimal stand-ins for the logging helpers claude.sh defines elsewhere —
  // these functions are extracted and run standalone, without the rest of
  // claude.sh sourced, so they need stubs to avoid "command not found". All
  // print to STDOUT (not stderr) so tests can assert on captured output
  // without needing to separately merge streams.
  return `log() { echo "LOG: $*"; }\ninfo() { echo "INFO: $*"; }\nwarning() { echo "WARN: $*"; }\nerror() { echo "ERROR: $*"; }\nsuccess() { echo "OK: $*"; }\n`;
}

describe('setup_worktrees() — design (static)', () => {
  const body = extractFunctionBody('setup_worktrees');

  it('verifies directory existence is a REAL, registered git worktree before skipping creation (not just that a directory exists)', () => {
    expect(body).toMatch(/worktree list --porcelain.*grep -q "\^worktree/);
  });

  it('removes a stale non-worktree directory before recreating, rather than leaving it in place', () => {
    const idx = body.indexOf('Stale non-worktree directory found');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 150);
    expect(block).toMatch(/rm -rf "\$wt_path"/);
  });
});

describe('cleanup_worktrees() — design (static)', () => {
  const body = extractFunctionBody('cleanup_worktrees');

  it('deletes the wt-* branch after removing the worktree checkout (not just the checkout)', () => {
    expect(body).toMatch(/branch -D "\$wt_branch"/);
  });

  it('falls back to manual rm -rf if `git worktree remove` fails', () => {
    const idx = body.indexOf('git worktree remove failed');
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 150);
    expect(block).toMatch(/rm -rf "\$wt_path"/);
  });

  it('verifies zero wt-* worktrees remain after cleanup and fails loudly if any are still registered', () => {
    expect(body).toMatch(/remaining=/);
    expect(body).toMatch(/Worktree cleanup incomplete/);
  });
});

describe('setup_worktrees() — REAL execution', () => {
  function runSetup(dir: string): { rc: number; output: string } {
    const scriptPath = join(dir, 'run.sh');
    const fnBody = extractFunctionBody('setup_worktrees');
    writeFileSync(
      scriptPath,
      `${stubLogFns()}GIT_WORK_ROOT="${dir}"\n${fnBody}\nsetup_worktrees\necho "RC=$?"\n`,
    );
    let output = '';
    let rc = 0;
    try {
      output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
      rc = e.status ?? 1;
    }
    const match = output.match(/RC=(\d+)/);
    if (match) rc = parseInt(match[1], 10);
    return { rc, output };
  }

  it('creates both primary and independent worktrees on a clean repo', () => {
    const dir = initBareRepo();
    try {
      const { rc } = runSetup(dir);
      expect(rc).toBe(0);
      const basename = dir.split('/').pop();
      expect(existsSync(join(dir, '..', `${basename}-wt-primary`))).toBe(true);
      expect(existsSync(join(dir, '..', `${basename}-wt-independent`))).toBe(true);
    } finally {
      const basename = dir.split('/').pop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(dir, '..', `${basename}-wt-primary`), { recursive: true, force: true });
      rmSync(join(dir, '..', `${basename}-wt-independent`), { recursive: true, force: true });
    }
  });

  it('REPRODUCES the fix: a stale non-worktree directory at the worktree path is removed and replaced with a real worktree, not silently skipped', () => {
    const dir = initBareRepo();
    const basename = dir.split('/').pop();
    const wtPath = join(dir, '..', `${basename}-wt-primary`);
    try {
      // Simulate a crash leftover: a plain directory with a marker file,
      // NOT a registered git worktree.
      execSync(`mkdir -p "${wtPath}" && echo "stale junk" > "${wtPath}/junk.txt"`);

      const { rc, output } = runSetup(dir);

      expect(rc).toBe(0);
      expect(output).toContain('Stale non-worktree directory found');
      expect(existsSync(join(wtPath, 'junk.txt'))).toBe(false);
      // Must now be a REAL, registered worktree.
      const wtList = git(dir, 'worktree list --porcelain');
      expect(wtList).toContain(`worktree ${wtPath}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(wtPath, { recursive: true, force: true });
      rmSync(join(dir, '..', `${basename}-wt-independent`), { recursive: true, force: true });
    }
  });

  it('does not recreate an already-valid worktree (idempotent on a clean re-run)', () => {
    const dir = initBareRepo();
    const basename = dir.split('/').pop();
    try {
      runSetup(dir);
      const { rc, output } = runSetup(dir);
      expect(rc).toBe(0);
      expect(output).toContain('already exists and is valid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(dir, '..', `${basename}-wt-primary`), { recursive: true, force: true });
      rmSync(join(dir, '..', `${basename}-wt-independent`), { recursive: true, force: true });
    }
  });
});

describe('cleanup_worktrees() — REAL execution', () => {
  function runCleanup(dir: string): { rc: number; output: string } {
    const scriptPath = join(dir, 'cleanup.sh');
    const fnBody = extractFunctionBody('cleanup_worktrees');
    writeFileSync(
      scriptPath,
      `${stubLogFns()}GIT_WORK_ROOT="${dir}"\n${fnBody}\ncleanup_worktrees\necho "RC=$?"\n`,
    );
    let output = '';
    let rc = 0;
    try {
      output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
      rc = e.status ?? 1;
    }
    const match = output.match(/RC=(\d+)/);
    if (match) rc = parseInt(match[1], 10);
    return { rc, output };
  }

  it('REPRODUCES the fix: removes both the worktree checkout AND its branch, so a subsequent setup_worktrees() never hits "branch already exists"', () => {
    const dir = initBareRepo();
    const basename = dir.split('/').pop();
    const wtPath = join(dir, '..', `${basename}-wt-primary`);
    try {
      git(dir, `worktree add -b wt-primary "${wtPath}"`);

      const { rc } = runCleanup(dir);
      expect(rc).toBe(0);

      expect(existsSync(wtPath)).toBe(false);
      const branches = git(dir, 'branch --list');
      expect(branches).not.toContain('wt-primary');

      // The actual live regression: this must succeed cleanly afterward.
      expect(() => {
        execSync(`git worktree add -b wt-primary "${wtPath}"`, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(wtPath, { recursive: true, force: true });
    }
  });

  it('is a no-op (rc 0) when no worktrees exist at all', () => {
    const dir = initBareRepo();
    try {
      const { rc, output } = runCleanup(dir);
      expect(rc).toBe(0);
      expect(output).toContain('already removed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to manual removal when the worktree directory was already deleted out-of-band', () => {
    const dir = initBareRepo();
    const basename = dir.split('/').pop();
    const wtPath = join(dir, '..', `${basename}-wt-primary`);
    try {
      git(dir, `worktree add -b wt-primary "${wtPath}"`);
      rmSync(wtPath, { recursive: true, force: true }); // simulate a crash

      const { rc } = runCleanup(dir);
      expect(rc).toBe(0);
      const branches = git(dir, 'branch --list');
      expect(branches).not.toContain('wt-primary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(wtPath, { recursive: true, force: true });
    }
  });
});
