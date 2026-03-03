/**
 * /review Slash Command
 * 
 * Instant inline code review
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { execa } from 'execa';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const reviewCommand: SlashCommand = {
  name: 'review',
  aliases: ['code-review'],
  description: 'Instant inline code review of recent changes',
  usage: '[file|all]',
  
  async execute(args, ctx): Promise<boolean> {
    const target = args.trim() || 'all';
    
    console.log();
    console.log(chalk.bold.cyan('🔍 Code Review'));
    console.log();
    
    const projectRoot = ctx.config.projectRoot || process.cwd();
    
    // Check if git repo
    const gitDir = join(projectRoot, '.git');
    
    if (!existsSync(gitDir)) {
      console.log(chalk.yellow('⚠  Not a git repository'));
      console.log(chalk.dim('Code review works best with git tracking'));
      console.log();
      return true;
    }
    
    try {
      // Get recent changes
      const { stdout: statusOutput } = await execa('git', ['diff', '--cached', '--stat'], {
        cwd: projectRoot,
        reject: false,
      });
      
      if (!statusOutput.trim()) {
        // Check unstaged changes
        const { stdout: unstagedOutput } = await execa('git', ['diff', '--stat'], {
          cwd: projectRoot,
          reject: false,
        });
        
        if (!unstagedOutput.trim()) {
          console.log(chalk.green('✓ No changes to review'));
          console.log();
          console.log(chalk.dim('Make some changes and run /review again'));
          console.log();
          return true;
        }
        
        console.log(chalk.bold('Unstaged Changes:'));
        console.log();
        console.log(unstagedOutput);
        console.log();
      } else {
        console.log(chalk.bold('Staged Changes:'));
        console.log();
        console.log(statusOutput);
        console.log();
      }
      
      // Review summary
      console.log(chalk.bold('Review Checklist:'));
      console.log();
      console.log(`  ${chalk.white('□')} Code follows project style`);
      console.log(`  ${chalk.white('□')} Tests included for new features`);
      console.log(`  ${chalk.white('□')} No console.log or debug statements`);
      console.log(`  ${chalk.white('□')} Error handling in place`);
      console.log(`  ${chalk.white('□')} No hardcoded secrets or credentials`);
      console.log();
      
      console.log(chalk.dim('Tip: Stage changes with: git add <file>'));
      console.log(chalk.dim('     View full diff: git diff'));
      console.log();
      
    } catch (err) {
      console.log(chalk.red('Error running code review'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }
    
    return true;
  },
};
