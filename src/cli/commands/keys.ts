import { Command } from 'commander';
import chalk from 'chalk';
import {
  storeApiKey,
  getApiKey,
  deleteApiKey,
  listStoredProviders,
} from '../../billing/KeychainKeyStore.js';

const PROVIDERS = ['anthropic', 'openai', 'gemini'];

export function createKeysCommand(): Command {
  const keysCmd = new Command('keys').description('Manage BYOK (bring-your-own-key) API keys');

  keysCmd
    .command('set <provider> <key>')
    .description(`Set API key for a provider (${PROVIDERS.join(', ')})`)
    .action(async (provider: string, key: string) => {
      if (!PROVIDERS.includes(provider)) {
        console.error(
          chalk.red(`Unknown provider: ${provider}. Use one of: ${PROVIDERS.join(', ')}`)
        );
        process.exit(1);
      }
      await storeApiKey(provider, key);
      console.log(chalk.green(`API key saved for ${provider}`));
    });

  keysCmd
    .command('get <provider>')
    .description('Show masked API key for a provider')
    .action(async (provider: string) => {
      const key = await getApiKey(provider);
      if (!key) {
        console.log(chalk.yellow(`No key stored for ${provider}`));
        return;
      }
      const masked = key.slice(0, 8) + '...' + key.slice(-4);
      console.log(`${provider}: ${masked}`);
    });

  keysCmd
    .command('remove <provider>')
    .description('Remove stored API key for a provider')
    .action(async (provider: string) => {
      await deleteApiKey(provider);
      console.log(chalk.green(`Removed key for ${provider}`));
    });

  keysCmd
    .command('list')
    .description('List providers with stored API keys')
    .action(async () => {
      const providers = await listStoredProviders();
      if (providers.length === 0) {
        console.log(chalk.dim('No API keys stored.'));
        return;
      }
      console.log(chalk.bold('Stored keys:'));
      for (const p of providers) {
        console.log(`  ${chalk.cyan(p)}`);
      }
    });

  return keysCmd;
}
