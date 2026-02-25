import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../src/agent/AgentRunner.js';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../../src/providers/types.js';
import type { Tool, ToolResult } from '../../src/tools/types.js';

class SequenceProvider implements LLMProvider {
  readonly name = 'seq';
  readonly defaultModel = 'seq';
  private idx = 0;

  constructor(private responses: ProviderResponse[]) {}

  async complete(_r: ProviderRequest): Promise<ProviderResponse> {
    return this.responses[this.idx++ % this.responses.length];
  }

  async stream(_r: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const res = this.responses[this.idx++ % this.responses.length];
    const text = res.content.find(p => p.type === 'text')?.text ?? '';
    if (text) handler({ type: 'text_delta', text });
    handler({ type: 'message_stop', stopReason: res.stopReason });
    return res;
  }
}

const noopTool: Tool = {
  name: 'noop',
  description: 'Does nothing',
  permission: 'safe',
  definition: {
    name: 'noop',
    description: 'Does nothing',
    inputSchema: { type: 'object', properties: {} },
  },
  async execute(): Promise<ToolResult> {
    return { toolUseId: '', content: 'ok', isError: false };
  },
};

describe('AgentRunner', () => {
  it('single-turn: returns final response', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'The answer is 42.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 8 },
      },
    ]);

    const deltas: string[] = [];
    const runner = new AgentRunner({
      userMessage: 'What is the answer?',
      systemPrompt: '',
      provider,
      model: 'seq',
      tools: [],
      onTextDelta: d => deltas.push(d),
    });

    const result = await runner.run();
    expect(result.finalResponse).toBe('The answer is 42.');
    expect(result.iterations).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(deltas).toContain('The answer is 42.');
  });

  it('stops at maxIterations when stuck in tool loop', async () => {
    // Always returns tool_use — never ends
    const provider = new SequenceProvider([
      {
        content: [{ type: 'tool_use', id: 'tid', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    vi.mock('../../src/tools/approval/ApprovalGate.js', () => ({
      requestApproval: vi.fn().mockResolvedValue(true),
    }));

    const runner = new AgentRunner({
      userMessage: 'Loop',
      systemPrompt: '',
      provider,
      model: 'seq',
      tools: [noopTool],
      maxIterations: 3,
    });

    const result = await runner.run();
    expect(result.iterations).toBe(3);
  });
});
