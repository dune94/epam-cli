import type { Tool } from './types.js';
import { ToolError } from '../utils/errors.js';

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): Tool {
  const tool = tools.get(name);
  if (!tool) {
    throw new ToolError(`Tool '${name}' not found. Available: ${Array.from(tools.keys()).join(', ')}`);
  }
  return tool;
}

export function listTools(): Tool[] {
  return Array.from(tools.values());
}

export function getToolDefinitions() {
  return listTools().map(t => t.definition);
}

export function hasToolEnabled(name: string, enabled: string[], disabled: string[]): boolean {
  if (disabled.includes(name)) return false;
  if (enabled.length > 0 && !enabled.includes(name)) return false;
  return true;
}

export function clearTools(): void {
  tools.clear();
}
