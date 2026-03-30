import OpenAI from 'openai';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
  ContentPart,
  Message,
} from '../types.js';
import { ProviderError } from '../../utils/errors.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly defaultModel = 'gpt-4o';

  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 16384,
        messages: this.convertMessages(request),
        tools: request.tools?.map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        stream: false,
      });

      return this.convertResponse(response);
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    try {
      const stream = await this.client.chat.completions.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 16384,
        messages: this.convertMessages(request),
        tools: request.tools?.map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
        stream: true,
      });

      let fullText = '';
      const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          handler({ type: 'text_delta', text: delta.content });
          fullText += delta.content;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (!existing) {
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            } else {
              existing.args += tc.function?.arguments ?? '';
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              handler({
                type: 'tool_delta',
                id: existing.id,
                name: existing.name,
                input: tc.function?.arguments ?? '',
              });
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          handler({ type: 'message_stop', stopReason: 'end_turn' });
        }
      }

      const content: ContentPart[] = [];
      if (fullText) content.push({ type: 'text', text: fullText });

      for (const [, tc] of toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.args || '{}'),
        });
      }

      const stopReason = toolCalls.size > 0 ? 'tool_use' : 'end_turn';
      return { content, stopReason, usage: { inputTokens: 0, outputTokens: 0 } };
    } catch (err) {
      handler({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      throw this.wrapError(err);
    }
  }

  private convertMessages(request: ProviderRequest): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        messages.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content });
        } else {
          const toolCalls = msg.content
            .filter(p => p.type === 'tool_use')
            .map(p => ({
              id: p.id ?? '',
              type: 'function' as const,
              function: { name: p.name ?? '', arguments: JSON.stringify(p.input ?? {}) },
            }));
          const textContent = msg.content.find(p => p.type === 'text')?.text;
          messages.push({
            role: 'assistant',
            content: textContent ?? null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        }
      } else if (msg.role === 'tool') {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'tool_result') {
              messages.push({
                role: 'tool',
                tool_call_id: part.tool_use_id ?? '',
                content: typeof part.content === 'string' ? part.content : '',
              });
            }
          }
        }
      }
    }

    return messages;
  }

  private convertResponse(response: OpenAI.ChatCompletion): ProviderResponse {
    const choice = response.choices[0];
    const content: ContentPart[] = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }

    const stopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn';

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  private wrapError(err: unknown): ProviderError {
    if (err instanceof OpenAI.APIError) {
      return new ProviderError(`OpenAI API error: ${err.message}`, err.status, err);
    }
    return new ProviderError(
      `OpenAI error: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err instanceof Error ? err : undefined
    );
  }
}
