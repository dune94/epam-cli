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

      // EPAM_SEARCH_FORCE_GREP exists so the fallback can be tested deterministically on a host
      // where rg IS installed. The defects below lived only on this path and were invisible to
      // any test that happened to run where rg existed.
      // EPAM_SEARCH_FORCE_GREP takes the SAME route a missing rg takes — spawning a binary that
      // cannot exist — rather than faking a result object. A hand-built stand-in would have to
      // reproduce execa's shape, and the first version of it silently narrowed the type and
      // deleted the shortMessage the "search did not run" branch below reports. Forcing the real
      // failure keeps the fallback under test identical to the one that runs in production.
      const rgBinary = process.env.EPAM_SEARCH_FORCE_GREP === '1'
        ? 'epam-force-grep-fallback-no-such-binary'
        : 'rg';
      let result = await execa(rgBinary, args, { reject: false, timeout: 10000 });
      if (!ran(result)) {
        // THE FALLBACK MUST ASK THE SAME QUESTION, not merely run.
        //
        // Live 2026-08-09: search("getServerSideProps|getStaticProps", filePattern="*.tsx")
        // returned "(no matches found)" against 11 files that matched. The writer tried three
        // times, concluded the codebase was empty, and switched to `bash grep` — 56 times.
        //
        //  -E: grep defaults to BASIC regular expressions, where `|` is a LITERAL PIPE. The
        //      alternation searched for a three-character string and correctly found nothing,
        //      while rg (Rust regex) would have matched — so the tool's answer depended on
        //      which binary happened to exist. Patterns without alternation kept working, which
        //      is exactly the split visible in the live data.
        //
        //  --include: the glob reached rg as --glob and simply vanished here, so a search
        //      scoped to "*.tsx" silently searched everything.
        //
        // The earlier fix made this path REACHABLE. It did not make it EQUIVALENT, and an
        // inequivalent fallback reports absence rather than failure — the same class of silent
        // wrong answer as the ENOENT it replaced.
        // ASK THE REPOSITORY WHAT TO SEARCH, exactly as rg does.
        //
        // `grep -r` ignores .gitignore, so a repo-root search walks the dependency tree — 1.3 GB
        // and 75,693 files in the live codeline. On 2026-08-09 that hit this tool's 10s timeout
        // (23:03:49.559 -> 23:03:59.584) and the call was lost; rg would have skipped it. Third
        // inequivalence found in this fallback, after the missing -E and the dropped --include:
        // each earlier fix made it RUN, none made it EQUIVALENT.
        //
        // git grep derives the exclusions from the repository instead of a list somebody has to
        // maintain — 31ms against grep's 285ms at that repo root, and the gap widens as
        // node_modules grows. --untracked keeps a file the writer just created visible, which
        // plain `git grep` would not; without it this fix would hide the writer's own work.
        //
        // Outside a git work tree there is nothing to derive from, so plain grep -r remains the
        // last resort.
        const inGitRepo = (await execa('git', ['-C', searchPath, 'rev-parse', '--is-inside-work-tree'],
          { reject: false, timeout: 5000 })).exitCode === 0;

        if (inGitRepo) {
          const gitArgs = [
            '-C', searchPath,
            'grep', '--no-color', '-n', '-E', '--untracked',
            caseSensitive ? '' : '-i',
            '--', pattern,
            ...(filePattern ? ['--', `*/${filePattern}`, filePattern] : []),
          ].filter(Boolean);
          result = await execa('git', gitArgs, { reject: false, timeout: 10000 });
        }

        if (!inGitRepo || !ran(result)) {
          const grepArgs = [
            '-r',
            '-n',
            '-E',
            caseSensitive ? '' : '-i',
            filePattern ? `--include=${filePattern}` : '',
            '--',
            pattern,
            searchPath,
          ].filter(Boolean);
          result = await execa('grep', grepArgs, { reject: false, timeout: 10000 });
        }
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
