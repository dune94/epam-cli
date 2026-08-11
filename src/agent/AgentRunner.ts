import type { Message } from '../providers/types.js';
import type { ToolCallRequest } from '../tools/types.js';
import type { AgentRunOptions, AgentRunResult, IterationTiming } from './types.js';
import { Executor } from './Executor.js';
import { ToolRunner } from './tools/ToolRunner.js';
import { compressHistory } from '../context/MemoryCompressor.js';
import { AuditorRunner } from '../auditors/AuditorRunner.js';
import { RalphWiggumLoop } from './RalphWiggumLoop.js';
import type { BashToolResult, BashErrorClassification } from '../tools/builtin/Bash.js';
import { logger } from '../utils/logger.js';
import type { MemoryLoader } from '../memory/MemoryLoader.js';
import { LoopDetector } from './LoopDetector.js';

// Back to 8_192 (2026-08-10, same day it was raised). The raise argued that truncation "mutates
// content inside the cacheable prefix" and that a larger stable result is cheaper than a smaller
// one that shifts the prefix. That reasoning was wrong: truncation is DETERMINISTIC, so the same
// result cut the same way yields the same prefix, merely shorter. Nothing shifts.
//
// What the raise did do was double the rate at which history grows, and history is re-sent on
// every turn of the loop. Measured the same day: a 120-turn attempt sent 7.5M input tokens, of
// which ~5.4M (72%) was accumulated history, with per-turn growth spiking to 53,721 tokens — an
// order only reachable by several large tool results landing in one turn.
//
// Caching discounts that traffic, it does not make it free, and no cached rate is even wired into
// the cost model yet. A smaller result is a smaller prefix every turn thereafter.
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_192;
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
  /** undefined until some provider reports cache detail — see the accumulation site. */
  private totalCachedInputTokens: number | undefined;
  /** Set when this turn's history was compacted, so the trace can attribute a cache collapse. */
  private compactedThisTurn = false;
  private totalCostUsd = 0;
  /** False the moment any turn's provider call didn't report real cost —
   * once false, totalCostUsd is a partial/incomplete sum, not the real total
   * for the whole run, and callers must fall back to an estimate instead of
   * presenting it as confirmed spend. */
  private allTurnsHadRealCost = true;
  private anyTurnRan = false;
  private totalToolCalls = 0;
  /** Announce the spent tool budget once, not on every subsequent turn. */
  private toolBudgetAnnounced = false;
  private maxToolOutputChars: number;
  private memoryLoader?: MemoryLoader;
  private memoryPromptBlock?: string;
  /**
   * Per-iteration model-latency / tool-execution split. See the comment at
   * modelCallStart in run() for why this exists: without it, a slow reasoning
   * call and a slow tool (e.g. a large CodeGraph query) are indistinguishable
   * from the outside, and they need opposite fixes.
   */
  private timings: IterationTiming[] = [];
  /** One instance = one story attempt (a fresh AgentRunner per `run()`), so
   *  this needs no explicit per-attempt reset — see LoopDetector's docstring. */
  private loopDetector = new LoopDetector();

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
    const autoCompressEveryNIterations = this.options.autoCompressEveryNIterations;
    let iterationAtLastCompress = 0;

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

      // Auto-compress if history has grown past a TOKEN threshold, OR if a
      // fixed ITERATION count has passed since the last compaction, whichever
      // fires first. Token-only compaction misses a long-horizon run that
      // stays under the token threshold on any single check but still
      // accumulates real risk over many iterations — many short tool calls,
      // each individually small, none crossing autoCompressAt on its own.
      const iterationsSinceCompress = this.iterationCount - iterationAtLastCompress;
      const iterationTriggerHit = typeof autoCompressEveryNIterations === 'number' &&
        autoCompressEveryNIterations > 0 &&
        iterationsSinceCompress >= autoCompressEveryNIterations;
      const tokenTriggerHit = estimateTokens(messages) > autoCompressAt;

      // NOT YET WIRED: the per-request billing-tier ceiling.
      //
      // MiniMax-M3 bills input up to 512K per REQUEST at the base rate and DOUBLES above it. The
      // vendor fact is recorded — model-pricing.json declares standardTierMaxInputTokens and
      // pricing.ts exposes standardTierMaxInputTokens() — but nothing consults it here yet, and
      // the contract is written in test/unit/agent/request-never-crosses-the-billing-tier.test.ts.
      //
      // Deliberately deferred past the 2026-08-10 measurement run: the guard belongs in THIS
      // block, which is the same code whose reconfiguration took prompt caching from 0% to 96%
      // and, as a side effect, produced zero compactions across 1,154 turns. Adding a new
      // compaction trigger immediately before a run whose whole purpose is to measure a
      // read-dedupe delta would confound that measurement and re-disturb the most fragile path in
      // the loop. It is also not urgent: the measured maximum request was 126,942 tokens, 24.2%
      // of the ceiling, and at the observed 359 tokens/turn growth a request would need ~1,411
      // turns to reach it against a 120-150 turn budget.
      if ((tokenTriggerHit || iterationTriggerHit) && messages.length > 6) {
        try {
          logger.debug(
            { trigger: iterationTriggerHit ? 'iteration-count' : 'token-threshold' },
            'Auto-compressing conversation history',
          );
          messages = await compressHistory(
            messages,
            this.options.provider,
            this.options.model,
          );
          iterationAtLastCompress = this.iterationCount;
          this.compactedThisTurn = true;
        } catch {
          logger.warn('Auto-compression failed, continuing with full history');
        }
      }

      let accumulatedText = '';

      // Build system prompt with memory injection
      const systemPrompt = this.buildSystemPrompt();

      // TOOL BUDGET — enforced, not requested.
      //
      // The code-graph-detective's prompt says "HARD LIMIT: 6 tool calls total.
      // This is not a suggestion." Nothing enforced it, so the model explored
      // past 6 and hit the ITERATION cap with no answer at all, discarding the
      // whole investigation. That was "fixed" three times by raising the cap
      // (10 → 20 → 25, and 40 was worst of all: 40 calls, 680K input tokens, no
      // fix). The budget was never the constraint — the absence of a mechanism
      // was. Withdrawing the tools is what actually stops the exploring, the
      // same way EPAM_ALLOWED_TOOLS='bash' structurally ended the
      // answer-by-WriteFile failure that prompt wording could not.
      //
      // Unset = unlimited, so existing agents are unchanged.
      const toolBudget = this.options.maxToolCalls;
      const budgetSpent = typeof toolBudget === 'number' && toolBudget > 0 &&
        this.totalToolCalls >= toolBudget;
      if (budgetSpent && !this.toolBudgetAnnounced) {
        this.toolBudgetAnnounced = true;
        messages.push({
          role: 'user',
          content:
            `Tool budget spent (${this.totalToolCalls}/${toolBudget} calls). No further tool ` +
            `calls are available. Give your final answer NOW, in the required output format, ` +
            `using only what you have already seen. A best-guess answer from the evidence you ` +
            `gathered is worth everything; another query is worth nothing.`,
        });
      }

      // A hung forced-answer turn must cost ONE turn, not the whole run.
      // Whether this turn offers tools at all. Drives BOTH the tools field and the strict
      // response-schema binding, so the two can never be sent together by accident.
      const toolsOfferedThisTurn = !budgetSpent && this.options.tools.length > 0;
      const turnDeadline = budgetSpent ? this.options.finalTurnTimeoutMs : undefined;
      const withDeadline = <T>(p: Promise<T>): Promise<T> => {
        if (!turnDeadline) return p;
        return Promise.race([
          p,
          new Promise<T>((_, reject) => setTimeout(
            () => reject(new Error(
              `Final answer turn timed out after ${turnDeadline}ms with no response. The model was ` +
              `asked to conclude with tools withdrawn and never replied.`)),
            turnDeadline).unref?.()),
        ]) as Promise<T>;
      };

      // Split model latency from tool execution time. Both were invisible before
      // this: the detective's own transcript log holds only the prompt and the
      // final JSON, so a 12-minute attempt (metrolinx, 2026-07-30) and a
      // 23-second one (mock3, same day) could not be told apart — model latency
      // on a large/reasoning call and slow tool execution against a big index
      // need opposite fixes, and EPAM_MAX_TOOL_CALLS was raised three times
      // against exactly this blind spot before anyone could see which it was.
      const modelCallStart = Date.now();
      const response = await withDeadline(this.options.provider.stream(
        {
          messages,
          systemPrompt,
          // OMIT tools entirely once the budget is spent — do not send `tools: []`.
          // Live metrolinx run 4 (2026-07-26): the detective made 7 quick,
          // productive tool calls in ~65s, then this forced-answer turn hung and
          // never returned, burning the rest of its 360s budget until the
          // timeout fired. Langfuse recorded it precisely — `tools given: []`,
          // `endTime: None`. An empty array is not the same request as no tools:
          // it leaves the tool-calling path active with nothing to call, and the
          // model can stall instead of answering. Omitting the field is the
          // request we actually mean.
          ...(toolsOfferedThisTurn ? { tools: this.options.tools.map(t => t.definition) } : {}),
          model: this.options.model,
          stream: true,
          maxTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          // BIND THE SHAPE ON EVERY TURN.
          //
          // I briefly bound this only on turns where tools were withheld, reasoning that a
          // schema sent alongside tools invites the model to satisfy the shape immediately
          // instead of calling anything. That coupling was a bug, and it cost a live run:
          // `tools` is withheld only once the tool BUDGET is spent, so an agent had to burn
          // all 8 of its inherited tool calls — eight round trips — before it was allowed to
          // produce a conforming answer. It timed out at 360s and the guard it feeds aborted
          // the specification pass. A ceiling on exploration had been turned into a floor on
          // latency.
          //
          // The concern it was meant to address is real but belongs in the SCHEMA, not in
          // turn placement: make the evidence required. Once TOOL_TICKET_LINKS required
          // `quotes` (minItems 1) and an explicit `fetchStatus`, the same agent fetched both
          // documents and returned 21 verbatim quotes — because a bound reply it could
          // satisfy without reading anything no longer exists. Content requirements force the
          // read; turn placement never did.
          ...(resolveKbResponseSchema() ? { responseFormat: resolveKbResponseSchema()! } : {}),
        },
        delta => {
          if (delta.type === 'text_delta') {
            this.options.onTextDelta?.(delta.text);
            accumulatedText += delta.text;
          }
        }
      ));
      const modelLatencyMs = Date.now() - modelCallStart;

      this.totalInputTokens += response.usage.inputTokens;
      this.totalOutputTokens += response.usage.outputTokens;
      // Accumulated only when the provider actually reported it, so a provider that says
      // nothing stays distinguishable from one that reports zero cached tokens. Without this
      // the field died here: the provider parsed it and the CLI emitted it, but the aggregate
      // in between dropped it, and an end-to-end run showed `undefined` while every unit test
      // on either side of this line passed.
      if (typeof response.usage.cachedInputTokens === 'number') {
        this.totalCachedInputTokens = (this.totalCachedInputTokens ?? 0) + response.usage.cachedInputTokens;
      }
      this.writeUsageProgress();
      // PER-TURN usage, appended. The aggregate alone cannot show WHERE cache utilisation
      // collapses across a long writer loop — and the leading hypothesis (compressHistory
      // replacing the message array, destroying the prefix) predicts a drop to zero on the
      // turn after each compaction. This makes that visible instead of inferred.
      if (process.env.EPAM_USAGE_TRACE_FILE) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('node:fs').appendFileSync(process.env.EPAM_USAGE_TRACE_FILE, JSON.stringify({
            iteration: this.iterationCount,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cachedInputTokens: response.usage.cachedInputTokens ?? null,
            compacted: this.compactedThisTurn,
            model: this.options.model,
          }) + '\n');
        } catch { /* observability must never break the run */ }
        this.compactedThisTurn = false;
      }
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
          this.recordTiming(modelLatencyMs, 0, []);
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
        this.recordTiming(modelLatencyMs, 0, []);
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
          this.recordTiming(modelLatencyMs, 0, []);
          nudgeCount++;
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: 'Please call your WriteFile tool now to write the required file(s). Do not output any more text — just call the tool.' });
          continue;
        }

        this.recordTiming(modelLatencyMs, 0, []);
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
        this.recordTiming(modelLatencyMs, 0, []);
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
      // ONE CALL PER TOOL. This joined the whole batch into a single string, so a model that
      // asks for three tools in one turn produced the "tool name" "bash, read_file, bash" —
      // live 2026-08-09, alongside "bash, bash". Per-tool counts were wrong whenever the model
      // batched, which is most turns, and the first input was reported for all of them.
      for (const req of toolCallRequests) {
        this.options.onToolCall?.(req.name, req.input ?? {});
      }

      // Loop protection: block exact-repeat tool calls (same tool + same args
      // seen too many times in the recent window) BEFORE they execute, so a
      // stuck agent doesn't keep re-running an expensive test/build/patch
      // that already failed the same way. Blocked calls never reach the
      // executor — the model receives the intervention message as if it
      // were the tool's own result, in place of running it again.
      const blockedResults: (ToolCallRequest & { toolUseId: string; content: string; isError: boolean })[] = [];
      const toExecute: ToolCallRequest[] = [];
      for (const req of toolCallRequests) {
        const { blocked, interventionMessage } = this.loopDetector.preToolCheck(req.name, req.input);
        if (blocked) {
          blockedResults.push({ ...req, toolUseId: req.id, content: interventionMessage ?? '', isError: true });
        } else {
          toExecute.push(req);
        }
      }

      // Execute tools with Ralph Wiggum Loop error recovery for bash failures
      const toolExecStart = Date.now();
      const executedResults = toExecute.length > 0 ? await this.executeToolsWithRecovery(toExecute) : [];
      const toolExecMs = Date.now() - toolExecStart;

      // Loop protection, part 2: an error that repeats the SAME fingerprint
      // (normalized — see LoopDetector) gets a nudge appended to its real
      // output, not replaced by it — the model still needs to see what
      // actually happened, just with a push to change strategy.
      for (const result of executedResults) {
        const { repeating, feedbackMessage } = this.loopDetector.postToolCheck(result);
        if (repeating && feedbackMessage) result.content += feedbackMessage;
      }

      const toolResults = [...executedResults, ...blockedResults];
      this.recordTiming(modelLatencyMs, toolExecMs, toolCallRequests.map(req => {
        const result = toolResults.find(r => r.toolUseId === req.id);
        return { name: req.name, resultBytes: result?.content.length ?? 0, isError: result?.isError ?? false };
      }));

      for (const result of toolResults) {
        result.content = truncateToolOutput(result.content, this.maxToolOutputChars);

        // Remember what was actually written, so an agent whose work went to disk
        // can SAY so instead of returning empty. Only successful writes count —
        // see the summary below for why that distinction is load-bearing.
        const req = toolCallRequests.find(r => r.id === result.toolUseId);
        if (req && !result.isError && /write|edit|create/i.test(req.name)) {
          const p = (req.input?.path ?? req.input?.file_path ?? req.input?.filename) as string | undefined;
          if (p) this.writtenPaths.push(p);
        }

        this.options.onToolResult?.(
          toolCallRequests.find(r => r.id === result.toolUseId)?.name ?? '',
          result.content,
          result.isError,
          {
            durationMs: (result as { durationMs?: number }).durationMs,
            bytes: result.content?.length ?? 0,
          },
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

    // A file-writing agent often ends its turn with no text, making finalResponse
    // indistinguishable from an agent that produced NOTHING. Report what was
    // written instead — generated from tool results, not asked of the model, since
    // a prompt instruction can be ignored and a deterministic summary cannot.
    //
    // Deliberately only when writes SUCCEEDED and no other response exists. Doing
    // this for a failed or silent agent would turn a detectable failure into a
    // plausible success, which is the defect being removed everywhere else here.
    // The max-iterations message above is set first and therefore wins.
    if (!finalResponse && this.writtenPaths.length > 0) {
      const unique = [...new Set(this.writtenPaths)];
      finalResponse = `Wrote ${unique.length} file(s): ${unique.join(', ')}`;
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

  /**
   * Record one iteration's model/tool split and fire the streaming callback.
   *
   * Called at every exit from the iteration (early return, throw, nudge-continue,
   * final-answer break, max_tokens-continue, and the normal tool-execution path)
   * so no iteration silently goes unmeasured — a gap here would be the same
   * defect this exists to fix: time spent that nobody can account for.
   */
  private recordTiming(
    modelLatencyMs: number,
    toolExecMs: number,
    toolCalls: { name: string; resultBytes: number; isError: boolean }[],
  ): void {
    const timing: IterationTiming = { iteration: this.iterationCount, modelLatencyMs, toolExecMs, toolCalls };
    this.timings.push(timing);
    this.options.onIterationTiming?.(timing);
  }

  /** Paths successfully written this run, used to summarise an otherwise-empty reply. */
  private writtenPaths: string[] = [];

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
        ...(this.totalCachedInputTokens != null
          ? { cachedInputTokens: this.totalCachedInputTokens }
          : {}),
      },
      messages,
      timings: this.timings,
    };
  }

  /**
   * Persist usage-so-far after every turn, so a KILLED attempt still reports what it spent.
   *
   * The watchdog SIGKILLs an attempt at 1800s. The cost record is written by the code that runs
   * after the invocation returns — which, for a killed attempt, never runs. Live 2026-08-10:
   * 10 of 23 writer invocations were killed, and those were the LONGEST and most expensive ones
   * (25.4 min, ~2.2M input tokens each). Every one contributed exactly $0 to the story's
   * running total, so the $15 hard limit was summing only the cheap attempts that finished.
   * The guard was blindest precisely where the money went.
   *
   * Written after each turn rather than at the end, because "at the end" is the case that does
   * not happen. Best-effort and silent on failure: an observability write must never be able to
   * take down the run it is observing.
   */
  private writeUsageProgress(): void {
    const path = process.env.EPAM_USAGE_PROGRESS_FILE;
    if (!path) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs');
      fs.writeFileSync(path, JSON.stringify({
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        iterations: this.iterationCount,
        toolCalls: this.totalToolCalls,
        ...(this.totalCachedInputTokens != null
          ? { cachedInputTokens: this.totalCachedInputTokens } : {}),
        ...(this.anyTurnRan && this.allTurnsHadRealCost ? { costUsd: this.totalCostUsd } : {}),
      }));
    } catch { /* observability must not break the run */ }
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
