/**
 * A reasoning model that spends its whole budget thinking must FAIL, not return "".
 *
 * Verified against OpenRouter (2026-07-25): glm-5.1, glm-5.2, kimi-k3 and
 * minimax-m3 all deduct reasoning tokens from max_tokens. Probed at max_tokens:200,
 * every one burned the ENTIRE budget on reasoning and returned
 *     HTTP 200, finish_reason="length", content: ""
 * That is indistinguishable from a successful empty answer unless something checks.
 *
 * Nothing did. AgentRunner's `max_tokens` handler sits at line ~197, but the branch
 * above it fires on `stopReason === 'end_turn' || toolUses.length === 0` — and a
 * fully-truncated response has ZERO tool uses, so it took the end-turn path, broke
 * out of the loop, and returned the empty/partial text AS THE ANSWER. The
 * max_tokens handler was unreachable for exactly the case that matters.
 *
 * Downstream that becomes the 169-byte team-lead review: "Now let me verify the
 * test actually covers..." accepted as a verdict, and the run blocked on
 * "review output unparseable".
 *
 * FailoverPolicy.ts:66 already routes on this — "Context window exhausted signal
 * (thrown by AgentRunner when stopReason === 'max_tokens')" — so the failover path
 * was built for a throw that never happened. This makes the throw real.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner';
import type { LLMProvider } from '../../../src/providers/types';

function providerReturning(resp: any): LLMProvider {
  // AgentRunner drives provider.stream(), not complete().
  return {
    name: 'qwen',
    stream: vi.fn().mockResolvedValue(resp),
    complete: vi.fn().mockResolvedValue(resp),
  } as unknown as LLMProvider;
}

const run = (provider: LLMProvider) =>
  new AgentRunner({ provider, model: 'z-ai/glm-5.2', userMessage: 'do the thing', tools: [] } as any).run();

describe('truncated reasoning is a hard failure', () => {
  it('throws when the budget was spent entirely on reasoning (empty content)', async () => {
    // The exact live shape: HTTP 200, stopReason max_tokens, nothing produced.
    await expect(run(providerReturning({
      content: [], stopReason: 'max_tokens',
      usage: { inputTokens: 1000, outputTokens: 32768 },
    }))).rejects.toThrow(/max_tokens/);
  });

  it('throws rather than returning a truncated fragment as the answer', async () => {
    // The 169-byte reviewer: text exists, but it is mid-sentence, not a verdict.
    await expect(run(providerReturning({
      content: [{ type: 'text', text: 'Now let me verify the test actually covers the prescribed fix scenario' }],
      stopReason: 'max_tokens',
      usage: { inputTokens: 1000, outputTokens: 32768 },
    }))).rejects.toThrow(/max_tokens/);
  });

  it('the error is one FailoverPolicy routes on', async () => {
    const { FailoverPolicy } = await import('../../../src/providers/health/FailoverPolicy');
    let err: any;
    try {
      await run(providerReturning({ content: [], stopReason: 'max_tokens',
        usage: { inputTokens: 1, outputTokens: 32768 } }));
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    // FailoverPolicy:66 matches on the message containing 'max_tokens'.
    expect(err.message).toContain('max_tokens');
  });

  it('does NOT throw for a normal completion', async () => {
    await expect(run(providerReturning({
      content: [{ type: 'text', text: 'APPROVED — the fix reuses parseDispatchLineItemKey.' }],
      stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 },
    }))).resolves.toBeDefined();
  });

  it('does NOT throw when the model genuinely produced an empty end_turn', async () => {
    // Empty is only a failure when the model was CUT OFF, not when it chose to stop.
    await expect(run(providerReturning({
      content: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 0 },
    }))).resolves.toBeDefined();
  });
});
