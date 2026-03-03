/**
 * /debug Slash Command
 * 
 * Provider + tool state dump for power users
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const debugCommand: SlashCommand = {
  name: 'debug',
  aliases: ['state', 'info'],
  description: 'Provider + tool state dump for power users',
  usage: '[full|brief]',
  
  async execute(args, ctx): Promise<boolean> {
    const mode = args.trim().toLowerCase() || 'brief';
    
    console.log();
    console.log(chalk.bold.cyan('🔧 Debug State Dump'));
    console.log();
    
    // Provider info
    console.log(chalk.bold('Provider Configuration:'));
    console.log(`  Provider: ${chalk.white(ctx.config.provider)}`);
    console.log(`  Model: ${chalk.cyan(ctx.currentModel)}`);
    console.log(`  Max iterations: ${chalk.white(ctx.config.maxIterations || 20)}`);
    console.log(`  Auto-compress at: ${chalk.white(ctx.config.autoCompressAt || 80000)} tokens`);
    console.log(`  Max output tokens: ${chalk.white(ctx.config.maxOutputTokens || 16384)}`);
    console.log();
    
    // Budget state
    console.log(chalk.bold('Budget State:'));
    console.log(`  Input tokens: ${chalk.white(ctx.totalInputTokens.toLocaleString())}`);
    console.log(`  Output tokens: ${chalk.white(ctx.totalOutputTokens.toLocaleString())}`);
    console.log(`  Session cost: ${chalk.green(`$${(ctx.budgetGuard?.sessionCost || 0).toFixed(4)}`)}`);
    
    if (ctx.budgetGuard?.limits) {
      const limits = ctx.budgetGuard.limits;
      console.log(`  Warning at: ${chalk.white(limits.warningAt < Infinity ? `$${limits.warningAt.toFixed(2)}` : '∞')}`);
      console.log(`  Hard limit: ${chalk.white(limits.hardLimitAt < Infinity ? `$${limits.hardLimitAt.toFixed(2)}` : '∞')}`);
    }
    console.log();
    
    // Tool state
    console.log(chalk.bold('Tool State:'));
    const tools = ctx.tools || [];
    console.log(`  Registered: ${chalk.white(tools.length)}`);
    
    if (mode === 'full') {
      console.log();
      console.log(chalk.dim('Tool Details:'));
      for (const tool of tools) {
        console.log(`  • ${chalk.cyan(tool.name)}`);
        if ((tool as any).definition) {
          const def = (tool as any).definition;
          console.log(chalk.dim(`    Description: ${def.description?.substring(0, 60) || 'N/A'}...`));
        }
      }
      console.log();
    }
    
    // Session state
    console.log(chalk.bold('Session State:'));
    console.log(`  Turn count: ${chalk.white(ctx.sessionTurnCount)}`);
    console.log(`  Messages: ${chalk.white(ctx.messages.length)}`);
    console.log(`  Context file: ${chalk.white(ctx.contextFilePath)}`);
    console.log(`  Project root: ${chalk.white(ctx.config.projectRoot || 'N/A')}`);
    console.log();
    
    // Provider chain
    if (ctx.providerChain) {
      console.log(chalk.bold('Provider Chain:'));
      const slots = (ctx.providerChain as any).getSlots?.() || [];
      const activeSlot = (ctx.providerChain as any).activeSlot;
      
      for (const slot of slots) {
        const isActive = activeSlot && 
                        activeSlot.provider === slot.provider && 
                        activeSlot.model === slot.model;
        const icon = isActive ? chalk.green('✓') : chalk.dim('○');
        const status = isActive ? chalk.green(' (ACTIVE)') : '';
        console.log(`  ${icon} ${slot.provider}/${slot.model}${status}`);
      }
      console.log();
    }
    
    // Memory usage (if available)
    if (mode === 'full' && typeof process !== 'undefined' && process.memoryUsage) {
      const mem = process.memoryUsage();
      console.log(chalk.bold('Memory Usage:'));
      console.log(`  RSS: ${chalk.white(Math.round(mem.rss / 1024 / 1024) + ' MB')}`);
      console.log(`  Heap: ${chalk.white(Math.round(mem.heapUsed / 1024 / 1024) + ' MB')}`);
      console.log();
    }
    
    console.log(chalk.dim('Tip: Use /debug full for detailed output'));
    console.log();
    
    return true;
  },
};
