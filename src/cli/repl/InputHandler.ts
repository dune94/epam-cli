import { findCommand } from './SlashCommands.js';
import type { SlashCommandContext } from './SlashCommands.js';

export type InputType = 'slash_command' | 'message' | 'empty';

export interface ParsedInput {
  type: InputType;
  raw: string;
  message?: string;
  slashCommand?: string;
  slashArgs?: string;
}

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { type: 'empty', raw };
  }

  if (trimmed.startsWith('/')) {
    const match = findCommand(trimmed);
    if (match) {
      return {
        type: 'slash_command',
        raw,
        slashCommand: match.command.name,
        slashArgs: match.args,
      };
    }
    // Unknown slash command — treat as message
  }

  return { type: 'message', raw, message: trimmed };
}

export async function handleSlashCommand(
  input: ParsedInput,
  ctx: SlashCommandContext
): Promise<boolean> {
  const match = findCommand(input.raw.trim());
  if (!match) {
    console.log(`Unknown command: ${input.raw.trim()}. Type /help for available commands.`);
    return true;
  }
  return match.command.execute(match.args, ctx);
}
