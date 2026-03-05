/**
 * Cursor Provider
 * 
 * Uses Gemini 2.5 Pro API for Cursor agent
 * https://cursor.com
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface CursorConfig {
  apiKey: string;
  baseURL?: string;
}

export class CursorProvider implements LLMProvider {
  readonly name = 'cursor';
  readonly defaultModel = 'gemini-2.5-pro';

  private apiKey: string;
  private baseURL: string;

  constructor(config: CursorConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
  }

  /** Use the requested model only if it's a Gemini model; fall back to default. */
  private resolveModel(requested?: string): string {
    if (requested && /^gemini-/.test(requested)) return requested;
    return this.defaultModel;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: messages,
          generationConfig: {
            maxOutputTokens: request.maxTokens || 4096,
            temperature: request.temperature || 0.7,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cursor API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new Error('Cursor API returned no candidates');
      }

      const content: ContentPart[] = [
        { type: 'text', text: candidate.content?.parts?.[0]?.text || '' }
      ];

      return {
        content,
        stopReason: this.mapStopReason(candidate.finishReason),
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount || 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'CursorProvider complete failed');
      throw err;
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      const response = await fetch(`${this.baseURL}/models/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: messages,
          generationConfig: {
            maxOutputTokens: request.maxTokens || 4096,
            temperature: request.temperature || 0.7,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cursor API error: ${response.status} ${error}`);
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
            
            const candidate = parsed.candidates?.[0];
            if (candidate) {
              const delta = candidate.content?.parts?.[0]?.text || '';
              if (delta) {
                accumulatedText += delta;
                handler({ type: 'text_delta', text: delta });
              }

              if (candidate.finishReason) {
                stopReason = this.mapStopReason(candidate.finishReason);
              }
            }

            if (parsed.usageMetadata) {
              inputTokens = parsed.usageMetadata.promptTokenCount || 0;
              outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
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
      logger.error({ error: (err as Error).message }, 'CursorProvider stream failed');
      throw err;
    }
  }

  /**
   * Format messages for Gemini API
   */
  private formatMessages(messages: Message[], systemPrompt?: string): any[] {
    const formatted: any[] = [];

    // Add system message as first user message with model instruction
    if (systemPrompt) {
      formatted.push({
        role: 'user',
        parts: [{ text: systemPrompt }],
      });
      formatted.push({
        role: 'model',
        parts: [{ text: 'Understood. I will follow these instructions.' }],
      });
    }

    // Format conversation messages
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      
      formatted.push({
        role,
        parts: [{ text: content }],
      });
    }

    return formatted;
  }

  /**
   * Map Gemini finishReason to our format
   */
  private mapStopReason(reason?: string): ProviderResponse['stopReason'] {
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }
}

/**
 * Factory function to create Cursor provider
 */
export function createCursorProvider(apiKey?: string, model?: string): CursorProvider | null {
  const key = apiKey || process.env.CURSOR_API_KEY;
  
  if (!key) {
    logger.warn('Cursor API key not found. Set CURSOR_API_KEY or use /keys set cursor');
    return null;
  }

  return new CursorProvider({ apiKey: key });
}
