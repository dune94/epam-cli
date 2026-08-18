/**
 * claude.sh IS THE CHILD PROCESS THAT ACTUALLY RUNS A STORY. A DEEP REVIEW FOUND IT IN GOOD SHAPE
 * — no embedded prompts, no vendor model literals, no extension-filtered diffs — WITH FIVE REAL
 * DEFECTS, ALL OF THE SAME FAMILY: SOMETHING REPORTED SUCCESS THAT HAD NOT SUCCEEDED.
 *
 * 1. `if CMD | tee ...; then` — twice. tee exits 0 essentially always, so the TC writer reported
 *    "TC generation complete" whatever it did, and the pre-phase assessment reported "completed"
 *    whether the agent ran, failed or timed out. The profiles.json validity check only runs on
 *    that success branch, so a failed agent skipped it entirely.
 *
 * 2. The selective worktree reset ran `git checkout <ref> -- .` and `git clean -fd -- .`, both
 *    under `2>/dev/null || true`. An unresolvable ref failed silently and the clean STILL RAN —
 *    deleting untracked work without restoring the tracked files. Proven by execution: the tree
 *    ends up holding the agent's modified content with its new files deleted, which is neither
 *    the baseline nor the attempt, and the log says "reset to <ref>".
 *
 * 3. Nine sites spelled the baseline `origin/${JIRA_BASELINE_BRANCH:-develop}`. On a codeline
 *    whose trunk is named anything else, every one of those diffs resolved nothing — and an empty
 *    diff reads downstream exactly like "this story changed nothing".
 *
 * 4. The pre-phase assessment's "restore backup" pointed at profiles.json.original — the canonical
 *    PRE-RUN base state — so recovering from a corrupted assessment discarded every skill note and
 *    augmentation the run had accumulated.
 *
 * 5. Whether a story counts as a test story was decided by `grep -c '\.test\.ts$'`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');

const src = () => readFileSync(CLAUDE, 'utf8');
const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'claude-sh-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});

/** Run the real _resolved_baseline_ref, lifted from the script. */
function resolveRef(repo: string, declared?: string): string {
  const fn = /^_resolved_baseline_ref\(\) \{[\s\S]*?\n\}/m.exec(src());
  expect(fn, 'the baseline resolver is gone — this test is measuring nothing').toBeTruthy();
  const r = spawnSync('bash', ['-c',
    `${fn![0]}\n${declared !== undefined ? `JIRA_BASELINE_BRANCH=${JSON.stringify(declared)}` : ''} `
    + `_resolved_baseline_ref ${JSON.stringify(repo)}`,
  ], { encoding: 'utf8' });
  return r.stdout.trim();
}

function repoOnBranch(branch: string): string {
  const dir = join(work, 'repo');
  spawnSync('git', ['init', '--quiet', '-b', branch, dir]);
  writeFileSync(join(dir, 'kept.txt'), 'tracked\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

describe('claude.sh reports what actually happened', () => {
  it('no `if CMD | tee` is left testing tee instead of the command', () => {
    const body = code();
    const bad = body.split('\n').filter((l) => /^\s*(el)?if .*\| tee /.test(l) && !/PIPESTATUS/.test(l));
    expect(bad.map((l) => l.trim()), 'a branch still tests tee’s exit status, which is always 0')
      .toEqual([]);
  });

  it('both tee sites read the command’s own status, at the right pipeline index', () => {
    // The TC writer is [writer, tee] -> PIPESTATUS[0]; the assessment is [echo, ai-run, tee] ->
    // PIPESTATUS[1]. Taking [0] on the second would read `echo`, which always succeeds.
    const body = src();
    const tc = body.indexOf('post-impl-tc-writer.sh');
    expect(body.slice(tc, tc + 600)).toMatch(/PIPESTATUS\[0\]/);
    const pa = body.indexOf('Pre-phase assessment completed');
    expect(body.slice(pa - 900, pa), 'the assessment reads the wrong pipeline element')
      .toMatch(/PIPESTATUS\[1\]/);
  });

  it('a failed checkout stops the clean — the half that deletes', () => {
    const body = src();
    const i = body.indexOf('WorktreeReset[$story_id]: could not restore tracked files');
    expect(i, 'the reset no longer guards the clean').toBeGreaterThan(-1);
    const block = body.slice(i - 900, i + 400);
    expect(block, 'the checkout failure is still swallowed').toMatch(/if ! git -C .* checkout/);
    expect(block, 'an empty baseline ref still reaches the clean').toMatch(/-z "\$_baseline_ref"/);
  });

  it('REPRODUCES what the old order did to a working tree', () => {
    // Not a description: the exact sequence, executed.
    const dir = repoOnBranch('main');
    writeFileSync(join(dir, 'kept.txt'), 'AGENT MODIFIED\n');
    writeFileSync(join(dir, 'untracked.txt'), 'agent work\n');

    const failed = git(dir, 'checkout', 'origin/nonexistent', '--', '.');
    expect(failed.status, 'the unresolvable checkout no longer fails').not.toBe(0);
    git(dir, 'clean', '-fd', '--', '.');

    expect(existsSync(join(dir, 'untracked.txt')), 'the clean no longer deletes untracked work').toBe(false);
    expect(readFileSync(join(dir, 'kept.txt'), 'utf8'),
      'the tracked file was restored after a failed checkout — premise gone').toContain('AGENT MODIFIED');
  });

  it('the baseline ref comes from the repository, not from the word "develop"', () => {
    expect(code(), 'a branch name is hardcoded again').not.toMatch(/JIRA_BASELINE_BRANCH:-develop/);
    expect(resolveRef(repoOnBranch('trunk')), 'a repo on trunk resolved nothing').toBe('trunk');
    expect(resolveRef(repoOnBranch('main'), 'release'), 'the declaration was ignored').toBe('release');
  });

  it('a detached HEAD resolves to nothing rather than to a guess', () => {
    // Empty is what makes the reset guard above refuse. A guess would let it clean.
    const dir = repoOnBranch('main');
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    expect(resolveRef(dir)).toBe('');
  });

  it('the pre-assessment restore uses a snapshot of NOW, not the pre-run canonical file', () => {
    const body = code();
    expect(body, 'a corrupted assessment still restores the whole run back to its base state')
      .not.toMatch(/profiles_backup="\$\{profiles_file\}\.original"/);
    expect(body, 'no pre-call snapshot is taken').toMatch(/profiles-preassessment-/);
  });

  it('that restore refuses to overwrite with a snapshot it never captured', () => {
    const body = src();
    const i = body.indexOf('may have corrupted profiles.json');
    expect(body.slice(i - 500, i + 500), 'an absent snapshot is still copied over the file')
      .toMatch(/-s "\$profiles_backup"/);
  });

  it('a test story is recognised by more than one convention', () => {
    expect(code(), 'the TC writer still decides on .test.ts alone')
      .not.toMatch(/grep -c '\\\.test\\\.ts\$'/);
  });
});
