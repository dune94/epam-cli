import { describe, it, expect } from 'vitest';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../../src/providers/types.js';

class MockStreamingProvider implements LLMProvider {
  readonly name = 'mock-stream';
  readonly defaultModel = 'mock-model';

  async complete(_req: ProviderRequest): Promise<ProviderResponse> {
    return {
      content: [{ type: 'text', text: 'Hello, world!' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async stream(_req: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    for (const word of ['Hello', ', ', 'world', '!']) {
      handler({ type: 'text_delta', text: word });
    }
    handler({ type: 'message_stop', stopReason: 'end_turn' });
    return {
      content: [{ type: 'text', text: 'Hello, world!' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

describe('Provider stream contract', () => {
  it('delivers text_delta events and a message_stop', async () => {
    const provider = new MockStreamingProvider();
    const deltas: string[] = [];
    let stopped = false;

    await provider.stream(
      { messages: [{ role: 'user', content: 'hi' }], model: 'mock-model', stream: true },
      delta => {
        if (delta.type === 'text_delta') deltas.push(delta.text);
        if (delta.type === 'message_stop') stopped = true;
      }
    );

    expect(deltas.join('')).toBe('Hello, world!');
    expect(stopped).toBe(true);
  });

  it('complete returns full response', async () => {
    const provider = new MockStreamingProvider();
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'mock-model',
      stream: false,
    });
    expect(response.stopReason).toBe('end_turn');
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'Hello, world!' });
  });
});
