/**
 * A tool budget stated in the prompt is not a budget — it must be enforced.
 *
 * The code-graph-detective's prompt says, verbatim:
 *
 *     CONVERGE FAST — HARD LIMIT: 6 tool calls total. This is not a suggestion.
 *     By your 6th tool call you MUST stop querying and emit the JSON answer
 *     with your BEST current hypothesis.
 *
 * Nothing enforced it. The runner allowed 25 iterations, so the model kept
 * calling tools past 6 and hit the iteration cap with no answer at all —
 * "Agent reached maximum iterations (25) without completing" — throwing away
 * every bit of the investigation it had done.
 *
 * That failure has been "fixed" three times by raising the cap, and the history
 * is recorded in spec-mode-runner.js: 10 exhausted on 7 runs, 20 on 9, 25 on 3,
 * and 40 was the WORST of all — 40 tool calls, 680K input tokens, ~$0.17, no
 * fix. The budget was never the constraint; the absence of a mechanism was.
 * Raising a limit the model ignores just buys more thrashing.
 *
 * So: count tool calls, and when the budget is spent, stop offering tools and
 * require the answer. The model cannot keep exploring if there is nothing to
 * explore with — the same reason EPAM_ALLOWED_TOOLS='bash' fixed the
 * answer-by-WriteFile failure structurally where prompt wording had not.
 *
 * Opt-in and generic: unset means unlimited, exactly as today.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner';
import type { LLMProvider } from '../../../src/providers/types';

const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'bash', input: { command: 'echo hi' } });
const usage = { inputTokens: 10, outputTokens: 10 };

/** A provider that calls a tool on every turn until told there are none. */
function relentlessProvider() {
  const seen: Array<{ toolCount: number; lastUserText: string }> = [];
  const provider = {
    name: 'qwen',
    complete: vi.fn(),
    stream: vi.fn(async (req: any) => {
      const lastUser = [...(req.messages ?? [])].reverse().find((m: any) => m.role === 'user');
      const lastUserText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? '');
      seen.push({ toolCount: (req.tools ?? []).length, lastUserText });

      // With no tools available it can only answer; otherwise it keeps digging.
      if (!req.tools || req.tools.length === 0) {
        return { content: [{ type: 'text', text: '[{"file":"src/a.ts"}]' }], stopReason: 'end_turn', usage };
      }
      return { content: [toolUse(`t${seen.length}`)], stopReason: 'tool_use', usage };
    }),
  } as unknown as LLMProvider;
  return { provider, seen };
}

const bashTool = {
  name: 'bash',
  description: 'run',
  permission: 'safe',
  definition: { name: 'bash', description: 'run', input_schema: { type: 'object', properties: {} } },
  execute: vi.fn(async () => ({ content: 'ok', isError: false })),
} as any;

function makeRunner(provider: LLMProvider, opts: Record<string, unknown> = {}) {
  return new AgentRunner({
    provider,
    model: 'z-ai/glm-5.1',
    userMessage: 'find the fix site',
    tools: [bashTool],
    maxIterations: 25,
    // Non-interactive: without this the runner blocks on the approval prompt.
    dangerousSkipApproval: true,
    ...opts,
  } as any);
}

describe('the tool-call budget is enforced, not requested', () => {
  it('stops offering tools once the budget is spent', async () => {
    const { provider, seen } = relentlessProvider();
    await makeRunner(provider, { maxToolCalls: 6 }).run();

    const withTools = seen.filter(s => s.toolCount > 0).length;
    expect(withTools,
      'the model was still handed tools after its budget was spent — it can keep ' +
      'exploring forever, which is exactly how it reaches the iteration cap with no answer')
      .toBe(6);
  });

  it('tells the model why the tools are gone and what to do now', async () => {
    const { provider, seen } = relentlessProvider();
    await makeRunner(provider, { maxToolCalls: 3 }).run();

    const finalTurn = seen[seen.length - 1];
    expect(finalTurn.toolCount).toBe(0);
    expect(finalTurn.lastUserText,
      'tools vanished with no explanation — the model has no idea it is being asked to conclude')
      .toMatch(/budget|final answer|no further tool/i);
  });

  it('returns the answer instead of exhausting the iteration cap', async () => {
    const { provider } = relentlessProvider();
    const result = await makeRunner(provider, { maxToolCalls: 4 }).run();

    expect(result.finalResponse,
      'the run produced no answer — this is "reached maximum iterations without completing", ' +
      'the failure that has cost a ladder escalation on nearly every run')
      .toContain('src/a.ts');
  });

  it('costs far fewer turns than the iteration cap', async () => {
    const { provider, seen } = relentlessProvider();
    await makeRunner(provider, { maxToolCalls: 6 }).run();
    expect(seen.length, 'the budget did not actually shorten the run').toBeLessThan(25);
  });

  it('is unlimited when unset — existing agents are unaffected', async () => {
    const { provider, seen } = relentlessProvider();
    await makeRunner(provider).run();
    // No budget: it explores until the iteration cap, exactly as before.
    expect(seen.every(s => s.toolCount > 0)).toBe(true);
    expect(seen.length).toBe(25);
  });

  it('OMITS the tools parameter when the budget is spent — never sends an empty array', async () => {
    // Live metrolinx run 4, 2026-07-26. The detective made seven quick,
    // productive tool calls in ~65s, then this forced-answer turn HUNG and never
    // returned, burning the rest of its 360s budget until the timeout fired.
    // Langfuse recorded it exactly: `tools given: []`, `endTime: None`.
    //
    // An empty tools array is not the same request as no tools at all — some
    // providers keep tool-calling machinery active for `tools: []` and the model
    // can stall rather than answer. Omitting the field is the request we
    // actually mean: "answer in prose, there is nothing to call".
    const { provider, seen } = relentlessProvider();
    await makeRunner(provider, { maxToolCalls: 2 }).run();

    const finalReq = (provider.stream as any).mock.calls.at(-1)[0];
    expect('tools' in finalReq && (finalReq.tools ?? []).length === 0 && finalReq.tools !== undefined,
      'the final turn sent tools: [] — the exact request shape that hung glm-5.1 for 5 minutes')
      .toBe(false);
    expect(seen.at(-1)!.toolCount).toBe(0);
  });

  it('is reachable from the pipeline, not just from code', async () => {
    // The orchestration layer configures agents purely through EPAM_* env vars
    // (spec-mode-runner → ai-run.sh → epam run), so an option with no env path
    // is an option the detective can never actually be given.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '../../../');
    expect(readFileSync(join(root, 'src/config/EnvVarOverrides.ts'), 'utf8'),
      'EPAM_MAX_TOOL_CALLS is not read from the environment').toMatch(/EPAM_MAX_TOOL_CALLS/);
    expect(readFileSync(join(root, 'src/cli/commands/run.ts'), 'utf8'),
      '`epam run` — the command the pipeline invokes — never passes it to the runner')
      .toMatch(/maxToolCalls/);
    expect(readFileSync(join(root, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8'),
      'the detective, whose prompt claims the 6-call limit, does not set a tool budget')
      .toMatch(/EPAM_MAX_TOOL_CALLS/);
  });

  it('never fires when the model answers on its own', async () => {
    const provider = {
      name: 'qwen',
      complete: vi.fn(),
      stream: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage,
      }),
    } as unknown as LLMProvider;

    const result = await makeRunner(provider, { maxToolCalls: 6 }).run();
    expect(result.finalResponse).toBe('done');
    expect((provider.stream as any).mock.calls.length).toBe(1);
  });
});

describe('a hung forced-answer turn cannot consume the whole run', () => {
  it('gives up on the final turn after its own deadline instead of hanging', async () => {
    // The other half of the run-4 failure. Omitting `tools` addresses the likely
    // cause; this addresses the consequence. The forced-answer turn inherited the
    // detective's entire 360s allowance, so ONE request that never returned burned
    // every remaining second and the attempt died with nothing — not even the
    // evidence it had already gathered.
    const provider = {
      name: 'qwen',
      complete: vi.fn(),
      stream: vi.fn(async (req: any) => {
        if (!req.tools) return new Promise(() => {});   // the hang, exactly as observed
        return { content: [toolUse('t1')], stopReason: 'tool_use', usage };
      }),
    } as unknown as LLMProvider;

    const started = Date.now();
    await expect(
      makeRunner(provider, { maxToolCalls: 1, finalTurnTimeoutMs: 300 }).run(),
    ).rejects.toThrow(/final answer|timed out/i);
    expect(Date.now() - started,
      'the runner waited far past its own deadline — a hung provider still stalls the run')
      .toBeLessThan(4000);
  });
});
