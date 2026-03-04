/**
 * /handoff Slash Command
 * 
 * Transfer session ownership to team member via EPAM backend API
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ulid } from 'ulid';
import { readTeamConfig } from './TeamCommand.js';

export const handoffCommand: SlashCommand = {
  name: 'handoff',
  aliases: ['transfer'],
  description: 'Transfer session ownership to team member',
  usage: '<email|user-id>',
  
  async execute(args, ctx): Promise<boolean> {
    const targetUser = args.trim();
    
    if (!targetUser) {
      console.log();
      console.log(chalk.bold.cyan('🔄 Session Handoff'));
      console.log();
      console.log(chalk.dim('Usage: /handoff <email|user-id>'));
      console.log();
      console.log(chalk.bold('What is Handoff?'));
      console.log(chalk.dim('  Transfer session context and ownership to another team member.'));
      console.log(chalk.dim('  They can continue the conversation from where you left off.'));
      console.log();
      console.log(chalk.bold('Example:'));
      console.log(chalk.dim('  /handoff john@example.com'));
      console.log(chalk.dim('  /handoff user_123456'));
      console.log();
      return true;
    }
    
    console.log();
    console.log(chalk.bold.cyan('🔄 Session Handoff'));
    console.log();

    const projectRoot = ctx.config.projectRoot || process.cwd();
    const team = readTeamConfig(projectRoot);

    // Resolve target: match by email or name from team.json
    let resolvedTarget = targetUser;
    if (team) {
      const match = team.members.find(
        m => m.email === targetUser || m.name === targetUser
      );
      if (match) resolvedTarget = match.email;
    }

    const handoffId = ulid();
    const handoff = {
      id: handoffId,
      targetUser: resolvedTarget,
      createdAt: new Date().toISOString(),
      session: {
        id: `session-${Date.now()}`,
        messages: ctx.messages.length,
        turns: ctx.sessionTurnCount,
        model: ctx.currentModel,
        provider: ctx.config.provider,
        projectRoot: ctx.config.projectRoot || process.cwd(),
      },
      lastMessage:
        ctx.messages.length > 0
          ? String(
              typeof ctx.messages[ctx.messages.length - 1].content === 'string'
                ? ctx.messages[ctx.messages.length - 1].content
                : JSON.stringify(ctx.messages[ctx.messages.length - 1].content)
            ).slice(0, 200)
          : '',
    };

    try {
      const handoffsDir = join(projectRoot, '.epam', 'handoffs');
      mkdirSync(handoffsDir, { recursive: true });
      writeFileSync(
        join(handoffsDir, `${handoffId}.json`),
        JSON.stringify(handoff, null, 2),
        'utf-8'
      );

      console.log(chalk.green(`✓ Session handed off to ${chalk.white(resolvedTarget)}`));
      console.log(`  Handoff ID: ${chalk.dim(handoffId)}`);
      console.log(`  Turns transferred: ${chalk.white(ctx.sessionTurnCount)}`);
      console.log(`  File: ${chalk.dim(join('.epam', 'handoffs', `${handoffId}.json`))}`);
      console.log();
    } catch (err) {
      console.log(chalk.red('Failed to write handoff'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }

    return true;
  },
};
