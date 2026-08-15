/**
 * A RESET NEVER ORPHANS A COMMIT.
 *
 * Live failure, run 20260814T213253Z (metrolinx, AMSD-2041). The writer finished, its
 * work passed `npm run test` AND `tsc`, and the pipeline committed it:
 *
 *     Committed 4 file(s) for AMSD-2041
 *     [SUCCESS] [tsc-gate] AMSD-2041: the project's type check passed
 *
 * The reviewer then requested changes over ONE inconsistent dependency declaration.
 * The ladder was already at its top rung, Step 3.6 escalated, and the retry called
 * ensure_story_branch, which does:
 *
 *     git checkout -B <branch> origin/<baseline>
 *     git reset --hard origin/<baseline>
 *     git clean -fd
 *
 * That moved the branch pointer back to origin/develop and orphaned the commit. The
 * work survived only in the reflog — where nothing in the pipeline looks, and where a
 * `git gc` would eventually remove it. The log line said "freshly based on
 * origin/develop", which reads like hygiene, not like deletion.
 *
 * The same shape destroyed FINISHED gotransit work the same day
 * (commits e780a8b7 / 45c82f2a / 20c2cea4), recovered by hand from the reflog.
 *
 * THE REQUIREMENT: the hard reset is legitimate and stays. What is NOT legitimate is
 * doing it SILENTLY and UNRECOVERABLY. Before the branch pointer moves, any commit
 * that would stop being reachable must be preserved under a real ref and named in the
 * log. Recovery must never depend on the reflog.
 *
 * This test asserts against a REAL git repository, not a mock: the defect is entirely
 * a property of what git does to refs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_OPS = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');

function sh(cwd: string, cmd: string) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

/**
 * Build an origin + clone, put a story commit on the branch, then run the real
 * ensure_story_branch over it — exactly the sequence the live run performed.
 */
function runEnsureStoryBranch() {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-'));
  const origin = join(dir, 'origin');
  const repo = join(dir, 'repo');

  sh(dir, `
    git init -q --bare "${origin}"
    git init -q "${repo}"
    cd "${repo}"
    git config user.email t@t && git config user.name t
    echo base > base.txt && git add -A && git commit -qm base
    git branch -M develop
    git remote add origin "${origin}"
    git push -q origin develop
    git checkout -qb bugfix/AI-AMSD-2041
  `);

  // The story's completed, committed work — the thing that must not vanish.
  writeFileSync(join(repo, 'feature.ts'), 'export const livePreview = true;\n');
  sh(repo, `git add -A && git commit -qm "AMSD-2041: story complete (1 file)"`);
  const storySha = sh(repo, `git rev-parse HEAD`).trim();

  const out = sh(repo, `
    set -uo pipefail
    success() { echo "SUCCESS: $*"; }
    warning() { echo "WARNING: $*"; }
    log()     { echo "$*"; }
    error()   { echo "ERROR: $*"; }
    _provision_epam_plugin_config() { :; }
    perimeter_apply() { :; }
    EPAM_BROWNFIELD=1
    EPAM_BRANCH_PREFIX="bugfix/"
    . "${GIT_OPS}"
    ensure_story_branch "${repo}" "AMSD-2041" "develop"
  `);

  // Is the story commit still reachable from ANY ref? The reflog does not count.
  const reachable = sh(repo, `git for-each-ref --contains ${storySha} --format='%(refname)' 2>/dev/null`).trim();
  const headAt = sh(repo, `git rev-parse HEAD`).trim();
  const baseAt = sh(repo, `git rev-parse origin/develop`).trim();

  rmSync(dir, { recursive: true, force: true });
  return { out, storySha, reachable, headAt, baseAt };
}

describe('a reset never orphans a commit', () => {
  it('preserves the committed story work under a real ref before hard-resetting', () => {
    const { out, reachable, headAt, baseAt } = runEnsureStoryBranch();

    // The reset itself still happens — that behaviour is wanted and unchanged.
    expect(headAt).toBe(baseAt);

    // ...but the work is still reachable without the reflog.
    expect(
      reachable,
      `the story commit is reachable from NO ref — it exists only in the reflog.\nOutput was:\n${out}`,
    ).not.toBe('');

    // And the operator was told, by name, where it went.
    expect(out).toMatch(/rescue/i);
  });

  it('says nothing and creates no ref when there is nothing to lose', () => {
    // Same function, but the branch has no commits above the baseline: the ordinary
    // first-attempt case, which must stay silent rather than littering rescue refs.
    const dir = mkdtempSync(join(tmpdir(), 'orphan-clean-'));
    const origin = join(dir, 'origin');
    const repo = join(dir, 'repo');
    sh(dir, `
      git init -q --bare "${origin}"
      git init -q "${repo}"
      cd "${repo}"
      git config user.email t@t && git config user.name t
      echo base > base.txt && git add -A && git commit -qm base
      git branch -M develop
      git remote add origin "${origin}"
      git push -q origin develop
    `);
    const out = sh(repo, `
      set -uo pipefail
      success() { echo "SUCCESS: $*"; }
      warning() { echo "WARNING: $*"; }
      log()     { echo "$*"; }
      error()   { echo "ERROR: $*"; }
      _provision_epam_plugin_config() { :; }
      perimeter_apply() { :; }
      EPAM_BROWNFIELD=1
      EPAM_BRANCH_PREFIX="bugfix/"
      . "${GIT_OPS}"
      ensure_story_branch "${repo}" "AMSD-2041" "develop"
    `);
    const rescueRefs = sh(repo, `git for-each-ref --format='%(refname)' | grep -i rescue || true`).trim();
    rmSync(dir, { recursive: true, force: true });

    expect(rescueRefs).toBe('');
    expect(out).not.toMatch(/rescue/i);
  });

  it('the rescue is not a comment — the reset path really calls it', () => {
    // Guards against the fix living only in a docstring: the preservation must sit
    // BEFORE the branch pointer moves, or it preserves nothing.
    const src = readFileSync(GIT_OPS, 'utf8');
    const fn = src.slice(src.indexOf('ensure_story_branch() {'));
    const body = fn.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const rescueAt = body.search(/rescue/i);
    const checkoutAt = body.indexOf('checkout -B');
    expect(rescueAt).toBeGreaterThan(-1);
    expect(checkoutAt).toBeGreaterThan(-1);
    expect(rescueAt).toBeLessThan(checkoutAt);
  });
});
