import chalk from 'chalk';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

const MAX_FILES = 200;
const IGNORED = new Set([
  'node_modules', '.git', '.venv', '__pycache__', 'dist', 'build',
  '.next', '.nuxt', 'coverage', '.nyc_output', '.cache',
]);

interface DirEntry { path: string; isDir: boolean }

function collect(dir: string, base: string, depth: number, entries: DirEntry[]): void {
  if (depth > 4 || entries.length >= MAX_FILES) return;
  let items: string[];
  try { items = readdirSync(dir).sort(); }
  catch { return; }
  for (const name of items) {
    if (name.startsWith('.') || IGNORED.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    const rel = relative(base, full);
    if (stat.isDirectory()) {
      entries.push({ path: rel + '/', isDir: true });
      collect(full, base, depth + 1, entries);
    } else {
      entries.push({ path: rel, isDir: false });
    }
    if (entries.length >= MAX_FILES) return;
  }
}

export const addDirCommand: SlashCommand = {
  name: 'add-dir',
  aliases: ['adddir'],
  description: 'Add a directory tree listing to the active context window',
  usage: '<path>',

  async execute(args, ctx): Promise<boolean> {
    const target = args.trim();

    if (!target) {
      console.log(chalk.bold('\n/add-dir <path>\n'));
      console.log(chalk.dim('  Adds a directory file listing to the active context so the'));
      console.log(chalk.dim('  assistant can reason about it in subsequent messages.\n'));
      console.log(chalk.dim('  Example: /add-dir src/billing'));
      console.log(chalk.dim('           /add-dir .'));
      console.log();
      return true;
    }

    const projectRoot = ctx.config.projectRoot ?? process.cwd();
    const absPath = resolve(projectRoot, target);

    if (!existsSync(absPath)) {
      console.log(chalk.red(`Directory not found: ${absPath}`));
      return true;
    }

    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      console.log(chalk.red(`Not a directory: ${absPath}`));
      return true;
    }

    const entries: DirEntry[] = [];
    collect(absPath, absPath, 0, entries);

    const truncated = entries.length >= MAX_FILES;
    const lines = entries.map(e => (e.isDir ? chalk.cyan(e.path) : e.path));

    const header = `Directory listing: ${resolve(absPath)}`;
    const body = entries.map(e => e.path).join('\n');
    const notice = truncated ? `\n(truncated at ${MAX_FILES} entries)` : '';

    // Inject as a system-context user message so the model sees it
    ctx.messages.push({
      role: 'user',
      content: `[Directory context added by /add-dir]\n\n${header}\n\n${body}${notice}`,
    });

    console.log(chalk.bold(`\nAdded to context: ${resolve(absPath)}\n`));
    lines.forEach(l => console.log(`  ${l}`));
    if (truncated) console.log(chalk.yellow(`\n  (truncated at ${MAX_FILES} entries)`));
    console.log(chalk.dim(`\n  ${entries.length} entries injected into conversation context`));
    console.log();
    return true;
  },
};
