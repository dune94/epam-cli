/**
 * GitHub Copilot Provider
 *
 * Supports two API backends:
 * 1. GitHub Models API (models.github.ai) — for GPT, Llama, and other GitHub-hosted models
 * 2. Copilot Chat API (api.githubcopilot.com) — for Copilot subscription models (Claude, etc.)
 *
 * Authentication (in order of priority):
 * 1. COPILOT_GITHUB_TOKEN env var
 * 2. GH_TOKEN env var
 * 3. GITHUB_TOKEN env var
 * 4. OAuth token stored by Copilot CLI (~/.copilot/config.json or system keychain)
 * 5. GITHUB_PERSONAL_ACCESS_TOKEN env var
 * 6. `gh auth token` (GitHub CLI fallback)
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message } from '../types.js';
import { logger } from '../../utils/logger.js';

const GITHUB_MODELS_URL = 'https://models.github.ai/inference';
const COPILOT_API_URL = 'https://api.githubcopilot.com';
const COPILOT_KEYCHAIN_SERVICE = 'copilot-cli';

const COPILOT_MODELS = new Set([
  'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
]);

const COPILOT_MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-haiku-4-5': 'claude-haiku-4.5',
};

const COPILOT_CHAT_HEADERS = {
  'Content-Type': 'application/json',
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.96.0',
  'Editor-Plugin-Version': 'copilot-chat/0.24.0',
  'User-Agent': 'GitHubCopilotChat/0.24.0',
} as const;

// Reasoning models use max_completion_tokens instead of max_tokens
const REASONING_MODELS = new Set(['openai/o3-mini', 'openai/o4-mini', 'openai/gpt-5', 'openai/gpt-5-mini']);

export interface CopilotConfig {
  model?: string;
  token?: string;
}

type CopilotConfigFile = {
  oauth_token?: unknown;
  last_logged_in_user?: {
    login?: unknown;
  };
};

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'openai/gpt-4o';

  static readonly SUPPORTED_MODELS = [
    'claude-opus-4.6',
    'claude-sonnet-4.6',
    'claude-haiku-4.5',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1-nano',
    'openai/gpt-5',
    'openai/gpt-5-mini',
    'openai/o3-mini',
    'openai/o4-mini',
    'meta/llama-4-scout-17b-16e-instruct',
    'meta/llama-3.3-70b-instruct',
    'deepseek/DeepSeek-V3-0324',
    'deepseek/deepseek-r1',
    'xai/grok-3',
    'xai/grok-3-mini',
  ] as const;

  private model: string;
  private token: string;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
    this.token = config.token || '';
  }

  private resolveModel(requested?: string): string {
    const model = requested || this.model || this.defaultModel;
    return COPILOT_MODEL_ALIASES[model] || model;
  }

  private isCopilotModel(model: string): boolean {
    return COPILOT_MODELS.has(model);
  }

  private static readCopilotConfig(): { oauthToken: string | null; lastLogin: string | null } {
    try {
      const { readFileSync } = require('fs');
      const { join } = require('path');
      const copilotHome = process.env.COPILOT_HOME || join(process.env.HOME || '', '.copilot');
      const configPath = join(copilotHome, 'config.json');
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as CopilotConfigFile;

      return {
        oauthToken: typeof parsed.oauth_token === 'string' && parsed.oauth_token.trim()
          ? parsed.oauth_token.trim()
          : null,
        lastLogin: typeof parsed.last_logged_in_user?.login === 'string' && parsed.last_logged_in_user.login.trim()
          ? parsed.last_logged_in_user.login.trim()
          : null,
      };
    } catch {
      return { oauthToken: null, lastLogin: null };
    }
  }

  private static async resolveStoredCopilotToken(): Promise<string | null> {
    const config = CopilotProvider.readCopilotConfig();
    if (config.oauthToken) return config.oauthToken;

    try {
      const keytarModule = await import('keytar');
      const keytar = keytarModule.default ?? keytarModule;
      const credentials = await keytar.findCredentials(COPILOT_KEYCHAIN_SERVICE);

      if (config.lastLogin) {
        const matchingCredential = credentials.find(credential =>
          credential.account === config.lastLogin && credential.password.trim().length > 0
        );
        if (matchingCredential) return matchingCredential.password.trim();
      }

      const firstCredential = credentials.find(credential => credential.password.trim().length > 0);
      if (firstCredential) return firstCredential.password.trim();
    } catch {
      // Keychain support is optional in this environment.
    }

    return null;
  }

  private static resolveGhToken(): string | null {
    const explicitEnvToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN;
    if (explicitEnvToken) return explicitEnvToken;

    try {
      const { readFileSync } = require('fs');
      const { join } = require('path');
      const configDir = process.env.GH_CONFIG_DIR || join(process.env.HOME || '', '.config', 'gh');
      const hostsFile = join(configDir, 'hosts.yml');
      const content = readFileSync(hostsFile, 'utf-8');
      const match = content.match(/oauth_token:\s+(\S+)/);
      if (match?.[1]) return match[1];
    } catch {
      // gh config not available
    }

    try {
      const { execSync } = require('child_process');
      const token = execSync('gh auth token 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
        .toString().trim();
      if (token) return token;
    } catch {
      // gh not available or not logged in
    }

    return null;
  }

  static async resolveToken(): Promise<string> {
    const envToken = process.env.COPILOT_GITHUB_TOKEN ||
                     process.env.GH_TOKEN ||
                     process.env.GITHUB_TOKEN ||
                     process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (envToken) return envToken;

    const storedToken = await CopilotProvider.resolveStoredCopilotToken();
    if (storedToken) return storedToken;

    return CopilotProvider.resolveGhToken() || '';
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

  private buildTokenLimit(model: string, maxTokens?: number): Record<string, number> {
    const limit = maxTokens || 4096;
    if (REASONING_MODELS.has(model)) {
      return { max_completion_tokens: limit };
    }
    return { max_tokens: limit };
  }

  private resolveEndpoint(model: string): { url: string; headers: Record<string, string> } {
    if (this.isCopilotModel(model)) {
      return {
        url: `${COPILOT_API_URL}/chat/completions`,
        headers: {
          ...COPILOT_CHAT_HEADERS,
          'Authorization': `Bearer ${this.token}`,
        },
      };
    }

    return {
      url: `${GITHUB_MODELS_URL}/chat/completions`,
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
    const endpoint = this.resolveEndpoint(model);

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
      throw new Error(`Copilot API error: ${response.status} ${error}`);
    }

    const data = await response.json() as any;
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Copilot API returned no choices');

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
    const endpoint = this.resolveEndpoint(model);

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
      throw new Error(`Copilot API error: ${response.status} ${error}`);
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
          } catch {
            // Skip malformed SSE lines.
          }
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
    return !!(await CopilotProvider.resolveToken());
  }

  static async isAuthenticated(): Promise<boolean> {
    const token = await CopilotProvider.resolveToken();
    if (!token) return false;
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
1. Preferred: run 'copilot login' (stores an OAuth token in the Copilot CLI keychain/config).
2. Alternative: run 'gh auth login' or export COPILOT_GITHUB_TOKEN / GH_TOKEN.
3. Fine-grained PATs must include the 'Copilot Requests' permission.
4. This provider will also use ~/.copilot/config.json when Copilot CLI falls back to plaintext storage.`;
  }
}

export async function createCopilotProvider(model?: string, token?: string): Promise<CopilotProvider | null> {
  const effectiveToken = token || await CopilotProvider.resolveToken();
  if (!effectiveToken) {
    logger.debug('No GitHub token found for direct Copilot access — will try proxy if available.');
    return null;
  }
  return new CopilotProvider({ model, token: effectiveToken });
}
