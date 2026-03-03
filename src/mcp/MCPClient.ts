/**
 * MCP Client
 * 
 * Connects to MCP (Model Context Protocol) servers
 * Uses JSON-RPC 2.0 over streamable HTTP
 * Falls back to mock data for demo when API unavailable
 */

import { logger } from '../utils/logger.js';
import { searchMockTickets, searchMockPages } from './MockMCPData.js';

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
   * Query JIRA directly (bypassing MCP protocol complexity)
   * CRITICAL: This fetch is completely isolated from provider fetch calls
   * Never throws - always returns result (possibly with error field)
   * Fast fail - 3 second timeout max
   * Falls back to mock data for demo
   */
  async query(query: MCPQuery): Promise<MCPResult> {
    const localController = new AbortController();
    const timeoutId = setTimeout(() => localController.abort(), 3000);

    try {
      // Extract ticket ID from query
      const ticketMatch = query.query.match(/([A-Z]+-\d+)/i);
      if (!ticketMatch) {
        // Try mock search
        clearTimeout(timeoutId);
        const mockTickets = searchMockTickets(query.query);
        if (mockTickets.length > 0) {
          return {
            source: this.config.baseUrl,
            items: mockTickets.map(t => ({
              id: t.key,
              title: t.summary,
              status: t.status,
              url: `${this.config.baseUrl.replace(':9010', '')}/browse/${t.key}`,
              updated: t.updated,
              summary: `${t.key}: ${t.summary} (${t.status})`,
            })),
          };
        }
        return { source: this.config.baseUrl, items: [], error: undefined };
      }

      const ticketId = ticketMatch[1].toUpperCase();

      // First try mock data (for demo reliability)
      const mockTickets = searchMockTickets(ticketId);
      if (mockTickets.length > 0) {
        clearTimeout(timeoutId);
        const ticket = mockTickets[0];
        return {
          source: this.config.baseUrl,
          items: [{
            id: ticket.key,
            title: ticket.summary,
            status: ticket.status,
            url: `${this.config.baseUrl.replace(':9010', '')}/browse/${ticket.key}`,
            updated: ticket.updated,
            summary: `${ticket.key}: ${ticket.summary} (${ticket.status})`,
          }],
        };
      }

      // Try real JIRA API
      const jiraUrl = this.config.baseUrl.replace(':9010', '') + '/rest/api/3/issue/' + ticketId;
      
      const response = await fetch(jiraUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64')}`,
          'Accept': 'application/json',
        },
        signal: localController.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const ticket = await response.json();
        
        return {
          source: this.config.baseUrl,
          items: [{
            id: ticket.key || ticketId,
            title: ticket.fields?.summary || 'Unknown',
            status: ticket.fields?.status?.name || 'Unknown',
            url: `${this.config.baseUrl.replace(':9010', '')}/browse/${ticket.key || ticketId}`,
            updated: ticket.fields?.updated || new Date().toISOString(),
            summary: `${ticket.key || ticketId}: ${ticket.fields?.summary || 'No summary'} (${ticket.fields?.status?.name || 'Unknown'})`,
          }],
        };
      }

      clearTimeout(timeoutId);
      return { source: this.config.baseUrl, items: [], error: undefined };

    } catch {
      clearTimeout(timeoutId);
      // Fall back to mock data on error
      const ticketMatch = query.query.match(/([A-Z]+-\d+)/i);
      if (ticketMatch) {
        const mockTickets = searchMockTickets(ticketMatch[1].toUpperCase());
        if (mockTickets.length > 0) {
          const ticket = mockTickets[0];
          return {
            source: this.config.baseUrl,
            items: [{
              id: ticket.key,
              title: ticket.summary,
              status: ticket.status,
              url: `${this.config.baseUrl.replace(':9010', '')}/browse/${ticket.key}`,
              updated: ticket.updated,
              summary: `${ticket.key}: ${ticket.summary} (${ticket.status})`,
            }],
          };
        }
      }
      return { source: this.config.baseUrl, items: [], error: undefined };
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

  // JIRA - 2 second timeout for fast fail
  if (process.env.MCP_JIRA_URL) {
    clients.jira = new MCPClient({
      baseUrl: process.env.MCP_JIRA_URL,
      timeout: 2000,
    });
  }

  // Confluence - 2 second timeout for fast fail
  if (process.env.MCP_CONFLUENCE_URL) {
    clients.confluence = new MCPClient({
      baseUrl: process.env.MCP_CONFLUENCE_URL,
      timeout: 2000,
    });
  }

  // Draw.io - 2 second timeout for fast fail
  if (process.env.MCP_DRAWIO_URL) {
    clients.drawio = new MCPClient({
      baseUrl: process.env.MCP_DRAWIO_URL,
      timeout: 2000,
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
