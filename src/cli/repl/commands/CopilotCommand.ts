/**
 * /copilot Slash Command
 * 
 * GitHub Copilot CLI authentication and status
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { CopilotProvider } from '../../providers/copilot/CopilotProvider.js';
import { execa } from 'execa';

export const copilotCommand: SlashCommand = {
  name: 'copilot',
  aliases: ['gh-copilot'],
  description: 'GitHub Copilot CLI authentication and status',
  usage: '[status|login|logout]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim().toLowerCase();
    
    if (!trimmedArgs || trimmedArgs === 'status') {
      return showStatus(ctx);
    }
    
    if (trimmedArgs === 'login') {
      return login(ctx);
    }
    
    if (trimmedArgs === 'logout') {
      return logout(ctx);
    }
    
    console.log(chalk.red(`Unknown copilot command: ${trimmedArgs}`));
    console.log(chalk.dim('Usage: /copilot [status|login|logout]'));
    console.log();
    
    return true;
  },
};

/**
 * Show Copilot status
 */
async function showStatus(ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🤖 GitHub Copilot Status'));
  console.log();
  
  // Check if CLI is available
  const available = await CopilotProvider.isAvailable();
  
  if (!available) {
    console.log(chalk.yellow('⚠  Copilot CLI not installed'));
    console.log();
    console.log(chalk.dim('Install with:'));
    console.log(chalk.dim('  npm install -g @github/copilot'));
    console.log();
    return true;
  }
  
  console.log(chalk.green('✓ Copilot CLI installed'));
  console.log();
  
  // Check authentication
  const authenticated = await CopilotProvider.isAuthenticated();
  
  if (authenticated) {
    console.log(chalk.green('✓ Authenticated'));
    console.log();
    
    // Check for env var
    const envToken = process.env.COPILOT_GITHUB_TOKEN || 
                    process.env.GH_TOKEN || 
                    process.env.GITHUB_TOKEN;
    
    if (envToken) {
      const tokenType = envToken.startsWith('github_pat_') ? 'Fine-grained PAT' :
                       envToken.startsWith('gho_') ? 'OAuth' :
                       envToken.startsWith('ghu_') ? 'GitHub App' : 'Unknown';
      console.log(chalk.dim(`  Auth method: ${chalk.white(tokenType)} (env var)`));
    } else {
      console.log(chalk.dim(`  Auth method: ${chalk.white('Copilot CLI')} (device flow)`));
    }
    console.log();
    
    // Try to get status from CLI
    try {
      const { stdout } = await execa('copilot', ['status'], { reject: false });
      if (stdout) {
        console.log(chalk.bold('CLI Status:'));
        console.log(chalk.dim(stdout));
      }
    } catch {
      // Ignore errors
    }
  } else {
    console.log(chalk.red('✗ Not authenticated'));
    console.log();
    console.log(chalk.bold('Authenticate with:'));
    console.log(chalk.dim('  /copilot login'));
    console.log();
    console.log(chalk.dim('Or set environment variable:'));
    console.log(chalk.dim('  COPILOT_GITHUB_TOKEN=github_pat_xxx'));
    console.log();
  }
  
  return true;
}

/**
 * Login to Copilot
 */
async function login(ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🔐 GitHub Copilot Login'));
  console.log();
  
  // Check if already authenticated via env
  const envToken = process.env.COPILOT_GITHUB_TOKEN || 
                  process.env.GH_TOKEN || 
                  process.env.GITHUB_TOKEN;
  
  if (envToken) {
    console.log(chalk.yellow('⚠  Environment variable detected'));
    console.log();
    console.log(chalk.dim(`COPILOT_GITHUB_TOKEN is set (${envToken.substring(0, 15)}...)`));
    console.log(chalk.dim('Unset it first if you want to use device flow:'));
    console.log(chalk.dim('  unset COPILOT_GITHUB_TOKEN'));
    console.log();
  }
  
  console.log(chalk.bold('Starting device flow authentication...'));
  console.log();
  console.log(chalk.dim('This will open your browser to authenticate.'));
  console.log(chalk.dim('Follow the instructions in the browser.'));
  console.log();
  
  try {
    const child = execa('copilot', ['login'], {
      stdio: 'inherit',
      reject: false,
    });
    
    const { exitCode } = await child;
    
    if (exitCode === 0) {
      console.log();
      console.log(chalk.green('✓ Authentication successful'));
      console.log();
      console.log(chalk.dim('You can now use:'));
      console.log(chalk.dim('  /model copilot'));
      console.log(chalk.dim('  epam chat --provider copilot'));
      console.log();
    } else {
      console.log();
      console.log(chalk.red('✗ Authentication failed'));
      console.log();
    }
  } catch (err) {
    console.log(chalk.red('Error: Copilot CLI not found'));
    console.log();
    console.log(chalk.dim('Install with:'));
    console.log(chalk.dim('  npm install -g @github/copilot'));
    console.log();
  }
  
  return true;
}

/**
 * Logout from Copilot
 */
async function logout(ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🚪 GitHub Copilot Logout'));
  console.log();
  
  try {
    const { exitCode } = await execa('copilot', ['logout'], {
      stdio: 'inherit',
      reject: false,
    });
    
    if (exitCode === 0) {
      console.log();
      console.log(chalk.green('✓ Logged out successfully'));
      console.log();
    } else {
      console.log();
      console.log(chalk.yellow('⚠  Logout completed with warnings'));
      console.log();
    }
  } catch (err) {
    console.log(chalk.red('Error: Copilot CLI not found'));
    console.log();
    console.log(chalk.dim('Install with:'));
    console.log(chalk.dim('  npm install -g @github/copilot'));
    console.log();
  }
  
  return true;
}
