/**
 * /user — Show and switch authenticated user accounts
 *
 * Commands:
 *   /user            Show current user identity across all providers
 *   /user list       List all stored provider credentials/accounts
 *   /user switch <provider> Switch the active key for a provider (prompts for new key)
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { execSync } from 'child_process';

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'codex', 'copilot', 'codemie'] as const;

function getGitUser(): { name: string; email: string } | null {
  try {
    const name  = execSync('git config --global user.name',  { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    const email = execSync('git config --global user.email', { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    return name ? { name, email } : null;
  } catch { return null; }
}

function maskKey(key: string): string {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 6) + '…' + key.slice(-4);
}

export const userCommand: SlashCommand = {
  name: 'user',
  aliases: ['whoami', 'users'],
  description: 'Show current user identity and switch provider accounts',
  usage: '[list | switch <provider>]',

  async execute(args, ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/);
    const sub   = parts[0]?.toLowerCase() ?? '';

    // ── switch ────────────────────────────────────────────────────────────────
    if (sub === 'switch') {
      const provider = parts[1]?.toLowerCase();
      if (!provider) {
        console.log(chalk.red('Usage: /user switch <provider>'));
        console.log(chalk.dim('Providers: ' + PROVIDERS.join(', ')));
        return true;
      }
      const envMap: Record<string, string> = {
        anthropic: 'EPAM_API_KEY_ANTHROPIC',
        claude:    'EPAM_API_KEY_ANTHROPIC',
        openai:    'EPAM_API_KEY_OPENAI',
        gemini:    'EPAM_API_KEY_GEMINI',
        codex:     'OPENAI_API_KEY',
      };
      const envVar = envMap[provider];
      if (!envVar) {
        console.log(chalk.yellow(`Switching accounts for "${provider}" is not supported via key-based auth.`));
        console.log(chalk.dim('Use /provider auth ' + provider + ' to re-authenticate.'));
        return true;
      }
      console.log(chalk.bold(`\nSwitch ${provider} account\n`));
      console.log(chalk.dim(`Set the environment variable and restart to apply:`));
      console.log(chalk.cyan(`  export ${envVar}=<your-new-api-key>`));
      console.log(chalk.dim(`  Or store it: /provider auth ${provider}\n`));
      return true;
    }

    // ── list or default (show current identity) ───────────────────────────────
    const { getApiKey } = await import('../../../billing/KeychainKeyStore.js');

    console.log(chalk.bold('\nCurrent user identity\n'));

    // Session identity
    if (ctx.userEmail) {
      console.log(chalk.cyan('  Session:  ') + ctx.userEmail);
    }

    // Git identity
    const git = getGitUser();
    if (git) {
      console.log(chalk.cyan('  Git:      ') + `${git.name} <${git.email}>`);
    }

    console.log();
    console.log(chalk.bold('Provider credentials\n'));

    for (const p of PROVIDERS) {
      const envMap: Record<string, string | undefined> = {
        anthropic: process.env.EPAM_API_KEY_ANTHROPIC,
        openai:    process.env.EPAM_API_KEY_OPENAI,
        gemini:    process.env.EPAM_API_KEY_GEMINI,
        codex:     process.env.OPENAI_API_KEY,
        copilot:   undefined,
        codemie:   process.env.EPAM_BACKEND_URL,
      };

      const envKey   = envMap[p];
      const storedKey = await getApiKey(p).catch(() => null);
      const key      = envKey ?? storedKey ?? null;

      const status = key
        ? chalk.green('✓') + chalk.dim(` ${maskKey(key)}`)
        : chalk.dim('○ not configured');

      const src = envKey ? chalk.dim(' (env)') : storedKey ? chalk.dim(' (stored)') : '';
      console.log(`  ${chalk.cyan(p.padEnd(12))} ${status}${src}`);
    }

    console.log();
    console.log(chalk.dim('Switch accounts: /user switch <provider>'));
    console.log(chalk.dim('Remove a key:    /provider logout <provider>'));
    console.log(chalk.dim('Add a key:       /provider auth <provider>\n'));
    return true;
  },
};
