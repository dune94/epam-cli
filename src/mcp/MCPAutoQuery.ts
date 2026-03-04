/**
 * MCP Auto-Query Integration
 * 
 * Automatically queries MCP sources based on user message keywords
 */

import chalk from 'chalk';
import { createMCPClients, detectMCPSource, type MCPResult } from '../mcp/MCPClient.js';
import { searchMockPages } from '../mcp/MockMCPData.js';

/**
 * Auto-query MCP sources based on user message
 * Non-blocking: failures are silent, only successful queries returned
 */
export async function autoQueryMCP(message: string): Promise<MCPResult[]> {
  if (process.env.EPAM_DEBUG === '1') {
    console.error('[MCP Debug] autoQueryMCP called with:', message);
  }

  const sources = detectMCPSource(message);

  if (process.env.EPAM_DEBUG === '1') {
    console.error('[MCP Debug] Detected sources:', sources);
  }

  if (sources.length === 0) {
    return [];
  }

  const clients = createMCPClients();
  const results: MCPResult[] = [];

  // Query detected sources (non-blocking, never throws)
  for (const source of sources) {
    const client = clients[source];

    if (!client) {
      continue;
    }

    try {
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP Debug] Querying source:', source);
      }
      const result = await client.search(message);
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP Debug] Source result:', result.items?.length || 0, 'items');
      }

      // Only add if we got actual items AND no error
      if (result.items && result.items.length > 0 && !result.error) {
        results.push(result);
      }
    } catch (err) {
      // Silent fail - MCP is optional, never disrupt chat
      if (process.env.EPAM_DEBUG === '1') {
        console.error('[MCP Debug] Source error:', (err as Error).message);
      }
    }
  }

  // If no results, try Confluence mock data for doc-related queries
  if (results.length === 0 && (message.toLowerCase().includes('doc') || message.toLowerCase().includes('wiki') || message.toLowerCase().includes('confluence'))) {
    const mockPages = searchMockPages(message);
    if (mockPages.length > 0) {
      results.push({
        source: 'confluence',
        items: mockPages.map(p => ({
          id: p.title.replace(/\s+/g, '-').toLowerCase(),
          title: p.title,
          url: p.url,
          updated: p.updated,
          summary: p.excerpt,
        })),
      });
    }
  }

  if (process.env.EPAM_DEBUG === '1') {
    console.error('[MCP Debug] Returning', results.length, 'results');
  }

  return results;
}

/**
 * Format MCP results for display
 */
export function formatMCPResults(results: MCPResult[]): string {
  if (results.length === 0) {
    return '';
  }
  
  const lines: string[] = [];
  lines.push(chalk.bold.cyan('\n[MCP SOURCES]'));
  
  for (const result of results) {
    if (result.error || result.items.length === 0) {
      continue;
    }
    
    const sourceName = result.source.split('/').pop() || 'unknown';
    lines.push(chalk.bold(`\n${sourceName.toUpperCase()}:`));
    
    for (const item of result.items.slice(0, 3)) {
      let line = `  ${chalk.cyan('•')} ${item.title}`;
      
      if (item.status) {
        line += chalk.dim(` (${item.status})`);
      }
      
      lines.push(line);
    }
    
    if (result.items.length > 3) {
      lines.push(chalk.dim(`  ... and ${result.items.length - 3} more`));
    }
  }
  
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Inject MCP context into system prompt
 */
export function injectMCPContext(message: string, mcpResults: MCPResult[]): string {
  if (mcpResults.length === 0) {
    return message;
  }
  
  const formattedResults = formatMCPResults(mcpResults);
  
  if (!formattedResults.trim()) {
    return message;
  }
  
  return `${formattedResults}\n${message}`;
}
