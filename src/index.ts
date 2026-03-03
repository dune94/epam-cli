import 'dotenv/config';
import { createCLI } from './cli/index.js';

const VERSION = '0.1.0';

async function main() {
  const program = createCLI(VERSION);

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
