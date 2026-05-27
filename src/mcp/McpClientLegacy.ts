import fs from 'fs/promises';
import path from 'path';
import type {
  McpConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolDefinition,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';
import type { Tool, ToolResult } from '../tools/types.js';
import type { ToolDefinition } from '../providers/types.js';
import { StdioTransport } from './StdioTransport.js';
import { logger } from '../utils/logger.js';

export class McpClient {
  private servers: McpServerStatus[] = [];
  private stdioTransports = new Map<string, StdioTransport>();
  private nextRpcId = 1;

  constructor(private projectRoot?: string) {}

  /**
   * Initialize the MCP client by reading .mcp.json and connecting to all servers.
   */
  async initialize(): Promise<void> {
    const config = await this.loadConfig();
    if (!config || config.servers.length === 0) {
      logger.debug('No MCP servers configured');
      return;
    }

    logger.debug(`Initializing ${config.servers.length} MCP server(s)`);

    // Connect to each server in parallel
    await Promise.all(
      config.servers.map(async (serverConfig) => {
        try {
          if (serverConfig.transport === 'stdio') {
            await this.connectStdio(serverConfig);
          } else {
            await this.connectHttp(serverConfig);
          }
        } catch (err) {
          const error = (err as Error).message;
          logger.warn(`MCP server '${serverConfig.name}' unreachable: ${error}`);
          this.servers.push({
            name: serverConfig.name,
            url: serverConfig.url,
            transport: serverConfig.transport,
            command: serverConfig.command,
            args: serverConfig.args,
            connected: false,
            tools: [],
            error,
          });
        }
      })
    );
  }

  /**
   * Get all connected servers and their status.
   */
  getServers(): McpServerStatus[] {
    return this.servers;
  }

  /**
   * Get all remote tools as Tool instances ready to register.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [];

    for (const server of this.servers) {
      if (!server.connected) continue;

      for (const toolDef of server.tools) {
        const namespacedName = `${server.name}/${toolDef.name}`;
        tools.push(this.createProxyTool(server, toolDef, namespacedName));
      }
    }

    return tools;
  }

  /**
   * Shut down all stdio transports (kill spawned processes).
   */
  shutdown(): void {
    for (const [name, transport] of this.stdioTransports) {
      logger.debug(`Shutting down stdio MCP server '${name}'`);
      transport.shutdown();
    }
    this.stdioTransports.clear();
  }

  // ── connection helpers ─────────────────────────────────────────

  private async connectHttp(serverConfig: McpServerConfig): Promise<void> {
    const tools = await this.fetchTools(serverConfig);
    this.servers.push({
      name: serverConfig.name,
      url: serverConfig.url,
      transport: serverConfig.transport,
      connected: true,
      tools,
    });
    logger.debug(
      `MCP server '${serverConfig.name}' connected — ${tools.length} tool(s) available`
    );
  }

  private async connectStdio(serverConfig: McpServerConfig): Promise<void> {
    const transport = new StdioTransport(serverConfig);
    const tools = await transport.connect();

    this.stdioTransports.set(serverConfig.name, transport);
    this.servers.push({
      name: serverConfig.name,
      transport: 'stdio',
      command: serverConfig.command,
      args: serverConfig.args,
      connected: true,
      tools,
    });
    logger.debug(
      `MCP stdio server '${serverConfig.name}' connected — ${tools.length} tool(s) available`
    );
  }

  /**
   * Load .mcp.json from the project root.
   */
  private async loadConfig(): Promise<McpConfig | null> {
    if (!this.projectRoot) {
      logger.debug('No project root — skipping MCP config');
      return null;
    }

    const configPath = path.join(this.projectRoot, '.mcp.json');

    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content) as McpConfig;

      // Validate config
      if (!config.servers || !Array.isArray(config.servers)) {
        logger.warn('.mcp.json: "servers" must be an array');
        return null;
      }

      return config;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('.mcp.json not found — MCP client disabled');
        return null;
      }
      logger.warn(`Failed to read .mcp.json: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Fetch available tools from a remote MCP server.
   */
  private async fetchTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextRpcId++,
      method: 'tools/list',
      params: {},
    };

    const response = await this.sendRpcRequest(server, request, 'tools/list');

    if (response.error) {
      throw new Error(
        `Server returned error: ${response.error.message} (code ${response.error.code})`
      );
    }

    if (!response.result) {
      throw new Error('Server returned no result');
    }

    const result = response.result as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  /**
   * Create a proxy Tool instance that forwards calls to the remote server.
   */
  private createProxyTool(
    server: McpServerStatus,
    toolDef: McpToolDefinition,
    namespacedName: string
  ): Tool {
    return {
      name: namespacedName,
      description: `[MCP:${server.name}] ${toolDef.description}`,
      permission: 'review' as const,
      definition: {
        name: namespacedName,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
      } as ToolDefinition,
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        if (server.transport === 'stdio') {
          return this.executeStdioTool(server.name, toolDef.name, input);
        }
        return this.executeRemoteTool(server, toolDef.name, input);
      },
    };
  }

  /**
   * Execute a tool via the stdio transport.
   */
  private async executeStdioTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    const transport = this.stdioTransports.get(serverName);
    if (!transport) {
      return {
        toolUseId: '',
        content: `Stdio transport not found for server '${serverName}'`,
        isError: true,
      };
    }

    const result = await transport.callTool(toolName, input);
    return { toolUseId: '', ...result };
  }

  /**
   * Execute a remote tool by proxying the call via JSON-RPC.
   */
  private async executeRemoteTool(
    server: McpServerStatus,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: this.nextRpcId++,
        method: 'tools/call',
        params: {
          tool: toolName,
          input,
          id: `mcp-${this.nextRpcId}`,
        },
      };

      const response = await this.sendRpcRequest(
        {
          name: server.name,
          url: server.url,
          transport: server.transport,
        },
        request,
        'tools/call'
      );

      if (response.error) {
        return {
          toolUseId: '',
          content: `Remote tool error: ${response.error.message}`,
          isError: true,
        };
      }

      const result = response.result as { content?: string } | undefined;
      return {
        toolUseId: '',
        content: result?.content ?? JSON.stringify(response.result),
        isError: false,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Failed to execute remote tool: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /**
   * Send a JSON-RPC request to a remote server.
   */
  private async sendRpcRequest(
    server: McpServerConfig,
    request: JsonRpcRequest,
    operation: 'tools/list' | 'tools/call'
  ): Promise<JsonRpcResponse> {
    const endpoint = this.resolveEndpoint(server, operation);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as JsonRpcResponse;
    return data;
  }

  private resolveEndpoint(
    server: McpServerConfig,
    operation: 'tools/list' | 'tools/call'
  ): string {
    if (!server.url) {
      throw new Error(`HTTP/SSE server '${server.name}' requires a "url" field`);
    }
    const baseUrl = server.url.replace(/\/+$/, '');

    if (baseUrl.endsWith('/tools/list')) {
      return operation === 'tools/list'
        ? baseUrl
        : `${baseUrl.slice(0, -'/tools/list'.length)}/tools/call`;
    }

    if (baseUrl.endsWith('/tools/call')) {
      return operation === 'tools/call'
        ? baseUrl
        : `${baseUrl.slice(0, -'/tools/call'.length)}/tools/list`;
    }

    if (baseUrl.endsWith('/mcp')) {
      return `${baseUrl}/${operation}`;
    }

    return `${baseUrl}/mcp/${operation}`;
  }
}
