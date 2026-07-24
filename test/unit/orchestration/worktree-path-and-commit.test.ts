/**
 * Worktree path rewriting and commit invariants.
 *
 * Root cause from run 95 (and run 94): technicalNotes.files in the PRD
 * contains absolute paths pointing to the MAIN repo
 * (e.g. /home/.../skyscanner-app/src/foo.ts). When a story runs in a
 * worktree, these paths must be rewritten to the worktree directory so:
 *   1. The agent writes files to the worktree, not the main repo.
 *   2. verify_story_deliverables checks the worktree, not the main repo.
 *   3. The worktree ends up with new commits that Step 3.2 can merge.
 *
 * Without this rewrite, agents "succeed" by finding files left from a prior
 * run in the main repo, nothing is written to the worktree, and Step 3.2
 * fails with "branch has no new commits".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

const CANONICAL_PRD = join(REPO, 'orchestrations/travel-app-prd.canonical.json');

// ── 1. Canonical PRD has absolute paths in technicalNotes.files ──────────────
describe('canonical PRD — technicalNotes.files path format', () => {
  it('canonical PRD exists', () => {
    expect(existsSync(CANONICAL_PRD)).toBe(true);
  });

  it('canonical PRD stories have absolute paths in technicalNotes.files', () => {
    const prd = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
    const storiesWithFiles = prd.stories.filter(
      (s: any) => s?.technicalNotes?.files?.length > 0
    );
    expect(storiesWithFiles.length, 'no stories have technicalNotes.files').toBeGreaterThan(0);

    for (const story of storiesWithFiles) {
      for (const f of story.technicalNotes.files) {
        expect(
          f.startsWith('/'),
          `story ${story.id} technicalNotes.files entry is not absolute: "${f}"`
        ).toBe(true);
      }
    }
  });

  it('canonical PRD file paths reference the main repo (not a worktree path)', () => {
    const prd = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
    for (const story of prd.stories) {
      for (const f of story?.technicalNotes?.files ?? []) {
        expect(
          f,
          `path contains worktree suffix -wt-: "${f}"`
        ).not.toMatch(/-wt-(primary|independent)/);
      }
    }
  });
});

// ── 2. claude.sh saves MAIN_PROJECT_ROOT before switching to worktree ────────
describe('claude.sh --worktree flag — MAIN_PROJECT_ROOT saved before path switch', () => {
  it('MAIN_PROJECT_ROOT is assigned before GIT_WORK_ROOT is reassigned', () => {
    // Must capture main project root BEFORE the reassignment so we can rewrite paths
    const wtIdx = claudeSrc.indexOf('--worktree)');
    expect(wtIdx).toBeGreaterThan(-1);
    // Use 1400-char window — variable is ~1000 chars into the case block
    const block = claudeSrc.slice(wtIdx, wtIdx + 1400);

    const mainRootIdx = block.indexOf('MAIN_PROJECT_ROOT=');
    // Find the GIT_WORK_ROOT= reassignment that comes AFTER MAIN_PROJECT_ROOT is set
    const gitWorkRootIdx = block.indexOf('GIT_WORK_ROOT=', mainRootIdx + 1);

    expect(mainRootIdx, 'MAIN_PROJECT_ROOT not assigned in --worktree block').toBeGreaterThan(-1);
    expect(gitWorkRootIdx, 'GIT_WORK_ROOT not reassigned in --worktree block').toBeGreaterThan(-1);
    expect(
      mainRootIdx,
      'MAIN_PROJECT_ROOT must be saved BEFORE GIT_WORK_ROOT is reassigned'
    ).toBeLessThan(gitWorkRootIdx);
  });

  it('MAIN_PROJECT_ROOT is a global variable (not declared local)', () => {
    // Must be global — local vars are not visible outside the case block
    const wtIdx = claudeSrc.indexOf('--worktree)');
    const block = claudeSrc.slice(wtIdx, wtIdx + 1400);
    expect(block).not.toMatch(/local MAIN_PROJECT_ROOT/);
    expect(block).toContain('MAIN_PROJECT_ROOT=');
  });
});

// ── 3. verify_story_deliverables rewrites absolute paths in worktree mode ────
describe('verify_story_deliverables — absolute path rewriting in worktree mode', () => {
  it('function rewrites main-repo absolute paths to worktree in WORKTREE_MODE', () => {
    const fnIdx = claudeSrc.indexOf('verify_story_deliverables()');
    expect(fnIdx).toBeGreaterThan(-1);
    // Widened from 800 (2026-07-12): the vendor-dir-skip fix added a
    // comment block + vendor-dir-reading code before the WORKTREE_MODE
    // rewrite logic, pushing it further into the function.
    const block = claudeSrc.slice(fnIdx, fnIdx + 2200);
    expect(block).toContain('WORKTREE_MODE');
    expect(block).toContain('MAIN_PROJECT_ROOT');
  });

  it('rewrite uses string substitution (not just PROJECT_ROOT prefix)', () => {
    // Pattern: ${PROJECT_ROOT}${file#${MAIN_PROJECT_ROOT}}
    const fnIdx = claudeSrc.indexOf('verify_story_deliverables()');
    const block = claudeSrc.slice(fnIdx, fnIdx + 2200);
    expect(block).toMatch(/PROJECT_ROOT.*MAIN_PROJECT_ROOT|MAIN_PROJECT_ROOT.*PROJECT_ROOT/);
  });

  it('rewrite only applies when file starts with MAIN_PROJECT_ROOT (not all absolute paths)', () => {
    // System absolute paths like /tmp/foo should not be rewritten
    const fnIdx = claudeSrc.indexOf('verify_story_deliverables()');
    const block = claudeSrc.slice(fnIdx, fnIdx + 2200);
    // Must guard with: [[ "$file" = "${MAIN_PROJECT_ROOT}"* ]]
    expect(block).toMatch(/MAIN_PROJECT_ROOT.*\*/);
  });
});

// ── 4. Agent prompt (write_first_lines) also rewrites paths ──────────────────
describe('agent write-first prompt — absolute paths rewritten in worktree mode', () => {
  // Anchor on the initialization line "write_first_lines=""" which starts the block
  const promptIdx = claudeSrc.indexOf('write_first_lines=""');

  it('write_first_lines block rewrites MAIN_PROJECT_ROOT paths to worktree', () => {
    expect(promptIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(promptIdx, promptIdx + 3000);
    expect(block).toContain('WORKTREE_MODE');
    expect(block).toContain('MAIN_PROJECT_ROOT');
  });

  it('write_first_lines path rewrite matches verify_story_deliverables pattern', () => {
    // Both must use bash parameter substitution: ${PROJECT_ROOT}${f#${MAIN_PROJECT_ROOT}}
    const verifyIdx = claudeSrc.indexOf('verify_story_deliverables()');
    // Widened from 1000 (2026-07-12): see the vendor-dir-skip fix comment above.
    const verifyBlock = claudeSrc.slice(verifyIdx, verifyIdx + 2400);
    const promptBlock = claudeSrc.slice(promptIdx, promptIdx + 3000);

    expect(verifyBlock).toMatch(/PROJECT_ROOT.*#.*MAIN_PROJECT_ROOT/);
    expect(promptBlock).toMatch(/PROJECT_ROOT.*#.*MAIN_PROJECT_ROOT/);
  });
});

// ── 4b. build_implementation_prompt and build_generator_prompt rewrite AC text ─
// Run 96 failure (SKY-003): the write-first directive was rewritten to use the
// worktree path, but acceptanceCriteria, technicalNotes, and description still
// contained absolute main-repo paths. The agent read those and wrote files to
// the main repo on every attempt. Only rewriting write_first_lines was insufficient.
describe('build_implementation_prompt — full prompt text rewritten in worktree mode', () => {
  const implIdx = claudeSrc.indexOf('build_implementation_prompt()');

  it('build_implementation_prompt rewrites acceptance_criteria paths', () => {
    expect(implIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(implIdx, implIdx + 1500);
    // Must replace MAIN_PROJECT_ROOT in acceptance_criteria string
    expect(block).toMatch(/acceptance_criteria.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|acceptance_criteria=.*\$\{acceptance_criteria\/\//);
  });

  it('build_implementation_prompt rewrites technical_notes paths', () => {
    const block = claudeSrc.slice(implIdx, implIdx + 1500);
    expect(block).toMatch(/technical_notes.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|technical_notes=.*\$\{technical_notes\/\//);
  });

  it('build_implementation_prompt rewrites files variable paths', () => {
    const block = claudeSrc.slice(implIdx, implIdx + 1500);
    expect(block).toMatch(/\bfiles=.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|\bfiles=.*\$\{files\/\//);
  });

  it('build_implementation_prompt rewrites description paths', () => {
    const block = claudeSrc.slice(implIdx, implIdx + 1500);
    expect(block).toMatch(/description.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|description=.*\$\{description\/\//);
  });

  it('build_implementation_prompt rewrite is guarded by WORKTREE_MODE check', () => {
    const block = claudeSrc.slice(implIdx, implIdx + 1500);
    expect(block).toContain('WORKTREE_MODE');
    expect(block).toContain('MAIN_PROJECT_ROOT');
  });
});

describe('build_generator_prompt — full prompt text rewritten in worktree mode', () => {
  const genIdx = claudeSrc.indexOf('build_generator_prompt()');

  it('build_generator_prompt rewrites acceptance_criteria paths', () => {
    expect(genIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(genIdx, genIdx + 1500);
    expect(block).toMatch(/acceptance_criteria.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|acceptance_criteria=.*\$\{acceptance_criteria\/\//);
  });

  it('build_generator_prompt rewrites technical_notes paths', () => {
    const block = claudeSrc.slice(genIdx, genIdx + 1500);
    expect(block).toMatch(/technical_notes.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|technical_notes=.*\$\{technical_notes\/\//);
  });

  it('build_generator_prompt is guarded by WORKTREE_MODE check', () => {
    const block = claudeSrc.slice(genIdx, genIdx + 1500);
    expect(block).toContain('WORKTREE_MODE');
    expect(block).toContain('MAIN_PROJECT_ROOT');
  });
});

// ── 5. Worktree health check auto-commits after story run ────────────────────
describe('worktree health check — auto-commit invariants', () => {
  const WH_SCRIPT = join(REPO, 'orchestrations/scripts/worktree-health-check.sh');
  const whSrc = readFileSync(WH_SCRIPT, 'utf8');

  it('worktree-health-check.sh exists', () => {
    expect(existsSync(WH_SCRIPT)).toBe(true);
  });

  it('orch script invokes health check with AUTO_COMMIT=true', () => {
    expect(claudeSrc.indexOf('AUTO_COMMIT=true') > -1 || true).toBe(true);
    // Actually in run-agent-orchestration.sh
    const orchSrc = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(orchSrc).toContain('AUTO_COMMIT=true');
  });

  it('health check auto-commits when uncommitted files are found', () => {
    expect(whSrc).toContain('AUTO_COMMIT=true');
    expect(whSrc).toContain('_auto_commit_worktree');
  });

  it('auto-commit stages src/ files', () => {
    const autoCommitIdx = whSrc.indexOf('_auto_commit_worktree()');
    const block = whSrc.slice(autoCommitIdx, autoCommitIdx + 600);
    expect(block).toContain('src/');
  });

  it('auto-commit uses git commit -m (not git stash or git reset)', () => {
    const autoCommitIdx = whSrc.indexOf('_auto_commit_worktree()');
    const block = whSrc.slice(autoCommitIdx, autoCommitIdx + 1600); // git commit is at line 44 (~1500 chars)
    expect(block).toMatch(/git -C.*wt_path.*commit/);
    expect(block).not.toContain('git stash');
    expect(block).not.toContain('git reset');
  });

  it('health check validates both wt-primary and wt-independent lanes', () => {
    expect(whSrc).toContain('primary');
    expect(whSrc).toContain('independent');
    // Must iterate over both
    const mainIdx = whSrc.indexOf('main()');
    const block = whSrc.slice(mainIdx, mainIdx + 400);
    expect(block).toContain('primary');
    expect(block).toContain('independent');
  });
});

// ── 6. Step 3.2 merge fails if branch has no new commits ─────────────────────
describe('Step 3.2 merge — branch must have commits ahead of main', () => {
  const orchSrc = readFileSync(
    join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8'
  );

  it('Step 3.2 checks _ahead count before merging', () => {
    const mergeIdx = orchSrc.indexOf('Step 17: Merging');
    expect(mergeIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(mergeIdx, mergeIdx + 1000);
    expect(block).toMatch(/_ahead|rev-list.*count/);
  });

  it('Step 3.2 errors if branch has no new commits (not silently skips)', () => {
    const mergeIdx = orchSrc.indexOf('Step 17: Merging');
    const block = orchSrc.slice(mergeIdx, mergeIdx + 1000);
    expect(block).toMatch(/no new commits|ahead.*0|_ahead.*-eq 0/);
    expect(block).toMatch(/error|ERROR|MERGE_FAILED/);
  });

  it('worktrees left in place after merge failure so developer can inspect them', () => {
    // Worktrees must NOT be auto-deleted on merge failure — developer needs them to debug
    const mergeIdx = orchSrc.indexOf('Step 17: Merging');
    // Widened from 3200 (2026-07-12): the merge-integrity guard added ahead
    // of the real `-X ours` merge call pushed this text further away.
    const block = orchSrc.slice(mergeIdx, mergeIdx + 6000);
    // Error message must say worktrees are preserved for inspection
    expect(block).toMatch(/skip.*cleanup|inspection|preserved/i);
  });
});

// ── 8. Scope guard EPAM_ALLOWED_WRITE_PATHS must use worktree paths ──────────
// Root cause of run 97 failure (SKY-003):
// The scope guard reads technicalNotes.files (main-repo absolute paths) and exports
// EPAM_ALLOWED_WRITE_PATHS = those paths WITHOUT rewriting them to the worktree.
// WriteFile.ts blocks writes outside EPAM_ALLOWED_WRITE_PATHS and returns an error
// message: "Permitted paths: /main-repo/src/cli.ts". The model reads this error,
// IGNORES the write-first directive to the worktree, and writes to the main repo.
// Fix: rewrite _allowed_write_paths to worktree path after the jq extraction,
// guarded by WORKTREE_MODE && MAIN_PROJECT_ROOT.
describe('scope guard — EPAM_ALLOWED_WRITE_PATHS rewritten to worktree in worktree mode', () => {
  // Anchor on the scope guard comment which immediately precedes the jq extraction
  const sgCommentIdx = claudeSrc.indexOf(
    'Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story'
  );

  it('scope guard comment exists in claude.sh', () => {
    expect(sgCommentIdx).toBeGreaterThan(-1);
  });

  it('_allowed_write_paths is rewritten with MAIN_PROJECT_ROOT→PROJECT_ROOT substitution', () => {
    expect(sgCommentIdx).toBeGreaterThan(-1);
    // The rewrite block must appear AFTER the jq extraction and BEFORE the epam invocation
    const block = claudeSrc.slice(sgCommentIdx, sgCommentIdx + 1000);
    // Must contain the bash global substitution pattern
    expect(block).toMatch(/_allowed_write_paths.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|_allowed_write_paths=.*\$\{_allowed_write_paths\/\//);
  });

  it('_allowed_write_paths rewrite is guarded by WORKTREE_MODE and MAIN_PROJECT_ROOT', () => {
    expect(sgCommentIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(sgCommentIdx, sgCommentIdx + 1000);
    expect(block).toContain('WORKTREE_MODE');
    expect(block).toContain('MAIN_PROJECT_ROOT');
  });

  it('_allowed_write_paths rewrite appears AFTER jq extraction and BEFORE EPAM_ALLOWED_WRITE_PATHS export', () => {
    expect(sgCommentIdx).toBeGreaterThan(-1);
    // Window widened: a fix-site-path union block now sits between the worktree
    // rewrite and the env export (detective fix-site → allowed write paths).
    const block = claudeSrc.slice(sgCommentIdx, sgCommentIdx + 2400);
    const jqIdx = block.indexOf('jq -r');
    const rewriteIdx = block.search(/_allowed_write_paths=.*\$\{_allowed_write_paths\/\//);
    const exportIdx = block.indexOf('EPAM_ALLOWED_WRITE_PATHS=');
    expect(jqIdx).toBeGreaterThan(-1);
    expect(rewriteIdx).toBeGreaterThan(-1);
    expect(exportIdx).toBeGreaterThan(-1);
    expect(rewriteIdx).toBeGreaterThan(jqIdx);
    expect(exportIdx).toBeGreaterThan(rewriteIdx);
  });

  it('scope guard in generator-mode also rewrites paths (parallel code path)', () => {
    // build_generator_prompt has a separate epam invocation path — it must also rewrite
    const genSgIdx = claudeSrc.indexOf(
      'Scope guard: build EPAM_ALLOWED_WRITE_PATHS from the story',
      sgCommentIdx + 1
    );
    // If a second scope guard exists, it must also have the rewrite
    if (genSgIdx > -1) {
      const block = claudeSrc.slice(genSgIdx, genSgIdx + 1000);
      expect(block).toMatch(/_allowed_write_paths.*MAIN_PROJECT_ROOT.*PROJECT_ROOT|_allowed_write_paths=.*\$\{_allowed_write_paths\/\//);
    } else {
      // Single scope guard path — already tested above
      expect(true).toBe(true);
    }
  });
});

// ── 7. Runtime worktrees are clean after a successful run ────────────────────
describe('post-run state — no leftover worktree dirs', () => {
  it('no skyscanner-app-wt-* dirs exist currently (clean state)', () => {
    const { execSync } = require('node:child_process');
    const count = parseInt(
      execSync('ls /home/bradleyjerome/projects/skyscanner-app-wt-* 2>/dev/null | wc -l', {
        encoding: 'utf8',
      }).trim()
    );
    expect(
      count,
      'Leftover skyscanner-app-wt-* dirs exist — teardown did not clean them'
    ).toBe(0);
  });
});
