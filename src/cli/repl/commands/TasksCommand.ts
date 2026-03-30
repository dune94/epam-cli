/**
 * /tasks Slash Command
 * 
 * Show running agent task queue
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  aliases: ['queue'],
  description: 'Show running agent task queue',
  
  async execute(_args, ctx): Promise<boolean> {
    console.log();
    console.log(chalk.bold.cyan('📋 Agent Task Queue'));
    console.log();
    
    // Show current session tasks
    console.log(chalk.bold('Current Session:'));
    console.log();
    
    console.log(`  ${chalk.cyan('Turns completed:')} ${chalk.white(ctx.sessionTurnCount)}`);
    console.log(`  ${chalk.cyan('Messages:')} ${chalk.white(ctx.messages.length)}`);
    console.log(`  ${chalk.cyan('Tool calls:')} ${chalk.white('0')} (this session)`);
    console.log();
    
    // Show tool usage
    const tools = ctx.tools || [];
    if (tools.length > 0) {
      console.log(chalk.bold('Available Tools:'));
      console.log();
      
      for (const tool of tools.slice(0, 8)) {
        console.log(`  • ${chalk.cyan(tool.name)}`);
      }
      
      if (tools.length > 8) {
        console.log(chalk.dim(`  ... and ${tools.length - 8} more`));
      }
      console.log();
    }
    
    // Show budget status
    if (ctx.budgetGuard) {
      console.log(chalk.bold('Budget Status:'));
      console.log();
      console.log(`  Spent: ${chalk.green(`$${(ctx.budgetGuard.sessionCost || 0).toFixed(4)}`)}`);
      
      const limits = ctx.budgetGuard.limits;
      if (limits && limits.warningAt < Infinity) {
        const remaining = limits.warningAt - (ctx.budgetGuard.sessionCost || 0);
        console.log(`  Limit: ${chalk.white(`$${limits.warningAt.toFixed(2)}`)}`);
        console.log(`  Remaining: ${remaining > 0 ? chalk.green(`$${remaining.toFixed(2)}`) : chalk.red('$0.00')}`);
      }
      console.log();
    }
    
    console.log(chalk.dim('Tip: Tasks are processed in real-time'));
    console.log(chalk.dim('     Use /status for detailed session info'));
    console.log();
    
    return true;
  },
};
