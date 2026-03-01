import { Command } from 'commander';
import chalk from 'chalk';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { ProfileLoader } from '../../agent/profiles/ProfileLoader.js';
import { queueConsultationForNextTurn } from '../../context/ContextBuilder.js';

function formatProfileHandle(profileName: string): string {
  return `@${ProfileLoader.normalizeProfileName(profileName)}`;
}

export function createConsultCommand(): Command {
  return new Command('consult')
    .description('Consult a saved expertise profile for the next response only')
    .argument('<profile>', 'Profile name to consult, prefixed with @')
    .action(async (profileArg: string) => {
      try {
        const config = await resolveConfig();
        const requestedProfile = ProfileLoader.normalizeProfileName(profileArg);
        const consultation = await ProfileLoader.resolveConsultation(
          requestedProfile,
          config.projectRoot
        );

        if (!consultation) {
          const profiles = await ProfileLoader.listAvailableProfiles(config.projectRoot);
          const available = profiles.map(profile => formatProfileHandle(profile.name));

          process.stderr.write(
            `Error: profile '${formatProfileHandle(profileArg)}' not found.\n`
          );

          if (available.length > 0) {
            process.stderr.write(`Available profiles: ${available.join(', ')}\n`);
          } else {
            process.stderr.write('Available profiles: none\n');
          }

          process.exit(1);
        }

        await queueConsultationForNextTurn({
          profileName: consultation.profile.name,
          systemPromptAppend: consultation.profile.systemPromptAppend,
          decisions: consultation.decisions,
        }, config.projectRoot ?? process.cwd());

        console.log(chalk.green(`Consulting ${formatProfileHandle(requestedProfile)} for next response...`));
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(1);
      }
    });
}
