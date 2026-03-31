export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  /** HTTP/SSE endpoint URL (required for http/sse transport) */
  url?: string;
  /** Command to spawn (required for stdio transport) */
  command?: string;
  /** Arguments for the spawned command */
  args?: string[];
  /** Extra environment variables for the spawned process */
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerStatus {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  connected: boolean;
  tools: McpToolDefinition[];
  error?: string;
}

export interface McpServerOptions {
  port: number;
  bind: string;
  dangerousSkipApproval?: boolean;
}

export interface SseEvent {
  type: 'progress' | 'result' | 'error';
  toolCallId: string;
  data?: unknown;
  message?: string;
}
