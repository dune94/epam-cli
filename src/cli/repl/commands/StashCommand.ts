/**
 * /stash — Private context session stash
 *
 * Commands:
 *   /stash save [name]     Save current conversation context to a named stash
 *   /stash list            List all your saved stashes
 *   /stash pop <name|id>   Restore a stash, replacing current context
 *   /stash merge <name|id> Merge a stash into the current context (append messages)
 *   /stash drop <name|id>  Delete a stash permanently
 *
 * Stashes are private (stored in ~/.epam/stash/, named by user+timestamp).
 */

import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

interface StashEntry {
  id: string;
  name: string;
  username: string;
  savedAt: string;
  model: string;
  messageCount: number;
  messages: unknown[];
}

function stashDir(): string {
  const dir = join(homedir(), '.epam', 'stash');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function username(ctx: SlashCommandContext): string {
  return (ctx.userEmail?.split('@')[0] ?? 'user').replace(/[^a-z0-9_-]/gi, '_');
}

function makeId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}_${rand}`;
}

function stashPath(dir: string, user: string, id: string): string {
  return join(dir, `${user}_${id}.json`);
}

function listStashes(user: string): StashEntry[] {
  const dir = stashDir();
  return readdirSync(dir)
    .filter(f => f.startsWith(`${user}_`) && f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as StashEntry; }
      catch { return null; }
    })
    .filter(Boolean) as StashEntry[];
}

function findStash(user: string, nameOrId: string): StashEntry | null {
  return listStashes(user).find(s => s.id === nameOrId || s.name === nameOrId) ?? null;
}

export const stashCommand: SlashCommand = {
  name: 'stash',
  description: 'Save/restore private context sessions',
  usage: 'save [name] | list | pop <name|id> | merge <name|id> | drop <name|id>',

  async execute(args, ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/);
    const sub   = parts[0]?.toLowerCase() ?? '';
    const arg   = parts.slice(1).join(' ').trim();
    const user  = username(ctx);
    const dir   = stashDir();

    // ── save ──────────────────────────────────────────────────────────────────
    if (sub === 'save' || sub === '') {
      const id   = makeId();
      const name = arg || id;
      const entry: StashEntry = {
        id,
        name,
        username: user,
        savedAt: new Date().toISOString(),
        model: ctx.currentModel,
        messageCount: ctx.messages.length,
        messages: ctx.messages,
      };
      writeFileSync(stashPath(dir, user, id), JSON.stringify(entry, null, 2));
      console.log(chalk.green(`✓ Stash saved`) + chalk.dim(` — "${name}" (${entry.messageCount} messages)`));
      console.log(chalk.dim(`  id: ${id}  →  restore with: /stash pop ${name}`));
      return true;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === 'list' || sub === 'ls') {
      const stashes = listStashes(user);
      if (stashes.length === 0) {
        console.log(chalk.dim('No stashes found. Save one with: /stash save [name]'));
        return true;
      }
      console.log(chalk.bold('\nYour stashes:\n'));
      for (const s of stashes.sort((a, b) => b.savedAt.localeCompare(a.savedAt))) {
        const date = new Date(s.savedAt).toLocaleString();
        console.log(
          chalk.cyan(`  ${s.name.padEnd(24)}`) +
          chalk.dim(`${s.messageCount} msgs  ${s.model}  ${date}`)
        );
        if (s.name !== s.id) console.log(chalk.dim(`  ${''.padEnd(24)}id: ${s.id}`));
      }
      console.log();
      return true;
    }

    // ── pop (restore, replace) ────────────────────────────────────────────────
    if (sub === 'pop' || sub === 'restore') {
      if (!arg) { console.log(chalk.red('Usage: /stash pop <name|id>')); return true; }
      const entry = findStash(user, arg);
      if (!entry) { console.log(chalk.red(`Stash not found: "${arg}"`)); return true; }

      ctx.messages.splice(0, ctx.messages.length, ...(entry.messages as typeof ctx.messages));
      console.log(chalk.green(`✓ Stash "${entry.name}" restored`) +
        chalk.dim(` — ${entry.messageCount} messages loaded, current context replaced`));
      return true;
    }

    // ── merge (append) ────────────────────────────────────────────────────────
    if (sub === 'merge') {
      if (!arg) { console.log(chalk.red('Usage: /stash merge <name|id>')); return true; }
      const entry = findStash(user, arg);
      if (!entry) { console.log(chalk.red(`Stash not found: "${arg}"`)); return true; }

      const before = ctx.messages.length;
      ctx.messages.push(...(entry.messages as typeof ctx.messages));
      console.log(chalk.green(`✓ Stash "${entry.name}" merged`) +
        chalk.dim(` — added ${ctx.messages.length - before} messages to current context`));
      return true;
    }

    // ── drop (delete) ─────────────────────────────────────────────────────────
    if (sub === 'drop' || sub === 'delete' || sub === 'rm') {
      if (!arg) { console.log(chalk.red('Usage: /stash drop <name|id>')); return true; }
      const entry = findStash(user, arg);
      if (!entry) { console.log(chalk.red(`Stash not found: "${arg}"`)); return true; }

      const file = stashPath(dir, user, entry.id);
      if (existsSync(file)) unlinkSync(file);
      console.log(chalk.green(`✓ Stash "${entry.name}" deleted`));
      return true;
    }

    // ── help ──────────────────────────────────────────────────────────────────
    console.log(chalk.bold('\n/stash — private context session stash\n'));
    console.log(chalk.dim('  /stash save [name]     Save current conversation'));
    console.log(chalk.dim('  /stash list            List your stashes'));
    console.log(chalk.dim('  /stash pop <name|id>   Restore, replacing current context'));
    console.log(chalk.dim('  /stash merge <name|id> Append stash into current context'));
    console.log(chalk.dim('  /stash drop <name|id>  Delete a stash\n'));
    return true;
  },
};
