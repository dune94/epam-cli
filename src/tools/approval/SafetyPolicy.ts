import type { ToolPermission } from '../types.js';

const ALWAYS_DANGEROUS = new Set(['bash', 'exec', 'shell']);
const ALWAYS_REVIEW = new Set(['write_file', 'delete_file', 'move_file', 'fetch_url']);
const ALWAYS_SAFE = new Set(['read_file', 'list_files', 'search', 'glob']);

export function classifyTool(toolName: string, permission: ToolPermission): ToolPermission {
  const lower = toolName.toLowerCase();

  if (ALWAYS_DANGEROUS.has(lower)) return 'dangerous';
  if (ALWAYS_REVIEW.has(lower)) return 'review';
  if (ALWAYS_SAFE.has(lower)) return 'safe';

  return permission;
}

export function isDangerous(toolName: string, permission: ToolPermission): boolean {
  return classifyTool(toolName, permission) === 'dangerous';
}

export function requiresApproval(
  toolName: string,
  permission: ToolPermission,
  skipApproval: boolean
): boolean {
  if (skipApproval) return false;
  const classified = classifyTool(toolName, permission);
  return classified === 'dangerous' || classified === 'review';
}
