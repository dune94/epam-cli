/**
 * A WORKTREE LANE RECORDS ITS PHASE BASELINE.
 *
 * £0 multi-lane run, 2026-10-04: phase-baseline-sha.txt was written only inside Step 8 (main-branch
 * stories). A brownfield lane runs its story in a worktree and skips Step 8, so a fresh lane had no
 * baseline: the writer's verification logged "no test baseline is declared … PRE-EXISTING test
 * failures will be attributed to this story" on every attempt, a failure already on the baseline was
 * charged to all eight, and the lane failed. Live it was hidden by a file an earlier Step-8 launch left.
 *
 * qa_record_phase_baseline is the one recording both paths use. EXECUTED on a git fixture shaped as a
 * lane after ensure_story_branch: the story branch based on origin/develop, carrying a commit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function lane() {
  const base = mkdtempSync(join(tmpdir(), 'phase-baseline-')); dirs.push(base);
  const origin = join(base, 'origin.git'); const repo = join(base, 'repo'); const logs = join(base, 'logs');
  mkdirSync(logs);
  git(base, ['init', '-q', '--bare', '-b', 'develop', origin]);
  git(base, ['init', '-q', '-b', 'develop', repo]);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['remote', 'add', 'origin', origin]); git(repo, ['push', '-q', 'origin', 'develop']);
  const baseline = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'bugfix/AI-EST-1', 'origin/develop']);
  writeFileSync(join(repo, 'a.txt'), 'b\n'); git(repo, ['commit', '-qam', 'story work']);
  return { repo, logs, baseline };
}

const record = (repo: string, branch: string, logs: string) => spawnSync('bash', ['-c', `
warning(){ echo "WARN $*" >&2; }; info(){ :; }; log(){ :; }
source ${JSON.stringify(join(LIB, 'qa-gate-evidence.sh'))}
qa_record_phase_baseline ${JSON.stringify(repo)} ${JSON.stringify(branch)} ${JSON.stringify(logs)}`], { encoding: 'utf8' });

describe('a worktree lane records its phase baseline', () => {
  it('the baseline is the commit the story branch diverged from, written where every gate reads it', () => {
    const { repo, logs, baseline } = lane();
    const r = record(repo, 'develop', logs);
    const f = join(logs, 'phase-baseline-sha.txt');
    expect(existsSync(f), `no baseline recorded:\n${r.stdout}${r.stderr}`).toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe(baseline);
  });

  it('a codeline with no resolvable commit records nothing and says so', () => {
    const base = mkdtempSync(join(tmpdir(), 'phase-baseline-empty-')); dirs.push(base);
    const repo = join(base, 'repo'); const logs = join(base, 'logs'); mkdirSync(logs);
    git(base, ['init', '-q', repo]);
    const r = record(repo, 'develop', logs);
    expect(existsSync(join(logs, 'phase-baseline-sha.txt'))).toBe(false);
    expect(r.stderr).toMatch(/WARN .*baseline/);
  });
});
