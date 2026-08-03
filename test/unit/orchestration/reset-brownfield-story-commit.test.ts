/**
 * reset_brownfield_story_commit() (lib/story-guards.sh) — predictable
 * teardown-to-pre-run-state for brownfield, on gate failure.
 *
 * Standing mandate (6+ months, not new): the pipeline must be able to tear
 * down to a predictable pre-run state every time — a run may be repeated
 * 200+ times until it succeeds, and contamination from a failed attempt
 * must never persist into the next one.
 *
 * Live bug this closes (AMSD-1820, 2026-07-22): commit_completed_story()
 * commits BEFORE story_tsc_gate runs. When the gate then failed, the commit
 * was left sitting on develop permanently — nothing ever reverted it. It
 * went on to actively poison later Semble semantic-search results for every
 * subsequent run (see spec-context-combined-sources.test.ts's "known
 * limitation" test), compounding the damage rather than staying inert.
 *
 * Fix: story_tsc_gate's genuine-failure branch now calls
 * reset_brownfield_story_commit(), which hard-resets the codeline to
 * phase-baseline-sha.txt — the SHA captured once, at the very start of the
 * run's phase, before any story touched anything. Brownfield-only; greenfield
 * worktree lanes are untouched (they have a different, existing teardown
 * model via reset-to-baseline.sh).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const GUARDS_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const guardsSrc = readFileSync(GUARDS_LIB, 'utf8');
const NODE_BIN = process.execPath;

function extractFunction(name: string): string {
  const start = guardsSrc.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() start anchor not found`);
  const end = guardsSrc.indexOf('\n}\n', start) + '\n}'.length;
  return guardsSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reset-brownfield-fixture-'));
  cleanupDirs.push(dir);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, noEmit: true }, include: ['src/**/*.ts'] }, null, 2)
  );
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
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

function runStoryTscGateWithTeardown(
  projectRoot: string,
  opts: { brownfield: boolean; baselineSha: string | null }
): { exitCode: number; stdout: string; finalSha: string; commitStillExists: boolean; badCommitSha: string } {
  const logDir = mkdtempSync(join(tmpdir(), 'reset-brownfield-logdir-'));
  cleanupDirs.push(logDir);
  if (opts.baselineSha) writeFileSync(join(logDir, 'phase-baseline-sha.txt'), opts.baselineSha);
  const prdPath = join(logDir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'TEST-STORY', agentRole: 'typescript-engineer' }] }));

  // Introduce the "bad" story commit — a genuinely broken new file, exactly
  // matching what commit_completed_story() would have committed before
  // story_tsc_gate ever runs.
  writeFileSync(join(projectRoot, 'src', 'story-work.ts'), 'const y: number = "broken by this story";\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-m', 'TEST-STORY: story complete (1 file(s))', '--quiet'], { cwd: projectRoot });
  const badCommitSha = currentSha(projectRoot);

  const gateFn = extractFunction('story_tsc_gate');
  const resetFn = extractFunction('reset_brownfield_story_commit');
  const scriptDir = mkdtempSync(join(tmpdir(), 'reset-brownfield-script-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash
PROJECT_ROOT="${projectRoot}"
LOG_DIR="${logDir}"
PRD_FILE="${prdPath}"
NODE_CMD="${NODE_BIN}"
EPAM_BROWNFIELD="${opts.brownfield ? '1' : '0'}"
warning() { echo "WARNING: $*"; }
success() { echo "SUCCESS: $*"; }
error() { echo "ERROR: $*"; }

${gateFn}

${resetFn}

if story_tsc_gate "TEST-STORY"; then
  rc=0
else
  rc=$?
fi
echo "EXIT_CODE:$rc"
`);
  execFileSync('chmod', ['+x', scriptPath]);
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60000, cwd: projectRoot });
  const stdout = result.stdout || '';
  const exitMatch = stdout.match(/EXIT_CODE:(\d+)/);
  const finalSha = currentSha(projectRoot);
  const logOutput = execFileSync('git', ['log', '--oneline', '-20'], { cwd: projectRoot, encoding: 'utf8' });
  return {
    exitCode: exitMatch ? parseInt(exitMatch[1], 10) : -1,
    stdout,
    finalSha,
    commitStillExists: logOutput.includes(badCommitSha.slice(0, 7)),
    badCommitSha,
  };
}

describe('reset_brownfield_story_commit — predictable teardown on gate failure (real git, real tsc)', () => {
  it('brownfield: a genuine gate failure hard-resets the repo, discarding the bad commit entirely', () => {
    const dir = makeGitFixture();
    const baselineSha = currentSha(dir);
    const result = runStoryTscGateWithTeardown(dir, { brownfield: true, baselineSha });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/\[teardown\].*resetting/);
    expect(result.stdout).toMatch(/\[teardown\].*reset complete/);
    // The repo is back to EXACTLY the pre-run baseline SHA — not just "some" reset
    expect(result.finalSha).toBe(baselineSha);
    // The bad commit is gone from history entirely (hard reset, not a revert commit)
    expect(result.commitStillExists).toBe(false);
  });

  it('greenfield (EPAM_BROWNFIELD unset): does NOT reset — the bad commit stays', () => {
    const dir = makeGitFixture();
    const baselineSha = currentSha(dir);
    const result = runStoryTscGateWithTeardown(dir, { brownfield: false, baselineSha });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toMatch(/\[teardown\]/);
    // The bad commit is still HEAD — untouched, greenfield has its own teardown model
    expect(result.finalSha).toBe(result.badCommitSha);
    expect(result.commitStillExists).toBe(true);
  });

  it('brownfield with no phase-baseline-sha.txt: safe no-op, does not error or reset blindly', () => {
    const dir = makeGitFixture();
    const result = runStoryTscGateWithTeardown(dir, { brownfield: true, baselineSha: null });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toMatch(/\[teardown\]/);
    // No baseline known — nothing reset, the commit stays (can't safely reset to an unknown target)
    expect(result.finalSha).toBe(result.badCommitSha);
  });

  it('the working tree is fully clean after reset (git status has nothing pending)', () => {
    const dir = makeGitFixture();
    const baselineSha = currentSha(dir);
    runStoryTscGateWithTeardown(dir, { brownfield: true, baselineSha });
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    expect(status.trim()).toBe('');
  });
});

describe('reset_brownfield_story_commit — source invariants', () => {
  const fnBody = extractFunction('reset_brownfield_story_commit');

  it('gated on EPAM_BROWNFIELD=1 — never touches greenfield worktree lanes', () => {
    expect(fnBody).toMatch(/EPAM_BROWNFIELD.*=.*1/);
  });

  it('reads the SAME phase-baseline-sha.txt used by the tsc baseline-diff fix (not a new, separate file)', () => {
    expect(fnBody).toContain('phase-baseline-sha.txt');
  });

  it('uses git reset --hard (not revert) — no accumulating trail of revert commits across 200+ repeated runs', () => {
    expect(fnBody).toContain('git -C "$PROJECT_ROOT" reset --hard');
  });

  it('is a no-op (not an error) when no baseline file exists — cannot safely reset to an unknown target', () => {
    const noBaselineIdx = fnBody.indexOf('-f "$_baseline_file"');
    expect(noBaselineIdx).toBeGreaterThan(-1);
  });

  it('story_tsc_gate calls it only in the genuine-failure branch, not the pre-existing-baseline-errors-only pass branch', () => {
    const gateFn = extractFunction('story_tsc_gate');
    const callIdx = gateFn.indexOf('reset_brownfield_story_commit');
    const passBranchIdx = gateFn.indexOf('only pre-existing baseline errors');
    expect(callIdx).toBeGreaterThan(-1);
    expect(passBranchIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(passBranchIdx);
  });
});

// ── record_brownfield_verified_baseline — the durable, cross-run half ──────
// reset_brownfield_story_commit (above) self-heals the NORMAL failure path
// within a single run. But a run that gets KILLED before story_tsc_gate ever
// runs leaves no chance for that self-heal to fire. The durable marker this
// function writes — OUTSIDE the codeline entirely, keyed by an md5 of
// PROJECT_ROOT — is what the run-START backstop (brownfield-preflight-
// reset.sh) reads to recover from that case: it can't be swept into a
// commit, and survives `git reset --hard` unconditionally since it was
// never part of the git working tree.

function makeIsolatedStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reset-brownfield-state-'));
  cleanupDirs.push(dir);
  return dir;
}

function runRecordBaseline(projectRoot: string, stateDir: string, brownfield: boolean): { stdout: string; markerContent: string | null } {
  const recordFn = extractFunction('record_brownfield_verified_baseline');
  const scriptDir = mkdtempSync(join(tmpdir(), 'record-baseline-script-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash
PROJECT_ROOT="${projectRoot}"
EPAM_BROWNFIELD_STATE_DIR="${stateDir}"
EPAM_BROWNFIELD="${brownfield ? '1' : '0'}"

${recordFn}

record_brownfield_verified_baseline
echo "DONE"
`);
  execFileSync('chmod', ['+x', scriptPath]);
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 30000 });
  const key = execFileSync('md5sum', [], { input: projectRoot, encoding: 'utf8' }).split(' ')[0];
  const markerPath = join(stateDir, `${key}.sha`);
  let markerContent: string | null = null;
  try {
    markerContent = readFileSync(markerPath, 'utf8').trim();
  } catch { /* marker not written */ }
  return { stdout: result.stdout || '', markerContent };
}

describe('record_brownfield_verified_baseline — durable cross-run marker (real git)', () => {
  it('writes the current HEAD SHA to the state-dir marker, keyed by md5(PROJECT_ROOT)', () => {
    const dir = makeGitFixture();
    const sha = currentSha(dir);
    const stateDir = makeIsolatedStateDir();
    const { markerContent } = runRecordBaseline(dir, stateDir, true);
    expect(markerContent).toBe(sha);
  });

  it('does NOT write anything when not brownfield', () => {
    const dir = makeGitFixture();
    const stateDir = makeIsolatedStateDir();
    const { markerContent } = runRecordBaseline(dir, stateDir, false);
    expect(markerContent).toBeNull();
  });

  it('never modifies the target repo itself — no new files, no dirty working tree', () => {
    const dir = makeGitFixture();
    const stateDir = makeIsolatedStateDir();
    runRecordBaseline(dir, stateDir, true);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    expect(status.trim()).toBe('');
  });

  it('different PROJECT_ROOT paths get different marker keys — no collision across codelines', () => {
    const dirA = makeGitFixture();
    const dirB = makeGitFixture();
    const stateDir = makeIsolatedStateDir();
    runRecordBaseline(dirA, stateDir, true);
    runRecordBaseline(dirB, stateDir, true);
    const keyA = execFileSync('md5sum', [], { input: dirA, encoding: 'utf8' }).split(' ')[0];
    const keyB = execFileSync('md5sum', [], { input: dirB, encoding: 'utf8' }).split(' ')[0];
    expect(keyA).not.toBe(keyB);
    expect(readFileSync(join(stateDir, `${keyA}.sha`), 'utf8').trim()).toBe(currentSha(dirA));
    expect(readFileSync(join(stateDir, `${keyB}.sha`), 'utf8').trim()).toBe(currentSha(dirB));
  });
});

describe('record_brownfield_verified_baseline — source invariants', () => {
  const fnBody = extractFunction('record_brownfield_verified_baseline');

  it('gated on EPAM_BROWNFIELD=1', () => {
    expect(fnBody).toMatch(/EPAM_BROWNFIELD.*=.*1/);
  });

  it('the marker path is outside PROJECT_ROOT — never inside the codeline itself', () => {
    expect(fnBody).not.toMatch(/\$PROJECT_ROOT\/\.epam\/\.last-verified/);
    expect(fnBody).toMatch(/EPAM_BROWNFIELD_STATE_DIR/);
  });

  it('story_tsc_gate calls it on BOTH success paths (outright pass and pre-existing-only pass)', () => {
    const gateFn = extractFunction('story_tsc_gate');
    const calls = gateFn.split('record_brownfield_verified_baseline').length - 1;
    expect(calls).toBe(2);
  });
});
