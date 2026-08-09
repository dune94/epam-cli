import { Command } from 'commander';
import { getActivityLogger } from '../../logging/AgentActivityLogger';
import { resolveConfig } from '../../config/ConfigResolver.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { createTools, applyToolAllowlist } from '../../tools/createTools.js';
import { AgentRunner } from '../../agent/AgentRunner.js';
import { buildSessionSystemPrompt } from '../../constraints/sessionPrompt.js';
import { consumeConsultationContext } from '../../context/ContextBuilder.js';
import { ProviderChain } from '../../providers/ProviderChain.js';
import { getApiKey as getEnvApiKey } from '../../config/EnvVarOverrides.js';
import { getApiKey as getStoredApiKey } from '../../billing/KeychainKeyStore.js';
import { detectTier } from '../../billing/TierDetector.js';
import { calculateCost } from '../../billing/pricing.js';
import { wrapWithTracing } from '../../observability/TracedProvider.js';
import { flushLangfuse } from '../../observability/LangfuseTracer.js';

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
        ? applyToolAllowlist([...createTools()], process.env.EPAM_ALLOWED_TOOLS)
        : [];

      const systemPrompt = await buildSessionSystemPrompt(config, authManager);
      const userMessage = config.projectRoot
        ? await consumeConsultationContext(prompt, config.projectRoot)
        : prompt;

      const provider = wrapWithTracing(chain);

      // Labels come from what the orchestration already exports; a bare `epam run` records the
      // calls with generic labels rather than not recording them.
      const agentName = process.env.EPAM_AGENT_NAME || 'epam-run';
      const storyLabel = process.env.EPAM_STORY_ID || undefined;
      const phaseLabel = process.env.PHASE || undefined;
      const activityLogger = config.projectRoot ? getActivityLogger(config.projectRoot) : null;

      const runner = new AgentRunner({
        userMessage,
        systemPrompt,
        provider,
        model: config.model,
        tools,
        maxIterations: config.maxIterations,
        maxToolCalls: config.maxToolCalls,
        autoCompressAt: config.autoCompressAt,
          autoCompressEveryNIterations: config.autoCompressEveryNIterations,
        maxOutputTokens: config.maxOutputTokens,
        dangerousSkipApproval: config.tools.dangerousSkipApproval,
        onTextDelta: jsonMode ? undefined : delta => process.stdout.write(delta),
        // TOOL USAGE IS RECORDED HERE OR NOWHERE.
        //
        // AgentActivityLogger has defined 'tool_run' and 'tool_result' since it was written and
        // nothing ever emitted them; AgentRunner has exposed onToolCall since it was written and
        // only the REPL wired it, to the terminal. So every tool call in every automated run —
        // the runs that actually cost money — went unrecorded, and "does the writer grep or
        // query the CodeGraph index?" had no answer in the logs.
        //
        // Failures here are swallowed deliberately: observability must never be able to fail a
        // story. The story/phase/agent labels come from the environment the orchestration
        // already sets, so a direct `epam run` simply records less rather than erroring.
        onToolCall: (toolName, input) => {
          void activityLogger?.emit(agentName, 'tool_run',
            { tool: toolName, args: summariseToolArgs(input) },
            { storyId: storyLabel, phase: phaseLabel }).catch(() => {});
        },
        onToolResult: (toolName, _result, isError, meta) => {
          void activityLogger?.emit(agentName, 'tool_result',
            { tool: toolName, ok: !isError, ms: meta?.durationMs ?? null, bytes: meta?.bytes ?? 0 },
            { storyId: storyLabel, phase: phaseLabel }).catch(() => {});
        },
      });

      const result = await runner.run();

      if (jsonMode) {
        // Prefer the provider's own REAL, billed cost (result.usage.costUsd,
        // populated when every turn's provider call reported it — see
        // AgentRunner.buildResult) over the local pricing-table estimate.
        // The estimate is fallback-only, and the output says which one this
        // is via cost_is_estimate — silently presenting an estimate as
        // confirmed spend is exactly the bug this field exists to prevent
        // (see feedback_real_cost_tracking_critical memory: real cost
        // capture is the required primary path).
        const isEstimate = result.usage.costUsd == null;
        const cost = isEstimate
          ? calculateCost(config.model, result.usage.inputTokens, result.usage.outputTokens)
          : result.usage.costUsd!;
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
          cost_is_estimate: isEstimate,
          toolCallCount: result.toolCallCount,
          iterations: result.iterations,
          // Model-latency / tool-execution split per iteration. Small (one entry
          // per round-trip) and additive to the existing shape — jq-based
          // consumers that don't ask for it are unaffected. This is what makes a
          // slow reasoning call distinguishable from a slow tool call (e.g. a
          // large CodeGraph query) from OUTSIDE the process, which nothing
          // before this could do (see AgentRunner's onIterationTiming comment).
          timings: result.timings,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        if (process.stdout.isTTY) process.stdout.write('\n');
      }

      await flushLangfuse();
    });
}

/**
 * A short, bounded description of what a tool was asked to do.
 *
 * Deliberately NOT the full input: tool arguments can contain an entire file body, and an
 * observability record that grows with the payload it observes is its own cost problem. Keys are
 * always kept — knowing a search was `pattern`+`path` is most of the value — and values are
 * truncated. Nothing is filtered by name, so a new tool's arguments are summarised the same way
 * without anyone remembering to add it here.
 */
export function summariseToolArgs(
  input: Record<string, unknown>,
  maxValueChars = Number(process.env.EPAM_ACTIVITY_ARG_CHARS || 120),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
    out[k] = s.length > maxValueChars ? `${s.slice(0, maxValueChars)}…(${s.length} chars)` : s;
  }
  return out;
}
