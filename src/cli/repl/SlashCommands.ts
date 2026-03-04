import chalk from 'chalk';
import prompts from 'prompts';
import type { ResolvedConfig, LLMChainSlot } from '../../config/types.js';
import { calculateCost, formatCost, getPricing } from '../../billing/pricing.js';
import { listSessions } from '../../context/SessionStore.js';
import type { Message } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import type { ToolRunner } from '../../agent/tools/ToolRunner.js';
import type { ProviderChain } from '../../providers/ProviderChain.js';
import type { HealthStatus } from '../../providers/health/types.js';
import type { BudgetGuard } from '../../billing/BudgetGuard.js';
import type { AuditorRegistry } from '../../auditors/AuditorRegistry.js';
import { providersCommand } from './commands/ProvidersCommand.js';
import { orchestrateCommand } from './commands/OrchestrateCommand.js';
import { statusCommand } from './commands/StatusCommand.js';
import { diffCommand } from './commands/DiffCommand.js';
import { exportCommand } from './commands/ExportCommand.js';
import { dashboardCommand } from './commands/DashboardCommand.js';
import { planCommand } from './commands/PlanCommand.js';
import { reviewCommand } from './commands/ReviewCommand.js';
import { forkCommand } from './commands/ForkCommand.js';
import { mcpCommand } from './commands/MCPCommand.js';
import { tasksCommand } from './commands/TasksCommand.js';
import { debugCommand } from './commands/DebugCommand.js';
import { teamCommand } from './commands/TeamCommand.js';
import { membersCommand } from './commands/MembersCommand.js';
import { inviteCommand } from './commands/InviteCommand.js';
import { shareCommand } from './commands/ShareCommand.js';
import { handoffCommand } from './commands/HandoffCommand.js';
import { importCommand } from './commands/ImportCommand.js';
import { modelCommand } from './commands/ModelCommand.js';
import { copilotCommand } from './commands/CopilotCommand.js';
import { failoverCommand } from './commands/FailoverCommand.js';
import { mcpCommand } from './commands/MCPQueryCommand.js';

export interface SlashCommandContext {
  config: ResolvedConfig;
  currentModel: string;
  sessionTurnCount: number;
  tokenCount: number;
  contextFilePath: string;
  // Authenticated user identity (email from JWT or EPAM_USER_EMAIL env)
  userEmail?: string;
  // Cost tracking
  totalInputTokens: number;
  totalOutputTokens: number;
  // Message history (for rewind)
  messages: Message[];
  // Tools
  tools?: Tool[];
  toolRunner?: ToolRunner;
  // Budget guard (session cost tracking + enforcement)
  budgetGuard?: BudgetGuard;
  // Provider chain (optional — present when failover is active)
  providerChain?: ProviderChain;
  // Auditor registry (optional — present when .epam/auditors.json exists)
  auditorRegistry?: AuditorRegistry;
  // Callbacks
  onModelChange: (model: string) => void;
  onClear: () => void;
  onCompact: () => Promise<void>;
  onRewind: () => void;
  onResume: (sessionId: string) => Promise<{ success: boolean; turnCount: number }>;
  onChainUpdate?: (slots: LLMChainSlot[]) => Promise<void>;
  // Provider auth helper
  onAuthenticateProvider?: (provider: string) => Promise<boolean>;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(args: string, ctx: SlashCommandContext): Promise<boolean>; // false = exit REPL
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── /help ──────────────────────────────────────────────────────────────────
  {
    name: 'help',
    description: 'Show available slash commands',
    async execute(_args, _ctx) {
      console.log(chalk.bold('\nSlash Commands:\n'));
      for (const cmd of SLASH_COMMANDS) {
        const aliases = cmd.aliases ? chalk.dim(` (${cmd.aliases.join(', ')})`) : '';
        const usage = cmd.usage ? chalk.dim(` ${cmd.usage}`) : '';
        console.log(`  ${chalk.cyan('/' + cmd.name)}${aliases}${usage}`);
        console.log(chalk.dim(`    ${cmd.description}`));
      }
      console.log();
      return true;
    },
  },

  // ── /clear ─────────────────────────────────────────────────────────────────
  {
    name: 'clear',
    aliases: ['c'],
    description: 'Clear conversation history (keeps context.md)',
    async execute(_args, ctx) {
      ctx.onClear();
      console.log(chalk.dim('Conversation cleared.'));
      return true;
    },
  },

  // ── /cost ──────────────────────────────────────────────────────────────────
  {
    name: 'cost',
    description: 'Show token usage, estimated USD cost, and budget status',
    async execute(_args, ctx) {
      const { totalInputTokens, totalOutputTokens, currentModel } = ctx;
      const cost = calculateCost(currentModel, totalInputTokens, totalOutputTokens);
      const pricing = getPricing(currentModel);

      console.log(chalk.bold('\nSession Cost:\n'));
      console.log(
        `  Model:         ${chalk.cyan(currentModel)}` +
          (pricing ? '' : chalk.yellow(' (no pricing data)'))
      );
      console.log(`  Input tokens:  ${chalk.white(totalInputTokens.toLocaleString())}`);
      console.log(`  Output tokens: ${chalk.white(totalOutputTokens.toLocaleString())}`);
      console.log(
        `  Total tokens:  ${chalk.white((totalInputTokens + totalOutputTokens).toLocaleString())}`
      );

      if (pricing) {
        const inputCost = (totalInputTokens / 1_000_000) * pricing.inputPerMillion;
        const outputCost = (totalOutputTokens / 1_000_000) * pricing.outputPerMillion;
        console.log();
        console.log(
          `  Input cost:    ${chalk.dim(formatCost(inputCost))}  ` +
            chalk.dim(`($${pricing.inputPerMillion}/M)`)
        );
        console.log(
          `  Output cost:   ${chalk.dim(formatCost(outputCost))}  ` +
            chalk.dim(`($${pricing.outputPerMillion}/M)`)
        );
        console.log(`  ${chalk.bold('Total cost:')}    ${chalk.green.bold(formatCost(cost))}`);
      }

      // Budget guardrails status
      const guard = ctx.budgetGuard;
      if (guard && guard.hasLimits) {
        const limits = guard.limits;
        console.log();
        console.log(chalk.bold('  Budget:'));
        if (isFinite(limits.warningAt)) {
          const warningPct = Math.min(100, (cost / limits.warningAt) * 100);
          const warningColor = warningPct >= 100 ? chalk.yellow : chalk.dim;
          console.log(`    Warning at:  ${warningColor(formatCost(limits.warningAt))}  (${warningPct.toFixed(0)}% used)`);
        }
        if (isFinite(limits.hardLimitAt)) {
          const limitPct = Math.min(100, (cost / limits.hardLimitAt) * 100);
          const remaining = Math.max(0, limits.hardLimitAt - cost);
          const limitColor = limitPct >= 100 ? chalk.red : limitPct >= 80 ? chalk.yellow : chalk.dim;
          console.log(`    Hard limit:  ${limitColor(formatCost(limits.hardLimitAt))}  (${limitPct.toFixed(0)}% used, ${formatCost(remaining)} remaining)`);
        }
      }

      console.log();
      return true;
    },
  },

  // ── /resume ────────────────────────────────────────────────────────────────
  {
    name: 'resume',
    aliases: ['r'],
    description: 'Resume a previous session',
    usage: '[session_id]',
    async execute(args, ctx) {
      const sessionId = args.trim();

      if (sessionId) {
        const result = await ctx.onResume(sessionId);
        if (result.success) {
          console.log(
            chalk.green(
              `Resumed session ${chalk.bold(sessionId.slice(-8))} — ${result.turnCount} turns loaded`
            )
          );
        } else {
          console.log(chalk.red(`Session '${sessionId}' not found.`));
        }
        return true;
      }

      // Interactive picker
      const sessions = await listSessions(ctx.config.projectRoot, 15);
      if (sessions.length === 0) {
        console.log(chalk.dim('No past sessions found.'));
        return true;
      }

      const choices = sessions.map(s => ({
        title:
          `${chalk.cyan(s.id.slice(-8))}  ` +
          `${chalk.dim(s.updatedAt.toLocaleString())}  ` +
          chalk.dim(`${s.turnCount} turn${s.turnCount !== 1 ? 's' : ''}`),
        value: s.id,
        description: s.id,
      }));

      const response = await prompts({
        type: 'select',
        name: 'id',
        message: 'Select a session to resume:',
        choices,
        initial: 0,
      });

      if (!response.id) return true; // user cancelled

      const result = await ctx.onResume(response.id as string);
      if (result.success) {
        console.log(chalk.green(`Resumed — ${result.turnCount} turns loaded`));
      } else {
        console.log(chalk.red('Failed to load session.'));
      }
      return true;
    },
  },

  // ── /rewind ────────────────────────────────────────────────────────────────
  {
    name: 'rewind',
    aliases: ['undo'],
    description: 'Remove the last conversation turn (user message + assistant response)',
    async execute(_args, ctx) {
      if (ctx.messages.length < 2) {
        console.log(chalk.yellow('Nothing to rewind — conversation is empty.'));
        return true;
      }

      // Show what will be removed
      const lastUser = ctx.messages
        .slice()
        .reverse()
        .find(m => m.role === 'user');
      const preview =
        typeof lastUser?.content === 'string'
          ? lastUser.content.slice(0, 80) + (lastUser.content.length > 80 ? '…' : '')
          : '(structured content)';

      console.log(chalk.dim(`\nLast turn: "${preview}"`));

      const response = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'Remove this turn?',
        initial: true,
      });

      if (response.confirm) {
        ctx.onRewind();
        console.log(chalk.dim('Last turn removed.'));
      }
      return true;
    },
  },

  // ── /context ───────────────────────────────────────────────────────────────
  {
    name: 'context',
    description: 'Show current session info and running cost',
    async execute(_args, ctx) {
      const cost = calculateCost(
        ctx.currentModel,
        ctx.totalInputTokens,
        ctx.totalOutputTokens
      );
      console.log(chalk.bold('\nSession Info:\n'));
      console.log(`  Model:         ${chalk.cyan(ctx.currentModel)}`);
      console.log(`  Provider:      ${chalk.cyan(ctx.config.provider)}`);
      console.log(`  Turns:         ${ctx.sessionTurnCount}`);
      console.log(`  Messages:      ${ctx.messages.length}`);
      console.log(`  Est tokens:    ${ctx.tokenCount.toLocaleString()}`);
      console.log(`  Session cost:  ${chalk.green(formatCost(cost))}`);
      if (ctx.budgetGuard?.hasLimits) {
        const limits = ctx.budgetGuard.limits;
        const limitStr = isFinite(limits.hardLimitAt)
          ? formatCost(limits.hardLimitAt)
          : 'none';
        const remaining = isFinite(limits.hardLimitAt)
          ? formatCost(Math.max(0, limits.hardLimitAt - cost))
          : 'unlimited';
        console.log(`  Budget limit:  ${chalk.dim(limitStr)}  (${remaining} remaining)`);
      }
      console.log(`  Context file:  ${chalk.dim(ctx.contextFilePath)}`);
      console.log(`  Project root:  ${chalk.dim(ctx.config.projectRoot ?? '(none)')}`);
      console.log();
      return true;
    },
  },

  // ── /model ─────────────────────────────────────────────────────────────────
  {
    name: 'model',
    aliases: ['m'],
    description: 'Switch the active model',
    usage: '[model-name]',
    async execute(args, ctx) {
      const modelName = args.trim();
      if (!modelName) {
        const pricing = getPricing(ctx.currentModel);
        const priceStr = pricing
          ? chalk.dim(
              ` · $${pricing.inputPerMillion}/M in · $${pricing.outputPerMillion}/M out`
            )
          : '';
        console.log(`Current model: ${chalk.cyan.bold(ctx.currentModel)}${priceStr}`);
      } else {
        ctx.onModelChange(modelName);
        const pricing = getPricing(modelName);
        const priceStr = pricing
          ? chalk.dim(` ($${pricing.inputPerMillion}/M in, $${pricing.outputPerMillion}/M out)`)
          : chalk.yellow(' (no pricing data — cost tracking unavailable)');
        console.log(chalk.green(`Switched to: ${chalk.bold(modelName)}`) + priceStr);
      }
      return true;
    },
  },

  // ── /compact ───────────────────────────────────────────────────────────────
  {
    name: 'compact',
    description: 'Summarize old conversation turns to free up token budget',
    async execute(_args, ctx) {
      console.log(chalk.dim('Compacting conversation...'));
      await ctx.onCompact();
      console.log(chalk.green('Conversation compacted.'));
      return true;
    },
  },

  // ── /chain ─────────────────────────────────────────────────────────────────
  {
    name: 'chain',
    description: 'Show or configure the LLM provider failover chain',
    usage: '[set <p1/m1> [p2/m2] ...] | [reset]',
    async execute(args, ctx) {
      const sub = args.trim();

      // /chain reset — clear all circuit breakers
      if (sub === 'reset') {
        if (ctx.providerChain) {
          ctx.providerChain.getHealth().resetAll();
          console.log(chalk.green('Provider chain health reset — all slots re-enabled.'));
        } else {
          console.log(chalk.yellow('No active provider chain.'));
        }
        return true;
      }

      // /chain set <slot1> [slot2] ... — redefine priority list
      if (sub.startsWith('set ')) {
        if (!ctx.onChainUpdate) {
          console.log(chalk.yellow('Chain update not available in this session.'));
          return true;
        }
        const parts = sub.slice(4).trim().split(/\s+/);
        const slots = parts.slice(0, 5).map(p => {
          const [provider, model] = p.split('/');
          return { provider: provider ?? p, model: model ?? '' };
        }).filter(s => s.provider && s.model);

        if (slots.length === 0) {
          console.log(chalk.red('Usage: /chain set anthropic/claude-sonnet-4-6 openai/gpt-4o'));
          return true;
        }

        await ctx.onChainUpdate(slots);
        console.log(chalk.green(`Chain updated: ${slots.map(s => chalk.cyan(`${s.provider}/${s.model}`)).join(' → ')}`));
        return true;
      }

      // /chain — show status
      const chain = ctx.providerChain;
      if (!chain) {
        // No chain active — show config
        const slots = ctx.config.llmChain;
        console.log(chalk.bold('\nLLM Chain (config, no failover active):\n'));
        slots.forEach((s, i) => {
          const active = i === 0 ? chalk.dim(' [active]') : '';
          console.log(`  ${i + 1}  ${chalk.cyan(`${s.provider}/${s.model}`)}${active}`);
        });
        console.log();
        return true;
      }

      const slots = chain.getSlots();
      const health = chain.getHealth();
      const active = chain.activeSlot;

      console.log(chalk.bold('\nLLM Provider Chain:\n'));
      slots.forEach((slot, i) => {
        const status = health.getStatus(slot);
        const isActive = slot === active || (slot.provider === active.provider && slot.model === active.model);

        const statusIcon = statusIcon_(status);
        const statusColor = statusColor_(status);
        const rec = health.getRecord(slot);
        const label = slot.label ? chalk.dim(` (${slot.label})`) : '';
        const activeTag = isActive ? chalk.green.bold(' [active]') : '';

        let statusDetail = statusColor(status);
        if (status === 'down' && rec.lastFailureAt != null) {
          const remainMs = health.cooldownRemainingMs(slot);
          const remainSec = Math.ceil(remainMs / 1000);
          statusDetail += chalk.dim(
            `  retry in ${remainSec >= 60 ? `${Math.ceil(remainSec / 60)}m` : `${remainSec}s`}`
          );
          if (rec.lastError) statusDetail += chalk.dim(`  (${rec.lastError.slice(0, 60)})`);
        } else if (status === 'unavailable' && rec.lastError) {
          statusDetail += chalk.dim(`  (${rec.lastError.slice(0, 60)})`);
        }

        console.log(`  ${i + 1} ${statusIcon} ${chalk.cyan(`${slot.provider}/${slot.model}`)}${label}  ${statusDetail}${activeTag}`);
      });
      console.log();
      console.log(chalk.dim('  /chain reset           — clear all circuit breakers'));
      console.log(chalk.dim('  /chain set p/m [p/m]   — redefine priority list'));
      console.log();
      return true;
    },
  },

  // ── /permissions ─────────────────────────────────────────────────────────────
  {
    name: 'permissions',
    description: 'Show or change tool approval permissions',
    usage: '[auto | reset | <tool> <auto|prompt|disabled>]',
    async execute(args, ctx) {
      if (!ctx.toolRunner || !ctx.tools) {
        console.log(chalk.yellow('Tools are not available in this session.'));
        return true;
      }

      const input = args.trim().toLowerCase();

      if (input === 'auto') {
        ctx.toolRunner.setAutoApproveAll();
        console.log(chalk.green('Global auto-approve enabled for all tools.'));
        return true;
      }

      if (input === 'reset') {
        ctx.toolRunner.reset();
        console.log(chalk.green('Tool permissions reset to default.'));
        return true;
      }

      if (input) {
        const parts = input.split(/\s+/);
        if (parts.length === 2) {
          const [toolName, mode] = parts;
          if (['auto', 'prompt', 'disabled'].includes(mode)) {
            ctx.toolRunner.setToolApprovalMode(toolName, mode as 'auto' | 'prompt' | 'disabled');
            console.log(chalk.green(`Tool '${toolName}' approval mode set to ${mode}.`));
            return true;
          }
        }
        console.log(chalk.red('Usage: /permissions [auto | reset | <tool> <auto|prompt|disabled>]'));
        return true;
      }

      console.log(chalk.bold('\nTool Permissions:\n'));
      const states = ctx.toolRunner.getAllToolStates();
      for (const state of states) {
        const modeColor = state.approvalMode === 'auto' ? chalk.green : state.approvalMode === 'disabled' ? chalk.dim : chalk.yellow;
        console.log(`  ${chalk.cyan(state.tool.name.padEnd(20))} ${chalk.dim(state.safetyTier.padEnd(10))} ${modeColor(state.approvalMode)}`);
      }
      console.log();
      return true;
    },
  },

  // ── /exit ──────────────────────────────────────────────────────────────────
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit EPAM CLI',
    async execute(_args, ctx) {
      const cost = calculateCost(
        ctx.currentModel,
        ctx.totalInputTokens,
        ctx.totalOutputTokens
      );
      if (cost > 0) {
        console.log(chalk.dim(`Session cost: ${formatCost(cost)}`));
      }
      console.log(chalk.dim('Goodbye!'));
      return false;
    },
  },

  // ── /auditors ──────────────────────────────────────────────────────────────
  {
    name: 'auditors',
    description: 'Toggle or list auditor personas for this session',
    usage: '[on|off|list]',
    async execute(args, ctx) {
      const registry = ctx.auditorRegistry;
      const sub = args.trim().toLowerCase();

      if (!registry) {
        console.log(chalk.dim('Auditors not available (no .epam/auditors.json found).'));
        return true;
      }

      if (sub === 'on') {
        registry.toggle(true);
        console.log(chalk.magenta(`Auditors enabled (${registry.getEnabled().length} persona(s) active).`));
      } else if (sub === 'off') {
        registry.toggle(false);
        console.log(chalk.dim('Auditors disabled for this session.'));
      } else {
        // list (default)
        const all = registry.getAll();
        if (all.length === 0) {
          console.log(chalk.dim('No auditor personas configured.'));
          return true;
        }
        const status = registry.isEnabled() ? chalk.magenta('enabled') : chalk.dim('disabled');
        console.log(chalk.bold(`\nAuditors (${status}):\n`));
        for (const a of all) {
          const active = a.enabled !== false ? chalk.magenta('●') : chalk.dim('○');
          console.log(`  ${active} ${chalk.white(a.name)} — ${chalk.dim(a.focus)} [threshold: ${a.severity_threshold}]`);
        }
        console.log();
      }
      return true;
    },
  },

  // ── /providers ──────────────────────────────────────────────────────────────
  providersCommand,
  orchestrateCommand,
  statusCommand,
  diffCommand,
  exportCommand,
  dashboardCommand,
  planCommand,
  reviewCommand,
  forkCommand,
  mcpCommand,
  tasksCommand,
  debugCommand,
  teamCommand,
  membersCommand,
  inviteCommand,
  shareCommand,
  handoffCommand,
  importCommand,
  modelCommand,
  copilotCommand,
  failoverCommand,
  mcpCommand,
];

function statusIcon_(status: HealthStatus): string {
  switch (status) {
    case 'healthy':     return chalk.green('✓');
    case 'degraded':    return chalk.yellow('~');
    case 'down':        return chalk.red('✗');
    case 'unavailable': return chalk.dim('○');
  }
}

function statusColor_(status: HealthStatus): (s: string) => string {
  switch (status) {
    case 'healthy':     return chalk.green;
    case 'degraded':    return chalk.yellow;
    case 'down':        return chalk.red;
    case 'unavailable': return chalk.dim;
  }
}

export function findCommand(input: string): { command: SlashCommand; args: string } | null {
  const trimmed = input.slice(1).trim();
  const [name, ...rest] = trimmed.split(/\s+/);
  const args = rest.join(' ');
  const command = SLASH_COMMANDS.find(
    cmd => cmd.name === name || cmd.aliases?.includes(name ?? '')
  );
  return command ? { command, args } : null;
}
