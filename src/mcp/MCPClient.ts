/**
 * MCP Client
 * 
 * Connects to MCP (Model Context Protocol) servers
 * Uses JSON-RPC 2.0 over streamable HTTP
 * Falls back to direct JIRA API when MCP unavailable
 * NO MOCK DATA - uses REAL APIs only
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
  readonly name = 'mcp';
  private config: MCPConfig;
  private sessionId?: string;

  constructor(config: MCPConfig) {
    this.config = config;
  }

  /**
   * Query MCP server using proper MCP protocol
   * Falls back to direct JIRA API for MCP-atlassian servers
   */
  async query(query: MCPQuery): Promise<MCPResult> {
    const localController = new AbortController();
    const timeoutId = setTimeout(() => localController.abort(), this.config.timeout || 5000);

    try {
      // Extract ticket ID from query
      const ticketMatch = query.query.match(/([A-Z]+-\d+)/i);
      
      if (!ticketMatch) {
        clearTimeout(timeoutId);
        return { source: this.config.baseUrl, items: [], error: undefined };
      }

      const ticketId = ticketMatch[1].toUpperCase();

      // Try MCP protocol first
      try {
        const mcpResult = await this.queryViaMCP(ticketId, localController.signal);
        clearTimeout(timeoutId);
        
        if (mcpResult && mcpResult.items.length > 0) {
          return mcpResult;
        }
      } catch (mcpErr) {
        // MCP failed, fall through to direct API
        if (process.env.EPAM_DEBUG === '1') {
          console.error('[MCP] MCP failed, using direct API:', (mcpErr as Error).message);
        }
      }

      // Fall back to direct JIRA API
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP] Using direct JIRA API for:', ticketId);
      }
      const jiraResult = await this.queryViaJiraAPI(ticketId, localController.signal);
      clearTimeout(timeoutId);
      return jiraResult;

    } catch (err) {
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP] Query error:', (err as Error).message);
      }
      clearTimeout(timeoutId);
      return { source: this.config.baseUrl, items: [], error: undefined };
    }
  }

  /**
   * Initialize MCP session and get session ID
   */
  private async initializeMCP(signal: AbortSignal): Promise<void> {
    const initResponse = await fetch(`${this.config.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'epam-cli', version: '0.1.0' },
        },
      }),
      signal,
    });

    if (!initResponse.ok) {
      throw new Error(`MCP init failed: ${initResponse.status}`);
    }

    // Get session ID from response header
    const sessionIdHeader = initResponse.headers.get('mcp-session-id');
    if (sessionIdHeader) {
      this.sessionId = sessionIdHeader;
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP] Session ID:', this.sessionId);
      }
    }
  }

  /**
   * Query via MCP protocol
   */
  private async queryViaMCP(ticketId: string, signal: AbortSignal): Promise<MCPResult> {
    // Initialize session if needed
    if (!this.sessionId) {
      await this.initializeMCP(signal);
    }

    // Build headers with session ID
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    // Call JIRA tool
    const toolResponse = await fetch(`${this.config.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'jira_get_issue',
          arguments: { issue_key: ticketId },  // Fixed: use issue_key not issueIdOrKey
        },
      }),
      signal,
    });

    if (!toolResponse.ok) {
      throw new Error(`MCP tool call failed: ${toolResponse.status}`);
    }

    // Parse SSE response
    const text = await toolResponse.text();
    if (process.env.EPAM_DEBUG === '1') {
      console.error('[MCP] Raw response:', text.substring(0, 500));
    }

    // Extract JSON from SSE format: "data: <json>"
    const dataMatch = text.match(/^data:\s*(.+)$/m);
    if (!dataMatch) {
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP] No data match in response');
      }
      return { source: this.config.baseUrl, items: [], error: undefined };
    }

    const data = JSON.parse(dataMatch[1]);
    
    if (data.error) {
      throw new Error(`MCP error: ${data.error.message}`);
    }
    
    if (data.result?.content?.[0]?.text) {
      try {
        const ticket = JSON.parse(data.result.content[0].text);
        if (process.env.EPAM_DEBUG === '1') {
          console.error('[MCP] Ticket found:', ticket.key, ticket.fields?.summary);
        }
        // MCP server returns flat structure: { key, summary, status: { name }, ... }
        const statusName = ticket.status?.name || ticket.fields?.status?.name || 'Unknown';
        const summary = ticket.summary || ticket.fields?.summary || 'Unknown';
        return {
          source: this.config.baseUrl,
          items: [{
            id: ticket.key || ticketId,
            title: summary,
            status: statusName,
            url: `${process.env.ATLASSIAN_BASE_URL || process.env.JIRA_URL || ''}/browse/${ticket.key || ticketId}`,
            updated: ticket.updated || ticket.fields?.updated || new Date().toISOString(),
            summary: `${ticket.key || ticketId}: ${summary} (${statusName})`,
          }],
        };
      } catch (parseErr) {
        if (process.env.EPAM_DEBUG === '1') {
          console.error('[MCP] Parse error:', (parseErr as Error).message);
        }
        return {
          source: this.config.baseUrl,
          items: [{
            id: ticketId,
            title: 'JIRA Issue',
            summary: data.result.content[0].text.substring(0, 200),
          }],
        };
      }
    }

    return { source: this.config.baseUrl, items: [], error: undefined };
  }

  /**
   * Query via direct JIRA API (fallback)
   * NO MOCK DATA - returns empty if JIRA returns 404
   */
  private async queryViaJiraAPI(ticketId: string, signal: AbortSignal): Promise<MCPResult> {
    const jiraBaseUrl = process.env.ATLASSIAN_BASE_URL || process.env.JIRA_URL || '';
    const jiraUrl = jiraBaseUrl + '/rest/api/3/issue/' + ticketId;
    
    if (process.env.EPAM_DEBUG === '1') {
      console.error('[JIRA] Direct API URL:', jiraUrl);
    }
    
    const response = await fetch(jiraUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64')}`,
        'Accept': 'application/json',
      },
      signal,
    });

    if (process.env.EPAM_DEBUG === '1') {
      console.error('[JIRA] Response status:', response.status);
    }

    // 404 - Ticket doesn't exist, return empty (NO MOCK DATA)
    if (response.status === 404) {
      return { source: this.config.baseUrl, items: [], error: undefined };
    }

    if (!response.ok) {
      return { source: this.config.baseUrl, items: [], error: undefined };
    }

    const ticket = await response.json() as Record<string, any>;

    if (process.env.EPAM_DEBUG === '1') {
      console.error('[JIRA] Ticket found:', ticket['key'], ticket['fields']?.summary);
    }

    return {
      source: this.config.baseUrl,
      items: [{
        id: ticket['key'] || ticketId,
        title: ticket['fields']?.summary || 'Unknown',
        status: ticket['fields']?.status?.name || 'Unknown',
        url: `${process.env.ATLASSIAN_BASE_URL || process.env.JIRA_URL || ''}/browse/${ticket['key'] || ticketId}`,
        updated: ticket['fields']?.updated || new Date().toISOString(),
        summary: `${ticket['key'] || ticketId}: ${ticket['fields']?.summary || 'No summary'} (${ticket['fields']?.status?.name || 'Unknown'})`,
      }],
    };
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
}

/**
 * Create MCP clients from environment variables
 */
export function createMCPClients(): Record<string, MCPClient> {
  const clients: Record<string, MCPClient> = {};

  // JIRA - 5 second timeout for fast fail
  if (process.env.MCP_JIRA_URL) {
    clients.jira = new MCPClient({
      baseUrl: process.env.MCP_JIRA_URL,
      timeout: 5000,
    });
  }

  // Confluence - 5 second timeout for fast fail
  if (process.env.MCP_CONFLUENCE_URL) {
    clients.confluence = new MCPClient({
      baseUrl: process.env.MCP_CONFLUENCE_URL,
      timeout: 5000,
    });
  }

  // Draw.io - 5 second timeout for fast fail
  if (process.env.MCP_DRAWIO_URL) {
    clients.drawio = new MCPClient({
      baseUrl: process.env.MCP_DRAWIO_URL,
      timeout: 5000,
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
