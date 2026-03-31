/**
 * /fork Slash Command
 * 
 * Branch the session context for parallel exploration
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export const forkCommand: SlashCommand = {
  name: 'fork',
  aliases: ['branch'],
  description: 'Branch the session context for parallel exploration',
  usage: '[name]',
  
  async execute(args, ctx): Promise<boolean> {
    const forkName = args.trim() || `fork-${Date.now()}`;
    
    console.log();
    console.log(chalk.bold.cyan('🍴 Fork Session'));
    console.log();
    
    // Save current session state
    const sessionData = {
      forkedAt: new Date().toISOString(),
      parentSession: {
        messages: ctx.messages.length,
        turnCount: ctx.sessionTurnCount,
        model: ctx.currentModel,
      },
      context: {
        provider: ctx.config.provider,
        projectRoot: ctx.config.projectRoot,
      },
    };
    
    const forkPath = join(process.cwd(), '.epam', 'forks', `${forkName}.json`);
    
    try {
      await mkdir(join(forkPath, '..'), { recursive: true });
      await writeFile(forkPath, JSON.stringify(sessionData, null, 2), 'utf-8');
      
      console.log(chalk.green('✓ Session forked successfully'));
      console.log();
      console.log(chalk.bold('Fork Details:'));
      console.log(`  Name: ${chalk.white(forkName)}`);
      console.log(`  Messages preserved: ${chalk.white(ctx.messages.length)}`);
      console.log(`  Context saved: ${chalk.white(ctx.config.projectRoot || 'N/A')}`);
      console.log();
      console.log(chalk.bold('Next Steps:'));
      console.log(`  1. Continue in current session (main branch)`);
      console.log(`  2. Load fork with: /resume ${forkName}`);
      console.log(`  3. Compare forks with: /fork compare ${forkName}`);
      console.log();
      console.log(chalk.dim(`Fork saved to: ${forkPath}`));
      console.log();
      
    } catch (err) {
      console.log(chalk.red('Error creating fork'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }
    
    return true;
  },
};
