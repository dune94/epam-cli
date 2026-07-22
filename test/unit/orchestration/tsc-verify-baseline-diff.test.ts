/**
 * run_tsc_verification() — baseline diff for brownfield pre-existing errors.
 *
 * Live bug (2026-07-22, Metrolinx azure.commerce.cdts / AMSD-1820): whole-project
 * `tsc --noEmit` fails identically for EVERY story in a large brownfield repo
 * because of pre-existing type errors in files no story ever touches (Redis/
 * Stripe/OTel type declarations, a jsonwebtoken signature mismatch — nothing
 * to do with the Mozio promo-discount story being implemented). Confirmed via
 * HealingBroken firing 4+ times on the exact same "pre-existing, unrelated"
 * diagnosis before the retry ladder exhausted all 8 attempts — no amount of
 * model escalation can fix errors in files the story never touches.
 *
 * Fix: diff the current tsc output against a baseline error set captured from
 * JIRA_BASELINE_BRANCH (the same baseline review-ranger/mutant-hunter already
 * use, cached at $LOG_DIR/phase-baseline-sha.txt). Only fail when the story's
 * own changes introduce errors NOT present in that baseline — i.e. tsc-verify
 * now answers "did THIS story break the build" instead of "is the whole
 * repo's tsc output clean" (an unanswerable bar for large brownfield repos
 * with pre-existing debt).
 *
 * This test extracts the REAL run_tsc_verification() function from claude.sh
 * (not a hand-copied duplicate) and runs it against real git fixture repos
 * with a real tsc binary (borrowed from this repo's own node_modules).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const NODE_BIN = process.execPath;

function extractTscVerifyFunction(): string {
  const start = claudeSrc.indexOf('run_tsc_verification() {');
  if (start === -1) throw new Error('run_tsc_verification() start anchor not found');
  const end = claudeSrc.indexOf('\n}\n', start) + '\n}'.length;
  return claudeSrc.slice(start, end);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-verify-fixture-'));
  cleanupDirs.push(dir);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, noEmit: true }, include: ['src/**/*.ts'] }, null, 2)
  );
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', message, '--quiet'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function runTscVerify(projectRoot: string, baselineSha: string | null): { exitCode: number; stdout: string; stderr: string; verificationFailure: string } {
  const logDir = mkdtempSync(join(tmpdir(), 'tsc-verify-logdir-'));
  cleanupDirs.push(logDir);
  if (baselineSha) {
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha);
  }
  const outputFile = join(logDir, 'output.txt');
  writeFileSync(outputFile, '');

  const fnBody = extractTscVerifyFunction();
  const scriptDir = mkdtempSync(join(tmpdir(), 'tsc-verify-script-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT="${projectRoot}"
LOG_DIR="${logDir}"
NODE_CMD="${NODE_BIN}"
warning() { echo "WARNING: $*"; }
success() { echo "SUCCESS: $*"; }

${fnBody}

run_tsc_verification "TEST-STORY" "${outputFile}"
echo "EXIT_CODE:$?"
echo "VERIFICATION_FAILURE_START"
echo "\${VERIFICATION_FAILURE:-}"
echo "VERIFICATION_FAILURE_END"
`);
  execFileSync('chmod', ['+x', scriptPath]);

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60000, cwd: projectRoot });
  const stdout = result.stdout || '';
  const exitMatch = stdout.match(/EXIT_CODE:(\d+)/);
  const vfMatch = stdout.match(/VERIFICATION_FAILURE_START\n([\s\S]*?)\nVERIFICATION_FAILURE_END/);
  return {
    exitCode: exitMatch ? parseInt(exitMatch[1], 10) : -1,
    stdout,
    stderr: result.stderr || '',
    verificationFailure: vfMatch ? vfMatch[1] : '',
  };
}

describe('run_tsc_verification — baseline diff (real git repos, real tsc)', () => {
  it('PASSES when the story introduces zero new errors, even though pre-existing baseline errors exist elsewhere', () => {
    const dir = makeGitFixture();
    // Baseline: a file with a genuine, unrelated pre-existing type error.
    writeFileSync(join(dir, 'src', 'legacy.ts'), 'const x: number = "not a number";\n');
    const baselineSha = commitAll(dir, 'baseline with pre-existing error');

    // Story's own change: a NEW file with NO errors — the story's actual work.
    writeFileSync(join(dir, 'src', 'mozio-promo.ts'), 'export function applyDiscount(amount: number): number { return amount * 0.9; }\n');

    const result = runTscVerify(dir, baselineSha);
    expect(result.exitCode, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  });

  it('FAILS when the story introduces a genuinely NEW error not present in the baseline', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'legacy.ts'), 'const x: number = "not a number";\n');
    const baselineSha = commitAll(dir, 'baseline with pre-existing error');

    // Story's own change introduces a NEW type error.
    writeFileSync(join(dir, 'src', 'mozio-promo.ts'), 'const y: number = "also not a number";\n');

    const result = runTscVerify(dir, baselineSha);
    expect(result.exitCode).toBe(1);
    expect(result.verificationFailure).toMatch(/mozio-promo\.ts/);
    // The pre-existing baseline error must NOT appear in the failure output
    expect(result.verificationFailure).not.toMatch(/legacy\.ts/);
  });

  it('FAILS on ANY error when no baseline SHA file exists (greenfield / no-baseline fallback preserved)', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'broken.ts'), 'const z: number = "broken";\n');
    commitAll(dir, 'single commit, no baseline tracking');

    const result = runTscVerify(dir, null); // no baseline SHA file at all
    expect(result.exitCode).toBe(1);
    expect(result.verificationFailure).toMatch(/broken\.ts/);
  });

  it('PASSES with exit 0 when tsc is clean and there is no baseline concept at all', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'clean.ts'), 'export const ok = 1;\n');
    commitAll(dir, 'clean commit');

    const result = runTscVerify(dir, null);
    expect(result.exitCode).toBe(0);
  });

  it('caches the baseline error computation — does not re-run tsc against the baseline worktree on a second call', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'legacy.ts'), 'const x: number = "not a number";\n');
    const baselineSha = commitAll(dir, 'baseline with pre-existing error');
    writeFileSync(join(dir, 'src', 'mozio-promo.ts'), 'export const ok = 1;\n');

    const logDir = mkdtempSync(join(tmpdir(), 'tsc-verify-cache-logdir-'));
    cleanupDirs.push(logDir);
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha);

    const fnBody = extractTscVerifyFunction();
    const scriptDir = mkdtempSync(join(tmpdir(), 'tsc-verify-cache-script-'));
    cleanupDirs.push(scriptDir);
    const scriptPath = join(scriptDir, 'run.sh');
    writeFileSync(scriptPath, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT="${dir}"
LOG_DIR="${logDir}"
NODE_CMD="${NODE_BIN}"
warning() { echo "WARNING: $*"; }
success() { echo "SUCCESS: $*"; }

${fnBody}

run_tsc_verification "STORY-1" "${join(logDir, 'out1.txt')}"
echo "FIRST_EXIT:$?"
run_tsc_verification "STORY-2" "${join(logDir, 'out2.txt')}"
echo "SECOND_EXIT:$?"
ls "${logDir}"/tsc-baseline-errors-*.txt 2>/dev/null | wc -l
`);
    execFileSync('chmod', ['+x', scriptPath]);
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60000 });
    const stdout = result.stdout || '';
    expect(stdout).toMatch(/FIRST_EXIT:0/);
    expect(stdout).toMatch(/SECOND_EXIT:0/);
    // Exactly one cache file, regardless of how many stories called run_tsc_verification
    expect(stdout.trim().split('\n').pop()?.trim()).toBe('1');
  });
});

describe('run_tsc_verification — source invariants', () => {
  const fnBody = extractTscVerifyFunction();

  it('reads the baseline SHA from phase-baseline-sha.txt — the same file review-ranger/mutant-hunter already use', () => {
    expect(fnBody).toContain('phase-baseline-sha.txt');
  });

  it('uses git worktree (not a full clone) to check out the baseline for the tsc comparison', () => {
    expect(fnBody).toContain('git -C "$PROJECT_ROOT" worktree add');
  });

  it('removes the temporary worktree after use (no leftover worktrees)', () => {
    expect(fnBody).toContain('git -C "$PROJECT_ROOT" worktree remove');
  });

  it('caches the baseline error set keyed by SHA — does not recompute per story', () => {
    expect(fnBody).toMatch(/tsc-baseline-errors-.*\.txt/);
  });

  it('falls back to failing on ANY error when no baseline is available (greenfield safe default)', () => {
    // The original _tsc_output is used as _new_errors unless a baseline cache exists and reduces it
    expect(fnBody).toContain('local _new_errors="$_tsc_output"');
  });
});
