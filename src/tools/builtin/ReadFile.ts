import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';

export class ReadFileTool implements Tool {
  readonly name = 'read_file';
  readonly description = 'Read the contents of a file at the given path.';
  readonly permission = 'safe' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
          enum: ['utf-8', 'base64'],
        },
      },
      required: ['path'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path as string;
    const encoding = (input.encoding as BufferEncoding) ?? 'utf-8';

    try {
      const resolved = path.resolve(filePath);
      const content = await fs.readFile(resolved, encoding);
      return { toolUseId: '', content: String(content), isError: false };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error reading file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
