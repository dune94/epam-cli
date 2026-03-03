/**
 * Codex Provider
 *
 * LLM Provider implementation for OpenAI Codex CLI.
 * Uses Codex CLI binary for authentication and API calls.
 * 
 * Authentication: codex (browser sign-in with ChatGPT)
 * Chat: codex exec "prompt"
 */

import { execa } from 'execa';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly defaultModel = 'gpt-5-codex';

  constructor(
    private model?: string
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model || this.model || this.defaultModel;

    // Extract last user message
    const lastMessage = request.messages
      .filter(m => m.role === 'user')
      .pop();
    

    if (!lastMessage) {
      throw new Error('No user message found');
    }

    const prompt = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);
    

    try {
      
      // Call codex exec for non-interactive mode
      const { stdout, stderr, exitCode } = await execa('codex', ['exec', '--skip-git-repo-check'], {
        input: prompt,
        timeout: request.maxTokens ? request.maxTokens * 10 : 120000,
        reject: false,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });
      

      if (exitCode !== 0) {
        throw new Error(`Codex CLI error: ${stderr || 'Unknown error'}`);
      }

      const content: ContentPart[] = [
        { type: 'text', text: stdout || '(no response)' }
      ];

      return {
        content,
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0, // Codex CLI doesn't expose token counts
          outputTokens: 0,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'CodexProvider complete failed');
      throw err;
    }
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const model = request.model || this.model || this.defaultModel;
    
    // Extract last user message
    const lastMessage = request.messages
      .filter(m => m.role === 'user')
      .pop();

    if (!lastMessage) {
      throw new Error('No user message found');
    }

    const prompt = typeof lastMessage.content === 'string' 
      ? lastMessage.content 
      : JSON.stringify(lastMessage.content);

    try {
      // For streaming, we'll use codex with TUI mode
      // Note: Codex CLI doesn't have a true streaming API, so we simulate it
      const { stdout, stderr, exitCode } = await execa('codex', ['exec', '--skip-git-repo-check'], {
        input: prompt,
        timeout: request.maxTokens ? request.maxTokens * 10 : 120000,
        reject: false,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (exitCode !== 0) {
        throw new Error(`Codex CLI error: ${stderr || 'Unknown error'}`);
      }

      // Simulate streaming by sending chunks
      const text = stdout || '(no response)';
      const chunkSize = 10;
      
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        handler({ type: 'text_delta', text: chunk });
        // Small delay to simulate streaming
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const content: ContentPart[] = [
        { type: 'text', text }
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
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'CodexProvider stream failed');
      throw err;
    }
  }

  /**
   * Check if Codex CLI is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const { exitCode } = await execa('codex', ['--version'], {
        timeout: 5000,
        reject: false,
      });
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Authenticate with Codex CLI
   */
  static async authenticate(): Promise<boolean> {
    try {
      logger.info('Starting Codex authentication...');
      logger.info('Please complete sign-in in the Codex CLI window.');
      
      // Codex CLI will prompt for browser sign-in
      const { exitCode } = await execa('codex', [], {
        stdio: 'inherit',
        timeout: 300000, // 5 minutes for user to complete auth
        reject: false,
      });

      if (exitCode === 0) {
        logger.info('Codex authentication successful');
        return true;
      } else {
        logger.error('Codex authentication failed');
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Codex authentication failed');
      return false;
    }
  }
}

/**
 * Factory function to create Codex provider
 */
export async function createCodexProvider(model?: string): Promise<CodexProvider | null> {
  const available = await CodexProvider.isAvailable();
  
  if (!available) {
    logger.warn('Codex CLI not found. Install with: npm install -g @openai/codex');
    return null;
  }

  return new CodexProvider(model);
}
