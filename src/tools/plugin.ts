import type { Tool, ToolPermission, ToolResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';

/**
 * ToolPlugin — the stable public interface for external tool packages.
 *
 * An npm package implementing this interface can be loaded by EPAM CLI
 * at startup by listing it in `.epam/settings.json` under `"tools"`.
 *
 * Versioning contract:
 *   - The `pluginApiVersion` field declares which version of this interface
 *     the plugin was built against. EPAM CLI will warn (not crash) when
 *     the major version doesn't match its own.
 *   - Currently at 1.x — breaking changes bump the major version.
 *
 * Minimal implementation example:
 * ```ts
 * import type { ToolPlugin } from 'epam-cli/plugin';
 *
 * const myTool: ToolPlugin = {
 *   pluginApiVersion: '1.0.0',
 *   name: 'my_tool',
 *   description: 'Does something useful.',
 *   permission: 'safe',
 *   definition: {
 *     name: 'my_tool',
 *     description: 'Does something useful.',
 *     inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
 *   },
 *   async execute(input) {
 *     return { toolUseId: '', content: `result: ${input.input}`, isError: false };
 *   },
 * };
 *
 * export default myTool;
 * // or: export const tools = [myTool, anotherTool];
 * ```
 */
export interface ToolPlugin extends Tool {
  readonly pluginApiVersion: string;
}

export const PLUGIN_API_VERSION = '1.0.0';
export const PLUGIN_API_MAJOR = 1;

/** Shape of a plugin module's default or named export */
export type PluginExport = ToolPlugin | ToolPlugin[];

/** Re-export core types so plugin authors only need to import from one place */
export type { Tool, ToolPermission, ToolResult, ToolDefinition };
