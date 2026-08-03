/**
 * computeStoryCommits (orchestrations/dashboards/build/snapshot.js) — matches
 * each story to its real completion commit by subject line.
 *
 * Previously untested. Found live 2026-08-02 while renaming the commit
 * message format ("story: complete <id> (...)" -> "<id>: story complete
 * (...)", to satisfy a client repo's own commitlint requiring the ticket ID
 * to lead the message): this function's marker string
 * (`story: complete ${id} (`) would have silently stopped matching any real
 * commit ever again, with no test to catch it.
 *
 * Real git repo, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { computeStoryCommits } = require('../../../orchestrations/dashboards/build/snapshot.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-story-commits-'));
  cleanupDirs.push(dir);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function commit(dir: string, message: string, allowEmpty = true): void {
  const args = ['commit', '--quiet', '-m', message];
  if (allowEmpty) args.push('--allow-empty');
  execFileSync('git', args, { cwd: dir });
}

describe('computeStoryCommits — real git, real commit_completed_story() message shape', () => {
  it('matches a story to its real completion commit via the current "<id>: story complete (...)" format', () => {
    const dir = makeRepo();
    commit(dir, 'init');
    commit(dir, 'AMSD-2041: story complete (3 file(s))');

    const result = computeStoryCommits({ stories: [{ id: 'AMSD-2041' }] }, dir);

    expect(result['AMSD-2041']).toBeTruthy();
    expect(result['AMSD-2041'].fileCount).toBe(3);
    expect(result['AMSD-2041'].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('does NOT match the OLD "story: complete <id> (...)" format (proves the rename took effect everywhere)', () => {
    const dir = makeRepo();
    commit(dir, 'init');
    commit(dir, 'story: complete AMSD-2041 (3 file(s))');

    const result = computeStoryCommits({ stories: [{ id: 'AMSD-2041' }] }, dir);

    expect(result['AMSD-2041']).toBeUndefined();
  });

  it('picks the MOST RECENT matching commit when a story has multiple (newest-first log order)', () => {
    const dir = makeRepo();
    commit(dir, 'init');
    commit(dir, 'SKY-001: story complete (1 file(s))');
    commit(dir, 'SKY-001: story complete (5 file(s))');

    const result = computeStoryCommits({ stories: [{ id: 'SKY-001' }] }, dir);

    expect(result['SKY-001'].fileCount).toBe(5);
  });

  it('returns {} for a story with no matching commit', () => {
    const dir = makeRepo();
    commit(dir, 'init');

    const result = computeStoryCommits({ stories: [{ id: 'NEVER-DONE' }] }, dir);

    expect(result['NEVER-DONE']).toBeUndefined();
  });

  it('returns {} when projectRoot is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-nogit-'));
    cleanupDirs.push(dir);
    const result = computeStoryCommits({ stories: [{ id: 'X' }] }, dir);
    expect(result).toEqual({});
  });
});
