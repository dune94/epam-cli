import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { loadSession, listSessions } from '../../context/SessionStore.js';
import type { SessionTurn } from '../../context/types.js';

export function createReplayCommand(): Command {
  return new Command('replay')
    .description('Replay a session with user messages, assistant responses, and tool calls')
    .argument('[session_id]', 'Session ID to replay')
    .option('-s, --speed <multiplier>', 'Playback speed (1, 2, or 4)', '1')
    .action(async (sessionIdArg, opts) => {
      const speed = parseSpeed(opts.speed);
      const config = await resolveConfig();

      let sessionId = sessionIdArg;

      // If no session ID provided, show interactive picker
      if (!sessionId) {
        sessionId = await pickSession(config.projectRoot);
        if (!sessionId) return; // User cancelled
      }

      // Load the session
      const session = await loadSession(sessionId, config.projectRoot);
      if (!session) {
        console.log(chalk.red(`Session '${sessionId}' not found.`));
        return;
      }

      if (session.turns.length === 0) {
        console.log(chalk.dim('Session is empty.'));
        return;
      }

      // Replay the session
      console.log(chalk.bold(`\nReplaying session ${chalk.cyan(sessionId.slice(-8))} at ${speed}x speed\n`));
      await replaySession(session.turns, speed);
      console.log(chalk.dim('\nReplay complete.\n'));
    });
}

function parseSpeed(speedStr: string): number {
  const speed = parseInt(speedStr, 10);
  if (![1, 2, 4].includes(speed)) {
    console.log(chalk.yellow(`Invalid speed '${speedStr}', using 1x`));
    return 1;
  }
  return speed;
}

async function pickSession(projectRoot: string | null): Promise<string | null> {
  const sessions = await listSessions(projectRoot, 20);

  if (sessions.length === 0) {
    console.log(chalk.dim('No sessions found.'));
    return null;
  }

  const choices = sessions.map(s => {
    const firstTurn = s.turnCount > 0 ? '...' : '(empty)';
    return {
      title:
        `${chalk.cyan(s.id.slice(-8))}  ` +
        `${chalk.dim(s.updatedAt.toLocaleString())}  ` +
        chalk.dim(`${s.turnCount} turn${s.turnCount !== 1 ? 's' : ''}  ${firstTurn}`),
      value: s.id,
      description: s.id,
    };
  });

  const response = await prompts({
    type: 'select',
    name: 'id',
    message: 'Select a session to replay:',
    choices,
    initial: 0,
  });

  return response.id as string | undefined ?? null;
}

async function replaySession(turns: SessionTurn[], speed: number): Promise<void> {
  const delayMs = getDelayForSpeed(speed);

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    console.log(chalk.bold(`\n─── Turn ${i + 1} ───\n`));

    // User message (cyan)
    console.log(chalk.cyan.bold('User:'));
    console.log(chalk.cyan(indent(turn.userMessage)));
    console.log();

    // Assistant response (white)
    console.log(chalk.white.bold('Assistant:'));
    console.log(chalk.white(indent(turn.assistantResponse)));
    console.log();

    // Tool calls (yellow) - if available
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      console.log(chalk.yellow.bold('Tool Calls:'));
      for (const toolCall of turn.toolCalls) {
        const argsPreview = truncateArgs(toolCall.input);
        console.log(
          chalk.yellow(
            `  ${toolCall.name}${argsPreview ? chalk.dim(` — ${argsPreview}`) : ''}`
          )
        );
      }
      console.log();
    } else if (turn.toolCallCount > 0) {
      // Fallback: just show count if tool calls not stored
      console.log(
        chalk.yellow.dim(`Tool calls: ${turn.toolCallCount} (details not available)`)
      );
      console.log();
    }

    // Pause between turns (except after last turn)
    if (i < turns.length - 1) {
      await sleep(delayMs);
    }
  }
}

function getDelayForSpeed(speed: number): number {
  switch (speed) {
    case 1:
      return 2000; // 2 seconds
    case 2:
      return 1000; // 1 second
    case 4:
      return 500; // 0.5 seconds
    default:
      return 2000;
  }
}

function indent(text: string, spaces = 2): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

function truncateArgs(input: Record<string, unknown> | undefined): string {
  if (!input) return '';

  const json = JSON.stringify(input);
  const maxLen = 60;

  if (json.length <= maxLen) return json;

  return json.slice(0, maxLen) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
