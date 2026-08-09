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
        startLine: {
          type: 'integer',
          description: 'First line to return, 1-based. Omit to start at the beginning.',
        },
        endLine: {
          type: 'integer',
          description: 'Last line to return, inclusive. Omit to read to the end of the file.',
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

  /**
   * Line bounds, accepting the string forms models actually send. Refused rather than coerced
   * to a default: a range silently reinterpreted is how the caller comes to believe it saw a
   * window it never saw.
   */
  private parseRange(
    input: Record<string, unknown>,
  ): { startLine?: number; endLine?: number } | { error: string } {
    const read = (key: 'startLine' | 'endLine'): number | undefined | { error: string } => {
      const raw = input[key];
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        return { error: `'${key}' must be a 1-based integer line number, got ${JSON.stringify(raw)}.` };
      }
      return n;
    };
    const startLine = read('startLine');
    if (startLine && typeof startLine === 'object') return startLine;
    const endLine = read('endLine');
    if (endLine && typeof endLine === 'object') return endLine;
    if (typeof startLine === 'number' && typeof endLine === 'number' && endLine < startLine) {
      return { error: `'endLine' (${endLine}) is before 'startLine' (${startLine}).` };
    }
    return { startLine: startLine as number | undefined, endLine: endLine as number | undefined };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = input.path as string;
    const encoding = (input.encoding as BufferEncoding) ?? 'utf-8';

    try {
      const resolved = path.resolve(filePath);
      const content = await fs.readFile(resolved, encoding);
      // The digest identifies the FILE'S STATE, so it is taken from the whole file before any
      // window is applied. Hashing the excerpt instead made every different window a different
      // "file" and defeated the dedupe entirely — a full read followed by a windowed read of the
      // same unchanged file was sent twice.
      const fullText = String(content);
      let text = fullText;

      // A REQUESTED WINDOW IS THE WINDOW RETURNED.
      //
      // These parameters did not exist. The live writer sent startLine on 20+ calls and received
      // the ENTIRE 537-line file every time — it believed it was paging through a large file 50
      // lines at a time while being handed all 537 lines on each call, then asked again because
      // it never got the window it asked for. That is a second, independent contributor to the
      // 1.1 MB of read_file traffic measured in one attempt.
      //
      // Strings are accepted deliberately: every live call sent startLine: "400", not 400.
      // Models emit JSON numbers as strings routinely, and a parameter that only works when the
      // type is exactly right is a parameter that mostly does not work.
      const range = this.parseRange(input);
      if ('error' in range) {
        return { toolUseId: '', content: `Error: ${range.error}`, isError: true };
      }
      if (range.startLine !== undefined || range.endLine !== undefined) {
        const lines = text.split('\n');
        const total = lines.length;
        const from = Math.max(1, range.startLine ?? 1);
        const to = Math.min(total, range.endLine ?? total);
        if (from > total) {
          return {
            toolUseId: '',
            content: `${resolved} has only ${total} lines; startLine ${from} is past the end. ` +
              `Nothing was returned — this is a statement about the request, not the file.`,
            isError: false,
          };
        }
        text = `[${resolved} lines ${from}-${to} of ${total}]\n` + lines.slice(from - 1, to).join('\n');
      }

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
        const digest = createHash('sha256').update(fullText).digest('hex').slice(0, 16);
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
