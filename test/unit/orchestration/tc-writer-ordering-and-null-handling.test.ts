/**
 * Two bugs found live in the same tier3 run (2026-07-02, core phase, first
 * run with the --cwd/tee-masking fix live):
 *
 * BUG 1 (severe): Step 1.6 (TC writer gate) used to execute right after
 * Step 1.5 (auto-commit), BEFORE Step 3's worktree implementation runs. For
 * any phase using worktree topology, Step 1 ("main-branch stories") is
 * empty — "no stories in lane" — so the TC writer always found zero source
 * files and, once the exit-code-masking bug was fixed, the gate now
 * correctly (but catastrophically) FAILED every single time, hard-aborting
 * the entire phase before implementation had a chance to run at all.
 * Fix: Step 1.6 now executes after Step 3.2 (worktree merge-back), so both
 * main-branch and worktree-topology phases are guaranteed to have real
 * implementation on the branch by the time it runs.
 *
 * BUG 2: post-impl-tc-writer.sh's python validator crashed with
 * `AttributeError: 'NoneType' object has no attribute 'get'` when the TC
 * writer agent legitimately wrote `null` for a story (its own documented
 * behavior when source files don't exist). This crash happened INSIDE the
 * already-failing gate, turning a clean failure message into a raw Python
 * traceback in the log.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');

const orchSrc = readFileSync(ORCH_SH, 'utf8');
const tcWriterSrc = readFileSync(TC_WRITER_SH, 'utf8');

describe('BUG 1 — Step 1.6 ordering relative to worktree topology', () => {
  it('Step 1 (main-branch stories) can be empty ("no stories in lane") for worktree-only phases', () => {
    expect(orchSrc).toMatch(/no stories in lane/);
  });

  it('the old Step 1.6 location (before Step 2/worktree creation) is now just a comment, no gate logic', () => {
    const iNeedWorktrees = orchSrc.indexOf('need_worktrees=false');
    const before = orchSrc.slice(Math.max(0, iNeedWorktrees - 600), iNeedWorktrees);
    expect(before).toMatch(/has moved — see after Step 3\.2 below/);
    expect(before).not.toMatch(/post-impl-tc-writer\.sh/);
    expect(before).not.toMatch(/_tc_writer_needed=/);
  });

  it('Step 1.6 gate logic executes after "Step 3.2: All worktree branches merged back successfully"', () => {
    const iMerge = orchSrc.indexOf('Step 3.2: All worktree branches merged back successfully');
    const iGate = orchSrc.indexOf('_tc_writer_needed=', iMerge);
    expect(iMerge).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iMerge);
  });

  it('Step 1.6 gate logic executes before the Step 3.5 post-parallel skill assessment', () => {
    const iGate = orchSrc.indexOf('_tc_writer_needed=');
    const iStep35 = orchSrc.indexOf('Step 3.5: Post-Parallel Skill Assessment');
    expect(iStep35).toBeGreaterThan(iGate);
  });

  it('a phase with ONLY worktree stories (empty main-branch lane) still reaches the TC gate after merge', () => {
    // Structural guarantee: the merge-back block runs unconditionally (even
    // the "else" no-worktrees branch), and the TC gate is placed
    // unconditionally after both branches close.
    const iElse = orchSrc.indexOf('Step 3.2: No worktrees — skipping merge-back');
    const iGate = orchSrc.indexOf('_tc_writer_needed=');
    expect(iGate).toBeGreaterThan(iElse);
  });
});

describe('BUG 2 — post-impl-tc-writer.sh handles a legitimate null TC value without crashing', () => {
  it('checks for `tc is None` before calling .get() on the story\'s TC value', () => {
    const idx = tcWriterSrc.indexOf('tc = tc_data[sid]');
    expect(idx).toBeGreaterThan(-1);
    const block = tcWriterSrc.slice(idx, idx + 400);
    expect(block).toMatch(/if tc is None:/);
  });

  it('the null-check appears BEFORE the first tc.get() call (not after)', () => {
    const noneCheckIdx = tcWriterSrc.indexOf('if tc is None:');
    const firstGetIdx = tcWriterSrc.indexOf("tc.get('facts')");
    expect(noneCheckIdx).toBeGreaterThan(-1);
    expect(firstGetIdx).toBeGreaterThan(noneCheckIdx);
  });

  it('treats a null TC as skipped (continue), not a fatal crash', () => {
    const idx = tcWriterSrc.indexOf('if tc is None:');
    const block = tcWriterSrc.slice(idx, idx + 200);
    expect(block).toMatch(/skipped\.append/);
    expect(block).toMatch(/continue/);
  });
});
