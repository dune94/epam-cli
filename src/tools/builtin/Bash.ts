import { execa } from 'execa';
import type { Tool, ToolResult } from '../types.js';

export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description =
    'Execute a bash command. Use for running scripts, installing packages, running tests, etc.';
  readonly permission = 'dangerous' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (default: current directory)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = input.command as string;
    const cwd = (input.cwd as string) ?? process.cwd();
    const timeout = (input.timeout as number) ?? 30000;

    try {
      const result = await execa('bash', ['-c', command], {
        cwd,
        timeout,
        all: true,
        reject: false,
      });

      const output = result.all ?? result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.exitCode ?? 0;

      let content = output;
      if (stderr && exitCode !== 0) {
        content += stderr ? `\nSTDERR:\n${stderr}` : '';
      }
      if (exitCode !== 0) {
        content += `\nExit code: ${exitCode}`;
      }

      return { toolUseId: '', content: content || '(no output)', isError: exitCode !== 0 };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error executing command: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
