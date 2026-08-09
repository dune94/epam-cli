/**
 * CAPS: CONFIGURED, AND SET WHERE THE WORK ACTUALLY NEEDS THEM.
 *
 * Two defects found auditing every limit in the pipeline on 2026-08-09.
 *
 * 1. A TOOL BUDGET BELOW THE TOOL'S OWN STATED USAGE. codegraph_query — the tool that exists so
 *    agents stop grepping — tells the agent in its own description: "Call this iteratively (5-10
 *    times is normal)". The gate agents that can call it were given
 *    EPAM_MAX_TOOL_CALLS=6: FAILURE_ANALYST, PLAN_REVIEW, PRD_CHANGE_REVIEWER.
 *
 *    An agent that follows the tool's advice exhausts its entire budget on one tool's normal
 *    usage, having read nothing else. The cheap alternative is one grep. That is not a tuning
 *    preference — the budget makes the expensive-but-correct path unaffordable and the
 *    cheap-but-blind path the only one that fits, which is precisely the behaviour the review
 *    was asked to explain.
 *
 *    The WRITER is unlimited (llm-settings.schema.json: "null = unlimited — this cap is not set
 *    anywhere today"), so this is specific to the gate agents rather than universal.
 *
 * 2. AN UNCONFIGURED CAP. codegraph-agent-query.sh caps `show` output at a literal `_cap=300`.
 *    Every other limit in the pipeline is `${VAR:-default}`; this one an operator cannot reach.
 *
 * Generous is the right default here for a specific reason: these budgets bound TOOL calls, not
 * model turns. A tool call is cheap next to a wasted attempt, and every one of these agents
 * exists to prevent a wrong answer that costs a full retry — 8 attempts × a 90K prompt. Being
 * stingy with reads to save tokens is how an agent guesses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const QUERY_SH = readFileSync(join(ROOT, 'orchestrations/scripts/codegraph-agent-query.sh'), 'utf8');
const CODEGRAPH = readFileSync(join(ROOT, 'orchestrations/plugins/codegraph-tools.js'), 'utf8');

/** The upper bound of the tool's own advertised iterative usage. */
function statedIterativeUsage(): number {
  const m = CODEGRAPH.match(/Call this iteratively \((\d+)-(\d+) times is normal\)/);
  expect(m, 'the tool no longer states its normal usage — this test is anchored to it').toBeTruthy();
  return Number((m as RegExpMatchArray)[2]);
}

const budget = (name: string): number => {
  const m = CLAUDE_SH.match(new RegExp(`\\$\\{${name}:-(\\d+)\\}`));
  expect(m, `${name} not found`).toBeTruthy();
  return Number((m as RegExpMatchArray)[1]);
};

describe('a tool budget accommodates the tools it grants', () => {
  const AGENTS = ['FAILURE_ANALYST_MAX_TOOL_CALLS', 'PLAN_REVIEW_MAX_TOOL_CALLS', 'PRD_CHANGE_REVIEWER_MAX_TOOL_CALLS'];

  it.each(AGENTS)('%s leaves room for the graph query to be used as documented', (name) => {
    const stated = statedIterativeUsage();
    expect(
      budget(name),
      `${name} is ${budget(name)} but codegraph_query alone calls for up to ${stated} — ` +
      'an agent following the tool\'s own instruction runs out having read nothing else, so ' +
      'the one-shot grep is the only affordable option',
    ).toBeGreaterThan(stated);
  });

  it('the budgets are still bounded — generous is not unlimited for a gate agent', () => {
    for (const name of AGENTS) expect(budget(name)).toBeLessThanOrEqual(50);
  });

  it('every budget remains operator-settable', () => {
    for (const name of AGENTS) expect(CLAUDE_SH).toContain(`\${${name}:-`);
  });
});

describe('every cap is reachable by an operator', () => {
  it('the show-output cap is configured, not a literal', () => {
    expect(QUERY_SH, 'a literal _cap=300 an operator cannot change').not.toMatch(/^\s*_cap=300\s*$/m);
    expect(QUERY_SH).toMatch(/_cap="?\$\{[A-Z_]+:-\d+\}/);
  });

  it('and it is generous enough to show a real file', () => {
    // The declared files on the live story run to 537 lines; a 300-line window silently cuts
    // the largest ones, which is how an agent concludes an export does not exist.
    const m = QUERY_SH.match(/_cap="?\$\{[A-Z_]+:-(\d+)\}/);
    expect(Number((m as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(600);
  });
});
