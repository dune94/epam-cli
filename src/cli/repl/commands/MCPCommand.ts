/**
 * /mcp Slash Command
 * 
 * Toggle MCP servers and show status
 */

import chalk from 'chalk';
import type { SlashCommand, SlashCommandContext } from '../SlashCommands.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface MCPServer {
  name: string;
  url: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: number;
}

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  aliases: ['mcp-servers'],
  description: 'Toggle MCP servers and show status',
  usage: '[list|connect|disconnect]',
  
  async execute(args, ctx): Promise<boolean> {
    const trimmedArgs = args.trim().toLowerCase();
    
    if (!trimmedArgs || trimmedArgs === 'list') {
      return listServers(ctx);
    }
    
    if (trimmedArgs === 'connect') {
      console.log(chalk.yellow('Connect command - coming soon'));
      console.log(chalk.dim('Usage: Configure servers in .mcp.json'));
      console.log();
      return true;
    }
    
    if (trimmedArgs === 'disconnect') {
      console.log(chalk.yellow('Disconnect command - coming soon'));
      console.log();
      return true;
    }
    
    console.log(chalk.red(`Unknown MCP command: ${trimmedArgs}`));
    console.log(chalk.dim('Usage: /mcp [list|connect|disconnect]'));
    console.log();
    
    return true;
  },
};

/**
 * List MCP servers
 */
function listServers(ctx: SlashCommandContext): boolean {
  console.log();
  console.log(chalk.bold.cyan('🔌 MCP Servers'));
  console.log();
  
  const mcpConfigPath = join(process.cwd(), '.mcp.json');
  
  if (!existsSync(mcpConfigPath)) {
    console.log(chalk.dim('No .mcp.json found'));
    console.log();
    console.log(chalk.bold('Example Configuration:'));
    console.log();
    console.log(chalk.dim('```json'));
    console.log(chalk.dim('{'));
    console.log(chalk.dim('  "servers": ['));
    console.log(chalk.dim('    {'));
    console.log(chalk.dim('      "name": "filesystem",'));
    console.log(chalk.dim('      "url": "http://localhost:3000"'));
    console.log(chalk.dim('    }'));
    console.log(chalk.dim('  ]'));
    console.log(chalk.dim('}'));
    console.log(chalk.dim('```'));
    console.log();
    return true;
  }
  
  try {
    const config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    const servers = config.servers || [];
    
    if (servers.length === 0) {
      console.log(chalk.dim('No servers configured'));
      console.log();
      return true;
    }
    
    console.log(chalk.bold('Configured Servers:'));
    console.log();
    
    for (const server of servers) {
      const status = 'disconnected'; // Would check actual status
      const statusIcon = status === 'connected' ? chalk.green('✓') :
                        status === 'error' ? chalk.red('✗') :
                        chalk.yellow('○');
      
      console.log(`  ${statusIcon} ${chalk.cyan(server.name)}`);
      if (server.url) {
        console.log(chalk.dim(`     URL: ${server.url}`));
      } else if (server.command) {
        console.log(chalk.dim(`     Command: ${server.command} ${(server.args ?? []).join(' ')}`));
      }
      console.log(chalk.dim(`     Transport: ${server.transport}`));
      console.log(chalk.dim(`     Status: ${status}`));
      console.log();
    }
    
    console.log(chalk.dim('Tip: MCP servers provide additional tools'));
    console.log(chalk.dim('     Configure in .mcp.json'));
    console.log();
    
  } catch (err) {
    console.log(chalk.red('Error reading .mcp.json'));
    console.log(chalk.dim((err as Error).message));
    console.log();
  }
  
  return true;
}
