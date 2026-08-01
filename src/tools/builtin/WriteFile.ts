import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';
import { ensureDir } from '../../utils/fs.js';

export class WriteFileTool implements Tool {
  /**
   * Per-file count of reuse-guard rejections, so the guard can yield rather
   * than deadlock a story on a wrong fix-site prescription. Keyed by resolved
   * path: one badly-prescribed file must not consume another's allowance.
   */
  private static readonly symbolBlocks = new Map<string, number>();

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

      // Reuse guard: when a story prescribes an existing helper for a specific
      // fix site, a write to that site must actually reference it.
      //
      // Live AMSD-2041 2026-07-30: the retry prompt named `Stack.livePreviewQuery`
      // 21 times and explained why re-implementing it fails. The model read the
      // advice and hand-rolled the logic anyway, three attempts running. Prose a
      // model may ignore is not a requirement; the write is where it becomes one,
      // and the agent sees the rejection inside its own loop rather than one full
      // billed attempt later.
      //
      // Bounded on purpose. The prescription comes from an LLM detective and has
      // been wrong before, so this yields after EPAM_REQUIRED_SYMBOL_MAX_BLOCKS
      // (default 2) rejections per file: a wrong fix site costs two tool results,
      // never a dead story. The post-hoc verifier and the ladder still catch a
      // genuine miss. A guard that can deadlock is worse than the prose it
      // replaces. Scope is required — symbols alone must never degrade into
      // "every file must mention it".
      const requiredSymbols = (process.env.EPAM_REQUIRED_SYMBOLS || '')
        .split(':').map(s => s.trim()).filter(Boolean);
      const symbolScope = (process.env.EPAM_REQUIRED_SYMBOL_SCOPE || '')
        .split(':').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));
      if (requiredSymbols.length && symbolScope.includes(resolved)) {
        const maxBlocks = Number(process.env.EPAM_REQUIRED_SYMBOL_MAX_BLOCKS ?? '2');
        const seen = WriteFileTool.symbolBlocks.get(resolved) ?? 0;
        if (maxBlocks > 0 && seen < maxBlocks && !requiredSymbols.some(s => content.includes(s))) {
          WriteFileTool.symbolBlocks.set(resolved, seen + 1);
          return {
            toolUseId: '',
            content:
              `[reuse-guard] Write blocked: ${resolved} is the prescribed fix site for ` +
              `${requiredSymbols.join(' or ')}, which already exists in this repository, but the ` +
              `content you wrote does not reference it. Import and call it rather than ` +
              `re-implementing its logic — a hand-rolled equivalent has produced fixes that ` +
              `could never work. Rewrite this file using ${requiredSymbols.join(' or ')}.`,
            isError: true,
          };
        }
      }

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
      // LLM-settings guard: llm-settings.json drives real ladder/cost/model
      // behavior (see orchestrations/config/llm-settings.schema.json) — a
      // story implementer silently editing its own budget or ladder mid-run
      // would be invisible to whoever is watching spend. Structural, not
      // prose, same reasoning as the reuse-guard above: only the designated
      // guardian role may write here, and every write that DOES happen is
      // recorded to a co-located audit log a human can read without needing
      // to diff git history mid-run.
      if (path.basename(resolved) === 'llm-settings.json') {
        const requiredRole = process.env.EPAM_LLM_SETTINGS_GUARDIAN_ROLE || 'llm-settings-guardian';
        const callerRole = process.env.EPAM_AGENT_ROLE || '';
        if (callerRole !== requiredRole) {
          return {
            toolUseId: '',
            content:
              `[settings-guard] Write blocked: ${resolved} may only be written by the ` +
              `'${requiredRole}' role (this call ran as '${callerRole || 'unknown'}'). ` +
              `LLM ladder/cost/model settings are not something a story implementer should ` +
              `change as a side effect of its own task.`,
            isError: true,
          };
        }
        const previousContent = await fs.readFile(resolved, 'utf-8').catch(() => null);
        const auditLogPath = process.env.EPAM_LLM_SETTINGS_AUDIT_LOG
          || path.join(path.dirname(resolved), 'llm-settings-changes.jsonl');
        const auditRecord = {
          timestamp: new Date().toISOString(),
          path: resolved,
          agentRole: callerRole,
          storyId: process.env.EPAM_STORY_ID || null,
          previousContent,
          newContent: content,
        };
        await ensureDir(path.dirname(auditLogPath));
        await fs.appendFile(auditLogPath, JSON.stringify(auditRecord) + '\n', 'utf-8');
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
