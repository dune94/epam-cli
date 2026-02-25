import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';

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

      console.log();
      console.log(
        allOk
          ? chalk.green.bold('All checks passed!')
          : chalk.yellow('Some checks failed. See above for details.')
      );
    });
}
