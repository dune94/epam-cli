import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
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
        force: {
          type: 'boolean',
          description:
            'Re-send the full contents even if you already read this file in this attempt. ' +
            'Use only if you no longer have the earlier output.',
        },
      },
      required: ['path'],
    },
  };

  /**
   * What this attempt has already been shown, keyed by RESOLVED path.
   *
   * Instance state, because createTools() builds a fresh tool per process and one process is one
   * story attempt — the same per-attempt isolation LoopDetector relies on, with no reset call to
   * forget.
   */
  private alreadySent = new Map<string, string>();

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path as string;
    const encoding = (input.encoding as BufferEncoding) ?? 'utf-8';

    try {
      const resolved = path.resolve(filePath);
      const content = await fs.readFile(resolved, encoding);
      const text = String(content);

      // RE-READING A FILE YOU ALREADY HAVE IS THE LARGEST TOKEN COST MEASURED.
      //
      // Live 2026-08-09: read_file ran 202 times for 1.1 MB in a single attempt, and
      // src/services/pageService.ts alone was read 53 TIMES — a 537-line file that was already
      // in the prompt, injected verbatim. Roughly 300 KB of re-sending what the model was handed.
      //
      // LoopDetector cannot see this and is not wrong not to: it hashes {tool + args}, and those
      // 53 reads carried seven distinct argument shapes (varying startLine, relative vs absolute
      // path, an explicit encoding). Its contract is "identical call". This keys on WHAT WAS
      // RETURNED instead — the resolved path and a hash of the content.
      //
      // It never permanently withholds. A file whose content CHANGED is always returned in full,
      // and the notice names the escape hatch, because context compaction can genuinely evict
      // earlier output and an agent that no longer has the file must be able to get it back.
      if (process.env.EPAM_READ_DEDUPE === '1' && input.force !== true) {
        const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
        const seen = this.alreadySent.get(resolved);
        if (seen === digest) {
          return {
            toolUseId: '',
            content:
              `You already read ${resolved} earlier in this attempt and it has NOT changed since ` +
              `(${text.length} bytes). Its contents are unchanged from the copy you already have — ` +
              `re-use that rather than re-reading. If you genuinely no longer have it, call ` +
              `read_file again with force: true.`,
            isError: false,
          };
        }
        this.alreadySent.set(resolved, digest);
      }

      return { toolUseId: '', content: text, isError: false };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error reading file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
