/**
 * GitHub Copilot Provider
 *
 * Uses the GitHub Models REST API (OpenAI-compatible).
 * Endpoint: https://models.github.ai/inference
 *
 * Authentication (in order of priority):
 * 1. COPILOT_GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. GITHUB_TOKEN env var
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

const GITHUB_MODELS_URL = 'https://models.github.ai/inference';

export interface CopilotConfig {
  model?: string;
  token?: string;
}

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'anthropic/claude-4-sonnet';

  // Models available via GitHub Models API (vendor/model format)
  static readonly SUPPORTED_MODELS = [
    'anthropic/claude-4-sonnet',    // Claude 4 Sonnet (default)
    'anthropic/claude-4-opus',      // Claude 4 Opus
    'anthropic/claude-3.7-sonnet',  // Claude 3.7 Sonnet
    'anthropic/claude-3.5-sonnet',  // Claude 3.5 Sonnet
    'anthropic/claude-3.5-haiku',   // Claude 3.5 Haiku
    'openai/gpt-5',                 // GPT-5
    'openai/gpt-5-mini',            // GPT-5 mini
    'openai/gpt-4.1',               // GPT-4.1
    'openai/gpt-4o',                // GPT-4o
    'openai/o3-mini',               // o3-mini reasoning
    'google/gemini-2.5-pro',        // Gemini 2.5 Pro
    'google/gemini-2.5-flash',      // Gemini 2.5 Flash
    'google/gemini-2.0-flash',      // Gemini 2.0 Flash
    'xai/grok-4',                   // Grok 4
    'xai/grok-3',                   // Grok 3
    'deepseek/deepseek-r1',         // DeepSeek R1
    'deepseek/deepseek-v3',         // DeepSeek V3
    'meta/llama-4-scout',           // Llama 4 Scout
    'meta/llama-4-maverick',        // Llama 4 Maverick
  ] as const;

  private model: string;
  private token: string;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
    this.token = config.token || CopilotProvider.resolveToken();
  }

  /** Use requested model directly; fall back to instance default. */
  private resolveModel(requested?: string): string {
    if (requested) return requested;
    return this.model || this.defaultModel;
  }

  /** Resolve GitHub token from environment or gh CLI. */
  static resolveToken(): string {
    const envToken = process.env.COPILOT_GITHUB_TOKEN ||
                     process.env.GH_TOKEN ||
                     process.env.GITHUB_TOKEN ||
                     process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (envToken) return envToken;
    // Fall back to gh CLI stored token (for OAuth-authed accounts)
    try {
      const { execSync } = require('child_process');
      const token = execSync('gh auth token 2>/dev/null', { stdio: ['ignore','pipe','ignore'], timeout: 2000 })
        .toString().trim();
      if (token) return token;
    } catch { /* gh not available or not logged in */ }
    return '';
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
        'X-GitHub-Api-Version': '2022-11-28',
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
        'X-GitHub-Api-Version': '2022-11-28',
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
        headers: { 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static getAuthInstructions(): string {
    return `GitHub Copilot Authentication:
Set one of: COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN
Token must be a GitHub PAT with 'models:read' permission, or use 'gh auth login' with the GitHub CLI.`;
  }
}

export function createCopilotProvider(model?: string, token?: string): CopilotProvider | null {
  const effectiveToken = token || CopilotProvider.resolveToken();
  if (!effectiveToken) {
    logger.debug('No GitHub token found for direct Copilot access — will try proxy if available.');
    return null;
  }
  return new CopilotProvider({ model, token: effectiveToken });
}

