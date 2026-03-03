/**
 * Qwen Provider
 * 
 * Alibaba Cloud DashScope API provider for Qwen models
 * https://dashscope.aliyun.com
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface QwenConfig {
  apiKey: string;
  baseURL?: string;
}

export class QwenProvider implements LLMProvider {
  readonly name = 'qwen';
  readonly defaultModel = 'qwen-max';

  private apiKey: string;
  private baseURL: string;

  constructor(config: QwenConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'https://dashscope.aliyuncs.com/api/v1';
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model || this.defaultModel;
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/services/aigc/text-generation/generation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: { messages },
          parameters: {
            max_tokens: request.maxTokens || 4096,
            temperature: request.temperature || 0.7,
            result_format: 'message',
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Qwen API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      const choice = data.output?.choices?.[0];
      if (!choice) {
        throw new Error('Qwen API returned no choices');
      }

      const content: ContentPart[] = [
        { type: 'text', text: choice.message?.content || '' }
      ];

      return {
        content,
        stopReason: this.mapStopReason(choice.finish_reason),
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'QwenProvider complete failed');
      throw err;
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = request.model || this.defaultModel;
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/services/aigc/text-generation/generation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify({
          model,
          input: { messages },
          parameters: {
            max_tokens: request.maxTokens || 4096,
            temperature: request.temperature || 0.7,
            result_format: 'message',
            incremental_output: true,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Qwen API error: ${response.status} ${error}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let accumulatedText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: ProviderResponse['stopReason'] = 'end_turn';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.startsWith('data:'));

        for (const line of lines) {
          const data = line.substring(5).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            
            const choice = parsed.output?.choices?.[0];
            if (choice) {
              const delta = choice.message?.content || '';
              if (delta) {
                accumulatedText += delta;
                handler({ type: 'text_delta', text: delta });
              }

              if (choice.finish_reason) {
                stopReason = this.mapStopReason(choice.finish_reason);
              }
            }

            if (parsed.usage) {
              inputTokens = parsed.usage.input_tokens || 0;
              outputTokens = parsed.usage.output_tokens || 0;
            }
          } catch {
            // Skip malformed JSON
          }
        }
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

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'QwenProvider stream failed');
      throw err;
    }
  }

  /**
   * Format messages for Qwen API
   */
  private formatMessages(messages: Message[], systemPrompt?: string): any[] {
    const formatted: any[] = [];

    // Add system message if provided
    if (systemPrompt) {
      formatted.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // Format conversation messages
    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Qwen doesn't support tool role, convert to user
        formatted.push({
          role: 'user',
          content: typeof msg.content === 'string' 
            ? `Tool result: ${msg.content}`
            : JSON.stringify(msg.content),
        });
      } else {
        formatted.push({
          role: msg.role,
          content: typeof msg.content === 'string' 
            ? msg.content 
            : JSON.stringify(msg.content),
        });
      }
    }

    return formatted;
  }

  /**
   * Map Qwen finish_reason to our format
   */
  private mapStopReason(reason?: string): ProviderResponse['stopReason'] {
    switch (reason) {
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'stop':
      default:
        return 'end_turn';
    }
  }
}

/**
 * Factory function to create Qwen provider
 */
export function createQwenProvider(apiKey?: string, model?: string): QwenProvider | null {
  const key = apiKey || process.env.QWEN_API_KEY;
  
  if (!key) {
    logger.warn('Qwen API key not found. Set QWEN_API_KEY or use /keys set qwen');
    return null;
  }

  return new QwenProvider({ apiKey: key });
}
