import { Command } from 'commander';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { ReadFileTool } from '../../tools/builtin/ReadFile.js';
import { WriteFileTool } from '../../tools/builtin/WriteFile.js';
import { BashTool } from '../../tools/builtin/Bash.js';
import { ListFilesTool } from '../../tools/builtin/ListFiles.js';
import { SearchTool } from '../../tools/builtin/Search.js';
import { FetchUrlTool } from '../../tools/builtin/FetchUrl.js';
import { Repl } from '../repl/Repl.js';
import { PipeWriter } from '../output/PipeWriter.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSessionSystemPrompt } from '../../constraints/sessionPrompt.js';
import { consumeConsultationContext } from '../../context/ContextBuilder.js';
import { ProviderChain } from '../../providers/ProviderChain.js';
import { getApiKey as getEnvApiKey } from '../../config/EnvVarOverrides.js';
import { getApiKey as getStoredApiKey } from '../../billing/KeychainKeyStore.js';
import { detectTier } from '../../billing/TierDetector.js';

const VERSION = '0.1.0';

export function createChatCommand(): Command {
  return new Command('chat')
    .description('Start an interactive chat session')
    .option('-m, --model <model>', 'Model to use')
    .option('-p, --provider <provider>', 'Provider to use')
    .action(async (opts) => {
      const config = await resolveConfig({
        model: opts.model,
        provider: opts.provider,
      });

      const authManager = new AuthManager(config.backendUrl);
      const tier = await detectTier();

      // Build provider chain from llmChain config (up to 5 slots)
      const chain = new ProviderChain({
        slots: config.llmChain,
        resolveApiKey: async (providerName: string) => {
          return getEnvApiKey(providerName) ?? await getStoredApiKey(providerName);
        },
        proxyConfig: (tier === 'pro' || tier === 'enterprise') ? {
          backendUrl: config.backendUrl,
          getAccessToken: () => authManager.getValidToken(),
        } : undefined,
      });
      await chain.initialize();

      // Fallback single provider (used for pipe mode and MemoryCompressor)
      const provider = chain;

      const tools = [
        new ReadFileTool(),
        new WriteFileTool(),
        new BashTool(),
        new ListFilesTool(),
        new SearchTool(),
        new FetchUrlTool(),
      ];

      if (!process.stdin.isTTY) {
        // Pipe mode: read stdin and run once
        const chunks: string[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk.toString());
        }
        const rawMessage = chunks.join('').trim();
        if (!rawMessage) process.exit(0);

        const systemPrompt = await buildSessionSystemPrompt(config, authManager);
        const userMessage = config.projectRoot
          ? await consumeConsultationContext(rawMessage, config.projectRoot)
          : rawMessage;

        const writer = new PipeWriter();
        const runner = new AgentRunner({
          userMessage,
          systemPrompt,
          provider,
          model: config.model,
          tools,
          maxIterations: config.maxIterations,
          autoCompressAt: config.autoCompressAt,
          maxOutputTokens: config.maxOutputTokens,
          dangerousSkipApproval: config.tools.dangerousSkipApproval,
          onTextDelta: delta => writer.write(delta),
        });

        await runner.run();
        writer.finalize();
        return;
      }

      const repl = new Repl({ provider, tools, config, version: VERSION, providerChain: chain, authManager });
      await repl.start();
    });
}
