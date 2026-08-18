/**
 * THE BASELINE IS WHAT EVERY GATE DIFFS AGAINST, SO IT HAS TO BE A COMMIT.
 *
 * `git rev-parse origin/develop` on a repo with no such ref ECHOES the literal "origin/develop" to
 * stdout and exits 128. In an `a || b || c` chain the substitution then captures BOTH the echoed
 * ref and the SHA the next command produced — a two-line value whose first line is not a commit.
 *
 * That value is written to phase-baseline-sha.txt and read by every gate diff oracle:
 * review-ranger, mutant-hunter, fuzz-weaver, sast-sentinel. It is the known "reviewers saw 0 files"
 * failure.
 *
 * A repository with a remote never shows it. One without hits it on every lane.
 * brownfield-preflight-reset.sh already guards the same shape and says why; the codeline loop did
 * not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'baseline-sha-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** A repo with a commit on `develop` and NO remote — the shape that triggers it. */
function repoWithoutRemote(): string {
  const dir = join(work, 'repo');
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  spawnSync('mkdir', ['-p', dir]);
  spawnSync('git', ['init', '--quiet', '-b', 'develop', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-m', 'init', '--quiet');
  return dir;
}

/** The resolution exactly as the codeline loop performs it. */
function resolveBaseline(repo: string, branch: string): string {
  const src = readFileSync(ORCH, 'utf8');
  const line = src.split('\n').find((l) => l.includes('_baseline_sha=$(git -C'));
  expect(line, 'the baseline resolution was not found — this test is measuring nothing').toBeTruthy();

  const block = src.split('\n')
    .slice(src.split('\n').indexOf(line!))
    .slice(0, 3).join('\n')
    .replace(/\$_wt/g, repo)
    .replace(/\$\{_baseline_branch\}/g, branch);

  const r = spawnSync('bash', ['-c', `${block}\nprintf '%s' "$_baseline_sha"`], { encoding: 'utf8' });
  return r.stdout;
}

describe('the baseline sha is a sha', () => {
  it('resolves to one line for a repo with no remote', () => {
    const captured = resolveBaseline(repoWithoutRemote(), 'develop');
    expect(captured.split('\n').filter(Boolean).length,
      `the baseline captured more than one line — the unresolvable ref was echoed and kept:\n${captured}`,
    ).toBe(1);
  });

  it('resolves to something git recognises as a commit', () => {
    const repo = repoWithoutRemote();
    const captured = resolveBaseline(repo, 'develop').trim();
    const t = spawnSync('git', ['-C', repo, 'cat-file', '-t', captured], { encoding: 'utf8' });
    expect(t.stdout.trim(),
      `the baseline is not a commit, so every gate diffs against nothing: got ${JSON.stringify(captured)}`,
    ).toBe('commit');
  });

  it('is empty rather than wrong when no ref resolves at all', () => {
    // An empty baseline makes the caller warn and fall back. A bogus one is silently used.
    const empty = join(work, 'not-a-repo');
    spawnSync('mkdir', ['-p', empty]);
    const captured = resolveBaseline(empty, 'develop').trim();
    expect(captured, 'a non-repo produced a non-empty baseline').toBe('');
  });
});

/**
 * ONE WRITER, ONE MEANING.
 *
 * phase-baseline-sha.txt had two writers carrying two different intents. The codeline setup loop
 * wrote origin/<branch> — "the project's main branch" — to the PARENT log directory. Step 8 wrote
 * HEAD at phase start — "what this run changed" — to the LANE's.
 *
 * Every reader runs in Step 4.2 or later, by which point LOG_DIR is the lane's directory, so the
 * setup write was never read at all. And the two values differ on a multi-phase run: the
 * project-branch reading would report a previous phase's work as this phase's changes.
 */
describe('the baseline has exactly one writer', () => {
  const ORCH_SRC = readFileSync(ORCH, 'utf8');

  it('only one place writes the file', () => {
    const writers = ORCH_SRC.split('\n')
      .filter((l) => /> *"\$LOG_DIR\/phase-baseline-sha\.txt"/.test(l) && !/^\s*#/.test(l));
    expect(writers.length,
      `${writers.length} writers of phase-baseline-sha.txt:\n  ${writers.map((l) => l.trim()).join('\n  ')}`,
    ).toBe(1);
  });

  it('that writer resolves the ref rather than echoing it', () => {
    const writerBlock = ORCH_SRC.slice(ORCH_SRC.indexOf('_phase_baseline='), ORCH_SRC.indexOf('_phase_baseline=') + 400);
    expect(writerBlock, 'a bare rev-parse echoes an unresolvable ref and exits 128')
      .toMatch(/rev-parse --verify --quiet/);
  });

  it('says so when it cannot resolve one, instead of leaving no file', () => {
    // It ended in `|| true`: a repository the run could not read produced no file, every gate
    // compared against nothing, and that reads as "this story changed no files" — a false pass.
    const writerBlock = ORCH_SRC.slice(ORCH_SRC.indexOf('_phase_baseline='), ORCH_SRC.indexOf('_phase_baseline=') + 700);
    expect(writerBlock, 'an unresolvable baseline is silent').toMatch(/warning .*baseline/);
  });
});
