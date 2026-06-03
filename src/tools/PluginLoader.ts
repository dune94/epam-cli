import path from 'path';
import fs from 'fs';
import type { ToolPlugin, PluginExport } from './plugin.js';
import { PLUGIN_API_MAJOR } from './plugin.js';
import type { ToolRegistry } from './registry.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _require = typeof require !== 'undefined' ? require : (id: string) => { throw new Error(`Cannot require: ${id}`); };

export interface PluginLoaderOptions {
  /** Absolute path to the project root (for resolving relative plugin paths) */
  projectRoot?: string;
  /** Emit warnings to stderr (default: true) */
  warn?: boolean;
}

/**
 * Loads external tool plugins listed in `.epam/settings.json` `tools` array
 * and registers them into the provided ToolRegistry.
 *
 * Each entry in `settings.tools` is either:
 *   - An npm package name:  `"@myorg/epam-tool-github"`
 *   - A relative path:      `"./local-tools/my-tool.js"`
 *
 * The module must export one of:
 *   - `export default tool` — a single ToolPlugin object
 *   - `export default [tool1, tool2]` — an array of ToolPlugin objects
 *   - `export const tools = [...]` — named `tools` array
 */
export class PluginLoader {
  private projectRoot: string;
  private warn: boolean;

  constructor(options: PluginLoaderOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.warn = options.warn ?? true;
  }

  /**
   * Load all plugins listed in the `tools` array and register them.
   * Invalid/missing plugins emit warnings and are skipped — never throw.
   */
  loadAll(pluginEntries: string[], registry: ToolRegistry): { loaded: string[]; failed: string[] } {
    const loaded: string[] = [];
    const failed: string[] = [];

    for (const entry of pluginEntries) {
      try {
        const plugins = this.loadOne(entry);
        for (const plugin of plugins) {
          this.validatePlugin(plugin, entry);
          registry.register(plugin.name, plugin);
        }
        loaded.push(entry);
      } catch (err) {
        if (this.warn) {
          process.stderr.write(`[epam] Plugin load warning: ${entry} — ${(err as Error).message}\n`);
        }
        failed.push(entry);
      }
    }

    return { loaded, failed };
  }

  private loadOne(entry: string): ToolPlugin[] {
    const resolved = entry.startsWith('.') || entry.startsWith('/')
      ? path.resolve(this.projectRoot, entry)
      : entry;

    const mod = _require(resolved) as { default?: PluginExport; tools?: PluginExport };
    const raw: PluginExport | undefined = mod.default ?? mod.tools;

    if (!raw) throw new Error(`module exports neither "default" nor "tools" — got keys: ${Object.keys(mod).join(', ')}`);
    return Array.isArray(raw) ? raw : [raw];
  }

  private validatePlugin(plugin: ToolPlugin, entry: string): void {
    if (!plugin.name) throw new Error('plugin missing required field: name');
    if (!plugin.execute) throw new Error('plugin missing required field: execute');
    if (!plugin.pluginApiVersion) {
      if (this.warn) {
        process.stderr.write(`[epam] Plugin "${entry}" is missing pluginApiVersion — assuming 1.0.0\n`);
      }
      return;
    }
    const majorVersion = parseInt(plugin.pluginApiVersion.split('.')[0] ?? '1', 10);
    if (majorVersion !== PLUGIN_API_MAJOR && this.warn) {
      process.stderr.write(
        `[epam] Plugin "${plugin.name}" built for API v${plugin.pluginApiVersion}, ` +
        `runtime API is v${PLUGIN_API_MAJOR}.x — may have compatibility issues\n`
      );
    }
  }

  /** Read the `tools` array from `.epam/settings.json`, or return [] */
  static readPluginList(settingsPath: string): string[] {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const tools = settings.tools;
      if (!Array.isArray(tools)) return [];
      return tools.filter((t): t is string => typeof t === 'string');
    } catch {
      return [];
    }
  }
}
