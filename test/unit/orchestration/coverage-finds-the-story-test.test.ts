/**
 * A STORY'S TESTS ARE NOT ALL IN ONE COMMIT.
 *
 * story_outputs_tests_for attributes files to a story by grepping for the commit
 * "<story_id>: story complete", because the PHASE manifest carries no story attribution and a
 * caller taking `| head -1` from it gave every story the first test anybody wrote.
 *
 * But the writer no longer produces one commit. Measured 2026-08-28, on the first fully green paid
 * run: MOCK3-1's fix was committed as "Fix: correct fare boundary for riders aged exactly 65" — no
 * marker at all — and MOCK3-2's marker commit carried only src/schedule.ts, because its test went in
 * a separate "MOCK3-2: add bug-reproducing test" commit. So BOTH stories reported
 *
 *   [vc-coverage] no test file in the writer manifest for MOCK3-N — coverage NOT checked
 *
 * while src/fares.test.ts sat in the manifest and on the branch. The gate ran, warned, and checked
 * nothing, on a run reported green.
 *
 * The attribution that actually holds is the story-id PREFIX the commit convention already
 * requires — every commit of the story, not the one that happens to say "story complete".
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-outputs.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A codeline whose story work is spread across commits, exactly as the writer leaves it. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'story-outputs-')); dirs.push(d);
  const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  mkdirSync(join(d, 'src'), { recursive: true });

  const commit = (file: string, msg: string) => {
    writeFileSync(join(d, file), `// ${msg}\n`);
    git('add', '-A'); git('commit', '-q', '-m', msg);
  };
  // MOCK3-1: the fix carries NO marker, the test commit carries the story id
  commit('src/fares.ts', 'Fix: correct fare boundary for riders aged exactly 65');
  commit('src/fares.test.ts', 'MOCK3-1: add bug-reproducing test');
  // MOCK3-2: marker commit holds only source; the test lands in its own commit
  commit('src/schedule.ts', 'MOCK3-2: story complete (1 file(s))');
  commit('src/schedule.test.ts', 'MOCK3-2: add bug-reproducing test');
  return d;
}

function testsFor(root: string, story: string): string[] {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(LIB)}
     story_outputs_tests_for ${JSON.stringify(root)} "" ${JSON.stringify(story)}`,
  ], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').trim().split('\n').filter(Boolean);
}

describe('THE COVERAGE GATE FINDS THE STORY\'S OWN TEST', () => {
  it('finds a test committed separately from the fix', () => {
    expect(testsFor(repo(), 'MOCK3-1'),
      'the gate reported "no test file" while the test sat on the branch, and checked nothing')
      .toEqual(['src/fares.test.ts']);
  });

  it('finds a test committed after the "story complete" marker', () => {
    expect(testsFor(repo(), 'MOCK3-2')).toEqual(['src/schedule.test.ts']);
  });

  it('never hands one story another story\'s test', () => {
    // The defect this attribution exists to prevent: story B measured against story A's test.
    const d = repo();
    expect(testsFor(d, 'MOCK3-1')).not.toContain('src/schedule.test.ts');
    expect(testsFor(d, 'MOCK3-2')).not.toContain('src/fares.test.ts');
  });

  it('returns nothing for a story with no commits — "not checked", never "covered"', () => {
    expect(testsFor(repo(), 'MOCK3-9')).toEqual([]);
  });

  it('returns only tests, not the source files of the same commits', () => {
    expect(testsFor(repo(), 'MOCK3-2').filter((f) => !/\.test\./.test(f))).toEqual([]);
  });
});
