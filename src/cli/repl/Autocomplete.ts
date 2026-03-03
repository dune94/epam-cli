/**
 * Slash Command Autocomplete
 * 
 * Provides tab-completion for slash commands in the REPL
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { SLASH_COMMANDS } from './SlashCommands.js';

/**
 * Get all available slash command names
 */
export function getCommandNames(): string[] {
  return SLASH_COMMANDS.map(cmd => cmd.name);
}

/**
 * Get command aliases mapping (alias -> command name)
 */
export function getCommandAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        aliases[alias] = cmd.name;
      }
    }
  }
  
  return aliases;
}

/**
 * Get command by name or alias
 */
export function getCommand(name: string) {
  return SLASH_COMMANDS.find(cmd => 
    cmd.name === name || cmd.aliases?.includes(name)
  );
}

/**
 * Autocomplete handler for readline
 *
 * Usage:
 * const rl = readline.createInterface({ input, output });
 * rl.completer = createCompleter();
 */
export function createCompleter(): readline.Completer {
  const commands = getCommandNames();
  const aliases = getCommandAliases();

  return (line: string): [string[], string] => {
    // Only autocomplete slash commands
    if (!line.startsWith('/')) {
      // Return empty to prevent hang
      return [[], line];
    }

    // Remove leading slash for matching
    const partial = line.slice(1);
    const lastSpaceIndex = partial.lastIndexOf(' ');

    if (lastSpaceIndex === -1) {
      // Autocomplete command name
      const matches = commands.filter(cmd => cmd.startsWith(partial));

      // Also check aliases
      for (const [alias, name] of Object.entries(aliases)) {
        if (alias.startsWith(partial) && !matches.includes(name)) {
          matches.push(name);
        }
      }

      // If no matches, return the original line to prevent hang
      if (matches.length === 0) {
        return [[], line];
      }

      return [
        matches.map(m => '/' + m),
        partial,
      ];
    }

    // Autocomplete command arguments (future enhancement)
    // For now, return empty to prevent hang
    return [[], line];
  };
}

/**
 * Setup autocomplete on a readline interface
 */
export function setupAutocomplete(rl: readline.Interface): void {
  rl.completer = createCompleter();
}

/**
 * Get help text for a command
 */
export function getCommandHelp(commandName: string): string | null {
  const cmd = getCommand(commandName);
  if (!cmd) return null;
  
  const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
  const usage = cmd.usage ? ` ${cmd.usage}` : '';
  
  return `/${cmd.name}${aliases}${usage} — ${cmd.description}`;
}

/**
 * List all commands with descriptions
 */
export function listCommands(): string {
  const lines: string[] = [];

  for (const cmd of SLASH_COMMANDS) {
    const aliases = cmd.aliases ? chalk.dim(` (${cmd.aliases.join(', ')})`) : '';
    const usage = cmd.usage ? chalk.dim(` ${cmd.usage}`) : '';

    lines.push(`  ${chalk.cyan('/' + cmd.name)}${aliases}${usage}`);
    lines.push(chalk.dim(`    ${cmd.description}`));
  }

  return lines.join('\n');
}
