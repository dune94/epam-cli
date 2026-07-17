/**
 * TC-density split design gap regression test.
 *
 * Root cause (observed live, 2026-07-16, tier3-travel-app run 20260716T172011):
 * The main story loop in run-agent-orchestration.sh iterates over
 * `$non_review_main`, a fixed snapshot of implementationOrder captured once at
 * phase start. When run_inline_tc_writer_gate fires on the LAST story in that
 * snapshot and performs a TC-density split (returning 1 = "caller should skip"),
 * the split children (e.g. SKY-004-c-tc1, SKY-004-c-tc2) are written to
 * prd.json but the loop's iterator is already exhausted — no more items remain
 * in the fixed string. Those children are silently dropped and never executed
 * in the same phase pass.
 *
 * Fix: add a "tail sweep" immediately after the main loop that re-reads
 * implementationOrder[$PHASE] from prd.json and executes any pending stories
 * not present in the original snapshot.
 *
 * These tests:
 *   1. Static assertion — FAILS until the tail sweep code appears in the source.
 *   2. Behavioural — FAILS until the tail sweep actually executes the children.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH   = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const orchSrc   = readFileSync(ORCH_SH, 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────

function nodeBin(): string {
  try { return execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim(); }
  catch { return 'node'; }
}

/**
 * Extract the complete fixed-story execution block: the helper function
 * definition + the main loop + the tail sweep.  This throws if the fix has
 * not yet been applied (function not found), which is intentional — the test
 * should fail before the fix lands.
 *
 * Start marker: `_run_one_main_story() {`  (only present after the fix)
 * End marker:   `if [ "$_phase_story_failures" -gt 0 ]` (next occurrence)
 */
function extractLoopSection(): string {
  const startMarker = '_run_one_main_story() {';
  const endMarker   = 'if [ "$_phase_story_failures" -gt 0 ]';
  const startIdx    = orchSrc.indexOf(startMarker);
  if (startIdx === -1) throw new Error(
    '_run_one_main_story function not found — tail-sweep fix not yet applied to run-agent-orchestration.sh'
  );
  const endIdx = orchSrc.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('loop end marker not found in run-agent-orchestration.sh');
  return orchSrc.slice(startIdx, endIdx);
}

// ── Static assertion ──────────────────────────────────────────────────────────

describe('TC-density split design gap — static structure check', () => {
  it('story loop has a tail-sweep block after done <<< "$non_review_main" (FAILS until fix is applied)', () => {
    const section = extractLoopSection();  // throws if _run_one_main_story not found
    // Must have a clear tail-sweep comment/label
    expect(section).toContain('tail-sweep');
    // Tail sweep must re-query prd.json for pending stories in the phase
    expect(section).toMatch(/jq.*implementationOrder.*\$PHASE|implementationOrder.*phase.*PHASE/s);
    // Must have at least two while-read loops: the main one and the sweep
    const loopMatches = section.match(/while IFS= read -r story/g) ?? [];
    expect(loopMatches.length).toBeGreaterThanOrEqual(2);
    // The sweep loop must appear AFTER the main loop's `done`
    const mainLoopEnd    = section.indexOf('done <<< "$non_review_main"');
    const sweepLoopStart = section.indexOf('while IFS= read -r story', mainLoopEnd);
    expect(mainLoopEnd).toBeGreaterThan(-1);
    expect(sweepLoopStart).toBeGreaterThan(mainLoopEnd);
  });
});

// ── Behavioural test ──────────────────────────────────────────────────────────

describe('TC-density split design gap — behavioural (FAILS until fix is applied)', () => {
  it('when the last story in a phase is TC-density split mid-loop, the children are executed in the same pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-split-gap-'));
    try {
      const prdPath     = join(dir, 'prd.json');
      const executedLog = join(dir, 'executed.txt');

      // PRD: SKY-A is first (impl), SKY-LAST-test is last (test with 35 facts).
      // The TC gate will split SKY-LAST-test → tc1 + tc2 when the harness runs.
      const facts = Array.from({ length: 35 }, (_, i) => `fact-${i}`);
      writeFileSync(prdPath, JSON.stringify({
        stories: [
          {
            id: 'SKY-A', title: 'Story A', status: 'pending', completed: false,
            agentRole: 'typescript-engineer', acceptanceCriteria: ['ac1'],
          },
          {
            id: 'SKY-LAST-test', title: 'Last test story', status: 'pending', completed: false,
            agentRole: 'test-engineer',
            technicalNotes: { files: ['src/last.test.ts'] },
            testCriteria: { facts },
          },
        ],
        implementationOrder: { core: ['SKY-A', 'SKY-LAST-test'] },
      }, null, 2));

      const loopSection = extractLoopSection();
      const node        = nodeBin();

      // update-monitor.sh stub: silent no-op
      const stubScriptDir = join(dir, 'scripts');
      execFileSync('bash', ['-c', `mkdir -p ${stubScriptDir}`]);
      writeFileSync(join(stubScriptDir, 'update-monitor.sh'),
        '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

      const harness = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        `LOG_DIR=${JSON.stringify(dir)}`,
        `SCRIPT_DIR=${JSON.stringify(stubScriptDir)}`,
        'PHASE=core',
        `EXECUTED_LOG=${JSON.stringify(executedLog)}`,
        `NODE_CMD=${JSON.stringify(node)}`,
        `SPEC_RUNNER=${JSON.stringify(SPEC_RUNNER)}`,
        '',
        '# Fixed snapshot — same as the real script builds at phase start',
        'non_review_main="SKY-A',
        'SKY-LAST-test"',
        '',
        '# ── Stubs ────────────────────────────────────────────────────────────',
        'log()     { echo "LOG: $*" >&2; }',
        'info()    { echo "INFO: $*" >&2; }',
        'warning() { echo "WARN: $*" >&2; }',
        'error()   { echo "ERROR: $*" >&2; }',
        'success() { echo "OK: $*" >&2; }',
        'step_emit()                   { :; }',
        'check_cost_budget()           { :; }',
        'wait_if_paused()              { :; }',
        'apply_redirect_if_any()       { :; }',
        'record_story_actual_cost()    { :; }',
        'story_tsc_gate()              { return 0; }',
        'checkpoint_already_done()     { return 1; }',  // not done yet
        'checkpoint_complete()         { :; }',
        'validate_mid_execution_splits() { :; }',
        'run_story_recovery_analyst()  { return 1; }',  // no recovery
        '',
        '# run_story_with_watchdog: record execution to log; always succeeds',
        'run_story_with_watchdog() {',
        '  local _s="$1"',
        '  echo "$_s" >> "$EXECUTED_LOG"',
        '  return 0',
        '}',
        '',
        '# run_inline_tc_writer_gate:',
        '#   SKY-LAST-test → split into tc1/tc2 via spec-mode-runner.js, return 1',
        '#   all other stories → return 0 (proceed normally)',
        'run_inline_tc_writer_gate() {',
        '  local _story="$1"',
        '  if [ "$_story" = "SKY-LAST-test" ]; then',
        '    "$NODE_CMD" "$SPEC_RUNNER" --split-test-story "$PRD_FILE" "$_story" >/dev/null 2>&1',
        '    return 1',
        '  fi',
        '  return 0',
        '}',
        '',
        '# ── Extracted loop section from run-agent-orchestration.sh ───────────',
        loopSection,
        '',
        'echo "HARNESS_DONE"',
      ].join('\n');

      const harnessPath = join(dir, 'harness.sh');
      writeFileSync(harnessPath, harness, { mode: 0o755 });

      let stdout = '';
      let stderr = '';
      try {
        stdout = execFileSync('bash', [harnessPath], { encoding: 'utf8', timeout: 15_000 });
      } catch (e: any) {
        stdout = (e.stdout ?? '').toString();
        stderr = (e.stderr ?? '').toString();
      }

      // Harness must complete without error
      expect(stdout).toContain('HARNESS_DONE');

      // Read what was executed
      let executed: string[] = [];
      try {
        executed = readFileSync(executedLog, 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        // file not written at all = nothing executed
      }

      // SKY-A must have run (sanity check)
      expect(executed).toContain('SKY-A');

      // THE KEY ASSERTION: split children must have been picked up
      // With the old fixed-snapshot loop this FAILS — tc1/tc2 are never executed.
      // With the tail-sweep fix this PASSES.
      expect(executed).toContain('SKY-LAST-test-tc1');
      expect(executed).toContain('SKY-LAST-test-tc2');

      // The original parent must NOT have been executed (it was deprecated by the split)
      expect(executed).not.toContain('SKY-LAST-test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
