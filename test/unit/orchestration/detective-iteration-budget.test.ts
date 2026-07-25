/**
 * B21 — the detective's iteration cap of 10 forced a ladder escalation every run.
 *
 * Observed on three consecutive runs (2026-07-24), always identically:
 *
 *   code-graph-detective produced NO parseable JSON (attempt 1/3)
 *     "Agent reached maximum iterations (10) without completing."
 *   ladder escalation — z-ai/glm-5.1 → moonshotai/kimi-k3
 *
 * Across today's logs "reached maximum iterations (10)" appears 16 times, every one
 * of them the detective. A SUCCESSFUL detective pass used 7 round-trips — so 10 sits
 * right on the boundary: the cheaper model needs more exploration than the cap
 * allows, the expensive one fits. The pipeline therefore pays a top-of-ladder
 * escalation on every single run to work around a budget that is barely too small.
 *
 * This is a cost defect, not a correctness one — the ladder recovers it every time —
 * but it is the most reliably reproducible waste in the pipeline.
 *
 * 20 gives roughly 2x the observed successful need. It is NOT unbounded: a runaway
 * agent must still terminate, and the ladder + self-heal remain the backstop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('B21 — detective iteration budget', () => {
  it('defaults above 10 — the value that exhausted on 3 consecutive runs', () => {
    const m = SPEC.match(/EPAM_MAX_ITERATIONS:\s*process\.env\.CODEGRAPH_DETECTIVE_MAX_ITERATIONS\s*\|\|\s*'(\d+)'/);
    expect(m, 'detective iteration default not found').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  it('stays BOUNDED — a runaway agent must still terminate', () => {
    const m = SPEC.match(/EPAM_MAX_ITERATIONS:\s*process\.env\.CODEGRAPH_DETECTIVE_MAX_ITERATIONS\s*\|\|\s*'(\d+)'/);
    expect(Number(m![1])).toBeLessThanOrEqual(40);
  });

  it('remains overridable per project via the env var', () => {
    expect(SPEC).toMatch(/process\.env\.CODEGRAPH_DETECTIVE_MAX_ITERATIONS/);
  });

  it('the ladder + self-heal stay in place as the backstop', () => {
    // A bigger budget must not replace escalation — it only stops us paying for it
    // on every run.
    expect(SPEC).toMatch(/ladder escalation/);
    expect(SPEC).toMatch(/CODEGRAPH_DETECTIVE_MAX_ATTEMPTS/);
  });
});
