import { glob } from 'glob';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';

export class ListFilesTool implements Tool {
  readonly name = 'list_files';
  readonly description =
    'List files matching a glob pattern. Returns a list of matching file paths.';
  readonly permission = 'safe' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files (e.g. "src/**/*.ts", "*.json")',
        },
        cwd: {
          type: 'string',
          description: 'Directory to search in (default: current directory)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 100)',
        },
      },
      required: ['pattern'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const cwd = (input.cwd as string) ?? process.cwd();
    const limit = (input.limit as number) ?? 100;

    try {
      const files = await glob(pattern, {
        cwd: path.resolve(cwd),
        nodir: false,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      const limited = files.slice(0, limit);
      const content =
        limited.length > 0
          ? limited.join('\n') +
            (files.length > limit ? `\n... (${files.length - limit} more)` : '')
          : '(no files found)';

      return { toolUseId: '', content, isError: false };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error listing files: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
