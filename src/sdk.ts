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

// Project agent roster.
//
// proposeAgents() mints the project-specific engineering roles that sit on top of the
// generic FIXED_AGENT_ROLES core. It existed from the first commit but was reachable
// only from the interactive `epam new` scaffold command and was never exported here —
// which is the physical reason the orchestration pipeline (plain node scripts that
// require dist/sdk.js) could not call it. No client codeline ever had a role minted
// for it; every brownfield ticket fell through to a hardcoded literal instead.
//
// FIXED_AGENT_ROLES is exported alongside it because minting must be ADDITIVE: the
// canonical core is protected and a proposal may never replace or remove one of them.
export { proposeAgents } from './scaffold/ManifestAnalyzer.js';
export { FIXED_AGENT_ROLES } from './scaffold/prdTypes.js';
export type { AgentProposal } from './scaffold/prdTypes.js';

// The proposal prompt itself, so the brownfield mint asks for roles in the SAME words the
// scaffold path does. The brownfield seam cannot reuse proposeAgents() wholesale — that
// calls an LLMProvider directly, which would mint agents outside the invocation gateway
// and therefore outside ladder/retry/self-heal, cost capture and timeouts. It reuses the
// PROMPT and drives it through the pipeline's own agent seam instead. Exporting it keeps
// one definition of what a project role is; a second copy would drift on the first edit.
export { getAgentProposalPrompt } from './scaffold/prompts.js';
// The mint's naming vocabulary, so the orchestration side constrains `name` in the response
// schema from the same registry the prompt's rule is derived from.
export { mintNameVocabulary, mintNameRule } from './scaffold/seamVocabulary.js';
