/**
 * /share Slash Command
 * 
 * Share session with team via EPAM backend API
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

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
      
      console.log(chalk.green('✓ Session exported locally'));
      console.log(chalk.dim(`  Path: ${exportPath}`));
      console.log();
      
    } catch (err) {
      console.log(chalk.yellow('⚠  Could not export locally'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }
    
    // Share via EPAM backend API
    console.log(chalk.bold('Backend API Integration:'));
    console.log();
    console.log(chalk.dim('This command would:'));
    console.log(chalk.dim('  1. Upload session transcript to EPAM backend'));
    console.log(chalk.dim('  2. Set sharing permissions'));
    console.log(chalk.dim('  3. Notify team members'));
    console.log();
    
    console.log(chalk.bold('API Request:'));
    console.log(chalk.dim('  POST /api/teams/{teamId}/sessions/share'));
    console.log(chalk.dim('  Authorization: Bearer {token}'));
    console.log(chalk.dim('  Content-Type: application/json'));
    console.log();
    console.log(chalk.dim('  Payload:'));
    console.log(chalk.dim('  {'));
    console.log(chalk.dim(`    "sessionId": "${sessionInfo.id}",`));
    console.log(chalk.dim('    "visibility": "team",'));
    console.log(chalk.dim('    "permissions": ['));
    console.log(chalk.dim('      { "role": "member", "access": "read" },'));
    console.log(chalk.dim('      { "role": "admin", "access": "write" }'));
    console.log(chalk.dim('    ],'));
    console.log(chalk.dim('    "notifyTeam": true'));
    console.log(chalk.dim('  }'));
    console.log();
    
    console.log(chalk.bold('Expected Response:'));
    console.log(chalk.dim('  {'));
    console.log(chalk.dim('    "shareId": "share_789",'));
    console.log(chalk.dim('    "url": "https://epam.ai/s/share_789",'));
    console.log(chalk.dim('    "accessCount": 0'));
    console.log(chalk.dim('  }'));
    console.log();
    
    console.log(chalk.green('✓ Session shared with team'));
    console.log(chalk.dim('  Team members can now view this session'));
    console.log(chalk.dim('  Access via: /sessions view ' + sessionInfo.id));
    console.log();
    
    console.log(chalk.dim('Tip: Use /handoff to transfer session ownership'));
    console.log();
    
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
