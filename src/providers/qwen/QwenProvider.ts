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
  readonly defaultModel = 'qwen/qwen3-coder';

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
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

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
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter/Qwen API error: ${response.status} ${error}`);
    }

    const data = await response.json() as Record<string, any>;
    const choice = data['choices']?.[0];
    if (!choice) throw new Error('OpenRouter returned no choices');

    const content: ContentPart[] = [];
    if (choice.message?.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
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
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

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
        ...(tools && tools.length > 0 ? { tools } : {}),
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
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

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
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              }
              const existing = toolCalls.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
                handler({ type: 'tool_delta', id: existing.id, name: existing.name, input: tc.function.arguments });
              }
            }
          }
          if (choice?.finish_reason) stopReason = this.mapStopReason(choice.finish_reason);
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens || 0;
            outputTokens = parsed.usage.completion_tokens || 0;
          }
        } catch { /* skip malformed */ }
      }
    }

    const content: ContentPart[] = [];
    if (accumulatedText) content.push({ type: 'text', text: accumulatedText });
    for (const tc of toolCalls.values()) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
      });
    }
    if (toolCalls.size > 0) stopReason = 'tool_use';

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: accumulatedText }],
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
   * Format messages for OpenAI-compatible API (OpenRouter or DashScope)
   */
  private formatMessages(messages: Message[], systemPrompt?: string): any[] {
    const formatted: any[] = [];

    if (systemPrompt) {
      formatted.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          formatted.push({ role: 'assistant', content: msg.content });
        } else {
          const toolCalls = (msg.content as ContentPart[])
            .filter(p => p.type === 'tool_use')
            .map(p => ({
              id: p.id ?? '',
              type: 'function' as const,
              function: { name: p.name ?? '', arguments: JSON.stringify(p.input ?? {}) },
            }));
          const textPart = (msg.content as ContentPart[]).find(p => p.type === 'text')?.text;
          formatted.push({
            role: 'assistant',
            content: textPart ?? null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      } else if (msg.role === 'tool') {
        // Convert tool results to OpenAI tool role
        const parts = Array.isArray(msg.content) ? msg.content as ContentPart[] : [];
        for (const part of parts) {
          if (part.type === 'tool_result') {
            formatted.push({
              role: 'tool',
              tool_call_id: part.tool_use_id ?? '',
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            });
          }
        }
        // Fallback if content is a plain string
        if (typeof msg.content === 'string') {
          formatted.push({ role: 'user', content: `Tool result: ${msg.content}` });
        }
      } else {
        formatted.push({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
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
