import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { Tool } from '../../../src/tools/types.js';

const createMockTool = (name: string): Tool => ({
  name,
  description: `Description for ${name}`,
  permission: 'safe',
  definition: {
    name,
    description: `Description for ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async () => ({
    toolUseId: '',
    content: 'mock result',
    isError: false,
  }),
});

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool with a simple name', () => {
      const tool = createMockTool('test-tool');
      registry.register('test-tool', tool);

      expect(registry.has('test-tool')).toBe(true);
      expect(registry.get('test-tool')).toBe(tool);
    });

    it('should register a tool with a namespaced name', () => {
      const tool = createMockTool('server/tool');
      registry.register('server/tool', tool);

      expect(registry.has('server/tool')).toBe(true);
      expect(registry.get('server/tool')).toBe(tool);
    });

    it('should overwrite existing tool with same name', () => {
      const tool1 = createMockTool('tool');
      const tool2 = createMockTool('tool');

      registry.register('tool', tool1);
      registry.register('tool', tool2);

      expect(registry.get('tool')).toBe(tool2);
      expect(registry.size).toBe(1);
    });
  });

  describe('registerMany', () => {
    it('should register multiple tools at once', () => {
      const tools = [
        createMockTool('tool1'),
        createMockTool('tool2'),
        createMockTool('tool3'),
      ];

      registry.registerMany(tools);

      expect(registry.size).toBe(3);
      expect(registry.has('tool1')).toBe(true);
      expect(registry.has('tool2')).toBe(true);
      expect(registry.has('tool3')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent tool', () => {
      expect(registry.get('non-existent')).toBeUndefined();
    });

    it('should return the correct tool', () => {
      const tool = createMockTool('test');
      registry.register('test', tool);

      expect(registry.get('test')).toBe(tool);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('should return all registered tools', () => {
      const tools = [
        createMockTool('tool1'),
        createMockTool('tool2'),
        createMockTool('tool3'),
      ];

      registry.registerMany(tools);

      const allTools = registry.getAll();
      expect(allTools).toHaveLength(3);
      expect(allTools).toEqual(expect.arrayContaining(tools));
    });
  });

  describe('getByNamespace', () => {
    it('should return tools matching namespace prefix', () => {
      registry.register('server1/tool1', createMockTool('server1/tool1'));
      registry.register('server1/tool2', createMockTool('server1/tool2'));
      registry.register('server2/tool1', createMockTool('server2/tool1'));
      registry.register('local-tool', createMockTool('local-tool'));

      const server1Tools = registry.getByNamespace('server1');
      expect(server1Tools).toHaveLength(2);
      expect(server1Tools.map(t => t.name)).toEqual(
        expect.arrayContaining(['server1/tool1', 'server1/tool2'])
      );
    });

    it('should handle namespace with or without trailing slash', () => {
      registry.register('ns/tool1', createMockTool('ns/tool1'));
      registry.register('ns/tool2', createMockTool('ns/tool2'));

      expect(registry.getByNamespace('ns').length).toBe(2);
      expect(registry.getByNamespace('ns/').length).toBe(2);
    });

    it('should return empty array for non-matching namespace', () => {
      registry.register('server1/tool1', createMockTool('server1/tool1'));

      expect(registry.getByNamespace('server2')).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return false for non-existent tool', () => {
      expect(registry.has('non-existent')).toBe(false);
    });

    it('should return true for registered tool', () => {
      registry.register('test', createMockTool('test'));
      expect(registry.has('test')).toBe(true);
    });
  });

  describe('unregister', () => {
    it('should remove a registered tool', () => {
      registry.register('test', createMockTool('test'));
      expect(registry.has('test')).toBe(true);

      const removed = registry.unregister('test');
      expect(removed).toBe(true);
      expect(registry.has('test')).toBe(false);
    });

    it('should return false when removing non-existent tool', () => {
      const removed = registry.unregister('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all tools', () => {
      registry.registerMany([
        createMockTool('tool1'),
        createMockTool('tool2'),
        createMockTool('tool3'),
      ]);

      expect(registry.size).toBe(3);

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe('size', () => {
    it('should return 0 for empty registry', () => {
      expect(registry.size).toBe(0);
    });

    it('should return correct count of registered tools', () => {
      registry.register('tool1', createMockTool('tool1'));
      expect(registry.size).toBe(1);

      registry.register('tool2', createMockTool('tool2'));
      expect(registry.size).toBe(2);

      registry.unregister('tool1');
      expect(registry.size).toBe(1);
    });
  });
});
