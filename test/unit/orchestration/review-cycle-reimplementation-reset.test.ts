/**
 * A retry that skips is not a retry.
 *
 * Live AMSD-2041 2026-07-30, metrolinx. The team-lead reviewer requested
 * changes with 7 blockers. Step 3.6's inner loop logged the expected recovery:
 *
 *   Step 3.6: review requested changes — re-implementing (cycle 1 → 2)
 *   Re-implementing AMSD-2041 to address reviewer feedback (self-heal enabled)...
 *
 * and then, within the same second:
 *
 *   Story AMSD-2041 is already completed, skipping
 *   Implemented: 0, Failed: 0, Skipped: 1
 *
 * `run_story_with_watchdog` invokes `claude.sh "$story_id"`, whose very first
 * check is `is_story_completed` — true, because Step 8 marks a story
 * `completed` the moment the agent's turn ends, regardless of whether the
 * work is any good. Nothing between the reviewer's rejection and this
 * re-implementation call ever clears that flag, so the "self-heal enabled"
 * cycle is a guaranteed no-op: zero new code, zero new review evidence. One
 * of the two review cycles (REVIEW_MAX_CYCLES=2) is pure waste, every time
 * review requests changes on any story.
 *
 * The outer whole-phase gate-remediation retry (exit 2 -> reset -> --reset)
 * already resets correctly — the exact same semantics
 * (`.completed = false | .status = "pending"`) just never run at the INNER,
 * per-story, per-cycle scope.
 *
 * THE FIX must be scoped to exactly the ONE story being re-implemented — a
 * broader reset (the whole phase, or every review-feedback story at once)
 * would discard progress on siblings that passed review cleanly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in run-agent-orchestration.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

function prdWith(stories: Array<Record<string, unknown>>) {
  const d = mkdtempSync(join(tmpdir(), 'reimpl-reset-'));
  dirs.push(d);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories }));
  return prd;
}

describe('the story being re-implemented is reset before the retry runs', () => {
  it('clears completed and status so is_story_completed no longer short-circuits it', () => {
    const prd = prdWith([
      { id: 'AMSD-2041', completed: true, status: 'completed', completedAt: '2026-07-30T18:00:00Z' },
    ]);
    const script = join(dirs[dirs.length - 1], 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MAIN_PRD_FILE=${JSON.stringify(prd)}
PRD_FILE=${JSON.stringify(prd)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_reset_story_for_reimplementation')}
_reset_story_for_reimplementation "AMSD-2041"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const story = after.stories.find((s: { id: string }) => s.id === 'AMSD-2041');
    expect(story.completed, 'is_story_completed will still short-circuit the retry').toBe(false);
    expect(story.status).toBe('pending');
  });

  it('does not touch a DIFFERENT story\'s completed state', () => {
    // Siblings that passed review cleanly must not be re-run.
    const prd = prdWith([
      { id: 'AMSD-2041', completed: true, status: 'completed' },
      { id: 'AMSD-2041-B', completed: true, status: 'completed' },
    ]);
    const script = join(dirs[dirs.length - 1], 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MAIN_PRD_FILE=${JSON.stringify(prd)}
PRD_FILE=${JSON.stringify(prd)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_reset_story_for_reimplementation')}
_reset_story_for_reimplementation "AMSD-2041"
`);
    spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const sibling = after.stories.find((s: { id: string }) => s.id === 'AMSD-2041-B');
    expect(sibling.completed, 'a sibling story was reset — this must be scoped to ONE story').toBe(true);
  });

  it('tolerates a story id that does not exist without erroring', () => {
    const prd = prdWith([{ id: 'X-1', completed: true, status: 'completed' }]);
    const script = join(dirs[dirs.length - 1], 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MAIN_PRD_FILE=${JSON.stringify(prd)}
PRD_FILE=${JSON.stringify(prd)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_reset_story_for_reimplementation')}
_reset_story_for_reimplementation "NOT-A-REAL-ID"
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout).toMatch(/RC=0/);
  });

  it('leaves a story that was never completed untouched (idempotent)', () => {
    const prd = prdWith([{ id: 'AMSD-2041', completed: false, status: 'pending' }]);
    const script = join(dirs[dirs.length - 1], 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
MAIN_PRD_FILE=${JSON.stringify(prd)}
PRD_FILE=${JSON.stringify(prd)}
log(){ :; }; warning(){ :; }; error(){ :; }
${fnText('_reset_story_for_reimplementation')}
_reset_story_for_reimplementation "AMSD-2041"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(prd, 'utf8'));
    expect(after.stories[0].completed).toBe(false);
  });
});

describe('the reset is actually wired into the re-implementation cycle', () => {
  it('is called before run_story_with_watchdog in Step 3.6\'s re-implementation loop', () => {
    const anchor = 'Re-implementing $_fb_story to address reviewer feedback';
    const i = SRC.indexOf(anchor);
    expect(i, 'the re-implementation log line is gone — this is anchored to nothing').toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, i - 400), i);
    const after = SRC.slice(i, i + 400);
    expect(before + after, 'the retry never resets the story it is about to re-run — ' +
      'is_story_completed will skip it exactly as it did live on 2026-07-30')
      .toMatch(/_reset_story_for_reimplementation/);
    // Must run BEFORE run_story_with_watchdog, not after — resetting after the
    // fact does nothing for the call it was supposed to unblock.
    const resetIdx = (before + after).indexOf('_reset_story_for_reimplementation');
    const watchdogIdx = (before + after).indexOf('run_story_with_watchdog');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(watchdogIdx).toBeGreaterThan(-1);
    expect(resetIdx, 'the reset runs AFTER the retry it was meant to enable').toBeLessThan(watchdogIdx);
  });
});
