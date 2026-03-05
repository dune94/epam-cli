import chalk from 'chalk';
import { formatUsage } from '../output/Formatter.js';

export class Renderer {
  renderPrompt(_provider: string, _model: string): string {
    return chalk.cyan.bold('epam') + chalk.cyan(' › ');
  }

  renderWelcome(version: string, _provider: string, _model: string, projectRoot: string | null): void {
    console.log();
    console.log(chalk.bold.cyan('EPAM CLI') + chalk.dim(` v${version}`));
    if (projectRoot) {
      console.log(chalk.dim(`Project: ${projectRoot}`));
    }
    console.log(chalk.dim('Type /help for commands, Ctrl+C twice to quit'));
    console.log();
  }

  renderUsage(inputTokens: number, outputTokens: number, sessionCost?: number): void {
    process.stderr.write(formatUsage(inputTokens, outputTokens, sessionCost) + '\n');
  }

  renderError(message: string): void {
    console.error(chalk.red(`\nError: ${message}`));
  }

  renderThinking(): void {
    process.stderr.write(chalk.dim('\nThinking...\n'));
  }
}
