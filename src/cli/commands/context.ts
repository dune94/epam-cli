import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { pathExists, ensureDir } from '../../utils/fs.js';

export function createContextCommand(): Command {
  const contextCmd = new Command('context').description(
    'Manage project context (.epam/context.md)'
  );

  contextCmd
    .command('show')
    .description('Show current context.md content')
    .action(async () => {
      const config = await resolveConfig();
      const contextPath = path.resolve(config.contextFile);

      if (!(await pathExists(contextPath))) {
        console.log(
          chalk.yellow('No context.md found. Run `epam context init` to create one.')
        );
        return;
      }

      const content = await fs.readFile(contextPath, 'utf-8');
      console.log(chalk.bold(`Context file: ${contextPath}\n`));
      console.log(content);
    });

  contextCmd
    .command('init')
    .description('Initialize .epam/context.md in the current directory')
    .action(async () => {
      const epamDir = path.join(process.cwd(), '.epam');
      await ensureDir(epamDir);
      const contextPath = path.join(epamDir, 'context.md');

      if (await pathExists(contextPath)) {
        console.log(chalk.yellow(`Context file already exists: ${contextPath}`));
        return;
      }

      const template = `# Project Context

## About this project
<!-- Describe your project here -->

## Key commands
- \`npm test\` — run tests
- \`npm run build\` — build project

## Architecture notes
<!-- Add any relevant architectural notes -->

## Coding conventions
<!-- Add coding conventions and patterns to follow -->
`;
      await fs.writeFile(contextPath, template, 'utf-8');
      console.log(chalk.green(`Created ${contextPath}`));
    });

  contextCmd
    .command('edit')
    .description('Open context.md in $EDITOR')
    .action(async () => {
      const config = await resolveConfig();
      const contextPath = path.resolve(config.contextFile);
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'nano';
      const { execa } = await import('execa');
      await execa(editor, [contextPath], { stdio: 'inherit' });
    });

  return contextCmd;
}
