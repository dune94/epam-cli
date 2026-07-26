/**
 * A QA gate that fails must LEARN, not just try again on a bigger model.
 *
 * Every gate already has retry and ladder escalation via
 * _run_qa_gate_with_retry. None of them had self-healing — the count of
 * kb_apply/kb_record inside that wrapper was zero, against five in
 * brownfield-repro-test-writer.sh.
 *
 * The consequence, live on 2026-07-26: perf-sentinel failed IDENTICALLY twice.
 * Its entire log, both attempts, was "The file has been written successfully."
 * — it answered by calling a write tool. Nothing diagnosed that between
 * attempts, so attempt 2 on a stronger model repeated it exactly. fuzz-weaver
 * produced a 0-byte log in the same run. Two of six quality gates reviewed
 * nothing, and the phase passed.
 *
 * The repro-test-writer hit the very same failure class that day and RECOVERED
 * on attempt 2, because its failure was recorded as an episode, diagnosed, and
 * compiled into an enforced constraint. That machinery already exists and is
 * proven; the gates simply never called it.
 *
 * Brownfield only — the greenfield flow is deliberately left as it is.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/** The retry wrapper every QA gate goes through. */
function retryWrapper(): string {
  const start = ORCH.indexOf('_run_qa_gate_with_retry() {');
  expect(start, '_run_qa_gate_with_retry not found').toBeGreaterThan(-1);
  const end = ORCH.indexOf('\n}', start);
  return ORCH.slice(start, end);
}

describe('a failing gate records what happened and applies what was learned', () => {
  it('records the failure as an episode the knowledge base can key on', () => {
    // Without an episode there is nothing for synthesis to build a rule from,
    // so the same failure recurs run after run.
    expect(retryWrapper(), 'gate failures are never recorded — the KB cannot learn from them')
      .toMatch(/kb_record_episode/);
  });

  it('applies existing constraints before retrying', () => {
    // The point is that attempt 2 differs from attempt 1 by more than the model.
    expect(retryWrapper(), 'the retry is identical to the first attempt apart from the model')
      .toMatch(/kb_apply_constraints/);
  });

  it('keys the episode on the gate that failed', () => {
    // A constraint compiled for "some gate" is unusable; it must name the agent
    // so it can be enforced on that agent alone.
    const w = retryWrapper();
    const i = w.indexOf('kb_record_episode');
    expect(w.slice(Math.max(0, i - 400), i + 300)).toMatch(/_qg_agent|_qg_slug/);
  });

  it('carries the failure class, so an unkeyable failure is still learnable', () => {
    // "produced no output" has no error string to key on. Without an explicit
    // class it cannot be looked up, which is why the write-tool failure was
    // never learned from.
    expect(retryWrapper()).toMatch(/FAILURE_CLASS|failure-class|no_structured_output/);
  });

  it('never lets self-healing break the gate', () => {
    // A learning mechanism that can fail a quality gate is worse than none.
    const w = retryWrapper();
    const kb = w.slice(w.indexOf('kb_'));
    expect((kb.match(/\|\|\s*true/g) || []).length,
      'the KB calls are not individually guarded').toBeGreaterThanOrEqual(2);
  });

  it('leaves the greenfield flow alone', () => {
    // Explicitly scoped: greenfield behaviour is not being changed here.
    expect(retryWrapper()).toMatch(/EPAM_BROWNFIELD/);
  });
});
