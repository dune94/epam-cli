import { Command } from 'commander';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';

export function createLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate with EPAM backend')
    .option('--browser', 'Use browser-based OAuth instead of device flow')
    .action(async opts => {
      const config = await resolveConfig();
      const authManager = new AuthManager(config.backendUrl);
      await authManager.login({ browser: opts.browser });
    });
}
