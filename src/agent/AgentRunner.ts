import type { Message } from '../providers/types.js';
import type { ToolCallRequest } from '../tools/types.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';
import { Executor } from './Executor.js';
import { ToolRunner } from './tools/ToolRunner.js';
import { compressHistory } from '../context/MemoryCompressor.js';
import { AuditorRunner } from '../auditors/AuditorRunner.js';
import { RalphWiggumLoop } from './RalphWiggumLoop.js';
import type { BashToolResult, BashErrorClassification } from '../tools/builtin/Bash.js';
import { logger } from '../utils/logger.js';
import type { MemoryLoader } from '../memory/MemoryLoader.js';

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_192;   // was 32768 — keeps tool results lean in history
const DEFAULT_AUTO_COMPRESS_AT = 24_000;       // was 80000 — compress earlier to prevent history explosion
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;       // was 16384 — enough for any code file, prevents verbose runaway

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      chars += JSON.stringify(m.content).length;
    }
  }
  return Math.ceil(chars / 4);
}

function truncateToolOutput(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const kept = content.slice(0, limit);
  const droppedChars = content.length - limit;
  return `${kept}\n\n[truncated — showing first ${limit.toLocaleString()} of ${content.length.toLocaleString()} chars (${droppedChars.toLocaleString()} dropped)]`;
}

/**
 * PILLAR 2 — a self-heal constraint of kind `response_schema` compiles to
 * EPAM_RESPONSE_SCHEMA. Read it here, where the ProviderRequest is built, so the
 * healed rule binds the model's OUTPUT SPACE rather than being asked for in prose.
 *
 * Malformed input is ignored (loudly): a broken KB must never take the agent down
 * with it, but it must not be invisible either.
 */
function resolveKbResponseSchema(): { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: boolean } | undefined {
  const raw = process.env.EPAM_RESPONSE_SCHEMA;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.name || !parsed?.schema) throw new Error('missing name or schema');
    return { type: 'json_schema', name: parsed.name, schema: parsed.schema, strict: true };
  } catch (e) {
    process.stderr.write(
      `[kb] ignoring malformed EPAM_RESPONSE_SCHEMA (${(e as Error).message}) — ` +
      `agent output is NOT schema-bound\n`);
    return undefined;
  }
}

export class AgentRunner {
  private executor: Executor;
  private iterationCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  /** False the moment any turn's provider call didn't report real cost —
   * once false, totalCostUsd is a partial/incomplete sum, not the real total
   * for the whole run, and callers must fall back to an estimate instead of
   * presenting it as confirmed spend. */
  private allTurnsHadRealCost = true;
  private anyTurnRan = false;
  private totalToolCalls = 0;
  private maxToolOutputChars: number;
  private memoryLoader?: MemoryLoader;
  private memoryPromptBlock?: string;

  constructor(private options: AgentRunOptions) {
    const toolRunner = options.toolRunner ?? new ToolRunner(options.tools, options.dangerousSkipApproval ?? false);

    this.executor = new Executor({
      toolRunner,
      maxConcurrency: 3,
    });
    this.maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
    this.memoryLoader = options.memoryLoader;
  }

  async run(): Promise<AgentRunResult> {
    const maxIterations = this.options.maxIterations ?? 20;
    const autoCompressAt = this.options.autoCompressAt ?? DEFAULT_AUTO_COMPRESS_AT;

    // Load memory and inject into system prompt on first run
    if (this.memoryLoader && !this.memoryPromptBlock) {
      this.memoryPromptBlock = await this.memoryLoader.generateSystemPromptBlock();
    }

    let messages: Message[] = [
      ...(this.options.history ?? []),
      { role: 'user', content: this.options.userMessage },
    ];
    let nudgeCount = 0;

    let finalResponse = '';

    while (this.iterationCount < maxIterations) {
      this.iterationCount++;
      this.options.onIterationStart?.(this.iterationCount);

      logger.debug({ iteration: this.iterationCount }, 'Agent iteration');

      // Auto-compress if history has grown past threshold
      if (estimateTokens(messages) > autoCompressAt && messages.length > 6) {
        try {
          logger.debug('Auto-compressing conversation history');
          messages = await compressHistory(
            messages,
            this.options.provider,
            this.options.model,
          );
        } catch {
          logger.warn('Auto-compression failed, continuing with full history');
        }
      }

      let accumulatedText = '';

      // Build system prompt with memory injection
      const systemPrompt = this.buildSystemPrompt();

      const response = await this.options.provider.stream(
        {
          messages,
          systemPrompt,
          tools: this.options.tools.map(t => t.definition),
          model: this.options.model,
          stream: true,
          maxTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(resolveKbResponseSchema() ? { responseFormat: resolveKbResponseSchema()! } : {}),
        },
        delta => {
          if (delta.type === 'text_delta') {
            this.options.onTextDelta?.(delta.text);
            accumulatedText += delta.text;
          }
        }
      );

      this.totalInputTokens += response.usage.inputTokens;
      this.totalOutputTokens += response.usage.outputTokens;
      this.anyTurnRan = true;
      if (typeof response.usage.costUsd === 'number') {
        this.totalCostUsd += response.usage.costUsd;
      } else {
        this.allTurnsHadRealCost = false;
      }

      // Budget enforcement — check after every LLM response
      if (this.options.budgetGuard) {
        const check = this.options.budgetGuard.recordUsage(
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        if (check.action !== 'ok') {
          this.options.onBudgetCheck?.(check);
        }
        if (check.action === 'pause') {
          // Hard stop — append what we have and return immediately
          messages.push({ role: 'assistant', content: response.content });
          return this.buildResult(
            response.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('') || check.message,
            messages,
          );
        }
      }

      const toolUses = response.content.filter(p => p.type === 'tool_use');
      const textParts = response.content.filter(p => p.type === 'text');

      if (textParts.length > 0 || accumulatedText) {
        finalResponse = textParts.map(p => p.text ?? '').join('') || accumulatedText;
      }

      // TRUNCATED REASONING IS A HARD FAILURE, NOT AN ANSWER.
      //
      // Verified against OpenRouter (2026-07-25): glm-5.1, glm-5.2, kimi-k3 and
      // minimax-m3 all deduct reasoning tokens from max_tokens. Probed at
      // max_tokens:200, every one spent the ENTIRE budget thinking and returned
      // HTTP 200, finish_reason="length", content:"" — a success status carrying
      // nothing. Downstream that became the 169-byte team-lead "review".
      //
      // This check must sit ABOVE the end_turn branch: a fully-truncated response
      // has zero tool_uses, so it satisfied `toolUses.length === 0`, broke out of
      // the loop, and returned the empty/partial text as the result. The
      // max_tokens handler further down was unreachable for exactly this case —
      // it only ever saw a truncated PARTIAL TOOL CALL, which is genuinely
      // continuable and is still handled there.
      //
      // FailoverPolicy.ts:66 already routes on an error whose message contains
      // 'max_tokens' ("thrown by AgentRunner when stopReason === 'max_tokens'"),
      // so the failover path was written for this throw before it existed.
      if (response.stopReason === 'max_tokens' && toolUses.length === 0) {
        const partial = (textParts.map(p => p.text ?? '').join('') || accumulatedText).trim();
        throw new Error(
          `Response truncated at max_tokens with no usable output — the model spent its ` +
          `entire output budget on reasoning. Raise EPAM_MAX_OUTPUT_TOKENS or disable ` +
          `reasoning for this call. Partial text (${partial.length} chars): ` +
          `${partial.slice(0, 200)}${partial.length > 200 ? '…' : ''}`
        );
      }

      if (response.stopReason === 'end_turn' || toolUses.length === 0) {
        // When the model outputs only planning/thinking text with no tool calls,
        // nudge it to actually call the tool rather than exiting the loop.
        // M3 often emits <think>...</think> as its first response then stops.
        const responseText = textParts.map(p => p.text ?? '').join('') || accumulatedText;
        const isThinkingOnly = toolUses.length === 0 &&
          nudgeCount < 2 &&
          responseText.trim().length > 0 &&
          (/<think>/i.test(responseText) || /^(I('ll| will)|Let me|Now I|First,|To (implement|write|create)|I need to)/i.test(responseText.trim()));

        if (isThinkingOnly) {
          // Model is planning but hasn't acted — nudge it to call the tool.
          // Max 2 nudges per run to avoid infinite loops if model never calls tools.
          nudgeCount++;
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: 'Please call your WriteFile tool now to write the required file(s). Do not output any more text — just call the tool.' });
          continue;
        }

        // Append the final assistant message so messages array is complete
        messages.push({ role: 'assistant', content: response.content });

        // Run auditors in parallel after each assistant turn
        if (this.options.auditors && this.options.auditors.length > 0) {
          const auditorInput = {
            userMessage: this.options.userMessage,
            proposedResponse: finalResponse,
            conversationHistory: messages.slice(0, -1),
          };
          const results = await Promise.all(
            this.options.auditors.map(a => a.run(auditorInput))
          );
          const decision = AuditorRunner.evaluateGate(results, this.options.auditors);
          this.options.onAuditorGate?.(decision);
        }

        break;
      }

      if (response.stopReason === 'max_tokens') {
        // Model ran out of output tokens mid-generation — push what we have
        // and continue the loop so the model can pick up where it left off.
        logger.debug('max_tokens hit — continuing conversation');
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Continue from where you left off.' });
        continue;
      }

      const toolCallRequests: ToolCallRequest[] = toolUses.map(p => ({
        id: p.id ?? '',
        name: p.name ?? '',
        input: (p.input as Record<string, unknown>) ?? {},
      }));

      this.totalToolCalls += toolCallRequests.length;
      this.options.onToolCall?.(
        toolCallRequests.map(r => r.name).join(', '),
        toolCallRequests[0]?.input ?? {}
      );

      // Execute tools with Ralph Wiggum Loop error recovery for bash failures
      const toolResults = await this.executeToolsWithRecovery(toolCallRequests);

      for (const result of toolResults) {
        result.content = truncateToolOutput(result.content, this.maxToolOutputChars);

        this.options.onToolResult?.(
          toolCallRequests.find(r => r.id === result.toolUseId)?.name ?? '',
          result.content,
          result.isError
        );
      }

      messages.push({
        role: 'assistant',
        content: response.content,
      });

      messages.push({
        role: 'user',
        content: toolResults.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolUseId,
          content: r.content,
        })),
      });
    }

    if (this.iterationCount >= maxIterations && !finalResponse) {
      finalResponse = `Agent reached maximum iterations (${maxIterations}) without completing.`;
    }

    return this.buildResult(finalResponse, messages);
  }

  /**
   * Execute tools with Ralph Wiggum Loop error recovery for bash failures.
   *
   * When a bash tool returns a recoverable error (exit code 1/2 with stderr),
   * spawns parallel agents to attempt different fix strategies.
   */
  private async executeToolsWithRecovery(
    toolCallRequests: ToolCallRequest[]
  ): Promise<ToolCallRequest['input'] extends Record<string, unknown> ? 
    (ToolCallRequest & { toolUseId: string; content: string; isError: boolean })[] : never> {
    
    const toolResults = await this.executor.executeAll(toolCallRequests);

    // Check for bash tool failures that may benefit from Ralph Wiggum Loop
    const bashFailure = toolResults.find((result): result is BashToolResult => {
      if (!result.isError) return false;
      const maybeBashResult = result as BashToolResult;
      return maybeBashResult.errorClassification?.recoverable === true;
    });

    if (!bashFailure) {
      return toolResults as any;
    }

    const bashRequest = toolCallRequests.find(r => r.id === bashFailure.toolUseId);
    if (!bashRequest || bashRequest.name !== 'bash') {
      return toolResults as any;
    }

    // Env-var kill-switch: EPAM_RALPH_WIGGUM_ENABLED=0 disables recovery entirely.
    // Use in CI, cost-sensitive runs, or when the loop is not yet validated.
    if (process.env.EPAM_RALPH_WIGGUM_ENABLED === '0') {
      logger.info({ command: bashRequest.input.command },
        'RalphWiggumLoop: Skipped (EPAM_RALPH_WIGGUM_ENABLED=0)');
      return toolResults as any;
    }

    logger.info({
      command: bashRequest.input.command,
      reason: bashFailure.errorClassification?.reason,
    }, 'RalphWiggumLoop: Triggering parallel error recovery');

    // Env-var overrides for cost/time control:
    //   EPAM_RALPH_WIGGUM_AGENTS=1      — limit to 1 parallel agent (default: 3)
    //   EPAM_RALPH_WIGGUM_TIMEOUT_MS=30000 — per-agent timeout ms (default: 120000)
    const ralphConfig: Partial<import('./RalphWiggumLoop.types.js').RalphWiggumConfig> = {};
    if (process.env.EPAM_RALPH_WIGGUM_AGENTS) {
      ralphConfig.parallelAgents = Math.max(1, parseInt(process.env.EPAM_RALPH_WIGGUM_AGENTS, 10) || 3);
    }
    if (process.env.EPAM_RALPH_WIGGUM_TIMEOUT_MS) {
      ralphConfig.agentTimeout = Math.max(5000, parseInt(process.env.EPAM_RALPH_WIGGUM_TIMEOUT_MS, 10) || 120000);
    }

    // Trigger Ralph Wiggum Loop
    const ralphWiggum = new RalphWiggumLoop(ralphConfig);

    const result = await ralphWiggum.run(
      {
        command: bashRequest.input.command as string,
        stderr: bashFailure.stderr ?? '',
        stdout: bashFailure.content,
        exitCode: bashFailure.exitCode ?? 1,
        contextMessages: [], // Could pass current messages if tracked
        systemPrompt: this.options.systemPrompt,
      },
      this.options.provider,
      this.options.model,
      this.options.tools,
      this.options.systemPrompt,
      this.options.dangerousSkipApproval ?? false
    );

    if (result.success && result.winningAttempt) {
      logger.info({
        winningStrategy: result.winningAttempt.strategy,
        elapsedMs: result.elapsedMs,
        agentsCancelled: result.agentsCancelled,
      }, 'RalphWiggumLoop: Found successful fix');

      // Re-execute the bash command after the fix was applied
      // The winning attempt's messages contain the fix, so we re-run the tool
      const fixedResults = await this.executor.executeAll(toolCallRequests);
      return fixedResults as any;
    }

    logger.warn({
      success: result.success,
      elapsedMs: result.elapsedMs,
    }, 'RalphWiggumLoop: No successful fix found');

    // Return original results if recovery failed
    return toolResults as any;
  }

  private buildResult(finalResponse: string, messages: Message[]): AgentRunResult {
    // Only expose a summed costUsd when EVERY turn reported real cost — a
    // partial sum (some turns real, some missing) would silently understate
    // spend if presented as the total, which is worse than admitting "not
    // fully confirmed, fall back to an estimate" (see
    // feedback_real_cost_tracking_critical memory).
    const costUsd = this.anyTurnRan && this.allTurnsHadRealCost ? this.totalCostUsd : undefined;
    return {
      finalResponse,
      toolCallCount: this.totalToolCalls,
      iterations: this.iterationCount,
      usage: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        ...(costUsd != null ? { costUsd } : {}),
      },
      messages,
    };
  }

  /**
   * Build the system prompt with memory injection.
   * Memory blocks are appended after the base system prompt.
   */
  private buildSystemPrompt(): string {
    const base = this.options.systemPrompt;

    if (!this.memoryPromptBlock) {
      return base;
    }

    return `${base}\n\n${this.memoryPromptBlock}`;
  }

  /**
   * Reload memory (called when /compact runs).
   */
  async reloadMemory(): Promise<void> {
    if (this.memoryLoader) {
      this.memoryPromptBlock = await this.memoryLoader.generateSystemPromptBlock();
    }
  }
}
