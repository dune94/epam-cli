import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StdioTransport } from '../../../src/mcp/StdioTransport.js';
import type { McpServerConfig } from '../../../src/mcp/types.js';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc.stdin = new Writable({
    write(_chunk: any, _enc: string, cb: () => void) { cb(); },
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function sendResponse(proc: any, response: Record<string, unknown>) {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
}

describe('StdioTransport', () => {
  let transport: StdioTransport;
  let mockProc: any;

  const config: McpServerConfig = {
    name: 'test-stdio',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
  };

  beforeEach(() => {
    mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    transport = new StdioTransport(config);
  });

  afterEach(() => {
    transport.shutdown();
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('should spawn the process with correct command and args', async () => {
      const connectPromise = transport.connect();

      // Respond to initialize
      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1.0.0' },
          },
        });
      }, 10);

      // Respond to tools/list
      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'navigate',
                description: 'Navigate to a URL',
                inputSchema: {
                  type: 'object',
                  properties: { url: { type: 'string' } },
                  required: ['url'],
                },
              },
            ],
          },
        });
      }, 20);

      const tools = await connectPromise;

      expect(spawn).toHaveBeenCalledWith('node', ['server.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({}),
      });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('navigate');
      expect(tools[0].description).toBe('Navigate to a URL');
    });

    it('should throw when command is missing', async () => {
      const badConfig: McpServerConfig = {
        name: 'no-cmd',
        transport: 'stdio',
      };
      const badTransport = new StdioTransport(badConfig);

      await expect(badTransport.connect()).rejects.toThrow('requires a "command" field');
    });

    it('should pass custom env vars to spawned process', async () => {
      const envConfig: McpServerConfig = {
        name: 'env-test',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { CHROME_PATH: '/usr/bin/chrome' },
      };

      const envTransport = new StdioTransport(envConfig);
      const connectPromise = envTransport.connect();

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
        });
      }, 10);

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 2,
          result: { tools: [] },
        });
      }, 20);

      await connectPromise;

      expect(spawn).toHaveBeenCalledWith('node', ['server.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ CHROME_PATH: '/usr/bin/chrome' }),
      });

      envTransport.shutdown();
    });
  });

  describe('callTool', () => {
    beforeEach(async () => {
      const connectPromise = transport.connect();

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
        });
      }, 10);

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 2,
          result: { tools: [{ name: 'navigate', description: 'Navigate', inputSchema: { type: 'object', properties: {} } }] },
        });
      }, 20);

      await connectPromise;
    });

    it('should call a tool and return the result', async () => {
      const callPromise = transport.callTool('navigate', { url: 'https://example.com' });

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0',
          id: 3,
          result: {
            content: [{ type: 'text', text: 'Navigated to https://example.com' }],
          },
        });
      }, 10);

      const result = await callPromise;

      expect(result.isError).toBe(false);
      expect(result.content).toBe('Navigated to https://example.com');
    });

    it('should handle tool errors from server', async () => {
      const callPromise = transport.callTool('navigate', { url: 'bad' });

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0',
          id: 3,
          error: { code: -32000, message: 'Navigation failed' },
        });
      }, 10);

      const result = await callPromise;

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Navigation failed');
    });
  });

  describe('shutdown', () => {
    it('should kill the spawned process', async () => {
      const connectPromise = transport.connect();

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
        });
      }, 10);

      setTimeout(() => {
        sendResponse(mockProc, {
          jsonrpc: '2.0', id: 2,
          result: { tools: [] },
        });
      }, 20);

      await connectPromise;

      transport.shutdown();

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});
