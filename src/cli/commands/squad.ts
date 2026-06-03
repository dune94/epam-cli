import { Command } from 'commander';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { createTools } from '../../tools/createTools.js';
import { ProviderChain } from '../../providers/ProviderChain.js';
import { getApiKey as getEnvApiKey } from '../../config/EnvVarOverrides.js';
import { resolveProviderSecret } from '../../auth/ProviderCredentialStore.js';
import { detectTier } from '../../billing/TierDetector.js';
import { SquadRunner } from '../../agent/squad/SquadRunner.js';

export function createSquadCommand(): Command {
  return new Command('squad')
    .description('Execute a task using a multi-agent squad (Leader, Coder, Tester, SecurityAuditor)')
    .argument('<task>', 'Task description for the squad to execute')
    .option('-m, --model <model>', 'Model to use')
    .option('-p, --provider <provider>', 'Provider to use')
    .action(async (task: string, opts) => {
      const config = await resolveConfig({
        model: opts.model,
        provider: opts.provider,
      });

      const authManager = new AuthManager(config.backendUrl);
      const tier = await detectTier();

      // Build provider chain
      const chain = new ProviderChain({
        slots: config.llmChain,
        resolveApiKey: async (providerName: string) => {
          return getEnvApiKey(providerName) ?? await resolveProviderSecret(providerName);
        },
        proxyConfig: (tier === 'pro' || tier === 'enterprise') ? {
          backendUrl: config.backendUrl,
          getAccessToken: () => authManager.getValidToken(),
        } : undefined,
      });
      await chain.initialize();

      const provider = chain;

      const tools = createTools();

      // Progress callback - stream to terminal
      const onProgress = (role: string, message: string) => {
        process.stderr.write(`[${role}] ${message}\n`);
      };

      const runner = new SquadRunner({
        taskDescription: task,
        provider,
        model: config.model,
        tools,
        dangerousSkipApproval: config.tools.dangerousSkipApproval,
        maxOutputTokens: config.maxOutputTokens,
        onProgress,
      });

      try {
        const result = await runner.run();

        // Output final result to stdout
        console.log(result.finalOutput);

        // Show summary to stderr
        process.stderr.write(`\n✓ Squad execution complete\n`);
        process.stderr.write(`  Review cycles: ${result.reviewCycles}\n`);
        if (result.securityReview?.status === 'approved') {
          process.stderr.write(`  Security: Approved\n`);
        } else if (result.securityReview?.status === 'blocked') {
          process.stderr.write(`  Security: Blocked (${result.securityReview.findings.length} findings)\n`);
        }
      } catch (err) {
        process.stderr.write(`\n✗ Squad execution failed: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
