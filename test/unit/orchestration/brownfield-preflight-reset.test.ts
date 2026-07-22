/**
 * brownfield-preflight-reset.sh — run-START backstop for the predictable-
 * teardown mandate (6+ months standing, not new).
 *
 * reset_brownfield_story_commit() (story-guards.sh) self-heals the NORMAL
 * failure path: a gate fails mid-run, the bad commit is reset immediately.
 * This script is the backstop for the case that can't cover: a run KILLED
 * before story_tsc_gate ever runs (mid-story, no gate check reached), which
 * leaves either a dirty working tree or an unverified "story: complete"
 * commit sitting on the codeline with nothing having reverted it.
 *
 * Source of truth: record_brownfield_verified_baseline() (story-guards.sh)
 * writes the current HEAD SHA to a marker OUTSIDE the codeline, every time a
 * story genuinely passes story_tsc_gate. This script reads that marker at
 * run start and hard-resets back to it if the codeline has drifted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/brownfield-preflight-reset.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-fixture-'));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = 1;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: dir });
  return dir;
}

function currentSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function md5Key(input: string): string {
  return execFileSync('md5sum', [], { input, encoding: 'utf8' }).split(' ')[0];
}

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-state-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeMarker(stateDir: string, projectRoot: string, sha: string) {
  const key = md5Key(projectRoot);
  writeFileSync(join(stateDir, `${key}.sha`), sha);
}

function runPreflight(projectRoot: string, stateDir: string): { stdout: string; exitCode: number } {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('bash', [SCRIPT_PATH, projectRoot], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_BROWNFIELD_STATE_DIR: stateDir },
  });
  // warn() writes to stderr, log() to stdout — merge both since assertions
  // check for either depending on the branch taken.
  return { stdout: (result.stdout || '') + (result.stderr || ''), exitCode: result.status ?? -1 };
}

describe('brownfield-preflight-reset.sh — real git repos', () => {
  it('resets an unverified commit back to the marker SHA', () => {
    const dir = makeGitFixture();
    const verifiedSha = currentSha(dir);
    const stateDir = makeStateDir();
    writeMarker(stateDir, dir, verifiedSha);

    // Simulate an interrupted run: a commit made after the verified baseline
    // that never reached story_tsc_gate (no self-heal ever ran for it).
    writeFileSync(join(dir, 'src', 'unverified-work.ts'), 'export const wip = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'story: complete WIP-STORY (1 file(s))', '--quiet'], { cwd: dir });
    expect(currentSha(dir)).not.toBe(verifiedSha);

    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/reset complete/);
    expect(currentSha(dir)).toBe(verifiedSha);
  });

  it('resets a dirty (uncommitted) working tree back to the marker SHA', () => {
    const dir = makeGitFixture();
    const verifiedSha = currentSha(dir);
    const stateDir = makeStateDir();
    writeMarker(stateDir, dir, verifiedSha);

    // Simulate a kill mid-write: uncommitted changes left on disk.
    writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = 999; // corrupted mid-write\n');
    writeFileSync(join(dir, 'src', 'orphan.ts'), 'this is not even valid typescript {{{\n');

    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/reset complete/);
    expect(currentSha(dir)).toBe(verifiedSha);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    expect(status.trim()).toBe('');
    expect(readFileSync(join(dir, 'src', 'clean.ts'), 'utf8')).toBe('export const ok = 1;\n');
  });

  it('is a safe no-op when no marker exists yet', () => {
    const dir = makeGitFixture();
    const originalSha = currentSha(dir);
    const stateDir = makeStateDir(); // empty — no marker written

    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/nothing known-good to reset to/);
    expect(currentSha(dir)).toBe(originalSha);
  });

  it('is a safe no-op when already at the verified baseline with a clean tree', () => {
    const dir = makeGitFixture();
    const verifiedSha = currentSha(dir);
    const stateDir = makeStateDir();
    writeMarker(stateDir, dir, verifiedSha);

    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/already at the last verified baseline/);
    expect(currentSha(dir)).toBe(verifiedSha);
  });

  it('rejects a stale marker SHA that does not exist in this repo\'s history — never resets to a nonexistent commit', () => {
    const dir = makeGitFixture();
    const stateDir = makeStateDir();
    // A plausible-looking but entirely fabricated SHA — simulates a marker
    // left over from a different clone/history that no longer applies here.
    writeMarker(stateDir, dir, '0123456789abcdef0123456789abcdef01234567');

    const originalSha = currentSha(dir);
    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/not found in .* history — skipping reset/);
    expect(currentSha(dir)).toBe(originalSha);
  });

  it('is a safe no-op when PROJECT_ROOT is not a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-not-git-'));
    cleanupDirs.push(dir);
    const stateDir = makeStateDir();
    const { stdout } = runPreflight(dir, stateDir);
    expect(stdout).toMatch(/not a git repository/);
  });
});

describe('brownfield-preflight-reset.sh — source invariants', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf8');

  it('verifies the marker SHA exists in history before resetting (cat-file -e check)', () => {
    expect(src).toMatch(/git -C "\$PROJECT_ROOT" cat-file -e/);
  });

  it('runs git clean -fd after reset --hard (removes untracked debris too)', () => {
    expect(src).toMatch(/reset --hard.*[\s\S]*clean -fd/);
  });

  it('always exits 0 — a best-effort backstop must never block a run from starting', () => {
    expect(src.trim().split('\n').pop()).toBe('exit 0');
  });
});
