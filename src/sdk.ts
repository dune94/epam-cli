/**
 * EPAM CLI — Public SDK Surface (GAP-P12)
 *
 * Import from this module to use EPAM CLI as an embeddable library:
 *
 * ```ts
 * import { AgentRunner, ProviderChain, ToolRegistry, createTools } from 'epam-cli/sdk';
 * ```
 *
 * Stability contract: exports from this file follow semver. Internal
 * modules under src/ are not part of the public API.
 */

// Agent
export { AgentRunner } from './agent/AgentRunner.js';

// Providers
export { ProviderChain } from './providers/ProviderChain.js';
export type { LLMProvider, Message, ContentPart, ProviderRequest, ProviderResponse } from './providers/types.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export { createTools } from './tools/createTools.js';
export type { Tool, ToolResult, ToolPermission } from './tools/types.js';
export type { ToolPlugin, PluginExport } from './tools/plugin.js';
export { PluginLoader } from './tools/PluginLoader.js';
export { PLUGIN_API_VERSION } from './tools/plugin.js';

// Built-in tools (for selective use)
export { ReadFileTool } from './tools/builtin/ReadFile.js';
export { WriteFileTool } from './tools/builtin/WriteFile.js';
export { BashTool } from './tools/builtin/Bash.js';
export { ListFilesTool } from './tools/builtin/ListFiles.js';
export { SearchTool } from './tools/builtin/Search.js';
export { FetchUrlTool } from './tools/builtin/FetchUrl.js';

// Config
export { resolveConfig } from './config/ConfigResolver.js';
