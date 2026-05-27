/**
 * /mcp-query Slash Command
 * 
 * Query MCP sources manually
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { createMCPClients, detectMCPSource } from '../../../mcp/MCPClient.js';

export const mcpQueryCommand: SlashCommand = {
  name: 'mcp-query',
  aliases: ['sources'],
  description: 'Query MCP sources manually (@jira, @confluence, etc.)',
  usage: '<jira|confluence|drawio|all> <query>',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim();
    
    if (!trimmedArgs) {
      return showMCPStatus(ctx);
    }
    
    const parts = trimmedArgs.split(/\s+/);
    const source = parts[0].toLowerCase();
    const query = parts.slice(1).join(' ');
    
    if (!query) {
      console.log(chalk.red('Error: Query required'));
      console.log(chalk.dim('Usage: /mcp <source> <query>'));
      console.log();
      return true;
    }
    
    return queryMCP(source, query, ctx);
  },
};

/**
 * Show MCP source status
 */
async function showMCPStatus(ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🔌 MCP Sources'));
  console.log();
  
  const clients = createMCPClients();
  
  if (Object.keys(clients).length === 0) {
    console.log(chalk.yellow('⚠  No MCP sources configured'));
    console.log();
    console.log(chalk.dim('Configure in .env:'));
    console.log(chalk.dim('  MCP_JIRA_URL=http://localhost:9010'));
    console.log(chalk.dim('  MCP_CONFLUENCE_URL=http://localhost:9020'));
    console.log(chalk.dim('  MCP_DRAWIO_URL=http://localhost:9040'));
    console.log();
    return true;
  }
  
  console.log(chalk.bold('Connected Sources:'));
  console.log();
  
  for (const [name, client] of Object.entries(clients) as [string, any][]) {
    console.log(chalk.green(`✓ ${name}`));
    console.log(chalk.dim(`  ${client.config?.baseUrl}`));
    console.log();
  }
  
  console.log(chalk.bold('Usage:'));
  console.log(chalk.dim('  /mcp jira authentication'));
  console.log(chalk.dim('  /mcp confluence auth docs'));
  console.log(chalk.dim('  /mcp all authentication'));
  console.log();
  
  console.log(chalk.bold('Auto-query:'));
  console.log(chalk.dim('  Type naturally - MCP sources queried automatically'));
  console.log(chalk.dim('  Use @jira, @confluence, @drawio, @all for explicit queries'));
  console.log();
  
  return true;
}

/**
 * Query MCP source
 */
async function queryMCP(source: string, query: string, ctx: SlashCommandContext): Promise<boolean> {
  console.log();
  console.log(chalk.bold.cyan('🔍 Querying MCP Sources'));
  console.log();
  
  const clients = createMCPClients();
  
  if (source === 'all') {
    // Query all sources
    const results = await Promise.all(
      (Object.entries(clients) as [string, any][]).map(async ([name, client]) => {
        const result = await client.search(query);
        return { name, ...result };
      })
    );
    
    displayResults(results);
  } else {
    // Query specific source
    const client = clients[source];
    
    if (!client) {
      console.log(chalk.red(`Unknown source: ${source}`));
      console.log(chalk.dim('Available: jira, confluence, drawio, all'));
      console.log();
      return true;
    }
    
    const result = await client.search(query);
    displayResults([{ name: source, ...result }]);
  }
  
  return true;
}

/**
 * Display MCP query results
 */
function displayResults(results: Array<{ name: string; source: string; items: unknown[]; error?: string }>): void {
  for (const result of results) {
    if (result.error) {
      console.log(chalk.red(`[${result.name.toUpperCase()}] Error: ${result.error}`));
      console.log();
      continue;
    }
    
    if (result.items.length === 0) {
      console.log(chalk.dim(`[${result.name.toUpperCase()}] No results found`));
      console.log();
      continue;
    }
    
    console.log(chalk.bold(`[${result.name.toUpperCase()}] ${result.items.length} result(s):`));
    console.log();
    
    for (const item of result.items.slice(0, 5) as Record<string, unknown>[]) {
      console.log(chalk.cyan(`  • ${item['title']}`));

      if (item['status']) {
        console.log(chalk.dim(`    Status: ${item['status']}`));
      }

      if (item['updated']) {
        console.log(chalk.dim(`    Updated: ${item['updated']}`));
      }

      if (item['url']) {
        console.log(chalk.dim(`    URL: ${item['url']}`));
      }
      
      console.log();
    }
    
    if (result.items.length > 5) {
      console.log(chalk.dim(`  ... and ${result.items.length - 5} more`));
      console.log();
    }
  }
}
