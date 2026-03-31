/**
 * /skills — List and toggle agent tools for the current session
 *
 * Commands:
 *   /skills                   List all tools with current state
 *   /skills enable <tool>     Enable a tool (set to auto-approve)
 *   /skills disable <tool>    Disable a tool for this session
 *   /skills show <tool>       Show tool details (description, permission level)
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

const TIER_COLOR: Record<string, (s: string) => string> = {
  safe:      s => chalk.green(s),
  review:    s => chalk.yellow(s),
  dangerous: s => chalk.red(s),
};

const MODE_COLOR: Record<string, (s: string) => string> = {
  auto:     s => chalk.green(s),
  prompt:   s => chalk.yellow(s),
  disabled: s => chalk.dim(s),
};

export const skillsCommand: SlashCommand = {
  name: 'skills',
  aliases: ['tools'],
  description: 'List and toggle agent tool capabilities for this session',
  usage: '[enable <tool> | disable <tool> | show <tool>]',

  async execute(args, ctx: SlashCommandContext): Promise<boolean> {
    if (!ctx.toolRunner || !ctx.tools) {
      console.log(chalk.dim('No tools are registered in this session.'));
      return true;
    }

    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub   = parts[0]?.toLowerCase() ?? '';

    // ── enable ────────────────────────────────────────────────────────────────
    if (sub === 'enable') {
      const toolName = parts[1];
      if (!toolName) {
        console.log(chalk.red('Usage: /skills enable <tool-name>'));
        return true;
      }
      const exists = ctx.tools.some(t => t.name === toolName);
      if (!exists) {
        console.log(chalk.red(`Tool "${toolName}" not found.`));
        listToolNames(ctx);
        return true;
      }
      ctx.toolRunner.setToolApprovalMode(toolName, 'auto');
      console.log(chalk.green(`✓ "${toolName}" enabled`) + chalk.dim(' (auto-approve)'));
      return true;
    }

    // ── disable ───────────────────────────────────────────────────────────────
    if (sub === 'disable') {
      const toolName = parts[1];
      if (!toolName) {
        console.log(chalk.red('Usage: /skills disable <tool-name>'));
        return true;
      }
      const exists = ctx.tools.some(t => t.name === toolName);
      if (!exists) {
        console.log(chalk.red(`Tool "${toolName}" not found.`));
        listToolNames(ctx);
        return true;
      }
      ctx.toolRunner.setToolApprovalMode(toolName, 'disabled');
      console.log(chalk.dim(`○ "${toolName}" disabled for this session.`));
      return true;
    }

    // ── show ──────────────────────────────────────────────────────────────────
    if (sub === 'show') {
      const toolName = parts[1];
      if (!toolName) {
        console.log(chalk.red('Usage: /skills show <tool-name>'));
        return true;
      }
      const tool = ctx.tools.find(t => t.name === toolName);
      if (!tool) {
        console.log(chalk.red(`Tool "${toolName}" not found.`));
        listToolNames(ctx);
        return true;
      }
      const states = ctx.toolRunner.getAllToolStates();
      const state  = states.find(s => s.tool.name === toolName);
      console.log(chalk.bold(`\n  ${toolName}\n`));
      console.log(chalk.cyan('  Description:  ') + tool.description);
      console.log(chalk.cyan('  Permission:   ') + (TIER_COLOR[state?.safetyTier ?? ''] ?? chalk.white)(state?.safetyTier ?? 'unknown'));
      console.log(chalk.cyan('  Mode:         ') + (MODE_COLOR[state?.approvalMode ?? ''] ?? chalk.white)(state?.approvalMode ?? 'unknown'));
      console.log();
      return true;
    }

    // ── default: list all ─────────────────────────────────────────────────────
    const states = ctx.toolRunner.getAllToolStates();

    console.log(chalk.bold('\nAvailable skills\n'));

    const byTier = { safe: [] as typeof states, review: [] as typeof states, dangerous: [] as typeof states };
    for (const s of states) {
      const tier = (s.safetyTier as keyof typeof byTier) ?? 'safe';
      (byTier[tier] ?? byTier.safe).push(s);
    }

    const sections: Array<{ tier: string; label: string }> = [
      { tier: 'safe',      label: 'Safe — auto-execute' },
      { tier: 'review',    label: 'Review — prompt before use' },
      { tier: 'dangerous', label: 'Dangerous — always confirm' },
    ];

    for (const { tier, label } of sections) {
      const group = byTier[tier as keyof typeof byTier];
      if (!group.length) continue;
      console.log(chalk.bold(`  ${(TIER_COLOR[tier] ?? chalk.white)(label)}\n`));
      for (const s of group.sort((a, b) => a.tool.name.localeCompare(b.tool.name))) {
        const enabled  = s.approvalMode !== 'disabled';
        const icon     = enabled ? chalk.green('✓') : chalk.dim('○');
        const nameStr  = enabled ? s.tool.name : chalk.dim(s.tool.name);
        const modeStr  = (MODE_COLOR[s.approvalMode] ?? chalk.white)(s.approvalMode);
        console.log(`    ${icon} ${nameStr.padEnd(22)} ${chalk.dim('[')}${modeStr}${chalk.dim(']')}`);
      }
      console.log();
    }

    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  /skills enable <tool>     — enable tool (auto-approve)'));
    console.log(chalk.dim('  /skills disable <tool>    — disable tool for this session'));
    console.log(chalk.dim('  /skills show <tool>       — show tool details\n'));
    return true;
  },
};

function listToolNames(ctx: SlashCommandContext): void {
  const names = ctx.tools?.map(t => t.name).join(', ') ?? '';
  console.log(chalk.dim(`Available: ${names}`));
}
