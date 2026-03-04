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

const PROVIDER_MODELS: Record<string, Array<{ id: string; desc: string; price: string }>> = {
  claude:  [
    { id: 'claude-opus-4-6',              desc: 'Most capable',  price: '$15/$75' },
    { id: 'claude-sonnet-4-6',            desc: 'Balanced',      price: '$3/$15'  },
    { id: 'claude-haiku-4-5-20251001',    desc: 'Fast & cheap',  price: '$0.80/$4'},
  ],
  qwen: [
    { id: 'qwen-max',      desc: 'Most capable',    price: '$2/$8'       },
    { id: 'qwen-plus',     desc: 'Balanced',         price: '$0.50/$2'   },
    { id: 'qwen-turbo',    desc: 'Fast & cheap',     price: '$0.10/$0.40'},
    { id: 'qwen-2.5-72b',  desc: 'Open source 72B',  price: '$0.40/$1.60'},
  ],
  openai: [
    { id: 'gpt-4o',        desc: 'Most capable', price: '$2.50/$10' },
    { id: 'gpt-4o-mini',   desc: 'Fast & cheap', price: '$0.15/$0.60'},
  ],
  gemini: [
    { id: 'gemini-1.5-pro',   desc: 'Most capable', price: '$1.25/$5'  },
    { id: 'gemini-1.5-flash', desc: 'Fast',          price: '$0.075/$0.30'},
    { id: 'gemini-2.0-flash', desc: 'Latest',        price: '$0.10/$0.40'},
  ],
  codemie: [{ id: 'claude-sonnet-4-5-20250929', desc: 'Via SSO',     price: 'Included' }],
  codex:   [{ id: 'gpt-5-codex',               desc: 'Via CLI auth', price: 'Included' }],
  cursor:  [{ id: 'gemini-3.1-pro',             desc: 'Gemini 3.1',  price: '$1.25/$5' }],
  copilot: [{ id: 'claude-sonnet-4-6',          desc: 'Via gh auth', price: 'Included' }],
};

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
  console.log(`  Active: ${chalk.white(ctx.config.provider)}/${chalk.cyan(ctx.currentModel)}`);
  console.log();

  const providerKey = ctx.config.provider;
  const models = PROVIDER_MODELS[providerKey];

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
  console.log(chalk.dim('  Provider unchanged: ' + ctx.config.provider));
  console.log();
  return true;
}

