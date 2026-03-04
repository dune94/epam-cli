/**
 * Codex Provider
 *
 * LLM Provider implementation for OpenAI Codex CLI.
 * Uses Codex CLI binary for authentication and API calls.
 *
 * Key design: stateless fresh invocations with history injected into the
 * prompt. We never use `resume` — killing the process mid-turn (after the
 * first agent_message) leaves the session in an incomplete state, and
 * resuming it causes codex to finish the queued tool calls before reading
 * the new message, causing a hang.
 *
 * Instead: build a "Conversation history:\n..." prefix and run a fresh
 * `codex exec --json` each time. Returns on the first `agent_message`
 * event (<5s), then SIGTERMs. No state to manage, no resume edge cases.
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
    const prompt = this.buildPrompt(request);
    const responseText = await this.runCodex(prompt);
    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(request);
    const responseText = await this.runCodex(prompt);

    // Stream the captured response word by word for a natural feel
    const words = responseText.split(' ');
    for (const word of words) {
      handler({ type: 'text_delta', text: word + ' ' });
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  /**
   * Build a single prompt string from the full message history.
   *
   * For single-turn conversations this is just the user message.
   * For multi-turn, we inject prior turns as a "Conversation history:"
   * prefix so codex has context without needing session resume.
   */
  private buildPrompt(request: ProviderRequest): string {
    const messages = request.messages;
    if (messages.length <= 1) {
      const msg = messages[0];
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }

    const lines: string[] = ['Conversation history (for context):'];
    for (const msg of messages.slice(0, -1)) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      lines.push(`${role}: ${content}`);
    }
    lines.push('');
    lines.push('Current request:');
    const last = messages[messages.length - 1];
    lines.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    return lines.join('\n');
  }

  /**
   * Run codex and return after the FIRST agent_message event.
   *
   * Uses `--json` to stream structured events. The first agent_message
   * fires within ~2-3s — before codex starts executing any shell tools.
   * We return immediately and SIGTERM the process. Next message starts
   * a completely fresh invocation with history in the prompt.
   */
  private async runCodex(prompt: string): Promise<string> {
    const args: string[] = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',  // no session files saved — avoids lock contention when killed mid-turn
      '--json',
    ];

    if (this.model) args.push('--model', this.model);
    args.push(prompt);

    // Show elapsed timer so the user knows Codex is working
    const start = Date.now();
    process.stderr.write('\x1b[2m⟳ Codex thinking...\x1b[0m');
    const timer = setInterval(() => {
      const s = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(`\r\x1b[2m⟳ Codex thinking... ${s}s\x1b[0m`);
    }, 1000);
    timer.unref();

    return new Promise((resolve, reject) => {
      let buffer = '';
      let resolved = false;

      const finish = (text: string) => {
        if (resolved) return;
        resolved = true;
        clearInterval(timer);
        clearTimeout(safetyTimer);
        process.stderr.write('\r\x1b[2K');
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        resolve(text.trim() || '(no response)');
      };

      const proc = execa('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      // execa returns a Promise — suppress the rejection from SIGKILL so it
      // doesn't become an unhandled rejection and crash the REPL process.
      proc.catch(() => {});

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            // Return on the FIRST agent_message — before tool calls execute.
            // turn.completed fires only after all shell commands in the turn
            // finish (can be 10-30s). The agent_message fires within ~2-3s.
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              const text = event.item.text ?? '';
              if (text.trim()) {
                finish(text);
              }
            }
          } catch { /* skip non-JSON lines (header output etc.) */ }
        }
      });

      proc.on('exit', () => {
        if (!resolved) finish('');
      });

      proc.on('error', (err: Error) => {
        if (!resolved) {
          clearInterval(timer);
          process.stderr.write('\r\x1b[2K');
          reject(err);
        }
      });

      // Safety net — 5 minutes absolute max.
      // .unref() so this timer doesn't prevent Node.js from exiting normally.
      const safetyTimer = setTimeout(() => finish('(timeout — try a simpler prompt)'), 5 * 60 * 1000);
      safetyTimer.unref();
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
