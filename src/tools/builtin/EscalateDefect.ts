import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolResult } from '../types.js';
import { renderAgentMessage } from '../messages.js';
import { ensureDir } from '../../utils/fs.js';

/**
 * Lets a story's agent hand off a defect it has correctly diagnosed but
 * cannot fix, because the fix lives in a file outside its own declared
 * scope (owned by a sibling split story, locked by the scope-guard).
 *
 * Root cause this addresses (found live, 2026-07-06): a split story pair
 * (e.g. SKY-002-impl / SKY-002-test) can end up with the test child's tests
 * failing because the impl child's code is missing something (e.g.
 * constructor validation) — but the test child's agent is correctly
 * forbidden from touching the impl file (EPAM_ALLOWED_WRITE_PATHS scope
 * guard, see WriteFileTool), so it just keeps re-diagnosing the same true
 * root cause every retry with no way to act on it, burning its entire retry
 * ladder on a defect it structurally cannot fix itself.
 *
 * This tool gives the agent an explicit, legitimate way out: file the
 * diagnosis instead of repeatedly attempting (and being blocked from) a
 * direct file write. The orchestration layer (claude.sh) polls for this
 * escalation file between retries, resolves the sibling story via the PRD,
 * applies a scoped fix there, and grants the escalating story a free retry.
 */
export class EscalateDefectTool implements Tool {
  readonly name = 'escalate_defect_to_sibling_story';
  readonly description =
    'Use this when a test/behavior failure requires a code change in a file OUTSIDE your own declared scope ' +
    '(e.g. a file owned by a sibling split story such as an "-impl" story when you are the "-test" story). ' +
    'Do NOT repeatedly attempt to modify that file yourself — writes outside your scope are blocked and will ' +
    'keep failing identically. Call this tool instead with the target file, your diagnosis, and the required ' +
    'fix. The pipeline will resolve it in the owning story and resume your task.';
  readonly permission = 'review' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetFile: {
          type: 'string',
          description: 'Path to the file that needs to change but is outside your own scope',
        },
        diagnosis: {
          type: 'string',
          description: 'What is wrong and why it causes your story to fail',
        },
        requiredFix: {
          type: 'string',
          description: 'The specific, narrow fix needed in targetFile',
        },
      },
      required: ['targetFile', 'diagnosis', 'requiredFix'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const targetFile = input.targetFile as string;
    const diagnosis = input.diagnosis as string;
    const requiredFix = input.requiredFix as string;
    const storyId = process.env.EPAM_STORY_ID || '';
    const projectRoot = process.env.PROJECT_ROOT || process.cwd();

    if (!storyId) {
      return {
        toolUseId: '',
        content:
          '[escalate-defect] EPAM_STORY_ID is not set — cannot file an escalation without knowing the ' +
          'escalating story. This tool is only available inside the orchestration pipeline.',
        isError: true,
      };
    }

    // THE FIX MAY BE THE CALLER'S OWN. regintel 20260919T224649Z resume 7 (2026-09-20): REGI-007a,
    // which declares regintel/pipeline.py, escalated regintel/pipeline.py, was told "do not modify
    // this file — it is outside your scope", obeyed, and burned its ladder on a defect it was
    // allowed to fix all along. The scope the writer runs with is already in the environment —
    // EPAM_ALLOWED_WRITE_PATHS, the same variable WriteFile's scope guard reads — so the answer is
    // derived from it: a target inside the declared scope is refused with "the fix is yours", and
    // nothing is filed. An undeclared scope (a caller that never computed one) files as before.
    const scopeEnv = process.env.EPAM_ALLOWED_WRITE_PATHS;
    if (scopeEnv) {
      const resolvedTarget = path.resolve(projectRoot, targetFile);
      const declared = scopeEnv.split(':').filter(Boolean).map((p) => path.resolve(projectRoot, p));
      const own = declared.some((d) => resolvedTarget === d || resolvedTarget.startsWith(d + path.sep));
      if (own) {
        return {
          toolUseId: '',
          content: renderAgentMessage('escalation_refused_own_file', { path: targetFile, declared: declared.join(':') }),
          isError: true,
        };
      }
    }

    try {
      const escalationsDir = path.join(projectRoot, '.epam', 'escalations');
      await ensureDir(escalationsDir);
      const escalationPath = path.join(escalationsDir, `${storyId}.json`);
      const record = {
        fromStoryId: storyId,
        targetFile,
        diagnosis,
        requiredFix,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(escalationPath, JSON.stringify(record, null, 2), 'utf-8');
      return {
        toolUseId: '',
        content: renderAgentMessage('escalation_filed', { path: targetFile }),
        isError: false,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `[escalate-defect] Failed to file escalation: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
