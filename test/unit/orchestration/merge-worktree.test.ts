/**
 * merge-worktree.sh — previously had ZERO test coverage despite performing a
 * real `git merge --no-ff` into `main`, with `merge --abort`/`reset --merge`
 * recovery paths and a final `git commit`, directly against a client codeline.
 * Found during the 2026-08-02 git-surface audit: no automated caller and no
 * test exercised it, so a regression in its conflict-detection or abort logic
 * would only ever surface live.
 *
 * The script derives PROJECT_ROOT from its own on-disk location
 * (two directories up from itself) and expects the worktree at a fixed
 * sibling path ("<project>-wt-<lane>"), so a real test needs to place a copy
 * of the script inside a fixture tree shaped like the real repo
 * (fixture/orchestrations/scripts/merge-worktree.sh) rather than invoking the
 * real epam-cli copy against a throwaway repo.
 *
 * Real git repos throughout — no mocking of git itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const REAL_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/merge-worktree.sh');

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8' });
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Builds a fixture shaped like the real repo: <root>/project (with .git,
 * on "main") + orchestrations/scripts/merge-worktree.sh copied in, plus the
 * sibling worktree directory the script's own path arithmetic expects:
 * <root>/project-wt-<lane>.
 */
function makeFixture(lane: 'primary' | 'independent' = 'primary'): {
  root: string;
  project: string;
  worktreePath: string;
  mergeLog: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'merge-worktree-test-'));
  cleanupDirs.push(root);

  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  git(project, 'init --quiet --initial-branch=main');
  git(project, 'config user.email "test@test.com"');
  git(project, 'config user.name "Test"');
  writeFileSync(join(project, 'README.md'), 'init\n');
  git(project, 'add -A');
  git(project, 'commit --quiet -m "init"');

  const scriptsDir = join(project, 'orchestrations/scripts');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(REAL_SCRIPT, join(scriptsDir, 'merge-worktree.sh'));

  const worktreePath = join(root, `project-wt-${lane}`);
  const mergeLog = join(root, 'merge-requests.jsonl');

  return { root, project, worktreePath, mergeLog };
}

function addLaneWorktree(project: string, worktreePath: string, lane: string): void {
  execFileSync('git', ['worktree', 'add', '-b', `wt-${lane}`, worktreePath, 'main'], { cwd: project });
}

function runMerge(
  fixture: { project: string; mergeLog: string },
  lane: string,
  phase = 'phase1_foundation',
  extraEnv: Record<string, string> = {},
): { exitCode: number; stdout: string } {
  const result = spawnSync('bash', ['orchestrations/scripts/merge-worktree.sh', lane, phase], {
    cwd: fixture.project,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MERGE_LOG: fixture.mergeLog, SKIP_TESTS: 'true', ...extraEnv },
  });
  return { exitCode: result.status ?? -1, stdout: (result.stdout || '') + (result.stderr || '') };
}

function readLogEntries(mergeLog: string): any[] {
  if (!existsSync(mergeLog)) return [];
  return readFileSync(mergeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('merge-worktree.sh — clean merge, real git', () => {
  it('merges a worktree lane with real commits into main, commits the merge, and logs status:merged', () => {
    const fixture = makeFixture('primary');
    addLaneWorktree(fixture.project, fixture.worktreePath, 'primary');
    writeFileSync(join(fixture.worktreePath, 'feature.ts'), 'export const x = 1;\n');
    git(fixture.worktreePath, 'add -A');
    git(fixture.worktreePath, 'commit --quiet -m "add feature"');

    const { exitCode } = runMerge(fixture, 'primary');

    expect(exitCode).toBe(0);
    expect(existsSync(join(fixture.project, 'feature.ts'))).toBe(true);
    expect(git(fixture.project, 'branch --show-current').trim()).toBe('main');

    const entries = readLogEntries(fixture.mergeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('merged');
    expect(entries[0].lane).toBe('primary');
    expect(entries[0].commit_sha).toBe(git(fixture.project, 'rev-parse HEAD').trim());
  });

  it('is a no-op (exit 0, no commit, no log entry) when the lane branch has no new commits', () => {
    const fixture = makeFixture('independent');
    addLaneWorktree(fixture.project, fixture.worktreePath, 'independent');
    const headBefore = git(fixture.project, 'rev-parse HEAD').trim();

    const { exitCode } = runMerge(fixture, 'independent');

    expect(exitCode).toBe(0);
    expect(git(fixture.project, 'rev-parse HEAD').trim()).toBe(headBefore);
    expect(readLogEntries(fixture.mergeLog)).toHaveLength(0);
  });
});

describe('merge-worktree.sh — real conflicts, real abort', () => {
  it('detects a real conflict, aborts the merge cleanly (main left untouched), and logs status:conflict', () => {
    const fixture = makeFixture('primary');
    // Both main and the lane branch edit the SAME line of the SAME file.
    writeFileSync(join(fixture.project, 'shared.ts'), 'export const value = "main";\n');
    git(fixture.project, 'add -A');
    git(fixture.project, 'commit --quiet -m "main edits shared.ts"');

    addLaneWorktree(fixture.project, fixture.worktreePath, 'primary');
    // Rebuild the lane branch's history from BEFORE main's edit, so it
    // genuinely conflicts rather than fast-forwarding.
    execFileSync('git', ['checkout', 'wt-primary'], { cwd: fixture.worktreePath });
    execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: fixture.worktreePath });
    writeFileSync(join(fixture.worktreePath, 'shared.ts'), 'export const value = "lane";\n');
    git(fixture.worktreePath, 'add -A');
    git(fixture.worktreePath, 'commit --quiet -m "lane edits shared.ts"');

    const headBefore = git(fixture.project, 'rev-parse HEAD').trim();
    const { exitCode, stdout } = runMerge(fixture, 'primary');

    expect(exitCode).toBe(1);
    expect(stdout.toLowerCase()).toContain('conflict');
    // main must be left exactly as it was — merge --abort must have run.
    expect(git(fixture.project, 'rev-parse HEAD').trim()).toBe(headBefore);
    expect(git(fixture.project, 'status --porcelain').trim()).toBe('');
    expect(readFileSync(join(fixture.project, 'shared.ts'), 'utf8')).toBe('export const value = "main";\n');

    const entries = readLogEntries(fixture.mergeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('conflict');
    expect(entries[0].requires_review).toBe(true);
  });
});

describe('merge-worktree.sh — post-merge test failure path', () => {
  it('rolls back the merge with reset --merge and logs status:test_failure when tsc fails after a clean merge', () => {
    const fixture = makeFixture('primary');
    addLaneWorktree(fixture.project, fixture.worktreePath, 'primary');
    writeFileSync(join(fixture.worktreePath, 'broken.ts'), 'this is not valid typescript {{{\n');
    git(fixture.worktreePath, 'add -A');
    git(fixture.worktreePath, 'commit --quiet -m "introduce a real ts syntax error"');

    // A minimal real package.json + tsconfig + a real, reachable tsc binary
    // are required for the script's own "package.json exists -> run tsc"
    // branch to actually execute — reuse the repo's own node_modules so tsc
    // is real, not stubbed.
    writeFileSync(join(fixture.project, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    writeFileSync(
      join(fixture.project, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: false }, include: ['*.ts'] }),
    );
    mkdirSync(join(fixture.project, 'node_modules/.bin'), { recursive: true });
    const realTsc = join(REPO_ROOT, 'node_modules/.bin/tsc');
    if (!existsSync(realTsc)) {
      // Environment doesn't have tsc locally installed — skip rather than false-fail.
      return;
    }
    execFileSync('ln', ['-s', realTsc, join(fixture.project, 'node_modules/.bin/tsc')]);
    // Also symlink the real typescript package so tsc can resolve itself.
    const tsPkg = join(REPO_ROOT, 'node_modules/typescript');
    if (existsSync(tsPkg)) {
      execFileSync('ln', ['-s', tsPkg, join(fixture.project, 'node_modules/typescript')]);
    }
    git(fixture.project, 'add -A');
    git(fixture.project, 'commit --quiet -m "add package.json/tsconfig for real tsc gate"');

    const headBefore = git(fixture.project, 'rev-parse HEAD').trim();
    const { exitCode } = runMerge(fixture, 'primary', 'phase1_foundation', { SKIP_TESTS: 'false' });

    expect(exitCode).toBe(2);
    expect(git(fixture.project, 'rev-parse HEAD').trim()).toBe(headBefore);

    const entries = readLogEntries(fixture.mergeLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('test_failure');
  });
});

describe('merge-worktree.sh — argument/prerequisite validation', () => {
  it('exits 3 with usage message when fewer than 2 args are given', () => {
    const fixture = makeFixture('primary');
    const result = spawnSync('bash', ['orchestrations/scripts/merge-worktree.sh', 'primary'], {
      cwd: fixture.project,
      encoding: 'utf8',
    });
    expect(result.status).toBe(3);
    expect((result.stderr || '')).toContain('Usage:');
  });

  it('exits 3 for an invalid lane name', () => {
    const fixture = makeFixture('primary');
    const { exitCode, stdout } = runMerge(fixture, 'not-a-real-lane');
    expect(exitCode).toBe(3);
    expect(stdout).toContain('Invalid lane');
  });

  it('exits 3 when the expected worktree directory does not exist', () => {
    const fixture = makeFixture('primary');
    // Branch exists (so the branch check would pass) but no worktree dir.
    execFileSync('git', ['branch', 'wt-primary'], { cwd: fixture.project });
    const { exitCode, stdout } = runMerge(fixture, 'primary');
    expect(exitCode).toBe(3);
    expect(stdout).toContain('Worktree not found');
  });

  it('exits 3 when main has real uncommitted changes to an already-tracked file', () => {
    const fixture = makeFixture('primary');
    addLaneWorktree(fixture.project, fixture.worktreePath, 'primary');
    writeFileSync(join(fixture.worktreePath, 'feature.ts'), 'export const x = 1;\n');
    git(fixture.worktreePath, 'add -A');
    git(fixture.worktreePath, 'commit --quiet -m "add feature"');

    // git diff-index --quiet HEAD -- (used by the script) only sees changes
    // to TRACKED files, not new untracked ones — modify README.md (already
    // committed by makeFixture) so the dirty-check actually has something to
    // catch, matching what it's really designed to detect.
    writeFileSync(join(fixture.project, 'README.md'), 'modified, uncommitted\n');

    const { exitCode, stdout } = runMerge(fixture, 'primary');
    expect(exitCode).toBe(3);
    expect(stdout).toContain('uncommitted changes');
  });

  it('does NOT catch a merely untracked (never-added) file as "uncommitted changes" — a real gap in the script\'s own diff-index check', () => {
    const fixture = makeFixture('primary');
    addLaneWorktree(fixture.project, fixture.worktreePath, 'primary');
    writeFileSync(join(fixture.worktreePath, 'feature.ts'), 'export const x = 1;\n');
    git(fixture.worktreePath, 'add -A');
    git(fixture.worktreePath, 'commit --quiet -m "add feature"');

    writeFileSync(join(fixture.project, 'untracked.txt'), 'never git add-ed\n');

    const { exitCode } = runMerge(fixture, 'primary');
    // Documents current (surprising) behavior: the merge proceeds despite a
    // real untracked file sitting in the tree, because `git diff-index
    // --quiet HEAD --` never looks at untracked files.
    expect(exitCode).toBe(0);
  });
});
