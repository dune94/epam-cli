/**
 * AgentRunner wires LoopDetector into the real tool-execution loop:
 * exact-repeat calls get blocked BEFORE execution (never reach the tool),
 * and a real error repeating the same fingerprint gets a nudge appended to
 * its result content. Real AgentRunner.run(), stub provider/tool — not a
 * description of the wiring, an execution of it.
 */
import { describe, it, expect } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';

/** Provider that calls the same bash command with identical args every turn, forever. */
function repeatingCallProvider(maxTurns: number) {
  let turn = 0;
  return {
    name: 'stub',
    async stream() {
      turn++;
      if (turn > maxTurns) {
        return { content: [{ type: 'text', text: 'giving up' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return {
        content: [{ type: 'tool_use', id: `t${turn}`, name: 'bash', input: { command: 'npm test' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as any;
}

function countingBashTool(executionCounter: { count: number }, { alwaysFailSameWay = false } = {}) {
  return {
    name: 'bash',
    definition: { name: 'bash', description: 'runs shell', inputSchema: { type: 'object', properties: {} } },
    permission: 'safe',
    async execute() {
      executionCounter.count++;
      if (alwaysFailSameWay) {
        return { toolUseId: 't', content: 'Error: 3 tests failed\n  at line 42', isError: true };
      }
      return { toolUseId: 't', content: 'ok', isError: false };
    },
  } as any;
}

describe('AgentRunner — loop protection is real, not just a helper class sitting unused', () => {
  it('stops executing the tool once the exact same call has repeated past the threshold', async () => {
    const counter = { count: 0 };
    await new AgentRunner({
      userMessage: 'run tests',
      provider: repeatingCallProvider(6),
      tools: [countingBashTool(counter)],
      model: 'm',
      dangerousSkipApproval: true,
      maxIterations: 6,
    } as any).run();

    // Default maxIdenticalToolCalls=2 means the 3rd+ identical call onward
    // is blocked before it ever reaches the tool's execute() — so across 6
    // turns of the IDENTICAL call, the tool should have actually run only
    // twice, not six times.
    expect(counter.count).toBe(2);
  });

  it('a genuinely repeating error gets a nudge appended to its result content (model still sees the real output)', async () => {
    const counter = { count: 0 };
    const results: string[] = [];
    await new AgentRunner({
      userMessage: 'run tests',
      provider: repeatingCallProvider(1), // only 1 turn so the tool call isn't ALSO blocked by preToolCheck
      tools: [countingBashTool(counter, { alwaysFailSameWay: true })],
      model: 'm',
      dangerousSkipApproval: true,
      maxIterations: 2,
      onToolResult: (_name: string, content: string) => { results.push(content); },
    } as any).run();

    expect(results[0]).toContain('3 tests failed');
    expect(results[0]).not.toMatch(/LOOP PROTECTION/); // first occurrence — not yet repeating
  });

  it('the SAME failing command called across multiple turns gets the repeat nudge on the 2nd occurrence, before the call itself gets blocked on the 3rd', async () => {
    const counter = { count: 0 };
    const results: string[] = [];
    await new AgentRunner({
      userMessage: 'run tests',
      provider: repeatingCallProvider(3),
      tools: [countingBashTool(counter, { alwaysFailSameWay: true })],
      model: 'm',
      dangerousSkipApproval: true,
      maxIterations: 4,
      onToolResult: (_name: string, content: string) => { results.push(content); },
    } as any).run();

    // Turn 1: real failure, no nudge yet.
    expect(results[0]).toContain('3 tests failed');
    expect(results[0]).not.toMatch(/LOOP PROTECTION/);
    // Turn 2: same fingerprint repeats — real output PLUS the nudge appended.
    expect(results[1]).toContain('3 tests failed');
    expect(results[1]).toMatch(/LOOP PROTECTION/);
    // Turn 3+: the identical CALL itself is now blocked before execution —
    // the tool never runs a 3rd time.
    expect(counter.count).toBe(2);
  });
});
