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
