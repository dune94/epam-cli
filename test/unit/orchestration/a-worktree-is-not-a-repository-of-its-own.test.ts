/**
 * A WORKTREE IS NOT A REPOSITORY OF ITS OWN.
 *
 * Live AMSD-2974 run 5 (2026-10-09): discovery chose cx-shared-line-7.x as a fifth codeline. It is a git worktree of
 * cx-shared — one the pipeline itself made in the estate root for release-line sibling builds — and discovery's
 * manifest listed it beside cx-shared as a separate repository, because its .git exists (as a FILE naming
 * cx-shared/.git/worktrees/...). As a lane it would collide with cx-shared on the story branch and work the 7.x
 * back-port twice. Every one of twelve earlier runs chose the same four codelines.
 *
 * The manifest lists a repository once: a directory whose .git file names another listed repository's worktrees is
 * that repository's checkout. Read from the file — no name pattern. A standalone repository, and a worktree of a
 * repository OUTSIDE the estate, are still candidates.
 *
 * EXECUTED: the real buildRepoManifest (lib/codeline-discovery.js) on real repositories made with real git.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildRepoManifest } = require(join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
};
function repo(at: string) {
  mkdirSync(at, { recursive: true }); git(at, 'init', '-q', '-b', 'master');
  writeFileSync(join(at, 'package.json'), '{}'); git(at, 'add', '-A'); git(at, 'commit', '-qm', 'base');
}

describe('a worktree is not a repository of its own', () => {
  it('the worktree of a listed repository is not listed; the repository is, once', () => {
    const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
    repo(join(root, 'cx-shared')); repo(join(root, 'next.gotransit.com'));
    git(join(root, 'cx-shared'), 'worktree', 'add', '-q', '--detach', join(root, 'cx-shared-line-7.x'), 'HEAD');
    const names = buildRepoManifest(root).map((r: any) => r.name).sort();
    expect(names).toEqual(['cx-shared', 'next.gotransit.com']);
  });

  it('a worktree of a repository OUTSIDE the estate is still a candidate — it is the only checkout here', () => {
    const outside = mkdtempSync(join(tmpdir(), 'elsewhere-')); dirs.push(outside);
    const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
    repo(join(outside, 'lib'));
    git(join(outside, 'lib'), 'worktree', 'add', '-q', '--detach', join(root, 'lib-checkout'), 'HEAD');
    repo(join(root, 'site'));
    expect(buildRepoManifest(root).map((r: any) => r.name).sort()).toEqual(['lib-checkout', 'site']);
  });

  it('an estate with no worktrees is listed exactly as before', () => {
    const root = mkdtempSync(join(tmpdir(), 'estate-')); dirs.push(root);
    repo(join(root, 'a')); repo(join(root, 'b')); mkdirSync(join(root, 'not-a-repo'));
    expect(buildRepoManifest(root).map((r: any) => r.name).sort()).toEqual(['a', 'b']);
  });
});
