/**
 * Step 9 (auto-commit main-branch story output) — run-agent-orchestration.sh
 *
 * Live bug (2026-07-22): this step fired whenever there were worktree-bound
 * stories AND the tree was dirty — with no check that Step 8 (main-branch
 * stories) actually ran anything. A parallel-only run (all stories routed
 * to worktrees, zero in the main lane — "no stories in lane" logged) still
 * has a dirty tree from incidental pipeline writes (CodeGraph indexing,
 * dependency-check manifests) — NOT genuine story output. This committed
 * that noise directly onto the shared baseline branch (develop) with zero
 * branch protection: confirmed live, a real run committed
 * .codegraph/.gitignore + three .epam/*.json manifests straight onto
 * develop, worse than the Step 8 story-commit bug already fixed this
 * session via ensure_story_branch (there wasn't even a dedicated branch
 * involved here).
 *
 * Fix: gate on `$main_stories` actually being non-empty (Step 8's own
 * condition) — if Step 8 had nothing to run, any dirtiness is pipeline
 * noise, not a deliverable to preserve.
 *
 * Real git repos throughout, no mocking.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractStep9Block(): string {
  const start = orchSrc.indexOf('# Step 1.5: Auto-commit any main-branch story output');
  const end = orchSrc.indexOf('# Step 10 (TC writer gate) has moved', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return orchSrc.slice(start, end);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'step9-fixture-'));
  cleanupDirs.push(dir);
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'seed.txt'), 'v1\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: dir });
  return dir;
}

/**
 * Runs the extracted Step 9 block standalone against a real repo.
 * mainStories/primaryStories/independentStories simulate the script-level
 * variables Step 8 would have already set before reaching this point.
 */
function runStep9(
  projectRoot: string,
  opts: { mainStories?: string; primaryStories?: string; independentStories?: string }
): { stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), 'step9-run-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      'step_emit() { :; }',
      'log()     { echo "LOG: $*"; }',
      'info()    { echo "INFO: $*"; }',
      'warning() { echo "WARN: $*"; }',
      'error()   { echo "ERROR: $*"; }',
      'success() { echo "OK: $*"; }',
      `PROJECT_ROOT=${JSON.stringify(projectRoot)}`,
      `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
      'PHASE=core',
      `main_stories=${JSON.stringify(opts.mainStories ?? '')}`,
      `primary_stories=${JSON.stringify(opts.primaryStories ?? '')}`,
      `independent_stories=${JSON.stringify(opts.independentStories ?? '')}`,
      extractStep9Block(),
      'echo "HARNESS_DONE"',
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
    const combined = (result.stdout || '') + (result.stderr || '');
    return { stdout: combined, exitCode: combined.includes('HARNESS_DONE') ? 0 : (result.status ?? -1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function currentBranchHead(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('Step 9 auto-commit — brownfield guard against committing pipeline noise onto develop', () => {
  it('reproduces the exact live bug scenario and confirms it no longer commits: worktree stories present, main_stories EMPTY, tree dirty from incidental pipeline files', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);
    // Simulate incidental pipeline writes (CodeGraph indexing, dependency-check
    // manifests) — NOT real story output, since main_stories is empty (all
    // stories routed to worktrees, matching "no stories in lane" live case).
    mkdirSync(join(repo, '.codegraph'), { recursive: true });
    writeFileSync(join(repo, '.codegraph/.gitignore'), '*.db\n');
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam/dependency-check.json'), '{}');

    const { stdout, exitCode } = runStep9(repo, {
      mainStories: '', // Step 8 had "no stories in lane"
      primaryStories: 'STORY-A',
      independentStories: 'STORY-B',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No main-branch stories ran this phase/);
    // Must NOT have committed — HEAD unchanged, files still just sitting untracked.
    expect(currentBranchHead(repo)).toBe(before);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status).toMatch(/\.codegraph/);
    expect(status).toMatch(/\.epam/);
  });

  it('still commits correctly when main_stories IS non-empty (the legitimate case this step exists for)', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);
    // Simulate a real main-branch story writing a real deliverable without
    // committing it itself (the "mock/epam-run agents only write files" case
    // this step was built for).
    writeFileSync(join(repo, 'src-output.ts'), 'export const real = true;\n');

    const { stdout, exitCode } = runStep9(repo, {
      mainStories: 'STORY-REAL',
      primaryStories: 'STORY-A',
      independentStories: '',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Committed main-branch output/);
    expect(currentBranchHead(repo)).not.toBe(before);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status.trim()).toBe(''); // clean — committed
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(log).toBe('chore: auto-commit main-branch story output for phase core');
  });

  it('is a no-op when there are no worktree-bound stories at all, regardless of main_stories', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);
    writeFileSync(join(repo, 'stray.txt'), 'noise\n');

    const { exitCode } = runStep9(repo, { mainStories: 'STORY-X', primaryStories: '', independentStories: '' });
    expect(exitCode).toBe(0);
    expect(currentBranchHead(repo)).toBe(before);
  });

  it('is a no-op when the tree is already clean, even with worktree stories and main_stories present', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);

    const { stdout, exitCode } = runStep9(repo, {
      mainStories: 'STORY-REAL',
      primaryStories: 'STORY-A',
      independentStories: '',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No uncommitted main-branch changes/);
    expect(currentBranchHead(repo)).toBe(before);
  });

  it('run 10x in a row reproducing the exact bug scenario — never commits, deterministically', () => {
    const RUNS = 10;
    const outcomes: { exitCode: number; headUnchanged: boolean }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const repo = makeRepo();
      const before = currentBranchHead(repo);
      mkdirSync(join(repo, '.codegraph'), { recursive: true });
      writeFileSync(join(repo, '.codegraph/.gitignore'), '*.db\n');
      const { exitCode } = runStep9(repo, { mainStories: '', primaryStories: 'S-A', independentStories: 'S-B' });
      outcomes.push({ exitCode, headUnchanged: currentBranchHead(repo) === before });
    }
    const failures = outcomes.filter(o => o.exitCode !== 0 || !o.headUnchanged);
    expect(failures, `${failures.length}/${RUNS} failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
  }, 30000);
});
