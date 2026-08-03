/**
 * Root cause of a live data-loss defect (run #12/#13, 2026-07-03): stories in the
 * same worktree lane run sequentially (SKY-002 → SKY-003 → SKY-004, chained by
 * .dependencies since the topology fix). If a LATER story in that chain exhausts
 * its 8 retries and fails, run_implementation() returns non-zero and claude.sh
 * exits non-zero — even though EARLIER stories in the same loop genuinely
 * completed. run-agent-orchestration.sh checked PRIMARY_EXIT/INDEPENDENT_EXIT and
 * `exit 1`ed immediately, BEFORE Step 3.1 (worktree-health-check.sh, AUTO_COMMIT)
 * and Step 3.2 (merge worktree branches back to master) ever ran. Since claude.sh
 * itself never called `git commit` anywhere, the earlier story's file changes sat
 * as uncommitted working-tree changes — and the run's cleanup trap calls
 * `git worktree remove --force`, which DELETES the entire worktree checkout,
 * permanently destroying that uncommitted work. Confirmed live: SKY-002 completed
 * and merged nothing when SKY-004 failed after it in the same lane.
 *
 * Fix, two parts:
 *   (a) claude.sh: a new commit_completed_story() helper commits each story's
 *       changes to the worktree's local branch immediately after
 *       update_story_status(..., "completed") — so the commit survives even if
 *       the worktree checkout is later force-removed (removing a worktree does
 *       not delete its branch or commits).
 *   (b) run-agent-orchestration.sh: the PRIMARY_EXIT/INDEPENDENT_EXIT check no
 *       longer exits immediately. It sets WORKTREE_HAD_FAILURE and continues
 *       through Step 3.1/3.2 (health-check + merge) so whatever DID commit gets
 *       merged into master, THEN fails the phase afterward — preserving the
 *       "stop the pipeline on failure" behavior without discarding real progress.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
// commit_completed_story() itself moved to lib/git-ops.sh (2026-08-02 git-ops
// consolidation) — single source of truth shared by claude.sh,
// codemie-claude.sh, and run-agent-orchestration.sh. claudeSrc is still used
// below for the CALL-SITE checks (claude.sh sources git-ops.sh and calls it).
const GIT_OPS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const gitOpsSrc = readFileSync(GIT_OPS_SH, 'utf8');

describe('claude.sh — commit_completed_story()', () => {
  it('is defined in lib/git-ops.sh and sourced by claude.sh', () => {
    expect(gitOpsSrc).toMatch(/commit_completed_story\s*\(\)/);
    expect(claudeSrc).toMatch(/source\s+"\$SCRIPT_DIR\/lib\/git-ops\.sh"/);
  });

  it('is called immediately after a story is marked completed, inside the run_implementation loop', () => {
    const implIdx = claudeSrc.indexOf('run_implementation() {');
    expect(implIdx).toBeGreaterThan(-1);
    const loopBody = claudeSrc.slice(implIdx, claudeSrc.indexOf('\n}', implIdx));
    const completedIdx = loopBody.indexOf('update_story_status "$story_id" "completed"');
    const commitIdx = loopBody.indexOf('commit_completed_story "$story_id"');
    expect(completedIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(completedIdx);
    // Must be in the same if-branch as the "completed" status update, not the "failed" branch
    const failedIdx = loopBody.indexOf('update_story_status "$story_id" "failed"');
    expect(commitIdx).toBeLessThan(failedIdx);
  });

  it('commits scoped to GIT_WORK_ROOT (the worktree checkout in --worktree mode)', () => {
    const fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
    const fnEnd = gitOpsSrc.indexOf('\n}', fnStart);
    const body = gitOpsSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/GIT_WORK_ROOT/);
    expect(body).toMatch(/git -C "\$_commit_root"/);
  });

  it('is a no-op (does not fail the story) when there is nothing to commit', () => {
    const fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
    const fnEnd = gitOpsSrc.indexOf('\n}', fnStart);
    const body = gitOpsSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/_changed_count.*-eq 0.*return 0|return 0/s);
  });
});

describe('run-agent-orchestration.sh — worktree failure no longer skips commit/merge', () => {
  it('does NOT exit immediately when a worktree agent fails', () => {
    const gateIdx = orchSrc.indexOf('WORKTREE_HAD_FAILURE=false');
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBlock = orchSrc.slice(gateIdx, gateIdx + 400);
    expect(gateBlock).not.toMatch(/exit 1/);
  });

  it('sets WORKTREE_HAD_FAILURE=true on failure instead of exiting', () => {
    const gateIdx = orchSrc.indexOf('WORKTREE_HAD_FAILURE=false');
    const gateBlock = orchSrc.slice(gateIdx, gateIdx + 400);
    expect(gateBlock).toMatch(/WORKTREE_HAD_FAILURE=true/);
  });

  it('Step 3.1 (health-check/auto-commit) appears AFTER the worktree-failure gate, not skipped by it', () => {
    const gateIdx = orchSrc.indexOf('WORKTREE_HAD_FAILURE=false');
    const step31Idx = orchSrc.indexOf('Step 3.1: Worktree health');
    expect(step31Idx).toBeGreaterThan(gateIdx);
  });

  it('Step 3.2 (merge worktree branches back) appears AFTER the worktree-failure gate', () => {
    const gateIdx = orchSrc.indexOf('WORKTREE_HAD_FAILURE=false');
    const step32Idx = orchSrc.indexOf('Merging worktree branches back to main branch');
    expect(step32Idx).toBeGreaterThan(gateIdx);
  });

  it('fails the phase AFTER Step 3.2 if WORKTREE_HAD_FAILURE was set (commit/merge still happened first)', () => {
    const step32Idx = orchSrc.indexOf('Merging worktree branches back to main branch');
    const finalFailIdx = orchSrc.indexOf('if [ "$WORKTREE_HAD_FAILURE" = true ]; then');
    expect(finalFailIdx).toBeGreaterThan(step32Idx);
    const finalBlock = orchSrc.slice(finalFailIdx, finalFailIdx + 300);
    expect(finalBlock).toMatch(/exit 1/);
  });
});

// ── Diagnostic instrumentation + bounded timeout (found live, 2026-07-06) ────
// A live run's story-level 600s watchdog killed the whole claude.sh subprocess
// with ZERO log output for ~9 minutes after a story had already succeeded
// (deliverables verified, TC-writer complete) — generate_story_contract() and
// commit_completed_story() were the only unlogged steps in between, so it was
// impossible to tell which one (if either) actually hung. Fix: log before/after
// each, and bound commit_completed_story()'s git calls with a timeout so a
// stale lock or slow filesystem fails fast and visibly instead of silently
// consuming the entire watchdog budget.
describe('run_implementation() — diagnostic logging around post-story steps', () => {
  it('logs before and after generate_story_contract, and before and after commit_completed_story', () => {
    const implIdx = claudeSrc.indexOf('run_implementation() {');
    const loopBody = claudeSrc.slice(implIdx, claudeSrc.indexOf('\n}', implIdx));
    expect(loopBody).toMatch(/\[post-story\] Generating dependency contract for \$story_id/);
    expect(loopBody).toMatch(/\[post-story\] Contract generation complete for \$story_id/);
    expect(loopBody).toMatch(/\[post-story\] Committing completed work for \$story_id/);
    expect(loopBody).toMatch(/\[post-story\] Commit step complete for \$story_id/);
  });

  it('the logging brackets each call precisely (before-log, then the call, then after-log)', () => {
    const implIdx = claudeSrc.indexOf('run_implementation() {');
    const loopBody = claudeSrc.slice(implIdx, claudeSrc.indexOf('\n}', implIdx));
    const beforeContract = loopBody.indexOf('Generating dependency contract');
    const contractCall = loopBody.indexOf('generate_story_contract "$story_id"');
    const afterContract = loopBody.indexOf('Contract generation complete');
    expect(beforeContract).toBeLessThan(contractCall);
    expect(contractCall).toBeLessThan(afterContract);

    const beforeCommit = loopBody.indexOf('Committing completed work');
    const commitCall = loopBody.indexOf('commit_completed_story "$story_id"');
    const afterCommit = loopBody.indexOf('Commit step complete');
    expect(beforeCommit).toBeGreaterThan(afterContract);
    expect(beforeCommit).toBeLessThan(commitCall);
    expect(commitCall).toBeLessThan(afterCommit);
  });
});

describe('commit_completed_story() — bounded timeout on git operations (static)', () => {
  const fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
  const fnEnd = gitOpsSrc.indexOf('\n}', fnStart);
  const body = gitOpsSrc.slice(fnStart, fnEnd);

  it('wraps git add, git diff --cached, and git commit with timeout', () => {
    expect(body).toMatch(/timeout "\$_git_timeout" git -C "\$_commit_root" add -A/);
    expect(body).toMatch(/timeout "\$_git_timeout" git -C "\$_commit_root" diff --cached/);
    expect(body).toMatch(/timeout "\$_git_timeout" git -C "\$_commit_root" commit/);
  });

  it('the timeout duration is configurable via EPAM_COMMIT_TIMEOUT_SECS, defaulting to 60s', () => {
    expect(body).toMatch(/_git_timeout="\$\{EPAM_COMMIT_TIMEOUT_SECS:-60\}"/);
  });

  it('detects timeout (exit 124) on git add and warns distinctly, without falling through to the commit step', () => {
    expect(body).toMatch(/_add_rc.*-eq 124/s);
    expect(body).toMatch(/git add timed out after \$\{_git_timeout\}s/);
  });

  it('detects timeout (exit 124) on git commit and warns distinctly from a generic commit failure', () => {
    expect(body).toMatch(/_commit_rc.*-eq 124/s);
    expect(body).toMatch(/git commit timed out after \$\{_git_timeout\}s/);
  });
});

describe('commit_completed_story() — REAL execution, proves the timeout actually bounds a hang', () => {
  function runCommitWithStubbedGit(gitStub: string): { stdout: string; exitCode: number; durationMs: number } {
    const dir = mkdtempSync(join(tmpdir(), 'commit-timeout-test-'));
    try {
      const fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
      const fnEnd = gitOpsSrc.indexOf('\n}', fnStart);
      const fnBody = gitOpsSrc.slice(fnStart, fnEnd + 2);
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      // Stub out `git` on PATH so this test needs no real repo and can simulate
      // a hang deterministically and fast.
      writeFileSync(join(binDir, 'git'), gitStub, { mode: 0o755 });
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          `export PATH="${binDir}:$PATH"`,
          `GIT_WORK_ROOT="${dir}"`,
          `EPAM_COMMIT_TIMEOUT_SECS=1`,
          `log() { echo "LOG: $*"; }`,
          `warning() { echo "WARN: $*"; }`,
          fnBody,
          `commit_completed_story "SKY-TEST"`,
          `echo "EXIT:$?"`,
        ].join('\n')
      );
      const start = Date.now();
      let stdout = '';
      let exitCode = 0;
      try {
        stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
        exitCode = e.status ?? -1;
      }
      return { stdout, exitCode, durationMs: Date.now() - start };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a hanging `git add` is killed by the timeout instead of blocking indefinitely', () => {
    // Simulates the exact live failure mode: git never returns.
    const hangingGit = '#!/usr/bin/env bash\nif [ "$1" = "-C" ] && [ "$3" = "add" ]; then sleep 300; fi\nexit 0\n';
    const result = runCommitWithStubbedGit(hangingGit);
    expect(result.stdout).toMatch(/git add timed out after 1s/);
    // Must return well within the test's own 15s ceiling — proves the 1s
    // EPAM_COMMIT_TIMEOUT_SECS actually bounded the hang rather than the
    // process running to the full simulated 300s sleep.
    expect(result.durationMs).toBeLessThan(10000);
  });

  it('a normal (fast) git sequence with changes reports success, unaffected by the timeout wrapper', () => {
    const fastGit = [
      '#!/usr/bin/env bash',
      'if [ "$3" = "diff" ]; then echo "src/index.ts"; exit 0; fi',
      'exit 0',
    ].join('\n') + '\n';
    const result = runCommitWithStubbedGit(fastGit);
    expect(result.stdout).toMatch(/Committed 1 file\(s\) for SKY-TEST/);
    expect(result.stdout).not.toMatch(/timed out/);
  });

  it('no changes staged is still a fast no-op (returns before ever reaching the commit timeout path)', () => {
    const noChangesGit = [
      '#!/usr/bin/env bash',
      'if [ "$3" = "diff" ]; then exit 0; fi', // empty output = 0 changed files
      'exit 0',
    ].join('\n') + '\n';
    const result = runCommitWithStubbedGit(noChangesGit);
    expect(result.stdout).not.toMatch(/Committed|timed out/);
  });
});
