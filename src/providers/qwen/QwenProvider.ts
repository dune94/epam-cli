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
  /** When true, use OpenAI-compatible OpenRouter endpoint instead of DashScope */
  openRouterMode?: boolean;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

export class QwenProvider implements LLMProvider {
  readonly name = 'qwen';
  readonly defaultModel = 'qwen/qwen-2.5-72b-instruct';

  private apiKey: string;
  private baseURL: string;
  private openRouterMode: boolean;

  constructor(config: QwenConfig) {
    this.apiKey = config.apiKey;
    this.openRouterMode = config.openRouterMode ?? false;
    this.baseURL = config.baseURL || (this.openRouterMode ? OPENROUTER_BASE_URL : DASHSCOPE_BASE_URL);
  }

  /** Only use request.model if it looks like a qwen/openrouter model. Falls back to default. */
  private resolveModel(requested?: string): string {
    if (requested && /^(qwen|mistral|llama|deepseek|meta-llama)/.test(requested)) return requested;
    return this.defaultModel;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.openRouterMode
      ? this.completeOpenRouter(request)
      : this.completeDashScope(request);
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    return this.openRouterMode
      ? this.streamOpenRouter(request, handler)
      : this.streamDashScope(request, handler);
  }

  // ─── OpenRouter (OpenAI-compatible) ────────────────────────────────────────

  private async completeOpenRouter(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://epam.com',
        'X-Title': 'EPAM CLI',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter/Qwen API error: ${response.status} ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data['choices']?.[0];
    if (!choice) throw new Error('OpenRouter returned no choices');

    return {
      content: [{ type: 'text', text: choice.message?.content || '' }],
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: data['usage']?.prompt_tokens || 0,
        outputTokens: data['usage']?.completion_tokens || 0,
      },
    };
  }

  private async streamOpenRouter(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://epam.com',
        'X-Title': 'EPAM CLI',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter/Qwen API error: ${response.status} ${error}`);
    }

    if (!response.body) throw new Error('No response body');

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
      for (const line of chunk.split('\n').filter(l => l.startsWith('data:'))) {
        const data = line.substring(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            accumulatedText += choice.delta.content;
            handler({ type: 'text_delta', text: choice.delta.content });
          }
          if (choice?.finish_reason) stopReason = this.mapStopReason(choice.finish_reason);
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.completion_tokens || 0;
          }
        } catch { /* skip malformed */ }
      }
    }

    return {
      content: [{ type: 'text', text: accumulatedText }],
      stopReason,
      usage: { inputTokens, outputTokens },
    };
  }

  // ─── DashScope (Alibaba native) ────────────────────────────────────────────

  private async completeDashScope(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
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

      const data = await response.json() as Record<string, any>;

      const choice = data['output']?.choices?.[0];
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
          inputTokens: data['usage']?.input_tokens || 0,
          outputTokens: data['usage']?.output_tokens || 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'QwenProvider complete failed');
      throw err;
    }
  }

  private async streamDashScope(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
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
  // Prefer OpenRouter key (English UI, no Alibaba account needed)
  const openRouterKey = process.env.OPENROUTER_API_KEY ?? process.env.EPAM_API_KEY_OPENROUTER;
  const dashScopeKey = apiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY;

  if (openRouterKey) {
    return new QwenProvider({ apiKey: openRouterKey, openRouterMode: true });
  }

  if (!dashScopeKey) {
    logger.warn('Qwen API key not found. Set OPENROUTER_API_KEY or use /provider auth qwen');
    return null;
  }

  return new QwenProvider({ apiKey: dashScopeKey });
}
