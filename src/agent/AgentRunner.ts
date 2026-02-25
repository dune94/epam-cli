import type { LLMProvider, Message, ContentPart } from '../providers/types.js';
import type { Tool, ToolCallRequest } from '../tools/types.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';
import { AgentContext } from './AgentContext.js';
import { Executor } from './Executor.js';
import { AgentError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export class AgentRunner {
  private context: AgentContext;
  private executor: Executor;
  private iterationCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalToolCalls = 0;

  constructor(private options: AgentRunOptions) {
    this.context = new AgentContext(options.systemPrompt);
    this.executor = new Executor({
      tools: options.tools,
      dangerousSkipApproval: false,
      maxConcurrency: 3,
    });
  }

  async run(): Promise<AgentRunResult> {
    const maxIterations = this.options.maxIterations ?? 20;
    let messages: Message[] = [{ role: 'user', content: this.options.userMessage }];
    let finalResponse = '';

    while (this.iterationCount < maxIterations) {
      this.iterationCount++;
      this.options.onIterationStart?.(this.iterationCount);

      logger.debug({ iteration: this.iterationCount }, 'Agent iteration');

      let accumulatedText = '';
      const toolUseBlocks: ContentPart[] = [];

      const response = await this.options.provider.stream(
        {
          messages,
          systemPrompt: this.options.systemPrompt,
          tools: this.options.tools.map(t => t.definition),
          model: this.options.model,
          stream: true,
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

      // Collect tool use blocks from response
      const toolUses = response.content.filter(p => p.type === 'tool_use');
      const textParts = response.content.filter(p => p.type === 'text');

      if (textParts.length > 0 || accumulatedText) {
        finalResponse = textParts.map(p => p.text ?? '').join('') || accumulatedText;
      }

      if (response.stopReason === 'end_turn' || toolUses.length === 0) {
        break;
      }

      if (response.stopReason === 'max_tokens') {
        throw new AgentError('Model hit max_tokens limit during agent run');
      }

      // Build tool call requests
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

      // Execute tools (parallel where possible)
      const toolResults = await this.executor.executeAll(toolCallRequests);

      for (const result of toolResults) {
        this.options.onToolResult?.(
          toolCallRequests.find(r => r.id === result.toolUseId)?.name ?? '',
          result.content,
          result.isError
        );
      }

      // Append assistant message with tool use blocks
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Append tool results
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

    return {
      finalResponse,
      toolCallCount: this.totalToolCalls,
      iterations: this.iterationCount,
      usage: {
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
      },
    };
  }
}
