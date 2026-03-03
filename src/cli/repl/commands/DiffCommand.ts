/**
 * /diff Slash Command
 * 
 * Show all file changes made this session
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { execa } from 'execa';
import { existsSync } from 'fs';
import { join } from 'path';

export const diffCommand: SlashCommand = {
  name: 'diff',
  aliases: ['changes'],
  description: 'Show all file changes made this session',
  
  async execute(_args, ctx): Promise<boolean> {
    console.log();
    console.log(chalk.bold.cyan('📝 Session File Changes'));
    console.log();
    
    const projectRoot = ctx.config.projectRoot || process.cwd();
    
    // Check if git repo
    const gitDir = join(projectRoot, '.git');
    
    if (!existsSync(gitDir)) {
      console.log(chalk.dim('Not a git repository - showing recent file modifications'));
      console.log();
      console.log(chalk.dim('Tip: Initialize git to track changes: git init'));
      console.log();
      return true;
    }
    
    try {
      // Get git status
      const { stdout: statusOutput } = await execa('git', ['status', '--short'], {
        cwd: projectRoot,
        reject: false,
      });
      
      if (!statusOutput.trim()) {
        console.log(chalk.green('✓ No changes'));
        console.log();
        console.log(chalk.dim('Files modified during this session will appear here'));
        console.log();
        return true;
      }
      
      const lines = statusOutput.split('\n').filter(Boolean);
      
      console.log(chalk.bold('Modified Files:'));
      console.log();
      
      let added = 0;
      let modified = 0;
      let deleted = 0;
      
      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        
        if (status.includes('A')) {
          console.log(`  ${chalk.green('+')} ${file}`);
          added++;
        } else if (status.includes('D')) {
          console.log(`  ${chalk.red('-')} ${file}`);
          deleted++;
        } else {
          console.log(`  ${chalk.yellow('M')} ${file}`);
          modified++;
        }
      }
      
      console.log();
      console.log(chalk.bold('Summary:'));
      console.log(`  ${chalk.green(`+${added} added`)}`);
      console.log(`  ${chalk.yellow(`${modified} modified`)}`);
      console.log(`  ${chalk.red(`-${deleted} deleted`)}`);
      console.log();
      
      // Show diff for first file
      if (lines.length > 0) {
        const firstFile = lines[0].substring(3).split(' ')[0];
        console.log(chalk.dim(`Tip: View full diff with: git diff ${firstFile}`));
        console.log();
      }
      
    } catch (err) {
      console.log(chalk.red('Error getting file changes'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }
    
    return true;
  },
};
