/**
 * A STORY BRANCH IS BASED ON THE CODELINE'S OWN BASELINE — the project's declared branch where the codeline has it,
 * else the codeline's own default branch.
 *
 * Live AMSD-2974, 2026-10-09: the project declares JIRA_BASELINE_BRANCH=develop; cx-shared's origin has only master.
 * ensure_story_branch fetched origin/develop, failed, warned "proceeding on current branch state" and left cx-shared on
 * bugfix/AI-AMSD-2974 carrying earlier runs' commits — the fresh run's detective read them as existing code ("make the
 * already-partial toast work explicit"). codeline_baseline_ref (lib/git-ops.sh) already knew the answer (origin/HEAD)
 * and was not asked.
 *
 * EXECUTED: lib/git-ops.sh ensure_story_branch on real repositories with a bare origin.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

/** origin with `branches`; a clone on a stale story branch carrying an old commit. */
function estate(branches: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'baseline-')); dirs.push(d);
  const seed = join(d, 'seed'); spawnSync('git', ['init', '-q', '-b', branches[0], seed]);
  writeFileSync(join(seed, 'a.txt'), 'base\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base');
  for (const b of branches.slice(1)) git(seed, 'branch', b);
  const origin = join(d, 'origin.git'); spawnSync('git', ['clone', '-q', '--bare', seed, origin]);
  const cl = join(d, 'cl'); spawnSync('git', ['clone', '-q', origin, cl]);
  git(cl, 'checkout', '-q', '-b', 'bugfix/AI-S-1'); writeFileSync(join(cl, 'a.txt'), 'old run work\n'); git(cl, 'commit', '-qam', 'old run');
  return { cl, base: git(cl, 'rev-parse', `origin/${branches[0]}`).stdout.trim() };
}
const ensure = (cl: string, declared: string) => spawnSync('bash', ['-c', `set -u
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; info(){ echo "INFO $*"; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }
perimeter_apply(){ :; }
EPAM_BROWNFIELD=1 EPAM_BRANCH_PREFIX=bugfix/
. ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}
ensure_story_branch ${JSON.stringify(cl)} S-1 ${JSON.stringify(declared)}; echo "RC=$?"`], { encoding: 'utf8' });

describe('ensure_story_branch picks the codeline\'s own baseline', () => {
  it('the codeline has the declared branch: based on it, as before', () => {
    const { cl } = estate(['develop', 'master']);
    const r = ensure(cl, 'develop');
    expect(r.stdout, r.stdout).toMatch(/RC=0/);
    expect(git(cl, 'rev-parse', 'HEAD').stdout.trim()).toBe(git(cl, 'rev-parse', 'origin/develop').stdout.trim());
  });
  it('the codeline lacks the declared branch: based on its own default (origin/HEAD), never left on the stale branch', () => {
    const { cl, base } = estate(['master']);
    const r = ensure(cl, 'develop');
    expect(r.stdout, r.stdout).toMatch(/RC=0/);
    expect(git(cl, 'rev-parse', 'HEAD').stdout.trim(), r.stdout).toBe(base);
    expect(git(cl, 'branch', '--show-current').stdout.trim()).toBe('bugfix/AI-S-1');
    expect(r.stdout).toMatch(/origin\/master/);
    // The old run's commit is pinned, not lost.
    expect(git(cl, 'branch', '--list', 'epam-rescue/*').stdout).toMatch(/epam-rescue\/S-1-/);
  });
  it('neither the declared branch nor a default exists: says so and does not move (unchanged)', () => {
    const { cl } = estate(['master']);
    git(cl, 'remote', 'set-head', 'origin', '-d');
    const before = git(cl, 'rev-parse', 'HEAD').stdout.trim();
    const r = ensure(cl, 'develop');
    expect(r.stdout).toMatch(/RC=1/);
    expect(git(cl, 'rev-parse', 'HEAD').stdout.trim()).toBe(before);
  });
});
