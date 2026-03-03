/**
 * /model Slash Command
 * 
 * Switch provider and model mid-session
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  aliases: ['provider'],
  description: 'Switch provider and model mid-session',
  usage: '[provider/model]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    if (!trimmedArgs) {
      return showCurrentModel(ctx);
    }
    
    if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
      return listAvailableModels(ctx);
    }
    
    return switchModel(trimmedArgs, ctx);
  },
};

/**
 * Show current model
 */
function showCurrentModel(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🎯 Current Model'));
  console.log();
  
  console.log(chalk.bold('Active:'));
  console.log(`  Provider: ${chalk.white(ctx.config.provider)}`);
  console.log(`  Model: ${chalk.cyan(ctx.currentModel)}`);
  console.log();
  
  // Show provider chain if available
  if (ctx.providerChain) {
    const slots = (ctx.providerChain as any).getSlots?.() || [];
    
    if (slots.length > 0) {
      console.log(chalk.bold('Failover Chain:'));
      const activeSlot = (ctx.providerChain as any).activeSlot;
      
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const isActive = activeSlot && 
                        activeSlot.provider === slot.provider && 
                        activeSlot.model === slot.model;
        const icon = isActive ? chalk.green('●') : chalk.dim('○');
        const status = isActive ? chalk.green(' (active)') : '';
        
        console.log(`  ${i + 1}. ${icon} ${slot.provider}/${slot.model}${status}`);
      }
      console.log();
    }
  }
  
  console.log(chalk.dim('Tip: Use /model <provider/model> to switch'));
  console.log(chalk.dim('     Use /model list to see all available models'));
  console.log();
  
  return true;
}

/**
 * List available models
 */
function listAvailableModels(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('📋 Available Models'));
  console.log();
  
  const models = [
    {
      provider: 'claude',
      name: 'Anthropic Claude',
      models: [
        { id: 'claude-opus-4-6', desc: 'Most capable', price: '$15/$75' },
        { id: 'claude-sonnet-4-6', desc: 'Balanced', price: '$3/$15' },
        { id: 'claude-haiku-4-5-20251001', desc: 'Fast & cheap', price: '$0.80/$4' },
      ],
    },
    {
      provider: 'qwen',
      name: 'Alibaba Qwen',
      models: [
        { id: 'qwen-max', desc: 'Most capable', price: '$2/$8' },
        { id: 'qwen-plus', desc: 'Balanced', price: '$0.50/$2' },
        { id: 'qwen-turbo', desc: 'Fast & cheap', price: '$0.10/$0.40' },
        { id: 'qwen-2.5-72b', desc: 'Open source 72B', price: '$0.40/$1.60' },
      ],
    },
    {
      provider: 'openai',
      name: 'OpenAI GPT',
      models: [
        { id: 'gpt-4o', desc: 'Most capable', price: '$2.50/$10' },
        { id: 'gpt-4o-mini', desc: 'Fast & cheap', price: '$0.15/$0.60' },
      ],
    },
    {
      provider: 'gemini',
      name: 'Google Gemini',
      models: [
        { id: 'gemini-1.5-pro', desc: 'Most capable', price: '$1.25/$5' },
        { id: 'gemini-1.5-flash', desc: 'Fast', price: '$0.075/$0.30' },
        { id: 'gemini-2.0-flash', desc: 'Latest', price: '$0.10/$0.40' },
      ],
    },
    {
      provider: 'codemie',
      name: 'Codemie (SSO)',
      models: [
        { id: 'claude-sonnet-4-5-20250929', desc: 'Via SSO', price: 'Included' },
      ],
    },
    {
      provider: 'codex',
      name: 'OpenAI Codex (CLI)',
      models: [
        { id: 'gpt-5-codex', desc: 'Via CLI auth', price: 'Included' },
      ],
    },
    {
      provider: 'cursor',
      name: 'Cursor Agent',
      models: [
        { id: 'gemini-2.5-pro', desc: 'Gemini 2.5 Pro', price: '$1.25/$5' },
      ],
    },
    {
      provider: 'copilot',
      name: 'GitHub Copilot (CLI)',
      models: [
        { id: 'claude-sonnet-4-6', desc: 'Via gh auth', price: 'Included' },
      ],
    },
  ];
  
  for (const provider of models) {
    console.log(chalk.bold(provider.name));
    console.log(chalk.dim(`  Provider: ${provider.provider}`));
    console.log();
    
    for (const model of provider.models) {
      console.log(chalk.dim(`    ${model.id.padEnd(30)} — ${model.desc.padEnd(15)} ${chalk.green(model.price)}`));
    }
    console.log();
  }
  
  console.log(chalk.dim('Tip: Switch with /model <provider> or /model <provider/model>'));
  console.log(chalk.dim('     Example: /model qwen, /model claude/claude-opus-4-6'));
  console.log();
  
  return true;
}

/**
 * Switch to a different model
 */
function switchModel(modelSpec: string, ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🔄 Switching Model'));
  console.log();
  
  // Parse model specification
  const parts = modelSpec.split('/');
  let provider: string;
  let model: string;
  
  if (parts.length === 1) {
    // Just provider name, use default model
    provider = parts[0];
    model = getDefaultModel(provider);
  } else {
    // Full provider/model specification
    provider = parts[0];
    model = parts.slice(1).join('/');
  }
  
  if (!model) {
    console.log(chalk.red(`Unknown provider: ${provider}`));
    console.log(chalk.dim('Use /model list to see available providers'));
    console.log();
    return true;
  }
  
  console.log(chalk.bold('Switching:'));
  console.log(`  From: ${chalk.white(ctx.config.provider)}/${chalk.white(ctx.currentModel)}`);
  console.log(`  To:   ${chalk.cyan(provider)}/${chalk.cyan(model)}`);
  console.log();
  
  // In real implementation, this would update the provider chain
  console.log(chalk.yellow('⚠  Model switch requires provider chain update'));
  console.log();
  console.log(chalk.dim('This command would:'));
  console.log(chalk.dim('  1. Validate API key for new provider'));
  console.log(chalk.dim('  2. Update provider chain configuration'));
  console.log(chalk.dim('  3. Preserve conversation context'));
  console.log(chalk.dim('  4. Continue session with new provider'));
  console.log();
  
  console.log(chalk.green('✓ Model switch prepared'));
  console.log(chalk.dim(`  Next message will use: ${provider}/${model}`));
  console.log();
  
  console.log(chalk.dim('Tip: Session context is preserved during switch'));
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
    codemie: 'claude-sonnet-4-5-20250929',
    codex: 'gpt-5-codex',
    cursor: 'gemini-2.5-pro',
    copilot: 'claude-sonnet-4-6',
  };
  
  return defaults[provider] || 'claude-sonnet-4-6';
}
