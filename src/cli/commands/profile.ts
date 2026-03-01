import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { ProfileStore } from '../../agent/profiles/ProfileStore.js';
import type { Profile } from '../../agent/profiles/types.js';

export function createProfileCommand(): Command {
  const cmd = new Command('profile')
    .description('Manage agent profiles (saved configurations)')
    .action(() => {
      cmd.help();
    });

  cmd
    .command('list')
    .description('List all available profiles')
    .action(async () => {
      try {
        const config = await resolveConfig();
        const store = new ProfileStore(config.projectRoot);
        const profiles = await store.list();

        if (profiles.length === 0) {
          console.log(chalk.dim('No profiles found.'));
          console.log();
          console.log(chalk.dim('Create a profile with: epam profile save <name>'));
          return;
        }

        console.log(chalk.bold('\nAvailable Profiles:\n'));

        for (const profile of profiles) {
          const sourceTag =
            profile.source === 'local'
              ? chalk.cyan('[local]')
              : chalk.dim('[global]');
          const tags = profile.tags && profile.tags.length > 0
            ? chalk.dim(` · ${profile.tags.join(', ')}`)
            : '';

          console.log(`  ${chalk.bold(profile.name)} ${sourceTag}${tags}`);
          console.log(`    ${chalk.dim(profile.description || '(no description)')}`);

          const details: string[] = [];
          if (profile.model) details.push(`model: ${profile.model}`);
          if (profile.maxIterations) details.push(`maxIterations: ${profile.maxIterations}`);
          if (profile.tools?.enabled) details.push(`tools: ${profile.tools.enabled.length} enabled`);
          if (profile.tools?.disabled) details.push(`tools: ${profile.tools.disabled.length} disabled`);

          if (details.length > 0) {
            console.log(`    ${chalk.dim(details.join(' · '))}`);
          }
          console.log();
        }
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(1);
      }
    });

  cmd
    .command('load <name>')
    .description('Show what would be loaded from a profile (non-interactive)')
    .action(async (name: string) => {
      try {
        const config = await resolveConfig();
        const store = new ProfileStore(config.projectRoot);
        const profile = await store.load(name);

        if (!profile) {
          console.log(chalk.red(`Profile '${name}' not found.`));
          process.exit(1);
        }

        console.log(chalk.bold(`\nProfile: ${profile.name}\n`));
        console.log(`  Description:  ${chalk.dim(profile.description || '(none)')}`);
        console.log(`  Source:       ${profile.source === 'local' ? chalk.cyan('local') : chalk.dim('global')}`);
        console.log(`  File:         ${chalk.dim(profile.filePath)}`);

        if (profile.model) {
          console.log(`  Model:        ${chalk.cyan(profile.model)}`);
        }
        if (profile.maxIterations) {
          console.log(`  Max Iter:     ${profile.maxIterations}`);
        }
        if (profile.systemPromptAppend) {
          const preview = profile.systemPromptAppend.slice(0, 80);
          const suffix = profile.systemPromptAppend.length > 80 ? '…' : '';
          console.log(`  Sys Append:   ${chalk.dim(preview + suffix)}`);
        }
        if (profile.tools?.enabled) {
          console.log(`  Tools:        ${profile.tools.enabled.join(', ')}`);
        }
        if (profile.tools?.disabled) {
          console.log(`  Disabled:     ${profile.tools.disabled.join(', ')}`);
        }
        if (profile.tags && profile.tags.length > 0) {
          console.log(`  Tags:         ${profile.tags.join(', ')}`);
        }

        console.log();
        console.log(chalk.dim('To use this profile in a REPL session: /profile ' + name));
        console.log();
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(1);
      }
    });

  cmd
    .command('save <name>')
    .description('Save a new profile (interactive)')
    .option('-d, --description <text>', 'Profile description')
    .option('-m, --model <model>', 'Model override')
    .option('--max-iterations <n>', 'Max iterations override')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--global', 'Save to global profiles instead of project-local')
    .action(
      async (
        name: string,
        options: {
          description?: string;
          model?: string;
          maxIterations?: string;
          tags?: string;
          global?: boolean;
        }
      ) => {
        try {
          const config = await resolveConfig();
          const store = new ProfileStore(config.projectRoot);

          // Check if profile already exists
          const existing = await store.load(name);
          if (existing) {
            const response = await prompts({
              type: 'confirm',
              name: 'overwrite',
              message: `Profile '${name}' already exists. Overwrite?`,
              initial: false,
            });

            if (!response.overwrite) {
              console.log(chalk.dim('Cancelled.'));
              return;
            }
          }

          // Prompt for missing fields
          let description = options.description;
          if (!description) {
            const response = await prompts({
              type: 'text',
              name: 'description',
              message: 'Description:',
              initial: existing?.description ?? '',
            });
            description = response.description || '';
          }

          const profile: Profile = {
            name,
            description: description || '',
            model: options.model,
            maxIterations: options.maxIterations ? parseInt(options.maxIterations, 10) : undefined,
            tags: options.tags ? options.tags.split(',').map(t => t.trim()) : undefined,
          };

          const location = options.global ? 'global' : 'local';
          const filePath = await store.save(profile, location);

          console.log(chalk.green(`Profile '${name}' saved to ${location}`));
          console.log(chalk.dim(filePath));
          console.log();
        } catch (error) {
          process.stderr.write(
            `Error: ${error instanceof Error ? error.message : String(error)}\n`
          );
          process.exit(1);
        }
      }
    );

  cmd
    .command('delete <name>')
    .description('Delete a profile')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (name: string, options: { yes?: boolean }) => {
      try {
        const config = await resolveConfig();
        const store = new ProfileStore(config.projectRoot);

        // Check if profile exists
        const profile = await store.load(name);
        if (!profile) {
          console.log(chalk.yellow(`Profile '${name}' not found.`));
          return;
        }

        // Confirm deletion
        if (!options.yes) {
          console.log(
            chalk.dim(`Profile: ${profile.name} (${profile.source})`)
          );
          console.log(chalk.dim(`File: ${profile.filePath}`));

          const response = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Delete this profile?`,
            initial: false,
          });

          if (!response.confirm) {
            console.log(chalk.dim('Cancelled.'));
            return;
          }
        }

        const result = await store.delete(name);

        if (result.notFound) {
          console.log(chalk.yellow(`Profile '${name}' not found.`));
        } else {
          console.log(chalk.green(`Deleted ${result.deleted.length} file(s):`));
          for (const file of result.deleted) {
            console.log(chalk.dim(`  ${file}`));
          }
        }
        console.log();
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(1);
      }
    });

  return cmd;
}
