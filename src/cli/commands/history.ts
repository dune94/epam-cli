import { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { getEpamGlobalDir } from '../../utils/platform.js';
import { pathExists } from '../../utils/fs.js';

export function createHistoryCommand(): Command {
  return new Command('history')
    .description('View session history')
    .option('-n, --count <n>', 'Number of sessions to show', '10')
    .action(async opts => {
      const config = await resolveConfig();
      const sessionsDir = config.projectRoot
        ? path.join(config.projectRoot, '.epam', 'sessions')
        : path.join(getEpamGlobalDir(), 'sessions');

      if (!(await pathExists(sessionsDir))) {
        console.log(chalk.dim('No session history found.'));
        return;
      }

      const files = await fs.readdir(sessionsDir);
      const jsonlFiles = files
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, parseInt(opts.count, 10));

      if (jsonlFiles.length === 0) {
        console.log(chalk.dim('No sessions found.'));
        return;
      }

      console.log(chalk.bold(`\nRecent sessions (${jsonlFiles.length}):\n`));
      for (const file of jsonlFiles) {
        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(sessionsDir, file);
        const stat = await fs.stat(filePath);
        console.log(
          `  ${chalk.cyan(sessionId)} ${chalk.dim(stat.mtime.toLocaleDateString())}`
        );
      }
    });
}
