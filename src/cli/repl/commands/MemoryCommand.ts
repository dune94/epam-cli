import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';

function resolveMemoryPaths(ctx: SlashCommandContext): { project: string; global: string } {
  const projectRoot = ctx.config.projectRoot ?? process.cwd();
  return {
    project: join(projectRoot, '.epam', 'context.md'),
    global:  join(homedir(), '.epam', 'MEMORY.md'),
  };
}

function readFile(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const memoryCommand: SlashCommand = {
  name: 'memory',
  aliases: ['mem'],
  description: 'View, edit, or clear project/global context memory',
  usage: '[show|edit|clear|global] [project|global]',

  async execute(args, ctx): Promise<boolean> {
    const parts = args.trim().split(/\s+/);
    const sub  = parts[0]?.toLowerCase() ?? '';
    const scope = parts[1]?.toLowerCase() ?? 'project';
    const paths = resolveMemoryPaths(ctx);
    const targetPath = scope === 'global' ? paths.global : paths.project;

    // /memory edit [project|global]
    if (sub === 'edit') {
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'nano';
      ensureDir(targetPath);
      if (!existsSync(targetPath)) writeFileSync(targetPath, '');
      const result = spawnSync(editor, [targetPath], { stdio: 'inherit' });
      if (result.error) {
        console.log(chalk.red(`Editor error: ${result.error.message}`));
        console.log(chalk.dim(`File path: ${targetPath}`));
      } else {
        console.log(chalk.green(`✓ Memory saved: ${targetPath}`));
      }
      return true;
    }

    // /memory clear [project|global]
    if (sub === 'clear') {
      const label = scope === 'global' ? 'global' : 'project';
      const confirmed = await new Promise<boolean>(resolve_ => {
        const rl = ctx.rl;
        if (!rl) { resolve_(false); return; }
        rl.question(chalk.cyan(`Clear ${label} memory? [y/N] `), answer => {
          resolve_(answer.trim().toLowerCase() === 'y');
        });
      });
      if (confirmed) {
        ensureDir(targetPath);
        writeFileSync(targetPath, '');
        console.log(chalk.green(`✓ ${label} memory cleared`));
      }
      return true;
    }

    // /memory global — show global memory
    if (sub === 'global') {
      const content = readFile(paths.global);
      console.log(chalk.bold(`\nGlobal Memory: ${paths.global}\n`));
      if (!content.trim()) {
        console.log(chalk.dim('  (empty — edit with /memory edit global)'));
      } else {
        console.log(content);
      }
      console.log();
      return true;
    }

    // /memory or /memory show — show project memory
    const content = readFile(paths.project);
    console.log(chalk.bold(`\nProject Memory: ${resolve(paths.project)}\n`));
    if (!content.trim()) {
      console.log(chalk.dim('  (empty — add context with /memory edit)'));
    } else {
      console.log(content);
    }
    console.log();
    console.log(chalk.dim('  /memory edit           — open in $EDITOR'));
    console.log(chalk.dim('  /memory clear          — clear project memory'));
    console.log(chalk.dim('  /memory global         — show global memory (~/.epam/MEMORY.md)'));
    console.log(chalk.dim('  /memory edit global    — edit global memory'));
    console.log();
    return true;
  },
};
