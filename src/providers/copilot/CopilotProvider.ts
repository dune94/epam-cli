/**
 * GitHub Copilot Provider
 * 
 * Uses GitHub Copilot CLI with OAuth device flow or fine-grained PAT
 * https://github.com/features/copilot
 * 
 * Authentication (in order of priority):
 * 1. COPILOT_GITHUB_TOKEN env var (fine-grained PAT with github_pat_)
 * 2. GH_TOKEN env var (OAuth token gho_)
 * 3. GITHUB_TOKEN env var (any supported token)
 * 4. GitHub CLI (gh) if authenticated
 * 5. Device flow authentication (interactive)
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';
import { execa } from 'execa';

export interface CopilotConfig {
  model?: string;
  token?: string;
}

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'claude-sonnet-4-6';

  private model: string;
  private token?: string;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
    this.token = config.token;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model || this.model;
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      // Use GitHub Copilot CLI
      const env: Record<string, string> = { ...process.env };
      
      // Set token if provided
      if (this.token) {
        env.COPILOT_GITHUB_TOKEN = this.token;
      }

      const { stdout, stderr, exitCode } = await execa('copilot', ['chat', '-m', model], {
        input: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
        env,
        timeout: request.maxTokens ? request.maxTokens * 10 : 120000,
        reject: false,
      });

      if (exitCode !== 0) {
        // Check for auth error
        if (stderr.includes('authentication') || stderr.includes('login')) {
          throw new Error('Copilot not authenticated. Run: copilot login or set COPILOT_GITHUB_TOKEN');
        }
        throw new Error(`Copilot CLI error: ${stderr || 'Unknown error'}`);
      }

      const content: ContentPart[] = [
        { type: 'text', text: stdout || '(no response)' }
      ];

      return {
        content,
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0, // Copilot CLI doesn't expose token counts
          outputTokens: 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'CopilotProvider complete failed');
      throw err;
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = request.model || this.model;
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      // Use GitHub Copilot CLI with streaming
      const env: Record<string, string> = { ...process.env };
      
      if (this.token) {
        env.COPILOT_GITHUB_TOKEN = this.token;
      }

      const child = execa('copilot', ['chat', '-m', model, '--json'], {
        input: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
        env,
        timeout: request.maxTokens ? request.maxTokens * 10 : 120000,
        reject: false,
      });

      let accumulatedText = '';

      if (child.stdout) {
        for await (const chunk of child.stdout) {
          const text = chunk.toString();
          accumulatedText += text;
          handler({ type: 'text_delta', text });
        }
      }

      const result = await child;

      if (result.exitCode !== 0) {
        throw new Error(`Copilot CLI error: ${result.stderr || 'Unknown error'}`);
      }

      const content: ContentPart[] = [
        { type: 'text', text: accumulatedText }
      ];

      return {
        content,
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      };

    } catch (err) {
      logger.error({ error: (err as Error).message }, 'CopilotProvider stream failed');
      throw err;
    }
  }

  /**
   * Format messages for Copilot CLI
   */
  private formatMessages(messages: Message[], systemPrompt?: string): string[] {
    const formatted: string[] = [];

    // Add system prompt as first message
    if (systemPrompt) {
      formatted.push(`System: ${systemPrompt}`);
    }

    // Format conversation messages
    for (const msg of messages) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      formatted.push(`${role}: ${content}`);
    }

    return formatted;
  }

  /**
   * Check if Copilot CLI is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await execa('copilot', ['--version'], {
        reject: false,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if authenticated (via env var or CLI)
   */
  static async isAuthenticated(): Promise<boolean> {
    // Check for environment variables first
    if (process.env.COPILOT_GITHUB_TOKEN || 
        process.env.GH_TOKEN || 
        process.env.GITHUB_TOKEN) {
      const token = process.env.COPILOT_GITHUB_TOKEN || 
                   process.env.GH_TOKEN || 
                   process.env.GITHUB_TOKEN;
      
      // Validate token type (must be gho_, github_pat_, or ghu_)
      if (token?.startsWith('gho_') || 
          token?.startsWith('github_pat_') || 
          token?.startsWith('ghu_')) {
        return true;
      }
    }

    // Try copilot CLI status
    try {
      const { exitCode } = await execa('copilot', ['status'], {
        reject: false,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get authentication instructions
   */
  static getAuthInstructions(): string {
    return `GitHub Copilot Authentication:

1. **Fine-grained PAT (Recommended for CI/CD):**
   - Create at: https://github.com/settings/tokens
   - Select "Fine-grained token"
   - Permissions: Copilot Requests (Read & Write)
   - Set as: COPILOT_GITHUB_TOKEN=github_pat_xxx

2. **OAuth Device Flow (Interactive):**
   - Run: copilot login
   - Follow browser instructions

3. **GitHub CLI (Fallback):**
   - Install: https://cli.github.com
   - Run: gh auth login
   - Ensure Copilot access is granted

Note: Classic PAT tokens (ghp_) are NOT supported.
Use fine-grained PAT (github_pat_) or OAuth (gho_) instead.`;
  }
}

/**
 * Factory function to create Copilot provider
 */
export function createCopilotProvider(model?: string, token?: string): CopilotProvider | null {
  // Check if copilot CLI is available
  if (!CopilotProvider.isAvailable()) {
    logger.warn('GitHub Copilot CLI not found. Install: npm install -g @github/copilot');
    return null;
  }

  // Check for token in config or env
  const envToken = process.env.COPILOT_GITHUB_TOKEN || 
                  process.env.GH_TOKEN || 
                  process.env.GITHUB_TOKEN;
  
  const effectiveToken = token || envToken;

  // Validate token type if provided
  if (effectiveToken) {
    if (!effectiveToken.startsWith('gho_') && 
        !effectiveToken.startsWith('github_pat_') && 
        !effectiveToken.startsWith('ghu_')) {
      logger.warn('Invalid token type. Must be gho_, github_pat_, or ghu_ (not ghp_)');
      logger.info(CopilotProvider.getAuthInstructions());
      return null;
    }
  }

  // Check if authenticated
  if (!CopilotProvider.isAuthenticated()) {
    logger.warn('Copilot not authenticated');
    logger.info(CopilotProvider.getAuthInstructions());
    return null;
  }

  return new CopilotProvider({ model, token: effectiveToken });
}
