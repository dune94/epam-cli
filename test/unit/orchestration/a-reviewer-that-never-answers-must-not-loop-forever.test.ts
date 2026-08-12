/**
 * A REVIEWER THAT NEVER PRODUCES A VERDICT MUST STOP THE PHASE, NOT SPIN FOREVER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * Live 2026-08-12. The story implemented cleanly — "Implemented: 1, Failed: 0, Skipped: 0" —
 * and then this repeated 701 times:
 *
 *     team-lead-review.sh: line 462: local: can only be used in a function
 *     WARNING Step 3.6: the REVIEWER did not produce a verdict (no per-story feedback)
 *             — re-running the REVIEW, not re-implementing (cycle 700 → 701)
 *
 * The reviewer died on a bash runtime error (`local` at top level, introduced 2026-08-10 in
 * 2bb230e, invisible to `bash -n`, and reported by shellcheck the entire time). Retrying could
 * never change that outcome.
 *
 * THE LOOP DEFECT IS SEPARATE FROM THE SYNTAX BUG, and outlives it. Step 3.6 already HAS a
 * safety valve:
 *
 *     _review_max_cycles="${REVIEW_MAX_CYCLES:-$(( _review_max_retries / 2 + 3 ))}"
 *     ...
 *     if [ "$_review_cycle" -ge "$_review_max_cycles" ]; then   # line ~8108
 *
 * but the no-verdict branch `continue`s at line ~8081, BEFORE that check — so the one bound
 * that exists is jumped straight over. Every other exit from this loop is bounded; this one
 * was not.
 *
 * Retrying a no-verdict is right for a transient miss (a model returning junk once) and wrong
 * forever after: a reviewer that cannot execute produces no verdict every single time. The
 * distinction the loop cannot make is WHY, so the bound is what makes it safe — the same
 * "unknown is not a free retry" rule as the rest of this pipeline.
 *
 * Bound reused, not invented: _review_max_cycles already exists and already means "how many
 * times may this loop go round". A second number would be a second thing to maintain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const STORY_RETRY_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

/** The REAL Step 3.6 loop, lifted verbatim — same extraction the ladder test uses. */
function extractBlock(startMarker: string, endMarker: string): string {
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = orchSrc.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return orchSrc.slice(start, end + endMarker.length);
}
const REVIEW_LOOP_BLOCK = extractBlock(
  '_review_max_retries="${EPAM_MAX_RETRIES:-7}"',
  'error "         A change the reviewer never approved must NOT proceed — human review required."\n    exit 2\nfi',
);

const cleanupDirs: string[] = [];
afterEach(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TIMEOUT_MS = 20000;

/**
 * Runs the real loop against a reviewer that NEVER produces a verdict — exactly what a
 * reviewer dying on a runtime error looks like from the loop's side.
 */
function runNeverAnswering(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-no-verdict-'));
  cleanupDirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify({
    implementationOrder: { core: ['S-1'] },
    stories: [{ id: 'S-1', agentRole: 'writer' }],
  }));

  // The reviewer stub reproduces the live failure: it writes NO feedback file and fails,
  // the way a script that dies on `local` at top level does.
  const stubPath = join(dir, 'team-lead-review.sh');
  writeFileSync(stubPath, [
    '#!/usr/bin/env bash',
    'echo "team-lead-review.sh: line 462: local: can only be used in a function" >&2',
    'exit 1',
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  const cycleLog = join(dir, 'cycles.txt');
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    `export SCRIPT_DIR=${JSON.stringify(dir)}`,
    `export PRD_FILE=${JSON.stringify(prdPath)}`,
    `export AGENT_PROFILES_FILE=${JSON.stringify(join(dir, 'profiles.json'))}`,
    'export PHASE=core',
    `export LOG_DIR=${JSON.stringify(logDir)}`,
    ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
    'echo "{}" > "$AGENT_PROFILES_FILE"',
    'log() { :; }',
    `warning() { echo "WARN: $*"; case "$*" in *"did not produce a verdict"*) echo x >> ${JSON.stringify(cycleLog)};; esac; }`,
    'error() { echo "ERROR: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    '_emit_agent() { :; }',
    // THE POINT OF THIS TEST: the reviewer never answers, every cycle, forever.
    'review_feedback_is_incomplete() { return 0; }',
    '_reset_story_for_reimplementation() { :; }',
    '_persist_skill_note_simple() { :; }',
    'run_story_with_watchdog() { :; }',
    `source ${JSON.stringify(STORY_RETRY_LIB)}`,
    REVIEW_LOOP_BLOCK,
    'echo "REACHED_END"',
  ].join('\n'));

  const started = Date.now();
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: TIMEOUT_MS });
  let cycles = 0;
  try { cycles = readFileSync(cycleLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { /* none */ }
  return {
    exitCode: result.status,
    timedOut: Date.now() - started >= TIMEOUT_MS - 500,
    output: (result.stdout || '') + (result.stderr || ''),
    cycles,
  };
}

describe('the harness reproduces the live failure', () => {
  it('the loop really does take the no-verdict branch', () => {
    // Without this, every assertion below could pass on a loop that exits for other reasons.
    const r = runNeverAnswering();
    expect(r.cycles, 'the no-verdict path was never taken — the test proves nothing')
      .toBeGreaterThan(0);
  });
});

describe('THE DEFECT: 701 CYCLES', () => {
  it('TERMINATES — it does not spin until something else kills it', () => {
    const r = runNeverAnswering();
    expect(r.timedOut, `the loop never exited (ran the full ${TIMEOUT_MS}ms) — this is the live 701-cycle hang`)
      .toBe(false);
  });

  it('is bounded by the safety valve that already exists', () => {
    // REVIEW_MAX_CYCLES=4 -> a handful of no-verdict cycles, not hundreds. The exact bound is
    // the pipeline's business; that it IS bounded is this test's business.
    const r = runNeverAnswering({ REVIEW_MAX_CYCLES: '4' });
    expect(r.cycles, `${r.cycles} no-verdict cycles with the valve set to 4`)
      .toBeLessThanOrEqual(4);
  });

  it('honours a bound of 1 — the branch reads the valve, it does not approximate it', () => {
    const r = runNeverAnswering({ REVIEW_MAX_CYCLES: '1' });
    expect(r.cycles).toBeLessThanOrEqual(1);
  });

  it('FAILS the phase rather than passing an unreviewed change', () => {
    // The worst possible outcome is a silent success: a change no reviewer ever approved,
    // shipped because the loop gave up quietly.
    const r = runNeverAnswering({ REVIEW_MAX_CYCLES: '3' });
    expect(r.exitCode, 'a phase whose reviewer never answered reported success').not.toBe(0);
    expect(r.output).not.toContain('REACHED_END');
  });

  it('says the reviewer never answered — not "changes requested"', () => {
    // Misreporting this as a rejected review sends the next investigator after the writer's
    // code, which is exactly what happened live: 701 cycles blamed on the story.
    const r = runNeverAnswering({ REVIEW_MAX_CYCLES: '3' });
    expect(r.output).toMatch(/verdict|never answered|could not review|not produce/i);
  });
});
