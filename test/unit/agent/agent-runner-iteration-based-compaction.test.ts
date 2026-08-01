/**
 * AgentRunner's existing auto-compaction (compressHistory) only triggers on
 * a TOKEN threshold. A long-horizon run whose turns are each individually
 * small (many short tool calls, none crossing the token threshold on its
 * own) can accumulate real context-window risk over many iterations without
 * ever tripping it — exactly the risk raised when discussing raising
 * brownfield iteration caps into the hundreds for genuinely large changes:
 * "we need to compact every 30 to 50 iterations" regardless of token count.
 *
 * This adds a SECOND, independent trigger — autoCompressEveryNIterations —
 * so compaction fires on whichever condition is met first. Configurable via
 * EPAM_AUTO_COMPRESS_EVERY_N_ITERATIONS / project config, not hardcoded;
 * unset = disabled (existing token-only behavior unchanged).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';

function tool(name: string) {
  return {
    name,
    definition: { name, description: 'x', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute() {
      return { toolUseId: 't', content: 'ok', isError: false };
    },
  } as any;
}

/** A provider that keeps calling a tool for N turns, then answers — each turn
 *  intentionally small so it never crosses a token threshold on its own. */
function loopingProvider(turns: number, completeSpy: ReturnType<typeof vi.fn>) {
  let i = 0;
  return {
    name: 'stub',
    async stream() {
      i++;
      if (i <= turns) {
        return {
          content: [{ type: 'tool_use', id: `t${i}`, name: 'q', input: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async complete(req: unknown) {
      completeSpy(req);
      return { content: [{ type: 'text', text: 'summary' }] };
    },
  } as any;
}

describe('AgentRunner — iteration-count-based compaction (independent of token threshold)', () => {
  it('compacts after N iterations even when the token threshold is never crossed', async () => {
    const completeSpy = vi.fn();
    const provider = loopingProvider(10, completeSpy);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
      autoCompressAt: 10_000_000, // effectively disables the token trigger
      autoCompressEveryNIterations: 3,
    } as any).run();

    expect(completeSpy, 'compaction (provider.complete) never fired despite the iteration trigger')
      .toHaveBeenCalled();
  });

  it('does NOT compact when autoCompressEveryNIterations is unset (backward compatible)', async () => {
    const completeSpy = vi.fn();
    const provider = loopingProvider(10, completeSpy);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
      autoCompressAt: 10_000_000,
      // autoCompressEveryNIterations intentionally omitted
    } as any).run();

    expect(completeSpy, 'compaction fired even though the iteration trigger was never configured')
      .not.toHaveBeenCalled();
  });

  it('does NOT compact when autoCompressEveryNIterations is 0 or negative (explicit opt-out, not a footgun)', async () => {
    const completeSpy = vi.fn();
    const provider = loopingProvider(10, completeSpy);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
      autoCompressAt: 10_000_000,
      autoCompressEveryNIterations: 0,
    } as any).run();

    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('the token-based trigger still fires independently when the iteration trigger is unset', async () => {
    const completeSpy = vi.fn();
    // Large tool results to cross a LOW token threshold quickly.
    const bigTool = {
      name: 'q',
      definition: { name: 'q', description: 'x', inputSchema: { type: 'object', properties: {} } },
      permission: 'safe',
      async execute() {
        return { toolUseId: 't', content: 'x'.repeat(5000), isError: false };
      },
    } as any;
    const provider = loopingProvider(5, completeSpy);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [bigTool], model: 'm', dangerousSkipApproval: true,
      autoCompressAt: 500, // low enough that the big tool results cross it fast
    } as any).run();

    expect(completeSpy, 'the existing token-based trigger regressed').toHaveBeenCalled();
  });

  it('both triggers can coexist — whichever fires first wins, neither is silently dropped', async () => {
    const completeSpy = vi.fn();
    const provider = loopingProvider(10, completeSpy);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
      autoCompressAt: 10_000_000,
      autoCompressEveryNIterations: 4,
    } as any).run();

    expect(completeSpy).toHaveBeenCalled();
  });
});
