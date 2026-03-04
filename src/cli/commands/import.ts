/**
 * epam-cli import <file>
 *
 * Import a .epam-session.json bundle shared by a team member.
 * Installs the session into local storage and starts the REPL with it loaded.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, basename } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { saveSession } from '../../context/SessionStore.js';
import { ulid } from 'ulid';
import type { SessionBundle } from '../repl/commands/ShareCommand.js';

export function createImportCommand(): Command {
  return new Command('import')
    .description('Import a shared session bundle from a team member')
    .argument('<file>', 'Path to .epam-session.json bundle')
    .option('--no-start', 'Install session but do not start the REPL')
    .action(async (file: string, opts: { start: boolean }) => {
      const absPath = resolve(file);

      if (!existsSync(absPath)) {
        console.error(chalk.red(`✗ File not found: ${absPath}`));
        process.exit(1);
      }

      let bundle: SessionBundle;
      try {
        bundle = JSON.parse(readFileSync(absPath, 'utf-8')) as SessionBundle;
      } catch {
        console.error(chalk.red('✗ Invalid bundle — must be a valid .epam-session.json'));
        process.exit(1);
      }

      if (bundle.version !== '1' || !Array.isArray(bundle.turns)) {
        console.error(chalk.red('✗ Unrecognised bundle format (expected version 1)'));
        process.exit(1);
      }

      const config = await resolveConfig();
      const newSessionId = ulid();

      await saveSession({
        id: newSessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectRoot: config.projectRoot ?? null,
        model: bundle.model,
        provider: bundle.provider,
        turns: bundle.turns,
      });

      console.log();
      console.log(chalk.bold.green('✓ Session imported'));
      console.log(`  ${chalk.bold('From:')}    ${chalk.white(bundle.exportedBy)}`);
      console.log(`  ${chalk.bold('Model:')}   ${chalk.white(bundle.model)}`);
      console.log(`  ${chalk.bold('Turns:')}   ${chalk.white(bundle.turns.length)}`);
      if (bundle.teamNote) {
        console.log(`  ${chalk.bold('Note:')}    ${chalk.white(bundle.teamNote)}`);
      }
      console.log(`  ${chalk.bold('Session:')} ${chalk.dim(newSessionId)}`);
      console.log();

      // Show last 3 turns as context recap before starting REPL
      const recentTurns = bundle.turns.slice(-3);
      if (recentTurns.length > 0) {
        console.log(chalk.bold('─── Last ' + recentTurns.length + ' turn' + (recentTurns.length > 1 ? 's' : '') + ' ───────────────────────────────'));
        console.log();
        for (const turn of recentTurns) {
          const userPreview = turn.userMessage.length > 120
            ? turn.userMessage.slice(0, 120) + '…'
            : turn.userMessage;
          console.log(chalk.bold.blue('You: ') + chalk.white(userPreview));
          const assistantPreview = turn.assistantResponse.length > 200
            ? turn.assistantResponse.slice(0, 200) + '…'
            : turn.assistantResponse;
          console.log(chalk.bold.green('AI:  ') + chalk.dim(assistantPreview));
          console.log();
        }
        console.log(chalk.bold('─'.repeat(50)));
        console.log();
      }

      if (opts.start === false) {
        console.log(chalk.dim(`Resume with: epam-cli chat  then  /resume ${newSessionId}`));
        console.log();
        return;
      }

      console.log(chalk.dim('Starting session — continue the conversation below ↓'));
      console.log();

      // Dynamically start chat with auto-resume
      const { createChatCommand } = await import('./chat.js');
      const chatCmd = createChatCommand();
      // Pass session id via env so Repl can auto-resume on startup
      process.env.EPAM_AUTO_RESUME = newSessionId;
      await chatCmd.parseAsync([], { from: 'user' });
    });
}
