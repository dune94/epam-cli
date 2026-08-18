/**
 * A REPOSITORY WITH NO REMOTE NEVER GOT A STORY BRANCH, SO THE WRITE WINDOW NEVER OPENED.
 *
 * ensure_story_branch begins with `git fetch origin <baseline>` and returns 1 the moment it
 * fails. A repository with no `origin` — every local estate, mock3 included — therefore never
 * reached `checkout -B`, and the writer worked directly on the baseline branch. It looked
 * harmless: one warning line, and the run carried on.
 *
 * It stopped being harmless when the write perimeter became generic. perimeter_apply — the call
 * that REOPENS a repository once it is on a story branch — sits at the end of ensure_story_branch,
 * past the early return. So a sealed repository with no remote could never be unsealed, and the
 * writer would be locked out of the very repository it was asked to change.
 *
 * THE START POINT IS THE THING THAT VARIES, not the procedure. With a remote, the baseline is
 * fetched and `origin/<baseline>` is the start point, exactly as before. Without one, the LOCAL
 * baseline branch is. Nothing else about the reset, the rescue ref, or the perimeter changes, and
 * a repository with neither still fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const GITOPS = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const PERIM = join(ROOT, 'orchestrations/scripts/lib/codeline-write-perimeter.sh');

const git = (dir: string, ...args: string[]) =>
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** Source both libraries with the log helpers git-ops.sh expects, then run a snippet. */
function sh(script: string, env: Record<string, string> = {}) {
  const preamble = [
    'warning() { echo "WARN: $*"; }',
    'error()   { echo "ERROR: $*"; }',
    'success() { echo "OK: $*"; }',
    'info()    { echo "INFO: $*"; }',
    `. "${PERIM}"`,
    `. "${GITOPS}"`,
  ].join('\n');
  return spawnSync('bash', ['-c', `${preamble}\n${script}`], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_BROWNFIELD: '1', JIRA_BASELINE_BRANCH: 'develop', ...env },
  });
}

const writable = (p: string) => (statSync(p).mode & 0o200) !== 0;

let dir: string;
let repo: string;

/** A repository on `develop`, with one tracked source file. */
function makeRepo(at: string) {
  mkdirSync(at, { recursive: true });
  mkdirSync(join(at, 'src'));
  writeFileSync(join(at, 'src/app.ts'), 'export const x = 1;\n');
  git(at, 'init', '-q', '-b', 'develop');
  git(at, 'add', '-A');
  git(at, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return at;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-branch-'));
  repo = makeRepo(join(dir, 'codeline'));
});

afterEach(() => {
  spawnSync('bash', ['-c', `. "${PERIM}"; perimeter_unlock "${repo}"`]);
  rmSync(dir, { recursive: true, force: true });
});

describe('a repo with no remote never got a story branch', () => {
  it('CREATES THE STORY BRANCH WITH NO REMOTE — off the local baseline', () => {
    const r = sh(`ensure_story_branch "${repo}" "MOCK3-1" "develop"`);
    expect(r.status, `ensure_story_branch failed: ${r.stdout}${r.stderr}`).toBe(0);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
      'the repository is still on the baseline — no story branch was created').toBe('AI-MOCK3-1');
  });

  it('OPENS THE WRITE WINDOW — a sealed repository is writable once on its story branch', () => {
    spawnSync('bash', ['-c', `. "${PERIM}"; perimeter_seal "${repo}"`]);
    expect(writable(join(repo, 'src/app.ts')), 'the seal did not take, so this proves nothing').toBe(false);

    const r = sh(`ensure_story_branch "${repo}" "MOCK3-1" "develop"`);
    expect(r.status).toBe(0);
    expect(writable(join(repo, 'src/app.ts')),
      'the writer is locked out of the repository it was asked to change').toBe(true);
  });

  it('STILL PREFERS THE REMOTE WHEN THERE IS ONE — unchanged for client estates', () => {
    // A real origin, so the fetch path is exercised rather than skipped.
    const origin = makeRepo(join(dir, 'origin'));
    git(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
    git(repo, 'remote', 'add', 'origin', origin);
    // A commit that exists only on the remote: if the start point were the LOCAL baseline, it
    // could not be reachable from the new branch.
    writeFileSync(join(origin, 'src/remote-only.ts'), 'export const y = 2;\n');
    git(origin, 'add', '-A');
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'remote-only');

    const r = sh(`ensure_story_branch "${repo}" "MOCK3-2" "develop"`);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(git(repo, 'log', '--oneline').stdout,
      'the story branch was not based on the remote baseline').toMatch(/remote-only/);
  });

  it('a repository with neither a remote nor the baseline branch still fails', () => {
    const r = sh(`ensure_story_branch "${repo}" "MOCK3-3" "no-such-branch"`);
    expect(r.status, 'a branch that exists nowhere was treated as a valid start point').toBe(1);
  });
});
