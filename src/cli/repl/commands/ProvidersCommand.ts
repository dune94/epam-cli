/**
 * /providers Slash Command
 * 
 * Shows provider status and allows authentication management.
 */

import chalk from 'chalk';
import { execa } from 'execa';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const providersCommand: SlashCommand = {
  name: 'providers',
  aliases: ['prov', 'p'],
  description: 'Show provider status and manage authentication',
  usage: '[list|auth <name>]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    // No args - show status
    if (!trimmedArgs) {
      return showProviderStatus(ctx);
    }
    
    // Parse subcommand
    const parts = trimmedArgs.split(/\s+/);
    const subcommand = parts[0].toLowerCase();
    
    if (subcommand === 'list' || subcommand === 'ls') {
      return showProviderStatus(ctx);
    } else if (subcommand === 'auth' || subcommand === 'login') {
      const providerName = parts[1];
      if (!providerName) {
        console.log(chalk.red('Error: Provider name required'));
        console.log(chalk.dim('Usage: /providers auth <name>'));
        console.log(chalk.dim('Example: /providers auth codex'));
        return true;
      }
      return await authenticateProvider(providerName, ctx);
    } else if (subcommand === 'help') {
      showHelp();
      return true;
    } else {
      console.log(chalk.red(`Unknown command: ${subcommand}`));
      showHelp();
      return true;
    }
  },
};

/**
 * Show provider status
 */
function showProviderStatus(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold('Provider Status:'));
  console.log();
  
  const chain = ctx.providerChain;
  if (!chain) {
    console.log(chalk.dim('  No provider chain configured.'));
    console.log();
    return true;
  }
  
  // Get chain slots (cast to access internal structure)
  const chainAny = chain as unknown as { 
    getSlots?: () => Array<{ provider: string; model: string }>;
    activeSlot?: { provider: string; model: string };
    options?: { slots: Array<{ provider: string; model: string }> };
  };
  
  const slots = chainAny.getSlots?.() || chainAny.options?.slots || [];
  const activeSlot = chainAny.activeSlot;
  
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const isActive = activeSlot && 
                    activeSlot.provider === slot.provider && 
                    activeSlot.model === slot.model;
    
    const status = isActive ? 'active' : (i === 0 ? 'primary' : 'failover');
    const icon = isActive ? chalk.green('✓') : chalk.dim('○');
    const statusColor = isActive ? chalk.green : chalk.dim;
    
    console.log(
      `${icon} ${slot.provider}/${slot.model}`.padEnd(35) +
      statusColor(` (${status})`)
    );
  }
  
  console.log();
  console.log(chalk.dim('Commands:'));
  console.log(chalk.dim('  /providers auth <name>  - Authenticate a provider'));
  console.log(chalk.dim('  /providers list         - Show this status'));
  console.log();
  
  return true;
}

/**
 * Authenticate a provider
 */
async function authenticateProvider(providerName: string, ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold(`Authenticating: ${providerName}`));
  console.log();
  
  try {
    // Use context auth callback if available (for inline auth)
    if (ctx.onAuthenticateProvider) {
      const success = await ctx.onAuthenticateProvider(providerName);
      if (success) {
        console.log(chalk.green(`  ✓ ${providerName} authenticated successfully`));
      } else {
        console.log(chalk.yellow(`  ⚠ ${providerName} authentication failed or cancelled`));
      }
      console.log();
      return true;
    }
    
    // Fallback to direct auth
    if (providerName === 'codex') {
      // First check if already authenticated
      const { existsSync } = await import('fs');
      const { homedir } = await import('os');
      const { join } = await import('path');
      
      const authFilePath = join(homedir(), '.codex', 'auth.json');
      
      if (existsSync(authFilePath)) {
        console.log();
        console.log(chalk.green('  ✓ Codex is already authenticated'));
        console.log(chalk.dim(`  Auth file: ${authFilePath}`));
        console.log();
        console.log(chalk.dim('  Codex is available for failover.'));
        console.log(chalk.dim('  To re-authenticate, first run: rm ~/.codex/auth.json'));
        console.log();
        return true;
      }
      
      // Not authenticated - proceed with auth flow
      console.log();
      console.log(chalk.bold('  Codex Authentication'));
      console.log();
      console.log(chalk.dim('  Codex CLI uses browser-based authentication.'));
      console.log(chalk.dim('  In the Codex CLI, select "Sign in with ChatGPT".'));
      console.log();
      console.log(chalk.dim('  After completing auth, type /exit in Codex CLI to return here.'));
      console.log();
      console.log(chalk.yellow('  Starting Codex CLI...'));
      console.log();
      
      // Flush console to ensure messages appear before Codex takes over
      await new Promise(resolve => setTimeout(resolve, 100));

      const { exitCode } = await execa('codex', [], {
        stdio: 'inherit',
        timeout: 300000,
        reject: false,
      });

      // CRITICAL: Clear any residual terminal state from Codex
      // Clear screen and reposition cursor
      process.stdout.write('\x1B[2J\x1B[0H');
      
      // Visual break
      console.log();
      console.log('─'.repeat(60));
      console.log();
      
      if (exitCode === 0) {
        console.log(chalk.green('  ✓ Welcome back to EPAM CLI'));
        console.log(chalk.dim('  Codex is now available for failover.'));
        console.log();
        console.log(chalk.dim('  Type your message to continue chatting, or run /providers to check status.'));
      } else {
        console.log(chalk.yellow('  ⚠ Codex session ended'));
        console.log();
        console.log(chalk.dim('  Run /providers auth codex to try again.'));
      }
      console.log();
      
      // Force prompt to reappear with explicit newline
      process.stdout.write('\n');
    } else if (providerName === 'codemie') {
      console.log(chalk.dim('  Opening browser for Codemie OAuth...'));
      console.log(chalk.dim('  Complete sign-in in the browser window.\n'));
      
      const { exitCode } = await execa('node', ['dist/epam.js', 'provider', 'login', 'codemie'], {
        stdio: 'inherit',
        cwd: process.cwd(),
        timeout: 300000,
        reject: false,
      });
      
      if (exitCode === 0) {
        console.log();
        console.log(chalk.green('  ✓ Codemie authenticated successfully'));
      } else {
        console.log();
        console.log(chalk.yellow('  ⚠ Codemie authentication failed or was cancelled'));
      }
    } else if (['anthropic', 'openai', 'gemini'].includes(providerName)) {
      console.log(chalk.dim(`  Enter your ${providerName} API key:\n`));
      
      const { apiKey } = await import('prompts').then(m => m.default([
        {
          type: 'password',
          name: 'apiKey',
          message: `${providerName} API key`,
          validate: (v: string) => v.trim().length > 0 ? true : 'API key cannot be empty',
        },
      ]));
      
      if (apiKey) {
        const { saveProviderCredential } = await import('../../auth/ProviderCredentialStore.js');
        await saveProviderCredential({
          provider: providerName as 'anthropic' | 'openai' | 'gemini',
          type: 'api_key',
          source: 'manual_api_key',
          secret: apiKey.trim(),
          createdAt: new Date().toISOString(),
        });
        
        console.log();
        console.log(chalk.green(`  ✓ ${providerName} API key saved`));
      }
    } else {
      console.log(chalk.red(`  Unknown provider: ${providerName}`));
      console.log(chalk.dim('  Supported: codemie, codex, anthropic, openai, gemini'));
    }
    
    console.log();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  Authentication error: ${message}`));
    console.log();
    return true;
  }
}

/**
 * Show help
 */
function showHelp(): void {
  console.log();
  console.log(chalk.bold('Provider Management Commands:'));
  console.log();
  console.log(chalk.cyan('  /providers') + ' or ' + chalk.cyan('/providers list'));
  console.log(chalk.dim('    Show status of all configured providers'));
  console.log();
  console.log(chalk.cyan('  /providers auth <name>'));
  console.log(chalk.dim('    Authenticate a provider'));
  console.log(chalk.dim('    Supported: codemie, codex, anthropic, openai, gemini'));
  console.log();
  console.log(chalk.cyan('  /providers help'));
  console.log(chalk.dim('    Show this help message'));
  console.log();
}
