/**
 * /model Slash Command
 *
 * List or switch the model within the current provider.
 *
 * Usage:
 *   /model              — show current model + list for this provider
 *   /model <name>       — switch to model (same provider)
 *
 * To switch provider use: /provider <name>
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { readProviders } from '../DataConfig.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  aliases: ['models'],
  description: 'List or switch model for the current provider',
  usage: '[<model-name>]',

  async execute(args, ctx): Promise<boolean> {
    const trimmed = args.trim();

    if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
      return showModels(ctx);
    }

    return switchModel(trimmed, ctx);
  },
};

function showModels(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🎯 Model'));
  console.log();
  console.log(`  Active: ${chalk.white(ctx.currentProvider)}/${chalk.cyan(ctx.currentModel)}`);
  console.log();

  // 'anthropic' and 'claude' are aliases for the same provider
  const providerKey = ctx.currentProvider === 'anthropic' ? 'claude' : ctx.currentProvider;
  const providers = readProviders();
  const entry = providers[providerKey];
  const models = entry?.models;

  if (models) {
    console.log(chalk.bold(`Models for ${providerKey}:`));
    for (const m of models) {
      const active = m.id === ctx.currentModel ? chalk.green(' ← active') : '';
      console.log(`  ${chalk.cyan(m.id.padEnd(35))} ${chalk.dim(m.desc.padEnd(15))} ${chalk.green(m.price)}${active}`);
    }
  } else {
    console.log(chalk.dim(`  No model list defined for provider: ${providerKey}`));
  }

  console.log();
  console.log(chalk.dim('Switch model:    /model <name>'));
  console.log(chalk.dim('Switch provider: /provider <name>'));
  console.log();
  return true;
}

function switchModel(modelName: string, ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🔄 Switching Model'));
  console.log();
  console.log(`  From: ${chalk.dim(ctx.currentModel)}`);
  console.log(`  To:   ${chalk.white(modelName)}`);
  console.log();

  ctx.onModelChange(modelName);

  console.log(chalk.green('✓ Model switched'));
  console.log(chalk.dim('  Provider unchanged: ' + ctx.currentProvider));
  console.log();
  return true;
}

