import path from 'path';
import type { Tool } from './types.js';
import { ReadFileTool } from './builtin/ReadFile.js';
import { WriteFileTool } from './builtin/WriteFile.js';
import { BashTool } from './builtin/Bash.js';
import { ListFilesTool } from './builtin/ListFiles.js';
import { SearchTool } from './builtin/Search.js';
import { FetchUrlTool } from './builtin/FetchUrl.js';
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
  ];

  const pluginEntries = PluginLoader.readPluginList(SETTINGS_PATH);
  if (pluginEntries.length === 0) return builtins;

  const registry = new ToolRegistry();
  registry.registerMany(builtins);

  const loader = new PluginLoader({ projectRoot: process.cwd() });
  loader.loadAll(pluginEntries, registry);

  return registry.getAll();
}
