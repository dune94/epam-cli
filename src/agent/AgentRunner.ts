import type { Message } from '../providers/types.js';
import type { ToolCallRequest } from '../tools/types.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';
import { Executor } from './Executor.js';
import { compressHistory } from '../context/MemoryCompressor.js';
import { logger } from '../utils/logger.js';

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 32_768;
const DEFAULT_AUTO_COMPRESS_AT = 80_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

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

export class AgentRunner {
  private executor: Executor;
  private iterationCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalToolCalls = 0;
  private maxToolOutputChars: number;

  constructor(private options: AgentRunOptions) {
    this.executor = new Executor({
      tools: options.tools,
      dangerousSkipApproval: options.dangerousSkipApproval ?? false,
      maxConcurrency: 3,
    });
    this.maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  }

  async run(): Promise<AgentRunResult> {
    const maxIterations = this.options.maxIterations ?? 20;
    const autoCompressAt = this.options.autoCompressAt ?? DEFAULT_AUTO_COMPRESS_AT;

    let messages: Message[] = [
      ...(this.options.history ?? []),
      { role: 'user', content: this.options.userMessage },
    ];

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

      const response = await this.options.provider.stream(
        {
          messages,
          systemPrompt: this.options.systemPrompt,
          tools: this.options.tools.map(t => t.definition),
          model: this.options.model,
          stream: true,
          maxTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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

      if (response.stopReason === 'end_turn' || toolUses.length === 0) {
        // Append the final assistant message so messages array is complete
        messages.push({ role: 'assistant', content: response.content });
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

      const toolResults = await this.executor.executeAll(toolCallRequests);

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
        role: 'tool',
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

  private buildResult(finalResponse: string, messages: Message[]): AgentRunResult {
    return {
      finalResponse,
      toolCallCount: this.totalToolCalls,
      iterations: this.iterationCount,
      usage: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
      },
      messages,
    };
  }
}
