/**
 * Codemie Provider
 *
 * LLM Provider implementation for Codemie (Claude-based agent platform).
 * Uses SSO-stored cookies for authenticated requests.
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Codemie API response structure
 */
interface CodemieResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class CodemieProvider implements LLMProvider {
  readonly name = 'codemie';
  readonly defaultModel = 'claude-sonnet-4-5';

  constructor(
    private apiUrl: string,
    private cookies: Record<string, string>
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const messages = this.formatMessages(request.messages);
    
    const response = await fetch(`${request.model || this.defaultModel}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.formatCookies(),
      },
      body: JSON.stringify({
        messages,
        model: request.model || this.defaultModel,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`Codemie API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as unknown as CodemieResponse;

    const content: ContentPart[] = [
      { type: 'text', text: data.choices[0]?.message?.content || '' }
    ];

    return {
      content,
      stopReason: this.mapStopReason(data.choices[0]?.finish_reason || 'stop'),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const messages = this.formatMessages(request.messages);
    
    const response = await fetch(`${request.model || this.defaultModel}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.formatCookies(),
      },
      body: JSON.stringify({
        messages,
        model: request.model || this.defaultModel,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Codemie API error: ${response.status} ${response.statusText}`);
    }

    let accumulatedText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6); // Remove 'data: ' prefix
          if (data === '[DONE]') {
            stopReason = 'end_turn';
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            
            if (content) {
              accumulatedText += content;
              handler({ type: 'text_delta', text: content });
            }

            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || 0;
              outputTokens = parsed.usage.completion_tokens || 0;
            }

            if (parsed.choices?.[0]?.finish_reason) {
              stopReason = this.mapStopReason(parsed.choices[0].finish_reason);
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content: ContentPart[] = [
      { type: 'text', text: accumulatedText }
    ];

    return {
      content,
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }

  /**
   * Map Codemie finish_reason to ProviderResponse stopReason
   */
  private mapStopReason(reason: string): ProviderResponse['stopReason'] {
    switch (reason) {
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'stop':
      default:
        return 'end_turn';
    }
  }

  /**
   * Format messages for Codemie API
   */
  private formatMessages(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  }

  /**
   * Format cookies for HTTP header
   */
  private formatCookies(): string {
    return Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}

/**
 * Factory function to create Codemie provider from stored credentials
 */
export async function createCodemieProvider(codeMieUrl?: string): Promise<CodemieProvider | null> {
  const { CodemieSSO } = await import('./CodemieSSO.js');
  const sso = new CodemieSSO();
  
  const credentials = await sso.getStoredCredentials(codeMieUrl);
  
  if (!credentials || !credentials.cookies) {
    logger.warn('No Codemie credentials found. Run: epam provider login codemie');
    return null;
  }

  // Check if credentials are expired
  if (Date.now() > credentials.expiresAt) {
    logger.warn('Codemie credentials expired. Run: epam provider login codemie');
    await sso.clearStoredCredentials(codeMieUrl);
    return null;
  }

  return new CodemieProvider(credentials.apiUrl, credentials.cookies);
}
