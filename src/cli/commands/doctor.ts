import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { resolveProviderCredential } from '../../auth/ProviderCredentialStore.js';
import type { ProviderName } from '../../auth/types.js';

async function check(
  name: string,
  fn: () => Promise<{ ok: boolean; message: string }>
): Promise<boolean> {
  try {
    const result = await fn();
    const icon = result.ok ? chalk.green('✓') : chalk.yellow('✗');
    console.log(`${icon} ${name}: ${result.message}`);
    return result.ok;
  } catch (err) {
    console.log(`${chalk.red('✗')} ${name}: ${chalk.red((err as Error).message)}`);
    return false;
  }
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Check epam-cli dependencies and configuration')
    .action(async () => {
      console.log(chalk.bold('\nRunning health checks...\n'));

      let allOk = true;

      allOk =
        (await check('Node.js version', async () => {
          const version = process.versions.node;
          const [major] = version.split('.').map(Number);
          return {
            ok: major >= 20,
            message: `v${version}${major < 20 ? ' (requires v20+)' : ''}`,
          };
        })) && allOk;

      allOk =
        (await check('keytar (native keychain)', async () => {
          try {
            await import('keytar');
            return { ok: true, message: 'available' };
          } catch {
            return {
              ok: false,
              message: 'not available (will use file-based credential storage)',
            };
          }
        })) && allOk;

      const config = await resolveConfig();

      allOk =
        (await check('Configuration', async () => ({
          ok: true,
          message: `provider=${config.provider}, model=${config.model}`,
        }))) && allOk;

      allOk =
        (await check('Authentication', async () => {
          const authManager = new AuthManager(config.backendUrl);
          const user = await authManager.getUser();
          return {
            ok: !!user,
            message: user
              ? `logged in as ${user.email}`
              : 'not authenticated (run `epam login`)',
          };
        })) && allOk;

      allOk =
        (await check('Backend connectivity', async () => {
          const res = await fetch(`${config.backendUrl}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          return {
            ok: res.ok,
            message: res.ok ? `${config.backendUrl} (ok)` : `HTTP ${res.status}`,
          };
        })) && allOk;

      // Provider Auth section (EPAM-047)
      console.log();
      console.log(chalk.bold('Provider Auth:'));
      const providerNames: ProviderName[] = ['anthropic', 'openai', 'gemini'];
      for (const name of providerNames) {
        const envKeyMap: Record<ProviderName, string | undefined> = {
          anthropic: process.env.EPAM_API_KEY_ANTHROPIC,
          openai:    process.env.EPAM_API_KEY_OPENAI,
          gemini:    process.env.EPAM_API_KEY_GEMINI,
        };
        const envKey = envKeyMap[name];

        if (envKey) {
          const masked = `${envKey.slice(0, 4)}...${envKey.slice(-4)}`;
          console.log(`  ${chalk.green('✓')} ${name.padEnd(12)} ${chalk.dim('env_var')}  ${masked}`);
        } else {
          try {
            const record = await resolveProviderCredential(name);
            if (!record) {
              console.log(`  ${chalk.dim('○')} ${name.padEnd(12)} ${chalk.dim('none')}`);
            } else {
              const now = new Date();
              const expired = record.expiresAt && new Date(record.expiresAt) <= now;
              const icon = expired ? chalk.red('✗') : chalk.green('✓');
              const masked = record.secret.length > 8
                ? `${record.secret.slice(0, 4)}...${record.secret.slice(-4)}`
                : '****';
              const expirySuffix = expired
                ? chalk.red(` (expired ${new Date(record.expiresAt!).toLocaleDateString()})`)
                : record.expiresAt
                  ? chalk.dim(` expires ${new Date(record.expiresAt).toLocaleDateString()}`)
                  : '';
              const accountSuffix = record.accountLabel ? chalk.dim(`  [${record.accountLabel}]`) : '';
              console.log(`  ${icon} ${name.padEnd(12)} ${chalk.dim(record.source)}  ${masked}${expirySuffix}${accountSuffix}`);
            }
          } catch {
            console.log(`  ${chalk.red('✗')} ${name.padEnd(12)} ${chalk.red('error reading credentials')}`);
          }
        }
      }

      console.log();
      console.log(
        allOk
          ? chalk.green.bold('All checks passed!')
          : chalk.yellow('Some checks failed. See above for details.')
      );
    });
}
