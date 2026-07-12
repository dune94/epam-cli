/**
 * A story that times out twice under the watchdog must be treated as a real
 * failure, not silently reported as success.
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
 * run_story_with_watchdog() (run-agent-orchestration.sh, ~line 687-770)
 * unconditionally `return 0`'d after a double-timeout in its non-pause
 * branch ("skipping story and continuing"). The caller (Step 1's main-branch
 * loop, ~line 2508-2511) only increments `_phase_story_failures` when the
 * watchdog call exits non-zero — so a timed-out story was silently treated
 * as a success: the phase kept going, `checkpoint_complete` was called for
 * a story that never actually finished, and the PRD was left with that
 * story stuck at `status: "pending"` forever, with no record anywhere that
 * anything went wrong. This is the same failure class as the original
 * vanishing-stories bug (a deliverable silently disappears with no signal)
 * via a different mechanism (watchdog timeout instead of a bad split/rewrite).
 *
 * Live symptom: SKY-002-test hit "Watchdog: SKY-002-test timed out twice
 * (600s then 900s) — skipping story and continuing", the loop moved on to
 * SKY-003-test, and travel-app-prd.json showed SKY-002-test as "pending"
 * with no completed/failed status and no phase abort.
 *
 * Fix: on a double-timeout in the non-pause branch, mark the story
 * `status: "failed"` in the PRD (with a technicalNotes.failureReason) and
 * `return 1` instead of `return 0`, so the caller's failure counter and
 * phase-abort gate see it. The operator-pause branch (EPAM_PAUSE_ON_TIMEOUT=
 * true) is left returning 0 — that path exists specifically so an operator
 * can intervene before resuming, a deliberately different contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractWatchdogFunction(): string {
  const start = orchSrc.indexOf('run_story_with_watchdog() {');
  // Function ends at the first top-level "}" after the final "return $_rc"
  const endMarker = "return $_rc\n}";
  const endIdx = orchSrc.indexOf(endMarker, start);
  return orchSrc.slice(start, endIdx + endMarker.length);
}

describe('run_story_with_watchdog — double-timeout failure propagation (static)', () => {
  const fn = extractWatchdogFunction();

  it('the non-pause double-timeout branch marks the story failed in the PRD', () => {
    const idx = fn.indexOf('skipping story and continuing');
    const block = fn.slice(idx, idx + 1800);
    expect(block).toMatch(/\.status\) = "failed"/);
    expect(block).toMatch(/technicalNotes\.failureReason/);
  });

  it('the non-pause double-timeout branch returns 1, not 0', () => {
    const idx = fn.indexOf('skipping story and continuing');
    const block = fn.slice(idx, idx + 1800);
    expect(block).toMatch(/return 1/);
  });

  it('the operator-pause branch still returns 0 (deliberately different contract)', () => {
    const idx = fn.indexOf('Operator resumed');
    const block = fn.slice(idx, idx + 100);
    expect(block).toMatch(/return 0/);
  });
});

describe('run_story_with_watchdog — REAL execution: reproduces the exact live defect and proves the fix', () => {
  function runWatchdog(pauseOnTimeout: boolean): { rc: number; prd: any } {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-timeout-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({
      stories: [{ id: 'SKY-002-test', status: 'pending', effort: 'low', technicalNotes: {} }],
    }, null, 2));

    // Stub CLAUDE_SH: a script that just sleeps forever, so `timeout` always
    // fires (rc=124) on both the first and the extended-retry invocation.
    const stubPath = join(dir, 'claude-stub.sh');
    writeFileSync(stubPath, ['#!/usr/bin/env bash', 'sleep 999999', ].join('\n'));
    chmodSync(stubPath, 0o755);

    const logDir = mkdtempSync(join(tmpdir(), 'watchdog-timeout-log-'));

    const fn = extractWatchdogFunction();
    // error()/warning()/log() are used by the function; stub them as no-ops
    // that still echo to stderr so failures are visible if something breaks.
    const script = [
      'set -euo pipefail',
      'error() { echo "[ERROR] $1" >&2; }',
      'warning() { echo "[WARNING] $1" >&2; }',
      'log() { echo "[LOG] $1" >&2; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `MAIN_PRD_FILE=${JSON.stringify(prdPath)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      `CLAUDE_SH=${JSON.stringify(stubPath)}`,
      'PHASE=core',
      'STORY_TIMEOUT_SECS=1',
      'EPAM_WATCHDOG_RETRY_MULTIPLIER=1',
      `EPAM_PAUSE_ON_TIMEOUT=${pauseOnTimeout ? 'true' : 'false'}`,
      'EPAM_MAX_PAUSE_SECS=1',
      // wait_if_paused is only invoked on the pause path — stub it so the
      // pause-branch test doesn't actually block. hot_swap_story_model_if_unstable
      // is invoked on the first-timeout retry path — stub it as a no-op.
      'wait_if_paused() { :; }',
      'hot_swap_story_model_if_unstable() { :; }',
      fn,
      'run_story_with_watchdog "SKY-002-test" "'+ join(logDir, 'main-SKY-002-test.log') +'"',
      'echo "RC=$?"',
    ].join('\n');

    let out = '';
    try {
      out = execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000 });
    } catch (e: any) {
      out = (e.stdout ?? '').toString();
    }
    const m = out.match(/RC=(\d+)/);
    const rc = m ? parseInt(m[1], 10) : -1;
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    return { rc, prd };
  }

  it('REPRODUCES the exact live defect and proves the fix: double-timeout marks the story failed and returns non-zero', () => {
    const { rc, prd } = runWatchdog(false);
    const story = prd.stories.find((s: any) => s.id === 'SKY-002-test');
    expect(rc).not.toBe(0);
    expect(story.status).toBe('failed');
    expect(story.technicalNotes.failureReason).toMatch(/watchdog_timeout/);
  }, 25000);

  it('the operator-pause path (EPAM_PAUSE_ON_TIMEOUT=true) still returns 0 after the operator resumes', () => {
    const { rc } = runWatchdog(true);
    expect(rc).toBe(0);
  }, 25000);
});
