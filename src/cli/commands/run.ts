import { Command } from 'commander';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { selectProvider } from '../../billing/ProviderSelector.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { ReadFileTool } from '../../tools/builtin/ReadFile.js';
import { WriteFileTool } from '../../tools/builtin/WriteFile.js';
import { BashTool } from '../../tools/builtin/Bash.js';
import { ListFilesTool } from '../../tools/builtin/ListFiles.js';
import { SearchTool } from '../../tools/builtin/Search.js';
import { FetchUrlTool } from '../../tools/builtin/FetchUrl.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSystemPrompt } from '../../context/ContextBuilder.js';

export function createRunCommand(): Command {
  return new Command('run')
    .description('Run a single agent task non-interactively')
    .argument('<prompt>', 'The task to execute')
    .option('-m, --model <model>', 'Model to use')
    .option('-p, --provider <provider>', 'Provider to use')
    .option('--no-tools', 'Disable all tools')
    .action(async (prompt: string, opts) => {
      const config = await resolveConfig({
        model: opts.model,
        provider: opts.provider,
      });

      const authManager = new AuthManager(config.backendUrl);
      const provider = await selectProvider({
        provider: config.provider,
        model: config.model,
        backendUrl: config.backendUrl,
        getAccessToken: () => authManager.getValidToken(),
      });

      const tools = opts.tools
        ? [
            new ReadFileTool(),
            new WriteFileTool(),
            new BashTool(),
            new ListFilesTool(),
            new SearchTool(),
            new FetchUrlTool(),
          ]
        : [];

      const systemPrompt = await buildSystemPrompt({
        contextFilePath: config.contextFile,
        systemPromptFile: config.systemPromptFile,
        projectRoot: config.projectRoot,
      });

      const runner = new AgentRunner({
        userMessage: prompt,
        systemPrompt,
        provider,
        model: config.model,
        tools,
        maxIterations: config.maxIterations,
        onTextDelta: delta => process.stdout.write(delta),
      });

      await runner.run();
      if (process.stdout.isTTY) process.stdout.write('\n');
    });
}
