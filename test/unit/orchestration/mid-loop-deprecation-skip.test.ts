/**
 * Step 1's main-branch loop must skip a story that became deprecated AFTER
 * it was already enqueued in the phase-start snapshot.
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run): a
 * NEW variant of the deprecated-story-requeue bug (distinct from the one
 * fixed earlier the same day in deprecated-story-requeue.test.ts, which only
 * protected against a story ALREADY deprecated before main_stories'
 * categorization query ran). This time: main_stories/non_review_main is a
 * SNAPSHOT captured once at phase start, well before Step 0.5's pre-phase
 * assessment. validate_mid_execution_splits() runs AFTER Step 0.5 (and again
 * after every story completes in this same loop) and can deprecate a story
 * for a same-file coherence violation AFTER it was already captured in that
 * snapshot. Live symptom: SKY-002-impl/-impl-1 both wrote client.ts, got
 * rejected and deprecated by the mid-execution split-gate right after Step
 * 0.5 — yet Step 1 still ran "Implementing story: SKY-002-impl" moments
 * later, burning real cost implementing a story that had already been
 * correctly abandoned.
 *
 * Fix: re-check the story's CURRENT status directly from the PRD file at
 * the top of each loop iteration (right before running it), instead of only
 * trusting the phase-start snapshot's implicit assumption that nothing
 * changed since.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Step 1 loop — live status re-check (static)', () => {
  // The per-story status checks now live inside _run_one_main_story(), the
  // shared function extracted from the old inline loop body.  Use it as the
  // anchor so the window always covers the function's guard clauses.
  it('re-checks the story status from the PRD file at the top of each loop iteration', () => {
    const idx = orchSrc.indexOf('_run_one_main_story() {');
    const block = orchSrc.slice(idx, idx + 2600);
    expect(block).toMatch(/_story_current_status=\$\(jq -r --arg id "\$story"/);
    expect(block).toMatch(/select\(\.id == \$id\) \| \.status \/\/ "pending"/);
  });

  it('skips (does not run) a story whose live status is deprecated', () => {
    const idx = orchSrc.indexOf('_run_one_main_story() {');
    const block = orchSrc.slice(idx, idx + 2600);
    expect(block).toMatch(/if \[ "\$_story_current_status" = "deprecated" \]; then/);
    expect(block).toMatch(/Skipping \$story — deprecated after being enqueued/);
  });

  it('the live re-check happens BEFORE checkpoint_already_done, so a deprecated story is never even checkpointed', () => {
    const idx = orchSrc.indexOf('_run_one_main_story() {');
    const statusCheckIdx = orchSrc.indexOf('_story_current_status=', idx);
    const checkpointIdx = orchSrc.indexOf('if checkpoint_already_done "$story"; then', idx);
    expect(statusCheckIdx).toBeGreaterThan(-1);
    expect(checkpointIdx).toBeGreaterThan(-1);
    expect(statusCheckIdx).toBeLessThan(checkpointIdx);
  });
});

describe('Step 1 loop — REAL execution: reproduces the exact live defect and proves the fix', () => {
  // Extract just the _run_one_main_story function definition — from its
  // opening line to the line before `_phase_story_failures=0`.
  function extractRunOneMainStoryFn(): string {
    const fnStart = orchSrc.indexOf('_run_one_main_story() {');
    const fnEnd   = orchSrc.indexOf('        _phase_story_failures=0', fnStart);
    if (fnStart === -1) throw new Error('_run_one_main_story not found');
    return orchSrc.slice(fnStart, fnEnd);
  }

  function checkStorySkipped(storyId: string, status: string): { skipped: boolean; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mid-loop-deprecation-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({
      stories: [{ id: storyId, status }],
    }));
    try {
      const fnDef = extractRunOneMainStoryFn();
      const script = [
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        'PHASE=core',
        'ORCH_RUN_ID=test-run',
        'LOG_DIR=/tmp',
        'SCRIPT_DIR=/bin',
        '_phase_story_failures=0',
        'info()     { echo "INFO: $*"; }',
        'log()      { :; }',
        'warning()  { :; }',
        'checkpoint_already_done()    { return 1; }',
        'check_cost_budget()          { :; }',
        'wait_if_paused()             { :; }',
        'apply_redirect_if_any()      { :; }',
        'run_inline_tc_writer_gate()  { return 0; }',
        'run_story_with_watchdog()    { echo "RAN:$1"; return 0; }',
        'run_story_recovery_analyst() { return 1; }',
        'record_story_actual_cost()   { :; }',
        'story_tsc_gate()             { return 0; }',
        'checkpoint_complete()        { :; }',
        'validate_mid_execution_splits() { :; }',
        fnDef,
        `_run_one_main_story ${JSON.stringify(storyId)}`,
        'echo "REACHED_END"',
      ].join('\n');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      let output = '';
      try {
        output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      } catch (e: any) {
        output = (e.stdout ?? '').toString();
      }
      return { skipped: output.includes('deprecated after being enqueued'), output };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live shape and proves the fix: a story deprecated mid-phase is skipped, not run', () => {
    const { skipped } = checkStorySkipped('SKY-002-impl', 'deprecated');
    expect(skipped).toBe(true);
  });

  it('a pending story is NOT skipped — no regression for the normal case', () => {
    const { skipped } = checkStorySkipped('SKY-002-impl', 'pending');
    expect(skipped).toBe(false);
  });

  it('a completed story is NOT skipped by this check (checkpoint_already_done owns that case)', () => {
    const { skipped } = checkStorySkipped('SKY-002-impl', 'completed');
    expect(skipped).toBe(false);
  });
});
