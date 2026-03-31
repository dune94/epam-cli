import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '../../../src/mcp/McpServer.js';

class MockRequest extends EventEmitter {
  constructor(body = '') {
    super();
    queueMicrotask(() => {
      if (body) {
        this.emit('data', Buffer.from(body));
      }
      this.emit('end');
    });
  }
}

class MockResponse {
  statusCode: number | null = null;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers?: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers ?? {};
  }

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
  }
}

function parseJsonRpc(body: string): any {
  return JSON.parse(body);
}

describe('McpServer', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({
      port: 3100,
      bind: '127.0.0.1',
      dangerousSkipApproval: false,
    });
  });

  afterEach(() => {
    ((server as any).sseClients as Set<MockResponse>).clear();
  });

  it('returns built-in tools from tools/list', async () => {
    const req = new MockRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
    );
    const res = new MockResponse();

    await (server as any).handleToolsList(req, res);

    const payload = parseJsonRpc(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.result.tools).toHaveLength(6);
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toContain('read_file');
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toContain('bash');
  });

  it('dispatches safe tool calls', async () => {
    const req = new MockRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          tool: 'read_file',
          input: { path: 'package.json' },
          id: 'safe-call-1',
        },
      })
    );
    const res = new MockResponse();

    await (server as any).handleToolCall(req, res);

    const payload = parseJsonRpc(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.result.isError).toBe(false);
    expect(payload.result.content).toContain('"name": "epam-cli"');
  });

  it('blocks dangerous tools when approval is required', async () => {
    const req = new MockRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          tool: 'bash',
          input: { command: 'echo blocked' },
          id: 'danger-call-1',
        },
      })
    );
    const res = new MockResponse();

    await (server as any).handleToolCall(req, res);

    const payload = parseJsonRpc(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.error.message).toContain('requires approval');
  });

  it('returns parse errors for invalid JSON payloads', async () => {
    const req = new MockRequest('{invalid-json');
    const res = new MockResponse();

    await (server as any).handleToolsList(req, res);

    const payload = parseJsonRpc(res.body);
    expect(res.statusCode).toBe(200);
    expect(payload.error.code).toBe(-32700);
  });

  it('streams SSE connection and tool result events and removes disconnected clients', async () => {
    const req = new MockRequest();
    const res = new MockResponse();

    await (server as any).handleSse(req, res);
    expect(((server as any).sseClients as Set<MockResponse>).size).toBe(1);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.body).toContain('"toolCallId":"connection"');

    const toolReq = new MockRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          tool: 'read_file',
          input: { path: 'package.json' },
          id: 'sse-call-1',
        },
      })
    );
    const toolRes = new MockResponse();

    await (server as any).handleToolCall(toolReq, toolRes);

    expect(res.body).toContain('"toolCallId":"sse-call-1"');
    expect(res.body).toContain('"type":"progress"');
    expect(res.body).toContain('"type":"result"');

    req.emit('close');
    expect(((server as any).sseClients as Set<MockResponse>).size).toBe(0);
  });
});
