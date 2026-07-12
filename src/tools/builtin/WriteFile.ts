import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';
import { ensureDir } from '../../utils/fs.js';

export class WriteFileTool implements Tool {
  readonly name = 'write_file';
  readonly description = 'Write content to a file. Creates parent directories if needed.';
  readonly permission = 'review' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
        append: {
          type: 'boolean',
          description: 'If true, append to existing file instead of overwriting',
        },
      },
      required: ['path', 'content'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path as string;
    const content = input.content as string;
    const append = Boolean(input.append);

    try {
      const resolved = path.resolve(filePath);

      // Scope guard: when EPAM_ALLOWED_WRITE_PATHS is set, block writes to TypeScript
      // source files outside the story's declared scope. This prevents scaffold agents
      // from overwriting core-phase implementations with incompatible stubs.
      const allowedPathsEnv = process.env.EPAM_ALLOWED_WRITE_PATHS;
      if (allowedPathsEnv && (resolved.endsWith('.ts') || resolved.endsWith('.tsx'))) {
        const allowed = allowedPathsEnv.split(':').filter(Boolean).map(p => path.resolve(p));
        const inScope = allowed.some(a => resolved === a || resolved.startsWith(a + path.sep));
        if (!inScope) {
          return {
            toolUseId: '',
            content: `[scope-guard] Write blocked: ${resolved} is outside this story's declared scope. Permitted paths: ${allowed.join(', ')}. Only modify files listed in the story's technicalNotes.files.`,
            isError: true,
          };
        }
      }
      // JSON integrity guard: refuse a write that would leave a .json file
      // containing invalid JSON. This catches the most common corruption mode
      // seen in practice — an agent appending a full replacement document onto
      // an existing one (or a partial/retry write), which silently produces
      // multiple concatenated JSON documents in one file and crashes every
      // downstream `json.load()`/`JSON.parse()` consumer.
      if (resolved.endsWith('.json')) {
        let finalContent = content;
        if (append) {
          const existing = await fs.readFile(resolved, 'utf-8').catch(() => '');
          finalContent = existing + content;
        }
        try {
          JSON.parse(finalContent);
        } catch (parseErr) {
          const hint = append
            ? 'Appending to an existing JSON file produces invalid JSON unless the appended text is not itself a full document — write the complete merged document instead with append=false (or omitted).'
            : 'The content is not a single, complete, valid JSON document.';
          return {
            toolUseId: '',
            content: `Error: refused to write ${resolved} — resulting content is not valid JSON (${(parseErr as Error).message}). ${hint}`,
            isError: true,
          };
        }
      }

      await ensureDir(path.dirname(resolved));
      if (append) {
        await fs.appendFile(resolved, content, 'utf-8');
      } else {
        await fs.writeFile(resolved, content, 'utf-8');
      }
      return {
        toolUseId: '',
        content: `Successfully wrote ${content.length} characters to ${resolved}`,
        isError: false,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error writing file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
