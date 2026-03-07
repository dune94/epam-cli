/**
 * GitHub Copilot Provider
 *
 * Supports two API backends:
 * 1. GitHub Models API (models.github.ai) — for PAT-based access (GPT, Llama, etc.)
 * 2. Copilot Internal API (api.githubcopilot.com) — for Copilot subscription models (Claude, etc.)
 *
 * Authentication (in order of priority):
 * 1. COPILOT_GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. GITHUB_TOKEN env var
 * 4. GITHUB_PERSONAL_ACCESS_TOKEN env var
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

const GITHUB_MODELS_URL = 'https://models.github.ai/inference';
const COPILOT_API_URL = 'https://api.githubcopilot.com';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// Copilot subscription models (routed through Copilot Internal API)
const COPILOT_MODELS = new Set([
  'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5',
]);

// Reasoning models use max_completion_tokens instead of max_tokens
const REASONING_MODELS = new Set(['openai/o3-mini', 'openai/o4-mini', 'openai/gpt-5', 'openai/gpt-5-mini']);

export interface CopilotConfig {
  model?: string;
  token?: string;
}

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'claude-sonnet-4.6';

  // All supported models across both backends
  static readonly SUPPORTED_MODELS = [
    // Copilot subscription models (via Copilot Internal API)
    'claude-opus-4.6',                       // Claude Opus 4.6
    'claude-sonnet-4.6',                     // Claude Sonnet 4.6 (default)
    'claude-haiku-4.5',                      // Claude Haiku 4.5
    // GitHub Models API models
    'openai/gpt-4o',                         // GPT-4o
    'openai/gpt-4o-mini',                    // GPT-4o mini
    'openai/gpt-4.1',                        // GPT-4.1
    'openai/gpt-4.1-mini',                   // GPT-4.1 mini
    'openai/gpt-4.1-nano',                   // GPT-4.1 nano
    'openai/gpt-5',                          // GPT-5 (reasoning)
    'openai/gpt-5-mini',                     // GPT-5 mini (reasoning)
    'openai/o3-mini',                        // o3-mini (reasoning)
    'openai/o4-mini',                        // o4-mini (reasoning)
    'meta/llama-4-scout-17b-16e-instruct',   // Llama 4 Scout
    'meta/llama-3.3-70b-instruct',           // Llama 3.3 70B
    'deepseek/DeepSeek-V3-0324',             // DeepSeek V3
    'deepseek/deepseek-r1',                  // DeepSeek R1
    'xai/grok-3',                            // Grok 3
    'xai/grok-3-mini',                       // Grok 3 mini
  ] as const;

  private model: string;
  private token: string;
  private copilotToken: string | null = null;
  private copilotTokenExpiry = 0;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
    this.token = config.token || CopilotProvider.resolveToken();
  }

  /** Use requested model directly; fall back to instance default. */
  private resolveModel(requested?: string): string {
    if (requested) return requested;
    return this.model || this.defaultModel;
  }

  /** Check if model routes through Copilot Internal API. */
  private isCopilotModel(model: string): boolean {
    return COPILOT_MODELS.has(model);
  }

  /** Exchange GitHub token for a short-lived Copilot API token (cached, 30 min TTL). */
  private async getCopilotToken(): Promise<string> {
    if (this.copilotToken && Date.now() < this.copilotTokenExpiry) {
      return this.copilotToken;
    }

    const res = await fetch(COPILOT_TOKEN_URL, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Copilot token exchange failed (${res.status}): ${body}. ` +
        `Claude models require a GitHub OAuth token with Copilot access. ` +
        `Use 'gh auth login' with the GitHub CLI, or set GH_TOKEN from an OAuth flow.`
      );
    }

    const data = await res.json();
    this.copilotToken = data.token;
    // Expire 2 minutes early to avoid edge cases
    this.copilotTokenExpiry = new Date(data.expires_at).getTime() - 120_000;
    logger.debug('Copilot API token acquired, expires: %s', data.expires_at);
    return this.copilotToken!;
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

  /** Build the token limit field — reasoning models use max_completion_tokens. */
  private buildTokenLimit(model: string, maxTokens?: number): Record<string, number> {
    const limit = maxTokens || 4096;
    if (REASONING_MODELS.has(model)) {
      return { max_completion_tokens: limit };
    }
    return { max_tokens: limit };
  }

  /** Resolve the API URL and auth token for the given model. */
  private async resolveEndpoint(model: string): Promise<{ url: string; authToken: string; headers: Record<string, string> }> {
    if (this.isCopilotModel(model)) {
      const copilotToken = await this.getCopilotToken();
      return {
        url: `${COPILOT_API_URL}/chat/completions`,
        authToken: copilotToken,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${copilotToken}`,
          'Editor-Version': 'epam-cli/0.1.0',
          'Copilot-Integration-Id': 'vscode-chat',
        },
      };
    }
    return {
      url: `${GITHUB_MODELS_URL}/chat/completions`,
      authToken: this.token,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = this.resolveModel(request.model);
    const messages = this.formatMessages(request.messages, request.systemPrompt);
    const endpoint = await this.resolveEndpoint(model);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({
        model,
        messages,
        ...this.buildTokenLimit(model, request.maxTokens),
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
    const endpoint = await this.resolveEndpoint(model);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({
        model,
        messages,
        ...this.buildTokenLimit(model, request.maxTokens),
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
    // Try Copilot token exchange first (supports Claude)
    try {
      const res = await fetch(COPILOT_TOKEN_URL, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/json' },
      });
      if (res.ok) return true;
    } catch { /* fall through */ }
    // Fall back to GitHub Models API check
    try {
      const res = await fetch(`${GITHUB_MODELS_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static getAuthInstructions(): string {
    return `GitHub Copilot Authentication:
For Claude models: Use 'gh auth login' (requires Copilot Pro/Business/Enterprise subscription).
For other models: Set GITHUB_TOKEN to a fine-grained PAT with 'models:read' permission.`;
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
