/**
 * Codex Provider
 *
 * LLM Provider implementation for OpenAI Codex CLI.
 * Uses Codex CLI binary for authentication and API calls.
 *
 * Key design: uses `codex exec --json` and returns after the FIRST
 * agent message turn, rather than waiting for the full agentic loop.
 * This matches the native `codex` CLI interactive UX (<5s response).
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
    const prompt = this.extractPrompt(request);
    const isFollowUp = request.messages.filter(m => m.role === 'user').length > 1;
    const responseText = await this.runCodex(prompt, isFollowUp);
    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const prompt = this.extractPrompt(request);
    const isFollowUp = request.messages.filter(m => m.role === 'user').length > 1;
    const responseText = await this.runCodex(prompt, isFollowUp);

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

  /**
   * Run codex and return after the FIRST agent message turn.
   *
   * Uses `--json` to stream structured events. As soon as the first
   * `turn.completed` event arrives (with a non-empty agent_message),
   * we kill the process and return. This gives <5s responses even for
   * complex prompts — matching the native codex interactive CLI UX.
   *
   * For follow-up messages (conversation history > 1 user turn),
   * we use `codex exec resume --last` to continue the previous session.
   */
  private async runCodex(prompt: string, isFollowUp = false): Promise<string> {
    const args: string[] = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
    ];

    if (this.model) args.push('--model', this.model);

    if (isFollowUp) {
      // Continue the most recent codex session
      args.push('resume', '--last', prompt);
    } else {
      args.push(prompt);
    }

    // Show elapsed timer so the user knows Codex is working
    const start = Date.now();
    process.stderr.write('\x1b[2m⟳ Codex thinking...\x1b[0m');
    const timer = setInterval(() => {
      const s = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(`\r\x1b[2m⟳ Codex thinking... ${s}s\x1b[0m`);
    }, 1000);

    return new Promise((resolve, reject) => {
      let firstMessage = '';
      let buffer = '';
      let resolved = false;

      const finish = (text: string) => {
        if (resolved) return;
        resolved = true;
        clearInterval(timer);
        process.stderr.write('\r\x1b[2K');
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
        resolve(text.trim() || '(no response)');
      };

      const proc = execa('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            // Accumulate agent message text within a turn
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              firstMessage = event.item.text ?? '';
            }
            // Return as soon as first turn completes with a message
            if (event.type === 'turn.completed' && firstMessage) {
              finish(firstMessage);
            }
          } catch { /* skip non-JSON lines (header output etc.) */ }
        }
      });

      proc.on('exit', () => {
        if (!resolved) finish(firstMessage);
      });

      proc.on('error', (err: Error) => {
        if (!resolved) {
          clearInterval(timer);
          process.stderr.write('\r\x1b[2K');
          reject(err);
        }
      });

      // Safety net — 5 minutes absolute max
      setTimeout(() => finish(firstMessage || '(timeout — try a simpler prompt)'), 5 * 60 * 1000);
    });
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

      const { exitCode } = await execa('codex', [], {
        stdio: 'inherit',
        timeout: 300000,
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
