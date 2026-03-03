/**
 * MCP Auto-Query Integration
 * 
 * Automatically queries MCP sources based on user message keywords
 */

import chalk from 'chalk';
import { createMCPClients, detectMCPSource, type MCPResult } from '../mcp/MCPClient.js';

/**
 * Auto-query MCP sources based on user message
 */
export async function autoQueryMCP(message: string): Promise<MCPResult[]> {
  const sources = detectMCPSource(message);
  
  if (sources.length === 0) {
    return [];
  }
  
  const clients = createMCPClients();
  const results: MCPResult[] = [];
  
  // Query detected sources
  for (const source of sources) {
    const client = clients[source];
    
    if (!client) {
      continue;
    }
    
    try {
      const result = await client.search(message);
      results.push(result);
    } catch (err) {
      // Ignore errors, continue with other sources
    }
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
