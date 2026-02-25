import { execa } from 'execa';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';

export class SearchTool implements Tool {
  readonly name = 'search';
  readonly description =
    'Search for a pattern in files using ripgrep (rg) or grep. Returns matching lines with file and line number.';
  readonly permission = 'safe' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: {
          type: 'string',
          description: 'Directory or file to search in (default: current directory)',
        },
        filePattern: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts")',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search (default: true)',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
        },
      },
      required: ['pattern'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = path.resolve((input.path as string) ?? process.cwd());
    const filePattern = input.filePattern as string | undefined;
    const caseSensitive = input.caseSensitive !== false;
    const maxResults = (input.maxResults as number) ?? 50;

    try {
      const args = [
        '--with-filename',
        '--line-number',
        '--no-heading',
        `--max-count=${maxResults}`,
        caseSensitive ? '' : '--ignore-case',
        filePattern ? `--glob=${filePattern}` : '',
        '--',
        pattern,
        searchPath,
      ].filter(Boolean);

      // Try rg first, fall back to grep
      let result;
      try {
        result = await execa('rg', args, { reject: false, timeout: 10000 });
      } catch {
        const grepArgs = ['-r', '-n', caseSensitive ? '' : '-i', pattern, searchPath].filter(
          Boolean
        );
        result = await execa('grep', grepArgs, { reject: false, timeout: 10000 });
      }

      const output = (result.stdout ?? '').trim();
      return {
        toolUseId: '',
        content: output || '(no matches found)',
        isError: false,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error searching: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
