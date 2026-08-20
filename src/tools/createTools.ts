import path from 'path';
import type { Tool } from './types.js';
import { ReadFileTool } from './builtin/ReadFile.js';
import { WriteFileTool } from './builtin/WriteFile.js';
import { BashTool } from './builtin/Bash.js';
import { ListFilesTool } from './builtin/ListFiles.js';
import { SearchTool } from './builtin/Search.js';
import { FetchUrlTool } from './builtin/FetchUrl.js';
import { EscalateDefectTool } from './builtin/EscalateDefect.js';
import { ToolRegistry } from './registry.js';
import { PluginLoader } from './PluginLoader.js';

const SETTINGS_PATH = path.join(process.cwd(), '.epam', 'settings.json');

/**
 * Returns the full tool set: all built-in tools plus any external plugins
 * listed in `.epam/settings.json` under `"tools"`.
 *
 * Plugin load failures emit warnings and are skipped — builtins always load.
 */
export function createTools(): Tool[] {
  const builtins: Tool[] = [
    new ReadFileTool(),
    new WriteFileTool(),
    new BashTool(),
    new ListFilesTool(),
    new SearchTool(),
    new FetchUrlTool(),
    new EscalateDefectTool(),
  ];

  const pluginEntries = PluginLoader.readPluginList(SETTINGS_PATH);
  if (pluginEntries.length === 0) return builtins;

  const registry = new ToolRegistry();
  registry.registerMany(builtins);

  // STRICT: every entry here was listed in this project's .epam/settings.json, so each one is a
  // capability the project asked for. The result of loadAll used to be discarded entirely, which is
  // how a plugin rejected on every single invocation still produced a tool set that looked complete.
  const loader = new PluginLoader({ projectRoot: process.cwd(), failOnError: true });
  loader.loadAll(pluginEntries, registry);

  return registry.getAll();
}

/**
 * Restrict a tool set to an explicit allowlist. This is a STRUCTURAL guard, not a
 * prompt-level one: an agent run with `EPAM_ALLOWED_TOOLS` set literally cannot
 * call any tool outside the list, because the excluded tools are never handed to
 * the model. Read-only agents (the code-graph-detective, review-agent, and the
 * source-reading QA gates) must never be able to reach `write_file` — a bug found
 * live 2026-07-23 where the detective "answered" by calling WriteFile and its real
 * output was lost. Prompt instructions could not prevent that; this does.
 *
 * The list is comma/colon-separated and matched case- and separator-insensitively,
 * so friendly names work interchangeably with tool names: `Bash`==`bash`,
 * `ReadFile`==`read_file`, `WriteFile`==`write_file`, etc. Empty/unset returns the
 * tools unchanged (backward compatible — no allowlist means "all tools").
 */
export function applyToolAllowlist(tools: Tool[], allowlistRaw: string | undefined | null): Tool[] {
  if (!allowlistRaw || !allowlistRaw.trim()) return tools;
  const normalize = (s: string): string => s.toLowerCase().replace(/[_\s-]/g, '');
  const allowed = new Set(
    allowlistRaw.split(/[,:]/).map(s => s.trim()).filter(Boolean).map(normalize),
  );
  if (allowed.size === 0) return tools;
  return tools.filter(t => allowed.has(normalize(t.name)));
}
