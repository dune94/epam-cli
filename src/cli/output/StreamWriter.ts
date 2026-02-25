import process from 'process';
import chalk from 'chalk';

export class StreamWriter {
  private isFirstDelta = true;

  write(text: string): void {
    process.stdout.write(text);
    this.isFirstDelta = false;
  }

  writeLine(text: string): void {
    process.stdout.write(text + '\n');
  }

  writeToolCall(toolName: string, input: Record<string, unknown>): void {
    const inputStr = JSON.stringify(input);
    const preview = inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr;
    process.stderr.write(chalk.dim(`\n[tool: ${toolName}] ${preview}\n`));
  }

  writeToolResult(toolName: string, result: string, isError: boolean): void {
    if (isError) {
      process.stderr.write(chalk.red(`[${toolName} error] ${result.slice(0, 200)}\n`));
    } else {
      const preview = result.length > 100 ? result.slice(0, 100) + '...' : result;
      process.stderr.write(chalk.dim(`[${toolName}] ${preview}\n`));
    }
  }

  flush(): void {
    // stdout is synchronous in Node.js
  }

  newline(): void {
    process.stdout.write('\n');
  }

  reset(): void {
    this.isFirstDelta = true;
  }
}
