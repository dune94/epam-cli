/**
 * /share Slash Command
 *
 * Exports current session as a portable .epam-session.json bundle
 * that any team member can import on their machine via /import or epam-cli import.
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { ulid } from 'ulid';
import { readTeamConfig, writeTeamConfig } from './TeamCommand.js';

export interface SessionBundle {
  version: '1';
  exportedAt: string;
  exportedBy: string;
  teamNote?: string;
  model: string;
  provider: string;
  turns: Array<{
    id: string;
    timestamp: number;
    userMessage: string;
    assistantResponse: string;
    toolCallCount: number;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

export const shareCommand: SlashCommand = {
  name: 'share',
  aliases: ['share-session'],
  description: 'Export session as portable bundle for team to import',
  usage: '[note]',

  async execute(args, ctx): Promise<boolean> {
    const teamNote = args.trim() || undefined;

    if (ctx.messages.length === 0) {
      console.log();
      console.log(chalk.yellow('⚠  No conversation to share yet'));
      console.log();
      return true;
    }

    console.log();
    console.log(chalk.bold.cyan('📤 Sharing Session'));
    console.log();

    const sessionId = ulid();
    const exportedBy =
      ctx.userEmail ||
      process.env.EPAM_USER_EMAIL ||
      process.env.USER ||
      'unknown';

    // Build turns from alternating user/assistant messages
    const turns: SessionBundle['turns'] = [];
    for (let i = 0; i < ctx.messages.length - 1; i++) {
      const cur = ctx.messages[i];
      const next = ctx.messages[i + 1];
      if (cur.role === 'user' && next.role === 'assistant') {
        turns.push({
          id: ulid(),
          timestamp: Date.now(),
          userMessage:
            typeof cur.content === 'string' ? cur.content : JSON.stringify(cur.content),
          assistantResponse:
            typeof next.content === 'string' ? next.content : JSON.stringify(next.content),
          toolCallCount: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        i++; // skip the assistant message we just consumed
      }
    }

    const bundle: SessionBundle = {
      version: '1',
      exportedAt: new Date().toISOString(),
      exportedBy,
      teamNote,
      model: ctx.currentModel,
      provider: ctx.config.provider,
      turns,
    };

    const projectRoot = ctx.config.projectRoot || process.cwd();
    const sharedDir = join(projectRoot, '.epam', 'shared');
    const bundlePath = join(sharedDir, `${sessionId}.epam-session.json`);
    const mdPath = join(sharedDir, `${sessionId}.md`);

    try {
      await mkdir(sharedDir, { recursive: true });
      await writeFile(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');
      await writeFile(mdPath, buildTranscript(ctx, sessionId, bundle), 'utf-8');

      // Register in team.json sharedSessions
      const team = readTeamConfig(projectRoot);
      if (team && !team.sharedSessions.includes(sessionId)) {
        team.sharedSessions.push(sessionId);
        writeTeamConfig(projectRoot, team);
      }

      console.log(chalk.green('✓ Session exported'));
      console.log(`  ${chalk.bold('Bundle:')} ${chalk.white(bundlePath)}`);
      console.log(`  ${chalk.bold('Turns:')} ${chalk.white(turns.length)}`);
      console.log(`  ${chalk.bold('Model:')} ${chalk.white(bundle.model)}`);
      if (teamNote) console.log(`  ${chalk.bold('Note:')} ${chalk.white(teamNote)}`);
      console.log();
      console.log(chalk.bold('Share with your team:'));
      console.log(chalk.dim(`  Send: ${bundlePath}`));
      console.log(chalk.dim('  They run: epam-cli import <file>'));
      console.log(chalk.dim('  Or in REPL: /import <path>'));
      console.log();
    } catch (err) {
      console.log(chalk.red('✗ Export failed'));
      console.log(chalk.dim((err as Error).message));
      console.log();
    }

    return true;
  },
};

function buildTranscript(ctx: SlashCommandContext, sessionId: string, bundle: SessionBundle): string {
  const lines: string[] = [
    '# EPAM CLI Session Transcript',
    '',
    `**Session ID:** ${sessionId}`,
    `**Exported:** ${bundle.exportedAt}`,
    `**By:** ${bundle.exportedBy}`,
    `**Provider:** ${bundle.provider}`,
    `**Model:** ${bundle.model}`,
    bundle.teamNote ? `**Note:** ${bundle.teamNote}` : '',
    '',
    '---',
    '',
    '## Conversation',
    '',
  ];

  for (const msg of ctx.messages) {
    const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    const content =
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
    lines.push(`### ${role}`, '', content, '');
  }

  lines.push(
    '---',
    '',
    '## Statistics',
    '',
    `- **Input tokens:** ${ctx.totalInputTokens.toLocaleString()}`,
    `- **Output tokens:** ${ctx.totalOutputTokens.toLocaleString()}`,
    `- **Session cost:** $${(ctx.budgetGuard?.sessionCost || 0).toFixed(4)}`,
    '',
  );

  return lines.filter(l => l !== undefined).join('\n');
}
