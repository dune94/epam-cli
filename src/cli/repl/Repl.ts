import * as readline from 'readline';
import chalk from 'chalk';
import type { LLMProvider, Message } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import type { ResolvedConfig, LLMChainSlot } from '../../config/types.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSystemPrompt } from '../../context/ContextBuilder.js';
import { createSession, createTurn, appendTurn, loadSession } from '../../context/SessionStore.js';
import { compressHistory } from '../../context/MemoryCompressor.js';
import { formatCost, calculateCost } from '../../billing/pricing.js';
import { BudgetGuard } from '../../billing/BudgetGuard.js';
import type { BudgetCheckResult } from '../../billing/BudgetGuard.js';
import { StreamWriter } from '../output/StreamWriter.js';
import { Renderer } from './Renderer.js';
import { parseInput, handleSlashCommand } from './InputHandler.js';
import type { SlashCommandContext } from './SlashCommands.js';
import type { ProviderChain } from '../../providers/ProviderChain.js';

interface ReplOptions {
  provider: LLMProvider;
  tools: Tool[];
  config: ResolvedConfig;
  version: string;
  /** Optional: chain instance, present when failover is configured. */
  providerChain?: ProviderChain;
}

export class Repl {
  private messages: Message[] = [];
  private currentModel: string;
  private session = createSession(null, '', '');
  private writer = new StreamWriter();
  private renderer = new Renderer();
  private running = false;
  private budgetGuard: BudgetGuard;

  constructor(private options: ReplOptions) {
    this.currentModel = options.config.llmChain[0]?.model ?? options.config.model;
    this.budgetGuard = new BudgetGuard(options.config.budgetGuardrails, this.currentModel);
  }

  async start(): Promise<void> {
    const { config, provider, version } = this.options;

    // Register failover notification handler if chain is present
    if (this.options.providerChain) {
      (this.options.providerChain as unknown as { options: { onFailover?: (e: unknown) => void } })
        .options.onFailover = (event: unknown) => {
        const e = event as { fromSlot: { provider: string; model: string }; toSlot: { provider: string; model: string }; reason: string };
        process.stderr.write(
          chalk.yellow(`\n⚠  Failover: ${e.fromSlot.provider}/${e.fromSlot.model}`) +
          chalk.dim(` → ${e.reason}`) +
          chalk.green(` → switching to ${e.toSlot.provider}/${e.toSlot.model}\n`)
        );
        this.currentModel = e.toSlot.model;
        this.budgetGuard.setModel(e.toSlot.model);
      };
    }

    this.session = createSession(config.projectRoot, this.currentModel, config.provider);

    const systemPrompt = await buildSystemPrompt({
      contextFilePath: config.contextFile,
      systemPromptFile: config.systemPromptFile,
      projectRoot: config.projectRoot,
    });

    this.renderer.renderWelcome(version, config.provider, this.currentModel, config.projectRoot);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.running = true;

    const prompt = () => {
      rl.question(
        this.renderer.renderPrompt(config.provider, this.currentModel),
        async input => {
          if (!this.running) return;

          const parsed = parseInput(input);

          if (parsed.type === 'empty') {
            prompt();
            return;
          }

          if (parsed.type === 'slash_command') {
            const ctx = this.buildSlashContext(config, systemPrompt);
            const keepRunning = await handleSlashCommand(parsed, ctx);
            if (keepRunning) {
              prompt();
            } else {
              this.running = false;
              rl.close();
            }
            return;
          }

          // Regular message — run agent
          const userMessage = parsed.message!;

          try {
            process.stdout.write('\n');

            const runner = new AgentRunner({
              userMessage,
              systemPrompt,
              provider,
              model: this.currentModel,
              tools: this.options.tools,
              maxIterations: config.maxIterations,
              history: this.messages,
              autoCompressAt: config.autoCompressAt,
              maxOutputTokens: config.maxOutputTokens,
              dangerousSkipApproval: config.tools.dangerousSkipApproval,
              budgetGuard: this.budgetGuard,
              onTextDelta: delta => this.writer.write(delta),
              onToolCall: (name, inp) => this.writer.writeToolCall(name, inp),
              onToolResult: (name, result, isError) =>
                this.writer.writeToolResult(name, result, isError),
              onBudgetCheck: (check) => this.handleBudgetCheck(check),
            });

            const result = await runner.run();
            this.writer.newline();

            // Store full message array (includes history + this turn's exchanges)
            this.messages = result.messages;

            // Show per-turn usage + running session cost
            this.renderer.renderUsage(
              result.usage.inputTokens,
              result.usage.outputTokens,
              this.budgetGuard.sessionCost,
            );

            const turn = createTurn(userMessage, result.finalResponse, result.toolCallCount, {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            });
            await appendTurn(this.session, turn);
          } catch (err) {
            this.renderer.renderError((err as Error).message);
          }

          this.writer.reset();
          prompt();
        }
      );
    };

    rl.on('SIGINT', () => {
      console.log(chalk.dim('\nInterrupted. Type /exit to quit.'));
      prompt();
    });

    rl.on('close', () => {
      this.running = false;
    });

    prompt();

    await new Promise<void>(resolve => {
      const checkRunning = setInterval(() => {
        if (!this.running) {
          clearInterval(checkRunning);
          resolve();
        }
      }, 100);
    });
  }

  private handleBudgetCheck(check: BudgetCheckResult): void {
    if (check.action === 'warning') {
      process.stderr.write(
        chalk.yellow.bold('\n  ⚠  Budget Warning: ') +
        chalk.yellow(check.message) + '\n'
      );
    } else if (check.action === 'downgrade') {
      // Trigger failover to next cheaper slot in the chain
      const chain = this.options.providerChain;
      if (chain) {
        const slots = chain.getSlots();
        const activeIdx = slots.indexOf(chain.activeSlot);
        if (activeIdx < slots.length - 1) {
          const nextSlot = slots[activeIdx + 1];
          chain.getHealth().markUnavailable(chain.activeSlot, 'budget limit');
          this.currentModel = nextSlot.model;
          this.budgetGuard.setModel(nextSlot.model);
          process.stderr.write(
            chalk.red.bold('\n  ⛔ Budget Hard Limit: ') +
            chalk.red(check.message) + '\n' +
            chalk.green(`     Downgraded to ${nextSlot.provider}/${nextSlot.model}\n`)
          );
        } else {
          process.stderr.write(
            chalk.red.bold('\n  ⛔ Budget Hard Limit: ') +
            chalk.red(check.message) +
            chalk.dim(' (no cheaper model available in chain)\n')
          );
        }
      } else {
        process.stderr.write(
          chalk.red.bold('\n  ⛔ Budget Hard Limit: ') +
          chalk.red(check.message) +
          chalk.dim(' (no failover chain — cannot downgrade)\n')
        );
      }
    } else if (check.action === 'pause') {
      process.stderr.write(
        chalk.red.bold('\n  ⛔ Budget Hard Limit: ') +
        chalk.red(check.message) + '\n'
      );
    }
  }

  private buildSlashContext(config: ResolvedConfig, _systemPrompt: string): SlashCommandContext {
    return {
      config,
      currentModel: this.currentModel,
      sessionTurnCount: this.session.turns.length,
      messages: this.messages,
      tokenCount: this.messages.reduce((sum, m) => {
        const text =
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(text.length / 4);
      }, 0),
      contextFilePath: config.contextFile,
      totalInputTokens: this.budgetGuard.inputTokens,
      totalOutputTokens: this.budgetGuard.outputTokens,
      budgetGuard: this.budgetGuard,

      onModelChange: model => {
        this.currentModel = model;
        this.budgetGuard.setModel(model);
      },

      onClear: () => {
        this.messages = [];
      },

      onCompact: async () => {
        this.messages = await compressHistory(
          this.messages,
          this.options.provider,
          this.currentModel
        );
      },

      // Remove last user+assistant pair
      onRewind: () => {
        // Walk back from end removing the last assistant then last user message
        let removed = 0;
        while (this.messages.length > 0 && removed < 2) {
          const last = this.messages[this.messages.length - 1];
          if (last.role === 'assistant' || last.role === 'user') {
            this.messages.pop();
            removed++;
          } else {
            break;
          }
        }
        // Also remove any trailing tool messages
        while (
          this.messages.length > 0 &&
          this.messages[this.messages.length - 1].role === 'tool'
        ) {
          this.messages.pop();
        }
      },

      // Load a past session's messages into current context
      onResume: async (sessionId: string) => {
        const loaded = await loadSession(sessionId, config.projectRoot);
        if (!loaded) return { success: false, turnCount: 0 };

        // Reconstruct messages from stored turns
        const reconstructed: Message[] = [];
        for (const turn of loaded.turns) {
          reconstructed.push({ role: 'user', content: turn.userMessage });
          reconstructed.push({ role: 'assistant', content: turn.assistantResponse });
        }

        this.messages = reconstructed;

        // Carry forward token counts from resumed session into budget guard
        const resumedInput = loaded.turns.reduce((s, t) => s + t.usage.inputTokens, 0);
        const resumedOutput = loaded.turns.reduce((s, t) => s + t.usage.outputTokens, 0);
        this.budgetGuard.loadTokens(resumedInput, resumedOutput);

        return { success: true, turnCount: loaded.turns.length };
      },

      providerChain: this.options.providerChain,

      onChainUpdate: async (slots: LLMChainSlot[]) => {
        const chain = this.options.providerChain;
        if (!chain) return;
        // Re-initialize the chain with new slots is not trivially mutable —
        // update the config so /chain status reflects new priority, and note it will take
        // effect on next session (ProviderChain is immutable after construction).
        // For live switching: update activeSlotIndex by resetting health of new slots.
        chain.getHealth().resetAll();
        // Update the config reference so /chain shows the right order
        config.llmChain = slots;
        this.currentModel = slots[0]?.model ?? this.currentModel;
      },
    };
  }
}
