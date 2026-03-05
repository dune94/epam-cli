/**
 * /provider Slash Command
 *
 * Unified provider management: list, switch, authenticate, logout.
 *
 * Usage:
 *   /provider              — list all providers + active status
 *   /provider <name>       — switch to provider (default model)
 *   /provider <name/model> — switch to provider + model
 *   /provider auth <name>  — authenticate a provider
 *   /provider logout <name>— deauthenticate a provider
 */

import chalk from 'chalk';
import { execa } from 'execa';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { CopilotProvider } from '../../../providers/copilot/CopilotProvider.js';

const PROVIDER_DEFAULTS: Record<string, string> = {
  claude:   'claude-sonnet-4-6',
  qwen:     'qwen-max',
  openai:   'gpt-4o',
  gemini:   'gemini-1.5-pro',
  codemie:  'claude-sonnet-4-5-20250929',
  codex:    'gpt-5-codex',
  cursor:   'gemini-3.1-pro',
  copilot:  'claude-sonnet-4-6',
};

const PROVIDER_LABELS: Record<string, string> = {
  claude:   'Anthropic Claude',
  qwen:     'Alibaba Qwen',
  openai:   'OpenAI GPT',
  gemini:   'Google Gemini',
  codemie:  'Codemie (SSO)',
  codex:    'OpenAI Codex (CLI)',
  cursor:   'Cursor Agent',
  copilot:  'GitHub Copilot (CLI)',
};

export const providerCommand: SlashCommand = {
  name: 'provider',
  aliases: ['providers', 'prov'],
  description: 'List or switch providers, manage authentication',
  usage: '[<name>[/model] | auth <name> | logout <name>]',

  async execute(args, ctx): Promise<boolean> {
    const trimmed = args.trim();

    if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
      return listProviders(ctx);
    }

    const parts = trimmed.split(/\s+/);
    const sub = parts[0].toLowerCase();

    if (sub === 'auth' || sub === 'login') {
      const name = parts[1];
      if (!name) {
        console.log();
        console.log(chalk.red('Provider name required.'));
        console.log(chalk.dim('Usage: /provider auth <name>'));
        console.log(chalk.dim('Names: ' + Object.keys(PROVIDER_DEFAULTS).join(', ')));
        console.log();
        return true;
      }
      return authenticateProvider(name, ctx);
    }

    if (sub === 'logout') {
      const name = parts[1];
      if (!name) {
        console.log();
        console.log(chalk.red('Provider name required.'));
        console.log(chalk.dim('Usage: /provider logout <name>'));
        console.log();
        return true;
      }
      return logoutProvider(name, ctx);
    }

    // Otherwise treat as provider switch: /provider <name> or /provider <name/model>
    return switchProvider(trimmed, ctx);
  },
};

// ─── List ────────────────────────────────────────────────────────────────────

function listProviders(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('⚡ Providers'));
  console.log();

  const chain = ctx.providerChain as unknown as {
    getSlots?: () => Array<{ provider: string; model: string }>;
    activeSlot?: { provider: string; model: string };
    options?: { slots: Array<{ provider: string; model: string }> };
  } | undefined;

  const slots = chain?.getSlots?.() ?? chain?.options?.slots ?? [];
  const activeSlot = chain?.activeSlot;

  if (slots.length > 0) {
    console.log(chalk.bold('Configured chain:'));
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const isActive =
        activeSlot?.provider === slot.provider && activeSlot?.model === slot.model;
      const bullet = isActive ? chalk.green('●') : chalk.dim('○');
      const label = isActive ? chalk.green(' ← active') : i === 0 ? chalk.dim(' (primary)') : chalk.dim(` (failover ${i})`);
      console.log(`  ${bullet} ${chalk.white(slot.provider)}/${chalk.dim(slot.model)}${label}`);
    }
    console.log();
  } else {
    console.log(chalk.dim('  No provider chain configured.'));
    console.log(`  Active: ${chalk.white(ctx.config.provider)}/${chalk.dim(ctx.currentModel)}`);
    console.log();
  }

  console.log(chalk.bold('All providers:'));
  for (const [key, label] of Object.entries(PROVIDER_LABELS)) {
    const defaultModel = PROVIDER_DEFAULTS[key];
    const isCurrent = ctx.config.provider === key;
    const marker = isCurrent ? chalk.green(' ✓') : '';
    console.log(`  ${chalk.cyan(key.padEnd(10))} ${chalk.dim(label.padEnd(22))} ${chalk.dim(defaultModel)}${marker}`);
  }
  console.log();
  console.log(chalk.dim('Switch:        /provider <name>          e.g. /provider copilot'));
  console.log(chalk.dim('Switch+model:  /provider <name>/<model>  e.g. /provider claude/claude-opus-4-6'));
  console.log(chalk.dim('Authenticate:  /provider auth <name>'));
  console.log(chalk.dim('Deauthenticate:/provider logout <name>'));
  console.log();
  return true;
}

// ─── Switch ──────────────────────────────────────────────────────────────────

function switchProvider(spec: string, ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🔄 Switching Provider'));
  console.log();

  const slashIdx = spec.indexOf('/');
  let providerName: string;
  let modelName: string;

  if (slashIdx === -1) {
    providerName = spec;
    modelName = PROVIDER_DEFAULTS[providerName] ?? '';
  } else {
    providerName = spec.slice(0, slashIdx);
    modelName = spec.slice(slashIdx + 1);
  }

  if (!PROVIDER_DEFAULTS[providerName] && !modelName) {
    console.log(chalk.red(`Unknown provider: ${providerName}`));
    console.log(chalk.dim('Run /provider to list available providers.'));
    console.log();
    return true;
  }

  if (!modelName) {
    console.log(chalk.red(`Unknown provider: ${providerName}`));
    console.log(chalk.dim('Run /provider to list available providers.'));
    console.log();
    return true;
  }

  console.log(`  From: ${chalk.dim(ctx.config.provider + '/' + ctx.currentModel)}`);
  console.log(`  To:   ${chalk.white(providerName + '/' + modelName)}`);
  console.log();

  // Use onChainUpdate if available (full provider switch)
  if (ctx.onChainUpdate) {
    ctx.onChainUpdate([{ provider: providerName, model: modelName }]).then(() => {
      console.log(chalk.green('✓ Provider switched'));
      console.log();
    }).catch((err: Error) => {
      console.log(chalk.yellow('⚠  Chain update failed: ' + err.message));
      console.log(chalk.dim('Falling back to model-only switch…'));
      ctx.onProviderChange?.(providerName);
      ctx.onModelChange(modelName);
      console.log(chalk.green('✓ Switched'));
      console.log();
    });
  } else {
    // Fall back: update both provider and model directly
    ctx.onProviderChange?.(providerName);
    ctx.onModelChange(modelName);
    console.log(chalk.green('✓ Provider switched'));
    console.log();
  }

  return true;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function authenticateProvider(providerName: string, ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan(`🔐 Authenticate — ${providerName}`));
  console.log();

  if (ctx.onAuthenticateProvider) {
    const ok = await ctx.onAuthenticateProvider(providerName);
    console.log(ok
      ? chalk.green(`✓ ${providerName} authenticated`)
      : chalk.yellow(`⚠  ${providerName} authentication failed or cancelled`));
    console.log();
    return true;
  }

  try {
    switch (providerName) {
      case 'copilot': {
        const envToken = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
        if (envToken) {
          console.log(chalk.yellow('⚠  Token already set via environment variable.'));
          console.log(chalk.dim(`COPILOT_GITHUB_TOKEN is set (${envToken.slice(0, 15)}…)`));
          console.log(chalk.dim('Unset it first if you want device-flow: unset COPILOT_GITHUB_TOKEN'));
          break;
        }
        const available = await CopilotProvider.isAvailable();
        if (!available) {
          console.log(chalk.red('✗ Copilot CLI not installed.'));
          console.log(chalk.dim('Install: npm install -g @github/copilot'));
          break;
        }
        console.log(chalk.dim('Starting device-flow — follow browser instructions…'));
        console.log();
        const { exitCode } = await execa('copilot', ['login'], { stdio: 'inherit', reject: false });
        console.log();
        console.log(exitCode === 0 ? chalk.green('✓ Copilot authenticated') : chalk.red('✗ Authentication failed'));
        break;
      }

      case 'codex': {
        const { existsSync } = await import('fs');
        const { homedir } = await import('os');
        const { join } = await import('path');
        if (existsSync(join(homedir(), '.codex', 'auth.json'))) {
          console.log(chalk.green('✓ Codex already authenticated'));
          console.log(chalk.dim('To re-authenticate: rm ~/.codex/auth.json  then /provider auth codex'));
          break;
        }
        console.log(chalk.dim('Starting Codex CLI — sign in with ChatGPT when prompted…'));
        console.log();
        await new Promise(resolve => setTimeout(resolve, 100));
        const { exitCode } = await execa('codex', [], { stdio: 'inherit', timeout: 300_000, reject: false });
        process.stdout.write('\x1B[2J\x1B[0H\n');
        console.log('─'.repeat(60));
        console.log();
        console.log(exitCode === 0 ? chalk.green('✓ Codex authenticated') : chalk.yellow('⚠  Codex session ended'));
        break;
      }

      case 'codemie': {
        console.log(chalk.dim('Opening browser for Codemie OAuth…'));
        const { exitCode } = await execa('node', ['dist/epam.js', 'provider', 'login', 'codemie'], {
          stdio: 'inherit', cwd: process.cwd(), timeout: 300_000, reject: false,
        });
        console.log();
        console.log(exitCode === 0 ? chalk.green('✓ Codemie authenticated') : chalk.yellow('⚠  Codemie authentication failed'));
        break;
      }

      case 'cursor': {
        console.log(chalk.dim('Cursor provider uses the Google Gemini API (Gemini 3.1 Pro).'));
        console.log(chalk.dim('Get an API key at: https://aistudio.google.com/apikey'));
        console.log();
        const { default: promptsCursor } = await import('prompts');
        const { apiKey: cursorKey } = await promptsCursor([{
          type: 'password',
          name: 'apiKey',
          message: 'Google AI Studio API key (CURSOR_API_KEY)',
          validate: (v: string) => v.trim().length > 0 ? true : 'API key cannot be empty',
        }]);
        if (cursorKey) {
          const { storeApiKey } = await import('../../../billing/KeychainKeyStore.js');
          await storeApiKey('cursor', cursorKey.trim());
          console.log();
          console.log(chalk.green('✓ Cursor API key saved'));
          console.log(chalk.dim('  To use env var instead: export CURSOR_API_KEY=<key>'));
        }
        break;
      }

      case 'qwen': {
        console.log(chalk.dim('Qwen models are accessed via OpenRouter — an English-language gateway to 200+ AI models.'));
        console.log(chalk.dim('Get a free API key at: https://openrouter.ai/keys  (no credit card required)'));
        console.log();
        const { default: promptsQwen } = await import('prompts');
        const { apiKey: qwenKey } = await promptsQwen([{
          type: 'password',
          name: 'apiKey',
          message: 'OpenRouter API key (for Qwen access)',
          validate: (v: string) => v.trim().length > 0 ? true : 'API key cannot be empty',
        }]);
        if (qwenKey) {
          const { storeApiKey } = await import('../../../billing/KeychainKeyStore.js');
          await storeApiKey('qwen', qwenKey.trim());
          console.log();
          console.log(chalk.green('✓ Qwen (via OpenRouter) API key saved'));
          console.log(chalk.dim('  To use env var instead: export OPENROUTER_API_KEY=<key>'));
        }
        break;
      }

      case 'anthropic':
      case 'claude':
      case 'openai':
      case 'gemini': {
        const envVarMap: Record<string, string> = {
          anthropic: 'EPAM_API_KEY_ANTHROPIC',
          claude:    'EPAM_API_KEY_ANTHROPIC',
          openai:    'EPAM_API_KEY_OPENAI',
          gemini:    'EPAM_API_KEY_GEMINI',
        };
        const { default: promptsKey } = await import('prompts');
        const { apiKey } = await promptsKey([{
          type: 'password',
          name: 'apiKey',
          message: `${providerName} API key (${envVarMap[providerName]})`,
          validate: (v: string) => v.trim().length > 0 ? true : 'API key cannot be empty',
        }]);
        if (apiKey) {
          const { storeApiKey } = await import('../../../billing/KeychainKeyStore.js');
          await storeApiKey(providerName === 'claude' ? 'anthropic' : providerName, apiKey.trim());
          console.log();
          console.log(chalk.green(`✓ ${providerName} API key saved`));
          console.log(chalk.dim(`  To use env var instead: export ${envVarMap[providerName]}=<key>`));
        }
        break;
      }

      default:
        console.log(chalk.red(`Unknown provider: ${providerName}`));
        console.log(chalk.dim('Supported: ' + Object.keys(PROVIDER_DEFAULTS).join(', ')));
    }
  } catch (err) {
    console.log(chalk.red(`Auth error: ${(err as Error).message}`));
  }

  console.log();
  return true;
}

// ─── Logout ──────────────────────────────────────────────────────────────────

async function logoutProvider(providerName: string, _ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan(`🚪 Logout — ${providerName}`));
  console.log();

  try {
    switch (providerName) {
      case 'copilot': {
        // Remove GitHub Copilot token files from known config locations
        const { existsSync, rmSync, readdirSync } = await import('fs');
        const { homedir } = await import('os');
        const { join } = await import('path');
        const home = homedir();
        const copilotPaths = [
          join(home, '.config', 'github-copilot'),
          join(home, '.github-copilot.json'),
        ];
        let removed = 0;
        for (const p of copilotPaths) {
          if (existsSync(p)) {
            try { rmSync(p, { recursive: true, force: true }); removed++; } catch { /* ignore */ }
          }
        }
        console.log();
        console.log(removed > 0
          ? chalk.green('✓ Copilot auth files removed')
          : chalk.dim('No Copilot auth files found — may already be logged out.'));
        console.log(chalk.dim('  Re-authenticate with: /provider auth copilot'));
        break;
      }

      case 'codex': {
        // Removes the CLI auth file — actual revocation
        const { existsSync, rmSync } = await import('fs');
        const { homedir } = await import('os');
        const { join } = await import('path');
        const authFile = join(homedir(), '.codex', 'auth.json');
        if (existsSync(authFile)) {
          rmSync(authFile);
          console.log(chalk.green('✓ Codex auth file removed (~/.codex/auth.json)'));
          console.log(chalk.dim('  Re-authenticate with: /provider auth codex'));
        } else {
          console.log(chalk.dim('No Codex auth file found — already logged out.'));
        }
        break;
      }

      case 'cursor':
      case 'qwen':
      case 'anthropic':
      case 'claude':
      case 'openai':
      case 'gemini': {
        // Remove from credential store; cannot unset shell env vars
        const storeKey = providerName === 'claude' ? 'anthropic' : providerName;
        const { deleteApiKey, getApiKey } = await import('../../../billing/KeychainKeyStore.js');
        const storedKey = await getApiKey(storeKey);
        const revokeUrls: Record<string, string> = {
          cursor:    'https://aistudio.google.com/apikey',
          qwen:      'https://openrouter.ai/keys',
          anthropic: 'https://console.anthropic.com/settings/keys',
          claude:    'https://console.anthropic.com/settings/keys',
          openai:    'https://platform.openai.com/api-keys',
          gemini:    'https://aistudio.google.com/apikey',
        };
        const envVarMap: Record<string, string> = {
          cursor:    'CURSOR_API_KEY',
          qwen:      'OPENROUTER_API_KEY',
          anthropic: 'EPAM_API_KEY_ANTHROPIC',
          claude:    'EPAM_API_KEY_ANTHROPIC',
          openai:    'EPAM_API_KEY_OPENAI',
          gemini:    'EPAM_API_KEY_GEMINI',
        };
        if (storedKey) {
          await deleteApiKey(storeKey);
          console.log(chalk.green(`✓ ${providerName} key removed from credential store`));
        } else {
          console.log(chalk.dim(`No stored credential found for ${providerName}.`));
        }
        console.log();
        console.log(chalk.bold('To fully revoke access:'));
        console.log(chalk.dim(`  1. Delete the key at:  ${revokeUrls[providerName]}`));
        console.log(chalk.dim(`  2. Unset env var:      unset ${envVarMap[providerName]}`));
        break;
      }

      default:
        console.log(chalk.dim(`No logout action defined for: ${providerName}`));
    }
  } catch (err) {
    console.log(chalk.red(`Error: ${(err as Error).message}`));
  }

  console.log();
  return true;
}
