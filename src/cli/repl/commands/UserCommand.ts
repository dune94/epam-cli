/**
 * /user — Multi-account user identity and provider account switching
 *
 * Stores named credentials per provider in ~/.epam/accounts/<provider>/<name>.json
 * Tracks the active account per provider in ~/.epam/accounts/.active.json
 *
 * Commands:
 *   /user                         Show current identity + active accounts
 *   /user list [provider]         List all stored accounts (optionally for one provider)
 *   /user add <provider> <name>   Save current credential as a named account
 *   /user switch <provider> <n>   Switch to a stored account (live, no restart)
 *   /user remove <provider> <n>   Delete a stored account
 */

import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface AccountEntry {
  name: string;
  provider: string;
  addedAt: string;
  // API-key providers
  key?: string;
  // Copilot / token providers
  token?: string;
}

interface ActiveAccounts {
  [provider: string]: string; // provider → account name
}

// ── Account store helpers ─────────────────────────────────────────────────────

function accountsRoot(): string {
  const dir = join(homedir(), '.epam', 'accounts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function providerDir(provider: string): string {
  const dir = join(accountsRoot(), provider);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function activePath(): string { return join(accountsRoot(), '.active.json'); }

function loadActive(): ActiveAccounts {
  try { return JSON.parse(readFileSync(activePath(), 'utf8')); } catch { return {}; }
}

function saveActive(a: ActiveAccounts): void {
  writeFileSync(activePath(), JSON.stringify(a, null, 2));
}

function listAccounts(provider: string): AccountEntry[] {
  const dir = providerDir(provider);
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean) as AccountEntry[];
}

function getAccount(provider: string, name: string): AccountEntry | null {
  try {
    const p = join(providerDir(provider), `${sanitize(name)}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch { return null; }
}

function saveAccount(entry: AccountEntry): void {
  const p = join(providerDir(entry.provider), `${sanitize(entry.name)}.json`);
  writeFileSync(p, JSON.stringify(entry, null, 2));
}

function deleteAccount(provider: string, name: string): boolean {
  const p = join(providerDir(provider), `${sanitize(name)}.json`);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

function sanitize(s: string): string { return s.replace(/[^a-z0-9_.-]/gi, '_'); }

// ── Provider env-var map ──────────────────────────────────────────────────────

const ENV_VAR: Record<string, string> = {
  anthropic: 'EPAM_API_KEY_ANTHROPIC',
  claude:    'EPAM_API_KEY_ANTHROPIC',
  openai:    'EPAM_API_KEY_OPENAI',
  gemini:    'EPAM_API_KEY_GEMINI',
  codex:     'OPENAI_API_KEY',
};

const TOKEN_ENV_VAR: Record<string, string> = {
  copilot: 'COPILOT_GITHUB_TOKEN',
};

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'codex', 'copilot', 'codemie'];

// ── Read current credential for a provider ────────────────────────────────────

async function currentCredential(provider: string): Promise<{ key?: string; token?: string } | null> {
  if (TOKEN_ENV_VAR[provider]) {
    const token = process.env[TOKEN_ENV_VAR[provider]] ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    return token ? { token } : null;
  }
  if (ENV_VAR[provider]) {
    const key = process.env[ENV_VAR[provider]];
    if (key) return { key };
  }
  try {
    const { getApiKey } = await import('../../../billing/KeychainKeyStore.js');
    const key = await getApiKey(provider);
    return key ? { key } : null;
  } catch { return null; }
}

function maskSecret(s: string): string {
  if (!s || s.length < 10) return '****';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

// ── Apply a stored account in-session ─────────────────────────────────────────

function applyAccount(entry: AccountEntry, ctx: SlashCommandContext): string[] {
  const warnings: string[] = [];

  if (entry.token && TOKEN_ENV_VAR[entry.provider]) {
    process.env[TOKEN_ENV_VAR[entry.provider]] = entry.token;
    // Also set the fallback vars CopilotProvider checks
    process.env.GH_TOKEN      = entry.token;
    process.env.GITHUB_TOKEN  = entry.token;
  } else if (entry.key && ENV_VAR[entry.provider]) {
    process.env[ENV_VAR[entry.provider]] = entry.key;
  } else {
    warnings.push(`No credential found in stored account "${entry.name}".`);
    return warnings;
  }

  // Clear provider cache so next request picks up the new credential
  if (ctx.providerChain) {
    ctx.providerChain.clearProviderCache();
  } else {
    warnings.push('Provider chain not available — restart may be needed for the switch to take full effect.');
  }

  // Update active account tracking
  const active = loadActive();
  active[entry.provider] = entry.name;
  saveActive(active);

  return warnings;
}

// ── Git helper ─────────────────────────────────────────────────────────────────

function getGitUser(): { name: string; email: string } | null {
  try {
    const name  = execSync('git config --global user.name',  { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    const email = execSync('git config --global user.email', { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    return name ? { name, email } : null;
  } catch { return null; }
}

// ── Command ───────────────────────────────────────────────────────────────────

export const userCommand: SlashCommand = {
  name: 'user',
  aliases: ['whoami', 'users'],
  description: 'Show current user identity and switch provider accounts',
  usage: '[list [provider] | add <provider> <name> | switch <provider> <name> | remove <provider> <name>]',

  async execute(args, ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub   = parts[0]?.toLowerCase() ?? '';

    // ── add ───────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      const provider = parts[1]?.toLowerCase();
      const name     = parts[2];
      if (!provider || !name) {
        console.log(chalk.red('Usage: /user add <provider> <name>'));
        console.log(chalk.dim('Example: /user add copilot work'));
        return true;
      }
      const cred = await currentCredential(provider);
      if (!cred) {
        console.log(chalk.red(`No active credential found for "${provider}".`));
        console.log(chalk.dim(`Authenticate first: /provider auth ${provider}`));
        return true;
      }
      const entry: AccountEntry = { name, provider, addedAt: new Date().toISOString(), ...cred };
      saveAccount(entry);
      const secret = cred.key ?? cred.token ?? '';
      console.log(chalk.green(`✓ Account "${name}" saved for ${provider}`) +
        chalk.dim(` (${maskSecret(secret)})`));
      console.log(chalk.dim(`  Switch to it with: /user switch ${provider} ${name}`));
      return true;
    }

    // ── switch ────────────────────────────────────────────────────────────────
    if (sub === 'switch') {
      const provider = parts[1]?.toLowerCase();
      const name     = parts[2];
      if (!provider || !name) {
        console.log(chalk.red('Usage: /user switch <provider> <name>'));
        console.log(chalk.dim('See stored accounts with: /user list'));
        return true;
      }
      const entry = getAccount(provider, name);
      if (!entry) {
        console.log(chalk.red(`No stored account "${name}" for ${provider}.`));
        const accounts = listAccounts(provider);
        if (accounts.length > 0) {
          console.log(chalk.dim(`Available: ${accounts.map(a => a.name).join(', ')}`));
        } else {
          console.log(chalk.dim(`No accounts stored. Add one with: /user add ${provider} <name>`));
        }
        return true;
      }
      const warnings = applyAccount(entry, ctx);
      console.log(chalk.green(`✓ Switched to "${name}" (${provider})`) +
        chalk.dim(' — provider cache cleared, next request uses new credential'));
      if (warnings.length > 0) {
        warnings.forEach(w => console.log(chalk.yellow(`  ⚠  ${w}`)));
      }
      return true;
    }

    // ── remove ────────────────────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const provider = parts[1]?.toLowerCase();
      const name     = parts[2];
      if (!provider || !name) {
        console.log(chalk.red('Usage: /user remove <provider> <name>'));
        return true;
      }
      if (deleteAccount(provider, name)) {
        const active = loadActive();
        if (active[provider] === name) { delete active[provider]; saveActive(active); }
        console.log(chalk.green(`✓ Account "${name}" removed from ${provider}`));
      } else {
        console.log(chalk.red(`Account "${name}" not found for ${provider}.`));
      }
      return true;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === 'list' || sub === 'ls') {
      const filterProvider = parts[1]?.toLowerCase();
      const active = loadActive();
      const providers = filterProvider ? [filterProvider] : KNOWN_PROVIDERS;
      let any = false;
      for (const p of providers) {
        const accounts = listAccounts(p);
        if (accounts.length === 0) continue;
        any = true;
        console.log(chalk.bold(`\n  ${p}`));
        for (const a of accounts.sort((x, y) => x.name.localeCompare(y.name))) {
          const isActive = active[p] === a.name;
          const marker   = isActive ? chalk.green('● ') : chalk.dim('○ ');
          const secret   = a.key ?? a.token ?? '';
          console.log(`    ${marker}${chalk.cyan(a.name.padEnd(20))}${chalk.dim(maskSecret(secret))}` +
            (isActive ? chalk.green('  ← active') : ''));
        }
      }
      if (!any) {
        console.log(chalk.dim('\nNo stored accounts. Add one with: /user add <provider> <name>'));
      }
      console.log();
      return true;
    }

    // ── default: show current identity ────────────────────────────────────────
    const active = loadActive();

    console.log(chalk.bold('\nCurrent user identity\n'));

    if (ctx.userEmail) {
      console.log(chalk.cyan('  Session:  ') + ctx.userEmail);
    }
    const git = getGitUser();
    if (git) {
      console.log(chalk.cyan('  Git:      ') + `${git.name} <${git.email}>`);
    }

    console.log();
    console.log(chalk.bold('Provider credentials\n'));

    for (const p of KNOWN_PROVIDERS) {
      const cred        = await currentCredential(p);
      const secret      = cred?.key ?? cred?.token ?? null;
      const activeAcct  = active[p];
      const accounts    = listAccounts(p);

      const credStatus = secret
        ? chalk.green('✓') + chalk.dim(` ${maskSecret(secret)}`)
        : chalk.dim('○ not configured');

      const acctInfo = activeAcct
        ? chalk.dim(` [account: ${activeAcct}]`)
        : accounts.length > 0
          ? chalk.dim(` [${accounts.length} stored, none active]`)
          : '';

      console.log(`  ${chalk.cyan(p.padEnd(12))} ${credStatus}${acctInfo}`);
    }

    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  /user list                      — list stored accounts'));
    console.log(chalk.dim('  /user add <provider> <name>     — save current credential as named account'));
    console.log(chalk.dim('  /user switch <provider> <name>  — switch to a stored account (live)'));
    console.log(chalk.dim('  /user remove <provider> <name>  — delete a stored account\n'));
    return true;
  },
};

