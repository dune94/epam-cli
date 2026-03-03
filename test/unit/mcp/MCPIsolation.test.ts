/**
 * MCP Isolation Test
 * 
 * Verifies that MCP auto-query failures NEVER trigger provider failover
 * and NEVER disrupt chat flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { autoQueryMCP, formatMCPResults } from '../../../src/mcp/MCPAutoQuery.js';
import { MCPClient } from '../../../src/mcp/MCPClient.js';

// Mock fetch globally
const originalFetch = global.fetch;

describe('MCP Isolation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  describe('MCPClient', () => {
    it('should never throw on network error', async () => {
      // Simulate network error
      vi.mocked(global.fetch).mockRejectedValue(new Error('fetch failed'));

      const client = new MCPClient({ baseUrl: 'http://localhost:9010' });
      
      // Should NOT throw
      const result = await client.query({ query: 'test' });
      
      // Should return silent fail
      expect(result.items).toEqual([]);
      expect(result.error).toBeUndefined(); // Silent fail
    });

    it('should never throw on HTTP error', async () => {
      // Simulate HTTP error
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const client = new MCPClient({ baseUrl: 'http://localhost:9010' });
      
      // Should NOT throw
      const result = await client.query({ query: 'test' });
      
      // Should return silent fail
      expect(result.items).toEqual([]);
      expect(result.error).toBeUndefined(); // Silent fail
    });

    it('should return items on success', async () => {
      // Simulate successful response
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: [
            { id: 'PROJ-123', title: 'Test ticket', status: 'In Progress' },
          ],
        }),
      } as Response);

      const client = new MCPClient({ baseUrl: 'http://localhost:9010' });
      const result = await client.query({ query: 'test' });
      
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe('PROJ-123');
      expect(result.error).toBeUndefined();
    });
  });

  describe('autoQueryMCP', () => {
    it('should return empty array when no keywords match', async () => {
      const result = await autoQueryMCP('hello how are you');
      expect(result).toEqual([]);
    });

    it('should return empty array when MCP servers unavailable', async () => {
      // Simulate network error
      vi.mocked(global.fetch).mockRejectedValue(new Error('fetch failed'));

      // Should trigger JIRA detection
      const result = await autoQueryMCP('how many jira tickets?');
      
      // Should NOT throw, should return empty
      expect(result).toEqual([]);
    });

    it('should return results when MCP servers available', async () => {
      // Simulate successful response
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: [
            { id: 'PROJ-123', title: 'Auth ticket', status: 'In Progress' },
          ],
        }),
      } as Response);

      // Set env var for JIRA
      process.env.MCP_JIRA_URL = 'http://localhost:9010';

      const result = await autoQueryMCP('how many jira tickets?');
      
      expect(result.length).toBe(1);
      expect(result[0].items.length).toBe(1);

      // Cleanup
      delete process.env.MCP_JIRA_URL;
    });
  });

  describe('formatMCPResults', () => {
    it('should format results with chalk formatting', () => {
      const results = [{
        source: 'http://localhost:9010',
        items: [
          { id: 'PROJ-123', title: 'Test ticket', status: 'In Progress' },
        ],
      }];

      const formatted = formatMCPResults(results);
      
      expect(formatted).toContain('[MCP SOURCES]');
      expect(formatted).toContain('LOCALHOST:9010'); // Source name from URL
      expect(formatted).toContain('Test ticket');
    });

    it('should return empty string for no results', () => {
      const formatted = formatMCPResults([]);
      expect(formatted).toBe('');
    });

    it('should skip items with errors', () => {
      const results = [{
        source: 'http://localhost:9010',
        items: [],
        error: 'Server unavailable',
      }];

      const formatted = formatMCPResults(results);
      // Should still show header but no items
      expect(formatted).toContain('[MCP SOURCES]');
    });
  });
});
