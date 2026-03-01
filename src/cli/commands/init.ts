import { Command } from 'commander';
import { ScaffoldRunner } from '../../scaffold/ScaffoldRunner.js';

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize EPAM CLI project (creates .epam/settings.json and INSTRUCTIONS.md)')
    .action(async () => {
      const runner = new ScaffoldRunner({
        projectRoot: process.cwd(),
        silent: false,
      });

      await runner.run();
    });
}
