/**
 * GitHub Copilot Provider
 *
 * Uses the GitHub Models REST API (OpenAI-compatible).
 * Endpoint: https://models.inference.ai.azure.com
 *
 * Authentication (in order of priority):
 * 1. COPILOT_GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. GITHUB_TOKEN env var
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com';

export interface CopilotConfig {
  model?: string;
  token?: string;
}

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'gpt-4o';

  private model: string;
  private token: string;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
    this.token = config.token || CopilotProvider.resolveToken();
  }

  /** Only pass model names that GitHub Models actually accepts. */
  private resolveModel(requested?: string): string {
    const supported = /^gpt-|^o[0-9]|^mistral-|^llama-|^phi-/;
    if (requested && supported.test(requested)) return requested;
    if (this.model && supported.test(this.model)) return this.model;
    return this.defaultModel;
  }

  /** Resolve GitHub token from environment. */
  static resolveToken(): string {
    return process.env.COPILOT_GITHUB_TOKEN ||
           process.env.GH_TOKEN ||
           process.env.GITHUB_TOKEN || '';
  }

  private formatMessages(messages: Message[], systemPrompt?: string): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      out.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
    return out;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    const response = await fetch(`${GITHUB_MODELS_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
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
      throw new Error(`GitHub Models API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('GitHub Models returned no choices');

    return {
      content: [{ type: 'text', text: choice.message?.content || '' }],
      stopReason: choice.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    const response = await fetch(`${GITHUB_MODELS_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
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
      throw new Error(`GitHub Models API error: ${response.status} ${error}`);
    }

    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (json === '[DONE]') break;
          try {
            const chunk = JSON.parse(json);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              handler({ type: 'text_delta', text: delta });
            }
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens || 0;
              outputTokens = chunk.usage.completion_tokens || 0;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    }

    return {
      content: [{ type: 'text', text: fullText }],
      stopReason: 'end_turn',
      usage: { inputTokens, outputTokens },
    };
  }

  static async isAvailable(): Promise<boolean> {
    return !!CopilotProvider.resolveToken();
  }

  static async isAuthenticated(): Promise<boolean> {
    const token = CopilotProvider.resolveToken();
    if (!token) return false;
    try {
      const res = await fetch(`${GITHUB_MODELS_URL}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static getAuthInstructions(): string {
    return `GitHub Copilot Authentication:
Set one of: COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN
Token must be a GitHub OAuth (gho_) or fine-grained PAT with GitHub Models access.`;
  }
}

export function createCopilotProvider(model?: string, token?: string): CopilotProvider | null {
  const effectiveToken = token || CopilotProvider.resolveToken();
  if (!effectiveToken) {
    logger.warn('No GitHub token found. Set GH_TOKEN or COPILOT_GITHUB_TOKEN.');
    return null;
  }
  return new CopilotProvider({ model, token: effectiveToken });
}

