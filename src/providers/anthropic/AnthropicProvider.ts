import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
  ContentPart,
  Message,
} from '../types.js';
import { ProviderError } from '../../utils/errors.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly defaultModel = 'claude-sonnet-4-6';

  private client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey,
      baseURL,
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 16384,
        system: request.systemPrompt,
        messages: this.convertMessages(request.messages),
        tools: request.tools?.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
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
      const stream = await this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens ?? 16384,
        system: request.systemPrompt,
        messages: this.convertMessages(request.messages),
        tools: request.tools?.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      });

      // Track tool use blocks being built
      const toolBlocks: Map<number, { id: string; name: string; input: string }> = new Map();
      const textParts: string[] = [];

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              input: '',
            });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            handler({ type: 'text_delta', text: event.delta.text });
            textParts.push(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.input += event.delta.partial_json;
              handler({
                type: 'tool_delta',
                id: block.id,
                name: block.name,
                input: event.delta.partial_json,
              });
            }
          }
        } else if (event.type === 'message_stop') {
          handler({ type: 'message_stop', stopReason: 'end_turn' });
        }
      }

      const finalMessage = await stream.finalMessage();
      return this.convertResponse(finalMessage);
    } catch (err) {
      handler({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      throw this.wrapError(err);
    }
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map(p => {
                if (p.type === 'text') return { type: 'text' as const, text: p.text ?? '' };
                if (p.type === 'tool_use') {
                  return {
                    type: 'tool_use' as const,
                    id: p.id ?? '',
                    name: p.name ?? '',
                    input: p.input ?? {},
                  };
                }
                if (p.type === 'tool_result') {
                  return {
                    type: 'tool_result' as const,
                    tool_use_id: p.tool_use_id ?? '',
                    content: typeof p.content === 'string' ? p.content : '',
                  };
                }
                return { type: 'text' as const, text: '' };
              }),
      }));
  }

  private convertResponse(response: Anthropic.Message): ProviderResponse {
    const content: ContentPart[] = response.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      return { type: 'text', text: '' };
    });

    const stopReason =
      response.stop_reason === 'tool_use'
        ? 'tool_use'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn';

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private wrapError(err: unknown): ProviderError {
    if (err instanceof Anthropic.APIError) {
      return new ProviderError(
        `Anthropic API error: ${err.message}`,
        err.status,
        err
      );
    }
    return new ProviderError(
      `Anthropic error: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err instanceof Error ? err : undefined
    );
  }
}
