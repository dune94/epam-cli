import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../types.js';
import { ProviderError } from '../../utils/errors.js';

export class ProxyProvider implements LLMProvider {
  readonly name = 'proxy';
  readonly defaultModel = 'claude-sonnet-4-6';

  constructor(
    private readonly backendUrl: string,
    private readonly getAccessToken: () => Promise<string>,
    private readonly targetProvider: string = 'anthropic'
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const token = await this.getAccessToken();
    const url = `${this.backendUrl}/v1/proxy/${this.targetProvider}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new ProviderError(
        `Proxy error: ${JSON.stringify(error)}`,
        response.status
      );
    }

    return response.json() as Promise<ProviderResponse>;
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const token = await this.getAccessToken();
    const url = `${this.backendUrl}/v1/proxy/${this.targetProvider}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new ProviderError(`Proxy stream error: ${JSON.stringify(error)}`, response.status);
    }

    if (!response.body) {
      throw new ProviderError('No response body from proxy');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              handler({ type: 'message_stop', stopReason });
              break;
            }
            try {
              const event = JSON.parse(data);
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                handler({ type: 'text_delta', text: event.delta.text });
                fullText += event.delta.text;
              } else if (event.type === 'message_delta') {
                stopReason = event.delta?.stop_reason ?? 'end_turn';
              }
            } catch {
              // Skip malformed SSE events
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: [{ type: 'text', text: fullText }],
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
