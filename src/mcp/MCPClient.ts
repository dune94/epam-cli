/**
 * MCP Client
 * 
 * Connects to MCP (Model Context Protocol) servers
 * Uses JSON-RPC 2.0 over streamable HTTP
 * 
 * IMPORTANT: All fetch calls are isolated and never interfere with provider calls
 */

import { logger } from '../utils/logger.js';

export interface MCPConfig {
  baseUrl: string;
  timeout?: number;
}

export interface MCPQuery {
  query: string;
  type?: 'search' | 'get' | 'list';
  filters?: Record<string, unknown>;
}

export interface MCPResult {
  source: string;
  items: MCPItem[];
  error?: string;
}

export interface MCPItem {
  id: string;
  title: string;
  url?: string;
  status?: string;
  updated?: string;
  summary?: string;
}

/**
 * MCP Client for querying MCP servers
 */
export class MCPClient {
  private config: MCPConfig;

  constructor(config: MCPConfig) {
    this.config = config;
  }

  /**
   * Query MCP server
   * CRITICAL: This fetch is completely isolated from provider fetch calls
   * Never throws - always returns result (possibly with error field)
   */
  async query(query: MCPQuery): Promise<MCPResult> {
    // Use a local AbortController that can't interfere with anything else
    const localController = new AbortController();
    const timeoutId = setTimeout(() => localController.abort(), this.config.timeout || 3000);

    try {
      const response = await fetch(`${this.config.baseUrl}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'query',
          params: query,
        }),
        signal: localController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          source: this.config.baseUrl,
          items: [],
          error: undefined, // Silent fail
        };
      }

      const data = await response.json();

      if (data.error) {
        return {
          source: this.config.baseUrl,
          items: [],
          error: undefined, // Silent fail
        };
      }

      return {
        source: this.config.baseUrl,
        items: this.parseItems(data.result || []),
      };

    } catch {
      // CRITICAL: Clear timeout and return silent fail
      // This catch block ensures MCP fetch NEVER throws to caller
      clearTimeout(timeoutId);
      return {
        source: this.config.baseUrl,
        items: [],
        error: undefined, // Silent fail - never disrupts chat
      };
    }
  }

  /**
   * Search MCP server
   */
  async search(keyword: string): Promise<MCPResult> {
    return this.query({
      query: keyword,
      type: 'search',
    });
  }

  /**
   * Parse MCP response items
   */
  private parseItems(result: unknown[]): MCPItem[] {
    if (!Array.isArray(result)) {
      return [];
    }

    return result.map(item => {
      if (typeof item !== 'object' || item === null) {
        return null;
      }

      const anyItem = item as Record<string, unknown>;

      return {
        id: String(anyItem.id || anyItem.key || ''),
        title: String(anyItem.title || anyItem.summary || anyItem.name || ''),
        url: anyItem.url ? String(anyItem.url) : undefined,
        status: anyItem.status ? String(anyItem.status) : undefined,
        updated: anyItem.updated ? String(anyItem.updated) : undefined,
        summary: anyItem.summary ? String(anyItem.summary) : undefined,
      };
    }).filter((item): item is MCPItem => item !== null);
  }
}

/**
 * Create MCP clients for configured servers
 */
export function createMCPClients(): Record<string, MCPClient> {
  const clients: Record<string, MCPClient> = {};

  // JIRA
  if (process.env.MCP_JIRA_URL) {
    clients.jira = new MCPClient({
      baseUrl: process.env.MCP_JIRA_URL,
      timeout: 10000,
    });
  }

  // Confluence
  if (process.env.MCP_CONFLUENCE_URL) {
    clients.confluence = new MCPClient({
      baseUrl: process.env.MCP_CONFLUENCE_URL,
      timeout: 10000,
    });
  }

  // Draw.io
  if (process.env.MCP_DRAWIO_URL) {
    clients.drawio = new MCPClient({
      baseUrl: process.env.MCP_DRAWIO_URL,
      timeout: 10000,
    });
  }

  return clients;
}

/**
 * Get auto-query keywords for MCP sources
 */
export function getMCPKeywords(): Record<string, string[]> {
  return {
    jira: ['ticket', 'jira', 'issue', 'story', 'sprint', 'epic', 'task', 'bug'],
    confluence: ['doc', 'documentation', 'wiki', 'confluence', 'page', 'guide', 'spec'],
    drawio: ['diagram', 'drawio', 'draw.io', 'architecture', 'flow', 'design'],
  };
}

/**
 * Detect MCP source from user message
 */
export function detectMCPSource(message: string): string[] {
  const keywords = getMCPKeywords();
  const sources: string[] = [];
  const lowerMessage = message.toLowerCase();

  // Check for explicit @mentions
  if (message.includes('@jira')) sources.push('jira');
  if (message.includes('@confluence')) sources.push('confluence');
  if (message.includes('@drawio') || message.includes('@draw.io')) sources.push('drawio');
  if (message.includes('@all')) return ['jira', 'confluence', 'drawio'];

  // Auto-detect from keywords
  for (const [source, sourceKeywords] of Object.entries(keywords)) {
    if (sourceKeywords.some(kw => lowerMessage.includes(kw))) {
      sources.push(source);
    }
  }

  // Remove duplicates
  return [...new Set(sources)];
}
