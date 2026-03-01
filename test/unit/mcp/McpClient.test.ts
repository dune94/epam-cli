import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { McpClient } from '../../../src/mcp/McpClient.js';
import type { McpToolDefinition } from '../../../src/mcp/types.js';
import fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('McpClient', () => {
  let client: McpClient;
  const mockProjectRoot = '/test/project';

  beforeEach(() => {
    client = new McpClient(mockProjectRoot);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('.mcp.json parsing', () => {
    it('should parse valid .mcp.json', async () => {
      const validConfig = {
        servers: [
          {
            name: 'test-server',
            url: 'http://localhost:3000',
            transport: 'http',
          },
        ],
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [] },
        }),
      });

      await client.initialize();
      const servers = client.getServers();

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('test-server');
      expect(servers[0].url).toBe('http://localhost:3000');
      expect(servers[0].transport).toBe('http');
    });

    it('should handle missing .mcp.json gracefully', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await client.initialize();
      const servers = client.getServers();

      expect(servers).toHaveLength(0);
    });

    it('should handle invalid JSON in .mcp.json', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('invalid json {');

      await client.initialize();
      const servers = client.getServers();

      expect(servers).toHaveLength(0);
    });

    it('should handle missing servers array in config', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ foo: 'bar' }));

      await client.initialize();
      const servers = client.getServers();

      expect(servers).toHaveLength(0);
    });
  });

  describe('tool registration', () => {
    it('should register remote tools with namespaced names', async () => {
      const validConfig = {
        servers: [
          {
            name: 'test-server',
            url: 'http://localhost:3000',
            transport: 'http',
          },
        ],
      };

      const remoteTool: McpToolDefinition = {
        name: 'example_tool',
        description: 'An example tool',
        inputSchema: {
          type: 'object',
          properties: {
            arg1: { type: 'string' },
          },
          required: ['arg1'],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [remoteTool] },
        }),
      });

      await client.initialize();
      const tools = client.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-server/example_tool');
      expect(tools[0].description).toContain('An example tool');
      expect(tools[0].permission).toBe('review');
    });

    it('should handle multiple servers and tools', async () => {
      const validConfig = {
        servers: [
          {
            name: 'server1',
            url: 'http://localhost:3000',
            transport: 'http',
          },
          {
            name: 'server2',
            url: 'http://localhost:3001',
            transport: 'sse',
          },
        ],
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [
                { name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } },
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [
                { name: 'tool2', description: 'Tool 2', inputSchema: { type: 'object', properties: {} } },
                { name: 'tool3', description: 'Tool 3', inputSchema: { type: 'object', properties: {} } },
              ],
            },
          }),
        });

      await client.initialize();
      const tools = client.getTools();

      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name).sort()).toEqual([
        'server1/tool1',
        'server2/tool2',
        'server2/tool3',
      ]);
    });
  });

  describe('remote tool proxy', () => {
    it('should proxy tool calls to remote server', async () => {
      const validConfig = {
        servers: [
          {
            name: 'test-server',
            url: 'http://localhost:3000',
            transport: 'http',
          },
        ],
      };

      const remoteTool: McpToolDefinition = {
        name: 'example_tool',
        description: 'An example tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
          required: ['input'],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // First call: tools/list
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0',
              id: 1,
              result: { tools: [remoteTool] },
            }),
          };
        } else {
          // Second call: tools/call
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0',
              id: 2,
              result: { content: 'Tool executed successfully' },
            }),
          };
        }
      });

      await client.initialize();
      const tools = client.getTools();
      const result = await tools[0].execute({ input: 'test' });

      expect(result.isError).toBe(false);
      expect(result.content).toBe('Tool executed successfully');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should handle remote tool errors', async () => {
      const validConfig = {
        servers: [
          {
            name: 'test-server',
            url: 'http://localhost:3000',
            transport: 'http',
          },
        ],
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0',
              id: 1,
              result: {
                tools: [
                  {
                    name: 'failing_tool',
                    description: 'A tool that fails',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            }),
          };
        } else {
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0',
              id: 2,
              error: {
                code: -32000,
                message: 'Tool execution failed',
              },
            }),
          };
        }
      });

      await client.initialize();
      const tools = client.getTools();
      const result = await tools[0].execute({});

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Tool execution failed');
    });
  });

  describe('unreachable server handling', () => {
    it('should skip unreachable servers and continue session', async () => {
      const validConfig = {
        servers: [
          {
            name: 'unreachable-server',
            url: 'http://localhost:9999',
            transport: 'http',
          },
          {
            name: 'working-server',
            url: 'http://localhost:3000',
            transport: 'http',
          },
        ],
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url) => {
        fetchCallCount++;
        if ((url as string).includes('9999')) {
          throw new Error('Connection refused');
        }
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: fetchCallCount,
            result: { tools: [{ name: 'tool1', description: 'Test', inputSchema: { type: 'object', properties: {} } }] },
          }),
        };
      });

      await client.initialize();
      const servers = client.getServers();

      expect(servers).toHaveLength(2);
      expect(servers[0].connected).toBe(false);
      expect(servers[0].error).toContain('Connection refused');
      expect(servers[1].connected).toBe(true);

      const tools = client.getTools();
      expect(tools).toHaveLength(1); // Only from working-server
      expect(tools[0].name).toBe('working-server/tool1');
    });
  });
});
