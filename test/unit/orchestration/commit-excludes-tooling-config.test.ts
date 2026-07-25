/**
 * Our own tooling config must never be committed into a client repo.
 *
 * Found in the metrolinx commit e60b7bb, then REPRODUCED by mock1 (d3df3f9):
 * the story-completion commit contained .epam/contract-generation.json,
 * .epam/dependency-check.json and .epam/known-fixes.json alongside the actual
 * one-line fix. Those are epam-cli's own dependency-check/contract manifests. A
 * client repo must never carry them — a standing rule, and separately they bury
 * the real deliverable in noise.
 *
 * commit_completed_story() already stages with a pathspec exclusion list
 * (orchestrations/logs, node_modules, build, .next). .epam was simply missing
 * from it, so `git add -A` swept it in.
 *
 * NOT excluded here: package-lock.json. mock1 committed 1831 lines of it, which is
 * noise — but package.json changed in the same commit, so the lockfile is arguably
 * a legitimate part of that change, and dropping a lockfile while its manifest
 * moves would break reproducible installs. Excluding it needs a deliberate
 * decision about dependency changes, not a quiet pathspec.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Extract the staging pathspec from commit_completed_story and run it for real. */
function stageInSandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'commit-excl-')); dirs.push(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 't@t.com');
  git('config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'hello.ts'), 'export const x = 1;\n');
  git('add', '-A'); git('commit', '-m', 'baseline', '--quiet');

  // The real deliverable, plus the tooling config that should never be committed.
  writeFileSync(join(repo, 'src', 'hello.ts'), 'export const x = 2;\n');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  for (const f of ['dependency-check.json', 'contract-generation.json', 'known-fixes.json']) {
    writeFileSync(join(repo, '.epam', f), '{}\n');
  }

  // Pull the exact pathspec the pipeline uses, so this tracks the real code.
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const m = src.match(/git -C "\$_commit_root" add -A -- \\\n([\s\S]*?)\n\s*2>\/dev\/null/);
  expect(m, 'staging pathspec not found in commit_completed_story').toBeTruthy();
  const specs = (m![1].match(/':![^']*'/g) || []).map(s => s.replace(/'/g, ''));

  execFileSync('git', ['add', '-A', '--', ...specs], { cwd: repo, encoding: 'utf8' });
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

describe('the pathspec fallback cannot reintroduce it', () => {
  it('unstages .epam unconditionally, whichever add path ran', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    // The fallback `git add -A` carries no pathspec, so exclusion alone is not
    // enough — a failure of the pathspec form would put .epam straight back.
    expect(src, 'no unconditional unstage — the no-pathspec fallback reintroduces .epam')
      .toMatch(/reset -q -- '\.epam'/);
  });
});

describe('story commit excludes our own tooling config', () => {
  const staged = stageInSandbox();

  it('stages the actual deliverable', () => {
    expect(staged).toContain('src/hello.ts');
  });

  it('does NOT stage .epam/ — epam-cli config must not enter a client repo', () => {
    const leaked = staged.filter(f => f.startsWith('.epam/'));
    expect(leaked,
      'our dependency-check/contract manifests were committed into the client repo, ' +
      'burying the real fix and violating the no-client-repo-writes rule')
      .toEqual([]);
  });
});
