/**
 * /import Slash Command
 *
 * Import a .epam-session.json bundle shared by a team member.
 * Installs the session locally and resumes it immediately.
 */

import chalk from 'chalk';
import type { SlashCommand } from '../SlashCommands.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ulid } from 'ulid';
import { saveSession } from '../../../context/SessionStore.js';
import type { SessionBundle } from './ShareCommand.js';

export const importCommand: SlashCommand = {
  name: 'import',
  aliases: ['load-session'],
  description: 'Import a shared session bundle from a team member',
  usage: '<path-to-bundle.epam-session.json>',

  async execute(args, ctx): Promise<boolean> {
    const bundlePath = args.trim();

    if (!bundlePath) {
      console.log();
      console.log(chalk.bold.cyan('📥 Import Session'));
      console.log();
      console.log(chalk.dim('Usage: /import <path-to-bundle.epam-session.json>'));
      console.log();
      console.log(chalk.bold('Example:'));
      console.log(chalk.dim('  /import ~/Downloads/session.epam-session.json'));
      console.log(chalk.dim('  /import .epam/shared/01J9X.epam-session.json'));
      console.log();
      return true;
    }

    const absPath = resolve(bundlePath);

    if (!existsSync(absPath)) {
      console.log();
      console.log(chalk.red(`✗ File not found: ${absPath}`));
      console.log();
      return true;
    }

    console.log();
    console.log(chalk.bold.cyan('📥 Importing Session'));
    console.log();

    let bundle: SessionBundle;
    try {
      bundle = JSON.parse(readFileSync(absPath, 'utf-8')) as SessionBundle;
    } catch {
      console.log(chalk.red('✗ Invalid bundle file — must be a valid .epam-session.json'));
      console.log();
      return true;
    }

    if (bundle.version !== '1' || !Array.isArray(bundle.turns)) {
      console.log(chalk.red('✗ Unrecognised bundle format (expected version 1)'));
      console.log();
      return true;
    }

    // Install into local sessions with a fresh ID
    const newSessionId = ulid();
    const projectRoot = ctx.config.projectRoot ?? null;

    await saveSession({
      id: newSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectRoot,
      model: bundle.model,
      provider: bundle.provider,
      turns: bundle.turns,
    });

    // Resume into current REPL context
    const result = await ctx.onResume(newSessionId);

    if (!result.success) {
      console.log(chalk.red('✗ Failed to resume imported session'));
      console.log();
      return true;
    }

    console.log(chalk.green('✓ Session imported and resumed'));
    console.log(`  ${chalk.bold('From:')}   ${chalk.white(bundle.exportedBy)}`);
    console.log(`  ${chalk.bold('Model:')}  ${chalk.white(bundle.model)}`);
    console.log(`  ${chalk.bold('Turns:')}  ${chalk.white(result.turnCount)}`);
    if (bundle.teamNote) {
      console.log(`  ${chalk.bold('Note:')}   ${chalk.white(bundle.teamNote)}`);
    }
    console.log(`  ${chalk.bold('Exported:')} ${chalk.white(bundle.exportedAt)}`);
    console.log();

    // Show last 3 turns as context recap
    const recentTurns = bundle.turns.slice(-3);
    if (recentTurns.length > 0) {
      console.log(chalk.bold('─── Last ' + recentTurns.length + ' turn' + (recentTurns.length > 1 ? 's' : '') + ' ───────────────────────────────'));
      console.log();
      for (const turn of recentTurns) {
        // User message
        const userPreview = turn.userMessage.length > 120
          ? turn.userMessage.slice(0, 120) + '…'
          : turn.userMessage;
        console.log(chalk.bold.blue('You: ') + chalk.white(userPreview));

        // Assistant response
        const assistantPreview = turn.assistantResponse.length > 200
          ? turn.assistantResponse.slice(0, 200) + '…'
          : turn.assistantResponse;
        console.log(chalk.bold.green('AI:  ') + chalk.dim(assistantPreview));
        console.log();
      }
      console.log(chalk.bold('─'.repeat(50)));
      console.log();
    }

    console.log(chalk.dim('Continue the conversation below ↓'));
    console.log();

    return true;
  },
};
