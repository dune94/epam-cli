/**
 * /handoff Slash Command
 *
 * Transfer session ownership to team member.
 * Writes a portable .epam-session.json bundle the recipient can import.
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ulid } from 'ulid';
import { readTeamConfig } from './TeamCommand.js';
import type { SessionBundle } from './ShareCommand.js';
import {
  isRedisAvailable,
  storeSession,
  enqueueHandoff,
} from '../../../context/RedisSessionStore.js';

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

    // Build portable bundle turns from messages
    const turns: SessionBundle['turns'] = [];
    for (let i = 0; i < ctx.messages.length - 1; i++) {
      const cur = ctx.messages[i];
      const next = ctx.messages[i + 1];
      if (cur.role === 'user' && next.role === 'assistant') {
        turns.push({
          id: ulid(),
          timestamp: Date.now(),
          userMessage: typeof cur.content === 'string' ? cur.content : JSON.stringify(cur.content),
          assistantResponse: typeof next.content === 'string' ? next.content : JSON.stringify(next.content),
          toolCallCount: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        i++;
      }
    }

    const bundle: SessionBundle = {
      version: '1',
      exportedAt: new Date().toISOString(),
      exportedBy: ctx.userEmail || process.env.EPAM_USER_EMAIL || process.env.USER || 'unknown',
      teamNote: `Handoff to ${resolvedTarget}`,
      model: ctx.currentModel,
      provider: ctx.config.provider,
      turns,
    };

    try {
      const useRedis = isRedisAvailable();

      if (useRedis) {
        await storeSession(bundle, handoffId);
        await enqueueHandoff(resolvedTarget, handoffId);

        console.log(chalk.green(`✓ Session handed off to ${chalk.white(resolvedTarget)}`));
        console.log(`  ${chalk.bold('Turns:')}  ${chalk.white(turns.length)}`);
        console.log(`  ${chalk.bold('Code:')}   ${chalk.cyan.bold(handoffId)}`);
        console.log();
        console.log(chalk.bold('Recipient runs:'));
        console.log(chalk.dim(`  epam-cli import ${handoffId}`));
        console.log(chalk.dim(`  Or in REPL: /import ${handoffId}`));
        console.log(chalk.dim(`  Or: /team  (shows pending handoffs)`));
        console.log();
      } else {
        const handoffsDir = join(projectRoot, '.epam', 'handoffs');
        mkdirSync(handoffsDir, { recursive: true });
        const bundlePath = join(handoffsDir, `${handoffId}.epam-session.json`);
        writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

        console.log(chalk.green(`✓ Session handed off to ${chalk.white(resolvedTarget)}`));
        console.log(`  ${chalk.bold('Turns:')}  ${chalk.white(turns.length)}`);
        console.log(`  ${chalk.bold('Bundle:')} ${chalk.white(bundlePath)}`);
        console.log();
        console.log(chalk.bold('Recipient runs:'));
        console.log(chalk.dim(`  epam-cli import ${bundlePath}`));
        console.log(chalk.dim.yellow('  Tip: Set EPAM_REDIS_URL for zero-transfer handoff'));
        console.log();
      }
    } catch (err) {
      console.log(chalk.red('Failed to write handoff'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }

    return true;
  },
};
