/**
 * post-impl-tc-writer.sh — defensive skip for delegated (split) parent stories.
 *
 * Root cause this fixes (found live, 2026-07-06, tier3-full-run-15): a
 * successfully-split parent's technicalNotes.files still lists its ORIGINAL
 * files (including any .test.ts), and it wasn't removed from
 * implementationOrder[phase] — so the TC writer's phase scan saw it as an
 * active "test story" with no TestCriteria yet, even though its actual
 * implementation (and TC) belongs entirely to a child story. This aborted a
 * live run at Step 1.6: "3 test stories still missing TCs: ['SKY-003',
 * 'SKY-004', 'SKY-002']" — all three were delegated parents, not real test
 * stories.
 *
 * spec-mode-runner.js marks a delegated parent status='deprecated' and
 * removes it from implementationOrder at split time (see
 * split-enforcement.test.ts) — status='deprecated' is the actual, specific
 * signal for this case, checked directly in the TC writer's own scan below.
 *
 * REMOVED (found live, 2026-07-14, tier3-travel-app run — SKY-004): the skip
 * used to ALSO fire on any story with completed == True, on the theory that
 * a delegated parent gets marked completed too ("belt-and-suspenders"). But
 * this BATCH gate (Step 1.6) only ever runs AFTER Step 1/3.2, by which point
 * EVERY story it examines is, by construction, already completed — that's
 * the entire premise of running it post-execution. The completed-exclusion
 * therefore silently no-op'd this script for every genuinely-finished combo
 * story (impl+test files together, e.g. SKY-004: src/server.ts +
 * src/server.test.ts) and every worktree-lane pure-test story once it
 * completed. The CALLER's own "needs TC" query (Step 1.6 in
 * run-agent-orchestration.sh) has no such completed-exclusion, so it kept
 * seeing SKY-004 as needing a TC, retried 3 times against a script that
 * always no-op'd, then permanently BLOCKED a story with real, already-
 * verified (tsc + external tests passed) work over this bookkeeping
 * mismatch. status='deprecated' alone is now the only skip signal — it is
 * both necessary and sufficient for the delegated-parent case.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const tcWriterSrc = readFileSync(TC_WRITER_SH, 'utf8');

function extractTcNeededBlock(): string {
  const start = tcWriterSrc.indexOf('TC_NEEDED=$(python3 << PYEOF');
  const end = tcWriterSrc.indexOf('PYEOF\n)', start) + 'PYEOF\n)'.length;
  return tcWriterSrc.slice(start, end);
}

describe('post-impl-tc-writer.sh — delegated-parent skip (static)', () => {
  const block = extractTcNeededBlock();

  it("checks status == 'deprecated' before treating a story as needing a TC", () => {
    expect(block).toMatch(/s\.get\('status'\) == 'deprecated'/);
  });

  it("does NOT also skip on completed is True (removed 2026-07-14 — see file docstring)", () => {
    expect(block).not.toMatch(/s\.get\('completed'\) is True/);
  });

  it('the skip check runs before the test-story/already-has-TC logic (short-circuits early)', () => {
    const skipIdx = block.indexOf("s.get('status') == 'deprecated'");
    const isTestStoryIdx = block.indexOf('is_test_story = any');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(isTestStoryIdx).toBeGreaterThan(skipIdx);
  });
});

describe('post-impl-tc-writer.sh — delegated-parent skip REAL execution', () => {
  function runTcNeededScan(prd: object): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'tc-writer-skip-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd));
      const block = extractTcNeededBlock();
      const scriptPath = join(dir, 'run.sh');
      // The heredoc references literal $PRD_FILE and $PHASE — substitute the
      // same way the real script does (bash variable interpolation before
      // the heredoc body reaches python3), by defining them as shell vars.
      writeFileSync(
        scriptPath,
        [`PRD_FILE="${prdPath}"`, `PHASE="core"`, block, `echo "$TC_NEEDED"`].join('\n')
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const baseChild = {
    id: 'SKY-002-test',
    technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
  };

  it('REPRODUCES the exact live scenario: a delegated parent (deprecated + completed) with a stale .test.ts in its files is skipped, not flagged as needing a TC', () => {
    const delegatedParent = {
      id: 'SKY-002',
      status: 'deprecated',
      completed: true,
      technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] },
      testCriteria: {},
    };
    const result = runTcNeededScan({
      stories: [delegatedParent, baseChild],
      implementationOrder: { core: ['SKY-002', 'SKY-002-test'] },
    });
    expect(result).not.toContain('SKY-002');
    expect(result).toContain('SKY-002-test');
  });

  it('a genuine (non-delegated) test story without a TC is still correctly flagged', () => {
    const result = runTcNeededScan({
      stories: [baseChild],
      implementationOrder: { core: ['SKY-002-test'] },
    });
    expect(result).toContain('SKY-002-test');
  });

  // REPRODUCES the exact live defect (SKY-004, 2026-07-14, tier3-travel-app
  // run) and proves the fix: a genuinely-completed COMBO story (owns both
  // src/server.ts and src/server.test.ts, real work, not a delegated split
  // parent) must still be flagged as needing a TC. Before the fix, this
  // silently no-op'd because the writer only checks completed==True for
  // EVERY story it examines here (this batch gate always runs post-Step-1) —
  // the caller's own "needs TC" query then retried 3 times against a script
  // that always no-op'd, and permanently BLOCKED a story with real,
  // already-verified work over this bookkeeping mismatch.
  it('does NOT skip a genuinely-completed combo story (real work, not a delegated parent) — this used to be the SKY-004 live defect', () => {
    const completedComboStory = {
      id: 'SKY-004',
      status: 'completed',
      completed: true,
      technicalNotes: { files: ['src/server.ts', 'src/server.test.ts'] },
      testCriteria: { facts: [] },
    };
    const result = runTcNeededScan({
      stories: [completedComboStory],
      implementationOrder: { core: ['SKY-004'] },
    });
    expect(result).toContain('SKY-004');
  });

  it('a completed story is still correctly skipped when it IS a delegated parent (status=deprecated, the real signal)', () => {
    const delegatedParent = {
      id: 'SKY-003',
      status: 'deprecated',
      completed: true,
      technicalNotes: { files: ['src/cli.ts', 'src/cli.test.ts'] },
    };
    const result = runTcNeededScan({
      stories: [delegatedParent],
      implementationOrder: { core: ['SKY-003'] },
    });
    expect(result).not.toContain('SKY-003');
  });

  it('does not skip a story that is merely status=pending with completed=false (normal active story)', () => {
    const activeTestStory = {
      id: 'SKY-004-test',
      status: 'pending',
      completed: false,
      technicalNotes: { files: ['src/server.test.ts'] },
    };
    const result = runTcNeededScan({
      stories: [activeTestStory],
      implementationOrder: { core: ['SKY-004-test'] },
    });
    expect(result).toContain('SKY-004-test');
  });

  it('a story that already has a TC (facts present) is not flagged, delegated or not', () => {
    const alreadyHasTc = {
      id: 'SKY-005-test',
      technicalNotes: { files: ['src/foo.test.ts'] },
      testCriteria: { facts: ['some fact'] },
    };
    const result = runTcNeededScan({
      stories: [alreadyHasTc],
      implementationOrder: { core: ['SKY-005-test'] },
    });
    expect(result).not.toContain('SKY-005-test');
  });
});
