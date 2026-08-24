import fs from 'fs/promises';
import path from 'path';
import { loadContextFile } from './ContextLoader.js';
import type { Constraint } from '../constraints/types.js';
import { getAssetStore, type AssetMatch } from '../assets/AssetStore.js';

interface ContextBuildOptions {
  contextFilePath: string;
  /**
   * The tools this agent is actually being given. The capability sentence is derived from it, so
   * a grant and the prompt describing that grant cannot disagree. Omitted by callers that do not
   * constrain tools (chat, repl), which then get a line promising nothing specific.
   */
  toolNames?: string[];
  systemPromptFile?: string | null;
  projectRoot?: string | null;
  blockConstraints?: Constraint[];
  warnConstraints?: Constraint[];
}

export interface ConsultationContext {
  profileName: string;
  systemPromptAppend?: string;
  decisions: Array<{
    id: string;
    title: string;
    description?: string;
    rationale: string;
    pattern_to_avoid: string;
    approved_alternative: string;
    tags: string[];
    createdAt: string;
    author?: string;
  }>;
}

const PROMPT_IDENTITY = 'You are EPAM CLI, an AI coding assistant running in the terminal.';
const PROMPT_MANNER = 'Be concise and helpful. When asked to perform tasks, prefer using tools '
  + 'over explaining what to do.';

/**
 * THE CAPABILITY SENTENCE IS DERIVED FROM THE GRANT, NEVER ASSERTED OVER IT.
 *
 * This used to be one fixed line promising every agent that it could "read files, write files,
 * search code, and execute commands". Most orchestration seams hold a read-only grant, so the
 * sentence was false for them, and agents acted on it: two read-only seams spent a full run
 * planning to write a file, discovering no WriteFile tool, and returning an apology instead of
 * their verdict — for prompts that never mentioned writing at all.
 */
function capabilitySentence(toolNames?: string[]): string {
  if (!toolNames) {
    return 'You have access to tools. Use the ones offered to you in this session.';
  }
  if (!toolNames.length) {
    return 'You have NO tools in this session. Answer from what you are given in the prompt.';
  }
  return `You have access to exactly these tools, and no others: ${toolNames.join(', ')}. `
    + 'If a task seems to need a tool that is not in that list, say so in your answer rather '
    + 'than asking for it — the list is the whole of what you can do.';
}

const DEFAULT_SYSTEM_PROMPT = `${PROMPT_IDENTITY} ${capabilitySentence(undefined)} ${PROMPT_MANNER}`;

const PENDING_CONSULTATION_FILE = '.epam/pending-consultation.json';

export async function buildSystemPrompt(opts: ContextBuildOptions): Promise<string> {
  const parts: string[] = [];

  // Block constraints prepended before base prompt
  if (opts.blockConstraints && opts.blockConstraints.length > 0) {
    const rules = opts.blockConstraints.map(c => `- ${c.rule}`).join('\n');
    parts.push(`[CONSTRAINTS — MUST FOLLOW]\n${rules}`);
  }

  // Base system prompt. The capability sentence reflects THIS agent's tools.
  const basePrompt = `${PROMPT_IDENTITY} ${capabilitySentence(opts.toolNames)} ${PROMPT_MANNER}`;
  if (opts.systemPromptFile) {
    const custom = await loadContextFile(opts.systemPromptFile);
    parts.push(custom || basePrompt);
  } else {
    parts.push(basePrompt);
  }

  // Project context
  const contextMd = await loadContextFile(opts.contextFilePath);
  if (contextMd) {
    parts.push(`\n## Project Context\n\n${contextMd}`);
  }

  if (opts.projectRoot) {
    parts.push(`\nWorking directory: ${opts.projectRoot}`);
  }

  // Warn constraints appended at the end
  if (opts.warnConstraints && opts.warnConstraints.length > 0) {
    const rules = opts.warnConstraints.map(c => `- ${c.rule}`).join('\n');
    parts.push(`\n[ADVISORY CONSTRAINTS]\n${rules}`);
  }

  return parts.join('\n');
}

export function buildConsultationBlock(ctx: ConsultationContext): string {
  const lines: string[] = [
    `[CONSULTING: @${ctx.profileName}]`,
  ];

  if (ctx.systemPromptAppend) {
    lines.push(ctx.systemPromptAppend);
  }

  if (ctx.decisions.length > 0) {
    lines.push('\n[RECENT MATCHING DECISIONS]');
    for (const d of ctx.decisions) {
      lines.push(`Decision ${d.id}: ${d.title}`);
      if (d.description) lines.push(`  ${d.description}`);
      lines.push(`  Rationale: ${d.rationale}`);
      lines.push(`  Avoid: ${d.pattern_to_avoid}`);
      lines.push(`  Prefer: ${d.approved_alternative}`);
    }
  }

  return lines.join('\n');
}

export async function queueConsultationForNextTurn(
  ctx: ConsultationContext,
  projectRoot: string
): Promise<void> {
  const filePath = path.join(projectRoot, PENDING_CONSULTATION_FILE);
  await fs.writeFile(filePath, JSON.stringify(ctx, null, 2), 'utf-8');
}

export async function loadPendingConsultation(
  projectRoot: string
): Promise<ConsultationContext | null> {
  const filePath = path.join(projectRoot, PENDING_CONSULTATION_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ConsultationContext;
  } catch {
    return null;
  }
}

export async function consumeConsultationContext(
  userMessage: string,
  projectRoot: string
): Promise<string> {
  const filePath = path.join(projectRoot, PENDING_CONSULTATION_FILE);
  const ctx = await loadPendingConsultation(projectRoot);

  if (!ctx) return userMessage;

  // Consume (delete) the pending file so it only applies once
  await fs.unlink(filePath).catch(() => undefined);

  const block = buildConsultationBlock(ctx);
  return `${block}\n\n${userMessage}`;
}

/**
 * Build asset alert block for injection into system prompt.
 *
 * Format:
 * [ASSET ALERT]
 * - {title} ({repoUrl}): {description}
 */
export function buildAssetAlertBlock(matches: AssetMatch[]): string {
  if (matches.length === 0) {
    return '';
  }

  const lines = ['[ASSET ALERT]'];

  for (const match of matches) {
    lines.push(`- ${match.asset.title} (${match.asset.repoUrl}): ${match.asset.description}`);
  }

  return lines.join('\n');
}

/**
 * Inject asset alerts into user message based on keyword matching.
 *
 * Called before each LLM call to discover relevant enterprise assets.
 * Only injects if matches exceed the configured threshold.
 *
 * @param userMessage - The user's message/query
 * @param projectRoot - Project root for loading assets
 * @returns User message with asset alert block prepended (if matches found)
 */
export async function injectAssetAlert(
  userMessage: string,
  projectRoot: string = process.cwd()
): Promise<string> {
  const assetStore = getAssetStore();

  // Load assets if not already loaded
  if (!assetStore.isLoaded()) {
    await assetStore.load(projectRoot);
  }

  // Search for matching assets
  const result = assetStore.search(userMessage);

  // No matches above threshold - return original message
  if (!result.hasMatches) {
    return userMessage;
  }

  // Build asset alert block and prepend to user message
  const assetBlock = buildAssetAlertBlock(result.matches);

  return `${assetBlock}\n\n${userMessage}`;
}
