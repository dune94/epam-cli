/**
 * /export Slash Command
 * 
 * Export session transcript to file
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export const exportCommand: SlashCommand = {
  name: 'export',
  aliases: ['save'],
  description: 'Export session transcript to file',
  usage: '[filename]',
  
  async execute(args, ctx): Promise<boolean> {
    const filename = args.trim() || `session-${Date.now()}.md`;
    const outputPath = join(process.cwd(), filename);
    
    console.log();
    console.log(chalk.bold.cyan('📦 Export Session Transcript'));
    console.log();
    
    // Build transcript
    const lines: string[] = [];
    
    // Header
    lines.push('# EPAM CLI Session Transcript');
    lines.push('');
    lines.push(`**Date:** ${new Date().toISOString()}`);
    lines.push(`**Provider:** ${ctx.config.provider}`);
    lines.push(`**Model:** ${ctx.currentModel}`);
    lines.push(`**Project:** ${ctx.config.projectRoot || 'N/A'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    
    // Messages
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
      lines.push(content);
      lines.push('```');
      lines.push('');
    }
    
    // Stats
    lines.push('---');
    lines.push('');
    lines.push('## Statistics');
    lines.push('');
    lines.push(`- **Total messages:** ${ctx.messages.length}`);
    lines.push(`- **Input tokens:** ${ctx.totalInputTokens.toLocaleString()}`);
    lines.push(`- **Output tokens:** ${ctx.totalOutputTokens.toLocaleString()}`);
    
    if (ctx.budgetGuard) {
      lines.push(`- **Session cost:** $${(ctx.budgetGuard.sessionCost || 0).toFixed(4)}`);
    }
    
    lines.push('');
    
    const transcript = lines.join('\n');
    
    // Ensure directory exists
    const dir = join(outputPath, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    // Write file
    await writeFile(outputPath, transcript, 'utf-8');
    
    console.log(chalk.green('✓ Session exported successfully'));
    console.log();
    console.log(chalk.dim(`File: ${outputPath}`));
    console.log(chalk.dim(`Size: ${(transcript.length / 1024).toFixed(2)} KB`));
    console.log(chalk.dim(`Messages: ${ctx.messages.length}`));
    console.log();
    console.log(chalk.dim('Tip: Open with: code ' + filename));
    console.log();
    
    return true;
  },
};
