/**
 * /status Slash Command
 * 
 * Live dashboard: provider, budget, tools, model
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const statusCommand: SlashCommand = {
  name: 'status',
  aliases: ['st'],
  description: 'Show live dashboard: provider, budget, tools, model',
  
  async execute(_args, ctx): Promise<boolean> {
    console.log();
    console.log(chalk.bold.cyan('📊 Session Status'));
    console.log();
    
    // Provider & Model
    console.log(chalk.bold('Provider & Model:'));
    console.log(`  Provider: ${chalk.white(ctx.config.provider)}`);
    console.log(`  Model: ${chalk.cyan(ctx.currentModel)}`);
    console.log(`  Max iterations: ${chalk.white(ctx.config.maxIterations || 20)}`);
    console.log();
    
    // Budget
    console.log(chalk.bold('Budget:'));
    const { totalInputTokens, totalOutputTokens } = ctx;
    const cost = ctx.budgetGuard?.sessionCost || 0;
    const limits = ctx.budgetGuard?.limits;
    
    console.log(`  Input tokens: ${chalk.white(totalInputTokens.toLocaleString())}`);
    console.log(`  Output tokens: ${chalk.white(totalOutputTokens.toLocaleString())}`);
    console.log(`  Session cost: ${chalk.green(`$${cost.toFixed(4)}`)}`);
    
    if (limits && limits.warningAt < Infinity) {
      const remaining = limits.warningAt - cost;
      console.log(`  Budget limit: ${chalk.white(`$${limits.warningAt.toFixed(2)}`)}`);
      console.log(`  Remaining: ${remaining > 0 ? chalk.green(`$${remaining.toFixed(2)}`) : chalk.red('$0.00')}`);
    } else {
      console.log(`  Budget limit: ${chalk.dim('none')}`);
    }
    console.log();
    
    // Tools
    console.log(chalk.bold('Tools:'));
    const tools = ctx.tools || [];
    const toolRunner = ctx.toolRunner;
    
    console.log(`  Registered: ${chalk.white(tools.length)}`);
    for (const tool of tools.slice(0, 5)) {
      const permission = toolRunner?.getPermission?.(tool.name) || 'unknown';
      const permissionColor = permission === 'dangerous' ? chalk.red : 
                             permission === 'warning' ? chalk.yellow : chalk.green;
      console.log(`    • ${chalk.cyan(tool.name)} ${permissionColor(`(${permission})`)}`);
    }
    if (tools.length > 5) {
      console.log(chalk.dim(`    ... and ${tools.length - 5} more`));
    }
    console.log();
    
    // Session
    console.log(chalk.bold('Session:'));
    console.log(`  Turn count: ${chalk.white(ctx.sessionTurnCount)}`);
    console.log(`  Messages: ${chalk.white(ctx.messages.length)}`);
    console.log(`  Context: ${chalk.white(ctx.contextFilePath)}`);
    console.log();
    
    // Provider Chain
    if (ctx.providerChain) {
      console.log(chalk.bold('Provider Chain:'));
      const slots = (ctx.providerChain as any).getSlots?.() || [];
      const activeSlot = (ctx.providerChain as any).activeSlot;
      
      for (const slot of slots) {
        const isActive = activeSlot && 
                        activeSlot.provider === slot.provider && 
                        activeSlot.model === slot.model;
        const icon = isActive ? chalk.green('✓') : chalk.dim('○');
        const status = isActive ? chalk.green(' (active)') : '';
        console.log(`  ${icon} ${slot.provider}/${slot.model}${status}`);
      }
      console.log();
    }
    
    return true;
  },
};
