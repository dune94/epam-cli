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
import { CodemieSSO } from '../../providers/codemie/CodemieSSO.js';
import { CodexProvider } from '../../providers/codex/CodexProvider.js';

const SUPPORTED_PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'gemini'];
const SSO_PROVIDERS = ['codemie'];
const CLI_PROVIDERS = ['codex'];

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
    case 'sso_oauth':           return chalk.green('SSO OAuth');
    case 'manual_api_key':      return chalk.white('manual api-key');
    default:                    return source;
  }
}

async function handleSSOLogin(providerName: string, options: { url?: string }): Promise<void> {
  if (providerName !== 'codemie') {
    console.error(chalk.red(`SSO login not supported for: ${providerName}`));
    process.exit(1);
  }

  const defaultUrl = 'https://codemie.lab.epam.com';
  const codeMieUrl = options.url || defaultUrl;

  console.log();
  console.log(chalk.bold('Codemie SSO Authentication'));
  console.log(chalk.dim(`  URL: ${codeMieUrl}`));
  console.log();
  console.log(chalk.dim('  Opening browser for OAuth login...'));
  console.log(chalk.dim('  Complete authentication in the browser window.'));
  console.log();

  const sso = new CodemieSSO();
  const result = await sso.authenticate({ codeMieUrl, timeout: 120000 });

  if (result.success) {
    console.log();
    console.log(chalk.green('✓ SSO authentication successful'));
    console.log(chalk.cyan(`  Connected to: ${codeMieUrl}`));
    console.log(chalk.cyan(`  Credentials stored (expires in 24h)`));
    console.log();
    console.log(chalk.bold('  Next Steps:'));
    console.log();
    console.log('  ' + chalk.white('• Check status:') + '     ' + chalk.cyan(`epam provider status ${providerName}`));
    console.log('  ' + chalk.white('• Refresh token:') + '    ' + chalk.cyan(`epam provider refresh ${providerName}`));
    console.log('  ' + chalk.white('• Start chat:') + '       ' + chalk.cyan('epam chat --provider codemie'));
    console.log('  ' + chalk.white('• Verify system:') + '    ' + chalk.cyan('epam doctor'));
    console.log();
  } else {
    console.log();
    console.log(chalk.red('✗ SSO authentication failed'));
    console.log(chalk.red(`  Error: ${result.error}`));
    console.log();
    process.exit(1);
  }
}

async function handleCLILogin(providerName: string): Promise<void> {
  if (providerName !== 'codex') {
    console.error(chalk.red(`CLI login not supported for: ${providerName}`));
    return;
  }

  console.log();
  console.log(chalk.bold('Codex CLI Authentication'));
  console.log(chalk.dim('  This will open Codex CLI for browser sign-in.'));
  console.log(chalk.dim('  Complete authentication in the Codex CLI window.'));
  console.log();

  const success = await CodexProvider.authenticate();

  if (success) {
    console.log();
    console.log(chalk.green('✓ Codex authentication successful'));
    console.log();
    console.log(chalk.bold('  Next Steps:'));
    console.log();
    console.log('  ' + chalk.white('• Check status:') + '  ' + chalk.cyan('epam provider status codex'));
    console.log('  ' + chalk.white('• Start chat:') + '    ' + chalk.cyan('epam chat --provider codex'));
    console.log();
  } else {
    console.log();
    console.log(chalk.red('✗ Codex authentication failed'));
    console.log(chalk.dim('  Make sure Codex CLI is installed: npm install -g @openai/codex'));
    console.log();
    process.exit(1);
  }
}

async function handleSSOStatus(providerName: string): Promise<void> {
  if (providerName !== 'codemie') {
    console.error(chalk.red(`SSO status not supported for: ${providerName}`));
    return;
  }

  const sso = new CodemieSSO();
  const credentials = await sso.getStoredCredentials();

  console.log();
  if (!credentials) {
    console.log(`${chalk.yellow('✗')} codemie: ${chalk.dim('no SSO credentials stored')}`);
    console.log(chalk.dim(`  Run \`epam provider login codemie\` to authenticate.`));
  } else {
    const isExpired = Date.now() > credentials.expiresAt;
    const expiryColor = isExpired ? chalk.red : chalk.green;
    
    console.log(`${chalk.green('✓')} codemie`);
    console.log(`  source:     ${formatSource('sso_oauth')}`);
    console.log(`  API URL:    ${credentials.apiUrl}`);
    console.log(`  expires:    ${expiryColor(new Date(credentials.expiresAt).toLocaleString())}`);
    console.log(`  status:     ${isExpired ? chalk.red('EXPIRED - run: epam provider login codemie') : chalk.green('ACTIVE')}`);
  }
  console.log();
}

async function handleSSOLogout(providerName: string): Promise<void> {
  if (providerName !== 'codemie') {
    console.error(chalk.red(`SSO logout not supported for: ${providerName}`));
    return;
  }

  const sso = new CodemieSSO();
  await sso.clearStoredCredentials();
  
  console.log(chalk.green('✓ SSO credentials cleared for codemie.'));
  console.log(chalk.dim('  EPAM backend authentication is unaffected.'));
  console.log();
}

export function createProviderCommand(): Command {
  const provider = new Command('provider')
    .description('Manage provider credentials (anthropic, openai, gemini, codemie)');

  // epam provider login <provider>
  provider
    .command('login <provider>')
    .description('Store credentials for a provider (bridge: API key entry, codemie: OAuth, codex: CLI)')
    .option('--url <url>', 'Codemie URL (for codemie provider)')
    .action(async (providerName: string, options: { url?: string }) => {
      // Handle CLI-based providers (Codex)
      if (CLI_PROVIDERS.includes(providerName)) {
        await handleCLILogin(providerName);
        return;
      }

      // Handle SSO providers (Codemie)
      if (SSO_PROVIDERS.includes(providerName)) {
        await handleSSOLogin(providerName, options);
        return;
      }

      // Handle API key providers (Anthropic, OpenAI, Gemini)
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${[...SUPPORTED_PROVIDERS, ...SSO_PROVIDERS, ...CLI_PROVIDERS].join(', ')}`));
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
      // Handle SSO providers
      if (providerName === 'codemie') {
        await handleSSOStatus(providerName);
        return;
      }

      // Handle API key providers
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${[...SUPPORTED_PROVIDERS, ...SSO_PROVIDERS].join(', ')}`));
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
      // Handle SSO providers
      if (providerName === 'codemie') {
        await handleSSOLogout(providerName);
        return;
      }

      // Handle API key providers
      if (!SUPPORTED_PROVIDERS.includes(providerName as ProviderName)) {
        console.error(chalk.red(`Unsupported provider: ${providerName}. Supported: ${[...SUPPORTED_PROVIDERS, ...SSO_PROVIDERS].join(', ')}`));
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

      // Show API key providers
      for (const name of SUPPORTED_PROVIDERS) {
        const creds = allCredentials.filter(c => c.provider === name);
        const valid = creds.filter(c => !c.expiresAt || new Date(c.expiresAt) > now);

        if (valid.length === 0) {
          const expired = creds.filter(c => c.expiresAt && new Date(c.expiresAt) <= now);
          const icon = expired.length > 0 ? chalk.red('✗') : chalk.dim('○');
          const suffix = expired.length > 0 ? chalk.red(' (expired)') : chalk.dim(' (none)');
          console.log(`  ${icon} ${name.padEnd(12)}${suffix}`);
        } else {
          const best = valid[0];
          const expirySuffix = best.expiresAt
            ? chalk.dim(` expires ${new Date(best.expiresAt).toLocaleDateString()}`)
            : '';
          console.log(
            `  ${chalk.green('✓')} ${name.padEnd(12)} ${formatSource(best.source)}${expirySuffix}`
          );
        }
      }

      // Show SSO providers
      for (const name of SSO_PROVIDERS) {
        const sso = new CodemieSSO();
        const credentials = await sso.getStoredCredentials();
        
        if (!credentials) {
          console.log(`  ${chalk.dim('○')} ${name.padEnd(12)}${chalk.dim(' (not authenticated)')}`);
        } else {
          const isExpired = Date.now() > credentials.expiresAt;
          const icon = isExpired ? chalk.red('✗') : chalk.green('✓');
          const status = isExpired ? chalk.red(' (expired)') : chalk.green(' (active)');
          console.log(`  ${icon} ${name.padEnd(12)}${chalk.green('SSO OAuth')}${status}`);
        }
      }

      console.log();
    });

  return provider;
}
