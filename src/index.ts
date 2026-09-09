import 'dotenv/config';
import { createCLI } from './cli/index.js';

const VERSION = '0.1.0';

async function main() {
  const program = createCLI(VERSION);

  // If the user passes flags without a subcommand (e.g. `epam --provider openai`),
  // inject 'chat' so flags reach the chat command directly.
  const knownSubcommands = program.commands.map(c => c.name());
  const userArgs = process.argv.slice(2);
  const firstNonFlag = userArgs.find(a => !a.startsWith('-'));
  if (!firstNonFlag || !knownSubcommands.includes(firstNonFlag)) {
    process.argv.splice(2, 0, 'chat');
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`\nError: ${err.message}\n`);
      if (process.env.EPAM_DEBUG === '1') {
        process.stderr.write((err.stack ?? '') + '\n');
      }
    }
    process.exit(1);
  }
}

main();
