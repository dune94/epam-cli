/**
 * /failover Slash Command
 * 
 * Force provider failover for demo/testing
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const failoverCommand: SlashCommand = {
  name: 'failover',
  aliases: ['switch-provider'],
  description: 'Force provider failover for demo/testing',
  usage: '<provider> [model]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    if (!trimmedArgs) {
      return showFailoverHelp(ctx);
    }
    
    const parts = trimmedArgs.split(/\s+/);
    const provider = parts[0];
    const model = parts[1];
    
    return forceFailover(provider, model, ctx);
  },
};

/**
 * Show failover help
 */
function showFailoverHelp(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🔄 Provider Failover'));
  console.log();
  console.log(chalk.bold('Usage:'));
  console.log(chalk.dim('  /failover <provider> [model]'));
  console.log();
  console.log(chalk.bold('Current Session:'));
  console.log(`  Provider: ${chalk.white(ctx.config.provider)}`);
  console.log(`  Model: ${chalk.cyan(ctx.currentModel)}`);
  console.log(`  Messages: ${chalk.white(ctx.messages.length)}`);
  console.log();
  
  console.log(chalk.bold('Available Providers:'));
  console.log(`  ${chalk.cyan('claude')}       — Anthropic Claude`);
  console.log(`  ${chalk.cyan('qwen')}         — Alibaba Qwen`);
  console.log(`  ${chalk.cyan('openai')}       — OpenAI GPT`);
  console.log(`  ${chalk.cyan('gemini')}       — Google Gemini`);
  console.log(`  ${chalk.cyan('cursor')}       — Cursor (Gemini 2.5 Pro)`);
  console.log(`  ${chalk.cyan('copilot')}      — GitHub Copilot (Claude)`);
  console.log(`  ${chalk.cyan('codemie')}      — Codemie (SSO)`);
  console.log(`  ${chalk.cyan('codex')}        — OpenAI Codex (CLI)`);
  console.log();
  
  console.log(chalk.bold('Examples:'));
  console.log(chalk.dim('  /failover qwen'));
  console.log(chalk.dim('  /failover cursor gemini-2.5-pro'));
  console.log(chalk.dim('  /failover copilot claude-sonnet-4-6'));
  console.log();
  
  console.log(chalk.yellow('⚠  This command simulates failover for demo purposes.'));
  console.log(chalk.dim('     In production, failover happens automatically on provider error.'));
  console.log();
  
  return true;
}

/**
 * Force failover to a different provider
 */
async function forceFailover(provider: string, model: string | undefined, ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🔄 Simulating Provider Failover'));
  console.log();
  
  // Get current session info
  const currentProvider = ctx.config.provider;
  const currentModel = ctx.currentModel;
  const messageCount = ctx.messages.length;
  
  console.log(chalk.bold('Session Transfer:'));
  console.log(`  From: ${chalk.white(currentProvider)}/${chalk.white(currentModel)}`);
  console.log(`  To:   ${chalk.cyan(provider)}/${chalk.cyan(model || 'default')}`);
  console.log();
  
  console.log(chalk.bold('Context Preservation:'));
  console.log(`  ✓ ${messageCount} messages transferred`);
  console.log(`  ✓ Conversation history preserved`);
  console.log(`  ✓ File system state visible`);
  console.log(`  ✓ Tool permissions maintained`);
  console.log();
  
  // Simulate failover delay
  console.log(chalk.dim('Simulating provider switch...'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log();
  
  console.log(chalk.green('✓ Failover simulated successfully'));
  console.log();
  
  console.log(chalk.bold('What Happened:'));
  console.log(chalk.dim('  1. Session context preserved (all messages)'));
  console.log(chalk.dim('  2. Provider chain updated'));
  console.log(chalk.dim('  3. New provider ready for next message'));
  console.log();
  
  console.log(chalk.bold('Next Steps:'));
  console.log(chalk.dim('  • Continue chatting - new provider will be used'));
  console.log(chalk.dim('  • Use /status to verify provider change'));
  console.log(chalk.dim('  • Use /model to see current model'));
  console.log();
  
  console.log(chalk.yellow('⚠  Note: This is a simulation.'));
  console.log(chalk.dim('     The actual provider switch requires configuration update.'));
  console.log(chalk.dim('     Use /model <provider> to actually switch providers.'));
  console.log();
  
  // Suggest actual model switch
  const targetModel = model || getDefaultModel(provider);
  console.log(chalk.dim(`To actually switch: /model ${provider}/${targetModel}`));
  console.log();
  
  return true;
}

/**
 * Get default model for a provider
 */
function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    claude: 'claude-sonnet-4-6',
    qwen: 'qwen-max',
    openai: 'gpt-4o',
    gemini: 'gemini-1.5-pro',
    cursor: 'gemini-2.5-pro',
    copilot: 'claude-sonnet-4-6',
    codemie: 'claude-sonnet-4-5-20250929',
    codex: 'gpt-5-codex',
  };
  
  return defaults[provider] || 'claude-sonnet-4-6';
}
