import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';

export function createLogoutCommand(): Command {
  return new Command('logout')
    .description('Sign out and remove stored credentials')
    .action(async () => {
      const config = await resolveConfig();
      const authManager = new AuthManager(config.backendUrl);
      await authManager.logout();
      console.log(chalk.green('Signed out successfully.'));
    });
}
