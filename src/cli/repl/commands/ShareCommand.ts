/**
 * /share Slash Command
 * 
 * Share session with team via EPAM backend API
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { readTeamConfig, writeTeamConfig } from './TeamCommand.js';

export const shareCommand: SlashCommand = {
  name: 'share',
  aliases: ['share-session'],
  description: 'Share session with team via EPAM backend API',
  usage: '[session-id|current]',
  
  async execute(args, ctx): Promise<boolean> {
    const sessionId = args.trim() || 'current';
    
    console.log();
    console.log(chalk.bold.cyan('📤 Share Session'));
    console.log();
    
    // Get session info
    const sessionInfo = {
      id: sessionId === 'current' ? `session-${Date.now()}` : sessionId,
      messages: ctx.messages.length,
      turns: ctx.sessionTurnCount,
      createdAt: new Date().toISOString(),
      provider: ctx.config.provider,
      model: ctx.currentModel,
    };
    
    console.log(chalk.bold('Session to Share:'));
    console.log(`  ID: ${chalk.white(sessionInfo.id)}`);
    console.log(`  Messages: ${chalk.white(sessionInfo.messages)}`);
    console.log(`  Turns: ${chalk.white(sessionInfo.turns)}`);
    console.log(`  Created: ${chalk.white(sessionInfo.createdAt)}`);
    console.log();
    
    // Export session transcript
    const transcript = buildTranscript(ctx, sessionInfo);
    const exportPath = join(process.cwd(), '.epam', 'shared', `${sessionInfo.id}.md`);
    
    try {
      // Ensure directory exists
      await mkdir(join(exportPath, '..'), { recursive: true });
      await writeFile(exportPath, transcript, 'utf-8');

      // Register in team.json sharedSessions
      const projectRoot = ctx.config.projectRoot || process.cwd();
      const team = readTeamConfig(projectRoot);
      if (team && !team.sharedSessions.includes(sessionInfo.id)) {
        team.sharedSessions.push(sessionInfo.id);
        writeTeamConfig(projectRoot, team);
      }

      console.log(chalk.green('✓ Session shared with team'));
      console.log(chalk.dim(`  Path: ${exportPath}`));
      console.log(chalk.dim(`  ID: ${sessionInfo.id}`));
      console.log(chalk.dim('  Visible via /team'));
      console.log();
      
    } catch (err) {
      console.log(chalk.yellow('⚠  Could not share session'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }

    return true;
  },
};

/**
 * Build session transcript
 */
function buildTranscript(ctx: SlashCommandContext, sessionInfo: any): string {
  const lines: string[] = [];
  
  lines.push('# EPAM CLI Session Transcript');
  lines.push('');
  lines.push(`**Session ID:** ${sessionInfo.id}`);
  lines.push(`**Date:** ${sessionInfo.createdAt}`);
  lines.push(`**Provider:** ${sessionInfo.provider}`);
  lines.push(`**Model:** ${sessionInfo.model}`);
  lines.push(`**Messages:** ${sessionInfo.messages}`);
  lines.push(`**Turns:** ${sessionInfo.turns}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Conversation');
  lines.push('');
  
  for (const msg of ctx.messages) {
    const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content, null, 2);
    
    lines.push(`### ${role}`);
    lines.push('');
    lines.push('```');
    lines.push(content.substring(0, 500)); // Truncate long messages
    if (content.length > 500) {
      lines.push('... [truncated]');
    }
    lines.push('```');
    lines.push('');
  }
  
  lines.push('---');
  lines.push('');
  lines.push('## Statistics');
  lines.push('');
  lines.push(`- **Input tokens:** ${ctx.totalInputTokens.toLocaleString()}`);
  lines.push(`- **Output tokens:** ${ctx.totalOutputTokens.toLocaleString()}`);
  lines.push(`- **Session cost:** $${(ctx.budgetGuard?.sessionCost || 0).toFixed(4)}`);
  lines.push('');
  
  return lines.join('\n');
}
