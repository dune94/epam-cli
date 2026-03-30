import chalk from 'chalk';
import { marked } from 'marked';
// marked-terminal is a renderer for marked
let TerminalRenderer: unknown;
try {
  const mt = require('marked-terminal');
  TerminalRenderer = mt.default ?? mt;
} catch {
  TerminalRenderer = null;
}

export function formatMarkdown(text: string): string {
  if (!process.stdout.isTTY) return text;

  try {
    if (TerminalRenderer) {
      marked.use({ renderer: new (TerminalRenderer as new () => object)() as object } as Parameters<typeof marked.use>[0]);
    }
    return marked(text) as string;
  } catch {
    return text;
  }
}

export function formatUsage(inputTokens: number, outputTokens: number, sessionCost?: number): string {
  const tokens = `${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out tokens`;
  const cost = sessionCost != null && sessionCost > 0
    ? `  session: ${sessionCost < 0.0001 ? '<$0.0001' : `$${sessionCost.toFixed(4)}`}`
    : '';
  return chalk.dim(`[${tokens}${cost}]`);
}

export function formatError(message: string): string {
  return chalk.red(`Error: ${message}`);
}

export function formatSuccess(message: string): string {
  return chalk.green(message);
}

export function formatInfo(message: string): string {
  return chalk.cyan(message);
}

export function formatDim(message: string): string {
  return chalk.dim(message);
}
