import type { ToolDefinition } from '../providers/types.js';

export type ToolPermission = 'safe' | 'review' | 'dangerous';

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermission;
  readonly definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
