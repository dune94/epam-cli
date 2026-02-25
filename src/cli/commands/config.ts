import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import {
  readGlobalConfig,
  writeGlobalConfig,
  getGlobalConfigPath,
} from '../../config/GlobalConfig.js';

export function createConfigCommand(): Command {
  const configCmd = new Command('config').description('Manage epam-cli configuration');

  configCmd
    .command('show')
    .description('Show current resolved configuration')
    .action(async () => {
      const config = await resolveConfig();
      console.log(chalk.bold('Resolved Configuration:'));
      console.log(JSON.stringify(config, null, 2));
    });

  configCmd
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      const config = await resolveConfig();
      const value = (config as unknown as Record<string, unknown>)[key];
      if (value === undefined) {
        console.log(chalk.yellow(`Key '${key}' not found`));
        process.exit(1);
      }
      console.log(String(value));
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a global configuration value')
    .action(async (key: string, value: string) => {
      await writeGlobalConfig({ [key]: value } as Parameters<typeof writeGlobalConfig>[0]);
      console.log(chalk.green(`Set ${key} = ${value}`));
    });

  configCmd
    .command('path')
    .description('Show global config file path')
    .action(() => {
      console.log(getGlobalConfigPath());
    });

  return configCmd;
}
