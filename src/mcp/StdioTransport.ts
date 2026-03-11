import { spawn, type ChildProcess } from 'child_process';
import type {
  McpServerConfig,
  McpToolDefinition,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';
import { logger } from '../utils/logger.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Manages a stdio-based MCP server: spawns the process and communicates
 * via newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */
export class StdioTransport {
  private process: ChildProcess | null = null;
  private buffer = '';
  private nextRpcId = 1;
  private pendingRequests = new Map<
    string | number,
    { resolve: (resp: JsonRpcResponse) => void; reject: (err: Error) => void }
  >();

  constructor(private config: McpServerConfig) {}

  /**
   * Spawn the server process, perform the MCP initialize handshake,
   * and return the list of available tools.
   */
  async connect(): Promise<McpToolDefinition[]> {
    if (!this.config.command) {
      throw new Error(`Stdio server '${this.config.name}' requires a "command" field`);
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(`[MCP:${this.config.name}:stderr] ${chunk.toString().trimEnd()}`);
    });
    this.process.on('error', (err) => {
      logger.warn(`MCP stdio process '${this.config.name}' error: ${err.message}`);
      this.rejectAll(err);
    });
    this.process.on('exit', (code) => {
      logger.debug(`MCP stdio process '${this.config.name}' exited (code=${code})`);
      this.rejectAll(new Error(`Process exited with code ${code}`));
      this.process = null;
    });

    // MCP protocol handshake
    await this.initialize();

    // Fetch available tools
    const toolsResp = await this.sendRequest('tools/list', {});
    const result = toolsResp.result as { tools?: McpToolDefinition[] } | undefined;
    return result?.tools ?? [];
  }

  /**
   * Call a tool on the remote stdio server.
   */
  async callTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    try {
      const resp = await this.sendRequest('tools/call', {
        name: toolName,
        arguments: input,
      });

      if (resp.error) {
        return {
          content: `Remote tool error: ${resp.error.message}`,
          isError: true,
        };
      }

      // MCP tools/call returns { content: [{ type, text }] }
      const result = resp.result as {
        content?: Array<{ type: string; text?: string; data?: string }>;
        isError?: boolean;
      } | undefined;

      if (result?.content && Array.isArray(result.content)) {
        const text = result.content
          .map((c) => c.text ?? c.data ?? JSON.stringify(c))
          .join('\n');
        return { content: text, isError: result.isError ?? false };
      }

      return { content: JSON.stringify(resp.result), isError: false };
    } catch (err) {
      return {
        content: `Failed to execute remote tool: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  /**
   * Kill the spawned process.
   */
  shutdown(): void {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.rejectAll(new Error('Transport shut down'));
  }

  // ── private ──────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const resp = await this.sendRequest(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'epam-cli', version: '1.0.0' },
      },
      INIT_TIMEOUT_MS
    );

    if (resp.error) {
      throw new Error(
        `MCP initialize failed: ${resp.error.message} (code ${resp.error.code})`
      );
    }

    // Send the initialized notification (no id = notification)
    this.writeMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<JsonRpcResponse> {
    const id = this.nextRpcId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.writeMessage(request);
    });
  }

  private writeMessage(msg: object): void {
    if (!this.process?.stdin?.writable) {
      throw new Error(`Cannot write to MCP process '${this.config.name}' — stdin not writable`);
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.dispatchMessage(msg);
      } catch {
        logger.debug(`[MCP:${this.config.name}] Non-JSON stdout line: ${line}`);
      }
    }
  }

  private dispatchMessage(msg: JsonRpcResponse): void {
    // Notifications (no id) are logged but ignored
    if (msg.id === undefined || msg.id === null) {
      logger.debug(`[MCP:${this.config.name}] Notification: ${JSON.stringify(msg)}`);
      return;
    }

    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      this.pendingRequests.delete(msg.id);
      pending.resolve(msg);
    } else {
      logger.debug(`[MCP:${this.config.name}] Unexpected response id=${msg.id}`);
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}
