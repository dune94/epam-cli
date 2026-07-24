/**
 * The code-graph-detective must reason at HIGH effort — it is the causal-tracing agent
 * that picks the fix site + helper (fixSiteAnalysis). Found live 2026-07-24 (AMSD-1820):
 * the ticket had no story points → pointsToEffort(0) → effort "low", and the detective
 * set NO effort of its own so it inherited LOW. At LOW effort (even with temperature 0)
 * it reasoned too little and gave DIFFERENT helpers across passes — a plausible-but-wrong
 * `getPreciseFloatNumber` on one pass, the correct `parseDispatchLineItemKey` on another.
 * Brownfield correctness needs careful reasoning, not story-point-derived LOW effort.
 *
 * The detective now sets EPAM_REASONING_EFFORT=high explicitly (env-overridable). This is
 * distinct from VC generation, which stays LOW on purpose (a restate task — high effort
 * there drives prescriptive drift).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('code-graph-detective reasons at HIGH effort', () => {
  it('the detective explore call sets EPAM_REASONING_EFFORT to high (env-overridable)', () => {
    // in the same env block as its EPAM_MAX_ITERATIONS='10' (the explore phase)
    expect(src).toMatch(/EPAM_REASONING_EFFORT:\s*process\.env\.CODEGRAPH_DETECTIVE_REASONING_EFFORT\s*\|\|\s*'high'/);
  });

  it('VC generation stays LOW on purpose (not raised by this change)', () => {
    // guard: the VC restate call must remain low — do not let a blanket bump touch it
    expect(src).toMatch(/EPAM_REASONING_EFFORT:\s*process\.env\.VC_LLM_REASONING_EFFORT\s*\|\|\s*'low'/);
  });
});
