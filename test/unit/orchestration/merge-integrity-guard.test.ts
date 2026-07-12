/**
 * Flow-gap analysis finding #1 (2026-07-12): Step 3.2 in
 * run-agent-orchestration.sh merges each worktree lane back with
 * `git merge --no-ff -X ours "$_wt_branch"`. `-X ours` silently resolves any
 * GENUINELY CONFLICTING hunk in favor of the pre-existing main-branch
 * content, discarding the worktree lane's competing changes -- with no
 * error, no warning, no artifact, and (confirmed empirically) no
 * "CONFLICT" text anywhere in git's own output; `git merge` with -X ours
 * exits 0 and prints only "Auto-merging <file>" / "Merge made by the 'ort'
 * strategy." even when it just discarded real content.
 *
 * Every downstream check in this pipeline (build gate, lint gate, Team Lead
 * Review, SAST/review-ranger/mutant-hunter) operates on a diff or state
 * computed from the POST-merge result. If -X ours silently dropped a hunk,
 * that content was never part of the diff those checks see -- there is
 * structurally nothing for any of them to flag. This is invisible-by-
 * construction to the entire review/gate stack, not an oversight in one
 * check among several.
 *
 * Fix: before the real merge, run `git merge-tree --write-tree --name-only`
 * (available git >= 2.38) -- a side-effect-free dry run that computes the
 * same merge without touching the working tree or creating a commit, and
 * exits non-zero with the conflicting file list when a real conflict would
 * occur. If it would, refuse to silently auto-resolve: record an audit
 * artifact, log the conflicting files, and set MERGE_FAILED=true (the same
 * "preserve worktrees for inspection, exit 1" path already used for an
 * outright merge failure) instead of proceeding with `-X ours`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractStep32Block(): string {
  const startMarker = '# Step 3.2: Merge worktree branches back to main branch';
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error('Step 3.2 marker not found');
  const endMarker = 'info "Step 3.2: No worktrees — skipping merge-back"';
  const endMarkerIdx = orchSrc.indexOf(endMarker, start);
  if (endMarkerIdx === -1) throw new Error('Step 3.2 end marker not found');
  const end = orchSrc.indexOf('\n', endMarkerIdx) + 1;
  // include the closing "fi" line right after the end marker's else-branch
  const fiIdx = orchSrc.indexOf('\nfi', end);
  return orchSrc.slice(start, fiIdx + 3);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function setupConflictingRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'wt-primary');
  writeFileSync(join(dir, 'f.txt'), 'worktree-change\n');
  git(dir, 'commit', '-qam', 'worktree change');
  git(dir, 'checkout', '-q', 'master');
  writeFileSync(join(dir, 'f.txt'), 'main-change\n');
  git(dir, 'commit', '-qam', 'main change');
}

function setupNonConflictingRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', 'base.txt');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'wt-primary');
  writeFileSync(join(dir, 'primary-only.txt'), 'primary content\n');
  git(dir, 'add', 'primary-only.txt');
  git(dir, 'commit', '-qm', 'worktree change (different file)');
  git(dir, 'checkout', '-q', 'master');
}

function runStep32(projectRoot: string, phase = 'test-phase'): { rc: number; output: string } {
  const scriptDir = mkdtempSync(join(tmpdir(), 'step32-scriptdir-'));
  try {
    // Stub update-monitor.sh -- Step 3.2 calls it as a fire-and-forget event
    // sink; not the thing under test here.
    writeFileSync(join(scriptDir, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const block = extractStep32Block();
    const runnerPath = join(scriptDir, 'run.sh');
    writeFileSync(
      runnerPath,
      [
        '#!/usr/bin/env bash',
        `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
        `SCRIPT_DIR=${JSON.stringify(scriptDir)}`,
        `PHASE=${JSON.stringify(phase)}`,
        'need_worktrees=true',
        'primary_stories="SKY-DUMMY"',
        'independent_stories=""',
        'log() { echo "LOG: $*"; }',
        'error() { echo "ERROR: $*"; }',
        'success() { echo "SUCCESS: $*"; }',
        'info() { echo "INFO: $*"; }',
        'warning() { echo "WARN: $*"; }',
        block,
        'echo "RC=$?"',
      ].join('\n'),
    );
    let output = '';
    let rc = -1;
    try {
      output = execFileSync('bash', [runnerPath], { encoding: 'utf8' });
      rc = 0;
    } catch (e: any) {
      output = ((e.stdout ?? '').toString()) + ((e.stderr ?? '').toString());
      rc = e.status ?? -1;
    }
    return { rc, output };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe('Step 3.2 merge — merge-integrity guard against silent -X ours data loss', () => {
  it('REPRODUCES the live gap: a genuine conflict is silently auto-resolved by -X ours, discarding the worktree lane\'s change, with the merge still reported as a success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-guard-conflict-'));
    try {
      setupConflictingRepo(dir);
      const { rc, output } = runStep32(dir);
      const finalContent = readFileSync(join(dir, 'f.txt'), 'utf8');

      // Desired behavior once fixed: the guard detects the would-be conflict
      // BEFORE merging and refuses to silently resolve it -- MERGE_FAILED,
      // exit 1, and the worktree's content must NOT have been discarded
      // (in fact the merge should not have happened at all).
      expect(output).toMatch(/[Mm]erge-integrity guard/);
      expect(output).toMatch(/f\.txt/);
      expect(rc).toBe(1);
      // The worktree branch's own commit still holds its content regardless
      // (branches are never destroyed by this guard) -- assert that on
      // master specifically, no *silent* merge commit landed overwriting it
      // without a trace.
      const log = git(dir, 'log', '--oneline', '-5');
      expect(log).not.toMatch(/merge: phase/);
      void finalContent;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes an audit artifact recording the conflicting file(s) when refusing to auto-resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-guard-artifact-'));
    try {
      setupConflictingRepo(dir);
      runStep32(dir, 'test-phase');
      const artifactPath = join(dir, '.epam/merge-conflicts/test-phase-wt-primary.json');
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      expect(artifact.conflictingFiles).toContain('f.txt');
      expect(artifact.branch).toBe('wt-primary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-conflicting merge (different files touched) still succeeds normally, unaffected by the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-guard-clean-'));
    try {
      setupNonConflictingRepo(dir);
      const { rc, output } = runStep32(dir);
      expect(rc).toBe(0);
      expect(output).toMatch(/Merged wt-primary into master/);
      expect(output).not.toMatch(/[Mm]erge-integrity guard/);
      expect(readFileSync(join(dir, 'primary-only.txt'), 'utf8')).toBe('primary content\n');
      expect(existsSync(join(dir, '.epam/merge-conflicts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
