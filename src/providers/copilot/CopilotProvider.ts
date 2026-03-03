/**
 * GitHub Copilot Provider
 * 
 * Uses GitHub Copilot CLI with gh auth
 * https://github.com/features/copilot
 */

import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, Message, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';
import { execa } from 'execa';

export interface CopilotConfig {
  model?: string;
}

export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot';
  readonly defaultModel = 'claude-sonnet-4-6';

  private model: string;

  constructor(config: CopilotConfig = {}) {
    this.model = config.model || this.defaultModel;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model || this.model;
    
    const messages = this.formatMessages(request.messages, request.systemPrompt);

    try {
      // Use GitHub Copilot CLI
      const { stdout, stderr, exitCode } = await execa('gh', ['copilot', 'chat', '-m', model], {
        input: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
        timeout: request.maxTokens ? request.maxTokens * 10 : 120000,
        reject: false,
      });

      if (exitCode !== 0) {
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
      const child = execa('gh', ['copilot', 'chat', '-m', model, '--json'], {
        input: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
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
   * Check if Copilot CLI is authenticated
   */
  static async isAuthenticated(): Promise<boolean> {
    try {
      const { exitCode } = await execa('gh', ['auth', 'status'], {
        reject: false,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if Copilot CLI is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await execa('gh', ['--version'], {
        reject: false,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}

/**
 * Factory function to create Copilot provider
 */
export function createCopilotProvider(model?: string): CopilotProvider | null {
  // Check if gh CLI is available
  if (!CopilotProvider.isAvailable()) {
    logger.warn('GitHub CLI (gh) not found. Install from https://cli.github.com');
    return null;
  }

  // Check if authenticated
  if (!CopilotProvider.isAuthenticated()) {
    logger.warn('GitHub CLI not authenticated. Run: gh auth login');
    return null;
  }

  return new CopilotProvider({ model });
}
