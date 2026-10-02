/**
 * A CODELINE IS CUT FROM ITS OWN BASELINE — NEVER FROM WHATEVER ITS CHECKOUT HAPPENS TO BE ON.
 *
 * 2026-10-02, AMSD-2974: the project declares one baseline (develop) for four codelines; cx-shared's
 * default branch is master and it has no develop, and next.gotransit.com's checkout sits on an old
 * story branch (bugfix/AI-AMSD-1919). The worktree lane cut its worktree from the checkout's HEAD.
 * codeline_baseline_ref answers, from LOCAL refs only (no remote is contacted): the declared branch
 * when the codeline has it (origin/<b>, else <b>), otherwise the codeline's own default branch
 * (refs/remotes/origin/HEAD). Nothing found → empty, never a guess.
 *
 * EXECUTED: the real codeline_baseline_ref (lib/git-ops.sh) against real git repositories.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');
const work = mkdtempSync(join(tmpdir(), 'baseline-ref-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A local "origin" with the given branches (default first), cloned; the clone checks out `onBranch`. */
function codeline(name: string, branches: string[], onBranch?: string) {
  const origin = join(work, `${name}-origin`);
  execFileSync('git', ['init', '-q', '-b', branches[0], origin]);
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
  for (const b of branches.slice(1)) git(origin, 'branch', b);
  const clone = join(work, name);
  execFileSync('git', ['clone', '-q', origin, clone]);
  if (onBranch) { git(clone, 'checkout', '-q', '-b', onBranch); git(clone, 'commit', '-q', '--allow-empty', '-m', 'old story'); }
  return clone;
}

function ref(root: string, declared: string) {
  const r = spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }; source ${JSON.stringify(LIB)}; codeline_baseline_ref ${JSON.stringify(root)} ${JSON.stringify(declared)}`], { encoding: 'utf8' });
  return r.stdout.trim();
}

describe('codeline_baseline_ref', () => {
  it('the declared branch, when the codeline has it — whatever the checkout is on', () => {
    const site = codeline('site', ['develop', 'master'], 'bugfix/old-story');
    expect(ref(site, 'develop')).toBe('origin/develop');
  });

  it('the codeline\'s own default branch when it has no declared branch', () => {
    const lib = codeline('lib', ['master']);
    expect(ref(lib, 'develop')).toBe('origin/master');
  });

  it('a local branch is used when the codeline has no remote copy of it', () => {
    const lib = codeline('local-only', ['master']);
    git(lib, 'branch', 'develop');
    expect(ref(lib, 'develop')).toBe('develop');
  });

  it('nothing found: empty, never a guess', () => {
    const bare = join(work, 'no-origin'); execFileSync('git', ['init', '-q', '-b', 'trunk', bare]);
    git(bare, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(ref(bare, 'develop')).toBe('');
  });
});
