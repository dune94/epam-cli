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
  // ─── Anthropic (direct BYOK) ──────────────────────────────────────────────
  claude: [
    { id: 'claude-opus-4-6',            desc: 'Most capable',         price: '$15/$75'    },
    { id: 'claude-opus-4-6-fast',       desc: 'Opus fast mode',       price: '$15/$75'    },
    { id: 'claude-opus-4-5',            desc: 'Previous Opus',        price: '$15/$75'    },
    { id: 'claude-sonnet-4-6',          desc: 'Balanced (default)',   price: '$3/$15'     },
    { id: 'claude-sonnet-4-5',          desc: 'Previous Sonnet',      price: '$3/$15'     },
    { id: 'claude-sonnet-4',            desc: 'Sonnet 4',             price: '$3/$15'     },
    { id: 'claude-3-7-sonnet-20250219', desc: 'Extended thinking',    price: '$3/$15'     },
    { id: 'claude-3-5-sonnet-20241022', desc: 'Claude 3.5 Sonnet',    price: '$3/$15'     },
    { id: 'claude-haiku-4-5',           desc: 'Fast & cheap',         price: '$0.80/$4'   },
    { id: 'claude-haiku-4-5-20251001',  desc: 'Haiku dated',          price: '$0.80/$4'   },
    { id: 'claude-3-5-haiku-20241022',  desc: 'Claude 3.5 Haiku',     price: '$0.80/$4'   },
  ],
  // ─── OpenAI (direct BYOK) ─────────────────────────────────────────────────
  openai: [
    { id: 'gpt-4o',         desc: 'GPT-4o flagship',       price: '$2.50/$10'  },
    { id: 'gpt-4o-mini',    desc: 'GPT-4o lite',           price: '$0.15/$0.60'},
    { id: 'gpt-4.1',        desc: 'GPT-4.1 (default)',     price: '$2/$8'      },
    { id: 'gpt-4.1-mini',   desc: 'GPT-4.1 mini',         price: '$0.40/$1.60'},
    { id: 'gpt-4.1-nano',   desc: 'GPT-4.1 nano',         price: '$0.10/$0.40'},
    { id: 'gpt-4-turbo',    desc: 'GPT-4 Turbo',          price: '$10/$30'    },
    { id: 'gpt-5',          desc: 'GPT-5 flagship',        price: '$10/$40'    },
    { id: 'gpt-5-mini',     desc: 'GPT-5 mini',           price: '$0.15/$0.60'},
    { id: 'o4-mini',        desc: 'Latest reasoning',      price: '$1.10/$4.40'},
    { id: 'o3',             desc: 'Advanced reasoning',    price: '$10/$40'    },
    { id: 'o3-mini',        desc: 'o3 compact',            price: '$1.10/$4.40'},
    { id: 'o1',             desc: 'Original reasoning',    price: '$15/$60'    },
    { id: 'o1-mini',        desc: 'o1 compact',            price: '$3/$12'     },
  ],
  // ─── Gemini (direct BYOK) ─────────────────────────────────────────────────
  gemini: [
    { id: 'gemini-2.5-pro',       desc: 'Most capable',     price: '$1.25/$5'    },
    { id: 'gemini-2.5-flash',     desc: 'Fast & cheap',     price: '$0.15/$0.60' },
    { id: 'gemini-2.0-flash',     desc: 'Latest gen',       price: '$0.10/$0.40' },
    { id: 'gemini-2.0-flash-lite',desc: 'Ultra cheap',      price: '$0.075/$0.30'},
    { id: 'gemini-2.0-flash-thinking', desc: 'With thinking', price: '$0.15/$0.60' },
    { id: 'gemini-1.5-pro',       desc: 'Proven flagship',  price: '$1.25/$5'    },
    { id: 'gemini-1.5-flash',     desc: 'Fast 1.5',         price: '$0.075/$0.30'},
    { id: 'gemini-1.5-flash-8b',  desc: 'Smallest',         price: '$0.0375/$0.15'},
  ],
  // ─── Qwen / OpenRouter ────────────────────────────────────────────────────
  qwen: [
    { id: 'qwen/qwen-2.5-72b-instruct',      desc: 'Qwen 2.5 72B (default)',   price: '$0.40/$1.60' },
    { id: 'qwen/qwen-2.5-7b-instruct',       desc: 'Qwen 2.5 7B compact',      price: '$0.04/$0.12' },
    { id: 'qwen/qwq-32b',                    desc: 'QwQ 32B reasoning',         price: '$0.20/$0.60' },
    { id: 'qwen/qwen3-235b-a22b',            desc: 'Qwen3 235B MoE flagship',   price: '$0.60/$2.40' },
    { id: 'qwen/qwen3-72b',                  desc: 'Qwen3 72B',                 price: '$0.40/$1.60' },
    { id: 'qwen/qwen3-32b',                  desc: 'Qwen3 32B',                 price: '$0.18/$0.90' },
    { id: 'qwen/qwen3-14b',                  desc: 'Qwen3 14B',                 price: '$0.10/$0.50' },
    { id: 'qwen/qwen3-8b',                   desc: 'Qwen3 8B',                  price: '$0.06/$0.30' },
    { id: 'deepseek/deepseek-r1',            desc: 'DeepSeek R1 reasoning',     price: '$0.55/$2.19' },
    { id: 'deepseek/deepseek-chat',          desc: 'DeepSeek V3 chat',          price: '$0.27/$1.10' },
    { id: 'meta-llama/llama-3.3-70b-instruct', desc: 'Llama 3.3 70B',          price: '$0.12/$0.12' },
    { id: 'meta-llama/llama-4-scout',        desc: 'Llama 4 Scout',             price: '$0.17/$0.17' },
    { id: 'mistral/mistral-large-2411',      desc: 'Mistral Large',             price: '$2.00/$6.00' },
    { id: 'mistral/mistral-small-3.1',       desc: 'Mistral Small',             price: '$0.10/$0.30' },
  ],
  // ─── GitHub Copilot (gh auth) ─────────────────────────────────────────────
  copilot: [
    { id: 'claude-sonnet-4-6',    desc: 'Balanced (default)',   price: 'Included' },
    { id: 'claude-opus-4-6',      desc: 'Most capable',         price: 'Included' },
    { id: 'claude-opus-4-6-fast', desc: 'Opus fast mode',       price: 'Included' },
    { id: 'claude-opus-4-5',      desc: 'Previous Opus',        price: 'Included' },
    { id: 'claude-sonnet-4-5',    desc: 'Previous Sonnet',      price: 'Included' },
    { id: 'claude-sonnet-4',      desc: 'Sonnet 4',             price: 'Included' },
    { id: 'claude-haiku-4-5',     desc: 'Fast & light',         price: 'Included' },
    { id: 'gpt-5.3-codex',        desc: 'GPT-5.3 Codex',        price: 'Included' },
    { id: 'gpt-5.2-codex',        desc: 'GPT-5.2 Codex',        price: 'Included' },
    { id: 'gpt-5.2',              desc: 'GPT-5.2',               price: 'Included' },
    { id: 'gpt-5.1-codex-max',    desc: 'GPT-5.1 Codex Max',    price: 'Included' },
    { id: 'gpt-5.1-codex',        desc: 'GPT-5.1 Codex',        price: 'Included' },
    { id: 'gpt-5.1',              desc: 'GPT-5.1',               price: 'Included' },
    { id: 'gpt-5.1-codex-mini',   desc: 'GPT-5.1 Codex Mini',   price: 'Included' },
    { id: 'gpt-5-mini',           desc: 'GPT-5 mini',            price: 'Included' },
    { id: 'gpt-4.1',              desc: 'GPT-4.1',               price: 'Included' },
    { id: 'gemini-3-pro-preview',  desc: 'Gemini 3 Pro',         price: 'Included' },
  ],
  // ─── EPAM Codemie (SSO) ───────────────────────────────────────────────────
  codemie: [
    { id: 'claude-sonnet-4-5-20250929', desc: 'Via EPAM SSO (default)', price: 'Enterprise' },
    { id: 'claude-sonnet-4-6',          desc: 'Latest Sonnet',           price: 'Enterprise' },
    { id: 'claude-opus-4-6',            desc: 'Opus flagship',           price: 'Enterprise' },
    { id: 'gpt-4o',                     desc: 'OpenAI GPT-4o',           price: 'Enterprise' },
    { id: 'gpt-4.1',                    desc: 'OpenAI GPT-4.1',          price: 'Enterprise' },
    { id: 'gemini-2.5-pro',             desc: 'Gemini 2.5 Pro',          price: 'Enterprise' },
  ],
  // ─── Codex CLI (subprocess) ───────────────────────────────────────────────
  codex: [
    { id: 'gpt-5-codex',      desc: 'Latest (default)',    price: 'Included' },
    { id: 'gpt-5.1-codex',    desc: 'GPT-5.1 Codex',      price: 'Included' },
    { id: 'gpt-5.2-codex',    desc: 'GPT-5.2 Codex',      price: 'Included' },
    { id: 'o3',               desc: 'Reasoning model',      price: 'Included' },
    { id: 'o4-mini',          desc: 'o4-mini reasoning',    price: 'Included' },
  ],
  // ─── Cursor / Gemini BYOK ─────────────────────────────────────────────────
  cursor: [
    { id: 'gemini-2.5-pro',        desc: 'Most capable (default)', price: '$1.25/$5'    },
    { id: 'gemini-2.5-flash',      desc: 'Fast & cheap',           price: '$0.15/$0.60' },
    { id: 'gemini-2.0-flash',      desc: 'Gemini 2.0 Flash',       price: '$0.10/$0.40' },
    { id: 'gemini-2.0-flash-lite', desc: 'Ultra cheap',            price: '$0.075/$0.30'},
    { id: 'gemini-1.5-pro',        desc: 'Gemini 1.5 Pro',         price: '$1.25/$5'    },
    { id: 'gemini-1.5-flash',      desc: 'Gemini 1.5 Flash',       price: '$0.075/$0.30'},
  ],
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

  // 'anthropic' and 'claude' are aliases for the same provider
  const providerKey = ctx.config.provider === 'anthropic' ? 'claude' : ctx.config.provider;
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

