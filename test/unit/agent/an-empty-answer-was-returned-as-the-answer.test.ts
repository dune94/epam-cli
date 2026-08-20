// THE MODEL PRODUCED 292 OUTPUT TOKENS AND THE LOOP RETURNED AN EMPTY STRING AS ITS ANSWER.
//
// Live metrolinx run 4, 2026-08-20. The reviewer's final turn, from Langfuse:
//
//   {"text": "", "toolCalls": [], "stopReason": "end_turn",
//    "textLength": 0, "inputTokens": 13631, "outputTokens": 292}
//
// Tokens were generated. Nothing was captured — a reasoning model spent them in a channel the
// adapter discards. The loop returned "" and everything downstream treated it as the reviewer's
// answer: the parser converted it into a changes_requested verdict, and the writer was sent to
// cycle 4 to fix feedback nobody wrote.
//
// AgentRunner already has the guard for "the model talked but did nothing" — isThinkingOnly nudges
// it to act. It requires `responseText.trim().length > 0`, so it is skipped EXACTLY when the output
// is empty: the worst case is the one case it will not handle.
//
// An answer of nothing is not an answer. The loop must either get one or say it could not.
import { describe, it, expect, vi } from 'vitest';

/** A provider that returns whatever turns the test scripts, then repeats the last one. */
function scriptedProvider(turns: Array<{ text: string; usage?: Record<string, number> }>) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    calls,
    async stream(req: unknown) {
      calls.push(req);
      const t = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return {
        content: t.text ? [{ type: 'text', text: t.text }] : [],
        stopReason: 'end_turn',
        // The live shape: tokens were BILLED and no text was captured.
        usage: t.usage ?? { inputTokens: 13631, outputTokens: t.text ? 50 : 292, cachedInputTokens: null },
      };
    },
  };
}

async function runWith(turns: Array<{ text: string }>) {
  const { AgentRunner } = await import('../../../src/agent/AgentRunner');
  const provider = scriptedProvider(turns);
  const runner = new (AgentRunner as unknown as new (o: unknown) => {
    run: () => Promise<unknown>;
  })({
    provider,
    tools: [],
    systemPrompt: 'you review code',
    userMessage: 'review this change',
    maxIterations: 5,
  });
  let error: unknown = null;
  let result: unknown = null;
  try { result = await runner.run(); } catch (e) { error = e; }
  return { result, error, provider };
}

describe('an empty final response is not an answer', () => {
  it('the loop does not simply hand back the empty string', async () => {
    const { result, error } = await runWith([{ text: '' }]);
    const text = typeof result === 'string' ? result
      : (result as { finalResponse?: string } | null)?.finalResponse ?? '';
    const surfaced = error !== null || /empty|no output|produced nothing/i.test(String(text));
    expect(surfaced,
      'the reviewer returned nothing and the loop passed it on as the review').toBe(true);
  });

  it('and it ASKS AGAIN before giving up — 292 tokens were spent, the model had something to say', async () => {
    const { provider } = await runWith([{ text: '' }]);
    expect(provider.calls.length,
      'the model was never asked again; the thinking-only nudge is skipped when the text is empty')
      .toBeGreaterThan(1);
  });

  it('a model that answers on the retry is taken at its word', async () => {
    const { result, error } = await runWith([{ text: '' }, { text: 'VERDICT: approved' }]);
    expect(error).toBeNull();
    const text = typeof result === 'string' ? result
      : (result as { finalResponse?: string } | null)?.finalResponse ?? '';
    expect(text).toContain('approved');
  });

  it('a normal answer is untouched — one call, no nudging', async () => {
    const { result, error, provider } = await runWith([{ text: 'VERDICT: changes_requested' }]);
    expect(error).toBeNull();
    expect(provider.calls.length).toBe(1);
    const text = typeof result === 'string' ? result
      : (result as { finalResponse?: string } | null)?.finalResponse ?? '';
    expect(text).toContain('changes_requested');
  });
});
