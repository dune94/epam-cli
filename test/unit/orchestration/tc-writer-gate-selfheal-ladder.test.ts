/**
 * B23 — the TC writer retries the SAME model 3x with no corrective guidance.
 *
 * `run_inline_tc_writer_gate` already loops `for _tc_gate_attempt in 1 2 3`, but
 * every attempt uses the identical model and an identical prompt: no escalation, no
 * self-heal. That is precisely the pattern that wasted attempts on the detective
 * (max_iterations x3) and the repro-test-writer (max_iterations, then no_file) until
 * each was given a ladder plus agent-attempt-analyst.sh.
 *
 * MEDIUM ladder, deliberately — not HIGH. The TC writer turns ACs/VCs into
 * test-criteria FACTS: structured restatement, not causal reasoning. It is closer to
 * the VC producer (pinned to temp 0 / low effort precisely because high reasoning
 * caused prescriptive drift) than to the detective (which must trace symptom ->
 * cause). The HIGH ladder tops out at kimi-k3, the most expensive rung; paying that
 * for restatement buys nothing and may buy WORSE output, since more reasoning is
 * what makes these agents editorialise instead of restate.
 *
 * Ladder semantics are the pipeline's existing convention: 2 tries per model with
 * the reasoning effort varying inside the rung, model changing at rung boundaries.
 * See [[project_inference_ladder_design]].
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATE_RAW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/lib/tc-writer-gate.sh'), 'utf8');
// Scan CODE, not comments — a comment documenting the old behaviour must not
// satisfy or trip these assertions (the trap hit twice already today).
const GATE = GATE_RAW.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('B23 — TC writer gets self-heal', () => {
  it('invokes the agent-attempt-analyst on a failed attempt', () => {
    expect(GATE).toMatch(/agent-attempt-analyst\.sh/);
  });

  it('feeds the corrective directive into the NEXT attempt', () => {
    // A directive that is computed and then ignored is the failure mode that made
    // "self-heal active" meaningless in the impl retries.
    expect(GATE).toMatch(/_tc_corrective|corrective/i);
  });

  it('classifies the failure before asking for a directive', () => {
    // max_iterations vs no_file vs no_json need different corrections.
    expect(GATE).toMatch(/max_iterations|no_file|no_json|_tc_fclass/);
  });
});

describe('B23 — TC writer escalates on the MEDIUM ladder', () => {
  it('uses the MEDIUM ladder, not HIGH', () => {
    expect(GATE).toMatch(/EPAM_MODEL_LADDER_MEDIUM/);
    expect(GATE, 'restatement work must not reach the kimi-k3 rung').not.toMatch(/EPAM_MODEL_LADDER_HIGH/);
  });

  it('actually changes model between rungs rather than repeating one', () => {
    expect(GATE).toMatch(/_tc_ladder_next_model|_tc_next_model/);
  });

  it('keeps the existing 3-attempt bound (no unbounded retrying)', () => {
    expect(GATE).toMatch(/for _tc_gate_attempt in 1 2 3|_tc_gate_attempt/);
  });

  it('still BLOCKS the story when all attempts fail', () => {
    // Escalation must not turn a hard gate into a soft one.
    expect(GATE).toMatch(/return 1/);
  });
});
