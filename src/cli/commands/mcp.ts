import { Command } from 'commander';
import chalk from 'chalk';
import { McpServer } from '../../mcp/McpServer.js';

export function createMcpCommand(): Command {
  const mcp = new Command('mcp').description('Serve or inspect the EPAM CLI MCP server');

  mcp.addCommand(
    new Command('serve')
      .description('Start the EPAM CLI MCP server')
      .option('--port <port>', 'Port to bind', value => parseInt(value, 10), 3100)
      .option('--bind <host>', 'Host/interface to bind', '127.0.0.1')
      .option('--list-tools', 'Print available tools and exit without starting the server')
      .option(
        '--dangerously-skip-approval',
        'Auto-approve dangerous tools for remote MCP calls'
      )
      .action(async opts => {
        const server = new McpServer({
          port: opts.port,
          bind: opts.bind,
          dangerousSkipApproval: Boolean(opts.dangerouslySkipApproval),
        });

        if (opts.listTools) {
          const tools = server.getToolDefinitions();
          console.log(chalk.bold('\nEPAM CLI MCP Tools:\n'));
          for (const tool of tools) {
            console.log(`  ${chalk.cyan(tool.name)}`);
            console.log(`    ${chalk.dim(tool.description)}`);
          }
          console.log();
          return;
        }

        await server.start();
      })
  );

  return mcp;
}
