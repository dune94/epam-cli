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
import { mkdtempSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly defaultModel = 'gpt-5-codex';

  constructor(
    private model?: string
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const prompt = this.extractPrompt(request);
    const responseText = await this.runCodex(prompt, request.maxTokens);
    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const prompt = this.extractPrompt(request);
    const responseText = await this.runCodex(prompt, request.maxTokens);

    // Stream the captured response word by word for a natural feel
    const words = responseText.split(' ');
    for (const word of words) {
      handler({ type: 'text_delta', text: word + ' ' });
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  private extractPrompt(request: ProviderRequest): string {
    const lastMessage = request.messages.filter(m => m.role === 'user').pop();
    if (!lastMessage) throw new Error('No user message found');
    return typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);
  }

  private async runCodex(prompt: string, maxTokens?: number): Promise<string> {
    const outFile = join(mkdtempSync(join(tmpdir(), 'epam-codex-')), 'response.txt');

    // Use a generous fixed timeout — codex exec can be slow for complex tasks.
    // maxTokens is a token count, not a time; don't use it for the timeout.
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    // Show elapsed timer so the user knows Codex is working
    const start = Date.now();
    const timer = setInterval(() => {
      const s = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(`\r\x1b[2m⟳ Codex thinking... ${s}s\x1b[0m`);
    }, 1000);
    process.stderr.write('\x1b[2m⟳ Codex thinking...\x1b[0m');

    const args: string[] = [
      'exec',
      '--skip-git-repo-check',
      // Bypass approval prompts — otherwise codex hangs silently waiting for
      // stdin input that never comes (stdio is piped, not a TTY).
      '--dangerously-bypass-approvals-and-sandbox',
      '-o', outFile,
    ];

    // Pass model if specified (e.g. gpt-5-codex, o3, o4-mini)
    if (this.model) {
      args.push('--model', this.model);
    }

    args.push(prompt);

    try {
      const { exitCode, stderr } = await execa('codex', args, {
        timeout: TIMEOUT_MS,
        reject: false,
        stdio: 'pipe',
        env: { ...process.env },
      });

      if (exitCode !== 0) {
        throw new Error(`Codex CLI error: ${stderr || 'Unknown error'}`);
      }

      try {
        return readFileSync(outFile, 'utf-8').trim() || '(no response)';
      } catch {
        return '(no response)';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'CodexProvider runCodex failed');
      throw err;
    } finally {
      clearInterval(timer);
      process.stderr.write('\r\x1b[2K');  // clear the thinking line
      try { unlinkSync(outFile); } catch { /* best-effort cleanup */ }
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
