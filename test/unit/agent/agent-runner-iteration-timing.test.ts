/**
 * Model latency and tool execution must be measurable separately.
 *
 * Measured 2026-07-30: the code-graph-detective took 9.4-11.6 minutes on
 * metrolinx and 23 seconds on mock3, same day, same agent. The detective's own
 * transcript log holds only the prompt and the final JSON — no timing at all —
 * so which of two very different problems this was could not be told from
 * outside the process:
 *
 *   - a slow reasoning call on a large/complex prompt (fix: context size, model)
 *   - slow CodeGraph tool execution against a bigger index (fix: the index)
 *
 * EPAM_MAX_TOOL_CALLS was raised three times against exactly this blind spot
 * (10 -> 20 -> 25 -> 40, one attempt burning 680K tokens) before anyone could
 * see which one it actually was — recorded at the detective's own call site.
 *
 * This tests the instrumentation itself: that AgentRunner emits one timing
 * record per iteration, that model and tool time are captured SEPARATELY (not
 * merged into one wall-clock number that hides the split), and that no
 * iteration silently escapes measurement — a gap here reproduces the exact
 * blind spot being fixed.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';
import type { IterationTiming } from '../../../src/agent/types.js';

function tool(name: string, { delayMs = 0, fail = false } = {}) {
  return {
    name,
    definition: { name, description: 'x', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { toolUseId: 't', content: fail ? 'boom' : 'ok result', isError: fail };
    },
  } as any;
}

/** A provider whose Nth stream() call is scripted. */
function scripted(turns: Array<{ delayMs?: number; content: unknown[]; stopReason: string }>) {
  let i = 0;
  return {
    name: 'stub',
    async stream() {
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
      return { content: t.content, stopReason: t.stopReason, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as any;
}

describe('AgentRunner records model/tool timing per iteration', () => {
  it('emits one timing record for a tool-calling round', async () => {
    const provider = scripted([
      { content: [{ type: 'tool_use', id: 't', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings.length, 'expected one timing record per iteration (2 turns)').toBe(2);
    expect(r.timings[0].toolCalls.map((c) => c.name)).toEqual(['q']);
    expect(r.timings[1].toolCalls, 'the final no-tool turn should record zero tool calls').toEqual([]);
  });

  it('separates model latency from tool execution time', async () => {
    // A slow MODEL and a fast tool: toolExecMs must stay near-zero even though
    // the round as a whole was slow. Conflating the two is the exact defect —
    // it would make a slow model indistinguishable from a slow tool.
    const provider = scripted([
      { delayMs: 60, content: [{ type: 'tool_use', id: 't', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q', { delayMs: 0 })], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings[0].modelLatencyMs, 'the slow model call was not measured').toBeGreaterThanOrEqual(55);
    expect(r.timings[0].toolExecMs, 'tool time absorbed the model\'s latency — the split is meaningless')
      .toBeLessThan(30);
  });

  it('separates tool execution time from model latency, the other way round', async () => {
    // A fast model, a slow tool — the case that actually matters for the
    // detective: distinguishing "the model is slow" from "codegraph-agent-
    // query.sh is slow."
    const provider = scripted([
      { content: [{ type: 'tool_use', id: 't', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q', { delayMs: 60 })], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings[0].toolExecMs, 'the slow tool was not measured').toBeGreaterThanOrEqual(55);
    expect(r.timings[0].modelLatencyMs, 'model time absorbed the tool\'s latency')
      .toBeLessThan(30);
  });

  it('records result size and error status per tool call', async () => {
    const provider = scripted([
      { content: [{ type: 'tool_use', id: 't', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    const call = r.timings[0].toolCalls[0];
    expect(call.resultBytes, 'result size is not recorded — cannot tell a large ' +
      'CodeGraph dump from a tiny one').toBeGreaterThan(0);
    expect(call.isError).toBe(false);
  });

  it('flags a failing tool call as an error, not silently', async () => {
    const provider = scripted([
      { content: [{ type: 'tool_use', id: 't', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q', { fail: true })], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings[0].toolCalls[0].isError).toBe(true);
  });

  it('records a timing even for a turn with no tool calls (final answer)', async () => {
    const provider = scripted([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings.length, 'the single, tool-free turn went unmeasured').toBe(1);
    expect(r.timings[0].toolExecMs).toBe(0);
  });

  it('numbers timings by iteration in order', async () => {
    const provider = scripted([
      { content: [{ type: 'tool_use', id: 't1', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 't2', name: 'q', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('q')], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings.map((t) => t.iteration)).toEqual([1, 2, 3]);
  });

  it('fires onIterationTiming as a live callback, not just in the final result', async () => {
    // Streaming access matters: a run that dies mid-way (crash, external kill)
    // must not lose every timing that happened before the crash — the same
    // reasoning as onToolCall/onIterationStart, which already stream.
    const seen: IterationTiming[] = [];
    const provider = scripted([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
    await new AgentRunner({
      userMessage: 'go', provider, tools: [], model: 'm', dangerousSkipApproval: true,
      onIterationTiming: (t: IterationTiming) => seen.push(t),
    } as any).run();

    expect(seen.length, 'onIterationTiming never fired — timings are only ' +
      'recoverable after a clean exit').toBe(1);
  });

  it('a multi-tool-call turn records every call, not just the first', async () => {
    const provider = scripted([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'a', input: {} },
          { type: 'tool_use', id: 't2', name: 'b', input: {} },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const r = await new AgentRunner({
      userMessage: 'go', provider, tools: [tool('a'), tool('b')], model: 'm', dangerousSkipApproval: true,
    } as any).run();

    expect(r.timings[0].toolCalls.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });
});
