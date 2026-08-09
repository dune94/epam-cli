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

      // Try rg first, fall back to grep.
      //
      // `reject: false` means execa RETURNS a failure instead of throwing, so the catch below
      // never fired and the fallback was unreachable dead code. On this machine `rg` is a
      // shell function with no binary on PATH, so every spawn was ENOENT, every search
      // returned empty, and the tool reported "(no matches found)" — indistinguishable from a
      // repository that genuinely contains nothing. An estate survey then concluded
      // "greenfield" about a brownfield estate with 243 matching files in one codeline
      // (2026-08-08). grep was at /usr/bin/grep the whole time and never once ran.
      //
      // Exit codes: 0 = matches, 1 = no matches (a real answer), anything else — or a spawn
      // failure, which surfaces as a non-numeric exitCode — means the search DID NOT RUN.
      const ran = (r: { exitCode?: number }) => r.exitCode === 0 || r.exitCode === 1;

      let result = await execa('rg', args, { reject: false, timeout: 10000 });
      if (!ran(result)) {
        const grepArgs = ['-r', '-n', caseSensitive ? '' : '-i', pattern, searchPath].filter(
          Boolean
        );
        result = await execa('grep', grepArgs, { reject: false, timeout: 10000 });
      }

      // Neither searcher ran. Reporting absence here is the one answer that must never be
      // given: the caller cannot tell it from a successful empty search, and will act on it.
      if (!ran(result)) {
        return {
          toolUseId: '',
          content:
            'Error: the search could not be run — neither ripgrep nor grep executed ' +
            `(${result.shortMessage ?? 'no exit code'}). This is NOT a statement that the ` +
            'pattern is absent; nothing was searched.',
          isError: true,
        };
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
