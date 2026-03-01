import http from 'http';
import { ReadFileTool } from '../tools/builtin/ReadFile.js';
import { WriteFileTool } from '../tools/builtin/WriteFile.js';
import { BashTool } from '../tools/builtin/Bash.js';
import { ListFilesTool } from '../tools/builtin/ListFiles.js';
import { SearchTool } from '../tools/builtin/Search.js';
import { FetchUrlTool } from '../tools/builtin/FetchUrl.js';
import { ToolRunner } from '../agent/tools/ToolRunner.js';
import type { Tool, ToolResult } from '../tools/types.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  McpServerOptions,
  SseEvent,
} from './types.js';

export class McpServer {
  private server: http.Server | null = null;
  private tools: Tool[];
  private toolRunner: ToolRunner;
  private sseClients: Set<http.ServerResponse> = new Set();
  private options: McpServerOptions;

  constructor(options: McpServerOptions) {
    this.options = options;

    // Initialize all built-in tools
    this.tools = [
      new ReadFileTool(),
      new WriteFileTool(),
      new BashTool(),
      new ListFilesTool(),
      new SearchTool(),
      new FetchUrlTool(),
    ];

    // Initialize tool runner with approval policy
    this.toolRunner = new ToolRunner(this.tools, options.dangerousSkipApproval ?? false);
  }

  /**
   * Get all available tools as MCP tool definitions.
   */
  getToolDefinitions(): McpToolDefinition[] {
    return this.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.definition.inputSchema,
    }));
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));

      this.server.on('error', reject);

      this.server.listen(this.options.port, this.options.bind, () => {
        console.log(`MCP Server listening on ${this.options.bind}:${this.options.port}`);
        if (this.options.bind !== '127.0.0.1' && this.options.bind !== 'localhost') {
          console.warn(
            '⚠️  WARNING: Server is exposed externally. Ensure proper firewall rules are in place.'
          );
        }
        resolve();
      });

      // Setup graceful shutdown handlers
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
    });
  }

  /**
   * Stop the server and close all SSE connections.
   */
  async shutdown(): Promise<void> {
    console.log('\nShutting down MCP Server...');

    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    // Close HTTP server
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
    }

    console.log('Server shut down gracefully.');
    process.exit(0);
  }

  /**
   * Handle incoming HTTP requests.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/mcp/tools/list' && req.method === 'POST') {
        await this.handleToolsList(req, res);
      } else if (url.pathname === '/mcp/tools/call' && req.method === 'POST') {
        await this.handleToolCall(req, res);
      } else if (url.pathname === '/mcp/sse' && req.method === 'GET') {
        await this.handleSse(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('Request handling error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Handle POST /mcp/tools/list - return available tools.
   */
  private async handleToolsList(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    let rpcRequest: JsonRpcRequest;

    try {
      rpcRequest = JSON.parse(body);
    } catch {
      this.sendJsonRpcError(res, null, -32700, 'Parse error');
      return;
    }

    const tools = this.getToolDefinitions();
    this.sendJsonRpcResponse(res, rpcRequest.id, { tools });
  }

  /**
   * Handle POST /mcp/tools/call - execute a tool call.
   */
  private async handleToolCall(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    let rpcRequest: JsonRpcRequest;

    try {
      rpcRequest = JSON.parse(body);
    } catch {
      this.sendJsonRpcError(res, null, -32700, 'Parse error');
      return;
    }

    if (!rpcRequest.params || typeof rpcRequest.params !== 'object') {
      this.sendJsonRpcError(res, rpcRequest.id, -32602, 'Invalid params');
      return;
    }

    const params = rpcRequest.params as {
      tool?: string;
      input?: Record<string, unknown>;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const tool = params.tool ?? params.name;
    const input = params.input ?? params.arguments;
    const callId = params.id;

    if (!tool || !input) {
      this.sendJsonRpcError(res, rpcRequest.id, -32602, 'Missing tool or input');
      return;
    }

    // Find the tool
    const toolInstance = this.tools.find(t => t.name === tool);
    if (!toolInstance) {
      this.sendJsonRpcError(res, rpcRequest.id, -32601, `Tool not found: ${tool}`);
      return;
    }

    // Check approval policy
    const shouldAutoApprove = this.toolRunner.shouldAutoApprove(
      toolInstance.name,
      toolInstance.permission
    );

    if (!shouldAutoApprove) {
      this.sendJsonRpcError(
        res,
        rpcRequest.id,
        -32000,
        `Tool ${tool} requires approval. Set dangerousSkipApproval=true or configure approval policy.`
      );
      return;
    }

    // Execute the tool
    try {
      // Broadcast progress event
      this.broadcastSseEvent({
        type: 'progress',
        toolCallId: callId ?? rpcRequest.id.toString(),
        message: `Executing ${tool}...`,
      });

      const result = await toolInstance.execute(input);

      // Broadcast result event
      this.broadcastSseEvent({
        type: result.isError ? 'error' : 'result',
        toolCallId: callId ?? rpcRequest.id.toString(),
        data: result.content,
      });

      this.sendJsonRpcResponse(res, rpcRequest.id, {
        content: result.content,
        isError: result.isError,
      });
    } catch (err) {
      const errorMessage = (err as Error).message;

      this.broadcastSseEvent({
        type: 'error',
        toolCallId: callId ?? rpcRequest.id.toString(),
        message: errorMessage,
      });

      this.sendJsonRpcError(res, rpcRequest.id, -32000, `Tool execution error: ${errorMessage}`);
    }
  }

  /**
   * Handle GET /mcp/sse - SSE endpoint for progress events.
   */
  private async handleSse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Add client to set
    this.sseClients.add(res);

    // Send initial connection event
    this.sendSseEvent(res, { type: 'progress', toolCallId: 'connection', message: 'Connected' });

    // Remove client on disconnect
    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  /**
   * Broadcast an SSE event to all connected clients.
   */
  private broadcastSseEvent(event: SseEvent): void {
    for (const client of this.sseClients) {
      this.sendSseEvent(client, event);
    }
  }

  /**
   * Send an SSE event to a specific client.
   */
  private sendSseEvent(res: http.ServerResponse, event: SseEvent): void {
    const data = JSON.stringify(event);
    res.write(`data: ${data}\n\n`);
  }

  /**
   * Send a JSON-RPC success response.
   */
  private sendJsonRpcResponse(
    res: http.ServerResponse,
    id: string | number,
    result: unknown
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response.
   */
  private sendJsonRpcError(
    res: http.ServerResponse,
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message, data },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Read the request body as a string.
   */
  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}
