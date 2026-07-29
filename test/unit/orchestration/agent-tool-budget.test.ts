/**
 * An agent with tools must be given a budget it can SEE.
 *
 * Live metrolinx 2026-07-29, three lanes, one prompt, one cap:
 *
 *   gotransit  — pre-phase assessment converged
 *   metrolinx  — converged
 *   upexpress  — "Agent reached maximum iterations (25) without completing"
 *
 * The assessment was handed read tools and EPAM_MAX_ITERATIONS=25, and nothing
 * ever told it to stop exploring. How many turns it spent was therefore a
 * property of whichever repository the lane drew, not of the task. The agents
 * that reliably converge are the ones given a visible budget — the CodeGraph
 * detective ("CONVERGE FAST — HARD LIMIT: 6 tool calls total", with
 * EPAM_MAX_TOOL_CALLS=7) and team-lead review (EPAM_MAX_TOOL_CALLS=8). The
 * assessment had neither.
 *
 * THE TWO HALVES MUST AGREE, which is what these tests exist to enforce. A
 * budget set only at the seam truncates the model mid-thought and the response
 * schema then returns a valid EMPTY object — the code's own comment calls this
 * "a loud failure turned silent". A budget stated only in the prompt is a
 * suggestion. And if the two numbers drift apart, the model plans against one
 * limit while the runtime enforces another, which is worse than either alone.
 * So the test resolves BOTH from the real script and compares them.
 *
 * It also checks the failure message, because the previous one asserted
 * something this run disproved: "the same prompt at the same cap fails
 * identically". It succeeded twice and failed once. That claim is why the
 * pipeline suppressed retry AND why nobody looked for the real cause for weeks.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

/** Resolve a shell default expression like ${FOO:-10} by executing it. */
function resolveShell(expr: string, env: Record<string, string> = {}): string {
  const r = spawnSync('bash', ['-c', `echo "${expr}"`], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15000,
  });
  return (r.stdout || '').trim();
}

/** The budget the seam enforces, as written in the script. */
function budgetExpr(): string {
  const m = SRC.match(/_pfa_tool_budget="([^"]+)"/);
  expect(m, 'the pre-phase assessment declares no tool budget — it will explore until the runtime cuts it off').toBeTruthy();
  return m![1];
}

describe('the pre-phase assessment has a tool budget', () => {
  it('sets EPAM_MAX_TOOL_CALLS at the invocation', () => {
    expect(SRC, 'the assessment runs with tools and no budget, like the run that exhausted')
      .toMatch(/EPAM_MAX_TOOL_CALLS="\$\{_pfa_tool_budget\}"/);
  });

  it('states the limit in the prompt, so the model can plan against it', () => {
    // A budget the model cannot see truncates it mid-thought; the schema then
    // returns a valid empty object and the failure looks like success.
    expect(SRC, 'the prompt never tells the agent to converge')
      .toMatch(/HARD LIMIT: \$\{_pfa_tool_budget\} tool calls/);
  });

  it('tells it to ANSWER at the limit, not merely to stop', () => {
    // "Stop at N" without "answer with what you have" produces an empty result,
    // which is the same outcome as exhausting.
    const idx = SRC.indexOf('HARD LIMIT: ${_pfa_tool_budget}');
    const block = SRC.slice(idx, idx + 600);
    expect(block, 'the agent is told to stop but not to return its best answer')
      .toMatch(/BEST current answer|answer now/i);
  });

  it('enforces the SAME number it advertises', () => {
    // Drift here is the worst case: the model plans against one limit while the
    // runtime enforces another. Both sides read one variable, so resolving it
    // once is enough — this asserts there is exactly one source.
    const occurrences = SRC.match(/\$\{_pfa_tool_budget\}/g) || [];
    expect(occurrences.length,
      'the budget should be referenced from a single variable in both the prompt and the env')
      .toBeGreaterThanOrEqual(2);
    expect(SRC.match(/_pfa_tool_budget="/g)!.length,
      'more than one assignment means the two halves can drift apart').toBe(1);
  });

  it('is configurable, with a sane default — not a constant', () => {
    // The next project's assessment may need a different budget; the engine must
    // not need editing for it.
    expect(budgetExpr()).toMatch(/PRE_ASSESSMENT_MAX_TOOL_CALLS/);
    const dflt = Number(resolveShell(budgetExpr(), {}));
    expect(dflt, 'default budget is not a usable number').toBeGreaterThan(0);
    expect(dflt, 'a budget this large is not a budget').toBeLessThanOrEqual(25);
    expect(resolveShell(budgetExpr(), { PRE_ASSESSMENT_MAX_TOOL_CALLS: '3' }),
      'the override is ignored').toBe('3');
  });
});

describe('the failure message claims only what is true', () => {
  it('no longer asserts the failure is deterministic', () => {
    // Disproved by the run that motivated this: same prompt, same cap, two
    // codelines converged and one did not.
    expect(SRC, 'the message still claims an identical failure every time')
      .not.toMatch(/the same prompt at the same cap fails identically/);
  });

  it('points at the budget as the lever, not the iteration cap', () => {
    // The recorded wrong lever. Raising the iteration cap buys more exploration
    // of an unbounded search; lowering the tool budget makes it commit.
    const idx = SRC.indexOf('explored past its budget without answering');
    expect(idx, 'the corrected diagnosis is missing').toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 700))
      .toMatch(/PRE_ASSESSMENT_MAX_TOOL_CALLS/);
  });
});

describe('every tool-enabled orchestration agent declares a budget', () => {
  it('the known convergent agents still have theirs', () => {
    // Guards the pattern rather than this one call site: if these regress, the
    // same unbounded-exploration failure returns elsewhere.
    const review = readFileSync(join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');
    expect(review, 'team-lead review lost its tool budget').toMatch(/EPAM_MAX_TOOL_CALLS=/);
    const spec = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(spec, 'the CodeGraph detective lost its tool budget').toMatch(/EPAM_MAX_TOOL_CALLS/);
  });
});
