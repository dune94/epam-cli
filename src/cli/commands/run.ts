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
      const agentName = resolveAgentLabel(process.env);
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
            { tool: toolLabel(toolName), args: summariseToolArgs(input) },
            { storyId: storyLabel, phase: phaseLabel }).catch(() => {});
        },
        onToolResult: (toolName, _result, isError, meta) => {
          void activityLogger?.emit(agentName, 'tool_result',
            { tool: toolLabel(toolName), ok: !isError, ms: meta?.durationMs ?? null, bytes: meta?.bytes ?? 0 },
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
        const output = buildRunResultJson(result, config);
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        if (process.stdout.isTTY) process.stdout.write('\n');
      }

      await flushLangfuse();
    });
}

/**
 * The machine-readable result the orchestration pipeline parses.
 *
 * Extracted from the command body so it can be asserted on directly. It was inline, which meant
 * the only way to check what the pipeline receives was to run the pipeline — and that is exactly
 * how `cache_read_input_tokens` stayed broken: claude.sh:9677 reads that key, nothing ever wrote
 * it, and jq's `// 0` turned the missing field into a confident zero on every record.
 *
 * The key is `cached_input_tokens`, NOT Anthropic's `cache_read_input_tokens`, and the
 * difference is load-bearing. Anthropic reports `input_tokens` EXCLUDING cached tokens, so
 * claude.sh:9678 adds them back. OpenAI-shaped providers — both of ours — report
 * `prompt_tokens` INCLUDING them. Emitting into the Anthropic key would have made that addition
 * double-count every cached token, inflating both the recorded spend and the budget guard that
 * reads it. Two different semantics get two different names.
 *
 * The key is OMITTED, not zeroed, when the provider reported no cache detail — a provider that
 * says nothing must stay distinguishable from one that says "none".
 */
export function buildRunResultJson(
  result: {
    finalResponse: string;
    usage: { inputTokens: number; outputTokens: number; costUsd?: number; cachedInputTokens?: number };
    toolCallCount: number;
    iterations: number;
    timings?: unknown;
    stopReason?: string;
  },
  config: { model: string; provider: string },
): Record<string, unknown> {
  // Prefer the provider's REAL billed cost (populated when every turn's provider call reported
  // it — see AgentRunner.buildResult) over the local pricing-table estimate. The estimate is
  // fallback-only, and cost_is_estimate says which one this is — silently presenting an estimate
  // as confirmed spend is the bug that field exists to prevent (feedback_real_cost_tracking_critical).
  // A PROVIDER ZERO ALONGSIDE REAL TOKENS IS A MISSING COST, NOT A FREE CALL.
  //
  // This tested `costUsd == null`, which is true only for null/undefined. A provider that returns
  // 0 because it does not know — OpenRouter does this for several models — landed in the "real
  // billed cost" branch, was published as confirmed spend, and the pricing table was never asked.
  //
  // Live 2026-08-17, mock3 run 20260817T162132Z: every call ran on z-ai/glm-5.2, which IS priced
  // at $0.93/M in and $3.00/M out, and 13 of 14 ledger records carried costUsd 0. Recorded
  // $0.0069 against $0.2592 of actual consumption — a 37x under-report on the measurement the
  // operator has called priority #1. It degrades exactly where it hurts most: the story budget
  // guard sums these to enforce storyBudgetHardLimitUsd, so a runaway story on a zero-reporting
  // provider is invisible to the only mechanism that stops it.
  //
  // Zero tokens with zero cost is still a genuinely free call and stays 0 — otherwise every no-op
  // would acquire a phantom charge.
  const consumedTokens = result.usage.inputTokens > 0 || result.usage.outputTokens > 0;
  const providerGaveCost = result.usage.costUsd != null
    && !(result.usage.costUsd === 0 && consumedTokens);

  const isEstimate = !providerGaveCost;
  const cost = isEstimate
    ? calculateCost(config.model, result.usage.inputTokens, result.usage.outputTokens)
    : result.usage.costUsd!;
  return {
    result: result.finalResponse,
    // OMITTED when the agent finished, present when it was cut off — the same "absent is not
    // zero" convention as cached_input_tokens above. A consumer that never looks is unaffected;
    // one that must not act on a truncated answer can refuse it without matching on prose.
    ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
    model: config.model,
    provider: config.provider,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      ...(typeof result.usage.cachedInputTokens === 'number'
        ? { cached_input_tokens: result.usage.cachedInputTokens }
        : {}),
    },
    cost_usd: Math.round(cost * 10000) / 10000,
    cost_is_estimate: isEstimate,
    toolCallCount: result.toolCallCount,
    iterations: result.iterations,
    // Model-latency / tool-execution split per iteration. Small (one entry per round-trip) and
    // additive — jq consumers that don't ask for it are unaffected. This is what makes a slow
    // reasoning call distinguishable from a slow tool call from OUTSIDE the process.
    timings: result.timings,
  };
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

/**
 * Which agent an activity event is attributed to.
 *
 * EPAM_AGENT_ROLE is what the orchestration exports at the writer invocation (claude.sh).
 * EPAM_AGENT_NAME was a variable invented CLI-side that nothing sets, so every live event on
 * 2026-08-09 came out as the fallback and no per-agent breakdown was possible.
 *
 * Exported and pure so this is testable by CALLING it. The first version of this check asserted
 * that run.ts mentioned EPAM_AGENT_ROLE, and a mutation removing the variable still passed —
 * the comment above it contained the string.
 */
export function resolveAgentLabel(env: NodeJS.ProcessEnv): string {
  return env.EPAM_AGENT_NAME || env.EPAM_AGENT_ROLE || 'epam-run';
}

/**
 * The name an activity event is filed under.
 *
 * Live 2026-08-09, 1 event of 193 recorded tool "" — the provider emitted a tool_use block with
 * real arguments and no name, and the executor answered "Tool '' not found". A genuine event,
 * but filed under an empty string it aggregates into nothing: it silently under-counts whichever
 * call it was and leaves a hole in the cost attribution this logging exists to provide. A
 * measurement that quietly drops rows is worse than one that is obviously missing.
 */
export function toolLabel(name: string | undefined | null): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? '(unnamed)' : trimmed;
}
