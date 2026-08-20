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
  /**
   * Throw when a plugin fails to load, instead of collecting it into `failed` for a caller that
   * may ignore it (default: false).
   *
   * A plugin listed in `.epam/settings.json` is a capability the project EXPLICITLY asked for. When
   * one silently fails, its tools are simply absent from every agent and nothing says so beyond one
   * warning line. That has now happened twice: scan_secrets (2026-08-09, see the note below) and
   * verification-plugin (added 2026-08-11 with `name` nested inside `definition`, rejected on every
   * invocation until 2026-08-20 — 15 warnings across three runs).
   */
  failOnError?: boolean;
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
  private failOnError: boolean;

  constructor(options: PluginLoaderOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.warn = options.warn ?? true;
    this.failOnError = options.failOnError ?? false;
  }

  /**
   * Load all plugins listed in the `tools` array and register them.
   *
   * By default an invalid or missing plugin emits a warning and is skipped, and the caller decides
   * what that means. With `failOnError` the first failure THROWS — for callers where a missing
   * capability is not a survivable state, which is every caller loading what a project explicitly
   * provisioned.
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
        if (this.failOnError) {
          // A capability the project explicitly provisioned is absent. Returning it for a caller to
          // ignore is how verification-plugin's tools went missing from every agent for nine days
          // (2026-08-11 to 2026-08-20) behind one warning line per invocation.
          throw new Error(
            `plugin "${entry}" is provisioned by this project but failed to load: ` +
            `${(err as Error).message}`);
        }
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
    // ADVISORY, NOT FATAL. This field exists to WARN about a version mismatch, and a value it
    // cannot parse must not take the plugin off the table. Live 2026-08-09: secret-scan-tools
    // declared the number 1, `1.split('.')` threw, loadAll caught it as a load failure, and
    // scan_secrets was silently absent from every review — one warning line in an agent log the
    // only trace. gate_allowed_tools already states the principle beside this one: "one bad
    // plugin must not blank the allowlist".
    const declared = plugin.pluginApiVersion;
    if (typeof declared !== 'string') {
      if (this.warn) {
        process.stderr.write(
          `[epam] Plugin "${plugin.name}" declares a non-string pluginApiVersion ` +
          `(${JSON.stringify(declared)}) — assuming ${PLUGIN_API_MAJOR}.0.0 and loading it anyway\n`);
      }
      return;
    }
    const majorVersion = parseInt(declared.split('.')[0] ?? '1', 10);
    if (majorVersion !== PLUGIN_API_MAJOR && this.warn) {
      process.stderr.write(
        `[epam] Plugin "${plugin.name}" built for API v${declared}, ` +
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
