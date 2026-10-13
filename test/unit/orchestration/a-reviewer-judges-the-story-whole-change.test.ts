/**
 * A REVIEWER JUDGES THE STORY'S WHOLE CHANGE — NOT ITS LAST REWORK COMMIT, AND NOT ANOTHER STORY'S.
 *
 * AMSD-2974 run 9 (2026-10-13): the reviewers were given the story's LATEST recorded commit alone. The 7.x back-port was
 * approved on 6cff178 — one line of one file, its last rework — and the 8.x line on 0620da2; neither reviewer saw the
 * change it approved. The latest-commit scope existed so another story's commit in the same branch stays out of a
 * story's review (regintel 20260919T224649Z); that must still hold.
 *
 * EXECUTED: the real story_review_range / story_review_diff / story_changed_files (lib/review-scope.sh) on a real git
 * repository with a real story-changes record: a first commit, an unrecorded test commit, another story's commit in
 * between, a rework commit, and a record from an attempt later reset away.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCOPE = join(__dirname, '../../../orchestrations/scripts/lib/review-scope.sh');

function estate(record: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'review-whole-'));
  const repo = join(d, 'repo'); const logs = join(d, 'logs'); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(logs);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
  const commit = (file: string, body: string, msg: string) => { writeFileSync(join(repo, file), body); git('add', '.'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'AI-S-1'); commit('src/Toast.tsx', 'position: BOTTOM_RIGHT\n', 'base');
  // An attempt later reset away: recorded, but not in the branch's history.
  git('checkout', '-qb', 'abandoned'); const gone = commit('src/Toast.tsx', 'position: ABANDONED\n', 'S-1: story complete (1 file(s))');
  git('checkout', '-q', '-'); git('branch', '-qD', 'abandoned');
  const first = commit('src/Toast.tsx', 'position: TOP_RIGHT\npointerEvents: "none"\n', 'S-1: story complete (1 file(s))');
  commit('src/Toast.spec.tsx', 'it("is top right")\n', 'S-1: add bug-reproducing test');
  commit('src/Other.tsx', 'other story\n', 'S-2: story complete (1 file(s))');
  const rework = commit('src/Toast.tsx', 'position: TOP_RIGHT\npointerEvents: "none"\nrole: "alert"\n', 'S-1: story complete (1 file(s))');
  if (record) writeFileSync(join(logs, 'story-changes.jsonl'), [gone, first, rework].map((sha) => JSON.stringify({ storyId: 'S-1', sha })).join('\n') + '\n');
  const sh = (fn: string) => spawnSync('bash', ['-c', `. "${SCOPE}"; ${fn} S-1`], { encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: repo, LOG_DIR: logs } }).stdout;
  return { diff: sh('story_review_diff'), files: sh('story_changed_files').trim().split('\n').sort(), range: sh('story_review_range').trim(), first, rework };
}

describe('a reviewer judges the story\'s whole change', () => {
  it('the diff runs from before the story\'s first commit to its last: the first change, its test and the rework are all in it', () => {
    const e = estate(true);
    expect(e.range).toBe(`${e.first}^ ${e.rework}`);
    for (const line of ['-position: BOTTOM_RIGHT', '+position: TOP_RIGHT', '+pointerEvents: "none"', '+role: "alert"', '+it("is top right")']) expect(e.diff, line).toContain(line);
    expect(e.files).toEqual(['src/Toast.spec.tsx', 'src/Toast.tsx']);
  });

  it('NEGATIVE: another story\'s commit between them is not in the story\'s review, nor an attempt reset away', () => {
    const e = estate(true);
    expect(e.diff).toContain('+role: "alert"');
    expect(e.diff).not.toContain('other story');
    expect(e.diff).not.toContain('ABANDONED');
    expect(e.files).not.toContain('src/Other.tsx');
  });

  it('NEGATIVE: no record — no range; the review falls back to recent history as before', () => {
    const e = estate(false);
    expect(e.range).toBe('');
    expect(e.diff).toContain('+role: "alert"');
  });
});
