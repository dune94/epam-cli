/**
 * A STORY WHOSE WORK WAS NEVER COMMITTED IS NOT "IMPLEMENTED".
 *
 * Live 2026-08-09, AMSD-2041 on gotransit. The writer produced 43 lines of correct
 * live-preview wiring. The commit-time credential scan unstaged everything, `git add` then
 * failed, and the log read:
 *
 *     [WARNING] [commit_completed_story] git add failed (exit 1) — work remains staged/uncommitted
 *     Implemented: 1, Failed: 0, Skipped: 0
 *
 * The story was marked `completed`, counted as implemented, and its work was sitting
 * uncommitted in the working tree. Every downstream reader — the run report, a rerun deciding
 * what is outstanding, a human — was told the story was delivered.
 *
 * The `|| true` at the call site is CORRECT and stays: this script runs under `set -e`, and a
 * bare failure there would kill the whole lane, taking every remaining story with it over one
 * story's commit. The defect is that the return code was discarded rather than acted on.
 *
 * The remedy is the shape already used for the post-story TypeScript gate a few lines below:
 * demote the story to failed and correct the tally. Nothing about lane survival changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE, 'utf8');

/** The post-story block: from the commit call to the tally. */
function postStoryBlock(): string {
  const from = src.indexOf('commit_completed_story "$story_id"');
  expect(from, 'the per-story commit call is gone').toBeGreaterThan(-1);
  const to = src.indexOf('Implemented: $implemented', from);
  expect(to, 'the tally is gone').toBeGreaterThan(from);
  const block = src.slice(from, to);
  // A window that excluded the code under test passed vacuously once already this session.
  expect(block.length, 'the block is suspiciously short — the bound is wrong').toBeGreaterThan(400);
  return block;
}

describe('the lane still survives a failed commit', () => {
  it('the call is still guarded, so one story cannot kill the lane under set -e', () => {
    expect(
      postStoryBlock(),
      'removing the guard makes a commit failure take every remaining story with it',
    ).toMatch(/commit_completed_story "\$story_id"/);
  });
});

describe('THE DEFECT: the outcome is acted on, not discarded', () => {
  it('the commit result is captured', () => {
    // The CALL must assign the code. Asserting only that `_commit_rc` appears somewhere
    // passes while the call still ends in `|| true` and the variable is never written — a
    // mutation slipped through on exactly that.
    expect(
      postStoryBlock(),
      'the return code is thrown away, so a story with uncommitted work still counts as done',
    ).toMatch(/commit_completed_story "\$story_id" \|\| _commit_rc=\$\?/);
    expect(
      postStoryBlock(),
      'the call still discards its result with `|| true`',
    ).not.toMatch(/commit_completed_story "\$story_id" \|\| true/);
  });

  it('a failed commit demotes the story to failed', () => {
    const block = postStoryBlock();
    const idx = block.indexOf('_commit_rc');
    expect(idx, 'no commit result to branch on').toBeGreaterThan(-1);
    const after = block.slice(idx);
    expect(after).toMatch(/update_story_status "\$story_id" "failed"/);
  });

  it('and corrects the tally, the way the tsc gate does', () => {
    const block = postStoryBlock();
    const after = block.slice(block.indexOf('_commit_rc'));
    expect(after).toMatch(/failed=\$\(\(failed \+ 1\)\)/);
    expect(after).toMatch(/implemented=\$\(\(implemented - 1\)\)/);
  });

  it('the operator is told plainly, not via a warning buried in the log', () => {
    const after = postStoryBlock();
    expect(after.toLowerCase()).toMatch(/uncommitted|not committed/);
  });
});

describe('the existing post-story gate is untouched', () => {
  it('the tsc gate still demotes the same way — this is a copy of its shape, not a rewrite', () => {
    const block = postStoryBlock();
    expect(block).toMatch(/story_tsc_gate "\$story_id"/);
    const tsc = block.slice(block.indexOf('story_tsc_gate'));
    expect(tsc).toMatch(/implemented=\$\(\(implemented - 1\)\)/);
  });

  it('cost recording and split validation still run', () => {
    const block = postStoryBlock();
    expect(block).toMatch(/record_story_actual_cost "\$story_id"/);
    expect(block).toMatch(/validate_mid_execution_splits/);
  });
});
