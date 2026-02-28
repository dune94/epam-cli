import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../../../src/agent/AgentRunner.js';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../../../src/providers/types.js';

class SingleResponseProvider implements LLMProvider {
  readonly name = 'test';
  readonly defaultModel = 'test';

  constructor(private response: ProviderResponse) {}

  async complete(_r: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }

  async stream(_r: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const text = this.response.content.find(p => p.type === 'text')?.text ?? '';
    if (text) handler({ type: 'text_delta', text });
    handler({ type: 'message_stop', stopReason: this.response.stopReason });
    return this.response;
  }
}

describe('AgentRunner conversation continuity', () => {
  it('prepends history messages before the current user message', async () => {
    let capturedMessages: unknown = null;

    const provider: LLMProvider = {
      name: 'spy',
      defaultModel: 'spy',
      async complete() { throw new Error('unused'); },
      async stream(request, handler) {
        capturedMessages = [...request.messages];
        const res: ProviderResponse = {
          content: [{ type: 'text', text: 'reply' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        handler({ type: 'text_delta', text: 'reply' });
        handler({ type: 'message_stop', stopReason: 'end_turn' });
        return res;
      },
    };

    const runner = new AgentRunner({
      userMessage: 'follow-up question',
      systemPrompt: 'sys',
      provider,
      model: 'spy',
      tools: [],
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });

    await runner.run();

    const msgs = capturedMessages as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('first question');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('first answer');
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toBe('follow-up question');
  });

  it('returns the full messages array in result', async () => {
    const provider = new SingleResponseProvider({
      content: [{ type: 'text', text: 'hello back' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const runner = new AgentRunner({
      userMessage: 'hello',
      systemPrompt: '',
      provider,
      model: 'test',
      tools: [],
      history: [
        { role: 'user', content: 'prior' },
        { role: 'assistant', content: 'prior reply' },
      ],
    });

    const result = await runner.run();
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toBe('prior');
    expect(result.messages[1].content).toBe('prior reply');
    expect(result.messages[2].content).toBe('hello');
    // Last message is assistant with ContentPart[]
    expect(result.messages[3].role).toBe('assistant');
  });

  it('works with no history (backward compatible)', async () => {
    const provider = new SingleResponseProvider({
      content: [{ type: 'text', text: 'answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const runner = new AgentRunner({
      userMessage: 'question',
      systemPrompt: '',
      provider,
      model: 'test',
      tools: [],
    });

    const result = await runner.run();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'question' });
    expect(result.finalResponse).toBe('answer');
  });
});
