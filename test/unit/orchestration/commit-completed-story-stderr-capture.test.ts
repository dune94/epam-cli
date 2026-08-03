/**
 * commit_completed_story() previously discarded git commit's real stderr
 * (>/dev/null 2>&1) on failure, so a rejected commit — e.g. a client repo's
 * own husky/lint-staged pre-commit hook failing — surfaced only as a generic
 * "Commit failed for X — work remains staged/uncommitted" with no way to
 * tell WHY. Found live 2026-08-01 investigating AMSD-2041: a real, verified-
 * correct, tsc-passing fix sat staged/uncommitted with no diagnosable cause.
 *
 * Fix: capture real `git commit ... 2>&1` output and log it alongside the
 * warning. This test proves the failure path surfaces the hook's actual
 * output, using a real (non-mocked) failing pre-commit hook.
 *
 * Real git repo throughout, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// commit_completed_story() moved to lib/git-ops.sh (2026-08-02 git-ops
// consolidation) — single source of truth shared by claude.sh,
// codemie-claude.sh, and run-agent-orchestration.sh.
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^\\s*${name}\\(\\)\\s*\\{`, 'm');
  const defMatch = defRe.exec(claudeSrc);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

const FN_BODY = extractFunctionBody('commit_completed_story');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'commit-stderr-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/hello.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });
  return repo;
}

function runCommit(repo: string): string {
  const scriptPath = join(repo, '..', 'run.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      `PROJECT_ROOT=${JSON.stringify(repo)}`,
      `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts'))}`,
      'SKIP_SECRET_SCAN=true',
      'log() { echo "LOG: $*"; }',
      'warning() { echo "WARN: $*"; }',
      FN_BODY,
      'commit_completed_story "SKY-TEST"',
    ].join('\n'),
  );
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
  return (result.stdout || '') + (result.stderr || '');
}

describe('commit_completed_story — real git commit failure surfaces real stderr', () => {
  it('logs the pre-commit hook\'s actual rejection message, not a generic failure line', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.git/hooks'), { recursive: true });
    const hookPath = join(repo, '.git/hooks/pre-commit');
    writeFileSync(
      hookPath,
      '#!/usr/bin/env bash\necho "DISTINCTIVE_HOOK_REJECTION: lint failed on src/hello.ts" >&2\nexit 1\n',
    );
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repo, 'src/hello.ts'), 'export const x = 2;\n');
    const out = runCommit(repo);

    expect(out).toContain('Commit failed for SKY-TEST');
    expect(out).toContain('DISTINCTIVE_HOOK_REJECTION: lint failed on src/hello.ts');

    // Work must remain staged, not lost, on a real commit failure.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' });
    expect(staged).toContain('src/hello.ts');
  });

  it('commits cleanly and logs no failure when there is no rejecting hook', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src/hello.ts'), 'export const x = 2;\n');
    const out = runCommit(repo);

    expect(out).toContain('Committed 1 file(s) for SKY-TEST');
    expect(out).not.toContain('Commit failed');

    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: repo, encoding: 'utf8' });
    expect(log).toContain('SKY-TEST: story complete');
  });
});
