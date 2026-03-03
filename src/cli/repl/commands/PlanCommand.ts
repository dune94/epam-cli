/**
 * /plan Slash Command
 * 
 * Structured plan mode with branching strategy
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const planCommand: SlashCommand = {
  name: 'plan',
  aliases: ['planning'],
  description: 'Enter structured plan mode with branching strategy',
  usage: '[show|create|branch]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim().toLowerCase();
    
    if (!trimmedArgs || trimmedArgs === 'show') {
      return showPlan(ctx);
    }
    
    if (trimmedArgs === 'create') {
      return createPlan(ctx);
    }
    
    if (trimmedArgs === 'branch') {
      return showBranches(ctx);
    }
    
    console.log(chalk.red(`Unknown plan command: ${trimmedArgs}`));
    console.log(chalk.dim('Usage: /plan [show|create|branch]'));
    console.log();
    
    return true;
  },
};

/**
 * Show current plan
 */
function showPlan(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('📋 Session Plan'));
  console.log();
  
  // Get plan from context or show default
  console.log(chalk.bold('Current Strategy:'));
  console.log(`  Mode: ${chalk.white('Linear')}`);
  console.log(`  Branches: ${chalk.white('0')}`);
  console.log(`  Steps completed: ${chalk.green('0')}`);
  console.log();
  
  console.log(chalk.dim('Tip: Use /plan create to start a new plan'));
  console.log(chalk.dim('     Use /plan branch to see branching options'));
  console.log();
  
  return true;
}

/**
 * Create new plan
 */
function createPlan(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('📋 Create Plan'));
  console.log();
  
  console.log(chalk.bold('Plan Structure:'));
  console.log();
  console.log(chalk.cyan('1. Define objective'));
  console.log(chalk.dim('   What are we trying to accomplish?'));
  console.log();
  console.log(chalk.cyan('2. Identify constraints'));
  console.log(chalk.dim('   Budget, time, technical limitations'));
  console.log();
  console.log(chalk.cyan('3. Break down into steps'));
  console.log(chalk.dim('   Sequential tasks with clear outcomes'));
  console.log();
  console.log(chalk.cyan('4. Define success criteria'));
  console.log(chalk.dim('   How do we know we succeeded?'));
  console.log();
  
  console.log(chalk.dim('Tip: Describe your goal and I will create a structured plan'));
  console.log();
  
  return true;
}

/**
 * Show branching options
 */
function showBranches(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🌿 Plan Branches'));
  console.log();
  
  console.log(chalk.bold('Available Strategies:'));
  console.log();
  console.log(`  ${chalk.cyan('Linear')}     - Sequential execution, one step at a time`);
  console.log(`  ${chalk.cyan('Parallel')}   - Multiple independent tasks simultaneously`);
  console.log(`  ${chalk.cyan('Iterative')}  - Build, review, refine cycles`);
  console.log(`  ${chalk.cyan('Exploratory')} - Try multiple approaches, keep best`);
  console.log();
  
  console.log(chalk.dim('Tip: Specify strategy when creating plan'));
  console.log(chalk.dim('     Example: "Create an iterative plan for building a React app"'));
  console.log();
  
  return true;
}
