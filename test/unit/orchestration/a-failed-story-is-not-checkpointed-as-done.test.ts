/**
 * A CHECKPOINT RECORDS WHAT WAS DONE — NEVER A FAILURE.
 *
 * regintel 20260916T200108Z, 2026-09-17 (resume on 2.0.48): the previous invocation had failed
 * REGI-001a and REGI-001b after 8 attempts each and checkpoint_complete was written for both
 * anyway — it ran after the success/failure branch, unconditionally. The resume re-queued them
 * to pending, then the story loop said "Skipping REGI-001a — already completed in checkpoint",
 * the reviewer found no rung to review on, refused six times, and the phase aborted having done
 * no work at all.
 *
 * This EXECUTES the real _run_one_main_story (lifted from run-agent-orchestration.sh, with the
 * real checkpoints.sh) and stubs only its collaborators: the writer (run_story_with_watchdog),
 * the tsc gate, the recovery analyst, the monitor. Asserted on the CHECKPOINT FILE — what the
 * next resume reads — not on a log line.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CHECKPOINTS = join(ROOT, 'orchestrations/scripts/lib/checkpoints.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function storyBody(): string {
  const src = engineSource(ORCH);
  const start = src.indexOf('        _run_one_main_story() {');
  expect(start, '_run_one_main_story not found').toBeGreaterThan(-1);
  const end = src.indexOf('\n        }\n', start);
  return src.slice(start, end + 11);
}

function runStory(opts: { writerExit: number; tscOk?: boolean }) {
  const d = mkdtempSync(join(tmpdir(), 'ckpt-done-')); dirs.push(d);
  const logs = join(d, 'logs'); mkdirSync(logs);
  const scripts = join(d, 'scripts'); mkdirSync(scripts);
  writeFileSync(join(scripts, 'update-monitor.sh'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(scripts, 'update-monitor.sh'), 0o755);
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'REGI-001a', status: 'pending', agentRole: 'eng' }] }));
  const ck = join(logs, 'checkpoint-scaffold-run1.jsonl');
  const script = [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    `PRD_FILE=${JSON.stringify(prd)}`, 'PHASE=scaffold', 'ORCH_RUN_ID=run1', `LOG_DIR=${JSON.stringify(logs)}`, `SCRIPT_DIR=${JSON.stringify(scripts)}`,
    `CHECKPOINT_FILE=${JSON.stringify(ck)}`, '_phase_story_failures=0', '_phase_failed_stories=""',
    'info(){ :; }; log(){ :; }; warning(){ :; }; success(){ :; }',
    `source ${JSON.stringify(CHECKPOINTS)}`,
    'ensure_story_branch(){ :; }', 'apply_redirect_if_any(){ :; }', 'validate_mid_execution_splits(){ :; }', 'record_story_actual_cost(){ :; }',
    'run_story_recovery_analyst(){ return 1; }',
    // The pre-writer gates and bookkeeping: each is its own seam with its own tests; here they let the story through.
    'check_cost_budget(){ :; }', 'wait_if_paused(){ :; }', 'run_inline_tc_writer_gate(){ return 0; }', 'qa_phase_baseline_sha(){ echo ""; }',
    `PROJECT_ROOT=${JSON.stringify(d)}`, 'export ORCH_STORY_START_EMITTED=0',
    `run_story_with_watchdog(){ return ${opts.writerExit}; }`,
    `story_tsc_gate(){ return ${opts.tscOk === false ? 1 : 0}; }`,
    storyBody(),
    '_run_one_main_story REGI-001a',
    'echo "FAILURES=$_phase_story_failures"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const records = existsSync(ck) ? readFileSync(ck, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, records };
}

describe('a failed story is not checkpointed as done', () => {
  it("run 200108Z's shape: the writer fails — NO checkpoint record, the failure is counted", () => {
    const { r, records } = runStory({ writerExit: 1 });
    expect(r.status, r.stderr).toBe(0);
    expect(records, 'a failed story was recorded as completed; the next resume will skip it').toEqual([]);
    expect(r.stdout).toMatch(/FAILURES=1/);
  });

  it('the writer succeeds and the tsc gate passes — the record IS written', () => {
    const { r, records } = runStory({ writerExit: 0 });
    expect(records.map((x) => x.storyId)).toEqual(['REGI-001a']);
    expect(records[0].status).toBe('completed');
    expect(r.stdout).toMatch(/FAILURES=0/);
  });

  it('the writer succeeds but the tsc gate fails — no record, the failure is counted', () => {
    const { r, records } = runStory({ writerExit: 0, tscOk: false });
    expect(records).toEqual([]);
    expect(r.stdout).toMatch(/FAILURES=1/);
  });
});
