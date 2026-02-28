import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
  ContentPart,
  Message,
} from '../types.js';
import { ProviderError } from '../../utils/errors.js';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly defaultModel = 'gemini-1.5-pro';

  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const model = this.getModel(request);
      const { history, lastMessage } = this.convertMessages(request.messages);

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(lastMessage);
      const response = result.response;

      const text = response.text();
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    try {
      const model = this.getModel(request);
      const { history, lastMessage } = this.convertMessages(request.messages);

      const chat = model.startChat({ history });
      const result = await chat.sendMessageStream(lastMessage);

      let fullText = '';
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          handler({ type: 'text_delta', text });
          fullText += text;
        }
      }

      handler({ type: 'message_stop', stopReason: 'end_turn' });

      const finalResponse = await result.response;
      return {
        content: [{ type: 'text', text: fullText }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: finalResponse.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: finalResponse.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      handler({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      throw this.wrapError(err);
    }
  }

  private getModel(request: ProviderRequest): GenerativeModel {
    const systemInstruction = request.systemPrompt
      ? { role: 'user' as const, parts: [{ text: request.systemPrompt }] }
      : undefined;

    return this.genAI.getGenerativeModel({
      model: request.model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 16384,
      },
    });
  }

  private convertMessages(messages: Message[]): {
    history: Array<{ role: string; parts: Array<{ text: string }> }>;
    lastMessage: string;
  } {
    const nonSystem = messages.filter(m => m.role !== 'system');
    if (nonSystem.length === 0) {
      return { history: [], lastMessage: '' };
    }

    const history = nonSystem.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

    const last = nonSystem[nonSystem.length - 1];
    const lastMessage = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);

    return { history, lastMessage };
  }

  private wrapError(err: unknown): ProviderError {
    return new ProviderError(
      `Gemini error: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err instanceof Error ? err : undefined
    );
  }
}
