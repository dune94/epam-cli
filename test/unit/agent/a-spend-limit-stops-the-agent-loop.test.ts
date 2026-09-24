// A SPEND LIMIT STOPS THE AGENT LOOP — AND SAYS IT DID.
//
// `epam run` had no spend stop. Its limits arrive as environment variables (EPAM_MAX_ITERATIONS,
// EPAM_MAX_TOOL_CALLS); the claude CLI arm got --max-budget-usd, the epam arm nothing. Live
// 2026-09-24, an escalated fix on z-ai/glm-5.3 ran 28.6 minutes over 8.5M input tokens ($2.57), and
// the next hop read for 30 minutes more, with nothing able to bound either.
//
// BudgetGuard already existed — a hard USD limit whose `pause` ends the loop — and nothing built one
// for `epam run`. EPAM_MAX_BUDGET_USD now builds it, and the loop records the stop structurally
// (stopReason 'max_budget') as it does for max_iterations: a caller must be able to tell a
// budget-stopped attempt from a finished one without reading prose.
import { describe, it, expect } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';
import { budgetGuardFromEnv, buildRunResultJson } from '../../../src/cli/commands/run';
import { MODEL_PRICING, calculateCost } from '../../../src/billing/pricing';

function tool(name: string) {
  return {
    name,
    definition: { name, description: 'x', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute() { return { toolUseId: 't', content: 'ok', isError: false }; },
  } as any;
}
// A priced model from the engine's own pricing table — never a price written here.
const MODEL = Object.keys(MODEL_PRICING).find((m) => calculateCost(m, 1_000_000, 0) > 0)!;
// One turn's tokens, and what one turn costs at the table's price.
const TURN_IN = 200_000;
const TURN_COST = calculateCost(MODEL, TURN_IN, 0);

/** Calls a tool forever — the shape of an agent that never converges. Counts its turns. */
function endlessProvider() {
  const state = { turns: 0 };
  return {
    state,
    provider: {
      name: 'stub',
      async stream() {
        state.turns += 1;
        return { content: [{ type: 'tool_use', id: `t${state.turns}`, name: 'q', input: {} }],
          stopReason: 'tool_use', usage: { inputTokens: TURN_IN, outputTokens: 0 } };
      },
      async complete() { return { content: [{ type: 'text', text: 'summary' }] }; },
    } as any,
  };
}

describe('a spend limit stops the agent loop', () => {
  it('the priced model used here costs something — otherwise nothing below is tested', () => {
    expect(MODEL, 'no priced model in the pricing table').toBeTruthy();
    expect(TURN_COST).toBeGreaterThan(0);
  });

  it('EPAM_MAX_BUDGET_USD builds a hard-limit guard; unset or not a number builds none', () => {
    expect(budgetGuardFromEnv(MODEL, { EPAM_MAX_BUDGET_USD: '1.25' })?.limits.hardLimitAt).toBe(1.25);
    expect(budgetGuardFromEnv(MODEL, {})).toBeUndefined();
    expect(budgetGuardFromEnv(MODEL, { EPAM_MAX_BUDGET_USD: 'lots' })).toBeUndefined();
    expect(budgetGuardFromEnv(MODEL, { EPAM_MAX_BUDGET_USD: '0' })).toBeUndefined();
  });

  it('the loop stops once spend crosses the limit, and says max_budget', async () => {
    const limit = TURN_COST * 3.5;                    // crossed on the 4th turn
    const { provider, state } = endlessProvider();
    const result: any = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: MODEL, dangerousSkipApproval: true,
      maxIterations: 50, autoCompressAt: 10_000_000_000,
      budgetGuard: budgetGuardFromEnv(MODEL, { EPAM_MAX_BUDGET_USD: String(limit) }),
    } as any).run();
    expect(state.turns, 'the loop ran past its spend limit').toBe(4);
    expect(result.stopReason).toBe('max_budget');
    expect(buildRunResultJson(result, { model: MODEL, provider: 'stub' }).stop_reason).toBe('max_budget');
  });

  it('without a limit the same loop runs to its iteration cap — the guard is the only difference', async () => {
    const { provider, state } = endlessProvider();
    const result: any = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: MODEL, dangerousSkipApproval: true,
      maxIterations: 8, autoCompressAt: 10_000_000_000,
    } as any).run();
    expect(state.turns).toBe(8);
    expect(result.stopReason).toBe('max_iterations');
  });
});
