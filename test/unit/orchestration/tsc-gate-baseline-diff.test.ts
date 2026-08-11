/**
 * story_tsc_gate() (lib/story-guards.sh) — baseline diff, same fix as
 * claude.sh's run_tsc_verification() (see tsc-verify-baseline-diff.test.ts).
 *
 * Live bug (AMSD-1820, 2026-07-22): run_tsc_verification() inside claude.sh's
 * retry loop got the baseline-diff fix and correctly passed the story ("tsc
 * --noEmit has only pre-existing baseline errors — none introduced by this
 * story"). The run log then showed "Story AMSD-1820 marked as completed" —
 * but a few lines later, story_tsc_gate() (a SEPARATE, shared implementation
 * in lib/story-guards.sh, called as an outer "defensive last-resort" check
 * AFTER the story already completed) ran the same whole-project `tsc
 * --noEmit` with NO baseline diff, hit the exact same pre-existing Redis/
 * Stripe/OTel/jwt errors, and flipped the story back to failed — "Story
 * AMSD-1820 marked as failed" immediately followed, and the phase aborted
 * with "Implemented: 0, Failed: 1" despite the story's own code being fine.
 *
 * Two independent call sites, two independent instances of the identical
 * bug — this test proves the second one is now fixed the same way.
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

function extractStoryTscGate(): string {
  const start = guardsSrc.indexOf('story_tsc_gate() {');
  if (start === -1) throw new Error('story_tsc_gate() start anchor not found');
  const end = guardsSrc.indexOf('\n}\n', start) + '\n}'.length;
  // The gate delegates to _run_project_verification, which runs the PROJECT's declared
  // command instead of a compiler the engine names. Extract it too: without it the call is
  // a missing command and the gate's verdict is decided by the wrong thing entirely.
  const hStart = guardsSrc.indexOf('_run_project_verification() {');
  const hEnd = guardsSrc.indexOf('\n}\n', hStart) + '\n}'.length;
  return `${guardsSrc.slice(hStart, hEnd)}\n${guardsSrc.slice(start, end)}`;
}

const AUTOMATION_DIR_FOR_TEST = join(__dirname, '../../../orchestrations');
const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-gate-fixture-'));
  cleanupDirs.push(dir);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  // The project declares HOW it verifies itself; the engine runs that declared command
  // rather than a compiler it named. A fixture that declares nothing is reported as
  // UNKNOWN by the gate, so the behaviour under test never fires.
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.epam', 'verification.json'), JSON.stringify({
    typecheck: { command: './node_modules/.bin/tsc --noEmit' },
  }));
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

function runStoryTscGate(projectRoot: string, baselineSha: string | null, prdStub: object): { exitCode: number; stdout: string } {
  const logDir = mkdtempSync(join(tmpdir(), 'tsc-gate-logdir-'));
  cleanupDirs.push(logDir);
  if (baselineSha) writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha);
  const prdPath = join(logDir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prdStub));

  const fnBody = extractStoryTscGate();
  const scriptDir = mkdtempSync(join(tmpdir(), 'tsc-gate-script-'));
  cleanupDirs.push(scriptDir);
  const scriptPath = join(scriptDir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash
PROJECT_ROOT="${projectRoot}"
LOG_DIR="${logDir}"
PRD_FILE="${prdPath}"
NODE_CMD="${NODE_BIN}"
AUTOMATION_DIR="${AUTOMATION_DIR_FOR_TEST}"
warning() { echo "WARNING: $*"; }
success() { echo "SUCCESS: $*"; }
error() { echo "ERROR: $*"; }

${fnBody}

# story_tsc_gate's own body toggles "set -e" back on internally (to restore
# ambient state after its own "set +e" around the tsc invocation) — a bare
# call as a simple command would then trigger immediate script termination
# on a non-zero return, before this echo ever runs. Using it as an \`if\`
# condition exempts it from that rule (bash's documented -e exemption for
# if/while/until conditions and &&/||/! contexts).
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
  return { exitCode: exitMatch ? parseInt(exitMatch[1], 10) : -1, stdout };
}

describe('story_tsc_gate — baseline diff (real git repos, real tsc)', () => {
  it('PASSES when the story introduces zero new errors, even with pre-existing baseline errors elsewhere', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'legacy.ts'), 'const x: number = "not a number";\n');
    const baselineSha = commitAll(dir, 'baseline with pre-existing error');
    writeFileSync(join(dir, 'src', 'story-work.ts'), 'export function ok(n: number): number { return n + 1; }\n');

    const result = runStoryTscGate(dir, baselineSha, { stories: [{ id: 'TEST-STORY', agentRole: 'typescript-engineer' }] });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/only pre-existing baseline errors/);
  });

  it('FAILS when the story introduces a genuinely NEW error, and does not falsely blame the pre-existing one', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'legacy.ts'), 'const x: number = "not a number";\n');
    const baselineSha = commitAll(dir, 'baseline with pre-existing error');
    writeFileSync(join(dir, 'src', 'story-work.ts'), 'const y: number = "also broken";\n');

    const result = runStoryTscGate(dir, baselineSha, { stories: [{ id: 'TEST-STORY', agentRole: 'typescript-engineer' }] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/TypeScript errors after story completed/);
  });

  it('FAILS on ANY error when no baseline SHA file exists (greenfield fallback preserved)', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'broken.ts'), 'const z: number = "broken";\n');
    commitAll(dir, 'single commit, no baseline tracking');

    const result = runStoryTscGate(dir, null, { stories: [{ id: 'TEST-STORY', agentRole: 'typescript-engineer' }] });
    expect(result.exitCode).toBe(1);
  });

  it('still skips test-engineer-role stories entirely (pre-existing behavior preserved)', () => {
    const dir = makeGitFixture();
    writeFileSync(join(dir, 'src', 'broken.ts'), 'const z: number = "broken";\n');
    commitAll(dir, 'commit');

    const result = runStoryTscGate(dir, null, { stories: [{ id: 'TEST-STORY', agentRole: 'test-engineer' }] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('EXIT_CODE:0');
  });
});

describe('story_tsc_gate — source invariants', () => {
  const fnBody = extractStoryTscGate();

  it('reads the baseline SHA from phase-baseline-sha.txt', () => {
    expect(fnBody).toContain('phase-baseline-sha.txt');
  });

  it('uses git worktree for the baseline comparison', () => {
    expect(fnBody).toContain('git -C "$PROJECT_ROOT" worktree add');
  });

  it('symlinks node_modules into the worktree (worktree checkouts omit gitignored dirs)', () => {
    expect(fnBody).toContain('ln -s "$PROJECT_ROOT/node_modules"');
  });

  it('removes the temporary worktree after use', () => {
    expect(fnBody).toContain('git -C "$PROJECT_ROOT" worktree remove');
  });

  it('caches the baseline error set keyed by SHA', () => {
    expect(fnBody).toMatch(/tsc-baseline-errors-.*\.txt/);
  });
});
