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
import { EventEmitter } from 'events';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler, ContentPart } from '../types.js';
import { logger } from '../../utils/logger.js';

export class CodexProvider implements LLMProvider {
  readonly name = 'codex';
  readonly defaultModel = 'gpt-5-codex';

  /** Returns true if the model name is a codex-native model (gpt/o-series). */
  static isCodexModel(model: string): boolean {
    return /^(gpt-|o[0-9]|codex-)/.test(model);
  }

  private interruptBus?: EventEmitter;
  // Track the active codex process so we can kill it before starting a new turn.
  private activeProc?: ReturnType<typeof execa>;

  /** Kill any still-running codex process from a previous turn. */
  private killActiveProc(): void {
    if (!this.activeProc) return;
    const p = this.activeProc;
    this.activeProc = undefined;
    try { process.kill(-(p.pid!), 'SIGKILL'); } catch { /* already gone */ }
    try { p.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Called by Repl to wire up Ctrl+C → abort running codex turn. */
  setInterruptBus(bus: EventEmitter): void {
    this.interruptBus = bus;
  }

  constructor(
    private model?: string
  ) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(request);
    const responseText = await this.runCodex(prompt, { returnFirstAgentMessage: false });
    const content: ContentPart[] = [{ type: 'text', text: responseText }];
    return { content, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(request);
    const responseText = await this.runCodex(prompt, { returnFirstAgentMessage: true });

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
    const sections: string[] = [];
    if (request.systemPrompt?.trim()) {
      sections.push(`System instructions:\n${request.systemPrompt.trim()}`);
      sections.push('');
    }

    const messages = request.messages;
    if (messages.length <= 1) {
      const msg = messages[0];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      sections.push(content);
      return sections.join('\n');
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
    sections.push(lines.join('\n'));
    return sections.join('\n');
  }

  /**
   * Pretty-print a codex JSON event to stderr.
   * Shows tool calls (command start/finish) as they happen so long tasks feel alive.
   * Clears the spinner line first; the spinner timer will redraw on next tick.
   */
  private renderCodexEvent(event: { type: string; item?: Record<string, unknown> }): void {
    const item = event.item;
    if (!item) return;

    if (event.type === 'item.started' && item['type'] === 'command_execution') {
      // Strip the /bin/bash -lc "..." wrapper to show the actual command.
      const raw = String(item['command'] ?? '');
      const inner = raw.replace(/^\/bin\/bash\s+-lc\s+"([\s\S]*)"$/, '$1')
                       .replace(/^\/bin\/bash\s+-lc\s+'([\s\S]*)'$/, '$1')
                       .replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
      const display = inner.length > 100 ? inner.slice(0, 97) + '…' : inner;
      process.stderr.write(`\r\x1b[2K\x1b[36m⚙\x1b[0m  \x1b[2m${display}\x1b[0m\n`);
    }

    if (event.type === 'item.completed' && item['type'] === 'command_execution') {
      const code = item['exit_code'];
      const ok = code === 0;
      const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const out = String(item['aggregated_output'] ?? '').split('\n')[0].trim();
      const preview = out.length > 80 ? out.slice(0, 77) + '…' : out;
      process.stderr.write(`\r\x1b[2K   ${mark} \x1b[2m${preview || `exit ${code}`}\x1b[0m\n`);
    }
  }

  /**
   * Run codex and return after the FIRST agent_message event, or when
   * turn.completed fires (whichever comes first).
   *
   * - Fast path: agent_message fires in 2-3s → return after 3s silence
   * - Slow path: codex goes straight to tool execution → wait for turn.completed
   * - Hard cap: 60s timeout returns a descriptive message
   * - SIGINT: Ctrl+C kills codex and unblocks the REPL immediately
   */
  private async runCodex(
    prompt: string,
    options: { returnFirstAgentMessage: boolean },
  ): Promise<string> {
    // Kill any codex process left over from a previous turn before starting a new one.
    this.killActiveProc();

    const args: string[] = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--ephemeral',
      '--json',
    ];

    if (this.model && CodexProvider.isCodexModel(this.model)) args.push('--model', this.model);
    args.push(prompt);

    const start = Date.now();
    process.stderr.write('\x1b[2m⟳ Codex thinking...\x1b[0m');
    const spinTimer = setInterval(() => {
      const s = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(`\r\x1b[2m⟳ Codex thinking... ${s}s\x1b[0m`);
    }, 1000);
    spinTimer.unref();

    return new Promise((resolve, reject) => {
      let buffer = '';
      let resolved = false;
      let firstAgentMessage = '';
      let lastAgentMessage = '';
      let agentMessageTimer: ReturnType<typeof setTimeout> | null = null;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;

      const killGroup = () => {
        try { process.kill(-(proc.pid!), 'SIGKILL'); } catch { /* already gone */ }
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      };

      const finish = (text: string) => {
        if (resolved) return;
        resolved = true;
        clearInterval(spinTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
        if (agentMessageTimer) clearTimeout(agentMessageTimer);
        process.removeListener('SIGINT', sigintHandler);
        this.interruptBus?.removeListener('interrupt', sigintHandler);
        process.stderr.write('\r\x1b[2K');
        this.activeProc = undefined;
        killGroup();
        resolve(text.trim() || '(no response)');
      };

      // Ctrl+C: listen on both process SIGINT (raw terminal) and the REPL's sigintBus
      // (readline intercepts SIGINT in interactive mode, so process.once may not fire)
      const sigintHandler = () => finish('(cancelled)');
      process.once('SIGINT', sigintHandler);
      this.interruptBus?.once('interrupt', sigintHandler);

      const proc = execa('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: true,
      });
      this.activeProc = proc;
      proc.catch(() => {});

      let stdoutBuf = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Pretty-print tool activity so long tasks feel alive.
            this.renderCodexEvent(event);

            if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
              const text = event.item.text ?? '';
              if (text.trim()) {
                firstAgentMessage = text;
                lastAgentMessage = text;
                if (options.returnFirstAgentMessage) {
                  // Return 3s after last agent_message if codex goes quiet
                  // (about to start tool execution — we have the conversational reply)
                  if (agentMessageTimer) clearTimeout(agentMessageTimer);
                  agentMessageTimer = setTimeout(() => finish(firstAgentMessage), 3000);
                  agentMessageTimer.unref();
                }
              }
            }

            // Return on turn.completed — covers cases where codex goes straight
            // to tool execution with no agent_message before working.
            if (event.type === 'turn.completed') {
              finish(lastAgentMessage || firstAgentMessage || '(task complete — check the files)');
            }
          } catch { /* skip non-JSON lines */ }
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          if (code !== 0) {
            // Parse any error events from stdout
            const errEvent = stdoutBuf.match(/"type":"error","message":"([^"]+)"/);
            const errMsg = errEvent ? errEvent[1] : `codex exited with code ${code}`;
            process.stderr.write(`\r\x1b[2K\x1b[33m⚠ ${errMsg}\x1b[0m\n`);
          }
          finish(firstAgentMessage);
        }
      });

      proc.on('error', (err: Error) => {
        if (!resolved) {
          clearInterval(spinTimer);
          if (safetyTimer) clearTimeout(safetyTimer);
          process.removeListener('SIGINT', sigintHandler);
          this.interruptBus?.removeListener('interrupt', sigintHandler);
          process.stderr.write('\r\x1b[2K');
          reject(err);
        }
      });

      // Hard cap: warn at 45s, give up at 20 minutes.
      // Do NOT .unref() — needed to keep Node alive and prevent orphaned codex processes.
      safetyTimer = setTimeout(() => {
        process.stderr.write('\r\x1b[2K\x1b[33m⚠ Codex still working (complex task)... Ctrl+C to cancel\x1b[0m\n');
        // Reset spinner so it stays visible
        const s = ((Date.now() - start) / 1000).toFixed(0);
        process.stderr.write(`\x1b[2m⟳ Codex thinking... ${s}s\x1b[0m`);
        // Hard cap at 20 minutes total
        safetyTimer = setTimeout(() => {
          finish(firstAgentMessage || '⚠ Codex task timed out after 20 minutes.');
        }, (20 * 60 - 45) * 1000);
      }, 45 * 1000);
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
