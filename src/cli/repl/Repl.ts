import * as readline from 'readline';
import { EventEmitter } from 'events';
import chalk from 'chalk';
import prompts from 'prompts';
import type { LLMProvider, Message } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import type { ResolvedConfig, LLMChainSlot } from '../../config/types.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSessionSystemPrompt } from '../../constraints/sessionPrompt.js';
import { consumeConsultationContext } from '../../context/ContextBuilder.js';
import { createSession, createTurn, appendTurn, loadSession } from '../../context/SessionStore.js';
import { compressHistory } from '../../context/MemoryCompressor.js';
import { formatCost, calculateCost } from '../../billing/pricing.js';
import { BudgetGuard } from '../../billing/BudgetGuard.js';
import type { BudgetCheckResult } from '../../billing/BudgetGuard.js';
import { StreamWriter } from '../output/StreamWriter.js';
import { Renderer } from './Renderer.js';
import { parseInput, handleSlashCommand } from './InputHandler.js';
import { PromptZone } from './PromptZone.js';
import { RawInputBox } from './RawInputBox.js';
import type { SlashCommandContext } from './SlashCommands.js';
import type { ProviderChain } from '../../providers/ProviderChain.js';
import { ToolRunner } from '../../agent/tools/ToolRunner.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { AuditorRegistry } from '../../auditors/AuditorRegistry.js';
import type { AuditorGateDecision } from '../../auditors/types.js';
import { isRedisAvailable, listHandoffs, getSessionMeta } from '../../context/RedisSessionStore.js';

interface ReplOptions {
  provider: LLMProvider;
  tools: Tool[];
  config: ResolvedConfig;
  version: string;
  /** Optional: chain instance, present when failover is configured. */
  providerChain?: ProviderChain;
  /** Optional: auth manager for constraint loading; if omitted one is created from config.backendUrl. */
  authManager?: AuthManager;
}

export class Repl {
  private messages: Message[] = [];
  private currentProvider: string;
  private currentModel: string;
  private session = createSession(null, '', '');
  private writer = new StreamWriter();
  private renderer = new Renderer();
  private running = false;
  private budgetGuard: BudgetGuard;
  private toolRunner: ToolRunner;
  private auditorRegistry?: AuditorRegistry;
  private userEmail?: string;
  private rl?: import('readline').Interface;
  /** Fires when the user presses Ctrl+C while an agent turn is running. */
  readonly sigintBus = new EventEmitter();

  constructor(private options: ReplOptions) {
    this.currentProvider = options.config.provider;
    this.currentModel = options.config.llmChain[0]?.model ?? options.config.model;
    this.budgetGuard = new BudgetGuard(options.config.budgetGuardrails, this.currentModel);
    this.toolRunner = new ToolRunner(options.tools, options.config.tools.dangerousSkipApproval);
  }

  async start(): Promise<void> {
    const { config, provider, version } = this.options;

    // Register failover notification handler if chain is present
    if (this.options.providerChain) {
      (this.options.providerChain as unknown as { options: { onFailover?: (e: unknown) => void, onAuthenticateProvider?: (p: string) => Promise<boolean> } })
        .options.onFailover = (event: unknown) => {
        const e = event as { fromSlot: { provider: string; model: string }; toSlot: { provider: string; model: string }; reason: string };
        process.stderr.write(
          chalk.yellow(`\n⚠  Failover: ${e.fromSlot.provider}/${e.fromSlot.model}`) +
          chalk.dim(` → ${e.reason}`) +
          chalk.green(` → switching to ${e.toSlot.provider}/${e.toSlot.model}\n`)
        );
        this.currentProvider = e.toSlot.provider;
        this.currentModel = e.toSlot.model;
        this.budgetGuard.setModel(e.toSlot.model);
        
        // Show session handoff summary
        this.renderSessionHandoff(e);
      };

      // Register inline authentication handler
      (this.options.providerChain as unknown as { options: { onAuthenticateProvider?: (p: string) => Promise<boolean> } })
        .options.onAuthenticateProvider = async (provider: string) => {
        return await this.handleProviderAuth(provider);
      };
    }

    this.session = createSession(config.projectRoot, this.currentModel, config.provider);

    const authManager = this.options.authManager ?? new AuthManager(config.backendUrl);
    let systemPrompt = await buildSessionSystemPrompt(config, authManager);
    const defaultSystemPrompt = systemPrompt;

    // Resolve user identity: JWT email → env var → OS user
    const authUser = await authManager.getUser().catch(() => null);
    this.userEmail =
      authUser?.email ||
      process.env.EPAM_USER_EMAIL ||
      process.env.USER ||
      undefined;

    // Load auditor personas (no-op if .epam/auditors.json absent)
    const auditorRegistry = new AuditorRegistry(config.projectRoot ?? process.cwd());
    await auditorRegistry.load();
    this.auditorRegistry = auditorRegistry;

    this.renderer.renderWelcome(version, config.provider, this.currentModel, config.projectRoot);

    // Check for pending handoffs in Redis and show banner
    await this.showPendingHandoffsBanner();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      // terminal: false prevents readline from echoing keystrokes to stdout.
      // RawInputBox owns all TTY input in raw mode; readline echoing causes
      // a duplicate prompt line on Enter (\r triggers readline's _normalWrite
      // which writes \n, shifting the cursor before clearBoxAndEcho runs).
      terminal: false,
    });
    this.rl = rl;

    // Setup slash command autocomplete
    const { setupAutocomplete } = await import('./Autocomplete.js');
    setupAutocomplete(rl);

    // Capture welcome content to replay inside scroll region on TTY
    const hintLines = [
      chalk.dim('Type @ to query MCP sources, / for commands, or ? for shortcuts'),
      chalk.dim('MCP: @jira @confluence @drawio @all'),
    ];

    if (!process.stdout.isTTY) {
      // Non-TTY: print hints immediately as before
      hintLines.forEach(l => console.log(l));
      console.log();
    }

    this.running = true;

    const promptZone = new PromptZone(process.stdout);
    const rawInputBox = new RawInputBox(this.sigintBus);

    // Ctrl+C during agent response (non-raw mode) → abort agent
    const sigintDuringAgent = () => { this.sigintBus.emit('interrupt'); };
    process.on('SIGINT', sigintDuringAgent);

    rl.on('close', () => { this.running = false; });

    const renderZone = () => promptZone.render({
      provider: this.currentProvider,
      model: this.currentModel,
      turns: this.session.turns.length,
      sessionCost: this.budgetGuard.sessionCost,
      hardLimitAt: this.budgetGuard.limits.hardLimitAt,
    });

    // Shared system prompt ref — allows /agent switch to update live
    const systemPromptRef = {
      get value() { return systemPrompt; },
      get default() { return defaultSystemPrompt; },
      onChange: (s: string) => { systemPrompt = s; },
    };

    // Auto-resume a session if one was pre-installed by `epam-cli import`
    const autoResumeId = process.env.EPAM_AUTO_RESUME;
    if (autoResumeId) {
      delete process.env.EPAM_AUTO_RESUME;
      const ctx = this.buildSlashContext(config, systemPrompt, systemPromptRef);
      const result = await ctx.onResume(autoResumeId);
      if (result.success) {
        process.stdout.write(
          chalk.green(`✓ Resumed imported session`) +
          chalk.dim(` — ${result.turnCount} turns loaded\n\n`)
        );
      }
    }

    // ── Main REPL loop ──────────────────────────────────────────────────────
    let lastSigint = 0;
    const replPrefix = this.renderer.renderPrompt(this.currentProvider, this.currentModel);

    while (this.running) {
      renderZone();

      const result = await rawInputBox.readLine(replPrefix);

      if (result.interrupted) {
        const now = Date.now();
        if (now - lastSigint < 1500) {
          process.removeListener('SIGINT', sigintDuringAgent);
          console.log(chalk.dim('\n(exiting)'));
          this.running = false;
          rl.close();
          process.stdout.write('\x1b[2J\x1b[H'); // clear terminal
          process.exit(0);
        }
        lastSigint = now;
        process.stdout.write(chalk.dim('(interrupted — press Ctrl+C again to exit)\n'));
        continue;
      }

      const parsed = parseInput(result.line);

      if (parsed.type === 'empty') continue;

      if (parsed.type === 'slash_command') {
        const ctx = this.buildSlashContext(config, systemPrompt, systemPromptRef);
        const keepRunning = await handleSlashCommand(parsed, ctx);
        if (!keepRunning) {
          this.running = false;
          rl.close();
        }
        continue;
      }

      // ── Agent turn ────────────────────────────────────────────────────────
      const rawMessage = parsed.message!;
      rawInputBox.addHistory(rawMessage);

      let userMessage = config.projectRoot
        ? await consumeConsultationContext(rawMessage, config.projectRoot)
        : rawMessage;

      // Auto-query MCP sources based on keywords (non-blocking, never fails chat)
      try {
        if (process.env.EPAM_DEBUG === '1') {
          console.error('[MCP] Starting autoQueryMCP for:', userMessage.substring(0, 50));
        }

        const { autoQueryMCP, formatMCPResults } = await import('../../mcp/MCPAutoQuery.js');
        const mcpResults = await autoQueryMCP(userMessage);

        if (process.env.EPAM_DEBUG === '1') {
          console.error('[MCP] autoQueryMCP returned', mcpResults.length, 'results');
          if (mcpResults.length > 0) {
            console.error('[MCP] First result source:', mcpResults[0].source);
            console.error('[MCP] First result items:', mcpResults[0].items?.length || 0);
          }
        }

        if (mcpResults.length > 0) {
          const formattedResults = formatMCPResults(mcpResults);
          if (formattedResults.trim()) {
            process.stderr.write('\n' + formattedResults);
          }

          const dataLines: string[] = [];
          for (const r of mcpResults) {
            for (const item of r.items) {
              dataLines.push(`ID: ${item.id}`);
              if (item.title) dataLines.push(`Title: ${item.title}`);
              if (item.status) dataLines.push(`Status: ${item.status}`);
              if (item.url) dataLines.push(`URL: ${item.url}`);
              if (item.updated) dataLines.push(`Updated: ${item.updated}`);
              if (item.summary && item.summary !== item.title) dataLines.push(`Summary: ${item.summary}`);
            }
          }

          const extraInstruction = userMessage
            .replace(/@(jira|confluence|drawio|all)\s*([A-Z]+-\d+)?/gi, '')
            .trim();

          userMessage = [
            'The following data was already fetched from the MCP server. Present it clearly to the user. Do not attempt to fetch or search for additional data.',
            '',
            dataLines.join('\n'),
            ...(extraInstruction ? ['', `User instruction: ${extraInstruction}`] : []),
          ].join('\n');
        }
      } catch (err) {
        if (process.env.EPAM_DEBUG === '1') {
          console.error('MCP auto-query error:', (err as Error).message);
        }
      }

      this.messages.push({ role: 'user', content: userMessage });

      try {
        for (const p of [provider, this.options.providerChain]) {
          if (p && typeof (p as unknown as { setInterruptBus?: (b: EventEmitter) => void }).setInterruptBus === 'function') {
            (p as unknown as { setInterruptBus: (b: EventEmitter) => void }).setInterruptBus(this.sigintBus);
          }
        }

        let gateDecision: AuditorGateDecision | undefined;

        const runner = new AgentRunner({
          userMessage,
          systemPrompt,
          provider,
          model: this.currentModel,
          tools: this.options.tools,
          toolRunner: this.toolRunner,
          maxIterations: config.maxIterations,
          history: this.messages.slice(0, -1),
          autoCompressAt: config.autoCompressAt,
          maxOutputTokens: config.maxOutputTokens,
          dangerousSkipApproval: config.tools.dangerousSkipApproval,
          budgetGuard: this.budgetGuard,
          auditors: auditorRegistry.getEnabledRunners(provider, this.options.tools ?? []),
          onAuditorGate: (decision) => {
            gateDecision = decision;
            this.renderAuditorFindings(decision);
          },
          onTextDelta: delta => this.writer.write(delta),
          onToolCall: (name, inp) => this.writer.writeToolCall(name, inp),
          onToolResult: (name, result, isError) =>
            this.writer.writeToolResult(name, result, isError),
          onBudgetCheck: async (check) => await this.handleBudgetCheck(check),
        });

        const agentResult = await runner.run();
        this.writer.newline();

        if (gateDecision?.blocked) {
          const proceed = await this.promptAuditorGate();
          if (!proceed) {
            console.log(chalk.dim('Response rejected. Please rephrase your request.'));
            continue;
          }
        }

        this.messages = agentResult.messages;

        this.renderer.renderUsage(
          agentResult.usage.inputTokens,
          agentResult.usage.outputTokens,
          this.budgetGuard.sessionCost,
        );

        const turn = createTurn(userMessage, agentResult.finalResponse, agentResult.toolCallCount, {
          inputTokens: agentResult.usage.inputTokens,
          outputTokens: agentResult.usage.outputTokens,
        });
        await appendTurn(this.session, turn);
      } catch (err) {
        console.error(chalk.red(`\nAgent error: ${(err as Error).message}`));
        if (process.env.EPAM_DEBUG === '1') {
          console.error((err as Error).stack);
        }
      } finally {
        this.writer.reset();
      }
    }

    process.removeListener('SIGINT', sigintDuringAgent);
    rl.close();
  }

  private async handleBudgetCheck(check: BudgetCheckResult): Promise<void> {
    if (check.action === 'warning') {
      process.stderr.write(
        chalk.yellow.bold('\n  ⚠  Budget Warning: ') +
        chalk.yellow(check.message) + '\n'
      );
    } else if (check.action === 'downgrade') {
      // Interactive provider switch confirmation
      const chain = this.options.providerChain;
      if (chain) {
        const slots = chain.getSlots();
        const activeIdx = slots.indexOf(chain.activeSlot);
        
        if (activeIdx < slots.length - 1) {
          const currentSlot = slots[activeIdx];
          const nextSlot = slots[activeIdx + 1];
          
          // Get pricing for comparison
          const currentPricing = this.getModelPricing(currentSlot.model);
          const nextPricing = this.getModelPricing(nextSlot.model);
          
          // Show interactive prompt
          process.stderr.write(
            chalk.red.bold('\n\n  ⛔ Budget Hard Limit Reached\n') +
            chalk.red(`     ${check.message}\n\n`)
          );
          
          process.stderr.write(chalk.bold('  Switch model to stay within budget?\n\n'));
          
          process.stderr.write(
            chalk.dim('     Current:  ') +
            chalk.white(`${currentSlot.provider}/${currentSlot.model}`) +
            (currentPricing ? chalk.dim(` (${currentPricing})`) : '') + '\n'
          );
          
          process.stderr.write(
            chalk.dim('     Switch to: ') +
            chalk.green(`${nextSlot.provider}/${nextSlot.model}`) +
            (nextPricing ? chalk.dim(` (${nextPricing})`) : '') + '\n'
          );
          
          // Show cost comparison
          if (currentPricing && nextPricing) {
            const currentRate = this.parsePricing(currentPricing);
            const nextRate = this.parsePricing(nextPricing);
            const savings = currentRate > 0 && nextRate > 0 
              ? ((1 - nextRate / currentRate) * 100).toFixed(0) 
              : '0';
            process.stderr.write(
              chalk.dim(`     Savings:  ${chalk.green(savings + '% cheaper')}\n\n`)
            );
          }
          
          process.stderr.write(chalk.dim('     Remaining budget: ') + chalk.white(check.message.split('session:')[1]?.split(')')[0]?.trim() || 'N/A') + '\n');
          process.stderr.write(chalk.dim('     Context retained: ') + chalk.green(`${this.messages.length} messages`) + '\n\n');
          
          const { confirm } = await prompts(
            {
              type: 'confirm',
              name: 'confirm',
              message: 'Switch model?',
              initial: true,
            },
            { onCancel: () => process.stderr.write(chalk.dim('\n  Switch cancelled\n')) }
          );
          
          if (confirm) {
            // Perform the switch
            chain.getHealth().markUnavailable(currentSlot, 'budget limit');
            this.currentModel = nextSlot.model;
            this.budgetGuard.setModel(nextSlot.model);
            
            process.stderr.write(
              chalk.green('\n  ✓ Switched to ') +
              chalk.green(`${nextSlot.provider}/${nextSlot.model}`) +
              chalk.green(` — context retained (${this.messages.length} messages)\n\n`)
            );
          } else {
            process.stderr.write(
              chalk.yellow('\n  ⚠  Continuing with current model. Future requests may fail budget check.\n\n')
            );
          }
          return;
        }
      }
      
      // Fallback: automatic downgrade if no chain or no cheaper model
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

  /**
   * Get pricing string for a model
   */
  private getModelPricing(model: string): string | null {
    try {
      const { getPricing } = require('../../billing/pricing.js');
      const pricing = getPricing(model);
      if (pricing) {
        return `$${pricing.input.toFixed(4)}/1K in, $${pricing.output.toFixed(4)}/1K out`;
      }
    } catch {
      // Pricing not available
    }
    return null;
  }

  /**
   * Parse pricing string to get input rate
   */
  private parsePricing(pricingStr: string): number {
    const match = pricingStr.match(/\$(\d+\.\d+)\/1K in/);
    return match ? parseFloat(match[1]) : 0;
  }

  /**
   * Handle inline provider authentication during failover
   */
  private async handleProviderAuth(provider: string): Promise<boolean> {
    process.stderr.write(
      chalk.bold('\n\n  🔐 Provider Authentication Required\n\n') +
      chalk.dim(`     ${provider} is not authenticated.\n`) +
      chalk.dim(`     This is required to continue the conversation.\n\n`)
    );

    const { confirm } = await prompts(
      {
        type: 'confirm',
        name: 'confirm',
        message: `Authenticate with ${provider} now?`,
        initial: true,
      },
      { onCancel: () => {
        process.stderr.write(chalk.dim('\n  Authentication cancelled\n'));
        return false;
      }}
    );

    if (!confirm) {
      return false;
    }

    // Spawn provider authentication
    process.stderr.write(
      chalk.dim('\n  Starting authentication...\n\n')
    );

    try {
      const { execa } = await import('execa');
      
      if (provider === 'codex') {
        // Spawn codex CLI for auth
        const { exitCode } = await execa('codex', [], {
          stdio: 'inherit',
          timeout: 300000,
          reject: false,
        });

        if (exitCode === 0) {
          process.stderr.write(
            chalk.green('\n  ✓ Codex authentication successful\n\n')
          );
          return true;
        } else {
          process.stderr.write(
            chalk.red('\n  ✗ Codex authentication failed\n\n')
          );
          return false;
        }
      } else if (provider === 'codemie') {
        // Spawn epam provider login codemie
        const { exitCode } = await execa('node', ['dist/epam.js', 'provider', 'login', 'codemie'], {
          stdio: 'inherit',
          cwd: process.cwd(),
          timeout: 300000,
          reject: false,
        });

        return exitCode === 0;
      } else {
        process.stderr.write(
          chalk.red(`\n  Authentication not supported for: ${provider}\n\n`)
        );
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        chalk.red(`\n  Authentication error: ${message}\n\n`)
      );
      return false;
    }
  }

  private buildSlashContext(
    config: ResolvedConfig,
    _systemPrompt: string,
    systemPromptRef?: { value: string; default: string; onChange: (s: string) => void }
  ): SlashCommandContext {
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
      userEmail: this.userEmail,
      totalInputTokens: this.budgetGuard.inputTokens,
      totalOutputTokens: this.budgetGuard.outputTokens,
      budgetGuard: this.budgetGuard,
      tools: this.options.tools,
      toolRunner: this.toolRunner,
      rl: this.rl,
      currentSystemPrompt: systemPromptRef?.value,
      defaultSystemPrompt: systemPromptRef?.default,
      onSystemPromptChange: systemPromptRef?.onChange,

      onModelChange: model => {
        this.currentModel = model;
        this.budgetGuard.setModel(model);
      },

      onProviderChange: provider => {
        this.currentProvider = provider;
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
      auditorRegistry: this.auditorRegistry,

      onChainUpdate: async (slots: LLMChainSlot[]) => {
        const chain = this.options.providerChain;
        if (!chain) return;
        chain.getHealth().resetAll();
        config.llmChain = slots;
        this.currentProvider = slots[0]?.provider ?? this.currentProvider;
        this.currentModel = slots[0]?.model ?? this.currentModel;
        this.budgetGuard.setModel(this.currentModel);
      },
    };
  }

  private renderSessionHandoff(event: { fromSlot: { provider: string; model: string }; toSlot: { provider: string; model: string }; reason: string }): void {
    // Count messages and estimate context
    const messageCount = this.messages.length;
    const userMessages = this.messages.filter(m => m.role === 'user').length;
    const assistantMessages = this.messages.filter(m => m.role === 'assistant').length;
    const toolMessages = this.messages.filter(m => m.role === 'tool').length;
    
    // Get last user message for context
    const lastUserMsg = this.messages.filter(m => m.role === 'user').pop();
    const lastContext = lastUserMsg 
      ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content.substring(0, 50) : '[complex message]')
      : 'N/A';

    process.stderr.write(
      chalk.cyan.bold('\n📦 Session transferred to ') +
      chalk.green(`${event.toSlot.provider}/${event.toSlot.model}`) +
      chalk.dim('\n')
    );
    process.stderr.write(chalk.dim(`   • ${messageCount} messages transferred\n`));
    process.stderr.write(chalk.dim(`   • ${userMessages} user, ${assistantMessages} assistant, ${toolMessages} tool calls\n`));
    process.stderr.write(chalk.dim(`   • Last message: "${lastContext}..."\n`));
    process.stderr.write(chalk.green.dim('   • Full conversation history preserved\n'));
    process.stderr.write(chalk.green.dim('   • File system state visible\n'));
    process.stderr.write(chalk.dim('\n'));
  }

  private renderAuditorFindings(decision: AuditorGateDecision): void {
    for (const result of decision.blockingAuditors) {
      process.stdout.write(chalk.magenta(`\n[AUDITOR: ${result.auditorName}]`));
      for (const finding of result.findings) {
        process.stdout.write(chalk.magenta(` Finding: ${finding.finding}\n`));
      }
    }
    if (decision.blocked) {
      process.stdout.write(chalk.magenta.bold('\n⚠  Auditor gate triggered — review findings above.\n'));
    }
  }

  private async showPendingHandoffsBanner(): Promise<void> {
    if (!isRedisAvailable() || !this.userEmail) return;

    try {
      const codes = await listHandoffs(this.userEmail);
      if (codes.length === 0) return;

      const width = 57;
      const line = '─'.repeat(width);
      console.log(chalk.cyan(`┌${line}┐`));
      const header = `  📥  ${codes.length} session${codes.length > 1 ? 's' : ''} waiting for you`;
      console.log(chalk.cyan('│') + chalk.bold.yellow(header.padEnd(width)) + chalk.cyan('│'));
      console.log(chalk.cyan(`│${' '.repeat(width)}│`));

      for (const code of codes.slice(0, 3)) {
        const meta = await getSessionMeta(code);
        if (!meta) continue;

        const fromLine = `  From:  ${meta.exportedBy}`;
        console.log(chalk.cyan('│') + chalk.white(fromLine.padEnd(width)) + chalk.cyan('│'));

        if (meta.teamNote) {
          const note = meta.teamNote.length > width - 10
            ? meta.teamNote.slice(0, width - 13) + '…'
            : meta.teamNote;
          const noteLine = `  Note:  ${note}`;
          console.log(chalk.cyan('│') + chalk.dim(noteLine.padEnd(width)) + chalk.cyan('│'));
        }

        const codeLine = `  Code:  ${code}`;
        console.log(chalk.cyan('│') + chalk.cyan(codeLine.padEnd(width)) + chalk.cyan('│'));

        const cmdLine = `  Run:   /import ${code}`;
        console.log(chalk.cyan('│') + chalk.dim(cmdLine.padEnd(width)) + chalk.cyan('│'));

        if (codes.indexOf(code) < Math.min(codes.length, 3) - 1) {
          console.log(chalk.cyan(`│${'·'.repeat(width)}│`));
        }
      }

      if (codes.length > 3) {
        console.log(chalk.cyan(`│${' '.repeat(width)}│`));
        const more = `  ... and ${codes.length - 3} more — run /team to see all`;
        console.log(chalk.cyan('│') + chalk.dim(more.padEnd(width)) + chalk.cyan('│'));
      }

      console.log(chalk.cyan(`└${line}┘`));
      console.log();
    } catch {
      // Redis unavailable at runtime — skip silently
    }
  }

  private async promptAuditorGate(): Promise<boolean> {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(chalk.magenta('Proceed with this response? [y/N] '), answer => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }
}
