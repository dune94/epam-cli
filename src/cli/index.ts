import { Command } from 'commander';
import { createChatCommand } from './commands/chat.js';
import { createRunCommand } from './commands/run.js';
import { createLoginCommand } from './commands/login.js';
import { createLogoutCommand } from './commands/logout.js';
import { createWhoamiCommand } from './commands/whoami.js';
import { createConfigCommand } from './commands/config.js';
import { createContextCommand } from './commands/context.js';
import { createKeysCommand } from './commands/keys.js';
import { createHistoryCommand } from './commands/history.js';
import { createModelsCommand } from './commands/models.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createEstimateCommand } from './commands/estimate.js';
import { createOrchestrateCommand } from './commands/orchestrate.js';
import { createConsultCommand } from './commands/consult.js';
import { createDecisionCommand } from './commands/decision.js';
import { createInitCommand } from './commands/init.js';
import { createMcpCommand } from './commands/mcp.js';
import { createPhaseCommand } from './commands/phase.js';
import { createProfileCommand } from './commands/profile.js';
import { createReplayCommand } from './commands/replay.js';
import { createReportCommand } from './commands/report.js';
import { createSquadCommand } from './commands/squad.js';
import { createSyncCommand } from './commands/sync.js';
import { createProviderCommand } from './commands/provider.js';
import { createImportCommand } from './commands/import.js';

export function createCLI(version: string): Command {
  const program = new Command();

  program
    .name('epam')
    .description('EPAM CLI — AI coding assistant')
    .version(version, '-v, --version', 'Output the current version')
    .helpOption('-h, --help', 'Display help')
    .option('-p, --provider <provider>', 'Provider to start the session with')
    .option('-m, --model <model>', 'Model to start the session with');

  program.addCommand(createChatCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createLoginCommand());
  program.addCommand(createLogoutCommand());
  program.addCommand(createWhoamiCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createContextCommand());
  program.addCommand(createKeysCommand());
  program.addCommand(createHistoryCommand());
  program.addCommand(createModelsCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createEstimateCommand());
  program.addCommand(createOrchestrateCommand());
  program.addCommand(createConsultCommand());
  program.addCommand(createDecisionCommand());
  program.addCommand(createInitCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createPhaseCommand());
  program.addCommand(createProfileCommand());
  program.addCommand(createReplayCommand());
  program.addCommand(createReportCommand());
  program.addCommand(createSquadCommand());
  program.addCommand(createSyncCommand());
  program.addCommand(createProviderCommand());
  program.addCommand(createImportCommand());

  // Default: start chat if interactive, else show help
  program.action((opts) => {
    if (process.stdin.isTTY) {
      const args = ['', '', 'chat'];
      if (opts.provider) { args.push('--provider', opts.provider as string); }
      if (opts.model)    { args.push('--model',    opts.model    as string); }
      program.parse(args);
    } else {
      program.help();
    }
  });

  return program;
}
