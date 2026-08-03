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
 * That fix gated on `$main_stories` non-empty, but ALSO kept requiring
 * worktree-bound stories to exist — introducing a second, opposite bug
 * (found live 2026-08-02, AMSD-2041 Writer Retest): a phase with ONLY
 * main-branch stories and ZERO worktree lanes never got committed at all.
 * `implement_story` marks the story completed in the PRD regardless, so the
 * missing commit went unnoticed until the brownfield repro-gate (which
 * diffs committed HEAD, never the working tree) permanently blocked with
 * "no test file accompanies the change" — every retry re-implemented the
 * same real fix and never landed it. Fix: drop the worktree-existence
 * requirement entirely — gate on `$main_stories` non-empty (Step 8's own
 * condition) and a dirty tree, regardless of whether any worktree lane
 * also exists this phase.
 *
 * Real git repos throughout, no mocking.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
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
  const start = orchSrc.indexOf('# Step 1.5: Auto-commit main-branch story output.');
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
    // Ticket-ID-first (found live 2026-08-02, same day: a client repo's
    // commitlint rejects a bare "chore:" subject with no ticket ID as the
    // first token — see repro-test-writer-commit-message-format.test.ts for
    // the sibling defect this same fix shape addresses).
    expect(log).toBe('STORY-REAL: auto-commit main-branch output (phase core)');
  });

  it('REPRODUCES the live incident and confirms the fix: commits real main-branch output even with ZERO worktree-bound stories (pure main-only phase)', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);
    // A real brownfield fix + its test file, exactly the AMSD-2041 shape:
    // agentGroup="main", no primary/independent lanes at all this phase.
    writeFileSync(join(repo, 'src-fix.ts'), 'export const fixed = true;\n');
    writeFileSync(join(repo, 'src-fix.spec.ts'), 'test("fixed", () => {});\n');

    const { stdout, exitCode } = runStep9(repo, {
      mainStories: 'STORY-X',
      primaryStories: '',
      independentStories: '',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Committed main-branch output/);
    expect(currentBranchHead(repo)).not.toBe(before);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status.trim()).toBe(''); // clean — committed, not left dangling for repro-gate to never see
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

/**
 * The ticket-ID-first message (see step9's own comment above) is a
 * best-effort default, not a guarantee every possible client repo's
 * commit-msg hook accepts it — this pipeline cannot and must not hardcode
 * a specific hook's exact rule set per project. What it must do, for ANY
 * hook and ANY rejection reason, is surface the hook's real output AND
 * not misreport a genuine rejection as "nothing to commit" (which
 * previously looked identical to a truly clean tree — actively
 * misleading, since files remain staged in one case but not the other).
 */
describe('Step 9 auto-commit — surfaces the REAL hook output on ANY commit rejection, distinct from "nothing to commit"', () => {
  it('a hook that rejects for a completely unrelated, made-up reason logs the real message and does NOT claim "nothing to commit"', () => {
    const repo = makeRepo();
    const before = currentBranchHead(repo);
    writeFileSync(join(repo, 'src-output.ts'), 'export const real = true;\n');
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'commit-msg'),
      `#!/usr/bin/env bash\necho "ARBITRARY_REJECTION_MARKER_71ae: needs a work-order tag" >&2\nexit 1\n`,
    );
    chmodSync(join(hooksDir, 'commit-msg'), 0o755);

    const { stdout, exitCode } = runStep9(repo, {
      mainStories: 'STORY-REAL',
      primaryStories: 'STORY-A',
      independentStories: '',
    });

    expect(exitCode).toBe(0); // Step 9 itself doesn't abort the phase on a rejected commit
    expect(stdout).toMatch(/ARBITRARY_REJECTION_MARKER_71ae/);
    expect(stdout).not.toMatch(/Nothing new to commit \(working tree already clean\)/);
    expect(currentBranchHead(repo)).toBe(before); // nothing landed
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status).toMatch(/src-output\.ts/); // still staged, not lost
  });
});
