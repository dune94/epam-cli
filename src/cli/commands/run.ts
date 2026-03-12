import { Command } from 'commander';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { ReadFileTool } from '../../tools/builtin/ReadFile.js';
import { WriteFileTool } from '../../tools/builtin/WriteFile.js';
import { BashTool } from '../../tools/builtin/Bash.js';
import { ListFilesTool } from '../../tools/builtin/ListFiles.js';
import { SearchTool } from '../../tools/builtin/Search.js';
import { FetchUrlTool } from '../../tools/builtin/FetchUrl.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSessionSystemPrompt } from '../../constraints/sessionPrompt.js';
import { consumeConsultationContext } from '../../context/ContextBuilder.js';
import { ProviderChain } from '../../providers/ProviderChain.js';
import { getApiKey as getEnvApiKey } from '../../config/EnvVarOverrides.js';
import { getApiKey as getStoredApiKey } from '../../billing/KeychainKeyStore.js';
import { detectTier } from '../../billing/TierDetector.js';
import { calculateCost } from '../../billing/pricing.js';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk.toString());
  }
  return chunks.join('').trim();
}

export function createRunCommand(): Command {
  return new Command('run')
    .description('Run a single agent task non-interactively')
    .argument('[prompt]', 'The task to execute (use "-" or omit to read from stdin)')
    .option('-m, --model <model>', 'Model to use')
    .option('-p, --provider <provider>', 'Provider to use')
    .option('--no-tools', 'Disable all tools')
    .option('--json', 'Output result as structured JSON (suppresses streaming text)')
    .action(async (promptArg: string | undefined, opts) => {
      // Resolve the prompt: argument, stdin via "-", or piped stdin when omitted
      let prompt: string;
      if (promptArg === '-' || (promptArg == null && !process.stdin.isTTY)) {
        prompt = await readStdin();
        if (!prompt) {
          process.stderr.write('Error: no prompt provided via stdin\n');
          process.exit(1);
        }
      } else if (promptArg) {
        prompt = promptArg;
      } else {
        process.stderr.write('Error: <prompt> argument required, or pipe input via stdin\n');
        process.exit(1);
      }

      const jsonMode = opts.json === true;
      const config = await resolveConfig({
        model: opts.model,
        provider: opts.provider,
      });

      const authManager = new AuthManager(config.backendUrl);
      const tier = await detectTier();

      // If BYOK key is available for the requested provider, skip proxy
      const providerToCheck = opts.provider ?? config.provider;
      const hasByokKey = !!(
        getEnvApiKey(providerToCheck) ??
        getEnvApiKey(config.provider) ??
        await getStoredApiKey(providerToCheck) ??
        await getStoredApiKey(config.provider)
      );
      const useProxy = !hasByokKey && (tier === 'pro' || tier === 'enterprise');

      const chain = new ProviderChain({
        slots: config.llmChain,
        resolveApiKey: async (providerName: string) => {
          return getEnvApiKey(providerName) ?? await getStoredApiKey(providerName);
        },
        proxyConfig: useProxy ? {
          backendUrl: config.backendUrl,
          getAccessToken: () => authManager.getValidToken(),
        } : undefined,
      });
      await chain.initialize();

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

      const systemPrompt = await buildSessionSystemPrompt(config, authManager);
      const userMessage = config.projectRoot
        ? await consumeConsultationContext(prompt, config.projectRoot)
        : prompt;

      const runner = new AgentRunner({
        userMessage,
        systemPrompt,
        provider: chain,
        model: config.model,
        tools,
        maxIterations: config.maxIterations,
        autoCompressAt: config.autoCompressAt,
        maxOutputTokens: config.maxOutputTokens,
        dangerousSkipApproval: config.tools.dangerousSkipApproval,
        onTextDelta: jsonMode ? undefined : delta => process.stdout.write(delta),
      });

      const result = await runner.run();

      if (jsonMode) {
        const cost = calculateCost(
          config.model,
          result.usage.inputTokens,
          result.usage.outputTokens,
        );
        const output = {
          result: result.finalResponse,
          model: config.model,
          provider: config.provider,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          },
          cost_usd: Math.round(cost * 10000) / 10000,
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        if (process.stdout.isTTY) process.stdout.write('\n');
      }
    });
}
