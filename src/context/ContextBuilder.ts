import { loadContextFile } from './ContextLoader.js';

interface ContextBuildOptions {
  contextFilePath: string;
  systemPromptFile?: string | null;
  projectRoot?: string | null;
}

const DEFAULT_SYSTEM_PROMPT = `You are EPAM CLI, an AI coding assistant running in the terminal. You have access to tools to read files, write files, search code, and execute commands. Be concise and helpful. When asked to perform tasks, prefer using tools over explaining what to do.`;

export async function buildSystemPrompt(opts: ContextBuildOptions): Promise<string> {
  const parts: string[] = [];

  // Base system prompt
  if (opts.systemPromptFile) {
    const custom = await loadContextFile(opts.systemPromptFile);
    if (custom) {
      parts.push(custom);
    } else {
      parts.push(DEFAULT_SYSTEM_PROMPT);
    }
  } else {
    parts.push(DEFAULT_SYSTEM_PROMPT);
  }

  // Project context
  const contextMd = await loadContextFile(opts.contextFilePath);
  if (contextMd) {
    parts.push(`\n## Project Context\n\n${contextMd}`);
  }

  if (opts.projectRoot) {
    parts.push(`\nWorking directory: ${opts.projectRoot}`);
  }

  return parts.join('\n');
}
