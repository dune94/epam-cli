/**
 * A file-writing agent should SAY it wrote files, not return empty.
 *
 * An agent whose work goes to disk often ends its turn with no text, so
 * finalResponse is "". Downstream that empty string is indistinguishable from an
 * agent that produced nothing at all, which forced ai-run.sh to infer the
 * difference from whether a result RECORD existed. Inference works, but the
 * ambiguity should not exist in the first place.
 *
 * THE CONSTRAINT THAT MATTERS: this must only fire when files were ACTUALLY
 * written. Synthesising "file written" for an agent that returned empty because it
 * FAILED would convert a detectable failure into a plausible success — the exact
 * defect being removed everywhere else in this pipeline. So an empty response with
 * no successful writes stays empty, and remains detectable as a failure.
 *
 * The summary is generated from tool results, not asked of the model: a prompt
 * instruction can be ignored, a deterministic summary cannot.
 */
import { describe, it, expect } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';

/** Provider that emits one write_file tool call, then finishes with no text. */
function writingProvider(toolName = 'write_file', path = 'src/discount.test.ts') {
  let turn = 0;
  return {
    name: 'stub',
    async stream() {
      turn++;
      if (turn === 1) {
        return {
          content: [{ type: 'tool_use', id: 't1', name: toolName, input: { path, content: 'x' } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as any;
}

/** Provider that just ends, with no text and no tool calls at all. */
const silentProvider = {
  name: 'stub',
  async stream() {
    return { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  },
} as any;

function writeTool(name = 'write_file', { fail = false } = {}) {
  return {
    name,
    definition: { name, description: 'writes', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute(input: Record<string, unknown>) {
      return {
        toolUseId: 't1',
        content: fail ? 'EACCES: permission denied' : `wrote ${String(input.path)}`,
        isError: fail,
      };
    },
  } as any;
}

describe('AgentRunner — file-writing agents report what they wrote', () => {
  it('summarises the written file when the agent ends with no text', async () => {
    const r = await new AgentRunner({
      userMessage: 'write the test', provider: writingProvider(), tools: [writeTool()],
      model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.finalResponse,
      'a file-writing agent still returns empty — downstream cannot tell it apart ' +
      'from an agent that produced nothing').not.toBe('');
    expect(r.finalResponse).toMatch(/discount\.test\.ts/);
  });

  it('does NOT invent a summary when nothing was written', async () => {
    // THE REMEDY CHANGED; THE REQUIREMENT DID NOT.
    //
    // This asserted `''` on the reasoning that an empty answer is a DETECTABLE failure, and that
    // inventing a summary would turn it into a plausible one. The first half is still right — no
    // summary is fabricated. The second half was disproved live on 2026-08-20: the reviewer
    // returned 292 output tokens as an empty string, `''` reached team-lead-review-json.py, became
    // a changes_requested verdict, and the writer was sent to cycle 4 to fix feedback nobody wrote.
    //
    // `''` is indistinguishable from a real answer to every caller. A run that made no tool calls,
    // produced no text, and still spent tokens now THROWS — which is what "detectable" was
    // supposed to mean.
    await expect(new AgentRunner({
      userMessage: 'do nothing', provider: silentProvider, tools: [],
      model: 'm', dangerousSkipApproval: true,
    } as any).run()).rejects.toThrow(/no text|nothing was captured/i);
  });

  it('does NOT summarise a FAILED write', async () => {
    const r = await new AgentRunner({
      userMessage: 'write the test', provider: writingProvider(),
      tools: [writeTool('write_file', { fail: true })],
      model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.finalResponse,
      'a failed write was reported as a successful one').not.toMatch(/wrote|written/i);
  });

  it('leaves a real text response untouched', async () => {
    const provider = {
      name: 'stub',
      async stream() {
        return {
          content: [{ type: 'text', text: 'the verdict is approved' }],
          stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as any;
    const r = await new AgentRunner({
      userMessage: 'review', provider, tools: [], model: 'm',
    } as any).run();
    expect(r.finalResponse).toBe('the verdict is approved');
  });
});
