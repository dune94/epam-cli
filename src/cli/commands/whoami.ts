import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';

export function createWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show current authenticated user')
    .action(async () => {
      const config = await resolveConfig();
      const authManager = new AuthManager(config.backendUrl);
      const user = await authManager.getUser();

      if (!user) {
        console.log(chalk.yellow('Not authenticated. Run `epam login` to sign in.'));
        process.exit(1);
      }

      const tier = await authManager.getTier();
      console.log(`${chalk.bold(user.email)} ${chalk.dim(`(${tier} tier)`)}`);
      if (user.name) console.log(chalk.dim(user.name));
    });
}
