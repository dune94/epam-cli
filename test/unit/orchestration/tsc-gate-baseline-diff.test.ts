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
  // The baseline-delta logic lives in ONE place now — lib/tsc-baseline-gate.sh. It used to be
  // copy-pasted into this gate, claude.sh and eslint-baseline-gate.sh, each with its own tsc
  // regex and node_modules literal, so each failed open independently. story-guards.sh sources
  // it in the real script; the harness does the same.
  const LIB = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/lib/tsc-baseline-gate.sh'), 'utf8');
  const vStart = guardsSrc.indexOf('_get_vendor_dirs() {');
  const vendor = vStart < 0
    ? readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8')
        .match(/_get_vendor_dirs\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
    : guardsSrc.slice(vStart, guardsSrc.indexOf('\n}\n', vStart) + 2);
  return [guardsSrc.slice(hStart, hEnd), vendor, LIB, guardsSrc.slice(start, end)].join('\n');
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
  // The baseline worktree checks out tracked files only, so the vendored directories must be
  // symlinked in or the checker cannot resolve at baseline and every current failure looks new.
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.epam', 'dependency-check.json'),
    JSON.stringify({ vendorDirs: ['node_modules'] }));
  // The project declares HOW it verifies itself; the engine runs that declared command
  // rather than a compiler it named. A fixture that declares nothing is reported as
  // UNKNOWN by the gate, so the behaviour under test never fires.
  mkdirSync(join(dir, '.epam'), { recursive: true });
  // HOW ITS FAILURES ARE IDENTIFIED sits beside how they are produced. Without failurePattern
  // the parse is UNDECLARED and the delta declines to guess — it reports the full output rather
  // than subtracting against an empty set. That refusal is the fix: the old grep matched nothing
  // on an unrecognised dialect, subtracted nothing, and returned PASS. The identity omits the
  // COLUMN deliberately — editing a line above shifts columns, and a baseline keyed on column
  // reports every pre-existing error as new.
  writeFileSync(join(dir, '.epam', 'verification.json'), JSON.stringify({
    typecheck: {
      command: './node_modules/.bin/tsc --noEmit',
      failurePattern: '^([^(]+)\\((\\d+),(\\d+)\\): error ([A-Z0-9]+)',
      failureIdentity: '{1}:{2}:{4}',
    },
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

  // THE MECHANICS MOVED, THE REQUIREMENTS DID NOT. These described an inline block in
  // story_tsc_gate that was one of four copies; they now hold for lib/tsc-baseline-gate.sh.
  const libBody = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/lib/tsc-baseline-gate.sh'), 'utf8');

  it('reads the baseline SHA from phase-baseline-sha.txt', () => {
    expect(libBody).toContain('phase-baseline-sha.txt');
  });

  it('uses git worktree for the baseline comparison', () => {
    expect(libBody).toContain('worktree add --detach');
  });

  it('symlinks the DECLARED vendor directories into the worktree', () => {
    // Was: expect(fnBody).toContain('ln -s "$PROJECT_ROOT/node_modules"'). Naming one
    // ecosystem's directory is the hardcoding this conversion removed — WHICH directories are
    // vendored is the project's declaration (dependency-check.json vendorDirs). The requirement
    // is unchanged: worktree checkouts omit gitignored dirs, so without the symlink the checker
    // cannot resolve at baseline and every current failure is reported as new.
    expect(libBody).toContain('_get_vendor_dirs');
    expect(libBody).toMatch(/ln -s "\$_vd"/);
  });

  it('removes the temporary worktree after use', () => {
    expect(libBody).toContain('worktree remove --force');
  });

  it('caches the baseline error set keyed by SHA', () => {
    expect(libBody).toMatch(/baseline-failures-\$\{section\}-\$\{baseline_sha/);
  });
});
