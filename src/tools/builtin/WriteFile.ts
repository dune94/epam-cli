import fs from 'fs/promises';
import path from 'path';
import { renderAgentMessage } from '../messages.js';
import type { Tool, ToolResult } from '../types.js';
import { ensureDir } from '../../utils/fs.js';
import { ENGINE_OWNED_DIRS, breachesEnginePerimeter } from '../../config/enginePaths.js';

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

      // Engine perimeter: the pipeline's own state may never be created inside the repo
      // an agent is working in. UNCONDITIONAL — not gated on file type, and not waivable
      // by widening EPAM_ALLOWED_WRITE_PATHS, because neither of those is a reason for
      // the engine's KB to exist in a customer's tree.
      //
      // Live metrolinx 20260804T225443Z: the writer prompt asks the agent to "append one
      // entry to `orchestrations/agents/KB.md`" — relative — while its cwd is the client
      // codeline, so the agent created the engine's KB inside the client repo. The scope
      // guard below existed and did not fire: it was gated on .ts/.tsx, and KB.md is
      // Markdown. Every non-TS write was unpoliced.
      //
      // Enforced here, at the write, rather than by unstaging later: a commit-seam filter
      // still leaves the file on disk, where the manifest picks it up as writer output.
      if (breachesEnginePerimeter(resolved)) {
        return {
          toolUseId: '',
          content:
            `[engine-perimeter] Write blocked: ${resolved} is an epam-cli engine path ` +
            `(${ENGINE_OWNED_DIRS.join(', ')}) and must never be created inside this ` +
            `repository. The engine's knowledge base, profiles, logs and indexes live in ` +
            `the engine's own installation, not in the codeline you are working on. If you ` +
            `were asked to record a note, skip it — do not write it here.`,
          isError: true,
        };
      }

      // Scope guard: when EPAM_ALLOWED_WRITE_PATHS is set, block writes outside the
      // story's declared scope. This prevents scaffold agents from overwriting core-phase
      // implementations with incompatible stubs.
      //
      // Applies to EVERY file type. It was gated on .ts/.tsx, which left .md/.json/.yml
      // writes entirely unchecked — the same hole the engine-perimeter guard above closes
      // for engine paths, but out-of-scope client files were escaping it too.
      const allowedPathsEnv = process.env.EPAM_ALLOWED_WRITE_PATHS;
      if (allowedPathsEnv) {
        const allowed = allowedPathsEnv.split(':').filter(Boolean).map(p => path.resolve(p));
        let inScope = allowed.some(a => resolved === a || resolved.startsWith(a + path.sep));

        // AN UNOWNED FILE IS NECESSARY WORK, NOT THEFT.
        //
        // This guard exists to stop one story overwriting another's implementation. A file that
        // belongs to NO other story is not that case, and refusing it turns "not on a list" into
        // a dead end the writer cannot get out of.
        //
        // Live 2026-08-10: the feature needed a type added to a file the ticket never declared
        // and the detective never listed. The write was refused in 1ms, the run's own log said
        // "Could not resolve an owning story" for that path, the writer worked around a second
        // refusal by shelling out to the package manager, and then rewrote the one file it WAS
        // allowed to touch 32 times in a single attempt — 7.1M to 11.7M input tokens. The dead
        // end did not prevent bad work; it produced a thrash loop.
        //
        // Ownership is data the caller already has. UNKNOWN ownership is not "owned by nobody":
        // when the list is unset or empty the write stays refused, so a caller that forgets to
        // pass it cannot silently switch the guard off.
        // Ownership is TRI-STATE, and the third state is the one that matters. "No other story
        // declares anything" is a real, common answer — a single-story PRD is the normal case —
        // and it is not the same as "nobody computed this". An empty string cannot tell them
        // apart, so the caller states explicitly that it looked, and only then does an unowned
        // path become writable. Without the marker the write stays refused, so a caller that
        // never computes ownership cannot switch the guard off by omission.
        let widened = false;
        if (!inScope && process.env.EPAM_STORY_OWNERSHIP_KNOWN === '1') {
          const others = (process.env.EPAM_OTHER_STORY_PATHS ?? '')
            .split(':').filter(Boolean).map(p => path.resolve(p));
          const ownedByAnother = others.some(o => resolved === o || resolved.startsWith(o + path.sep));
          if (!ownedByAnother) { inScope = true; widened = true; }
        }

        // A widening nobody can see is how scope quietly stops meaning anything. Recorded to a
        // co-located log rather than only the console, for the same reason the settings guard is:
        // whoever reviews the change needs it without diffing git history mid-run. Best-effort —
        // an audit write must never be able to take down the run it is auditing.
        if (widened) {
          const auditPath = process.env.EPAM_SCOPE_WIDENING_LOG;
          if (auditPath) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              require('node:fs').appendFileSync(auditPath,
                `${new Date().toISOString()} story=${process.env.EPAM_STORY_ID ?? ''} ` +
                `role=${process.env.EPAM_AGENT_ROLE ?? ''} wrote ${resolved} ` +
                `(outside declared scope; no other story owns it)\n`);
            } catch { /* observability must not break the run */ }
          }
        }

        if (!inScope) {
          // TWO DIFFERENT REFUSALS, TWO DIFFERENT REMEDIES.
          //
          // The old message said only "outside declared scope. Permitted paths: …", which reads
          // as "never" whatever the actual reason. Live 2026-08-10 the writer took it that way
          // and rewrote the one file it was allowed to touch 32 times rather than escalating.
          //
          // Now a refusal means one of exactly two things, and they are not interchangeable: the
          // file belongs to another story (a real conflict — escalate to its owner), or ownership
          // could not be determined (missing data — not a statement about this file at all).
          const ownershipKnown = process.env.EPAM_STORY_OWNERSHIP_KNOWN === '1';
          // Two refusals, two remedies, two codes — the project supplies the words.
          // Collapsing them into one message is what made a refusal read as "never", and the
          // writer answered that by rewriting a file it could already write, 32 times.
          return {
            toolUseId: '',
            content: renderAgentMessage(
              ownershipKnown ? 'write_refused_owned_by_other_story' : 'write_refused_ownership_unknown',
              { path: resolved, declared: allowed.join(',') }),
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
