/**
 * STEP 3.2 MERGES EACH LANE BRANCH BACK, AND ITS DIAGNOSIS HAS TO NAME THE REAL CAUSE.
 *
 * The real merge uses `-X ours`, which resolves a genuinely conflicting hunk in favour of the
 * TARGET branch — silently, exit 0, no "CONFLICT" anywhere in git's output. Every downstream gate
 * only ever sees the post-merge diff, so content dropped that way can never be caught. The
 * merge-tree guard in front of it is therefore load-bearing, and the first test proves both halves
 * of that: what -X ours does, and that the guard sees it.
 *
 * The second failure is that an unresolvable target announces nothing. An unreadable HEAD with no
 * configured baseline leaves the target branch EMPTY, and the empty side of a git range silently
 * defaults to HEAD — so every check downstream returns a sensible number and passes. A detached
 * HEAD is the same shape: --abbrev-ref returns the literal string "HEAD", which is not a branch.
 *
 * Both then merge onto a detached HEAD. The merge commit is referenced by no branch, so the lane's
 * work is unreachable at the next checkout, and the next phase — which recreates lane branches from
 * HEAD — inherits nothing. Every step reports success while the work is discarded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'merge-back-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

/** main and wt-primary each changing the SAME line — the shape -X ours resolves away. */
function divergedRepo(): string {
  const dir = join(work, 'repo');
  spawnSync('git', ['init', '--quiet', '-b', 'main', dir]);
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-q', '-b', 'wt-primary');
  writeFileSync(join(dir, 'f.txt'), 'a\nAGENT\nc\n');
  git(dir, 'commit', '-qam', 'agent');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'a\nMAIN\nc\n');
  git(dir, 'commit', '-qam', 'main');
  return dir;
}

/** The target-branch validation, lifted from the script and run as the script runs it. */
function validateTarget(repo: string): { code: number; text: string } {
  const src = readFileSync(ORCH, 'utf8');
  const start = src.indexOf('    # THE TARGET MUST BE A REAL BRANCH');
  expect(start, 'the target-branch validation is gone — this test is measuring nothing')
    .toBeGreaterThan(-1);
  const end = src.indexOf('MERGE_FAILED=false', start);
  const block = src.slice(start, end);

  const r = spawnSync('bash', ['-c',
    `set -o pipefail
     _merge_git_root=${JSON.stringify(repo)}
     PHASE=test
     error() { echo "ERROR: $*"; }
     _merge_current_branch=$(git -C "$_merge_git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "\${JIRA_BASELINE_BRANCH:-}")
${block}
     echo "REACHED_MERGE"`,
  ], { encoding: 'utf8', env: { ...process.env, JIRA_BASELINE_BRANCH: '' } });
  return { code: r.status ?? -1, text: `${r.stdout}${r.stderr}` };
}

describe('the merge-back says what actually stopped it', () => {
  it('the guard in front of -X ours is load-bearing, not decorative', () => {
    const dir = divergedRepo();

    // The guard sees the conflict.
    const mt = git(dir, 'merge-tree', '--write-tree', '--name-only', 'main', 'wt-primary');
    expect(mt.status, 'merge-tree did not flag a genuinely conflicting merge').not.toBe(0);
    expect(mt.stdout, 'merge-tree did not name the conflicting file').toContain('f.txt');

    // And this is what it is protecting against: -X ours exits 0 and keeps the target's line.
    const merged = git(dir, 'merge', '--no-ff', '-X', 'ours', 'wt-primary', '-m', 'm');
    expect(merged.status, '-X ours no longer exits 0 on a conflict — re-derive the guard').toBe(0);
    expect(readFileSync(join(dir, 'f.txt'), 'utf8'),
      'the agent’s change survived, so this fixture no longer reproduces the silent discard',
    ).toContain('MAIN');
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).not.toContain('AGENT');
  });

  it('refuses, naming the target, when HEAD is detached', () => {
    const dir = divergedRepo();
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    const { code, text } = validateTarget(dir);
    expect(text, 'it proceeded to merge onto a detached HEAD, where the commits reference nothing')
      .not.toContain('REACHED_MERGE');
    expect(code, 'a detached HEAD did not stop the merge').not.toBe(0);
    expect(text, 'the operator is not told the target could not be resolved')
      .toMatch(/cannot resolve a branch/i);
    expect(text, 'it still blames the lane for having no commits')
      .not.toMatch(/no new commits/i);
  });

  it('says the work is intact, because it is', () => {
    // The false diagnosis sent the investigation at the agent. The lane branch and its commits are
    // untouched by this failure and the message has to say so.
    const dir = divergedRepo();
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    const { text } = validateTarget(dir);
    expect(text).toMatch(/intact|nothing was discarded/i);

    expect(git(dir, 'rev-list', '--count', 'wt-primary').stdout.trim(),
      'the lane branch lost commits',
    ).not.toBe('0');
  });

  it('proceeds when the target really is a branch', () => {
    // Guard against the fix being too strict — a refusal on a healthy repo blocks every run.
    const { code, text } = validateTarget(divergedRepo());
    expect(text, 'a healthy repository was refused').toContain('REACHED_MERGE');
    expect(code).toBe(0);
  });

  it('an empty target silently means HEAD rather than failing', () => {
    // WHY THE VALIDATION HAS TO COME FIRST. An empty branch name does not make git complain: the
    // empty side of a range defaults to HEAD, so every check downstream succeeds and reports a
    // sensible-looking count. The merge then runs with an empty target — detached-HEAD semantics,
    // where the merge commit is referenced by no branch and the lane's work is lost at the next
    // checkout. Nothing in the sequence ever says the target was unresolvable.
    const dir = divergedRepo();
    const count = git(dir, 'rev-list', '--count', '..wt-primary');
    expect(count.status, 'an empty range now errors — the silent-substitution premise is gone').toBe(0);
    expect(count.stdout.trim(), 'the empty side no longer defaults to HEAD').toBe(
      git(dir, 'rev-list', '--count', 'HEAD..wt-primary').stdout.trim());
  });
});
