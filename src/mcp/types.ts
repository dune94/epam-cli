export type McpTransport = 'http' | 'sse';

export interface McpServerConfig {
  name: string;
  url: string;
  transport: McpTransport;
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
  url: string;
  transport: McpTransport;
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
