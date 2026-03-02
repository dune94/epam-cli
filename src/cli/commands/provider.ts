import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import {
  saveProviderCredential,
  deleteProviderCredential,
  listProviderCredentials,
  resolveProviderCredential,
} from '../../auth/ProviderCredentialStore.js';
import type { ProviderName } from '../../auth/types.js';

const SUPPORTED_PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'gemini'];

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function formatExpiry(expiresAt?: string): string {
  if (!expiresAt) return 'never';
  const d = new Date(expiresAt);
  const now = new Date();
  if (d <= now) return chalk.red(`expired (${d.toLocaleDateString()})`);
  return chalk.green(d.toLocaleString());
}

function formatSource(source: string): string {
  switch (source) {
    case 'epam_brokered_local': return chalk.cyan('epam-brokered');
    case 'provider_browser':    return chalk.yellow('bridge (API key)');
    case 'manual_api_key':      return chalk.white('manual api-key');
    default:                    return source;
  }
}

export function createProviderCommand(): Command {
  const provider = new Command('provider')
    .description('Manage provider credentials (anthropic, openai, gemini)');

  // epam provider login <provider>
  provider
    .command('login <provider>')
    .description('Store credentials for a provider (bridge: API key entry)')
    .action(async (providerName: string) => {
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`));
        process.exit(1);
      }

      console.log();
      console.log(chalk.yellow('⚠  This is a temporary bridge until EPAM-managed integration is available.'));
      console.log(chalk.dim('   Your API key will be stored securely in the system credential store.'));
      console.log();

      const { apiKey } = await prompts(
        {
          type: 'password',
          name: 'apiKey',
          message: `Enter your ${providerName} API key`,
          validate: (v: string) => v.trim().length > 0 ? true : 'API key cannot be empty',
        },
        { onCancel: () => process.exit(0) }
      );

      const { label } = await prompts(
        {
          type: 'text',
          name: 'label',
          message: 'Account label (optional, press Enter to skip)',
        },
        { onCancel: () => process.exit(0) }
      );

      await saveProviderCredential({
        provider: providerName as ProviderName,
        type: 'api_key',
        // This is an interim bridge — real browser OAuth requires a registered OAuth app per provider.
        // Using source=provider_browser gives it higher precedence than manual_api_key.
        source: 'provider_browser',
        secret: apiKey.trim(),
        accountLabel: label?.trim() || undefined,
        createdAt: new Date().toISOString(),
      });

      console.log();
      console.log(chalk.green(`✓ Credentials saved for ${providerName}.`));
    });

  // epam provider status <provider>
  provider
    .command('status <provider>')
    .description('Show credential status for a provider')
    .action(async (providerName: string) => {
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`));
        process.exit(1);
      }

      const record = await resolveProviderCredential(providerName);
      console.log();
      if (!record) {
        console.log(`${chalk.yellow('✗')} ${providerName}: ${chalk.dim('no credentials stored')}`);
        console.log(chalk.dim(`  Run \`epam provider login ${providerName}\` to add credentials.`));
      } else {
        console.log(`${chalk.green('✓')} ${providerName}`);
        console.log(`  source:  ${formatSource(record.source)}`);
        console.log(`  key:     ${maskSecret(record.secret)}`);
        if (record.accountLabel) {
          console.log(`  account: ${record.accountLabel}`);
        }
        console.log(`  expires: ${formatExpiry(record.expiresAt)}`);
        console.log(`  stored:  ${new Date(record.createdAt).toLocaleString()}`);
      }
      console.log();
    });

  // epam provider logout <provider>
  provider
    .command('logout <provider>')
    .description('Remove stored credentials for a provider')
    .action(async (providerName: string) => {
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`));
        process.exit(1);
      }

      await deleteProviderCredential(providerName);
      console.log(chalk.green(`✓ Credentials removed for ${providerName}.`));
      console.log(chalk.dim('  EPAM backend authentication is unaffected.'));
    });

  // epam provider list
  provider
    .command('list')
    .description('List all configured providers and their credential status')
    .action(async () => {
      const allCredentials = await listProviderCredentials();
      const now = new Date();

      console.log();
      console.log(chalk.bold('Provider credential status:'));
      console.log();

      for (const name of SUPPORTED_PROVIDERS) {
        const creds = allCredentials.filter(c => c.provider === name);
        const valid = creds.filter(c => !c.expiresAt || new Date(c.expiresAt) > now);

        if (valid.length === 0) {
          const expired = creds.filter(c => c.expiresAt && new Date(c.expiresAt) <= now);
          const icon = expired.length > 0 ? chalk.red('✗') : chalk.dim('○');
          const suffix = expired.length > 0 ? chalk.red(' (expired)') : chalk.dim(' (none)');
          console.log(`  ${icon} ${name.padEnd(12)}${suffix}`);
        } else {
          // Pick highest-priority credential to display
          const best = valid[0];
          const expirySuffix = best.expiresAt
            ? chalk.dim(` expires ${new Date(best.expiresAt).toLocaleDateString()}`)
            : '';
          console.log(
            `  ${chalk.green('✓')} ${name.padEnd(12)} ${formatSource(best.source)}${expirySuffix}`
          );
        }
      }

      console.log();
    });

  return provider;
}
